// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Optional GitHub/Jira/Slack for engineering specialist slugs (mirrors AIW amplify/lib/connections.ts). */
export const ENGINEERING_SPECIALIST_OPTIONAL_CONNECTIONS = {
    schemaVersion: '1',
    providers: [
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
    ]
};

/** Figma OAuth (read-only MCP) — UX designer handoff. Mirrors AIW amplify/lib/connections.ts DEFAULT_MVP figma row. */
const FIGMA_OPTIONAL_CONNECTION = {
    providerKey: 'figma',
    displayName: 'Figma',
    attachMode: 'install',
    authMode: 'oauth',
    required: false,
    requiredScopes: [
        'current_user:read',
        'file_content:read',
        'file_metadata:read',
        'projects:read'
    ],
    oauthProviderName: 'platform-figma',
    mcpTargetName: 'figma',
    mcpTargetType: 'openApiSchema'
};

/** GitHub + Figma + optional Jira/Slack for ux-designer slug. */
export const UX_DESIGNER_OPTIONAL_CONNECTIONS = {
    schemaVersion: '1',
    providers: [...ENGINEERING_SPECIALIST_OPTIONAL_CONNECTIONS.providers, FIGMA_OPTIONAL_CONNECTION]
};

const ENGINEERING_SPECIALIST_SLUGS = new Set([
    'backend-api-developer',
    'ui-developer',
    'tech-lead',
    'product-manager',
    'ux-designer'
]);

export function isEngineeringSpecialistSlug(slug) {
    return ENGINEERING_SPECIALIST_SLUGS.has(
        String(slug ?? '')
            .trim()
            .toLowerCase()
    );
}

export function connectionsForEngineeringSpecialistSlug(slug) {
    const normalized = String(slug ?? '')
        .trim()
        .toLowerCase();
    if (normalized === 'ux-designer') {
        return UX_DESIGNER_OPTIONAL_CONNECTIONS;
    }
    if (isEngineeringSpecialistSlug(normalized)) {
        return ENGINEERING_SPECIALIST_OPTIONAL_CONNECTIONS;
    }
    return null;
}
