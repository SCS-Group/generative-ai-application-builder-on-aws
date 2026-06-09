#!/usr/bin/env bash
# Deletes orphaned AIW workspace AgentCore policy engines (aiw_pe_*).
#
# Safe to run repeatedly. For each engine:
# 1) disassociates from MCP gateway when --gateway-use-case-id is passed or auto-detected
# 2) deletes Cedar policies on the engine
# 3) deletes the policy engine
#
# Usage:
#   AWS_REGION=us-east-1 ./source/scripts/cleanup-orphaned-workspace-policy-engines.sh --dry-run
#   ./source/scripts/cleanup-orphaned-workspace-policy-engines.sh --keep bdaf98eb
#   ./source/scripts/cleanup-orphaned-workspace-policy-engines.sh --instance bdaf98eb-f331-4c0b-8ed2-93deabc5f5d9
#
# --keep PREFIX     skip engines whose name contains PREFIX (first 8 hex of instance id)
# --instance ID     delete only the engine for this workspace instance id

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=false
KEEP_PREFIX=""
ONLY_INSTANCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --keep)
      KEEP_PREFIX="${2:-}"
      shift 2
      ;;
    --instance)
      ONLY_INSTANCE="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

echo "Region: $REGION"
echo "Dry run: $DRY_RUN"
[[ -n "$KEEP_PREFIX" ]] && echo "Keep prefix: $KEEP_PREFIX"
[[ -n "$ONLY_INSTANCE" ]] && echo "Only instance: $ONLY_INSTANCE"
echo ""

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
export ACCOUNT_ID

python3 - <<'PY' "$REGION" "$DRY_RUN" "$KEEP_PREFIX" "$ONLY_INSTANCE" "$ACCOUNT_ID"
import json, subprocess, sys, time

region, dry_run, keep_prefix, only_instance, account_id = sys.argv[1:6]
dry_run = dry_run.lower() == "true"

def sh(*args):
    cmd = list(args)
    if dry_run:
        print("DRY_RUN:", " ".join(cmd))
        return "{}"
    return subprocess.check_output(cmd, text=True)

def disassociate_gateway(gateway_id: str):
    gw = json.loads(
        sh(
            "aws", "bedrock-agentcore-control", "get-gateway",
            "--region", region, "--gateway-identifier", gateway_id, "--output", "json",
        )
    )
    if not gw.get("policyEngineConfiguration"):
        return
    print(f"  disassociate policy engine from gateway {gw.get('name')} ({gateway_id})")
    update = {
        "gatewayIdentifier": gateway_id,
        "name": gw["name"],
        "roleArn": gw["roleArn"],
        "authorizerType": gw["authorizerType"],
        "protocolType": gw["protocolType"],
    }
    for key in ("description", "authorizerConfiguration", "protocolConfiguration", "kmsKeyArn", "interceptorConfigurations"):
        if gw.get(key):
            update[key] = gw[key]
    sh(
        "aws", "bedrock-agentcore-control", "update-gateway",
        "--region", region,
        "--cli-input-json", json.dumps(update),
    )

def disassociate_policy_engine(policy_engine_id: str):
    pe_arn_suffix = f"policy-engine/{policy_engine_id}"
    gateways = json.loads(
        sh("aws", "bedrock-agentcore-control", "list-gateways", "--region", region, "--max-results", "50", "--output", "json")
    ).get("items", [])
    for g in gateways:
        gid = (g.get("gatewayId") or "").strip()
        if not gid:
            continue
        gw = json.loads(
            sh(
                "aws", "bedrock-agentcore-control", "get-gateway",
                "--region", region, "--gateway-identifier", gid, "--output", "json",
            )
        )
        arn = ((gw.get("policyEngineConfiguration") or {}).get("arn") or "").strip()
        if policy_engine_id in arn:
            disassociate_gateway(gid)

def policy_engine_name(instance_id: str) -> str:
    suffix = instance_id.replace("-", "")[:8]
    return f"aiw_pe_{suffix}"

engines = json.loads(
    sh("aws", "bedrock-agentcore-control", "list-policy-engines", "--region", region, "--max-results", "50", "--output", "json")
).get("policyEngines", [])

targets = []
for e in engines:
    name = (e.get("name") or "").strip()
    pe_id = (e.get("policyEngineId") or "").strip()
    if not name.startswith("aiw_pe_") or not pe_id:
        continue
    if only_instance:
        expected = policy_engine_name(only_instance)
        if name != expected:
            continue
    elif keep_prefix and keep_prefix in name:
        continue
    targets.append((name, pe_id, e.get("status")))

if not targets:
    print("No matching aiw_pe_* policy engines.")
    sys.exit(0)

print(f"Found {len(targets)} policy engine(s) to delete.")

for name, pe_id, status in targets:
    print("")
    print(f"==> {name} ({pe_id}) status={status}")

    next_token = None
    while True:
        args = [
            "aws", "bedrock-agentcore-control", "list-policies",
            "--region", region, "--policy-engine-id", pe_id,
            "--max-results", "50", "--output", "json",
        ]
        if next_token:
            args.extend(["--next-token", next_token])
        page = json.loads(sh(*args))
        for policy in page.get("policies", []):
            pid = (policy.get("policyId") or "").strip()
            pname = policy.get("name")
            if not pid:
                continue
            print(f"  delete policy {pname} ({pid})")
            sh(
                "aws", "bedrock-agentcore-control", "delete-policy",
                "--region", region, "--policy-engine-id", pe_id, "--policy-id", pid,
            )
        next_token = page.get("nextToken")
        if not next_token:
            break

    disassociate_policy_engine(pe_id)

    print(f"  delete policy engine {pe_id}")
    try:
        sh(
            "aws", "bedrock-agentcore-control", "delete-policy-engine",
            "--region", region, "--policy-engine-id", pe_id,
        )
    except subprocess.CalledProcessError as e:
        print(f"  WARN: delete-policy-engine failed: {e}")
        continue

    if not dry_run:
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                out = subprocess.check_output(
                    [
                        "aws", "bedrock-agentcore-control", "get-policy-engine",
                        "--region", region, "--policy-engine-id", pe_id,
                        "--output", "json",
                    ],
                    text=True,
                    stderr=subprocess.STDOUT,
                )
                status = json.loads(out).get("status")
                print(f"  waiting for delete… status={status}")
                time.sleep(2)
            except subprocess.CalledProcessError as e:
                if "ResourceNotFoundException" in e.output or "not found" in e.output.lower():
                    print("  deleted")
                    break
                raise
        else:
            print("  WARN: timed out waiting for policy engine delete")

print("")
print("Done.")
PY
