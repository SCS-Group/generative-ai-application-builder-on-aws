// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    BedrockAgentCoreControlClient,
    GetAgentRuntimeCommand,
    ListAgentRuntimesCommand,
    UpdateAgentRuntimeCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { AIW_GITHUB_API_KEY_SECRET_ID_ENV } from './utils/github-runtime-env';
import { loadGithubApiKeySecretArn } from './utils/load-github-api-key-secret-arn';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { withPlatformAgentRuntimeDefaults } from './utils/platform-agent-runtime-env';
import { logger } from './power-tools-init';
import {
    GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM,
    GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM,
    isWorkflowContainerUri,
    isWorkflowRuntimeName,
    resolveWorkflowPlatformContainerUri
} from './platform-workflow-image-uri';

/** Written by DeploymentPlatformStack CodeBuild custom resource (see gaab-strands-agent-image-build). */
const AIW_OAUTH_CALLBACK_SSM_PARAM = '/gaab-deployment-platform/AiwOAuthCallbackUrl';
const AIW_FIGMA_TOOL_PROXY_LAMBDA_SSM_PARAM = '/gaab-deployment-platform/AiwFigmaToolProxyLambdaName';
const AIW_FIGMA_UX_TEMPLATE_FILE_KEY_SSM_PARAM = '/gaab-deployment-platform/AiwFigmaUxTemplateFileKey';
const AIW_FIGMA_TEAM_ID_SSM_PARAM = '/gaab-deployment-platform/AiwFigmaTeamId';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const control = new BedrockAgentCoreControlClient({});
const ssm = new SSMClient({});

const AIW_AGENT_WORKLOAD_NAME_ENV = 'AIW_AGENT_WORKLOAD_NAME';

function buildAgentWorkloadRuntimeEnv(runtimeId: string): Record<string, string> {
    const id = runtimeId.trim();
    return id ? { [AIW_AGENT_WORKLOAD_NAME_ENV]: id } : {};
}

function agentRuntimeNameFromUseCaseId(useCaseId: string): string {
    const short = useCaseId.trim().split('-')[0];
    // Workflow stacks create runtimes using the `gaab_workflow_<shortId>` naming convention.
    return `gaab_workflow_${short}`;
}

async function loadAgentRuntimeEnvVars(useCaseId: string): Promise<Record<string, string> | undefined> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        return undefined;
    }

    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: useCaseId },
            ProjectionExpression: 'UseCaseConfigRecordKey'
        })
    );
    const configKey =
        typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey.trim() : '';
    if (!configKey) {
        return undefined;
    }

    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: configTable,
            Key: { key: configKey }
        })
    );
    const config = cfgRow.Item?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return undefined;
    }
    const envVars = (config as Record<string, unknown>).AgentRuntimeEnvVars;
    if (!envVars || typeof envVars !== 'object' || Array.isArray(envVars)) {
        return undefined;
    }
    const parsed: Record<string, string> = {};
    for (const [k, v] of Object.entries(envVars)) {
        if (v != null && String(v).trim()) {
            parsed[String(k)] = String(v);
        }
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
}

async function patchConfigAgentRuntimeEnv(
    useCaseId: string,
    runtimeEnvPatch: Record<string, string>
): Promise<void> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable || !Object.keys(runtimeEnvPatch).length) {
        return;
    }

    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: useCaseId },
            ProjectionExpression: 'UseCaseConfigRecordKey'
        })
    );
    const configKey =
        typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey.trim() : '';
    if (!configKey) {
        return;
    }

    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: configTable,
            Key: { key: configKey }
        })
    );
    const config = cfgRow.Item?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return;
    }

    const base = { ...(config as Record<string, unknown>) };
    const envVars =
        base.AgentRuntimeEnvVars && typeof base.AgentRuntimeEnvVars === 'object' && !Array.isArray(base.AgentRuntimeEnvVars)
            ? { ...(base.AgentRuntimeEnvVars as Record<string, string>) }
            : {};
    Object.assign(envVars, runtimeEnvPatch);
    base.AgentRuntimeEnvVars = envVars;

    await ddb.send(
        new UpdateCommand({
            TableName: configTable,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': base }
        })
    );
}

