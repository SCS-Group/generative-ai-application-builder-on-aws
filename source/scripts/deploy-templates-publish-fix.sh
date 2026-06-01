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

log "1/2 Deploy UseCaseManagementStack (TemplatesManagementLambda code)…"
cd "$INFRA_DIR"
npx cdk deploy UseCaseManagementStack --require-approval never --region "$REGION"

log "2/2 Build and publish deployment UI to S3/CloudFront…"
cd "$SOURCE_ROOT/ui-deployment"
npm ci
npm run build
bash "$SCRIPT_DIR/publish-deployment-ui.sh"

log "Done. Hard-refresh the GAAB dashboard (Cmd+Shift+R). Publish will confirm, show Publishing…, and surface API errors."
