// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    PLATFORM_REST_API_ID_ENV_VAR,
    PLATFORM_REST_API_ROOT_RESOURCE_ID_ENV_VAR
} from './utils/constants';

/** CFN / MCP deploy fields shared with AgentBuilder; copied from template body or platform env. */
const PLATFORM_FIELD_KEYS = [
    'ExistingRestApiId',
    'ExistingApiRootResourceId',
    'DeployUI'
] as const;

export type PlatformDeployFallback = {
    existingRestApiId?: string;
    existingApiRootResourceId?: string;
};

export function platformDeployFallbackFromEnv(): PlatformDeployFallback {
    return {
        existingRestApiId: process.env[PLATFORM_REST_API_ID_ENV_VAR]?.trim() || undefined,
        existingApiRootResourceId:
            process.env[PLATFORM_REST_API_ROOT_RESOURCE_ID_ENV_VAR]?.trim() || undefined
    };
}

/**
 * MCP gateway stacks require ExistingRestApiId on the deploy body (MCP adapter always passes it to CFN).
 * Agent templates may omit it; fall back to the deployment platform REST API id from env.
 */
export function applyPlatformDeployFields(
    gatewayBody: Record<string, unknown>,
    agentDeployBody: Record<string, unknown>,
    fallback: PlatformDeployFallback = platformDeployFallbackFromEnv()
): void {
    for (const key of PLATFORM_FIELD_KEYS) {
        const v = agentDeployBody[key];
        if (typeof v === 'string' && v.trim()) {
            gatewayBody[key] = v.trim();
        } else if (typeof v === 'boolean' && key === 'DeployUI') {
            gatewayBody[key] = v;
        }
    }

    if (!gatewayBody.ExistingRestApiId && fallback.existingRestApiId) {
        gatewayBody.ExistingRestApiId = fallback.existingRestApiId;
    }
    if (!gatewayBody.ExistingApiRootResourceId && fallback.existingApiRootResourceId) {
        gatewayBody.ExistingApiRootResourceId = fallback.existingApiRootResourceId;
    }

    if (gatewayBody.ExistingRestApiId === undefined) {
        gatewayBody.ExistingRestApiId = fallback.existingRestApiId ?? '';
    }
}
