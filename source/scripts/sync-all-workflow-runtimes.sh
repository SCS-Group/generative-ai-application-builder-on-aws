#!/usr/bin/env bash
# Sync all live workflow orchestrator AgentCore runtimes to platform SSM image + env
# (AIW_DISABLE_GITHUB_DIRECT, GitHub vault, OAuth, Figma proxy, etc.).
#
# Runs automatically after every DeploymentPlatformStack agent image CodeBuild
# (invokes orchestrator-provision-subscriber SyncAllWorkflowRuntimes). Use this
# script to trigger sync manually without a full platform deploy.
#
# Usage:
#   bash source/scripts/sync-all-workflow-runtimes.sh
#   AWS_REGION=us-east-1 bash source/scripts/sync-all-workflow-runtimes.sh
#
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${DEPLOYMENT_PLATFORM_STACK_NAME:-DeploymentPlatformStack}"
ORCHESTRATOR_FN_SSM="/gaab-deployment-platform/OrchestratorProvisionSubscriberFunction"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

FN=$(aws ssm get-parameter --region "$REGION" --name "$ORCHESTRATOR_FN_SSM" \
  --query Parameter.Value --output text 2>/dev/null || true)

if [ -z "$FN" ] || [ "$FN" = "None" ]; then
  FN=$(aws cloudformation describe-stack-resources --region "$REGION" --stack-name "$STACK" \
    --query "StackResources[?contains(LogicalResourceId,'OrchestratorProvisionSubscriber') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null || true)
fi

[ -n "$FN" ] && [ "$FN" != "None" ] || die "OrchestratorProvisionSubscriber not found (SSM $ORCHESTRATOR_FN_SSM or stack $STACK)"

log "Invoking $FN (SyncAllWorkflowRuntimes, async)"
PAYLOAD_FILE=/tmp/sync-all-workflow-runtimes-payload.json
printf '%s' '{"source":"gaab.platform","detail-type":"SyncAllWorkflowRuntimes","detail":{"trigger":"manual-script"}}' > "$PAYLOAD_FILE"
aws lambda invoke --region "$REGION" \
  --function-name "$FN" \
  --invocation-type Event \
  --cli-binary-format raw-in-base64-out \
  --payload "file://$PAYLOAD_FILE" \
  /tmp/sync-all-workflow-runtimes-out.json >/dev/null

log "Sync started. Check CloudWatch logs for OrchestratorProvisionSubscriber for per-use-case results."
