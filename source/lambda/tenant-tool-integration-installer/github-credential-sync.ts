// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeEvent } from 'aws-lambda';
import { syncGithubRuntimeEnvForCredentialUpdate } from './sync-github-runtime-env';

type GithubCredentialSyncTarget = {
    tenantTemplateInstanceId?: string;
    gaabUseCaseId?: string;
    customGithubOwner?: string;
    customGithubRepo?: string;
};

type GithubCredentialUpdatedDetail = {
    version?: string;
    correlationId?: string;
    tenantId?: string;
    credentialProviderArn?: string;
    triggeredByInstanceId?: string;
    targets?: GithubCredentialSyncTarget[];
};

function parseDetail(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    return {};
}

function asTargets(raw: unknown): GithubCredentialSyncTarget[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is GithubCredentialSyncTarget => Boolean(item && typeof item === 'object'));
}

export async function handleTenantGithubCredentialUpdated(
    event: EventBridgeEvent<string, unknown>
): Promise<void> {
    const d = parseDetail(event.detail) as GithubCredentialUpdatedDetail;
    if (String(d.version) !== '1') {
        console.warn('TenantGithubCredentialUpdated: expected detail.version "1"', JSON.stringify(d));
        return;
    }

    const tenantId = typeof d.tenantId === 'string' ? d.tenantId.trim() : '';
    const credentialProviderArn =
        typeof d.credentialProviderArn === 'string' ? d.credentialProviderArn.trim() : '';
    const correlationId = typeof d.correlationId === 'string' ? d.correlationId.trim() : '';
    const targets = asTargets(d.targets);

    if (!tenantId || !credentialProviderArn) {
        console.warn('TenantGithubCredentialUpdated: missing tenantId or credentialProviderArn', JSON.stringify(d));
        return;
    }
    if (!targets.length) {
        console.info('TenantGithubCredentialUpdated: no targets to sync', { tenantId, correlationId });
        return;
    }

    let synced = 0;
    const failures: string[] = [];

    for (const target of targets) {
        const gaabUseCaseId = target.gaabUseCaseId?.trim() ?? '';
        const owner = target.customGithubOwner?.trim() ?? '';
        const repo = target.customGithubRepo?.trim() ?? '';
        const instanceId = target.tenantTemplateInstanceId?.trim() ?? '';

        if (!gaabUseCaseId || !owner || !repo) {
            failures.push(
                `skip invalid target instance=${instanceId || 'unknown'} useCase=${gaabUseCaseId || 'missing'}`
            );
            continue;
        }

        try {
            await syncGithubRuntimeEnvForCredentialUpdate({
                tenantId,
                gaabUseCaseId,
                customGithubOwner: owner,
                customGithubRepo: repo
            });
            synced += 1;
            console.info('TenantGithubCredentialUpdated: synced runtime env', {
                tenantId,
                correlationId,
                tenantTemplateInstanceId: instanceId,
                gaabUseCaseId,
                owner,
                repo
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${gaabUseCaseId}: ${message}`);
            console.error('TenantGithubCredentialUpdated: sync failed', {
                tenantId,
                correlationId,
                tenantTemplateInstanceId: instanceId,
                gaabUseCaseId,
                error: message
            });
        }
    }

    console.info('TenantGithubCredentialUpdated: fan-out complete', {
        tenantId,
        correlationId,
        credentialProviderArn,
        synced,
        failed: failures.length,
        triggeredByInstanceId: d.triggeredByInstanceId
    });

    if (failures.length) {
        throw new Error(`GitHub credential fan-out incomplete (${synced}/${targets.length} synced): ${failures[0]}`);
    }
}
