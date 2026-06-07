/**
 * Persist GitHub owner/repo on AgentRuntimeEnvVars and optionally sync the live AgentCore runtime.
 */
export declare function patchAgentRuntimeGithubEnv(params: {
    gaabUseCaseId: string;
    tenantId: string;
    githubOwner: string;
    githubRepo: string;
    syncRuntime?: boolean;
}): Promise<void>;
