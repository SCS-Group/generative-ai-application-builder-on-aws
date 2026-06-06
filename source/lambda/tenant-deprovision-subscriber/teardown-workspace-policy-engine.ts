// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    DeletePolicyCommand,
    DeletePolicyEngineCommand,
    GetGatewayCommand,
    GetPolicyEngineCommand,
    ListGatewaysCommand,
    ListPoliciesCommand,
    ListPolicyEnginesCommand,
    UpdateGatewayCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getAgentCoreControlClient } from './agentcore-policy/client';
import { policyEngineNameForInstance } from './agentcore-policy/policy-engine-naming';
import { logger } from './power-tools-init';

export { policyEngineNameForInstance } from './agentcore-policy/policy-engine-naming';

function gatewayNameFromUseCaseId(gaabMcpGatewayUseCaseId: string): string {
    return `gaab-mcp-${gaabMcpGatewayUseCaseId.slice(0, 8)}`;
}

async function resolveGatewayId(gaabMcpGatewayUseCaseId: string): Promise<string | undefined> {
    const useCaseId = gaabMcpGatewayUseCaseId.trim();
    if (!useCaseId) return undefined;

    const expectedName = gatewayNameFromUseCaseId(useCaseId);
    const control = getAgentCoreControlClient();
    let nextToken: string | undefined;

    do {
        const out = await control.send(
            new ListGatewaysCommand({
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        const match = (out.items ?? []).find((g) => (g.name ?? '').trim() === expectedName);
        if (match?.gatewayId) {
            return match.gatewayId;
        }
        nextToken = out.nextToken;
    } while (nextToken);

    return undefined;
}

async function disassociateGatewayPolicyEngine(gatewayId: string): Promise<void> {
    const control = getAgentCoreControlClient();
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    if (!gateway.policyEngineConfiguration) {
        return;
    }
    if (!gateway.name || !gateway.roleArn || !gateway.authorizerType || !gateway.protocolType) {
        throw new Error(`Gateway ${gatewayId} is missing fields required to clear policy association`);
    }

    await control.send(
        new UpdateGatewayCommand({
            gatewayIdentifier: gatewayId,
            name: gateway.name,
            roleArn: gateway.roleArn,
            authorizerType: gateway.authorizerType,
            protocolType: gateway.protocolType,
            ...(gateway.description ? { description: gateway.description } : {}),
            ...(gateway.authorizerConfiguration
                ? { authorizerConfiguration: gateway.authorizerConfiguration }
                : {}),
            ...(gateway.protocolConfiguration ? { protocolConfiguration: gateway.protocolConfiguration } : {}),
            ...(gateway.kmsKeyArn ? { kmsKeyArn: gateway.kmsKeyArn } : {}),
            ...(gateway.interceptorConfigurations
                ? { interceptorConfigurations: gateway.interceptorConfigurations }
                : {})
        })
    );

    logger.info('Disassociated policy engine from MCP gateway', { gatewayId });
}

async function findPolicyEngineByName(name: string): Promise<string | undefined> {
    const control = getAgentCoreControlClient();
    let nextToken: string | undefined;

    do {
        const out = await control.send(
            new ListPolicyEnginesCommand({
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        const match = (out.policyEngines ?? []).find((e) => (e.name ?? '').trim() === name);
        if (match?.policyEngineId) {
            return match.policyEngineId;
        }
        nextToken = out.nextToken;
    } while (nextToken);

    return undefined;
}

async function deletePoliciesOnEngine(policyEngineId: string): Promise<void> {
    const control = getAgentCoreControlClient();
    let nextToken: string | undefined;

    do {
        const out = await control.send(
            new ListPoliciesCommand({
                policyEngineId,
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        for (const policy of out.policies ?? []) {
            const policyId = policy.policyId?.trim();
            if (!policyId) continue;
            await control.send(new DeletePolicyCommand({ policyEngineId, policyId }));
            logger.info('Deleted Cedar policy from workspace policy engine', { policyEngineId, policyId });
        }
        nextToken = out.nextToken;
    } while (nextToken);
}

async function waitForPolicyEngineDeleted(policyEngineId: string, timeoutMs = 120_000): Promise<void> {
    const control = getAgentCoreControlClient();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const out = await control.send(new GetPolicyEngineCommand({ policyEngineId }));
            const status = String(out.status ?? '');
            if (status === 'DELETE_FAILED') {
                throw new Error(`Policy engine ${policyEngineId} delete failed`);
            }
            logger.info('Waiting for policy engine deletion', { policyEngineId, status });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (message.includes('ResourceNotFoundException') || message.includes('not found')) {
                return;
            }
            throw e;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Timed out waiting for policy engine ${policyEngineId} to delete`);
}

/**
 * Best-effort AgentCore Policy teardown before MCP gateway stack delete.
 * Disassociates the policy engine from the live gateway, deletes Cedar policies, then deletes the engine.
 */
export async function teardownWorkspacePolicyEngine(opts: {
    tenantTemplateInstanceId: string;
    gaabMcpGatewayUseCaseId?: string;
}): Promise<void> {
    const instanceId = opts.tenantTemplateInstanceId.trim();
    const gaabMcpGatewayUseCaseId = opts.gaabMcpGatewayUseCaseId?.trim() ?? '';
    if (!instanceId) {
        return;
    }

    if (gaabMcpGatewayUseCaseId) {
        try {
            const gatewayId = await resolveGatewayId(gaabMcpGatewayUseCaseId);
            if (gatewayId) {
                await disassociateGatewayPolicyEngine(gatewayId);
            } else {
                logger.info('MCP gateway not found for policy disassociation; continuing with policy engine delete', {
                    gaabMcpGatewayUseCaseId
                });
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn('Failed to disassociate policy engine from gateway', {
                gaabMcpGatewayUseCaseId,
                message
            });
        }
    }

    const engineName = policyEngineNameForInstance(instanceId);
    const policyEngineId = await findPolicyEngineByName(engineName);
    if (!policyEngineId) {
        logger.info('No workspace policy engine to delete', { engineName, instanceId });
        return;
    }

    await deletePoliciesOnEngine(policyEngineId);
    const control = getAgentCoreControlClient();
    await control.send(new DeletePolicyEngineCommand({ policyEngineId }));
    await waitForPolicyEngineDeleted(policyEngineId);

    logger.info('Deleted workspace policy engine', { policyEngineId, engineName, instanceId });
}
