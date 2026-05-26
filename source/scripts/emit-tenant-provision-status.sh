#!/usr/bin/env bash
# Emit TenantProvisionStatus to update AIW workspace (same bus as provision subscriber).
# Usage:
#   export TENANT_TEMPLATE_INSTANCE_ID='<uuid from AIW TenantTemplateInstance>'
#   export GAAB_USE_CASE_ID='<uuid from GAAB Deployments>'
#   export RUNTIME_UI_URL='https://....cloudfront.net'   # optional; resolved from stack if omitted
#   bash source/scripts/emit-tenant-provision-status.sh runtime_ready

set -euo pipefail

PHASE="${1:-runtime_ready}"
: "${TENANT_TEMPLATE_INSTANCE_ID:?Set TENANT_TEMPLATE_INSTANCE_ID}"
: "${GAAB_USE_CASE_ID:?Set GAAB_USE_CASE_ID}"

REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
export AWS_DEFAULT_REGION="$REGION"

if [ -z "${RUNTIME_UI_URL:-}" ] && [ "$PHASE" = "runtime_ready" ]; then
  TABLE=$(aws cloudformation describe-stacks --stack-name DeploymentPlatformStack \
    --query "Stacks[0].Outputs[?OutputKey=='UseCasesTableName'].OutputValue" --output text)
  STACK_ARN=$(aws dynamodb get-item --table-name "$TABLE" \
    --key "{\"UseCaseId\":{\"S\":\"$GAAB_USE_CASE_ID\"}}" \
    --projection-expression StackId --query 'Item.StackId.S' --output text)
  STACK_NAME=$(echo "$STACK_ARN" | awk -F/ '/stack\// { print $2 }')
  RUNTIME_UI_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontWebUrl'].OutputValue" --output text 2>/dev/null || true)
fi

export PHASE
DETAIL=$(python3 - <<PY
import json, os
d = {
  "version": "1",
  "tenantTemplateInstanceId": os.environ["TENANT_TEMPLATE_INSTANCE_ID"],
  "phase": os.environ["PHASE"],
  "gaabUseCaseId": os.environ["GAAB_USE_CASE_ID"],
}
url = os.environ.get("RUNTIME_UI_URL", "").strip()
if url:
  d["runtimeUiUrl"] = url
print(json.dumps(d))
PY
)

ENTRIES=$(python3 - <<PY
import json, os
print(json.dumps([{
  "EventBusName": "default",
  "Source": "gaab.tenant",
  "DetailType": "TenantProvisionStatus",
  "Detail": os.environ["DETAIL"],
}]))
PY
)

aws events put-events --entries "$ENTRIES"

echo "Emitted TenantProvisionStatus phase=$PHASE for instance $TENANT_TEMPLATE_INSTANCE_ID"
