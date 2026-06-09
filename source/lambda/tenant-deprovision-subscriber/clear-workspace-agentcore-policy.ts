// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR
} from './utils/constants';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function stripAgentCoreWorkspacePolicy(config: Record<string, unknown>): Record<string, unknown> {
    const next = { ...config };
    delete next.AgentCoreWorkspacePolicy;

    const envVars =
        next.AgentRuntimeEnvVars && typeof next.AgentRuntimeEnvVars === 'object' && !Array.isArray(next.AgentRuntimeEnvVars)
            ? { ...(next.AgentRuntimeEnvVars as Record<string, unknown>) }
            : {};
    for (const key of ['AIW_WORKSPACE_POLICY_BLOCK', 'AIW_WORKSPACE_POLICY_VERSION', 'AIW_WORKSPACE_POLICY_MEMORY_ENABLED']) {
        delete envVars[key];
    }
    delete next.WorkspaceAgentPolicy;
    next.AgentRuntimeEnvVars = envVars;
    return next;
}

/** Best-effort: remove AgentCoreWorkspacePolicy from GAAB use-case config after engine teardown. */
export async function clearWorkspaceAgentCorePolicyFromUseCase(gaabUseCaseId: string): Promise<void> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        logger.warn('Skipping AgentCore policy config clear: use case tables not configured on deprovision subscriber');
        return;
    }

    const useCaseId = gaabUseCaseId.trim();
    if (!useCaseId) {
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
        logger.info('No use case config key; skip AgentCore policy config clear', { useCaseId });
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

    const stripped = stripAgentCoreWorkspacePolicy(config as Record<string, unknown>);
    await ddb.send(
        new UpdateCommand({
            TableName: configTable,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': stripped }
        })
    );

    logger.info('Cleared AgentCoreWorkspacePolicy from use case config during workspace offload', {
        useCaseId,
        configKey
    });
}
