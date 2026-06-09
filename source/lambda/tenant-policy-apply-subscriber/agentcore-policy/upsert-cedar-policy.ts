// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    CreatePolicyCommand,
    DeletePolicyCommand,
    ListPoliciesCommand,
    UpdatePolicyCommand,
    type UpdatePolicyCommandInput
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { CompiledCedarPolicy } from './types';
import { getAgentCoreControlClient } from './client';
import { createPolicyDescription, updatePolicyDescriptionWire } from './policy-description';
import { waitForPolicyAbsent, waitForPolicyActive } from './wait-for-resource-active';
import { logger } from '../power-tools-init';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isPolicyNameConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const name = (error as { name?: string }).name;
    const message = (error as { message?: string }).message ?? '';
    return name === 'ConflictException' || /same name already exists/i.test(message);
}

export type UpsertedCedarPolicy = {
    policyId: string;
    policyArn?: string;
    name: string;
};

export type UpsertedCedarPolicySet = {
    primary: UpsertedCedarPolicy;
    byName: Record<string, UpsertedCedarPolicy>;
};

/** AIW-managed Cedar policies on workspace policy engines use this prefix. */
export const WORKSPACE_CEDAR_POLICY_NAME_PREFIX = 'aiw_workspace_';

/** AgentCore CreatePolicy / CreatePolicyEngine clientToken constraint. */
export const AGENTCORE_CLIENT_TOKEN_PATTERN = /^[a-zA-Z0-9](-*[a-zA-Z0-9]){0,256}$/;

/** Normalize arbitrary text into an AgentCore-safe clientToken (hyphens only, alnum ends). */
export function sanitizeAgentCoreClientToken(value: string): string {
    let token = value
        .replace(/[^A-Za-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '');

    if (!token || !/^[a-zA-Z0-9]/.test(token)) {
        token = `0-${token}`.replace(/^-+/, '');
    }

    token = token.replace(/-+$/, '');
    if (!token) {
        return '0';
    }

    token = token.slice(0, 256).replace(/-+$/, '');
    return token || '0';
}

/** Stable CreatePolicy client token — idempotent retries and concurrent applies. */
export function policyClientToken(policyEngineId: string, policyName: string): string {
    return sanitizeAgentCoreClientToken(`aiwpol-${policyEngineId}-${policyName}`);
}

export async function listPoliciesByName(
    policyEngineId: string
): Promise<Map<string, UpsertedCedarPolicy>> {
    const control = getAgentCoreControlClient();
    const byName = new Map<string, UpsertedCedarPolicy>();
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
            const name = (policy.name ?? '').trim();
            const policyId = policy.policyId?.trim();
            if (!name || !policyId) continue;
            byName.set(name, {
                policyId,
                policyArn: policy.policyArn,
                name
            });
        }
        nextToken = out.nextToken;
    } while (nextToken);

    return byName;
}

async function waitForPolicyNameAbsent(
    policyEngineId: string,
    name: string,
    timeoutMs = 120_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const byName = await listPoliciesByName(policyEngineId);
        if (!byName.has(name)) {
            return;
        }
        logger.info('Waiting for Cedar policy name to become available', { policyEngineId, name });
        await sleep(2000);
    }
    throw new Error(`Timed out waiting for Cedar policy name ${name} to delete on ${policyEngineId}`);
}

async function findPolicyByNameWithRetry(
    policyEngineId: string,
    name: string,
    attempts = 60,
    initialDelayMs = 500
): Promise<UpsertedCedarPolicy | undefined> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const byName = await listPoliciesByName(policyEngineId);
        const match = byName.get(name);
        if (match) {
            return match;
        }
        if (attempt < attempts) {
            await sleep(initialDelayMs * attempt);
        }
    }
    return undefined;
}

async function updateExistingCedarPolicy(
    policyEngineId: string,
    policyId: string,
    compiled: CompiledCedarPolicy
): Promise<UpsertedCedarPolicy> {
    const control = getAgentCoreControlClient();
    const definition = {
        cedar: {
            statement: compiled.statement
        }
    };

    const wireDescription = updatePolicyDescriptionWire(compiled.description);
    const updateInput = {
        policyEngineId,
        policyId,
        definition,
        validationMode: 'IGNORE_ALL_FINDINGS' as const,
        ...(wireDescription ? { description: wireDescription } : {})
    } as UpdatePolicyCommandInput;

    const out = await control.send(new UpdatePolicyCommand(updateInput));
    await waitForPolicyActive(policyEngineId, policyId);
    logger.info('Updated Cedar policy', { policyEngineId, policyId, name: compiled.name });
    return {
        policyId,
        policyArn: out.policyArn,
        name: compiled.name
    };
}

