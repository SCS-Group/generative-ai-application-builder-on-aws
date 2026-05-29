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
# Figma-only (Google already configured):
#   export FIGMA_CLIENT_ID=...
#   export FIGMA_CLIENT_SECRET=...
#   export FIGMA_ONLY=1
#   ./setup-platform-tool-oauth-providers.sh

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
GOOGLE_DISCOVERY="${GOOGLE_DISCOVERY_URL:-https://accounts.google.com/.well-known/openid-configuration}"
DROPBOX_DISCOVERY="${DROPBOX_DISCOVERY_URL:-https://www.dropbox.com/.well-known/openid-configuration}"
GOOGLE_PROVIDER_NAME="${GOOGLE_PROVIDER_NAME:-platform-google}"
DROPBOX_PROVIDER_NAME="${DROPBOX_PROVIDER_NAME:-platform-dropbox}"
FIGMA_PROVIDER_NAME="${FIGMA_PROVIDER_NAME:-platform-figma}"

FIGMA_ONLY="${FIGMA_ONLY:-0}"

resolve_ssm_param_name() {
  local name="${SSM_PARAM_NAME:-}"
  if [[ -z "$name" ]]; then
    name=$(aws cloudformation describe-stack-resources \
      --stack-name DeploymentPlatformStack \
      --logical-resource-id ToolConnectionOAuthProviders9EA6D85D \
      --query 'StackResources[0].PhysicalResourceId' --output text 2>/dev/null || true)
  fi
  if [[ -z "$name" || "$name" == "None" ]]; then
    return 1
  fi
  echo "$name"
}

load_existing_oauth_ssm() {
  local param_name
  param_name="$(resolve_ssm_param_name)" || return 1
  aws ssm get-parameter --name "$param_name" --region "$REGION" --query Parameter.Value --output text 2>/dev/null || true
}

provider_arn_from_existing() {
  local key="$1"
  local existing_json="${2:-}"
  if [[ -z "$existing_json" ]]; then
    return 1
  fi
  echo "$existing_json" | jq -r --arg k "$key" '.[$k].credentialProviderArn // empty' 2>/dev/null || true
}

lookup_provider_arn_by_name() {
  local name="$1"
  if aws bedrock-agentcore-control get-oauth2-credential-provider --name "$name" --region "$REGION" >/dev/null 2>&1; then
    aws bedrock-agentcore-control get-oauth2-credential-provider --name "$name" --region "$REGION" \
      --query credentialProviderArn --output text
    return 0
  fi
  return 1
}

if [[ -n "${FIGMA_CLIENT_ID:-}" && -n "${FIGMA_CLIENT_SECRET:-}" && ( -z "${GOOGLE_CLIENT_ID:-}" || -z "${GOOGLE_CLIENT_SECRET:-}" || "$FIGMA_ONLY" == "1" ) ]]; then
  FIGMA_ONLY=1
fi

if [[ "$FIGMA_ONLY" != "1" && ( -z "${GOOGLE_CLIENT_ID:-}" || -z "${GOOGLE_CLIENT_SECRET:-}" ) ]]; then
  if [[ -n "${FIGMA_CLIENT_ID:-}" && -n "${FIGMA_CLIENT_SECRET:-}" ]]; then
    echo "Google credentials not set; running Figma-only update (FIGMA_ONLY=1)." >&2
    FIGMA_ONLY=1
  else
    echo "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET for Figma-only." >&2
    exit 1
  fi
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

create_figma_provider() {
  local name="$1"
  local client_id="$2"
  local client_secret="$3"
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
        \"oauthDiscovery\": {
          \"authorizationServerMetadata\": {
            \"issuer\": \"https://www.figma.com\",
            \"authorizationEndpoint\": \"https://www.figma.com/oauth\",
            \"tokenEndpoint\": \"https://api.figma.com/v1/oauth/token\",
            \"responseTypes\": [\"code\"],
            \"tokenEndpointAuthMethods\": [\"client_secret_post\"]
          }
        },
        \"clientId\": \"$client_id\",
        \"clientSecret\": \"$client_secret\"
      }
    }" \
    --region "$REGION" \
    --query credentialProviderArn --output text
}

echo "Creating Google OAuth provider ($GOOGLE_PROVIDER_NAME)..."
GOOGLE_ARN=""
DROPBOX_ARN=""
FIGMA_ARN=""
EXISTING_JSON=""

if [[ "$FIGMA_ONLY" == "1" ]]; then
  EXISTING_JSON="$(load_existing_oauth_ssm || true)"
  GOOGLE_ARN="$(provider_arn_from_existing "platform-google-drive" "$EXISTING_JSON")"
  if [[ -z "$GOOGLE_ARN" ]]; then
    GOOGLE_ARN="$(lookup_provider_arn_by_name "$GOOGLE_PROVIDER_NAME" || true)"
  fi
  DROPBOX_ARN="$(provider_arn_from_existing "platform-dropbox" "$EXISTING_JSON")"
  if [[ -z "$DROPBOX_ARN" ]]; then
    DROPBOX_ARN="$GOOGLE_ARN"
  fi
  if [[ -z "$GOOGLE_ARN" ]]; then
    echo "Figma-only mode: could not resolve existing Google provider ARN from SSM or AgentCore." >&2
    echo "Either set GOOGLE_CLIENT_ID/SECRET for a full run, or ensure platform-google exists." >&2
    exit 1
  fi
  echo "Figma-only: keeping existing Google/Dropbox ARNs from SSM/AgentCore."
