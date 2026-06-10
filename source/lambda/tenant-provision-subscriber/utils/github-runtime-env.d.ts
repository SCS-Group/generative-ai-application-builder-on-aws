/** Runtime env keys for direct GitHub REST tools (gaab-strands-common aiw_github_tool). */
export declare const AIW_AGENT_WORKLOAD_NAME_ENV = "AIW_AGENT_WORKLOAD_NAME";
export declare const AIW_GITHUB_OWNER_ENV = "AIW_GITHUB_OWNER";
export declare const AIW_GITHUB_REPO_ENV = "AIW_GITHUB_REPO";
export declare const AIW_GITHUB_API_KEY_PROVIDER_ENV = "AIW_GITHUB_API_KEY_PROVIDER_NAME";
export declare const AIW_GITHUB_API_KEY_SECRET_ID_ENV = "AIW_GITHUB_API_KEY_SECRET_ID";
export declare function githubApiKeyProviderName(tenantId: string): string;
/** AgentCore workload identity name is the runtime id (not gaab_agent_{useCasePrefix}). */
export declare function buildAgentWorkloadRuntimeEnv(runtimeId: string): Record<string, string>;
export declare function buildGithubRuntimeEnvVars(params: {
    tenantId: string;
    githubOwner: string;
    githubRepo: string;
    githubApiKeySecretArn?: string;
}): Record<string, string>;
export declare function githubFieldsFromProvisionDetail(detail: Record<string, unknown>): {
    githubOwner: string;
    githubRepo: string;
};
