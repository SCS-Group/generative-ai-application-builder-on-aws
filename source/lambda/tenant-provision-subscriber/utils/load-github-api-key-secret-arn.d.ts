import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
export declare function loadGithubApiKeySecretArn(control: BedrockAgentCoreControlClient, tenantId: string, onError?: (providerName: string, error: unknown) => void): Promise<string | undefined>;
