// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    CreatePolicyEngineCommand,
    ListPolicyEnginesCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getAgentCoreControlClient } from './client';
import { waitForPolicyEngineActive } from './wait-for-resource-active';
import { logger } from '../power-tools-init';

export type PolicyEngineRef = {
    policyEngineId: string;
    policyEngineArn: string;
    name: string;
};

function policyEngineName(tenantTemplateInstanceId: string): string {
    return `aiw-pe-${tenantTemplateInstanceId.slice(0, 8)}`;
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

export async function ensurePolicyEngine(opts: {
    tenantTemplateInstanceId: string;
    gaabUseCaseId: string;
    existing?: { policyEngineId: string; policyEngineArn: string };
}): Promise<PolicyEngineRef> {
    if (opts.existing?.policyEngineId && opts.existing.policyEngineArn) {
        return {
            policyEngineId: opts.existing.policyEngineId,
            policyEngineArn: opts.existing.policyEngineArn,
            name: policyEngineName(opts.tenantTemplateInstanceId)
        };
    }

    const name = policyEngineName(opts.tenantTemplateInstanceId);
    const found = await findPolicyEngineByName(name);
    if (found) {
        logger.info('Reusing existing policy engine', { name, policyEngineId: found.policyEngineId });
        return found;
    }

    const control = getAgentCoreControlClient();
    const out = await control.send(
        new CreatePolicyEngineCommand({
            name,
            description: `AIW workspace policy engine for instance ${opts.tenantTemplateInstanceId} (use case ${opts.gaabUseCaseId})`,
            clientToken: `aiw-pe-${opts.tenantTemplateInstanceId}`
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
}
