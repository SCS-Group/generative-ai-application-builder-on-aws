// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runtime env keys for direct GitHub REST tools (gaab-strands-common aiw_github_tool). */

export const AIW_GITHUB_OWNER_ENV = 'AIW_GITHUB_OWNER';
export const AIW_GITHUB_REPO_ENV = 'AIW_GITHUB_REPO';
export const AIW_GITHUB_API_KEY_PROVIDER_ENV = 'AIW_GITHUB_API_KEY_PROVIDER_NAME';

export function githubApiKeyProviderName(tenantId: string): string {
    const prefix = tenantId.trim().slice(0, 8);
    return `aiw-custom-${prefix}-github`;
}

export function buildGithubRuntimeEnvVars(params: {
    tenantId: string;
    githubOwner: string;
    githubRepo: string;
}): Record<string, string> {
    const owner = params.githubOwner.trim();
    const repo = params.githubRepo.trim();
    if (!owner || !repo) {
        return {};
    }
    return {
        [AIW_GITHUB_OWNER_ENV]: owner,
        [AIW_GITHUB_REPO_ENV]: repo,
        [AIW_GITHUB_API_KEY_PROVIDER_ENV]: githubApiKeyProviderName(params.tenantId)
    };
}

export function githubFieldsFromProvisionDetail(
    detail: Record<string, unknown>
): { githubOwner: string; githubRepo: string } {
    const owner = typeof detail.githubOwner === 'string' ? detail.githubOwner.trim() : '';
    const repo = typeof detail.githubRepo === 'string' ? detail.githubRepo.trim() : '';
    return { githubOwner: owner, githubRepo: repo };
}
