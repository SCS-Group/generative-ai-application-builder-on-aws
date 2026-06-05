// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GetGatewayCommand, UpdateGatewayCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import type { GatewayPolicyEngineMode } from './types';
import { getAgentCoreControlClient } from './client';
import { ensureGatewayPolicyEngineAccess } from './ensure-gateway-policy-engine-access';
import { logger } from '../power-tools-init';

export async function associateGatewayPolicyEngine(opts: {
    gatewayId: string;
    policyEngineArn: string;
    tenantTemplateInstanceId: string;
    mode?: GatewayPolicyEngineMode;
}): Promise<void> {
    const control = getAgentCoreControlClient();
    const mode = opts.mode ?? 'LOG_ONLY';
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: opts.gatewayId }));

    if (!gateway.name || !gateway.roleArn || !gateway.authorizerType || !gateway.protocolType) {
        throw new Error(`Gateway ${opts.gatewayId} is missing fields required for policy engine association`);
    }

    await ensureGatewayPolicyEngineAccess({
        gatewayRoleArn: gateway.roleArn,
        policyEngineArn: opts.policyEngineArn,
        tenantTemplateInstanceId: opts.tenantTemplateInstanceId
    });

    const updateInput = {
        gatewayIdentifier: opts.gatewayId,
        name: gateway.name,
        roleArn: gateway.roleArn,
        authorizerType: gateway.authorizerType,
        protocolType: gateway.protocolType,
        ...(gateway.description ? { description: gateway.description } : {}),
        ...(gateway.protocolConfiguration ? { protocolConfiguration: gateway.protocolConfiguration } : {}),
        ...(gateway.authorizerConfiguration ? { authorizerConfiguration: gateway.authorizerConfiguration } : {}),
        ...(gateway.kmsKeyArn ? { kmsKeyArn: gateway.kmsKeyArn } : {}),
        ...(gateway.interceptorConfigurations
            ? { interceptorConfigurations: gateway.interceptorConfigurations }
            : {}),
        policyEngineConfiguration: {
            arn: opts.policyEngineArn,
            mode
        }
    };

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await control.send(new UpdateGatewayCommand(updateInput));
            break;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const iamPropagation =
                message.includes('GetPolicyEngine') && message.includes('Access denied');
            if (!iamPropagation || attempt === maxAttempts) {
                throw e;
            }
            const delayMs = attempt * 2000;
            logger.info('Waiting for gateway role IAM propagation before policy association', {
                gatewayId: opts.gatewayId,
                attempt,
                delayMs
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    logger.info('Associated policy engine with MCP gateway', {
        gatewayId: opts.gatewayId,
        policyEngineArn: opts.policyEngineArn,
        mode
    });
}
