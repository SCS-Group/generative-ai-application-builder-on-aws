#!/usr/bin/env bash
# Refresh hosted chat UI + agentcore-invocation Lambda for one GAAB workflow/specialist use case.
#
# **Permanent source of truth:** repo `source/ui-chat` and `source/lambda/agentcore-invocation`.
# **New use cases:** pick up these assets automatically after `stage-assets` (CI on main) and
#   CloudFormation CREATE via `/deployments/workflows` — no manual refresh required.
# **Existing use cases:** run this script after ui-chat or agentcore-invocation changes, or trigger
#   a CloudFormation UPDATE on the use-case stack from the GAAB dashboard.
#
# Usage:
#   GAAB_USE_CASE_STACK=feature-orchestrator-1b309012 bash source/scripts/refresh-use-case-hosted-chat.sh
#   GAAB_USE_CASE_ID=1b309012-cebe-41ed-9f44-471f022ffda4 bash source/scripts/refresh-use-case-hosted-chat.sh
#
# Options:
#   REFRESH_UI_ONLY=1       Skip Lambda code update
#   REFRESH_LAMBDA_ONLY=1   Skip ui-chat S3 sync
#
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAMBDA_DIR="${SOURCE_ROOT}/lambda/agentcore-invocation"
UI_DIR="${SOURCE_ROOT}/ui-chat"
ZIP="/tmp/gaab-agentcore-invocation-$(date +%s).zip"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

resolve_stack_name() {
  if [[ -n "${GAAB_USE_CASE_STACK:-}" ]]; then
    echo "$GAAB_USE_CASE_STACK"
    return
  fi
  local use_case_id="${GAAB_USE_CASE_ID:-}"
  [[ -n "$use_case_id" ]] || die "Set GAAB_USE_CASE_STACK or GAAB_USE_CASE_ID"
  local table
  table=$(aws dynamodb list-tables --region "$REGION" --output json |
    python3 -c "import json,sys; t=[x for x in json.load(sys.stdin)['TableNames'] if 'UseCasesTable8AC05A74' in x]; print(t[0] if t else '')")
  [[ -n "$table" ]] || die "UseCasesTable not found"
  local stack_id
  stack_id=$(aws dynamodb get-item --region "$REGION" --table-name "$table" \
    --key "{\"UseCaseId\":{\"S\":\"$use_case_id\"}}" \
    --query 'Item.StackId.S' --output text)
  [[ -n "$stack_id" && "$stack_id" != "None" ]] || die "No StackId for use case $use_case_id"
  echo "$stack_id" | awk -F/ '{for(i=1;i<=NF;i++) if($i=="stack") print $(i+1)}'
}

STACK="$(resolve_stack_name)"
log "Use case stack: ${STACK}"

if [[ "${REFRESH_UI_ONLY:-}" != "1" ]]; then
  INVOCATION_FN=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK" \
    --query "StackResourceSummaries[?LogicalResourceId=='AgentInvocationLambda70E440A1'].PhysicalResourceId | [0]" \
    --output text)
  [[ -n "$INVOCATION_FN" && "$INVOCATION_FN" != "None" ]] || die "AgentInvocationLambda not found on stack $STACK"

  log "Packaging agentcore-invocation"
  (
    cd "$LAMBDA_DIR"
    zip -qr "$ZIP" . \
      -x 'test/*' '__pycache__/*' '*.pyc' '.pytest_cache/*' 'poetry.lock' 'pyproject.toml' '.venv/*'
  )

  log "Updating Lambda ${INVOCATION_FN}"
  aws lambda update-function-code --region "$REGION" --function-name "$INVOCATION_FN" --zip-file "fileb://${ZIP}" --output text --query 'FunctionName'
  aws lambda wait function-updated-v2 --region "$REGION" --function-name "$INVOCATION_FN"
fi

if [[ "${REFRESH_LAMBDA_ONLY:-}" != "1" ]]; then
  WEB_STACK=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK" \
    --query "StackResourceSummaries[?contains(LogicalResourceId,'WebAppNestedStack')].PhysicalResourceId | [0]" \
    --output text)
  [[ -n "$WEB_STACK" && "$WEB_STACK" != "None" ]] || die "WebApp nested stack not found"

  WEBSITE_BUCKET=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$WEB_STACK" \
    --query "StackResourceSummaries[?LogicalResourceId=='WebsiteBucket4326D7C2'].PhysicalResourceId | [0]" \
    --output text)
  CF_DIST=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$WEB_STACK" \
    --query "StackResourceSummaries[?LogicalResourceId=='WebsiteUICloudFrontDistribution9683A5F7'].PhysicalResourceId | [0]" \
    --output text)
  [[ -n "$WEBSITE_BUCKET" && "$WEBSITE_BUCKET" != "None" ]] || die "Website bucket not found"
  [[ -n "$CF_DIST" && "$CF_DIST" != "None" ]] || die "CloudFront distribution not found"

  log "Building ui-chat from ${UI_DIR}"
  (cd "$UI_DIR" && npm ci --silent && npx vite build)

  log "Syncing ui-chat to s3://${WEBSITE_BUCKET}/ (preserving runtimeConfig.json)"
  aws s3 sync "$UI_DIR/build/" "s3://${WEBSITE_BUCKET}/" --delete --region "$REGION" \
    --exclude "runtimeConfig.json"

  log "Invalidating CloudFront ${CF_DIST}"
  aws cloudfront create-invalidation --distribution-id "$CF_DIST" --paths "/*" --query 'Invalidation.Id' --output text
fi

log "Done. Stack ${STACK} refreshed from repo source."
