// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    BedrockAgentCoreControlClient,
    ListAgentRuntimesCommand
} from '@aws-sdk/client-bedrock-agentcore-control';

const control = new BedrockAgentCoreControlClient({});

/** Matches tenant-provision-subscriber sync-agent-runtime-env naming. */
export function agentRuntimeNameFromUseCaseId(agentUseCaseId: string): string {
    const short = agentUseCaseId.trim().split('-')[0];
    return `gaab_agent_${short}`;
}

async function resolveAgentRuntimeId(runtimeName: string): Promise<string | undefined> {
    let nextToken: string | undefined;
    do {
        const page = await control.send(new ListAgentRuntimesCommand({ maxResults: 50, nextToken }));
        const match = page.agentRuntimes?.find((rt) => rt.agentRuntimeName === runtimeName);
        if (match?.agentRuntimeId) {
            return match.agentRuntimeId;
        }
        nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
}

/**
 * Workload identity for AgentCore Runtime OAuth vault binding.
 * Service-linked runtime workloads use agentRuntimeId as the workload identity name.
 */
export async function resolveAgentOAuthWorkloadName(agentUseCaseId: string): Promise<string | undefined> {
    const useCaseId = agentUseCaseId.trim();
    if (!useCaseId) {
        return undefined;
    }
    const runtimeName = agentRuntimeNameFromUseCaseId(useCaseId);
    return resolveAgentRuntimeId(runtimeName);
}
