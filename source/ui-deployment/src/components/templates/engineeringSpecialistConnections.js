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
