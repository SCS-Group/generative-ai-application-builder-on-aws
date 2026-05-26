#!/usr/bin/env bash
# Create AgentCore Identity OAuth providers for AIW tool connections (Google + Dropbox)
# and update DeploymentPlatformStack SSM ToolConnectionOAuthProviders.
#
# Prerequisites:
#   - Google Cloud OAuth client (Web application) with authorized redirect URI:
#       https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/*
#     (AgentCore registers an exact callback on the provider; also add your AIW URL in Google console
#      if Google redirects to AIW after AgentCore completes the flow.)
#   - Dropbox app with redirect URIs as required by AgentCore + AIW callback.
#
# Usage:
#   export GOOGLE_CLIENT_ID=...
#   export GOOGLE_CLIENT_SECRET=...
#   export DROPBOX_CLIENT_ID=...
#   export DROPBOX_CLIENT_SECRET=...
#   export AWS_REGION=us-east-1
#   ./setup-platform-tool-oauth-providers.sh
#
# Optional:
#   export AIW_OAUTH_CALLBACK_URL=https://main.dlv006bgs1hxc.amplifyapp.com/oauth/callback
#   export SSM_PARAM_NAME=CFN-ToolConnectionOAuthProviders9EA6D85D-RLpq565e0Pxq

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
GOOGLE_DISCOVERY="${GOOGLE_DISCOVERY_URL:-https://accounts.google.com/.well-known/openid-configuration}"
DROPBOX_DISCOVERY="${DROPBOX_DISCOVERY_URL:-https://www.dropbox.com/.well-known/openid-configuration}"
GOOGLE_PROVIDER_NAME="${GOOGLE_PROVIDER_NAME:-platform-google}"
DROPBOX_PROVIDER_NAME="${DROPBOX_PROVIDER_NAME:-platform-dropbox}"

if [[ -z "${GOOGLE_CLIENT_ID:-}" || -z "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  echo "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (from Google Cloud Console)." >&2
  exit 1
fi

create_provider() {
  local name="$1"
  local discovery="$2"
  local client_id="$3"
  local client_secret="$4"
  if aws bedrock-agentcore-control get-oauth2-credential-provider --name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo "Provider $name already exists; skipping create."
    aws bedrock-agentcore-control get-oauth2-credential-provider --name "$name" --region "$REGION" \
      --query credentialProviderArn --output text
    return
  fi
  aws bedrock-agentcore-control create-oauth2-credential-provider \
    --name "$name" \
    --credential-provider-vendor CustomOauth2 \
    --oauth2-provider-config-input "{
      \"customOauth2ProviderConfig\": {
        \"oauthDiscovery\": { \"discoveryUrl\": \"$discovery\" },
        \"clientId\": \"$client_id\",
        \"clientSecret\": \"$client_secret\"
      }
    }" \
    --region "$REGION" \
    --query credentialProviderArn --output text
}

echo "Creating Google OAuth provider ($GOOGLE_PROVIDER_NAME)..."
GOOGLE_ARN="$(create_provider "$GOOGLE_PROVIDER_NAME" "$GOOGLE_DISCOVERY" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET")"
echo "  ARN: $GOOGLE_ARN"

DROPBOX_ARN=""
if [[ -n "${DROPBOX_CLIENT_ID:-}" && -n "${DROPBOX_CLIENT_SECRET:-}" ]]; then
  echo "Creating Dropbox OAuth provider ($DROPBOX_PROVIDER_NAME)..."
  DROPBOX_ARN="$(create_provider "$DROPBOX_PROVIDER_NAME" "$DROPBOX_DISCOVERY" "$DROPBOX_CLIENT_ID" "$DROPBOX_CLIENT_SECRET")"
  echo "  ARN: $DROPBOX_ARN"
else
  echo "DROPBOX_CLIENT_ID/SECRET not set; platform-dropbox will use Google ARN (create Dropbox app later)."
  DROPBOX_ARN="$GOOGLE_ARN"
fi

if [[ -z "${DROPBOX_ARN}" ]]; then
  DROPBOX_ARN="$GOOGLE_ARN"
fi

JSON=$(jq -n \
  --arg g "$GOOGLE_ARN" \
  --arg d "$DROPBOX_ARN" \
  '{
    "platform-google-drive": {"credentialProviderArn": $g},
    "platform-gmail": {"credentialProviderArn": $g},
    "platform-dropbox": {"credentialProviderArn": $d}
  }')

SSM_NAME="${SSM_PARAM_NAME:-}"
if [[ -z "$SSM_NAME" ]]; then
  SSM_NAME=$(aws cloudformation describe-stack-resources \
    --stack-name DeploymentPlatformStack \
    --logical-resource-id ToolConnectionOAuthProviders9EA6D85D \
    --query 'StackResources[0].PhysicalResourceId' --output text 2>/dev/null || true)
fi

if [[ -z "$SSM_NAME" || "$SSM_NAME" == "None" ]]; then
  echo "Could not resolve SSM parameter name. Set SSM_PARAM_NAME and run:" >&2
  echo "  aws ssm put-parameter --name \"\$SSM_PARAM_NAME\" --type String --value '\$JSON' --overwrite" >&2
  echo "$JSON"
  exit 0
fi

echo "Updating SSM $SSM_NAME ..."
aws ssm put-parameter --name "$SSM_NAME" --type String --value "$JSON" --overwrite --region "$REGION"

# Lambda reads OAuth map from env at deploy time; update function env or redeploy stack.
FN=$(aws lambda list-functions --query "Functions[?contains(FunctionName,'TenantToolConnectionSubscr')].FunctionName" --output text | head -1)
if [[ -n "$FN" ]]; then
  echo "Updating Lambda environment on $FN ..."
  ENV=$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)
  NEW_ENV=$(echo "$ENV" | jq --arg j "$JSON" '.TOOL_CONNECTION_OAUTH_PROVIDERS_JSON = $j')
  aws lambda update-function-configuration --function-name "$FN" \
    --environment "$(jq -n --argjson v "$NEW_ENV" '{Variables: $v}')" --region "$REGION" >/dev/null
  echo "Lambda env updated. Retry Connect in AIW."
fi

echo "Done. Do NOT use gaab-oauth-provider-* for Gmail/Drive — that ARN is GAAB Cognito M2M only."
