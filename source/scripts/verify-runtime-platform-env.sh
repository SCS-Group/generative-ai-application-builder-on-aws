#!/usr/bin/env bash
# Print AgentCore runtime status for a GAAB use case (no deploy).
#
# Usage:
#   AGENT_USE_CASE_ID=5c87d3f4-c05e-486f-b345-3b49179c13c2 ./verify-runtime-platform-env.sh
#   AGENT_USE_CASE_ID=... EXPECT_IMAGE_TAG=v4.1.10-platform ./verify-runtime-platform-env.sh
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
USE_CASE_ID="${AGENT_USE_CASE_ID:?Set AGENT_USE_CASE_ID}"
RT_SHORT="${USE_CASE_ID%%-*}"
RT_NAME="gaab_agent_${RT_SHORT}"
EXPECT_TAG="${EXPECT_IMAGE_TAG:-}"

RT_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --max-results 50 --output json |
  python3 -c "import json,sys; n='$RT_NAME'; print(next((x['agentRuntimeId'] for x in json.load(sys.stdin).get('agentRuntimes',[]) if x.get('agentRuntimeName')==n),''))")

[ -n "$RT_ID" ] || { echo "Runtime not found: $RT_NAME" >&2; exit 1; }

DESCRIBE=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RT_ID" --output json)
export DESCRIBE EXPECT_TAG
python3 <<'PY'
import json
import os
import sys

d = json.loads(os.environ["DESCRIBE"])
status = d.get("status", "UNKNOWN")
version = d.get("agentRuntimeVersion")
image = d.get("agentRuntimeArtifact", {}).get("containerConfiguration", {}).get("containerUri", "")
updated = d.get("lastUpdatedAt", "")
expect = os.environ.get("EXPECT_TAG", "").strip()

print(f"runtime: {d.get('agentRuntimeId')}")
print(f"status:  {status}")
print(f"version: {version}")
print(f"image:   {image}")
print(f"updated: {updated}")

if status != "READY":
    print("\nNOT READY — wait for UPDATING to finish before re-running the agent.", file=sys.stderr)
    sys.exit(2)

if expect and expect not in image:
    print(f"\nImage tag mismatch — expected '{expect}' in URI.", file=sys.stderr)
    sys.exit(3)

print("\nREADY")
PY
