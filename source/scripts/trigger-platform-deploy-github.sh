#!/usr/bin/env bash
# Dispatches "Deploy DeploymentPlatformStack (manual)" on GitHub Actions.
# Requires: GitHub CLI (gh) installed and authenticated: gh auth login
#
# Usage:
#   ADMIN_USER_EMAIL=admin@yourcompany.com bash source/scripts/trigger-platform-deploy-github.sh
#
# Optional:
#   GITHUB_REPO=owner/repo   (default: SCS-Group/generative-ai-application-builder-on-aws)
#   AWS_REGION=us-west-2     (default: us-east-1)

set -euo pipefail

REPO="${GITHUB_REPO:-SCS-Group/generative-ai-application-builder-on-aws}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
: "${ADMIN_USER_EMAIL:?Set ADMIN_USER_EMAIL to the initial Cognito admin email}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: https://cli.github.com/  then: gh auth login" >&2
  exit 1
fi

echo "==> Dispatching deploy-platform-dispatch.yml on $REPO (ref: main, region: $REGION)"
gh workflow run deploy-platform-dispatch.yml --repo "$REPO" --ref main \
  -f "aws_region=${REGION}" \
  -f "dry_run=false" \
  -f "admin_user_email=${ADMIN_USER_EMAIL}"

echo ""
echo "==> Recent runs (wait ~10s then refresh if empty):"
sleep 2
gh run list --repo "$REPO" --workflow=deploy-platform-dispatch.yml --limit 5 || true

echo ""
echo "Open: https://github.com/${REPO}/actions/workflows/deploy-platform-dispatch.yml"