else
  GOOGLE_ARN="$(create_provider "$GOOGLE_PROVIDER_NAME" "$GOOGLE_DISCOVERY" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET")"
  echo "  ARN: $GOOGLE_ARN"

  if [[ -n "${DROPBOX_CLIENT_ID:-}" && -n "${DROPBOX_CLIENT_SECRET:-}" ]]; then
    echo "Creating Dropbox OAuth provider ($DROPBOX_PROVIDER_NAME)..."
    DROPBOX_ARN="$(create_provider "$DROPBOX_PROVIDER_NAME" "$DROPBOX_DISCOVERY" "$DROPBOX_CLIENT_ID" "$DROPBOX_CLIENT_SECRET")"
    echo "  ARN: $DROPBOX_ARN"
  else
    echo "DROPBOX_CLIENT_ID/SECRET not set; platform-dropbox will use Google ARN (create Dropbox app later)."
    DROPBOX_ARN="$GOOGLE_ARN"
  fi
fi

if [[ -z "${DROPBOX_ARN}" ]]; then
  DROPBOX_ARN="$GOOGLE_ARN"
fi

if [[ -n "${FIGMA_CLIENT_ID:-}" && -n "${FIGMA_CLIENT_SECRET:-}" ]]; then
  echo "Creating Figma OAuth provider ($FIGMA_PROVIDER_NAME)..."
  FIGMA_ARN="$(create_figma_provider "$FIGMA_PROVIDER_NAME" "$FIGMA_CLIENT_ID" "$FIGMA_CLIENT_SECRET")"
  echo "  ARN: $FIGMA_ARN"
else
  FIGMA_ARN="$(provider_arn_from_existing "platform-figma" "$EXISTING_JSON")"
  if [[ -z "$FIGMA_ARN" ]]; then
    FIGMA_ARN="$(lookup_provider_arn_by_name "$FIGMA_PROVIDER_NAME" || true)"
  fi
  if [[ -z "$FIGMA_ARN" ]]; then
    echo "FIGMA_CLIENT_ID/SECRET not set; platform-figma will use REPLACE_WITH placeholder until configured."
    FIGMA_ARN="REPLACE_WITH_PLATFORM_FIGMA_ARN"
  else
    echo "Keeping existing Figma provider ARN: $FIGMA_ARN"
  fi
fi

JSON=$(jq -n \
  --arg g "$GOOGLE_ARN" \
  --arg d "$DROPBOX_ARN" \
  --arg f "$FIGMA_ARN" \
  '{
    "platform-google-drive": {"credentialProviderArn": $g},
    "platform-gmail": {"credentialProviderArn": $g},
    "platform-dropbox": {"credentialProviderArn": $d},
    "platform-figma": {"credentialProviderArn": $f}
  }')

SSM_NAME="$(resolve_ssm_param_name || true)"

if [[ -z "$SSM_NAME" || "$SSM_NAME" == "None" ]]; then
  echo "Could not resolve SSM parameter name. Set SSM_PARAM_NAME and run:" >&2
  echo "  aws ssm put-parameter --name \"\$SSM_PARAM_NAME\" --type String --value '\$JSON' --overwrite" >&2
  echo "$JSON"
  exit 0
fi

echo "Updating SSM $SSM_NAME ..."
aws ssm put-parameter --name "$SSM_NAME" --type String --value "$JSON" --overwrite --region "$REGION"

# Lambdas read OAuth map from env at deploy time; refresh after SSM update.
for fn in $(aws lambda list-functions --region "$REGION" --query "Functions[?contains(FunctionName,'TenantToolConnectionSubscr') || contains(FunctionName,'TenantToolIntegrationInstaller')].FunctionName" --output text); do
  if [[ -n "$fn" ]]; then
    echo "Updating Lambda environment on $fn ..."
    ENV=$(aws lambda get-function-configuration --function-name "$fn" --query 'Environment.Variables' --output json)
    NEW_ENV=$(echo "$ENV" | jq --arg j "$JSON" '.TOOL_CONNECTION_OAUTH_PROVIDERS_JSON = $j')
    aws lambda update-function-configuration --function-name "$fn" \
      --environment "$(jq -n --argjson v "$NEW_ENV" '{Variables: $v}')" --region "$REGION" >/dev/null
  fi
done
echo "Lambda env updated. Retry Connect in AIW."

echo "Done. Do NOT use gaab-oauth-provider-* for Gmail/Drive — that ARN is GAAB Cognito M2M only."
