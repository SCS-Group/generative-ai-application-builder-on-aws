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

export async function upsertCedarPolicy(opts: {
    policyEngineId: string;
    compiled: CompiledCedarPolicy;
    existingPolicyId?: string;
}): Promise<UpsertedCedarPolicy> {
    const control = getAgentCoreControlClient();
    const definition = {
        cedar: {
            statement: opts.compiled.statement
        }
    };

    const existingId = opts.existingPolicyId?.trim();
    if (existingId) {
        const out = await control.send(
            new UpdatePolicyCommand({
                policyEngineId: opts.policyEngineId,
                policyId: existingId,
                description: opts.compiled.description,
                definition,
                validationMode: 'IGNORE_ALL_FINDINGS'
            })
        );
        await waitForPolicyActive(opts.policyEngineId, existingId);
        logger.info('Updated Cedar policy', { policyEngineId: opts.policyEngineId, policyId: existingId });
        return {
            policyId: existingId,
            policyArn: out.policyArn,
            name: opts.compiled.name
        };
    }

    const byName = await findPolicyByName(opts.policyEngineId, opts.compiled.name);
    if (byName?.policyId) {
        const out = await control.send(
            new UpdatePolicyCommand({
                policyEngineId: opts.policyEngineId,
                policyId: byName.policyId,
                description: opts.compiled.description,
                definition,
                validationMode: 'IGNORE_ALL_FINDINGS'
            })
        );
        await waitForPolicyActive(opts.policyEngineId, byName.policyId);
        logger.info('Updated Cedar policy by name', {
            policyEngineId: opts.policyEngineId,
            policyId: byName.policyId
        });
        return {
            policyId: byName.policyId,
            policyArn: out.policyArn ?? byName.policyArn,
            name: opts.compiled.name
        };
    }

    const out = await control.send(
        new CreatePolicyCommand({
            policyEngineId: opts.policyEngineId,
            name: opts.compiled.name,
            description: opts.compiled.description,
            definition,
            validationMode: 'IGNORE_ALL_FINDINGS'
        })
    );

    if (!out.policyId) {
        throw new Error(`CreatePolicy did not return policyId for ${opts.compiled.name}`);
    }

    await waitForPolicyActive(opts.policyEngineId, out.policyId);
    logger.info('Created Cedar policy', {
        policyEngineId: opts.policyEngineId,
        policyId: out.policyId,
        name: opts.compiled.name
    });

    return {
        policyId: out.policyId,
        policyArn: out.policyArn,
        name: opts.compiled.name
    };
}
