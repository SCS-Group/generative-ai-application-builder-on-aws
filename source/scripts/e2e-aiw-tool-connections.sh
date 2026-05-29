#!/usr/bin/env bash
# Repeatable E2E path for AIW tool connections (Gmail) on GAAB + AgentCore.
#
# Usage:
#   ./e2e-aiw-tool-connections.sh verify          # Check platform image + Lambdas (no deploy)
#   ./e2e-aiw-tool-connections.sh platform-deploy      # Deploy platform stack + Lambdas
#   ./e2e-aiw-tool-connections.sh deploy-provision-fixes # Update TenantProvisionSubscriber only (fast)
#   ./e2e-aiw-tool-connections.sh stage-assets         # Upload CDK templates (AgentBuilder IAM incl. Figma proxy)
#   ./e2e-aiw-tool-connections.sh aiw-checklist          # Print AIW tear-down / recreate steps
#
# Prerequisites: AWS CLI, Docker, credentials for GAAB account, AIW Amplify app deployed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$SOURCE_ROOT/infrastructure"
REGION="${AWS_REGION:-us-east-1}"
ADMIN_EMAIL="${ADMIN_USER_EMAIL:-}"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

require_aws() {
  aws sts get-caller-identity --region "$REGION" --output text >/dev/null || die "AWS CLI not configured"
}

stack_status() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name DeploymentPlatformStack \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND"
}

verify_platform_stack() {
  local st
  st=$(stack_status)
  log "DeploymentPlatformStack status: $st"
  case "$st" in
    CREATE_COMPLETE|UPDATE_COMPLETE) ;;
    *) die "Platform stack not ready ($st). Run: $0 platform-deploy" ;;
  esac
}

verify_ssm_image() {
  aws ssm get-parameter --region "$REGION" \
    --name /gaab-deployment-platform/GaabStrandsAgentImageUri \
    --query Parameter.Value --output text >/dev/null \
    || die "SSM /gaab-deployment-platform/GaabStrandsAgentImageUri missing (CodeBuild did not run)"
}

verify_oauth_callback_ssm() {
  aws ssm get-parameter --region "$REGION" \
    --name /gaab-deployment-platform/AiwOAuthCallbackUrl \
    --query Parameter.Value --output text >/dev/null \
    || die "SSM AiwOAuthCallbackUrl missing — set AIW_OAUTH_CALLBACK_URL on platform deploy"
}

verify_subscriber_lambdas() {
  aws lambda get-function --region "$REGION" \
    --function-name "$(aws cloudformation list-stack-resources --region "$REGION" \
      --stack-name DeploymentPlatformStack --output json |
      python3 -c "
import json,sys
for r in json.load(sys.stdin).get('StackResourceSummaries',[]):
  if r.get('LogicalResourceId','').startswith('TenantProvisionSubscriber') and r.get('ResourceType')=='AWS::Lambda::Function':
    print(r['PhysicalResourceId']); break
" 2>/dev/null || true)" >/dev/null 2>&1 \
    || log "WARN: TenantProvisionSubscriber Lambda not found by logical id (may differ after deploy)"
}

cmd_verify() {
  require_aws
  verify_platform_stack
  verify_ssm_image
  verify_oauth_callback_ssm
  verify_subscriber_lambdas
  log "Pulling and inspecting agent image"
  "$SCRIPT_DIR/verify-gaab-strands-agent-image.sh"
  log "Platform verification OK"
  cmd_aiw_checklist
}

build_lambda_layers() {
  for layer in aws-sdk-lib aws-node-user-agent-config; do
    local dir="$SOURCE_ROOT/lambda/layers/$layer"
    [ -d "$dir" ] || die "layer not found: $dir"
    log "Building layer $layer"
    (cd "$dir" && npm ci --silent 2>/dev/null || npm install --silent && npm run build --silent)
  done
}

deploy_platform_stack() {
  local hotswap="${1:-}"
  [ -d "$INFRA_DIR" ] || die "infrastructure dir not found: $INFRA_DIR"
  build_lambda_layers
  if [ -z "$ADMIN_EMAIL" ]; then
    ADMIN_EMAIL=$(aws cloudformation describe-stacks --region "$REGION" --stack-name DeploymentPlatformStack \
      --query 'Stacks[0].Parameters[?ParameterKey==`AdminUserEmail`].ParameterValue' --output text 2>/dev/null || true)
  fi
  [ -n "$ADMIN_EMAIL" ] || die "Set ADMIN_USER_EMAIL for DeploymentPlatformStack"
  (
    cd "$INFRA_DIR"
    export SKIP_ECR_PREBUILD=1
    export STAGE_ASSETS_ASSUME_YES=true
    npm ci --silent 2>/dev/null || npm install --silent
    npm run build --silent
    deploy_args=(npx cdk deploy DeploymentPlatformStack
      -a "npx ts-node --prefer-ts-exts bin/deploy-deployment-platform-only.ts"
      --require-approval never
      --parameters "AdminUserEmail=${ADMIN_EMAIL}")
    if [ "$hotswap" = "hotswap" ]; then
      deploy_args+=(--hotswap)
    fi
    "${deploy_args[@]}"
  )
}

