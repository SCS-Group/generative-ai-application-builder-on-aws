// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    BedrockAgentCoreControlClient,
    GetAgentRuntimeCommand,
    ListAgentRuntimesCommand,
    UpdateAgentRuntimeCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const USE_CASES_TABLE = process.env.USE_CASES_TABLE_NAME?.trim() ?? '';
const USE_CASE_CONFIG_TABLE = process.env.USE_CASE_CONFIG_TABLE_NAME?.trim() ?? '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const control = new BedrockAgentCoreControlClient({});

function githubApiKeyProviderName(tenantId: string): string {
    return `aiw-custom-${tenantId.trim().slice(0, 8)}-github`;
}

function githubRuntimeEnv(tenantId: string, owner: string, repo: string): Record<string, string> {
    const o = owner.trim();
    const r = repo.trim();
    if (!o || !r) return {};
    return {
        AIW_GITHUB_OWNER: o,
        AIW_GITHUB_REPO: r,
        AIW_GITHUB_API_KEY_PROVIDER_NAME: githubApiKeyProviderName(tenantId)
    };
}

async function loadConfigKey(useCaseId: string): Promise<string | undefined> {
    if (!USE_CASES_TABLE) return undefined;
    const row = await ddb.send(
        new GetCommand({
            TableName: USE_CASES_TABLE,
            Key: { UseCaseId: useCaseId },
            ProjectionExpression: 'UseCaseConfigRecordKey'
        })
    );
    const key = typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey.trim() : '';
    return key || undefined;
}

async function patchConfigGithubEnv(
    gaabUseCaseId: string,
    tenantId: string,
    owner: string,
    repo: string
): Promise<Record<string, string>> {
    const githubEnv = githubRuntimeEnv(tenantId, owner, repo);
    if (!Object.keys(githubEnv).length || !USE_CASE_CONFIG_TABLE) {
        return githubEnv;
    }
    const configKey = await loadConfigKey(gaabUseCaseId);
    if (!configKey) {
        throw new Error(`Use case config key not found for ${gaabUseCaseId}`);
    }
    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: USE_CASE_CONFIG_TABLE,
            Key: { key: configKey }
        })
    );
    const config = cfgRow.Item?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Use case config missing for key ${configKey}`);
    }
    const base = { ...(config as Record<string, unknown>) };
    const envVars =
        base.AgentRuntimeEnvVars && typeof base.AgentRuntimeEnvVars === 'object' && !Array.isArray(base.AgentRuntimeEnvVars)
            ? { ...(base.AgentRuntimeEnvVars as Record<string, string>) }
            : {};
    Object.assign(envVars, githubEnv);
    base.AgentRuntimeEnvVars = envVars;
    await ddb.send(
        new UpdateCommand({
            TableName: USE_CASE_CONFIG_TABLE,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': base }
        })
    );
    return envVars;
}

async function resolveRuntimeId(useCaseId: string): Promise<string | undefined> {
    const runtimeName = `gaab_agent_${useCaseId.trim().split('-')[0]}`;
    let nextToken: string | undefined;
    do {
        const page = await control.send(new ListAgentRuntimesCommand({ maxResults: 50, nextToken }));
        const match = page.agentRuntimes?.find((rt) => rt.agentRuntimeName === runtimeName);
        if (match?.agentRuntimeId) return match.agentRuntimeId;
        nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
}

async function applyRuntimeEnv(gaabUseCaseId: string, envVars: Record<string, string>): Promise<void> {
    const runtimeId = await resolveRuntimeId(gaabUseCaseId);
    if (!runtimeId) {
        throw new Error(`Agent runtime not found for use case ${gaabUseCaseId}`);
    }
    const describe = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    const roleArn = describe.roleArn?.trim();
    if (!roleArn) {
        throw new Error(`Agent runtime ${runtimeId} missing roleArn`);
    }
    const containerUri = describe.agentRuntimeArtifact?.containerConfiguration?.containerUri?.trim() ?? '';
    const merged = { ...(describe.environmentVariables ?? {}), ...envVars };
    await control.send(
        new UpdateAgentRuntimeCommand({
            agentRuntimeId: runtimeId,
            agentRuntimeArtifact: {
                containerConfiguration: { containerUri }
            },
            roleArn,
            networkConfiguration: describe.networkConfiguration ?? { networkMode: 'PUBLIC' },
            environmentVariables: merged,
            ...(describe.protocolConfiguration ? { protocolConfiguration: describe.protocolConfiguration } : {}),
            ...(describe.lifecycleConfiguration ? { lifecycleConfiguration: describe.lifecycleConfiguration } : {})
        })
    );
}

type GithubInstallDetail = {
    gaabUseCaseId?: string;
    tenantId: string;
    customGithubOwner?: string;
    customGithubRepo?: string;
};

/** After GitHub gateway target install, persist owner/repo on the agent runtime for direct REST tools. */
export async function syncGithubRuntimeEnvAfterInstall(detail: GithubInstallDetail): Promise<void> {
    const gaabUseCaseId = detail.gaabUseCaseId?.trim();
    const owner = detail.customGithubOwner?.trim() ?? '';
    const repo = detail.customGithubRepo?.trim() ?? '';
    const tenantId = detail.tenantId?.trim() ?? '';
    if (!gaabUseCaseId || !owner || !repo || !tenantId) {
        return;
    }
    try {
        const envVars = await patchConfigGithubEnv(gaabUseCaseId, tenantId, owner, repo);
        await applyRuntimeEnv(gaabUseCaseId, envVars);
        console.info('GitHub runtime env synced after integration install', { gaabUseCaseId, owner, repo });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('GitHub runtime env sync failed (install still succeeded)', msg);
    }
}
