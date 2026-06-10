// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeEvent } from 'aws-lambda';
import { clearGithubRuntimeEnvForWorkspace } from './sync-github-runtime-env';

type GithubWorkspaceUninstalledDetail = {
    version?: string;
    correlationId?: string;
    tenantId?: string;
    tenantTemplateInstanceId?: string;
    gaabUseCaseId?: string;
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

export async function handleTenantGithubWorkspaceUninstalled(
    event: EventBridgeEvent<string, unknown>
): Promise<void> {
    const d = parseDetail(event.detail) as GithubWorkspaceUninstalledDetail;
    if (String(d.version) !== '1') {
        console.warn('TenantGithubWorkspaceUninstalled: expected detail.version "1"', JSON.stringify(d));
        return;
    }

    const gaabUseCaseId = typeof d.gaabUseCaseId === 'string' ? d.gaabUseCaseId.trim() : '';
    const tenantTemplateInstanceId =
        typeof d.tenantTemplateInstanceId === 'string' ? d.tenantTemplateInstanceId.trim() : '';
    const tenantId = typeof d.tenantId === 'string' ? d.tenantId.trim() : '';
    const correlationId = typeof d.correlationId === 'string' ? d.correlationId.trim() : '';

    if (!gaabUseCaseId) {
        console.warn('TenantGithubWorkspaceUninstalled: missing gaabUseCaseId', JSON.stringify(d));
        return;
    }

    await clearGithubRuntimeEnvForWorkspace(gaabUseCaseId);
    console.info('TenantGithubWorkspaceUninstalled: cleared GitHub runtime env', {
        tenantId,
        tenantTemplateInstanceId,
        gaabUseCaseId,
        correlationId
    });
}
