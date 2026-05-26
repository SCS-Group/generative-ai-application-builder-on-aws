#!/usr/bin/env bash
# Attach inline IAM on a test (or any) use-case stack custom-resource role so AgentCore
# teardown succeeds when the nested stack was created before delete IAM was in CDK.
#
# Usage:
#   ./source/scripts/patch-stack-agentcore-delete-iam.sh tpl-test-test-ff91a52b-a65a76e6
#   AWS_REGION=us-east-1 ./source/scripts/patch-stack-agentcore-delete-iam.sh <stack-name>

set -euo pipefail

STACK_NAME="${1:?stack name required}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
PARTITION="${AWS_PARTITION:-aws}"

ROLE_ARN="$(aws cloudformation describe-stack-resources \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "StackResources[?contains(LogicalResourceId, 'UseCaseSetupCustomResourc') && ResourceType=='AWS::IAM::Role'].PhysicalResourceId | [0]" \
  --output text)"

if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
  echo "Could not find UseCaseSetup custom resource role in stack $STACK_NAME" >&2
  exit 1
fi

ROLE_NAME="${ROLE_ARN##*/}"
POLICY_NAME="GAABAgentCoreDeletePatch"

cat > /tmp/gaab-agentcore-delete-patch.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AgentCoreRuntimeDelete",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:DeleteAgentRuntime",
        "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
        "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:GetAgentRuntimeEndpoint",
        "bedrock-agentcore:ListAgentRuntimes",
        "bedrock-agentcore:ListAgentRuntimeEndpoints",
        "bedrock-agentcore:DeleteWorkloadIdentity",
        "bedrock-agentcore:GetWorkloadIdentity",
        "bedrock-agentcore:ListWorkloadIdentities"
      ],
      "Resource": [
        "arn:${PARTITION}:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/*",
        "arn:${PARTITION}:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/*/runtime-endpoint/*",
        "arn:${PARTITION}:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/*",
        "arn:${PARTITION}:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/*"
      ]
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document file:///tmp/gaab-agentcore-delete-patch.json

echo "Attached inline policy ${POLICY_NAME} to role ${ROLE_NAME} (stack ${STACK_NAME})"
