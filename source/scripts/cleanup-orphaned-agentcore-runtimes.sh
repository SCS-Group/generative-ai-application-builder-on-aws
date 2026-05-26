#!/usr/bin/env bash
# Deletes orphaned GAAB AgentCore runtimes that were left behind after CFN stack deletion.
#
# This is safe to run repeatedly. It:
# 1) lists agent runtimes whose name matches gaab_agent_<8-hex>
# 2) deletes any non-DEFAULT endpoints (DEFAULT cannot be deleted directly)
# 3) deletes the runtime (DEFAULT endpoint is removed automatically)
# 4) best-effort deletes the workload identity gaab-oauth-provider-<8-hex>
#
# Usage:
#   AWS_REGION=us-east-1 ./source/scripts/cleanup-orphaned-agentcore-runtimes.sh
#   ./source/scripts/cleanup-orphaned-agentcore-runtimes.sh --dry-run

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

echo "Region: $REGION"
echo "Dry run: $DRY_RUN"
echo ""

RUNTIMES_JSON="$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --output json)"

python3 - <<'PY' "$RUNTIMES_JSON" "$REGION" "$DRY_RUN"
import json, os, re, subprocess, sys

runtimes = json.loads(sys.argv[1]).get("agentRuntimes", [])
region = sys.argv[2]
dry_run = sys.argv[3].lower() == "true"

def sh(cmd):
    if dry_run:
        print("DRY_RUN:", " ".join(cmd))
        return ""
    out = subprocess.check_output(cmd, text=True)
    return out

pat = re.compile(r"^gaab_agent_([0-9a-f]{8})$")

matches = []
for r in runtimes:
    name = r.get("agentRuntimeName", "")
    rid = r.get("agentRuntimeId", "")
    m = pat.match(name)
    if not m or not rid:
        continue
    matches.append((name, rid, m.group(1), r.get("status")))

if not matches:
    print("No gaab_agent_<8-hex> runtimes found.")
    sys.exit(0)

print(f"Found {len(matches)} runtime(s) to evaluate.")

for name, rid, short_id, status in matches:
    print("")
    print(f"==> {name} ({rid}) status={status}")

    # Delete non-default endpoints first (DEFAULT is removed when deleting the runtime).
    try:
        eps = json.loads(sh([
            "aws","bedrock-agentcore-control","list-agent-runtime-endpoints",
            "--region",region,
            "--agent-runtime-id",rid,
            "--output","json"
        ]) or "{}").get("runtimeEndpoints", [])
    except subprocess.CalledProcessError as e:
        print("WARN: list-agent-runtime-endpoints failed:", e)
        eps = []

    for ep in eps:
        ep_name = ep.get("name")
        if not ep_name or ep_name == "DEFAULT":
            continue
        print(f"Deleting endpoint: {ep_name}")
        try:
            sh([
                "aws","bedrock-agentcore-control","delete-agent-runtime-endpoint",
                "--region",region,
                "--agent-runtime-id",rid,
                "--endpoint-name",ep_name
            ])
        except subprocess.CalledProcessError as e:
            print("WARN: delete-agent-runtime-endpoint failed:", e)

    print("Deleting runtime (DEFAULT endpoint is removed automatically)")
    try:
        sh([
            "aws","bedrock-agentcore-control","delete-agent-runtime",
            "--region",region,
            "--agent-runtime-id",rid
        ])
    except subprocess.CalledProcessError as e:
        print("WARN: delete-agent-runtime failed:", e)

    # Best-effort identity cleanup (may not exist depending on config).
    identity = f"gaab-oauth-provider-{short_id}"
    print(f"Deleting workload identity (best-effort): {identity}")
    try:
        sh([
            "aws","bedrock-agentcore-control","delete-workload-identity",
            "--region",region,
            "--name",identity
        ])
    except subprocess.CalledProcessError as e:
        # ignore not found, conflicts, etc.
        print("WARN: delete-workload-identity failed:", e)

print("")
print("Done.")
PY

