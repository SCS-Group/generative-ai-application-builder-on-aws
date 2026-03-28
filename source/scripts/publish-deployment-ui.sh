#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Uploads a fresh Vite build of the deployment dashboard to the platform website bucket
# and invalidates CloudFront. Does not replace runtimeConfig.json (managed by the stack).
#
# Prerequisites: aws CLI, credentials for the account/region; stack deployed with outputs
# DeploymentWebUIBucketName and DeploymentWebUIDistributionId (re-deploy platform stack once
# after upgrading CDK that adds those outputs).
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

BUCKET="$(
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='DeploymentWebUIBucketName'].OutputValue | [0]" \
    --output text
)"
DIST_ID="$(
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='DeploymentWebUIDistributionId'].OutputValue | [0]" \
    --output text
)"

if [[ -z "${BUCKET}" || "${BUCKET}" == "None" ]]; then
  echo "ERROR: Stack output DeploymentWebUIBucketName is missing." >&2
  echo "Deploy (or update) ${STACK_NAME} with CDK that exports DeploymentWebUIBucketName / DeploymentWebUIDistributionId." >&2
  exit 1
fi
if [[ -z "${DIST_ID}" || "${DIST_ID}" == "None" ]]; then
  echo "ERROR: Stack output DeploymentWebUIDistributionId is missing." >&2
  exit 1
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
