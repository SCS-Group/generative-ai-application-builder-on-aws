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
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AIW_AGENT_WORKLOAD_NAME_ENV } from './utils/github-runtime-env';
import {
    AIW_FIGMA_TOOL_PROXY_LAMBDA_ENV,
    FIGMA_WORKSPACE_RUNTIME_ENV_KEYS,
    buildFigmaRuntimeEnvVars
} from './utils/figma-runtime-env';

const USE_CASES_TABLE = process.env.USE_CASES_TABLE_NAME?.trim() ?? '';
const USE_CASE_CONFIG_TABLE = process.env.USE_CASE_CONFIG_TABLE_NAME?.trim() ?? '';
const GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM = '/gaab-deployment-platform/GaabStrandsAgentImageUri';
const AIW_OAUTH_CALLBACK_SSM_PARAM = '/gaab-deployment-platform/AiwOAuthCallbackUrl';
const AIW_FIGMA_TOOL_PROXY_LAMBDA_SSM_PARAM = '/gaab-deployment-platform/AiwFigmaToolProxyLambdaName';

const PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS: Record<string, string> = {
    BEDROCK_READ_TIMEOUT: '850',
    BEDROCK_CONNECT_TIMEOUT: '10',
    GITHUB_MCP_MAX_FILE_READS: '8',
    GITHUB_MCP_MAX_ISSUE_FETCHES: '1'
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const control = new BedrockAgentCoreControlClient({});
const ssm = new SSMClient({});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function agentRuntimeNameFromUseCaseId(useCaseId: string): string {
    return `gaab_agent_${useCaseId.trim().split('-')[0]}`;
}

function removeFigmaKeysFromEnv(env: Record<string, string>): Record<string, string> {
    const next = { ...env };
    for (const key of FIGMA_WORKSPACE_RUNTIME_ENV_KEYS) {
        delete next[key];
    }
    return next;
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

async function loadSsmParam(name: string): Promise<string | undefined> {
    try {
        const resp = await ssm.send(new GetParameterCommand({ Name: name }));
        return resp.Parameter?.Value?.trim() || undefined;
    } catch {
        return undefined;
    }
}

async function resolveRuntimeId(runtimeName: string): Promise<string | undefined> {
    let nextToken: string | undefined;
    do {
        const page = await control.send(new ListAgentRuntimesCommand({ maxResults: 50, nextToken }));
        const match = page.agentRuntimes?.find((rt) => rt.agentRuntimeName === runtimeName);
        if (match?.agentRuntimeId) return match.agentRuntimeId;
        nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
}

async function resolveRuntimeIdOnce(useCaseId: string): Promise<string> {
    const runtimeName = agentRuntimeNameFromUseCaseId(useCaseId);
    const runtimeId = await resolveRuntimeId(runtimeName);
    if (!runtimeId) {
        throw new Error(`Agent runtime ${runtimeName} not found for Figma runtime env sync`);
    }
    return runtimeId;
}

async function resolveRuntimeIdWithRetry(useCaseId: string): Promise<string> {
    const runtimeName = agentRuntimeNameFromUseCaseId(useCaseId);
    for (let attempt = 1; attempt <= 30; attempt++) {
        const runtimeId = await resolveRuntimeId(runtimeName);
        if (runtimeId) {
            return runtimeId;
        }
        console.info('Figma runtime env sync waiting for agent runtime', { runtimeName, attempt });
        await sleep(10_000);
    }
    throw new Error(`Agent runtime ${runtimeName} not found after Figma install`);
}

async function patchConfigFigmaEnv(
    gaabUseCaseId: string,
    runtimeId: string,
    figmaEnv: Record<string, string>
): Promise<Record<string, string>> {
    if (!USE_CASE_CONFIG_TABLE) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured on integration installer');
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
    Object.assign(envVars, figmaEnv, { [AIW_AGENT_WORKLOAD_NAME_ENV]: runtimeId.trim() });
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

async function patchConfigRemoveFigmaEnv(gaabUseCaseId: string, runtimeId: string): Promise<Record<string, string>> {
    if (!USE_CASE_CONFIG_TABLE) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured on integration installer');
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
            ? removeFigmaKeysFromEnv(base.AgentRuntimeEnvVars as Record<string, string>)
            : {};
    envVars[AIW_AGENT_WORKLOAD_NAME_ENV] = runtimeId.trim();
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

async function applyRuntimeEnv(gaabUseCaseId: string, configEnvVars: Record<string, string>, runtimeId: string): Promise<void> {
    const describe = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    const roleArn = describe.roleArn?.trim();
    if (!roleArn) {
        throw new Error(`Agent runtime ${runtimeId} missing roleArn`);
    }

    const platformUri = await loadSsmParam(GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM);
    if (!platformUri) {
        throw new Error(`SSM ${GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM} is missing`);
    }

    const oauthCallback = process.env.AIW_OAUTH_CALLBACK_URL?.trim() || (await loadSsmParam(AIW_OAUTH_CALLBACK_SSM_PARAM));
    const env: Record<string, string> = {
        ...(describe.environmentVariables ?? {}),
        ...configEnvVars,
        [AIW_AGENT_WORKLOAD_NAME_ENV]: runtimeId,
        ...(oauthCallback ? { AIW_OAUTH_CALLBACK_URL: oauthCallback } : {}),
        ...PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS
    };

    await control.send(
        new UpdateAgentRuntimeCommand({
            agentRuntimeId: runtimeId,
            agentRuntimeArtifact: {
                containerConfiguration: { containerUri: platformUri }
            },
            roleArn,
            networkConfiguration: describe.networkConfiguration ?? { networkMode: 'PUBLIC' },
            environmentVariables: env,
            ...(describe.protocolConfiguration ? { protocolConfiguration: describe.protocolConfiguration } : {}),
            ...(describe.lifecycleConfiguration ? { lifecycleConfiguration: describe.lifecycleConfiguration } : {})
        })
    );

    console.info('Figma runtime env applied to agent runtime', { gaabUseCaseId, runtimeId });
}

export type FigmaInstallDetail = {
    gaabUseCaseId?: string;
    customFigmaTeamId?: string;
    customFigmaUxTemplateFileKey?: string;
    customFigmaProjectId?: string;
};

export function isFigmaConfiguredInstall(detail: FigmaInstallDetail): boolean {
    return Boolean(detail.customFigmaTeamId?.trim() && detail.customFigmaUxTemplateFileKey?.trim());
}

async function buildFigmaEnvFromDetail(detail: FigmaInstallDetail): Promise<Record<string, string>> {
    const figmaProxy = await loadSsmParam(AIW_FIGMA_TOOL_PROXY_LAMBDA_SSM_PARAM);
    return buildFigmaRuntimeEnvVars({
        figmaTeamId: detail.customFigmaTeamId ?? '',
        figmaUxTemplateFileKey: detail.customFigmaUxTemplateFileKey ?? '',
        figmaProjectId: detail.customFigmaProjectId,
        figmaToolProxyLambda: figmaProxy
    });
}

export async function syncFigmaRuntimeEnvAfterInstall(detail: FigmaInstallDetail): Promise<void> {
    await syncFigmaRuntimeEnv(detail, { waitForRuntime: true });
}

export async function syncFigmaRuntimeEnvFromSettings(detail: FigmaInstallDetail): Promise<void> {
    await syncFigmaRuntimeEnv(detail, { waitForRuntime: false });
}

async function syncFigmaRuntimeEnv(detail: FigmaInstallDetail, options: { waitForRuntime: boolean }): Promise<void> {
    const gaabUseCaseId = detail.gaabUseCaseId?.trim();
    if (!gaabUseCaseId) {
        throw new Error('Figma sync missing gaabUseCaseId');
    }
    if (!isFigmaConfiguredInstall(detail)) {
        console.warn('Figma runtime env sync skipped: team id and UX template file key are required');
        return;
    }

    const figmaEnv = await buildFigmaEnvFromDetail(detail);
    if (!Object.keys(figmaEnv).length) {
        console.warn('Figma runtime env sync skipped: empty env patch');
        return;
    }

    const runtimeId = options.waitForRuntime
        ? await resolveRuntimeIdWithRetry(gaabUseCaseId)
        : await resolveRuntimeIdOnce(gaabUseCaseId);

    const configEnvVars = await patchConfigFigmaEnv(gaabUseCaseId, runtimeId, figmaEnv);
    await applyRuntimeEnv(gaabUseCaseId, configEnvVars, runtimeId);
}

export async function clearFigmaRuntimeEnvForWorkspace(gaabUseCaseId: string): Promise<void> {
    const useCaseId = gaabUseCaseId.trim();
    if (!useCaseId) {
        throw new Error('gaabUseCaseId is required to clear Figma runtime env');
    }
    const runtimeId = await resolveRuntimeIdOnce(useCaseId);
    const configEnvVars = await patchConfigRemoveFigmaEnv(useCaseId, runtimeId);
    await applyRuntimeEnv(useCaseId, configEnvVars, runtimeId);
}
