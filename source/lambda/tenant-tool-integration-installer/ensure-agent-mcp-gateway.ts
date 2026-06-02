// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const USE_CASES_TABLE_NAME_ENV_VAR = 'USE_CASES_TABLE_NAME';
const USE_CASE_CONFIG_TABLE_NAME_ENV_VAR = 'USE_CASE_CONFIG_TABLE_NAME';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function getGatewayUrlForUseCase(useCaseId: string): Promise<string | undefined> {
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
    const configKey = typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey.trim() : '';
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

function gatewayUseCaseName(useCaseId: string): string {
    return `gaab-mcp-${useCaseId.slice(0, 8)}`;
}

function mergeMcpGateway(
    agentParams: Record<string, unknown>,
    gateway: { useCaseId: string; useCaseName: string; gatewayUrl: string }
): boolean {
    const existing = Array.isArray(agentParams.MCPServers) ? [...(agentParams.MCPServers as unknown[])] : [];
    const already = existing.some((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
        return (row as Record<string, unknown>).UseCaseId === gateway.useCaseId;
    });
    if (already) {
        return false;
    }

    const withoutSameGateway = existing.filter((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
        const id = (row as Record<string, unknown>).UseCaseId;
        return id !== gateway.useCaseId;
    });
    withoutSameGateway.push({
        Type: 'gateway',
        UseCaseId: gateway.useCaseId,
        UseCaseName: gateway.useCaseName,
        Url: gateway.gatewayUrl
    });
    agentParams.MCPServers = withoutSameGateway;
    return true;
}

/**
 * Install-mode agents may deploy before GatewayUrl is ready, leaving MCPServers empty.
 * Patch the stored AgentBuilder config so MCP tool discovery (Discord, etc.) works on the next chat turn.
 */
export async function ensureAgentMcpGatewayInConfig(opts: {
    agentUseCaseId: string;
    gatewayUseCaseId: string;
}): Promise<{ patched: boolean; reason?: string }> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        return { patched: false, reason: 'DDB table env vars not configured on installer' };
    }

    const agentUseCaseId = opts.agentUseCaseId.trim();
    const gatewayUseCaseId = opts.gatewayUseCaseId.trim();
    if (!agentUseCaseId || !gatewayUseCaseId) {
        return { patched: false, reason: 'missing agent or gateway use case id' };
    }

    const gatewayUrl = await getGatewayUrlForUseCase(gatewayUseCaseId);
    if (!gatewayUrl) {
        return { patched: false, reason: `GatewayUrl not found for ${gatewayUseCaseId}` };
    }

    const useCaseRow = await ddb.send(
        new GetCommand({
            TableName: useCasesTable,
            Key: { UseCaseId: agentUseCaseId },
            ProjectionExpression: 'UseCaseConfigRecordKey'
        })
    );
    const configKey =
        typeof useCaseRow.Item?.UseCaseConfigRecordKey === 'string'
            ? useCaseRow.Item.UseCaseConfigRecordKey.trim()
            : '';
    if (!configKey) {
        return { patched: false, reason: `No UseCaseConfigRecordKey for agent ${agentUseCaseId}` };
    }

    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: configTable,
            Key: { key: configKey }
        })
    );
    const config = cfgRow.Item?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { patched: false, reason: 'Agent use case config missing or invalid' };
    }

    const configObj = { ...(config as Record<string, unknown>) };
    const agentBuilderParams =
        configObj.AgentBuilderParams && typeof configObj.AgentBuilderParams === 'object' && !Array.isArray(configObj.AgentBuilderParams)
            ? { ...(configObj.AgentBuilderParams as Record<string, unknown>) }
            : {};
    configObj.AgentBuilderParams = agentBuilderParams;

    const merged = mergeMcpGateway(agentBuilderParams, {
        useCaseId: gatewayUseCaseId,
        useCaseName: gatewayUseCaseName(gatewayUseCaseId),
        gatewayUrl
    });
    if (!merged) {
        return { patched: false, reason: 'MCPServers already includes tenant gateway' };
    }

    await ddb.send(
        new PutCommand({
            TableName: configTable,
            Item: {
                ...cfgRow.Item,
                key: configKey,
                config: configObj
            }
        })
    );

    console.info('Patched agent MCPServers with tenant MCP gateway', {
        agentUseCaseId,
        gatewayUseCaseId,
        gatewayUrl
    });
    return { patched: true };
}
