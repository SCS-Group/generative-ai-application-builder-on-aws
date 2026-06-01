// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    PLATFORM_REST_API_ID_ENV_VAR,
    PLATFORM_REST_API_ROOT_RESOURCE_ID_ENV_VAR
} from './utils/constants';

const PLATFORM_FIELD_KEYS = ['ExistingRestApiId', 'ExistingApiRootResourceId', 'DeployUI'] as const;

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

export function applyPlatformDeployFields(
    body: Record<string, unknown>,
    fallback: PlatformDeployFallback = platformDeployFallbackFromEnv()
): void {
    if (body.DeployUI === undefined) {
        body.DeployUI = true;
    }
    if (!body.ExistingRestApiId && fallback.existingRestApiId) {
        body.ExistingRestApiId = fallback.existingRestApiId;
    }
    if (!body.ExistingApiRootResourceId && fallback.existingApiRootResourceId) {
        body.ExistingApiRootResourceId = fallback.existingApiRootResourceId;
    }
    if (body.ExistingRestApiId === undefined) {
        body.ExistingRestApiId = fallback.existingRestApiId ?? '';
    }
}
