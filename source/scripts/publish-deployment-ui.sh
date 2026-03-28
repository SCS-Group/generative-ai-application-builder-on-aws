#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Uploads a fresh Vite build of the deployment dashboard to the platform website bucket
# and invalidates CloudFront. Does not replace runtimeConfig.json (managed by the stack).
#
# Prefers stack outputs DeploymentWebUIBucketName and DeploymentWebUIDistributionId (added
# in CDK). If those are missing (stack not updated yet), resolves the distribution from
# CloudFrontWebUrl and the S3 bucket from the distribution's first S3 origin domain.
#
# IAM: s3:PutObject/ListBucket on the web bucket; cloudfront:CreateInvalidation; for fallback
# also cloudfront:ListDistributions and cloudfront:GetDistributionConfig.
#
# Usage (from repo root):
#   cd source/ui-deployment && npm ci && npm run build && cd ../..
#   DEPLOYMENT_PLATFORM_STACK_NAME=DeploymentPlatformStack STAGING_AWS_REGION=us-east-1 bash source/scripts/publish-deployment-ui.sh
#
set -euo pipefail

STACK_NAME="${DEPLOYMENT_PLATFORM_STACK_NAME:-DeploymentPlatformStack}"
UI_BUILD_DIR="${UI_DEPLOYMENT_BUILD_DIR:-$(cd "$(dirname "$0")/../ui-deployment" && pwd)/build}"

if [[ ! -f "${UI_BUILD_DIR}/index.html" ]]; then
  echo "ERROR: No index.html under ${UI_BUILD_DIR}. Run: cd source/ui-deployment && npm ci && npm run build" >&2
  exit 1
fi

if [[ -z "${STAGING_AWS_REGION:-}" && -n "${AWS_REGION:-}" ]]; then
  STAGING_AWS_REGION="${AWS_REGION}"
fi
if [[ -z "${STAGING_AWS_REGION:-}" && -n "${AWS_DEFAULT_REGION:-}" ]]; then
  STAGING_AWS_REGION="${AWS_DEFAULT_REGION}"
fi
REGION="${STAGING_AWS_REGION:-us-east-1}"

echo "Using stack=${STACK_NAME} region=${REGION} build=${UI_BUILD_DIR}"

stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text 2>/dev/null || true
}

BUCKET="$(stack_output DeploymentWebUIBucketName)"
DIST_ID="$(stack_output DeploymentWebUIDistributionId)"

if [[ -z "${DIST_ID}" || "${DIST_ID}" == "None" ]]; then
  CF_URL="$(stack_output CloudFrontWebUrl)"
  if [[ -z "${CF_URL}" || "${CF_URL}" == "None" ]]; then
    echo "ERROR: Stack outputs DeploymentWebUIDistributionId and CloudFrontWebUrl are both missing." >&2
    echo "Ensure ${STACK_NAME} is deployed with the deployment dashboard (DeployWebApp) enabled." >&2
    exit 1
  fi
  HOST="${CF_URL#https://}"
  HOST="${HOST#http://}"
  HOST="${HOST%/}"
  DIST_ID="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?DomainName=='${HOST}'].Id | [0]" \
    --output text)"
  if [[ -z "${DIST_ID}" || "${DIST_ID}" == "None" ]]; then
    echo "ERROR: No CloudFront distribution found for host ${HOST} (from CloudFrontWebUrl)." >&2
    exit 1
  fi
  echo "Note: Resolved distribution ID from CloudFrontWebUrl (re-deploy stack to get DeploymentWebUIDistributionId output)."
fi

if [[ -z "${BUCKET}" || "${BUCKET}" == "None" ]]; then
  # Read origin domains from the distribution (S3 virtual-hosted–style: <bucket>.s3...amazonaws.com)
  ORIGIN_DOMAIN="$(
    aws cloudfront get-distribution-config --id "${DIST_ID}" --output json |
      jq -r '.DistributionConfig.Origins.Items[].DomainName | select(contains(".s3") and contains("amazonaws.com"))' |
      head -1
  )"
  if [[ -z "${ORIGIN_DOMAIN}" ]]; then
    echo "ERROR: Could not find an S3 origin on distribution ${DIST_ID}." >&2
    exit 1
  fi
  # Strip .s3.<region>.amazonaws.com, .s3.amazonaws.com, .s3.dualstack.*, etc.
  BUCKET="${ORIGIN_DOMAIN%%.s3*}"
  echo "Note: Resolved bucket from CloudFront origin ${ORIGIN_DOMAIN} (re-deploy stack to get DeploymentWebUIBucketName output)."
fi

echo "Publishing to s3://${BUCKET}/ (excluding runtimeConfig.json)"

# Do not delete bucket keys: preserves runtimeConfig.json and any legacy keys (e.g. login.html) not in the Vite build.
aws s3 sync "${UI_BUILD_DIR}" "s3://${BUCKET}/" \
  --region "${REGION}" \
  --exclude "runtimeConfig.json"

echo "Creating CloudFront invalidation for distribution ${DIST_ID}"
aws cloudfront create-invalidation \
  --distribution-id "${DIST_ID}" \
  --paths "/*" \
  --query "Invalidation.Id" \
  --output text

echo "Done. Allow a minute for CloudFront to serve the new bundle."
