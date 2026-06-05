// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR } from '../utils/constants';
import type { AgentCoreWorkspacePolicyRecord } from './types';
import { logger } from '../power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function patchUseCaseAgentCorePolicy(
    configKey: string,
    config: Record<string, unknown>,
    record: AgentCoreWorkspacePolicyRecord
): Promise<void> {
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!configTable) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured');
    }

    const updated: Record<string, unknown> = {
        ...config,
        AgentCoreWorkspacePolicy: record
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

    logger.info('Patched AgentCore workspace policy metadata on use case config', {
        configKey,
        policyEngineArn: record.policyEngineArn,
        policyVersion: record.policyVersion,
        gatewayId: record.gatewayId
    });
}
