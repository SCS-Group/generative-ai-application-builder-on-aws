// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Mirrors AIW `amplify/lib/connections.ts` for provision-time gateway targets. */

export type ConnectionAttachMode = 'prewired' | 'install';

export type ConnectionAuthMode = 'oauth' | 'api_key';

export type ConnectionProviderDefinition = {
    providerKey: string;
    displayName: string;
    attachMode: ConnectionAttachMode;
    authMode?: ConnectionAuthMode;
    required?: boolean;
    requiredScopes: string[];
    oauthProviderName: string;
    mcpTargetName: string;
    mcpTargetType: string;
};

export const CATALOG_API_KEY_PROVIDERS: ConnectionProviderDefinition[] = [
    {
        providerKey: 'github',
        displayName: 'GitHub',
        attachMode: 'install',
        authMode: 'api_key',
        required: false,
        requiredScopes: [],
        oauthProviderName: '',
        mcpTargetName: 'github',
        mcpTargetType: 'openApiSchema'
    },
    {
        providerKey: 'jira',
        displayName: 'Jira',
        attachMode: 'install',
        authMode: 'api_key',
        required: false,
        requiredScopes: [],
        oauthProviderName: '',
        mcpTargetName: 'jira',
        mcpTargetType: 'openApiSchema'
    },
    {
        providerKey: 'slack',
        displayName: 'Slack',
        attachMode: 'install',
        authMode: 'api_key',
        required: false,
        requiredScopes: [],
        oauthProviderName: '',
        mcpTargetName: 'slack',
        mcpTargetType: 'openApiSchema'
    }
];

const CATALOG_BY_KEY = new Map(CATALOG_API_KEY_PROVIDERS.map((p) => [p.providerKey, p] as const));

export const DEFAULT_MVP_CONNECTION_PROVIDERS: ConnectionProviderDefinition[] = [
    {
        providerKey: 'figma',
        displayName: 'Figma',
        attachMode: 'install',
        authMode: 'oauth',
        requiredScopes: [
            'current_user:read',
            'file_content:read',
            'file_metadata:read',
            'project_metadata:read',
            'projects:read',
            'file_comments:read',
            'file_comments:write',
            'file_dev_resources:read',
            'file_dev_resources:write'
        ],
        oauthProviderName: 'platform-figma',
        mcpTargetName: 'figma',
        mcpTargetType: 'openApiSchema'
    },
    {
        providerKey: 'gmail',
        displayName: 'Gmail',
        attachMode: 'install',
        authMode: 'oauth',
        requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauthProviderName: 'platform-gmail',
        mcpTargetName: 'gmail',
        mcpTargetType: 'openApiSchema'
    }
];

export function connectionAuthMode(provider: ConnectionProviderDefinition): ConnectionAuthMode {
    return provider.authMode === 'api_key' ? 'api_key' : 'oauth';
}

export function isCatalogApiKeyProviderKey(providerKey: string): boolean {
    return CATALOG_BY_KEY.has(providerKey.trim());
}

function isProviderRow(v: unknown): v is ConnectionProviderDefinition {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const r = v as Record<string, unknown>;
    if (typeof r.providerKey !== 'string' || !r.providerKey.trim()) return false;
    if (typeof r.displayName !== 'string' || !r.displayName.trim()) return false;
    if (r.attachMode !== 'prewired' && r.attachMode !== 'install') return false;
    if (!Array.isArray(r.requiredScopes)) return false;
    if (typeof r.mcpTargetName !== 'string' || !r.mcpTargetName.trim()) return false;
    if (typeof r.mcpTargetType !== 'string' || !r.mcpTargetType.trim()) return false;
    const authMode = r.authMode === 'api_key' ? 'api_key' : 'oauth';
    if (authMode === 'oauth' && typeof r.oauthProviderName !== 'string') return false;
    return true;
}

function normalizeProviderRow(raw: ConnectionProviderDefinition): ConnectionProviderDefinition {
    const catalog = CATALOG_BY_KEY.get(raw.providerKey.trim());
    const authMode = raw.authMode === 'api_key' || catalog?.authMode === 'api_key' ? 'api_key' : 'oauth';
    return {
        providerKey: raw.providerKey.trim(),
        displayName: raw.displayName.trim() || catalog?.displayName || raw.providerKey.trim(),
        attachMode: raw.attachMode,
        authMode,
        required: catalog && authMode === 'api_key' ? false : raw.required === true,
        requiredScopes: authMode === 'api_key' ? [] : raw.requiredScopes.filter((s) => typeof s === 'string'),
        oauthProviderName:
            authMode === 'api_key'
                ? typeof raw.oauthProviderName === 'string'
                    ? raw.oauthProviderName
                    : ''
                : String(raw.oauthProviderName ?? '').trim(),
        mcpTargetName: raw.mcpTargetName.trim() || catalog?.mcpTargetName || raw.providerKey.trim(),
        mcpTargetType: raw.mcpTargetType.trim() || 'openApiSchema'
    };
}

export function connectionsFromDevops(devops: unknown): ConnectionProviderDefinition[] {
    const root = parseDevopsRecord(devops);
    const gaab = root?.gaab as Record<string, unknown> | undefined;
    const connections = gaab?.connections as Record<string, unknown> | undefined;
    const raw = connections?.providers;
    if (Array.isArray(raw)) {
        const providers = raw.filter(isProviderRow).map(normalizeProviderRow);
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
