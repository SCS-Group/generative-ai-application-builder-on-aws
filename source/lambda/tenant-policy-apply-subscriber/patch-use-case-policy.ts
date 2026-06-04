// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { customAwsConfig } from 'aws-node-user-agent-config';
import {
    AIW_WORKSPACE_POLICY_BLOCK_ENV,
    AIW_WORKSPACE_POLICY_MEMORY_ENABLED_ENV,
    AIW_WORKSPACE_POLICY_VERSION_ENV,
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR
} from './utils/constants';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(customAwsConfig()));

export async function patchUseCaseWorkspacePolicy(
    gaabUseCaseId: string,
    opts: {
        policyBlock: string;
        policyVersion: string;
        policy: Record<string, unknown>;
        memoryEnabled: boolean;
    }
): Promise<void> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        throw new Error('USE_CASES_TABLE_NAME or USE_CASE_CONFIG_TABLE_NAME not configured');
    }

    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: gaabUseCaseId },
            ProjectionExpression: 'UseCaseConfigRecordKey'
        })
    );
    const configKey =
        typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey.trim() : '';
    if (!configKey) {
        throw new Error(`No UseCaseConfigRecordKey for use case ${gaabUseCaseId}`);
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

    const prev = config as Record<string, unknown>;
    const envVars =
        prev.AgentRuntimeEnvVars && typeof prev.AgentRuntimeEnvVars === 'object' && !Array.isArray(prev.AgentRuntimeEnvVars)
            ? { ...(prev.AgentRuntimeEnvVars as Record<string, unknown>) }
            : {};

    envVars[AIW_WORKSPACE_POLICY_BLOCK_ENV] = opts.policyBlock;
    envVars[AIW_WORKSPACE_POLICY_VERSION_ENV] = opts.policyVersion;
    envVars[AIW_WORKSPACE_POLICY_MEMORY_ENABLED_ENV] = opts.memoryEnabled ? 'true' : 'false';

    const updated: Record<string, unknown> = {
        ...prev,
        AgentRuntimeEnvVars: envVars,
        WorkspaceAgentPolicy: {
            policyVersion: opts.policyVersion,
            policyBlock: opts.policyBlock,
            policy: opts.policy,
            memoryEnabled: opts.memoryEnabled,
            updatedAt: new Date().toISOString()
        }
    };

    await ddb.send(
        new UpdateCommand({
            TableName: configTable,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': updated }
        })
    );

    logger.info('Patched workspace policy on use case config', {
        gaabUseCaseId,
        configKey,
        policyVersion: opts.policyVersion,
        memoryEnabled: opts.memoryEnabled
    });
}
