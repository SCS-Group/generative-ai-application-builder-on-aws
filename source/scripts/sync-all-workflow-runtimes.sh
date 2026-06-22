#!/usr/bin/env bash
# Sync all live workflow orchestrator AgentCore runtimes to platform SSM image + env
# (AIW_DISABLE_GITHUB_DIRECT, GitHub vault, OAuth, Figma proxy, etc.).
#
# Runs automatically after every DeploymentPlatformStack agent image CodeBuild
# (Custom::SyncAllWorkflowRuntimes). Use this script to trigger sync manually
# without a full platform deploy.
#
# Usage:
#   bash source/scripts/sync-all-workflow-runtimes.sh
#   AWS_REGION=us-east-1 bash source/scripts/sync-all-workflow-runtimes.sh
#
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${DEPLOYMENT_PLATFORM_STACK_NAME:-DeploymentPlatformStack}"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

FN=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK" \
  --query "StackResourceSummaries[?LogicalResourceId=='OrchestratorProvisionSubscriber30D8FD82'].PhysicalResourceId | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$FN" ] || [ "$FN" = "None" ]; then
  FN=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK" \
    --query "StackResourceSummaries[?contains(LogicalResourceId,'OrchestratorProvisionSubscriber')].PhysicalResourceId | [0]" \
    --output text)
fi

[ -n "$FN" ] && [ "$FN" != "None" ] || die "OrchestratorProvisionSubscriber not found on stack $STACK"

log "Invoking $FN (SyncAllWorkflowRuntimes, async)"
aws lambda invoke --region "$REGION" \
  --function-name "$FN" \
  --invocation-type Event \
  --payload '{"source":"gaab.platform","detail-type":"SyncAllWorkflowRuntimes","detail":{"trigger":"manual-script"}}' \
  /tmp/sync-all-workflow-runtimes-out.json >/dev/null

log "Sync started. Check CloudWatch logs for OrchestratorProvisionSubscriber for per-use-case results."
