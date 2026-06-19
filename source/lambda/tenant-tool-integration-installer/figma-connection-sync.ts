// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeEvent } from 'aws-lambda';
import { clearFigmaRuntimeEnvForWorkspace, syncFigmaRuntimeEnvFromSettings } from './sync-figma-runtime-env';

type FigmaConnectionConfiguredDetail = {
    version?: string;
    gaabUseCaseId?: string;
    customFigmaTeamId?: string;
    customFigmaUxTemplateFileKey?: string;
    customFigmaProjectId?: string;
};

type FigmaWorkspaceUninstalledDetail = {
    version?: string;
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

export async function handleTenantFigmaConnectionConfigured(
    event: EventBridgeEvent<string, unknown>
): Promise<void> {
    const d = parseDetail(event.detail) as FigmaConnectionConfiguredDetail;
    if (String(d.version) !== '1') {
        console.warn('TenantFigmaConnectionConfigured: expected detail.version "1"', JSON.stringify(d));
        return;
    }
    const gaabUseCaseId = typeof d.gaabUseCaseId === 'string' ? d.gaabUseCaseId.trim() : '';
    if (!gaabUseCaseId) {
        console.warn('TenantFigmaConnectionConfigured: missing gaabUseCaseId', JSON.stringify(d));
        return;
    }
    await syncFigmaRuntimeEnvFromSettings({
        gaabUseCaseId,
        customFigmaTeamId: typeof d.customFigmaTeamId === 'string' ? d.customFigmaTeamId.trim() : undefined,
        customFigmaUxTemplateFileKey:
            typeof d.customFigmaUxTemplateFileKey === 'string' ? d.customFigmaUxTemplateFileKey.trim() : undefined,
        customFigmaProjectId:
            typeof d.customFigmaProjectId === 'string' ? d.customFigmaProjectId.trim() : undefined
    });
}

export async function handleTenantFigmaWorkspaceUninstalled(
    event: EventBridgeEvent<string, unknown>
): Promise<void> {
    const d = parseDetail(event.detail) as FigmaWorkspaceUninstalledDetail;
    if (String(d.version) !== '1') {
        console.warn('TenantFigmaWorkspaceUninstalled: expected detail.version "1"', JSON.stringify(d));
        return;
    }
    const gaabUseCaseId = typeof d.gaabUseCaseId === 'string' ? d.gaabUseCaseId.trim() : '';
    if (!gaabUseCaseId) {
        console.warn('TenantFigmaWorkspaceUninstalled: missing gaabUseCaseId', JSON.stringify(d));
        return;
    }
    await clearFigmaRuntimeEnvForWorkspace(gaabUseCaseId);
}
