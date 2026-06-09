// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    CreatePolicyEngineCommand,
    GetPolicyEngineCommand,
    ListPolicyEnginesCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getAgentCoreControlClient } from './client';
import { policyEngineNameForInstance } from './policy-engine-naming';
import { sanitizeAgentCoreClientToken } from './upsert-cedar-policy';
import { waitForPolicyEngineActive } from './wait-for-resource-active';
import { logger } from '../power-tools-init';

export type PolicyEngineRef = {
    policyEngineId: string;
    policyEngineArn: string;
    name: string;
};

function isPolicyEngineNameConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const name = (error as { name?: string }).name;
    const message = (error as { message?: string }).message ?? '';
    return name === 'ConflictException' || /same name already exists/i.test(message);
}

async function findPolicyEngineByName(name: string): Promise<PolicyEngineRef | undefined> {
    const control = getAgentCoreControlClient();
    let nextToken: string | undefined;

    do {
        const out = await control.send(
            new ListPolicyEnginesCommand({
                maxResults: 50,
                ...(nextToken ? { nextToken } : {})
            })
        );
        const engines = (out.policyEngines ?? []) as Array<{
            policyEngineId?: string;
            policyEngineArn?: string;
            name?: string;
            status?: string;
        }>;
        const match = engines.find((e) => (e.name ?? '').trim() === name);
        if (match?.policyEngineId && match.policyEngineArn) {
            return {
                policyEngineId: match.policyEngineId,
                policyEngineArn: match.policyEngineArn,
                name
            };
        }
        nextToken = out.nextToken;
    } while (nextToken);

    return undefined;
}

async function resolveExistingPolicyEngine(
    policyEngineId: string,
    name: string
): Promise<PolicyEngineRef | undefined> {
    const control = getAgentCoreControlClient();
    try {
        const out = await control.send(new GetPolicyEngineCommand({ policyEngineId }));
        if (out.policyEngineArn) {
            return {
                policyEngineId,
                policyEngineArn: out.policyEngineArn,
                name
            };
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.includes('ResourceNotFoundException') && !message.includes('not found')) {
            throw e;
        }
        logger.warn('Configured policy engine id is stale; resolving by name', {
            policyEngineId,
            name
        });
    }
    return undefined;
}

export async function ensurePolicyEngine(opts: {
    tenantTemplateInstanceId: string;
    gaabUseCaseId: string;
    existing?: { policyEngineId: string; policyEngineArn: string };
}): Promise<PolicyEngineRef> {
    const name = policyEngineNameForInstance(opts.tenantTemplateInstanceId);

    if (opts.existing?.policyEngineId && opts.existing.policyEngineArn) {
        const resolved = await resolveExistingPolicyEngine(opts.existing.policyEngineId, name);
        if (resolved) {
            return resolved;
        }
    }

    const found = await findPolicyEngineByName(name);
    if (found) {
        logger.info('Reusing existing policy engine', { name, policyEngineId: found.policyEngineId });
        return found;
    }

    const control = getAgentCoreControlClient();
    const clientToken = sanitizeAgentCoreClientToken(
        `aiwpe-${opts.tenantTemplateInstanceId.replace(/[^A-Za-z0-9-]/g, '')}`
    );

    try {
        const out = await control.send(
            new CreatePolicyEngineCommand({
                name,
                description: `AIW workspace policy engine for instance ${opts.tenantTemplateInstanceId} (use case ${opts.gaabUseCaseId})`,
                clientToken
            })
        );

        if (!out.policyEngineId || !out.policyEngineArn) {
            throw new Error(`CreatePolicyEngine returned incomplete response for ${name}`);
        }

        await waitForPolicyEngineActive(out.policyEngineId);

        logger.info('Created policy engine', {
            name,
            policyEngineId: out.policyEngineId,
            policyEngineArn: out.policyEngineArn
        });

        return {
            policyEngineId: out.policyEngineId,
            policyEngineArn: out.policyEngineArn,
            name
        };
    } catch (error) {
        if (!isPolicyEngineNameConflict(error)) {
            throw error;
        }
        logger.warn('CreatePolicyEngine conflict; resolving existing engine by name', { name });
        const existing = await findPolicyEngineByName(name);
        if (existing) {
            return existing;
        }
        throw error;
    }
}
