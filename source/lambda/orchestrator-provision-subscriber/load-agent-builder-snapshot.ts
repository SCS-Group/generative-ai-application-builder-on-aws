// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(customAwsConfig()));

export type AgentBuilderWorkflowAgentEntry = {
    UseCaseId: string;
    UseCaseType: 'AgentBuilder';
    UseCaseName: string;
    UseCaseDescription?: string;
    LlmParams: Record<string, unknown>;
    AgentBuilderParams: Record<string, unknown>;
};

export type LoadAgentSnapshotResult =
    | { ok: true; agent: AgentBuilderWorkflowAgentEntry; tenantId: string }
    | { ok: false; message: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function agentBuilderParamsFromConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
    const fromBuilder = asRecord(config.AgentBuilderParams);
    if (fromBuilder?.SystemPrompt) {
        return fromBuilder;
    }
    const fromAgent = asRecord(config.AgentParams);
    if (fromAgent?.SystemPrompt) {
        return fromAgent;
    }
    return undefined;
}

/**
 * Read-only snapshot of a deployed AgentBuilder use case for workflow Agents[] embedding.
 * Includes MCPServers when present on the stored config (required for Gmail/Figma/custom tools under orchestration).
 */
export async function loadAgentBuilderSnapshotForWorkflow(
    gaabUseCaseId: string,
    expectedTenantId: string
): Promise<LoadAgentSnapshotResult> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        return { ok: false, message: 'GAAB use case tables are not configured.' };
    }

    const useCaseId = gaabUseCaseId.trim();
    const tenantId = expectedTenantId.trim();

    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: useCaseId }
        })
    );
    const item = row.Item;
    if (!item) {
        return { ok: false, message: `Specialist use case ${useCaseId} was not found in GAAB.` };
    }

    const rowTenantId = typeof item.TenantId === 'string' ? item.TenantId.trim() : '';
    if (rowTenantId && tenantId && rowTenantId !== tenantId) {
        return { ok: false, message: `Specialist ${useCaseId} does not belong to this tenant.` };
    }

    const useCaseType = typeof item.UseCaseType === 'string' ? item.UseCaseType.trim() : '';
    if (useCaseType && useCaseType !== 'AgentBuilder') {
        return { ok: false, message: `Use case ${useCaseId} is not an AgentBuilder specialist (${useCaseType}).` };
    }

    const useCaseName = typeof item.Name === 'string' ? item.Name.trim() : '';
    if (!useCaseName) {
        return { ok: false, message: `Specialist ${useCaseId} is missing a use case name.` };
    }

    const configKey =
        typeof item.UseCaseConfigRecordKey === 'string' ? item.UseCaseConfigRecordKey.trim() : '';
    if (!configKey) {
        return { ok: false, message: `Specialist ${useCaseId} has no configuration record.` };
    }

    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: configTable,
            Key: { key: configKey }
        })
    );
    const config = asRecord(cfgRow.Item?.config);
    if (!config) {
        return { ok: false, message: `Specialist ${useCaseId} configuration could not be loaded.` };
    }

    const llmParams = asRecord(config.LlmParams);
    const agentBuilderParams = agentBuilderParamsFromConfig(config);
    if (!llmParams) {
        return { ok: false, message: `Specialist ${useCaseId} is missing LlmParams in config.` };
    }
    if (!agentBuilderParams?.SystemPrompt) {
        return { ok: false, message: `Specialist ${useCaseId} is missing SystemPrompt in config.` };
    }

    const description =
        typeof item.Description === 'string' && item.Description.trim()
            ? item.Description.trim()
            : undefined;

    logger.info('Loaded specialist snapshot for workflow', {
        gaabUseCaseId: useCaseId,
        useCaseName,
        mcpServerCount: Array.isArray(agentBuilderParams.MCPServers)
            ? agentBuilderParams.MCPServers.length
            : 0
    });

    return {
        ok: true,
        tenantId: rowTenantId || tenantId,
        agent: {
            UseCaseId: useCaseId,
            UseCaseType: 'AgentBuilder',
            UseCaseName: useCaseName,
            ...(description ? { UseCaseDescription: description } : {}),
            LlmParams: llmParams,
            AgentBuilderParams: agentBuilderParams
        }
    };
}