package_custom_resource_lambda() {
  local cr_dir="$SOURCE_ROOT/lambda/custom-resource"
  local zip="/tmp/gaab-custom-resource-$(date +%s).zip"
  [ -d "$cr_dir" ] || die "custom-resource lambda not found: $cr_dir"
  log "Packaging platform custom-resource Lambda (BUILD_GAAB_STRANDS_AGENT_IMAGE)"
  (cd "$cr_dir" && zip -qr "$zip" . -x 'test/*' '__pycache__/*' '*.pyc' '.pytest_cache/*')
  local fn
  fn=$(aws cloudformation list-stack-resources --region "$REGION" --stack-name DeploymentPlatformStack \
    --query "StackResourceSummaries[?LogicalResourceId=='DeploymentPlatformSetupInfraSetupCustomResource5473231F'].PhysicalResourceId" \
    --output text 2>/dev/null || true)
  if [ -z "$fn" ] || [ "$fn" = "None" ]; then
    fn="DeploymentPlatformStack-DeploymentPlatformSetupInf-vgb2lhTuDoAH"
  fi
  log "  update-function-code $fn"
  aws lambda update-function-code --region "$REGION" --function-name "$fn" \
    --zip-file "fileb://${zip}" --output text --query 'FunctionName' >/dev/null
  aws lambda wait function-updated --region "$REGION" --function-name "$fn"
  rm -f "$zip"
}

unblock_stuck_image_build_resource() {
  local st
  st=$(stack_status)
  if [[ "$st" == UPDATE_ROLLBACK_COMPLETE* ]]; then
    log "Skipping stuck AgentStrandsEcrImagePublish delete so stack can update again"
    aws cloudformation continue-update-rollback --region "$REGION" \
      --stack-name DeploymentPlatformStack \
      --resources-to-skip AgentStrandsEcrImagePublishBuild907B3C46 2>/dev/null || true
    sleep 10
  fi
}

publish_working_agent_image_tag() {
  # Use *-platform tag so ECR pull-through does not serve public.ecr.aws/aws-solutions/gaab-strands-agent:v4.1.9.
  local repo="deploymentplatformstack/gaab-strands-agent"
  local tag="${PLATFORM_AGENT_IMAGE_TAG:-v4.1.9-platform}"
  local acct
  acct=$(aws sts get-caller-identity --query Account --output text)
  local dest="${acct}.dkr.ecr.${REGION}.amazonaws.com/${repo}:${tag}"
  local src_tag="${WORKING_AGENT_IMAGE_TAG:-v4.1.9-oauth-fix3}"
  log "Publishing gaab-strands-agent:${tag} from ${src_tag} (ECR API, no docker push)"
  local manifest
  manifest=$(aws ecr batch-get-image --region "$REGION" --repository-name "$repo" \
    --image-ids imageTag="${src_tag}" \
    --accepted-media-types application/vnd.oci.image.index.v1+json application/vnd.oci.image.manifest.v1+json \
    --query 'images[0].imageManifest' --output text)
  [ -n "$manifest" ] && [ "$manifest" != "None" ] || die "Could not load manifest for tag ${src_tag}"
  if ! aws ecr put-image --region "$REGION" --repository-name "$repo" \
    --image-tag "$tag" --image-manifest "$manifest" >/dev/null 2>&1; then
    log "  (tag ${tag} already points at the working image)"
  fi
  aws ssm put-parameter --region "$REGION" \
    --name /gaab-deployment-platform/GaabStrandsAgentImageUri \
    --type String --value "$dest" --overwrite
}

