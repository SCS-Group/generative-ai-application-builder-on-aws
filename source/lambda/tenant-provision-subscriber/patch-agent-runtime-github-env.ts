// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { buildGithubRuntimeEnvVars } from './utils/github-runtime-env';
import { syncAgentRuntimeEnvFromConfig } from './sync-agent-runtime-env';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function loadUseCaseConfigKey(useCaseId: string): Promise<string | undefined> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable) {
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
    return configKey || undefined;
}

/**
 * Persist GitHub owner/repo on AgentRuntimeEnvVars and optionally sync the live AgentCore runtime.
 */
export async function patchAgentRuntimeGithubEnv(params: {
    gaabUseCaseId: string;
    tenantId: string;
    githubOwner: string;
    githubRepo: string;
    syncRuntime?: boolean;
}): Promise<void> {
    const githubEnv = buildGithubRuntimeEnvVars(params);
    if (Object.keys(githubEnv).length === 0) {
        return;
    }

    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!configTable) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured');
    }

    const configKey = await loadUseCaseConfigKey(params.gaabUseCaseId);
    if (!configKey) {
        throw new Error(`Use case config key not found for ${params.gaabUseCaseId}`);
    }

    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: configTable,
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
            TableName: configTable,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': base }
        })
    );

    logger.info('Patched GitHub runtime env on use case config', {
        gaabUseCaseId: params.gaabUseCaseId,
        githubOwner: params.githubOwner,
        githubRepo: params.githubRepo
    });

    if (params.syncRuntime !== false) {
        await syncAgentRuntimeEnvFromConfig(params.gaabUseCaseId);
    }
}
