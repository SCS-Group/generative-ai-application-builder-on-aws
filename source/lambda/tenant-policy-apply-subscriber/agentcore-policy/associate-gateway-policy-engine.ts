// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GetGatewayCommand, UpdateGatewayCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import type { GatewayPolicyEngineMode } from './types';
import { getAgentCoreControlClient } from './client';
import { logger } from '../power-tools-init';

export async function associateGatewayPolicyEngine(opts: {
    gatewayId: string;
    policyEngineArn: string;
    mode?: GatewayPolicyEngineMode;
}): Promise<void> {
    const control = getAgentCoreControlClient();
    const mode = opts.mode ?? 'LOG_ONLY';
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: opts.gatewayId }));

    if (!gateway.name || !gateway.roleArn || !gateway.authorizerType || !gateway.protocolType) {
        throw new Error(`Gateway ${opts.gatewayId} is missing fields required for policy engine association`);
    }

    await control.send(
        new UpdateGatewayCommand({
            gatewayIdentifier: opts.gatewayId,
            name: gateway.name,
            roleArn: gateway.roleArn,
            authorizerType: gateway.authorizerType,
            protocolType: gateway.protocolType,
            ...(gateway.description ? { description: gateway.description } : {}),
            ...(gateway.protocolConfiguration ? { protocolConfiguration: gateway.protocolConfiguration } : {}),
            ...(gateway.authorizerConfiguration
                ? { authorizerConfiguration: gateway.authorizerConfiguration }
                : {}),
            ...(gateway.kmsKeyArn ? { kmsKeyArn: gateway.kmsKeyArn } : {}),
            ...(gateway.interceptorConfigurations
                ? { interceptorConfigurations: gateway.interceptorConfigurations }
                : {}),
            policyEngineConfiguration: {
                arn: opts.policyEngineArn,
                mode
            }
        })
    );

    logger.info('Associated policy engine with MCP gateway', {
        gatewayId: opts.gatewayId,
        policyEngineArn: opts.policyEngineArn,
        mode
    });
}
