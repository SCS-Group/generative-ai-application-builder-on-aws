#!/usr/bin/env bash
# Point an AgentCore runtime at the ECR image from SSM and recycle (after DeploymentPlatformStack CodeBuild).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
USE_CASE_ID="${AGENT_USE_CASE_ID:-f4ae196e-a59f-4ae2-9e99-0e7e1b459b35}"
RT_SHORT="${USE_CASE_ID%%-*}"
RT_NAME="gaab_agent_${RT_SHORT}"

IMAGE_URI="${AGENT_IMAGE_URI:-$(aws ssm get-parameter --region "$REGION" \
  --name /gaab-deployment-platform/GaabStrandsAgentImageUri --query Parameter.Value --output text)}"

RT_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --max-results 50 --output json |
  python3 -c "import json,sys; n='$RT_NAME'; print(next((x['agentRuntimeId'] for x in json.load(sys.stdin).get('agentRuntimes',[]) if x.get('agentRuntimeName')==n),''))")

echo "Runtime $RT_NAME -> $RT_ID"
echo "Image $IMAGE_URI"

DESCRIBE=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RT_ID" --output json)
export RT_ID IMAGE_URI DESCRIBE REGION
python3 <<'PY'
import json
import os
import subprocess

rt = os.environ["RT_ID"]
img = os.environ["IMAGE_URI"]
d = json.loads(os.environ["DESCRIBE"])
req = {
    "agentRuntimeId": rt,
    "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": img}},
    "roleArn": d["roleArn"],
    "networkConfiguration": d.get("networkConfiguration", {"networkMode": "PUBLIC"}),
    "environmentVariables": d.get("environmentVariables") or {},
}
if d.get("protocolConfiguration"):
    req["protocolConfiguration"] = d["protocolConfiguration"]
if d.get("lifecycleConfiguration"):
    req["lifecycleConfiguration"] = d["lifecycleConfiguration"]
subprocess.run(
    [
        "aws",
        "bedrock-agentcore-control",
        "update-agent-runtime",
        "--region",
        os.environ["REGION"],
        "--cli-input-json",
        json.dumps(req),
    ],
    check=True,
)
print("Updated runtime", rt)
PY
