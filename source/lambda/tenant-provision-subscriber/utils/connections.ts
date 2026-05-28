// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Mirrors AIW `amplify/lib/connections.ts` for provision-time gateway targets. */

export type ConnectionProviderDefinition = {
    providerKey: string;
    displayName: string;
    attachMode: 'prewired';
    requiredScopes: string[];
    oauthProviderName: string;
    mcpTargetName: string;
    mcpTargetType: string;
};

export const DEFAULT_MVP_CONNECTION_PROVIDERS: ConnectionProviderDefinition[] = [
    {
        providerKey: 'google_drive',
        displayName: 'Google Drive',
        attachMode: 'prewired',
        requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
        oauthProviderName: 'platform-google-drive',
        mcpTargetName: 'google-drive',
        mcpTargetType: 'openApiSchema'
    },
    {
        providerKey: 'gmail',
        displayName: 'Gmail',
        attachMode: 'prewired',
        requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauthProviderName: 'platform-gmail',
        mcpTargetName: 'gmail',
        mcpTargetType: 'openApiSchema'
    },
    {
        providerKey: 'dropbox',
        displayName: 'Dropbox',
        attachMode: 'prewired',
        requiredScopes: ['files.metadata.read'],
        oauthProviderName: 'platform-dropbox',
        mcpTargetName: 'dropbox',
        mcpTargetType: 'openApiSchema'
    }
];

export function connectionsFromDevops(devops: unknown): ConnectionProviderDefinition[] {
    const root = parseDevopsRecord(devops);
    const gaab = root?.gaab as Record<string, unknown> | undefined;
    const connections = gaab?.connections as Record<string, unknown> | undefined;
    const raw = connections?.providers;
    if (Array.isArray(raw)) {
        const providers = raw.filter(isProviderRow);
        if (providers.length > 0) {
            return providers;
        }
    }
    return [...DEFAULT_MVP_CONNECTION_PROVIDERS];
}

function parseDevopsRecord(devops: unknown): Record<string, unknown> | null {
    if (devops && typeof devops === 'object' && !Array.isArray(devops)) {
        return devops as Record<string, unknown>;
    }
    if (typeof devops === 'string') {
        try {
            const o = JSON.parse(devops) as unknown;
            if (o && typeof o === 'object' && !Array.isArray(o)) {
                return o as Record<string, unknown>;
            }
        } catch {
            return null;
        }
    }
    return null;
}

function isProviderRow(v: unknown): v is ConnectionProviderDefinition {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const r = v as Record<string, unknown>;
    return (
        typeof r.providerKey === 'string' &&
        typeof r.displayName === 'string' &&
        r.attachMode === 'prewired' &&
        Array.isArray(r.requiredScopes) &&
        typeof r.oauthProviderName === 'string' &&
        typeof r.mcpTargetName === 'string' &&
        typeof r.mcpTargetType === 'string'
    );
}