async function resolveAgentRuntimeId(runtimeName: string): Promise<string | undefined> {
    let nextToken: string | undefined;
    do {
        const page = await control.send(
            new ListAgentRuntimesCommand({ maxResults: 50, nextToken })
        );
        const match = page.agentRuntimes?.find((rt) => rt.agentRuntimeName === runtimeName);
        if (match?.agentRuntimeId) {
            return match.agentRuntimeId;
        }
        nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
}

async function loadSsmParam(name: string): Promise<string | undefined> {
    try {
        const resp = await ssm.send(new GetParameterCommand({ Name: name }));
        return resp.Parameter?.Value?.trim() || undefined;
    } catch (e) {
        logger.warn('syncAgentRuntimeEnv: could not load SSM parameter', { name, error: e });
        return undefined;
    }
}

async function loadPlatformAgentImageUri(): Promise<string | undefined> {
    return loadSsmParam(GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM);
}

async function loadPlatformWorkflowImageUri(): Promise<string | undefined> {
    return loadSsmParam(GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM);
}

async function loadOAuthCallbackUrl(): Promise<string | undefined> {
    const fromEnv = process.env.AIW_OAUTH_CALLBACK_URL?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    return loadSsmParam(AIW_OAUTH_CALLBACK_SSM_PARAM);
}

function githubConfiguredOnRuntimeEnv(env: Record<string, string>): boolean {
    return Boolean(
        env.AIW_GITHUB_API_KEY_PROVIDER_NAME?.trim() &&
            env.AIW_GITHUB_OWNER?.trim() &&
            env.AIW_GITHUB_REPO?.trim()
    );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After agent stack completes, merge AgentRuntimeEnvVars from use case config onto the live runtime
 * and align the container image with the platform CodeBuild tag from SSM when needed.
 */
export async function syncAgentRuntimeEnvFromConfig(useCaseId: string): Promise<{ agentRuntimeArn?: string }> {
    const additional = await loadAgentRuntimeEnvVars(useCaseId);
    if (!additional?.AIW_TENANT_ID) {
        throw new Error(`Use case config has no AgentRuntimeEnvVars.AIW_TENANT_ID (useCaseId=${useCaseId})`);
    }

    const runtimeName = agentRuntimeNameFromUseCaseId(useCaseId);
    let runtimeId: string | undefined;
    for (let attempt = 1; attempt <= 30; attempt++) {
        runtimeId = await resolveAgentRuntimeId(runtimeName);
        if (runtimeId) {
            break;
        }
        logger.info('syncAgentRuntimeEnv: waiting for runtime', { runtimeName, attempt });
        await sleep(10_000);
    }
    if (!runtimeId) {
        throw new Error(`Agent runtime ${runtimeName} not found after stack complete`);
    }

    const describe = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    const roleArn = describe.roleArn?.trim();
    if (!roleArn) {
        throw new Error(`Agent runtime ${runtimeId} missing roleArn`);
    }

    const currentUri = describe.agentRuntimeArtifact?.containerConfiguration?.containerUri?.trim();
    const platformAgentUri = await loadPlatformAgentImageUri();
    const platformWorkflowUri = await loadPlatformWorkflowImageUri();
    const containerUri = resolveWorkflowPlatformContainerUri({
        platformWorkflowUri,
        platformAgentUri,
        currentUri,
        runtimeName
    });

    if (isWorkflowContainerUri(currentUri) && !isWorkflowContainerUri(containerUri)) {
        throw new Error(
            `Refusing to replace workflow container image with specialist agent image on ${runtimeName}`
        );
    }

    const workloadEnv = buildAgentWorkloadRuntimeEnv(runtimeId);

    const oauthCallback = await loadOAuthCallbackUrl();
    const figmaProxyLambda = await loadSsmParam(AIW_FIGMA_TOOL_PROXY_LAMBDA_SSM_PARAM);
    const figmaTemplateKey = await loadSsmParam(AIW_FIGMA_UX_TEMPLATE_FILE_KEY_SSM_PARAM);
    const figmaTeamId = await loadSsmParam(AIW_FIGMA_TEAM_ID_SSM_PARAM);
    const githubSecretArn =
        (additional.AIW_GITHUB_API_KEY_PROVIDER_NAME
            ? await loadGithubApiKeySecretArn(control, additional.AIW_TENANT_ID, (providerName, error) => {
                  logger.warn('syncAgentRuntimeEnv: could not resolve GitHub API key secret ARN', {
                      providerName,
                      error
                  });
              })
            : undefined) || additional[AIW_GITHUB_API_KEY_SECRET_ID_ENV]?.trim();
    if (githubConfiguredOnRuntimeEnv(additional) && !githubSecretArn) {
        throw new Error(
            `GitHub is configured for use case ${useCaseId} but ${AIW_GITHUB_API_KEY_SECRET_ID_ENV} could not be resolved.`
        );
    }
    const env = withPlatformAgentRuntimeDefaults({
        ...(describe.environmentVariables ?? {}),
        ...additional,
        ...workloadEnv,
        ...(isWorkflowRuntimeName(runtimeName) ? { AIW_DISABLE_GITHUB_DIRECT: '1' } : {}),
        ...(oauthCallback ? { AIW_OAUTH_CALLBACK_URL: oauthCallback } : {}),
        ...(figmaProxyLambda && !figmaProxyLambda.startsWith('REPLACE_') && !additional.AIW_FIGMA_TOOL_PROXY_LAMBDA?.trim()
            ? { AIW_FIGMA_TOOL_PROXY_LAMBDA: figmaProxyLambda }
            : {}),
        ...(figmaTemplateKey &&
        !figmaTemplateKey.startsWith('REPLACE_') &&
        !additional.AIW_FIGMA_UX_TEMPLATE_FILE_KEY?.trim()
            ? { AIW_FIGMA_UX_TEMPLATE_FILE_KEY: figmaTemplateKey }
            : {}),
        ...(figmaTeamId && !figmaTeamId.startsWith('REPLACE_') && !additional.AIW_FIGMA_TEAM_ID?.trim()
            ? { AIW_FIGMA_TEAM_ID: figmaTeamId }
            : {}),
        ...(githubSecretArn ? { [AIW_GITHUB_API_KEY_SECRET_ID_ENV]: githubSecretArn } : {})
    });

    await control.send(
        new UpdateAgentRuntimeCommand({
            agentRuntimeId: runtimeId,
            agentRuntimeArtifact: {
                containerConfiguration: { containerUri }
            },
            roleArn,
            networkConfiguration: describe.networkConfiguration ?? { networkMode: 'PUBLIC' },
            environmentVariables: env,
            ...(describe.protocolConfiguration ? { protocolConfiguration: describe.protocolConfiguration } : {}),
            ...(describe.lifecycleConfiguration ? { lifecycleConfiguration: describe.lifecycleConfiguration } : {})
        })
    );

    try {
        await patchConfigAgentRuntimeEnv(useCaseId, {
            ...workloadEnv,
            ...(isWorkflowRuntimeName(runtimeName) ? { AIW_DISABLE_GITHUB_DIRECT: '1' } : {}),
            ...(githubSecretArn ? { [AIW_GITHUB_API_KEY_SECRET_ID_ENV]: githubSecretArn } : {})
        });
    } catch (e) {
        logger.warn('syncAgentRuntimeEnv: could not persist workload env to use case config', {
            useCaseId,
            runtimeId,
            error: e
        });
    }

    logger.info('syncAgentRuntimeEnv: applied AgentRuntimeEnvVars to runtime', {
        useCaseId,
        runtimeId,
        runtimeName,
        keys: Object.keys(additional),
        imageUpdated: Boolean(containerUri && containerUri !== currentUri),
        containerUri,
        previousContainerUri: currentUri
    });

    return { agentRuntimeArn: describe.agentRuntimeArn?.trim() || undefined };
}
