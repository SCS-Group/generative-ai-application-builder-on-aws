// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConnectionProviderDefinition } from './utils/connections';
import type { OAuthProviderConfig } from './oauth-providers';

export type GatewayDeployBuildResult =
    | { ok: true; body: Record<string, unknown>; useCaseName: string }
    | { ok: false; message: string };

export function buildGatewayDeployBody(opts: {
    tenantId: string;
    gatewayUseCaseName: string;
    providers: ConnectionProviderDefinition[];
    oauthProviderMap: Record<string, OAuthProviderConfig>;
    schemaUriByTargetName: Record<string, string>;
}): GatewayDeployBuildResult {
    const targetParams: Record<string, unknown>[] = [];
    const missing: string[] = [];

    for (const p of opts.providers) {
        if (p.attachMode !== 'prewired' || p.mcpTargetType !== 'openApiSchema') {
            continue;
        }
        const oauth = opts.oauthProviderMap[p.oauthProviderName];
        if (!oauth?.credentialProviderArn) {
            missing.push(`oauth:${p.oauthProviderName}`);
            continue;
        }
        const schemaUri = opts.schemaUriByTargetName[p.mcpTargetName];
        if (!schemaUri) {
            missing.push(`schema:${p.mcpTargetName}`);
            continue;
        }
        targetParams.push({
            TargetName: p.mcpTargetName,
            TargetDescription: `${p.displayName} (AIW prewired)`,
            TargetType: 'openApiSchema',
            SchemaUri: schemaUri,
            OutboundAuthParams: {
                OutboundAuthProviderArn: oauth.credentialProviderArn,
                OutboundAuthProviderType: 'OAUTH',
                AdditionalConfigParams: {
                    OAuthAdditionalConfig: {
                        scopes: p.requiredScopes,
                        ...(process.env.AIW_OAUTH_CALLBACK_URL?.trim()
                            ? { defaultReturnUrl: process.env.AIW_OAUTH_CALLBACK_URL.trim() }
                            : {})
                    }
                }
            }
        });
    }

    if (targetParams.length === 0) {
        const hint =
            missing.length > 0
                ? ` Missing: ${missing.join(', ')}. Set TOOL_CONNECTION_OAUTH_PROVIDERS_JSON and TOOL_CONNECTION_MCP_SCHEMA_URIS_JSON (S3 keys under deployments bucket).`
                : ' No prewired openApiSchema providers in template connections.';
        return { ok: false, message: `Cannot deploy MCP gateway:${hint}` };
    }

    return {
        ok: true,
        useCaseName: opts.gatewayUseCaseName,
        body: {
            UseCaseType: 'MCPServer',
            UseCaseName: opts.gatewayUseCaseName,
            UseCaseDescription: 'Per-tenant tool gateway (AIW)',
            TenantId: opts.tenantId,
            MCPParams: {
                GatewayParams: {
                    TargetParams: targetParams
                }
            }
        }
    };
}

export function mergeAgentMcpServer(
    agentDeployBody: Record<string, unknown>,
    gateway: { useCaseId: string; useCaseName: string; gatewayUrl: string }
): void {
    const agentParams =
        agentDeployBody.AgentParams && typeof agentDeployBody.AgentParams === 'object' && !Array.isArray(agentDeployBody.AgentParams)
            ? (agentDeployBody.AgentParams as Record<string, unknown>)
            : {};
    agentDeployBody.AgentParams = agentParams;

    const existing = Array.isArray(agentParams.MCPServers) ? [...(agentParams.MCPServers as unknown[])] : [];
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
}