cmd_platform_deploy() {
  require_aws
  [ -d "$INFRA_DIR" ] || die "infrastructure dir not found: $INFRA_DIR"
  if [ -z "$ADMIN_EMAIL" ]; then
    ADMIN_EMAIL=$(aws cloudformation describe-stacks --region "$REGION" --stack-name DeploymentPlatformStack \
      --query 'Stacks[0].Parameters[?ParameterKey==`AdminUserEmail`].ParameterValue' --output text 2>/dev/null || true)
  fi
  [ -n "$ADMIN_EMAIL" ] || die "Set ADMIN_USER_EMAIL for DeploymentPlatformStack"
  unblock_stuck_image_build_resource
  package_custom_resource_lambda
  publish_working_agent_image_tag
  log "Deploying DeploymentPlatformStack (CDK bundles TenantProvisionSubscriber; CodeBuild may rebuild agent image)"
  deploy_platform_stack
  if [ -n "${AIW_OAUTH_CALLBACK_URL:-}" ]; then
    log "Updating SSM AiwOAuthCallbackUrl"
    aws ssm put-parameter --region "$REGION" \
      --name /gaab-deployment-platform/AiwOAuthCallbackUrl \
      --type String --value "$AIW_OAUTH_CALLBACK_URL" --overwrite
  fi
  log "Waiting for stack (CodeBuild may take 15–30 minutes)..."
  for _ in $(seq 1 120); do
    st=$(stack_status)
    case "$st" in
      CREATE_COMPLETE|UPDATE_COMPLETE) break ;;
      UPDATE_ROLLBACK_*|ROLLBACK_*|DELETE_*|FAILED) die "Platform deploy failed: $st (see CloudFormation events)" ;;
    esac
    sleep 30
  done
  verify_platform_stack
  verify_ssm_image
  "$SCRIPT_DIR/verify-gaab-strands-agent-image.sh"
  log "Run setup-platform-tool-oauth-providers.sh if Google OAuth providers are not configured"
  log "Platform deploy complete"
  cmd_aiw_checklist
}

cmd_deploy_provision_fixes() {
  require_aws
  verify_platform_stack
  verify_ssm_image
  log "Hotswapping DeploymentPlatformStack (TenantProvisionSubscriber runtime sync + SSM IAM)"
  deploy_platform_stack hotswap
  if [ -n "${AIW_OAUTH_CALLBACK_URL:-}" ]; then
    aws ssm put-parameter --region "$REGION" \
      --name /gaab-deployment-platform/AiwOAuthCallbackUrl \
      --type String --value "$AIW_OAUTH_CALLBACK_URL" --overwrite
  fi
  log "Done. Next AIW workspace create will sync v4.1.9-platform + AIW_TENANT_ID on the agent runtime."
}

cmd_stage_assets() {
  require_aws
  [ -d "$SOURCE_ROOT" ] || die "source root not found: $SOURCE_ROOT"
  log "Staging CDK assets (AgentBuilderStack includes AiwFigmaToolProxyInvoke IAM)"
  (
    cd "$SOURCE_ROOT/infrastructure"
    export SKIP_ECR_PREBUILD=1
    npm run build --silent
    cd ..
    STAGE_ASSETS_SKIP_ECR=true STAGE_ASSETS_ASSUME_YES=true SKIP_ECR_PREBUILD=1 AWS_REGION="$REGION" ./stage-assets.sh
  )
  log "Verifying staged AgentBuilder template"
  aws s3 cp "s3://cdk-hnb659fds-assets-${AWS_ACCOUNT_ID:-635434164361}-${REGION}/AgentBuilderStack.template.json" /tmp/AgentBuilderStack.staged.json --region "$REGION"
  grep -q AiwFigmaToolProxyInvoke /tmp/AgentBuilderStack.staged.json && grep -q figmatoolproxy /tmp/AgentBuilderStack.staged.json \
    || die "Staged template missing Figma proxy IAM"
  log "stage-assets complete"
}

cmd_aiw_checklist() {
  cat <<'EOF'

--- AIW full E2E (tear down + recreate) ---

GAAB (once per environment, or after agent-image code changes):
  1. bash source/scripts/e2e-aiw-tool-connections.sh platform-deploy
     (or deploy-provision-fixes if platform stack is already green)
  2. bash source/scripts/setup-platform-tool-oauth-providers.sh  # if Connect fails

AIW (Amplify app) — your test:
  3. Remove workspace / agent instance in AIW
  4. Create a new workspace from template (wait until status = active / runtime ready)
  5. Connections → Connect Gmail → status Connected
  6. New chat → "List my last 5 emails"

Expected (no manual AWS console / docker):
  - Runtime image: .../gaab-strands-agent:v4.1.9-platform (from SSM)
  - Runtime env: AIW_TENANT_ID, AIW_OAUTH_WORKLOAD_NAME, AIW_OAUTH_CALLBACK_URL
  - Agent tool: list_gmail_messages (direct Gmail API)

EOF
}

case "${1:-verify}" in
  verify) cmd_verify ;;
  platform-deploy) cmd_platform_deploy ;;
  deploy-provision-fixes) cmd_deploy_provision_fixes ;;
  stage-assets) cmd_stage_assets ;;
  aiw-checklist) cmd_aiw_checklist ;;
  *)
    echo "Usage: $0 {verify|platform-deploy|deploy-provision-fixes|stage-assets|aiw-checklist}"
    exit 1
    ;;
esac
