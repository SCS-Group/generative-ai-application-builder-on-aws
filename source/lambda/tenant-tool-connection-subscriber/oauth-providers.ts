// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { TOOL_CONNECTION_OAUTH_PROVIDERS_ENV_VAR } from './utils/constants';

export type OAuthProviderConfig = {
    credentialProviderArn: string;
};

export function loadOAuthProviderMap(): Record<string, OAuthProviderConfig> {
    const raw = process.env[TOOL_CONNECTION_OAUTH_PROVIDERS_ENV_VAR];
    if (!raw?.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const out: Record<string, OAuthProviderConfig> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const arn = (value as Record<string, unknown>).credentialProviderArn;
            if (typeof arn === 'string' && arn.trim()) {
                out[key] = { credentialProviderArn: arn.trim() };
            }
        }
        return out;
    } catch {
        return {};
    }
}
