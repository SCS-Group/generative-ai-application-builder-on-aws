// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR } from '../utils/constants';
import { clearPolicyLimitRuntimeEnv, policyLimitRuntimeEnvPatch } from './policy-runtime-env';
import type { AgentCoreWorkspacePolicyRecord } from './types';
import { logger } from '../power-tools-init';

const AIW_MCP_GATEWAY_USE_CASE_ID_ENV = 'AIW_MCP_GATEWAY_USE_CASE_ID';
const LEGACY_POLICY_ENV_KEYS = [
    'AIW_WORKSPACE_POLICY_BLOCK',
    'AIW_WORKSPACE_POLICY_VERSION',
    'AIW_WORKSPACE_POLICY_MEMORY_ENABLED'
] as const;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function stripLegacyWorkspacePolicyConfig(config: Record<string, unknown>): Record<string, unknown> {
    const next = { ...config };
    delete next.WorkspaceAgentPolicy;

    const envVars =
        next.AgentRuntimeEnvVars && typeof next.AgentRuntimeEnvVars === 'object' && !Array.isArray(next.AgentRuntimeEnvVars)
            ? { ...(next.AgentRuntimeEnvVars as Record<string, unknown>) }
            : {};

    for (const key of LEGACY_POLICY_ENV_KEYS) {
        delete envVars[key];
    }
    clearPolicyLimitRuntimeEnv(envVars);

    next.AgentRuntimeEnvVars = envVars;
    return next;
}

export async function patchUseCaseAgentCorePolicy(
    configKey: string,
    config: Record<string, unknown>,
    record: AgentCoreWorkspacePolicyRecord
): Promise<void> {
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!configTable) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured');
    }

    const stripped = stripLegacyWorkspacePolicyConfig(config);
    const envVars =
        stripped.AgentRuntimeEnvVars && typeof stripped.AgentRuntimeEnvVars === 'object' && !Array.isArray(stripped.AgentRuntimeEnvVars)
            ? (stripped.AgentRuntimeEnvVars as Record<string, unknown>)
            : {};
    envVars[AIW_MCP_GATEWAY_USE_CASE_ID_ENV] = record.gaabMcpGatewayUseCaseId;
    if (record.policy && typeof record.policy === 'object' && !Array.isArray(record.policy)) {
        Object.assign(envVars, policyLimitRuntimeEnvPatch(record.policy as Record<string, unknown>));
    }

    const updated: Record<string, unknown> = {
        ...stripped,
        AgentRuntimeEnvVars: envVars,
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
        gatewayId: record.gatewayId,
        gaabMcpGatewayUseCaseId: record.gaabMcpGatewayUseCaseId
    });
}

/** Remove stale AgentCoreWorkspacePolicy after engine teardown or before re-apply on a new engine. */
export async function clearAgentCoreWorkspacePolicyFromConfig(
    configKey: string,
    config: Record<string, unknown>
): Promise<void> {
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!configTable) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured');
    }

    const stripped = stripLegacyWorkspacePolicyConfig(config);
    delete stripped.AgentCoreWorkspacePolicy;

    await ddb.send(
        new UpdateCommand({
            TableName: configTable,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': stripped }
        })
    );

    logger.info('Cleared AgentCore workspace policy metadata from use case config', { configKey });
}
