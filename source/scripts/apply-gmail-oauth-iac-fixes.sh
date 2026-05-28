#!/usr/bin/env bash
# Apply Gmail OAuth IaC/runtime fixes without Docker (Lambda zip + CFN stack updates).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
CB="${AIW_OAUTH_CALLBACK_URL:-https://main.dlv006bgs1hxc.amplifyapp.com/oauth/callback}"
TENANT="${AIW_TENANT_ID:-8d8480cc-6b5f-4d3f-b281-94a697de224a}"
AGENT_USE_CASE_ID="${AGENT_USE_CASE_ID:-f4ae196e-a59f-4ae2-9e99-0e7e1b459b35}"
GW_ID="${MCP_GATEWAY_ID:-gaab-mcp-05578852-t8twlpykvz}"
PROVIDER_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default/oauth2credentialprovider/platform-google"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CR_DIR="${ROOT}/lambda/custom-resource"
UM_DIR="${ROOT}/lambda/use-case-management"
ZIP_CR="/tmp/gaab-custom-resource-$(date +%s).zip"
ZIP_UM="/tmp/gaab-use-case-mgmt-$(date +%s).zip"

echo "=== Packaging custom-resource Lambda ==="
(cd "$CR_DIR" && zip -qr "$ZIP_CR" . -x 'test/*' '__pycache__/*' '*.pyc' '.pytest_cache/*')

echo "=== Packaging use-case-management Lambda ==="
(cd "$UM_DIR" && zip -qr "$ZIP_UM" . -x 'test/*' '__pycache__/*' '*.pyc' '.pytest_cache/*' 'node_modules/*')

echo "=== Updating shared custom-resource Lambdas ==="
aws lambda list-functions --region "$REGION" --output json |
  python3 -c "
import json,sys,subprocess
z=sys.argv[1]
for f in json.load(sys.stdin)['Functions']:
    n=f['FunctionName']
    if 'Custom' in n and ('InfraSetup' in n or 'DeploymentPlatformSetupInf' in n) and 'Bucket' not in n and 'Scheduled' not in n:
        print(n)
" "$ZIP_CR" | while read -r fn; do
  echo "  update $fn"
  aws lambda update-function-code --region "$REGION" --function-name "$fn" --zip-file "fileb://${ZIP_CR}" --output text --query 'FunctionName'
done

echo "=== Updating use-case-management Lambdas ==="
aws lambda list-functions --region "$REGION" --output json |
  python3 -c "
import json,sys
for f in json.load(sys.stdin)['Functions']:
    n=f['FunctionName']
    if 'UseCaseManagement' in n and 'AgentManagement' in n:
        print(n)
" | while read -r fn; do
  echo "  update $fn"
  aws lambda update-function-code --region "$REGION" --function-name "$fn" --zip-file "fileb://${ZIP_UM}" --output text --query 'FunctionName' 2>/dev/null || true
done

# Agent management API lambda name pattern
AGENT_MGMT=$(aws lambda list-functions --region "$REGION" --output json |
  python3 -c "import json,sys
for f in json.load(sys.stdin)['Functions']:
    n=f['FunctionName']
    if 'AgentManagementLambda' in n or n.endswith('AgentManagementLambdaB2E-AyL5uDt32ZAZ'):
        print(n); break
")
if [[ -n "$AGENT_MGMT" && "$AGENT_MGMT" != "None" ]]; then
  echo "=== Updating $AGENT_MGMT ==="
  aws lambda update-function-code --region "$REGION" --function-name "$AGENT_MGMT" --zip-file "fileb://${ZIP_UM}" --output text --query 'FunctionName'
fi

echo "=== Patching MCP gateway OAuth targets on $GW_ID ==="
for TARGET in gmail google-drive; do
  TID=$(aws bedrock-agentcore-control list-gateway-targets --region "$REGION" --gateway-identifier "$GW_ID" --query "items[?name=='$TARGET'].targetId | [0]" --output text)
  [[ -z "$TID" || "$TID" == "None" ]] && continue
  S3=$(aws bedrock-agentcore-control get-gateway-target --region "$REGION" --gateway-identifier "$GW_ID" --target-id "$TID" --query 'targetConfiguration.mcp.openApiSchema.s3.uri' --output text)
  if [[ "$TARGET" == "gmail" ]]; then SCOPES='["https://www.googleapis.com/auth/gmail.readonly"]'; else SCOPES='["https://www.googleapis.com/auth/drive.readonly"]'; fi
  aws bedrock-agentcore-control update-gateway-target --region "$REGION" \
    --gateway-identifier "$GW_ID" --target-id "$TID" --name "$TARGET" \
    --description "$TARGET (AIW prewired)" \
    --target-configuration "{\"mcp\":{\"openApiSchema\":{\"s3\":{\"uri\":\"$S3\"}}}}" \
    --credential-provider-configurations "[{\"credentialProviderType\":\"OAUTH\",\"credentialProvider\":{\"oauthCredentialProvider\":{\"providerArn\":\"$PROVIDER_ARN\",\"grantType\":\"AUTHORIZATION_CODE\",\"defaultReturnUrl\":\"$CB\",\"scopes\":$SCOPES}}}]" \
    --query '[name,status]' --output text
done

echo "=== Syncing agent runtime AIW_TENANT_ID ==="
RT_NAME="gaab_agent_${AGENT_USE_CASE_ID%%-*}"
RT_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --max-results 50 --output json |
  python3 -c "import json,sys; n=sys.argv[1]; print(next((x['agentRuntimeId'] for x in json.load(sys.stdin).get('agentRuntimes',[]) if x.get('agentRuntimeName')==n),''))" "$RT_NAME")
DESCRIBE=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RT_ID" --output json)
python3 -c "
import json,os,subprocess
rt=os.environ['RT_ID']
d=json.loads(os.environ['DESCRIBE'])
env=dict(d.get('environmentVariables') or {})
env['AIW_TENANT_ID']=os.environ['TENANT']
req={'agentRuntimeId':rt,'agentRuntimeArtifact':d['agentRuntimeArtifact'],'roleArn':d['roleArn'],
     'networkConfiguration':d.get('networkConfiguration',{'networkMode':'PUBLIC'}),
     'environmentVariables':env}
if d.get('protocolConfiguration'): req['protocolConfiguration']=d['protocolConfiguration']
if d.get('lifecycleConfiguration'): req['lifecycleConfiguration']=d['lifecycleConfiguration']
subprocess.run(['aws','bedrock-agentcore-control','update-agent-runtime','--region',os.environ['REGION'],
  '--cli-input-json',json.dumps(req)],check=True)
print('Runtime updated',rt,'AIW_TENANT_ID=',env.get('AIW_TENANT_ID'))
" 

echo "=== CFN stack update (agent + MCP) to re-run custom resources ==="
for STACK in "test-2-${AGENT_USE_CASE_ID%%-*}" "AIW-Tools-test-2-05578852"; do
  if aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null; then
    echo "  updating stack $STACK"
    aws cloudformation update-stack --region "$REGION" --stack-name "$STACK" \
      --use-previous-template --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Parameters' --output json | python3 -c "
import json,sys
params=json.load(sys.stdin)
print(' '.join(f\"ParameterKey={p['ParameterKey']} ParameterValue={p['ParameterValue']}\" for p in params))
")" 2>&1 | head -3 || echo "  (stack update skipped or no changes: $STACK)"
  fi
done

echo "=== Done. Start a new agent chat and test Gmail. ==="