async function createCedarPolicy(policyEngineId: string, compiled: CompiledCedarPolicy): Promise<UpsertedCedarPolicy> {
    const control = getAgentCoreControlClient();
    const definition = {
        cedar: {
            statement: compiled.statement
        }
    };
    const clientToken = policyClientToken(policyEngineId, compiled.name);

    try {
        const out = await control.send(
            new CreatePolicyCommand({
                policyEngineId,
                name: compiled.name,
                description: createPolicyDescription(compiled.description),
                definition,
                validationMode: 'IGNORE_ALL_FINDINGS',
                clientToken
            })
        );

        if (!out.policyId) {
            throw new Error(`CreatePolicy did not return policyId for ${compiled.name}`);
        }

        await waitForPolicyActive(policyEngineId, out.policyId);
        logger.info('Created Cedar policy', {
            policyEngineId,
            policyId: out.policyId,
            name: compiled.name
        });

        return {
            policyId: out.policyId,
            policyArn: out.policyArn,
            name: compiled.name
        };
    } catch (error) {
        if (!isPolicyNameConflict(error)) {
            throw error;
        }
        logger.warn('CreatePolicy conflict; resolving existing Cedar policy by name', {
            policyEngineId,
            name: compiled.name,
            clientToken
        });
        const existing = await findPolicyByNameWithRetry(policyEngineId, compiled.name);
        if (existing?.policyId) {
            return updateExistingCedarPolicy(policyEngineId, existing.policyId, compiled);
        }

        logger.warn('CreatePolicy conflict persisted after list retries; retrying idempotent create', {
            policyEngineId,
            name: compiled.name,
            clientToken
        });
        await sleep(2000);
        const retryOut = await control.send(
            new CreatePolicyCommand({
                policyEngineId,
                name: compiled.name,
                description: createPolicyDescription(compiled.description),
                definition,
                validationMode: 'IGNORE_ALL_FINDINGS',
                clientToken
            })
        );
        if (retryOut.policyId) {
            await waitForPolicyActive(policyEngineId, retryOut.policyId);
            return {
                policyId: retryOut.policyId,
                policyArn: retryOut.policyArn,
                name: compiled.name
            };
        }
        throw error;
    }
}

async function upsertOneCedarPolicy(
    policyEngineId: string,
    compiled: CompiledCedarPolicy,
    knownPolicies: Map<string, UpsertedCedarPolicy>,
    existingPolicyId?: string
): Promise<UpsertedCedarPolicy> {
    const existingId = existingPolicyId?.trim();
    if (existingId) {
        try {
            return await updateExistingCedarPolicy(policyEngineId, existingId, compiled);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn('Cedar policy update failed; recreating policy', {
                policyEngineId,
                policyId: existingId,
                name: compiled.name,
                message
            });
            const control = getAgentCoreControlClient();
            await control.send(new DeletePolicyCommand({ policyEngineId, policyId: existingId }));
            await waitForPolicyAbsent(policyEngineId, existingId);
            await waitForPolicyNameAbsent(policyEngineId, compiled.name);
            knownPolicies.delete(compiled.name);
        }
    }

    const byName = knownPolicies.get(compiled.name) ?? (await findPolicyByNameWithRetry(policyEngineId, compiled.name, 12));
    if (byName?.policyId) {
        try {
            const updated = await updateExistingCedarPolicy(policyEngineId, byName.policyId, compiled);
            knownPolicies.set(compiled.name, updated);
            return updated;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn('Cedar policy update by name failed; recreating policy', {
                policyEngineId,
                policyId: byName.policyId,
                name: compiled.name,
                message
            });
            const control = getAgentCoreControlClient();
            await control.send(
                new DeletePolicyCommand({ policyEngineId, policyId: byName.policyId })
            );
            await waitForPolicyAbsent(policyEngineId, byName.policyId);
            await waitForPolicyNameAbsent(policyEngineId, compiled.name);
            knownPolicies.delete(compiled.name);
        }
    }

    const created = await createCedarPolicy(policyEngineId, compiled);
    knownPolicies.set(compiled.name, created);
    return created;
}

async function pruneOrphanWorkspaceCedarPolicies(
    policyEngineId: string,
    retainedNames: ReadonlySet<string>
): Promise<void> {
    const byName = await listPoliciesByName(policyEngineId);
    const control = getAgentCoreControlClient();

    for (const [name, policy] of byName.entries()) {
        if (!name.startsWith(WORKSPACE_CEDAR_POLICY_NAME_PREFIX) || retainedNames.has(name)) {
            continue;
        }
        await control.send(new DeletePolicyCommand({ policyEngineId, policyId: policy.policyId }));
        logger.info('Deleted orphan workspace Cedar policy after re-apply', {
            policyEngineId,
            policyId: policy.policyId,
            name
        });
    }
}

/** @deprecated Use upsertCedarPolicies for multi-statement workspace policies. */
export async function upsertCedarPolicy(opts: {
    policyEngineId: string;
    compiled: CompiledCedarPolicy;
    existingPolicyId?: string;
}): Promise<UpsertedCedarPolicy> {
    const knownPolicies = await listPoliciesByName(opts.policyEngineId);
    return upsertOneCedarPolicy(
        opts.policyEngineId,
        opts.compiled,
        knownPolicies,
        opts.existingPolicyId
    );
}

export async function upsertCedarPolicies(opts: {
    policyEngineId: string;
    compiled: CompiledCedarPolicy[];
    existingPolicyIds?: Record<string, string>;
}): Promise<UpsertedCedarPolicySet> {
    if (!opts.compiled.length) {
        throw new Error('At least one compiled Cedar policy is required');
    }

    const knownPolicies = await listPoliciesByName(opts.policyEngineId);
    const byName: Record<string, UpsertedCedarPolicy> = {};

    for (const cedar of opts.compiled) {
        const upserted = await upsertOneCedarPolicy(
            opts.policyEngineId,
            cedar,
            knownPolicies,
            opts.existingPolicyIds?.[cedar.name]
        );
        byName[cedar.name] = upserted;
    }

    await pruneOrphanWorkspaceCedarPolicies(
        opts.policyEngineId,
        new Set(opts.compiled.map((cedar) => cedar.name))
    );

    const primary = byName[opts.compiled[0].name];
    if (!primary) {
        throw new Error('Primary Cedar policy missing after upsert');
    }

    return { primary, byName };
}
