// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR
} from '../utils/constants';
import type { AgentCoreWorkspacePolicyRecord } from './types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type UseCaseConfigLoadResult = {
    configKey: string;
    config: Record<string, unknown>;
    agentCorePolicy?: AgentCoreWorkspacePolicyRecord;
};

function asAgentCorePolicyRecord(raw: unknown): AgentCoreWorkspacePolicyRecord | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    const policyEngineId = typeof o.policyEngineId === 'string' ? o.policyEngineId.trim() : '';
    const policyEngineArn = typeof o.policyEngineArn === 'string' ? o.policyEngineArn.trim() : '';
    const gatewayId = typeof o.gatewayId === 'string' ? o.gatewayId.trim() : '';
    const gaabMcpGatewayUseCaseId =
        typeof o.gaabMcpGatewayUseCaseId === 'string' ? o.gaabMcpGatewayUseCaseId.trim() : '';
    const cedarPolicyId = typeof o.cedarPolicyId === 'string' ? o.cedarPolicyId.trim() : '';
    const policyVersion = typeof o.policyVersion === 'string' ? o.policyVersion.trim() : '';
    const mode = o.mode === 'ENFORCE' || o.mode === 'LOG_ONLY' ? o.mode : 'LOG_ONLY';
    const updatedAt = typeof o.updatedAt === 'string' ? o.updatedAt.trim() : '';
    const policy =
        o.policy && typeof o.policy === 'object' && !Array.isArray(o.policy)
            ? (o.policy as Record<string, unknown>)
            : {};

    if (!policyEngineId || !policyEngineArn || !cedarPolicyId) {
        return undefined;
    }

    return {
        policyEngineId,
        policyEngineArn,
        gatewayId,
        gatewayArn: typeof o.gatewayArn === 'string' ? o.gatewayArn.trim() : undefined,
        gaabMcpGatewayUseCaseId,
        cedarPolicyId,
        cedarPolicyArn: typeof o.cedarPolicyArn === 'string' ? o.cedarPolicyArn.trim() : undefined,
        policyVersion,
        policy,
        mode,
        updatedAt
    };
}

export async function loadUseCaseConfig(gaabUseCaseId: string): Promise<UseCaseConfigLoadResult> {
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
    return {
        configKey,
        config: prev,
        agentCorePolicy: asAgentCorePolicyRecord(prev.AgentCoreWorkspacePolicy)
    };
}
