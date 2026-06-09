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
    UpdateGatewayCommand,
    type UpdateGatewayCommandInput
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getAgentCoreControlClient } from './agentcore-policy/client';
import { policyEngineNameForInstance } from './agentcore-policy/policy-engine-naming';
import { logger } from './power-tools-init';

export { policyEngineNameForInstance } from './agentcore-policy/policy-engine-naming';

export class PolicyEngineDeleteBlockedError extends Error {
    readonly policyEngineId: string;

    constructor(message: string, policyEngineId: string) {
        super(message);
        this.name = 'PolicyEngineDeleteBlockedError';
        this.policyEngineId = policyEngineId;
    }
}

function gatewayNameFromMcpUseCaseId(gaabMcpGatewayUseCaseId: string): string {
    return `gaab-mcp-${gaabMcpGatewayUseCaseId.slice(0, 8)}`;
}

function isPolicyEngineAssociationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const name = (error as { name?: string }).name;
    const message = (error as { message?: string }).message ?? '';
    return name === 'ConflictException' && /still associated with/i.test(message);
}

function gatewayUpdateBase(gateway: Awaited<ReturnType<typeof fetchGateway>>): UpdateGatewayCommandInput {
    if (!gateway.name || !gateway.roleArn || !gateway.authorizerType || !gateway.protocolType) {
        throw new Error(`Gateway ${gateway.gatewayId} is missing fields required to update policy association`);
    }

    return {
        gatewayIdentifier: gateway.gatewayId,
        name: gateway.name,
        roleArn: gateway.roleArn,
        authorizerType: gateway.authorizerType,
        protocolType: gateway.protocolType,
        ...(gateway.description ? { description: gateway.description } : {}),
        ...(gateway.authorizerConfiguration ? { authorizerConfiguration: gateway.authorizerConfiguration } : {}),
        ...(gateway.protocolConfiguration ? { protocolConfiguration: gateway.protocolConfiguration } : {}),
        ...(gateway.kmsKeyArn ? { kmsKeyArn: gateway.kmsKeyArn } : {}),
        ...(gateway.interceptorConfigurations
            ? { interceptorConfigurations: gateway.interceptorConfigurations }
            : {})
    };
}

async function fetchGateway(gatewayId: string) {
    const control = getAgentCoreControlClient();
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    return { ...gateway, gatewayId };
}

