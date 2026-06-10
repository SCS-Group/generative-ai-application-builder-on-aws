// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const AIW_AGENT_WORKLOAD_NAME_ENV = 'AIW_AGENT_WORKLOAD_NAME';
export const AIW_GITHUB_OWNER_ENV = 'AIW_GITHUB_OWNER';
export const AIW_GITHUB_REPO_ENV = 'AIW_GITHUB_REPO';
export const AIW_GITHUB_API_KEY_PROVIDER_ENV = 'AIW_GITHUB_API_KEY_PROVIDER_NAME';
export const AIW_GITHUB_API_KEY_SECRET_ID_ENV = 'AIW_GITHUB_API_KEY_SECRET_ID';

export const GITHUB_WORKSPACE_RUNTIME_ENV_KEYS = [
    AIW_GITHUB_OWNER_ENV,
    AIW_GITHUB_REPO_ENV,
    AIW_GITHUB_API_KEY_PROVIDER_ENV,
    AIW_GITHUB_API_KEY_SECRET_ID_ENV,
    'GITHUB_MCP_MAX_FILE_READS',
    'GITHUB_MCP_MAX_ISSUE_FETCHES'
] as const;

export function githubApiKeyProviderName(tenantId: string): string {
    const prefix = tenantId.trim().slice(0, 8);
    return `aiw-custom-${prefix}-github`;
}

export function buildGithubRuntimeEnvVars(params: {
    tenantId: string;
    githubOwner: string;
    githubRepo: string;
    githubApiKeySecretArn?: string;
}): Record<string, string> {
    const owner = params.githubOwner.trim();
    const repo = params.githubRepo.trim();
    if (!owner || !repo) {
        return {};
    }
    const env: Record<string, string> = {
        [AIW_GITHUB_OWNER_ENV]: owner,
        [AIW_GITHUB_REPO_ENV]: repo,
        [AIW_GITHUB_API_KEY_PROVIDER_ENV]: githubApiKeyProviderName(params.tenantId)
    };
    const secretArn = params.githubApiKeySecretArn?.trim();
    if (secretArn) {
        env[AIW_GITHUB_API_KEY_SECRET_ID_ENV] = secretArn;
    }
    return env;
}
