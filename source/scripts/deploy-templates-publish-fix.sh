#!/usr/bin/env bash
# Redeploy GAAB Templates API Lambda + UI after publish-button / publish-timeout fixes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$SOURCE_ROOT/infrastructure"
REGION="${AWS_REGION:-us-east-1}"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

aws sts get-caller-identity --region "$REGION" --output text >/dev/null || die "AWS CLI not configured"

log "1/2 Deploy DeploymentPlatformStack (TemplatesManagementLambda + related Lambdas)…"
ADMIN_EMAIL="${ADMIN_USER_EMAIL:-$(aws cloudformation describe-stacks --region "$REGION" --stack-name DeploymentPlatformStack \
  --query 'Stacks[0].Parameters[?ParameterKey==`AdminUserEmail`].ParameterValue' --output text 2>/dev/null || true)}"
[ -n "$ADMIN_EMAIL" ] || die "Set ADMIN_USER_EMAIL or ensure DeploymentPlatformStack exists with AdminUserEmail"
cd "$INFRA_DIR"
export SKIP_ECR_PREBUILD=1
export STAGE_ASSETS_ASSUME_YES=true
npx cdk deploy DeploymentPlatformStack \
  -a "npx ts-node --prefer-ts-exts bin/deploy-deployment-platform-only.ts" \
  --require-approval never \
  --parameters "AdminUserEmail=${ADMIN_EMAIL}" \
  --region "$REGION"

log "2/2 Build and publish deployment UI to S3/CloudFront…"
cd "$SOURCE_ROOT/ui-deployment"
npm ci
npm run build
bash "$SCRIPT_DIR/publish-deployment-ui.sh"

log "Done. Hard-refresh the GAAB dashboard (Cmd+Shift+R). Publish will confirm, show Publishing…, and surface API errors."
