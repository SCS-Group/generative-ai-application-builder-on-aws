// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR
} from '../utils/constants';

const AIW_MCP_GATEWAY_USE_CASE_ID_ENV = 'AIW_MCP_GATEWAY_USE_CASE_ID';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function readAgentRuntimeEnvVar(gaabUseCaseId: string, envKey: string): Promise<string | undefined> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        return undefined;
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

    const value = (envVars as Record<string, unknown>)[envKey];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function resolveMcpGatewayUseCaseId(opts: {
    gaabMcpGatewayUseCaseId?: string;
    gaabUseCaseId: string;
}): Promise<string> {
    const fromEvent = opts.gaabMcpGatewayUseCaseId?.trim();
    if (fromEvent) {
        return fromEvent;
    }

    const fromConfig = await readAgentRuntimeEnvVar(opts.gaabUseCaseId, AIW_MCP_GATEWAY_USE_CASE_ID_ENV);
    if (fromConfig) {
        return fromConfig;
    }

    throw new Error(
        'gaabMcpGatewayUseCaseId missing from event and AIW_MCP_GATEWAY_USE_CASE_ID not found on agent use case config'
    );
}
