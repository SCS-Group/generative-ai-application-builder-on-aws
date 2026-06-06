// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    CreatePolicyCommand,
    ListPoliciesCommand,
    UpdatePolicyCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { CompiledCedarPolicy } from './types';
import { getAgentCoreControlClient } from './client';
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

async function upsertOneCedarPolicy(
    policyEngineId: string,
    compiled: CompiledCedarPolicy,
    existingPolicyId?: string
): Promise<UpsertedCedarPolicy> {
    const control = getAgentCoreControlClient();
    const definition = {
        cedar: {
            statement: compiled.statement
        }
    };

    const existingId = existingPolicyId?.trim();
    if (existingId) {
        const out = await control.send(
            new UpdatePolicyCommand({
                policyEngineId,
                policyId: existingId,
                description: compiled.description,
                definition,
                validationMode: 'IGNORE_ALL_FINDINGS'
            })
        );
        await waitForPolicyActive(policyEngineId, existingId);
        logger.info('Updated Cedar policy', { policyEngineId, policyId: existingId, name: compiled.name });
        return {
            policyId: existingId,
            policyArn: out.policyArn,
            name: compiled.name
        };
    }

    const byName = await findPolicyByName(policyEngineId, compiled.name);
    if (byName?.policyId) {
        const out = await control.send(
            new UpdatePolicyCommand({
                policyEngineId,
                policyId: byName.policyId,
                description: compiled.description,
                definition,
                validationMode: 'IGNORE_ALL_FINDINGS'
            })
        );
        await waitForPolicyActive(policyEngineId, byName.policyId);
        logger.info('Updated Cedar policy by name', {
            policyEngineId,
            policyId: byName.policyId,
            name: compiled.name
        });
        return {
            policyId: byName.policyId,
            policyArn: out.policyArn ?? byName.policyArn,
            name: compiled.name
        };
    }

    const out = await control.send(
        new CreatePolicyCommand({
            policyEngineId,
            name: compiled.name,
            description: compiled.description,
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

    const primary = byName[opts.compiled[0].name];
    if (!primary) {
        throw new Error('Primary Cedar policy missing after upsert');
    }

    return { primary, byName };
}
