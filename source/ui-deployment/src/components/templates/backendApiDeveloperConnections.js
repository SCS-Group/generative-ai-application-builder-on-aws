// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Optional tool connections for slug `backend-api-developer` (mirrors AIW amplify/lib/connections.ts). */
export const BACKEND_API_DEVELOPER_OPTIONAL_CONNECTIONS = {
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

export function isBackendApiDeveloperSlug(slug) {
    return String(slug ?? '')
        .trim()
        .toLowerCase() === 'backend-api-developer';
}
