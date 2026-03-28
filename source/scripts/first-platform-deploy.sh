#!/usr/bin/env bash
# One-time (per account/region) bootstrap + DeploymentPlatformStack.
# Prerequisites: AWS CLI credentials, Node 20, cdk CLI available via npx.
#
# Usage:
#   export ADMIN_USER_EMAIL='admin@yourcompany.com'
#   export AWS_DEFAULT_REGION=us-east-1   # optional; default us-east-1
#   bash source/scripts/first-platform-deploy.sh

set -euo pipefail

: "${ADMIN_USER_EMAIL:?Set ADMIN_USER_EMAIL to the first admin Cognito user email}"

REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_REGION="$REGION"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$SCRIPT_DIR/../infrastructure"
cd "$INFRA"

echo "==> Account / region"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "    Account: $ACCOUNT  Region: $REGION"

echo "==> CDK bootstrap (safe to re-run)"
export SKIP_ECR_PREBUILD=1
npm ci
npm run build
npx cdk bootstrap "aws://${ACCOUNT}/${REGION}"

echo "==> Deploy DeploymentPlatformStack"
npx cdk deploy DeploymentPlatformStack \
  --parameters "AdminUserEmail=${ADMIN_USER_EMAIL}" \
  --require-approval never

echo "==> Next: stage assets (dashboard needs them for use-case stacks)"
echo "    cd $(cd "$SCRIPT_DIR/.." && pwd) && ./stage-assets.sh"
echo "    Or run GitHub Action: Stage CDK assets"
