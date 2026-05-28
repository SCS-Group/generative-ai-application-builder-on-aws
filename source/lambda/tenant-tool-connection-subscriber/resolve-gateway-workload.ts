// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BedrockAgentCoreControlClient, GetGatewayCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const control = new BedrockAgentCoreControlClient({});

export type GatewayOAuthContext = {
    /** Service-linked gateway id (deploy verification only). */
    gatewayId: string;
    /** Non–service-linked workload for USER_FEDERATION OAuth (GatewayName / gaab-mcp-{prefix}). */
    oauthWorkloadName: string;
};

export type GatewayOAuthResolveResult =
    | { ok: true; context: GatewayOAuthContext }
    | { ok: false; reason: 'missing_config' | 'missing_gateway' | 'get_gateway_failed'; message: string };

/** Prefix-only name. Matches MCP gateway companion workload (not service-linked GatewayId). */
export function gatewayWorkloadPrefixFromUseCaseId(mcpGatewayUseCaseId: string): string {
    const short = mcpGatewayUseCaseId.trim().substring(0, 8);
    return `gaab-mcp-${short}`;
}

type GatewayParamsFromConfig = {
    gatewayId?: string;
    gatewayName?: string;
};

async function gatewayParamsFromUseCaseConfig(mcpGatewayUseCaseId: string): Promise<GatewayParamsFromConfig | undefined> {
    const useCaseId = mcpGatewayUseCaseId.trim();
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
    const mcpParams = (config as Record<string, unknown>).MCPParams;
    if (!mcpParams || typeof mcpParams !== 'object' || Array.isArray(mcpParams)) {
        return undefined;
    }
    const gatewayParams = (mcpParams as Record<string, unknown>).GatewayParams;
    if (!gatewayParams || typeof gatewayParams !== 'object' || Array.isArray(gatewayParams)) {
        return undefined;
    }
    const gp = gatewayParams as Record<string, unknown>;
    const gatewayId = typeof gp.GatewayId === 'string' && gp.GatewayId.trim() ? gp.GatewayId.trim() : undefined;
    const gatewayName =
        typeof gp.GatewayName === 'string' && gp.GatewayName.trim() ? gp.GatewayName.trim() : undefined;
    return { gatewayId, gatewayName };
}

/**
 * Resolve MCP gateway OAuth binding workload.
 * Tokens must be stored on the companion workload (GatewayName), not the service-linked GatewayId workload.
 */
export async function resolveGatewayOAuthContext(
    mcpGatewayUseCaseId: string
): Promise<GatewayOAuthResolveResult> {
    const useCasesTable = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    const configTable = process.env[USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]?.trim();
    if (!useCasesTable || !configTable) {
        return {
            ok: false,
            reason: 'missing_config',
            message: 'GAAB OAuth subscriber is missing USE_CASES_TABLE_NAME or USE_CASE_CONFIG_TABLE_NAME.'
        };
    }

    const params = await gatewayParamsFromUseCaseConfig(mcpGatewayUseCaseId);
    const gatewayId = params?.gatewayId;
    const oauthWorkloadName = params?.gatewayName ?? gatewayWorkloadPrefixFromUseCaseId(mcpGatewayUseCaseId);

    if (!gatewayId) {
        return {
            ok: false,
            reason: 'missing_gateway',
            message:
                `MCP gateway use case ${mcpGatewayUseCaseId} has no GatewayId yet. Wait for gateway deploy to finish, then retry Connect.`
        };
    }

    try {
        await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
        return { ok: true, context: { gatewayId, oauthWorkloadName } };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('resolveGatewayOAuthContext get-gateway failed', gatewayId, e);
        return {
            ok: false,
            reason: 'get_gateway_failed',
            message: `Could not read MCP gateway ${gatewayId}: ${msg}`
        };
    }
}

/** @deprecated Use resolveGatewayOAuthContext */
export async function resolveGatewayWorkloadName(mcpGatewayUseCaseId: string): Promise<string | undefined> {
    const resolved = await resolveGatewayOAuthContext(mcpGatewayUseCaseId);
    return resolved.ok ? resolved.context.oauthWorkloadName : undefined;
}
