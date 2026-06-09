// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    BedrockAgentCoreControlClient,
    GetApiKeyCredentialProviderCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { githubApiKeyProviderName } from './github-runtime-env';

export async function loadGithubApiKeySecretArn(
    control: BedrockAgentCoreControlClient,
    tenantId: string,
    onError?: (providerName: string, error: unknown) => void
): Promise<string | undefined> {
    const providerName = githubApiKeyProviderName(tenantId);
    try {
        const resp = await control.send(new GetApiKeyCredentialProviderCommand({ name: providerName }));
        return resp.apiKeySecretArn?.secretArn?.trim() || undefined;
    } catch (error) {
        onError?.(providerName, error);
        return undefined;
    }
}
