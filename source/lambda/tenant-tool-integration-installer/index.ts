// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeEvent } from 'aws-lambda';
import { BedrockAgentCoreControlClient, CreateGatewayTargetCommand, ListGatewaysCommand, ListGatewayTargetsCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

type InstallRequestedDetail = {
    correlationId: string;
    tenantTemplateInstanceId: string;
    tenantId: string;
    gaabMcpGatewayUseCaseId: string;
    providerKey: string;
    mcpTargetName: string;
    oauthProviderName: string;
    scopes: string[];
};

function parseDetail(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    return {};
}

function requiredEnv(name: string): string {
    const v = process.env[name]?.trim() ?? '';
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

function jsonMap(envName: string): Record<string, { credentialProviderArn?: string } | string> {
    const raw = process.env[envName]?.trim() ?? '';
    if (!raw) return {};
    try {
        const v = JSON.parse(raw) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
    } catch {
        // ignore
    }
    return {};
}

async function emitResult(detail: {
    correlationId: string;
    tenantTemplateInstanceId: string;
    providerKey: string;
    ok: boolean;
    message?: string;
}): Promise<void> {
    const bus = requiredEnv('EVENT_BUS_NAME');
    const eb = new EventBridgeClient({});
    await eb.send(
        new PutEventsCommand({
            Entries: [
                {
                    EventBusName: bus,
                    Source: 'gaab.tenant',
                    DetailType: 'TenantToolIntegrationInstalled',
                    Detail: JSON.stringify({ version: '1', ...detail })
                }
            ]
        })
    );
}

async function resolveGatewayId(gaabMcpGatewayUseCaseId: string): Promise<{ gatewayId: string; gatewayName: string }> {
    const prefix = gaabMcpGatewayUseCaseId.slice(0, 8);
    const expectedName = `gaab-mcp-${prefix}`;
    const control = new BedrockAgentCoreControlClient({});
    const out = await control.send(new ListGatewaysCommand({ maxResults: 50 }));
    const items = (out.items ?? []) as Array<{ gatewayId?: string; name?: string }>;
    const match = items.find((g) => (g.name ?? '').trim() === expectedName);
    if (!match?.gatewayId) {
        throw new Error(`Gateway not found for ${gaabMcpGatewayUseCaseId} (expected name ${expectedName})`);
    }
    return { gatewayId: match.gatewayId, gatewayName: expectedName };
}

export const handler = async (event: EventBridgeEvent<string, unknown>) => {
    const d = parseDetail(event.detail);
    const detail: InstallRequestedDetail = {
        correlationId: typeof d.correlationId === 'string' ? d.correlationId.trim() : '',
        tenantTemplateInstanceId: typeof d.tenantTemplateInstanceId === 'string' ? d.tenantTemplateInstanceId.trim() : '',
        tenantId: typeof d.tenantId === 'string' ? d.tenantId.trim() : '',
        gaabMcpGatewayUseCaseId: typeof d.gaabMcpGatewayUseCaseId === 'string' ? d.gaabMcpGatewayUseCaseId.trim() : '',
        providerKey: typeof d.providerKey === 'string' ? d.providerKey.trim() : '',
        mcpTargetName: typeof d.mcpTargetName === 'string' ? d.mcpTargetName.trim() : '',
        oauthProviderName: typeof d.oauthProviderName === 'string' ? d.oauthProviderName.trim() : '',
        scopes: Array.isArray(d.scopes) ? d.scopes.filter((s): s is string => typeof s === 'string') : []
    };

    if (!detail.correlationId || !detail.tenantTemplateInstanceId || !detail.providerKey || !detail.gaabMcpGatewayUseCaseId) {
        console.warn('TenantToolIntegrationInstallRequested missing required fields', JSON.stringify(d));
        return;
    }

    try {
        const deploymentsBucket = requiredEnv('DEPLOYMENTS_BUCKET_NAME');
        const schemaByTarget = jsonMap('TOOL_CONNECTION_MCP_SCHEMA_URIS_JSON') as Record<string, string>;
        const oauthByName = jsonMap('TOOL_CONNECTION_OAUTH_PROVIDERS_JSON') as Record<
            string,
            { credentialProviderArn?: string }
        >;
        const schemaKey = schemaByTarget[detail.mcpTargetName];
        const oauthArn = oauthByName[detail.oauthProviderName]?.credentialProviderArn?.trim() ?? '';
        const callbackUrl = requiredEnv('AIW_OAUTH_CALLBACK_URL');

        if (!schemaKey) {
            throw new Error(`No OpenAPI schema key configured for target "${detail.mcpTargetName}"`);
        }
        if (!oauthArn) {
            throw new Error(`No credentialProviderArn configured for oauthProviderName "${detail.oauthProviderName}"`);
        }

        const { gatewayId } = await resolveGatewayId(detail.gaabMcpGatewayUseCaseId);
        const control = new BedrockAgentCoreControlClient({});

        const existing = await control.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId, maxResults: 100 }));
        const hasTarget = (existing.items ?? []).some((t) => (t.name ?? '').trim() === detail.mcpTargetName);
        if (hasTarget) {
            console.info('Integration install skipped: target already exists', detail.mcpTargetName, gatewayId);
            await emitResult({
                correlationId: detail.correlationId,
                tenantTemplateInstanceId: detail.tenantTemplateInstanceId,
                providerKey: detail.providerKey,
                ok: true,
                message: 'Target already installed'
            });
            return;
        }

        const s3Uri = `s3://${deploymentsBucket}/${schemaKey.replace(/^\/+/, '')}`;
        await control.send(
            new CreateGatewayTargetCommand({
                gatewayIdentifier: gatewayId,
                name: detail.mcpTargetName,
                description: `${detail.providerKey} (AIW installed)`,
                targetConfiguration: { mcp: { openApiSchema: { s3: { uri: s3Uri } } } },
                credentialProviderConfigurations: [
                    {
                        credentialProviderType: 'OAUTH',
                        credentialProvider: {
                            oauthCredentialProvider: {
                                providerArn: oauthArn,
                                grantType: 'AUTHORIZATION_CODE',
                                scopes: detail.scopes,
                                defaultReturnUrl: callbackUrl
                            }
                        }
                    }
                ]
            })
        );

        console.info('Integration install succeeded', detail.mcpTargetName, gatewayId);
        await emitResult({
            correlationId: detail.correlationId,
            tenantTemplateInstanceId: detail.tenantTemplateInstanceId,
            providerKey: detail.providerKey,
            ok: true,
            message: 'Installed'
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('Integration install failed', msg);
        await emitResult({
            correlationId: detail.correlationId,
            tenantTemplateInstanceId: detail.tenantTemplateInstanceId,
            providerKey: detail.providerKey,
            ok: false,
            message: msg
        });
    }
};

