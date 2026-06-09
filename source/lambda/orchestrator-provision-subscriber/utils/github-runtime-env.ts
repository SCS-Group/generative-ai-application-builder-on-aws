// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const AIW_GITHUB_API_KEY_SECRET_ID_ENV = 'AIW_GITHUB_API_KEY_SECRET_ID';

export function githubApiKeyProviderName(tenantId: string): string {
    const prefix = tenantId.trim().slice(0, 8);
    return `aiw-custom-${prefix}-github`;
}
