#!/usr/bin/env bash
# Print DeploymentPlatformStack outputs: CloudFront (deployment dashboard) + REST API URL.
# Uses default credential chain / region (AWS_PROFILE, AWS_REGION, etc.).
#
# Usage:
#   bash source/scripts/print-dashboard-url.sh
#   AWS_REGION=us-west-2 bash source/scripts/print-dashboard-url.sh
#   CF_STACK_NAME=MyStack bash source/scripts/print-dashboard-url.sh

set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
STACK="${CF_STACK_NAME:-DeploymentPlatformStack}"

echo "Stack: $STACK  Region: $REGION"
echo ""

CFN_URL=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontWebUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || true)

API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RestEndpointUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$CFN_URL" ] || [ "$CFN_URL" = "None" ]; then
  echo "CloudFrontWebUrl: (not in outputs — wrong stack/region, or UI output is conditional)"
  echo "All outputs:"
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" --output table
  exit 1
fi

echo "Deployment dashboard (CloudFront): $CFN_URL"
echo "REST API: $API_URL"
