// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(customAwsConfig()));

export async function getGatewayUrlForUseCase(useCaseId: string): Promise<string | undefined> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR];
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR];
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
    const configKey = typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey : '';
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
    const mcpParams = (config as Record<string, unknown>).MCPParams;
    if (!mcpParams || typeof mcpParams !== 'object' || Array.isArray(mcpParams)) {
        return undefined;
    }
    const gatewayParams = (mcpParams as Record<string, unknown>).GatewayParams;
    if (!gatewayParams || typeof gatewayParams !== 'object' || Array.isArray(gatewayParams)) {
        return undefined;
    }
    const url = (gatewayParams as Record<string, unknown>).GatewayUrl;
    return typeof url === 'string' && url.trim() ? url.trim() : undefined;
}

export async function waitForGatewayUrl(
    useCaseId: string,
    maxWaitMs = 600_000,
    intervalMs = 15_000
): Promise<string | undefined> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const url = await getGatewayUrlForUseCase(useCaseId);
            if (url) {
                return url;
            }
        } catch (e) {
            logger.warn('waitForGatewayUrl failed', { useCaseId, error: e });
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return undefined;
}
