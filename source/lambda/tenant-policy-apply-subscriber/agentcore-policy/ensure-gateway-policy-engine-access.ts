// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { logger } from '../power-tools-init';

function roleNameFromArn(roleArn: string): string {
    const name = roleArn.split('/').pop()?.trim();
    if (!name) {
        throw new Error(`Invalid gateway role ARN: ${roleArn}`);
    }
    return name;
}

/**
 * AgentCore validates the gateway execution role can read the associated policy engine.
 */
export async function ensureGatewayPolicyEngineAccess(opts: {
    gatewayRoleArn: string;
    policyEngineArn: string;
    tenantTemplateInstanceId: string;
    region?: string;
}): Promise<void> {
    const roleArn = opts.gatewayRoleArn.trim();
    const policyEngineArn = opts.policyEngineArn.trim();
    if (!roleArn || !policyEngineArn) {
        throw new Error('gatewayRoleArn and policyEngineArn are required');
    }

    const suffix = opts.tenantTemplateInstanceId.replace(/-/g, '').slice(0, 8);
    const policyName = `aiw-pe-access-${suffix}`.slice(0, 128);
    const policyDocument = {
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Action: ['bedrock-agentcore:GetPolicyEngine'],
                Resource: [policyEngineArn]
            }
        ]
    };

    const iam = new IAMClient({ region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1' });
    await iam.send(
        new PutRolePolicyCommand({
            RoleName: roleNameFromArn(roleArn),
            PolicyName: policyName,
            PolicyDocument: JSON.stringify(policyDocument)
        })
    );

    logger.info('Granted gateway role GetPolicyEngine for workspace policy engine', {
        roleArn,
        policyEngineArn,
        policyName
    });
}
