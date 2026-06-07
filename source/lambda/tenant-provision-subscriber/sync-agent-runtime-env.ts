// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    BedrockAgentCoreControlClient,
    GetAgentRuntimeCommand,
    ListAgentRuntimesCommand,
    UpdateAgentRuntimeCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { withPlatformAgentRuntimeDefaults } from './utils/platform-agent-runtime-env';
import { logger } from './power-tools-init';

/** Written by DeploymentPlatformStack CodeBuild custom resource (see gaab-strands-agent-image-build). */
const GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM = '/gaab-deployment-platform/GaabStrandsAgentImageUri';
const AIW_OAUTH_CALLBACK_SSM_PARAM = '/gaab-deployment-platform/AiwOAuthCallbackUrl';
const AIW_FIGMA_TOOL_PROXY_LAMBDA_SSM_PARAM = '/gaab-deployment-platform/AiwFigmaToolProxyLambdaName';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const control = new BedrockAgentCoreControlClient({});
const ssm = new SSMClient({});

function agentRuntimeNameFromUseCaseId(useCaseId: string): string {
    const short = useCaseId.trim().split('-')[0];
    return `gaab_agent_${short}`;
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

async function loadOAuthCallbackUrl(): Promise<string | undefined> {
    const fromEnv = process.env.AIW_OAUTH_CALLBACK_URL?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    return loadSsmParam(AIW_OAUTH_CALLBACK_SSM_PARAM);
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
    const platformUri = await loadPlatformAgentImageUri();
    if (!platformUri) {
        throw new Error(
            `SSM ${GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM} is missing; run DeploymentPlatformStack platform-deploy first`
        );
    }
    const containerUri = platformUri;

    const oauthCallback = await loadOAuthCallbackUrl();
    const figmaProxyLambda = await loadSsmParam(AIW_FIGMA_TOOL_PROXY_LAMBDA_SSM_PARAM);
    const env = withPlatformAgentRuntimeDefaults({
        ...(describe.environmentVariables ?? {}),
        ...additional,
        ...(oauthCallback ? { AIW_OAUTH_CALLBACK_URL: oauthCallback } : {}),
        ...(figmaProxyLambda && !figmaProxyLambda.startsWith('REPLACE_')
            ? { AIW_FIGMA_TOOL_PROXY_LAMBDA: figmaProxyLambda }
            : {})
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

    logger.info('syncAgentRuntimeEnv: applied AgentRuntimeEnvVars to runtime', {
        useCaseId,
        runtimeId,
        runtimeName,
        keys: Object.keys(additional),
        imageUpdated: Boolean(platformUri && platformUri !== currentUri),
        containerUri
    });

    return { agentRuntimeArn: describe.agentRuntimeArn?.trim() || undefined };
}
