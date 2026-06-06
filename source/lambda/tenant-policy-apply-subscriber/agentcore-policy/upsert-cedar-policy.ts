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
import { waitForPolicyActive } from './wait-for-resource-active';
import { logger } from '../power-tools-init';

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

async function findPolicyByName(policyEngineId: string, name: string): Promise<UpsertedCedarPolicy | undefined> {
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
        const policies = (out.policies ?? []) as Array<{
            policyId?: string;
            policyArn?: string;
            name?: string;
        }>;
        const match = policies.find((p) => (p.name ?? '').trim() === name);
        if (match?.policyId) {
            return {
                policyId: match.policyId,
                policyArn: match.policyArn,
                name
            };
        }
        nextToken = out.nextToken;
    } while (nextToken);

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

    const out = await control.send(
        new CreatePolicyCommand({
            policyEngineId,
            name: compiled.name,
            description: createPolicyDescription(compiled.description),
            definition,
            validationMode: 'IGNORE_ALL_FINDINGS'
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
}

async function upsertOneCedarPolicy(
    policyEngineId: string,
    compiled: CompiledCedarPolicy,
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
        }
    }

    const byName = await findPolicyByName(policyEngineId, compiled.name);
    if (byName?.policyId) {
        try {
            return await updateExistingCedarPolicy(policyEngineId, byName.policyId, compiled);
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
        }
    }

    return createCedarPolicy(policyEngineId, compiled);
}

async function pruneOrphanWorkspaceCedarPolicies(
    policyEngineId: string,
    retainedNames: ReadonlySet<string>
): Promise<void> {
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
            const name = (policy.name ?? '').trim();
            const policyId = policy.policyId?.trim();
            if (!name.startsWith(WORKSPACE_CEDAR_POLICY_NAME_PREFIX) || retainedNames.has(name) || !policyId) {
                continue;
            }
            await control.send(new DeletePolicyCommand({ policyEngineId, policyId }));
            logger.info('Deleted orphan workspace Cedar policy after re-apply', {
                policyEngineId,
                policyId,
                name
            });
        }
        nextToken = out.nextToken;
    } while (nextToken);
}

/** @deprecated Use upsertCedarPolicies for multi-statement workspace policies. */
export async function upsertCedarPolicy(opts: {
    policyEngineId: string;
    compiled: CompiledCedarPolicy;
    existingPolicyId?: string;
}): Promise<UpsertedCedarPolicy> {
    return upsertOneCedarPolicy(opts.policyEngineId, opts.compiled, opts.existingPolicyId);
}

export async function upsertCedarPolicies(opts: {
    policyEngineId: string;
    compiled: CompiledCedarPolicy[];
    existingPolicyIds?: Record<string, string>;
}): Promise<UpsertedCedarPolicySet> {
    if (!opts.compiled.length) {
        throw new Error('At least one compiled Cedar policy is required');
    }

    const byName: Record<string, UpsertedCedarPolicy> = {};
    for (const cedar of opts.compiled) {
        const upserted = await upsertOneCedarPolicy(
            opts.policyEngineId,
            cedar,
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
