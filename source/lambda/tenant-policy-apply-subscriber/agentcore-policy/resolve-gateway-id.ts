// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GetGatewayCommand, ListGatewaysCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { getAgentCoreControlClient } from './client';

export type ResolvedGateway = {
    gatewayId: string;
    gatewayName: string;
    gatewayArn?: string;
};

function gatewayNameFromUseCaseId(gaabMcpGatewayUseCaseId: string): string {
    return `gaab-mcp-${gaabMcpGatewayUseCaseId.slice(0, 8)}`;
}

async function listAllGateways(): Promise<Array<{ gatewayId?: string; name?: string }>> {
    const control = getAgentCoreControlClient();
    const items: Array<{ gatewayId?: string; name?: string }> = [];
    let nextToken: string | undefined;

    do {
        const out = await control.send(
            new ListGatewaysCommand({
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        items.push(...((out.items ?? []) as Array<{ gatewayId?: string; name?: string }>));
        nextToken = out.nextToken;
    } while (nextToken);

    return items;
}

export async function resolveGatewayId(gaabMcpGatewayUseCaseId: string): Promise<ResolvedGateway> {
    const useCaseId = gaabMcpGatewayUseCaseId.trim();
    if (!useCaseId) {
        throw new Error('gaabMcpGatewayUseCaseId is required to resolve MCP gateway');
    }

    const expectedName = gatewayNameFromUseCaseId(useCaseId);
    const items = await listAllGateways();
    const match = items.find((g) => (g.name ?? '').trim() === expectedName);
    if (!match?.gatewayId) {
        throw new Error(`Gateway not found for ${useCaseId} (expected name ${expectedName})`);
    }

    const control = getAgentCoreControlClient();
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: match.gatewayId }));
    return {
        gatewayId: match.gatewayId,
        gatewayName: expectedName,
        gatewayArn: gateway.gatewayArn
    };
}
