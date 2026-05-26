#!/usr/bin/env bash
# Ensures ui-chat zip exists where CopyUseCaseUI expects it (fixes NoSuchBucket on test deploys).
# Run from repo: bash source/scripts/ensure-use-case-ui-assets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/source"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
DIST_BUCKET_BASE="${DIST_OUTPUT_BUCKET:-github-actions}"
DIST_BUCKET="${DIST_BUCKET_BASE}-${REGION}"
CDK_BUCKET="cdk-hnb659fds-assets-$(aws sts get-caller-identity --query Account --output text)-${REGION}"
SOLUTION_NAME="$(node -p "require('./infrastructure/cdk.json').context.solution_name")"
VERSION="$(node -p "require('./infrastructure/cdk.json').context.solution_version")"

echo "Building ui-chat..."
cd ui-chat
npm ci
npx vite build
cd ..

ASSET_HASH="${UI_ASSET_HASH_OVERRIDE:-}"
if [ -z "$ASSET_HASH" ] && [ -f infrastructure/cdk.out/AgentBuilderStack.assets.json ]; then
  ASSET_HASH=$(jq -r '[.files | to_entries[] | .value | select(.source.packaging == "zip") | (.destinations | to_entries[0].value.objectKey)] | .[0]' infrastructure/cdk.out/AgentBuilderStack.assets.json | sed 's/.zip$//')
fi
if [ -z "$ASSET_HASH" ] || [ "$ASSET_HASH" = "null" ]; then
  echo "Set UI_ASSET_HASH_OVERRIDE to the asset hash from CopyWebUI logs (asset....zip without .zip)"
  exit 1
fi
ZIP_NAME="${ASSET_HASH}.zip"

TMPZIP="$(mktemp -t gaab-ui-chat).zip"
trap 'rm -f "$TMPZIP"' EXIT
( cd ui-chat/build && zip -r -q "$TMPZIP" . )

echo "Uploading ui-chat to s3://${CDK_BUCKET}/${ZIP_NAME}"
aws s3 cp "$TMPZIP" "s3://${CDK_BUCKET}/${ZIP_NAME}" --region "$REGION"

DIST_KEY="${SOLUTION_NAME}/${VERSION}/${ZIP_NAME}"
echo "Uploading ui-chat to s3://${DIST_BUCKET}/${DIST_KEY}"
aws s3 mb "s3://${DIST_BUCKET}" --region "$REGION" 2>/dev/null || true
aws s3 cp "$TMPZIP" "s3://${DIST_BUCKET}/${DIST_KEY}" --region "$REGION"

echo "Done. CopyUseCaseUI will read: bucket=${DIST_BUCKET} key=${DIST_KEY}"
