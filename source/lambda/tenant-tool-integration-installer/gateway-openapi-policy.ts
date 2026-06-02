// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    BedrockAgentCoreControlClient,
    GetApiKeyCredentialProviderCommand,
    GetGatewayCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';

function roleNameFromArn(roleArn: string): string {
    const name = roleArn.split('/').pop()?.trim();
    if (!name) {
        throw new Error(`Invalid gateway role ARN: ${roleArn}`);
    }
    return name;
}

function tokenVaultArnFromProviderArn(providerArn: string): string {
    const parts = providerArn.split('/');
    if (parts.length < 2) {
        throw new Error(`Invalid credential provider ARN: ${providerArn}`);
    }
    return `${parts[0]}/${parts[1]}`;
}

/**
 * Grant the MCP gateway role access to an API-key credential provider (Discord, BYO OpenAPI).
 * Mirrors GAAB custom-resource GatewayPolicyManager.add_openapi_policy for API_KEY targets.
 */
export async function ensureGatewayApiKeyPolicy(params: {
    gatewayId: string;
    targetName: string;
    providerArn: string;
    region?: string;
}): Promise<void> {
    const providerArn = params.providerArn.trim();
    const providerName = providerArn.split('/').pop()?.trim();
    if (!providerName) {
        throw new Error(`Invalid credential provider ARN: ${providerArn}`);
    }

    const region = params.region ?? process.env.AWS_REGION ?? 'us-east-1';
    const control = new BedrockAgentCoreControlClient({ region });
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: params.gatewayId }));
    const roleArn = gateway.roleArn?.trim();
    if (!roleArn) {
        throw new Error(`Gateway ${params.gatewayId} has no roleArn`);
    }

    const cred = await control.send(new GetApiKeyCredentialProviderCommand({ name: providerName }));
    const secretArn = cred.apiKeySecretArn?.secretArn?.trim();
    if (!secretArn) {
        throw new Error(`API key provider ${providerName} has no secretArn`);
    }

    const policyName = `${params.targetName}-${providerName}-access-policy`.slice(0, 128);
    const policyDocument = {
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Action: ['bedrock-agentcore:GetResourceApiKey'],
                Resource: [tokenVaultArnFromProviderArn(providerArn), providerArn]
            },
            {
                Effect: 'Allow',
                Action: ['secretsmanager:GetSecretValue'],
                Resource: [secretArn]
            }
        ]
    };

    const iam = new IAMClient({ region });
    await iam.send(
        new PutRolePolicyCommand({
            RoleName: roleNameFromArn(roleArn),
            PolicyName: policyName,
            PolicyDocument: JSON.stringify(policyDocument)
        })
    );
}