async function waitForGatewayReady(
    gatewayId: string,
    opts?: { expectPolicyEngine?: boolean; timeoutMs?: number }
): Promise<void> {
    const control = getAgentCoreControlClient();
    const deadline = Date.now() + (opts?.timeoutMs ?? 120_000);

    while (Date.now() < deadline) {
        const gateway = await fetchGateway(gatewayId);
        const status = String(gateway.status ?? '');
        const hasPolicyEngine = Boolean(gateway.policyEngineConfiguration?.arn?.trim());
        if (status === 'READY') {
            if (opts?.expectPolicyEngine === undefined || hasPolicyEngine === opts.expectPolicyEngine) {
                return;
            }
        }
        logger.info('Waiting for MCP gateway to become ready', {
            gatewayId,
            status,
            hasPolicyEngine,
            expectPolicyEngine: opts?.expectPolicyEngine
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Timed out waiting for gateway ${gatewayId} to reach READY`);
}

async function resolveGatewayIdFromMcpUseCaseId(gaabMcpGatewayUseCaseId: string): Promise<string | undefined> {
    const useCaseId = gaabMcpGatewayUseCaseId.trim();
    if (!useCaseId) {
        return undefined;
    }

    const expectedName = gatewayNameFromMcpUseCaseId(useCaseId);
    const control = getAgentCoreControlClient();
    let nextToken: string | undefined;

    do {
        const out = await control.send(
            new ListGatewaysCommand({
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        const match = (out.items ?? []).find((item) => (item.name ?? '').trim() === expectedName);
        const gatewayId = match?.gatewayId?.trim();
        if (gatewayId) {
            return gatewayId;
        }
        nextToken = out.nextToken;
    } while (nextToken);

    logger.warn('Could not resolve MCP gateway id from use case id', { gaabMcpGatewayUseCaseId: useCaseId, expectedName });
    return undefined;
}

async function associateGatewayPolicyEngine(gatewayId: string, policyEngineArn: string): Promise<void> {
    const gateway = await fetchGateway(gatewayId);
    await getAgentCoreControlClient().send(
        new UpdateGatewayCommand({
            ...gatewayUpdateBase(gateway),
            policyEngineConfiguration: {
                arn: policyEngineArn,
                mode: 'LOG_ONLY'
            }
        })
    );
    await waitForGatewayReady(gatewayId, { expectPolicyEngine: true });
    logger.info('Re-associated policy engine with MCP gateway for teardown heal', { gatewayId, policyEngineArn });
}

async function disassociateGatewayPolicyEngine(gatewayId: string): Promise<void> {
    const gateway = await fetchGateway(gatewayId);
    if (!gateway.policyEngineConfiguration?.arn?.trim()) {
        return;
    }

    await getAgentCoreControlClient().send(new UpdateGatewayCommand(gatewayUpdateBase(gateway)));
    await waitForGatewayReady(gatewayId, { expectPolicyEngine: false });
    logger.info('Disassociated policy engine from MCP gateway', { gatewayId });
}

async function healGatewayPolicyAssociation(gatewayId: string, policyEngineArn: string): Promise<void> {
    const gateway = await fetchGateway(gatewayId);
    const visibleArn = gateway.policyEngineConfiguration?.arn?.trim() ?? '';
    if (!visibleArn.includes(policyEngineArn.split('/').pop() ?? policyEngineArn)) {
        await associateGatewayPolicyEngine(gatewayId, policyEngineArn);
    }
    await disassociateGatewayPolicyEngine(gatewayId);
}

async function disassociatePolicyEngineFromAllGateways(policyEngineId: string): Promise<void> {
    const control = getAgentCoreControlClient();
    let nextToken: string | undefined;
    let disassociated = 0;

    do {
        const out = await control.send(
            new ListGatewaysCommand({
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        for (const item of out.items ?? []) {
            const gatewayId = item.gatewayId?.trim();
            if (!gatewayId) continue;
            const gateway = await fetchGateway(gatewayId);
            const arn = gateway.policyEngineConfiguration?.arn?.trim() ?? '';
            if (!arn.includes(policyEngineId)) {
                continue;
            }
            await disassociateGatewayPolicyEngine(gatewayId);
            disassociated += 1;
        }
        nextToken = out.nextToken;
    } while (nextToken);

    if (disassociated) {
        logger.info('Disassociated workspace policy engine from gateways', { policyEngineId, disassociated });
    }
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

async function deletePolicyEngineWithRetry(opts: {
    policyEngineId: string;
    policyEngineArn: string;
    gatewayId?: string;
}): Promise<void> {
    const control = getAgentCoreControlClient();
    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await control.send(new DeletePolicyEngineCommand({ policyEngineId: opts.policyEngineId }));
            await waitForPolicyEngineDeleted(opts.policyEngineId);
            return;
        } catch (e) {
            if (!isPolicyEngineAssociationConflict(e) || attempt === maxAttempts) {
                throw e;
            }

            const message = e instanceof Error ? e.message : String(e);
            logger.warn('Policy engine delete blocked by gateway association; healing before retry', {
                policyEngineId: opts.policyEngineId,
                gatewayId: opts.gatewayId,
                attempt,
                message
            });

            if (opts.gatewayId) {
                await healGatewayPolicyAssociation(opts.gatewayId, opts.policyEngineArn);
            } else {
                await disassociatePolicyEngineFromAllGateways(opts.policyEngineId);
            }

            await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
        }
    }
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
    if (!instanceId) {
        return;
    }

    const engineName = policyEngineNameForInstance(instanceId);
    const policyEngineId = await findPolicyEngineByName(engineName);
    if (!policyEngineId) {
        logger.info('No workspace policy engine to delete', { engineName, instanceId });
        return;
    }

    const control = getAgentCoreControlClient();
    const policyEngine = await control.send(new GetPolicyEngineCommand({ policyEngineId }));
    const policyEngineArn = policyEngine.policyEngineArn?.trim();
    if (!policyEngineArn) {
        throw new Error(`Policy engine ${policyEngineId} is missing policyEngineArn`);
    }

    const gatewayId = opts.gaabMcpGatewayUseCaseId
        ? await resolveGatewayIdFromMcpUseCaseId(opts.gaabMcpGatewayUseCaseId)
        : undefined;

    try {
        await disassociatePolicyEngineFromAllGateways(policyEngineId);
        if (gatewayId) {
            await healGatewayPolicyAssociation(gatewayId, policyEngineArn);
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn('Failed to disassociate policy engine from gateways', {
            policyEngineId,
            gatewayId,
            message
        });
    }

    await deletePoliciesOnEngine(policyEngineId);

    try {
        await deletePolicyEngineWithRetry({
            policyEngineId,
            policyEngineArn,
            gatewayId
        });
    } catch (e) {
        if (!isPolicyEngineAssociationConflict(e)) {
            throw e;
        }
        const message = e instanceof Error ? e.message : String(e);
        throw new PolicyEngineDeleteBlockedError(message, policyEngineId);
    }

    logger.info('Deleted workspace policy engine', { policyEngineId, engineName, instanceId });
}
