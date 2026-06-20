#!/usr/bin/env bash
# Hot-patch Feature Orchestrator use case: agentcore-invocation + ui-chat (ideation resume).
# Does NOT reprovision the stack — updates live Lambda code and chat static assets.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
USE_CASE_ID="${GAAB_USE_CASE_ID:-1b309012-cebe-41ed-9f44-471f022ffda4}"
STACK="${GAAB_USE_CASE_STACK:-feature-orchestrator-1b309012}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAMBDA_DIR="${ROOT}/lambda/agentcore-invocation"
UI_DIR="${ROOT}/ui-chat"
ZIP="/tmp/gaab-agentcore-invocation-$(date +%s).zip"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

log "Packaging agentcore-invocation from ${LAMBDA_DIR}"
(
  cd "$LAMBDA_DIR"
  zip -qr "$ZIP" . \
    -x 'test/*' '__pycache__/*' '*.pyc' '.pytest_cache/*' 'poetry.lock' 'pyproject.toml' '.venv/*'
)

INVOCATION_FN=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name "$STACK" \
  --query "StackResourceSummaries[?LogicalResourceId=='AgentInvocationLambda70E440A1'].PhysicalResourceId | [0]" \
  --output text)
[[ -n "$INVOCATION_FN" && "$INVOCATION_FN" != "None" ]] || die "AgentInvocationLambda not found on stack $STACK"

log "Updating Lambda ${INVOCATION_FN}"
aws lambda update-function-code --region "$REGION" --function-name "$INVOCATION_FN" --zip-file "fileb://${ZIP}" --output text --query 'FunctionName'
aws lambda wait function-updated-v2 --region "$REGION" --function-name "$INVOCATION_FN"

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

log "Building ui-chat"
(
  cd "$UI_DIR"
  npm ci --silent
  npx vite build
)

log "Syncing ui-chat to s3://${WEBSITE_BUCKET}/"
aws s3 sync "$UI_DIR/build/" "s3://${WEBSITE_BUCKET}/" --delete --region "$REGION"

log "Invalidating CloudFront ${CF_DIST}"
INVALIDATION=$(aws cloudfront create-invalidation --distribution-id "$CF_DIST" --paths "/*" --query 'Invalidation.Id' --output text)
log "Invalidation id: ${INVALIDATION}"

log "Done. Use case ${USE_CASE_ID} — open chat with ?aiwSessionKey=your-session-key after AIW Ideation tab sync."
