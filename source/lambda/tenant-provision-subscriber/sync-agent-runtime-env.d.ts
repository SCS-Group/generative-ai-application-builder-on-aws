/**
 * After agent stack completes, merge AgentRuntimeEnvVars from use case config onto the live runtime
 * and align the container image with the platform CodeBuild tag from SSM when needed.
 */
export declare function syncAgentRuntimeEnvFromConfig(useCaseId: string): Promise<{
    agentRuntimeArn?: string;
}>;
