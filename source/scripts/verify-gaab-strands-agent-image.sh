#!/usr/bin/env bash
# Verify the platform-built gaab-strands-agent image includes AIW Gmail direct tools.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
IMAGE_URI="${AGENT_IMAGE_URI:-}"

if [ -z "$IMAGE_URI" ]; then
  IMAGE_URI=$(aws ssm get-parameter --region "$REGION" \
    --name /gaab-deployment-platform/GaabStrandsAgentImageUri \
    --query Parameter.Value --output text 2>/dev/null || true)
fi

if [ -z "$IMAGE_URI" ] || [ "$IMAGE_URI" = "None" ]; then
  echo "ERROR: Set AGENT_IMAGE_URI or deploy DeploymentPlatformStack (SSM GaabStrandsAgentImageUri missing)."
  exit 1
fi

echo "Verifying image: $IMAGE_URI"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${IMAGE_URI%%/*}" >/dev/null
docker pull --platform linux/arm64 "$IMAGE_URI"

docker run --rm --platform linux/arm64 --entrypoint python "$IMAGE_URI" -c "
from gaab_strands_common.aiw_google_gmail_tool import load_aiw_gmail_tools, filter_gateway_gmail_mcp_tools
from gaab_strands_common import mcp_tools_loader
assert hasattr(mcp_tools_loader, '_streamable_http_transport_with_headers')
print('OK: direct Gmail tool + MCP header transport present')
"

echo "Image verification passed."
