// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeEvent } from 'aws-lambda';
import {
    BedrockAgentCoreControlClient,
    CreateGatewayTargetCommand,
    ListGatewaysCommand,
    ListGatewayTargetsCommand,
    UpdateGatewayTargetCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ensureAgentMcpGatewayInConfig } from './ensure-agent-mcp-gateway';
import { ensureGatewayApiKeyPolicy } from './gateway-openapi-policy';
import { handleTenantGithubCredentialUpdated } from './github-credential-sync';
import { handleTenantGithubWorkspaceUninstalled } from './github-workspace-uninstall';
import { syncGithubRuntimeEnvAfterInstall } from './sync-github-runtime-env';

type InstallRequestedDetail = {
    correlationId: string;
    tenantTemplateInstanceId: string;
    tenantId: string;
    gaabUseCaseId?: string;
    gaabMcpGatewayUseCaseId: string;
    providerKey: string;
    mcpTargetName: string;
    oauthProviderName: string;
    scopes: string[];
    version?: string;
    // Custom MCP tool (BYO OpenAPI + API key) payload (v2).
    customOpenApiSpecText?: string;
    customApiKeyProviderArn?: string;
    customCredentialLocation?: 'HEADER' | 'QUERY_PARAMETER';
    customCredentialParameterName?: string;
    customCredentialPrefix?: string;
    /** Discord preset: channel baked into OpenAPI; vault stores full `Bot <token>` header value. */
    customDiscordChannelId?: string;
    /** Public.com preset: account id baked into OpenAPI paths; vault stores Bearer access token. */
    customPublicBrokerAccountId?: string;
    /** GitHub preset: owner/repo baked into OpenAPI paths; vault stores Bearer PAT. */
    customGithubOwner?: string;
    customGithubRepo?: string;
    /** Jira preset: site URL baked into server; vault stores Basic auth header. */
    customJiraSiteUrl?: string;
    customJiraUserEmail?: string;
    /** Slack preset: channel id in tool description; vault stores Bearer bot token. */
    customSlackChannelId?: string;
};

function isDiscordCustomInstall(detail: InstallRequestedDetail): boolean {
    const channelId = detail.customDiscordChannelId?.trim();
    if (channelId) return true;
    const spec = detail.customOpenApiSpecText ?? '';
    return spec.includes('discord.com/api/v10');
}

function isPublicBrokerCustomInstall(detail: InstallRequestedDetail): boolean {
    const spec = detail.customOpenApiSpecText ?? '';
    return spec.includes('api.public.com') && spec.includes('userapigateway');
}

function isGithubCustomInstall(detail: InstallRequestedDetail): boolean {
    if (detail.customGithubOwner?.trim() && detail.customGithubRepo?.trim()) return true;
    const spec = detail.customOpenApiSpecText ?? '';
    return spec.includes('api.github.com') && spec.includes('github_create_pull');
}

function isJiraCustomInstall(detail: InstallRequestedDetail): boolean {
    if (detail.customJiraSiteUrl?.trim()) return true;
    const spec = detail.customOpenApiSpecText ?? '';
    return spec.includes('/rest/api/3/') && spec.includes('jira_get_issue');
}

function isSlackCustomInstall(detail: InstallRequestedDetail): boolean {
    if (detail.customSlackChannelId?.trim()) return true;
    const spec = detail.customOpenApiSpecText ?? '';
    return spec.includes('slack.com/api') && spec.includes('slack_post_message');
}

function isFullHeaderVaultPreset(detail: InstallRequestedDetail): boolean {
    return (
        isDiscordCustomInstall(detail) ||
        isPublicBrokerCustomInstall(detail) ||
        isGithubCustomInstall(detail) ||
        isJiraCustomInstall(detail) ||
        isSlackCustomInstall(detail)
    );
}

function buildApiKeyCredentialProvider(detail: InstallRequestedDetail) {
    const base = {
        providerArn: detail.customApiKeyProviderArn!,
        credentialLocation: (detail.customCredentialLocation || 'HEADER') as 'HEADER' | 'QUERY_PARAMETER',
        credentialParameterName: detail.customCredentialParameterName || 'Authorization'
    };
    if (isFullHeaderVaultPreset(detail)) {
        return base;
    }
    const prefix = detail.customCredentialPrefix?.trim();
    return prefix ? { ...base, credentialPrefix: prefix } : base;
}

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

async function ensureCustomApiKeyGatewayPolicy(
    gatewayId: string,
    targetName: string,
    providerArn: string | undefined
): Promise<void> {
    const arn = providerArn?.trim();
    if (!arn) return;
    try {
        await ensureGatewayApiKeyPolicy({ gatewayId, targetName, providerArn: arn });
        console.info('Gateway API key policy ensured', targetName, arn);
    } catch (policyErr) {
        const msg = policyErr instanceof Error ? policyErr.message : String(policyErr);
        console.error('Gateway API key policy failed', targetName, msg);
        throw policyErr;
    }
}

export const handler = async (event: EventBridgeEvent<string, unknown>) => {
    if (event['detail-type'] === 'TenantGithubCredentialUpdated') {
        await handleTenantGithubCredentialUpdated(event);
        return;
    }
    if (event['detail-type'] === 'TenantGithubWorkspaceUninstalled') {
        await handleTenantGithubWorkspaceUninstalled(event);
        return;
    }

    const d = parseDetail(event.detail);
    const detail: InstallRequestedDetail = {
        correlationId: typeof d.correlationId === 'string' ? d.correlationId.trim() : '',
        tenantTemplateInstanceId: typeof d.tenantTemplateInstanceId === 'string' ? d.tenantTemplateInstanceId.trim() : '',
        tenantId: typeof d.tenantId === 'string' ? d.tenantId.trim() : '',
        gaabUseCaseId: typeof d.gaabUseCaseId === 'string' ? d.gaabUseCaseId.trim() : undefined,
        gaabMcpGatewayUseCaseId: typeof d.gaabMcpGatewayUseCaseId === 'string' ? d.gaabMcpGatewayUseCaseId.trim() : '',
        providerKey: typeof d.providerKey === 'string' ? d.providerKey.trim() : '',
        mcpTargetName: typeof d.mcpTargetName === 'string' ? d.mcpTargetName.trim() : '',
        oauthProviderName: typeof d.oauthProviderName === 'string' ? d.oauthProviderName.trim() : '',
        scopes: Array.isArray(d.scopes) ? d.scopes.filter((s): s is string => typeof s === 'string') : [],
        version: typeof d.version === 'string' ? d.version.trim() : undefined,
        customOpenApiSpecText: typeof (d as any).customOpenApiSpecText === 'string' ? (d as any).customOpenApiSpecText : undefined,
        customApiKeyProviderArn: typeof (d as any).customApiKeyProviderArn === 'string' ? (d as any).customApiKeyProviderArn : undefined,
        customCredentialLocation:
            typeof (d as any).customCredentialLocation === 'string'
                ? ((d as any).customCredentialLocation as any)
                : undefined,
        customCredentialParameterName:
            typeof (d as any).customCredentialParameterName === 'string'
                ? (d as any).customCredentialParameterName
                : undefined,
        customCredentialPrefix:
            typeof (d as any).customCredentialPrefix === 'string' ? (d as any).customCredentialPrefix : undefined,
        customDiscordChannelId:
            typeof (d as any).customDiscordChannelId === 'string' ? (d as any).customDiscordChannelId.trim() : undefined,
        customPublicBrokerAccountId:
            typeof (d as any).customPublicBrokerAccountId === 'string'
                ? (d as any).customPublicBrokerAccountId.trim()
                : undefined,
        customGithubOwner:
            typeof (d as any).customGithubOwner === 'string' ? (d as any).customGithubOwner.trim() : undefined,
        customGithubRepo:
            typeof (d as any).customGithubRepo === 'string' ? (d as any).customGithubRepo.trim() : undefined,
        customJiraSiteUrl:
            typeof (d as any).customJiraSiteUrl === 'string' ? (d as any).customJiraSiteUrl.trim() : undefined,
        customJiraUserEmail:
            typeof (d as any).customJiraUserEmail === 'string' ? (d as any).customJiraUserEmail.trim() : undefined,
        customSlackChannelId:
            typeof (d as any).customSlackChannelId === 'string' ? (d as any).customSlackChannelId.trim() : undefined
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
        const callbackUrl = requiredEnv('AIW_OAUTH_CALLBACK_URL');

        const isCustom = Boolean(detail.customOpenApiSpecText?.trim()) && Boolean(detail.customApiKeyProviderArn?.trim());
        let effectiveSchemaKey = schemaKey;
        let oauthArn = '';
        if (!isCustom) {
            oauthArn = oauthByName[detail.oauthProviderName]?.credentialProviderArn?.trim() ?? '';
            if (!effectiveSchemaKey) {
                throw new Error(`No OpenAPI schema key configured for target "${detail.mcpTargetName}"`);
            }
            if (!oauthArn) {
                throw new Error(`No credentialProviderArn configured for oauthProviderName "${detail.oauthProviderName}"`);
            }
        } else {
            const specText = detail.customOpenApiSpecText!.trim();
            if (specText.length > 220_000) {
                throw new Error('Custom OpenAPI spec too large.');
            }
            // Upload custom spec under deployments bucket so CreateGatewayTarget can reference S3 URI.
            const uuid = detail.providerKey.replace(/^custom:/, '').slice(0, 36) || detail.correlationId.slice(0, 36);
            effectiveSchemaKey = `mcp/schemas/openApiSchema/custom/${uuid}.yaml`;
            const s3 = new S3Client({});
            await s3.send(
                new PutObjectCommand({
                    Bucket: deploymentsBucket,
                    Key: effectiveSchemaKey,
                    Body: specText,
                    ContentType: 'application/yaml'
                })
            );
        }

        const { gatewayId } = await resolveGatewayId(detail.gaabMcpGatewayUseCaseId);
        const control = new BedrockAgentCoreControlClient({});

        const s3Uri = `s3://${deploymentsBucket}/${(effectiveSchemaKey ?? '').replace(/^\/+/, '')}`;
        const existing = await control.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId, maxResults: 100 }));
        const existingTarget = (existing.items ?? []).find((t) => (t.name ?? '').trim() === detail.mcpTargetName);
        const hasTarget = Boolean(existingTarget);
        if (hasTarget) {
            console.info('Integration install skipped: target already exists', detail.mcpTargetName, gatewayId);
            if (isCustom) {
                await ensureCustomApiKeyGatewayPolicy(gatewayId, detail.mcpTargetName, detail.customApiKeyProviderArn);
                const targetId = (existingTarget as { targetId?: string }).targetId?.trim();
                if (targetId && isFullHeaderVaultPreset(detail)) {
                    const apiKeyCredentialProvider = buildApiKeyCredentialProvider(detail);
                    await control.send(
                        new UpdateGatewayTargetCommand({
                            gatewayIdentifier: gatewayId,
                            targetId,
                            name: detail.mcpTargetName,
                            targetConfiguration: { mcp: { openApiSchema: { s3: { uri: s3Uri } } } },
                            credentialProviderConfigurations: [
                                {
                                    credentialProviderType: 'API_KEY',
                                    credentialProvider: { apiKeyCredentialProvider }
                                }
                            ]
                        })
                    );
                    console.info('Custom MCP gateway target credentials repaired (no credentialPrefix)', detail.mcpTargetName);
                }
            }
            if (detail.gaabUseCaseId) {
                try {
                    await ensureAgentMcpGatewayInConfig({
                        agentUseCaseId: detail.gaabUseCaseId,
                        gatewayUseCaseId: detail.gaabMcpGatewayUseCaseId
                    });
                } catch (patchErr) {
                    const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
                    console.warn('Agent MCPServers patch failed after existing target', patchMsg);
                }
            }
            if (isGithubCustomInstall(detail)) {
                await syncGithubRuntimeEnvAfterInstall(detail);
            }
            await emitResult({
                correlationId: detail.correlationId,
                tenantTemplateInstanceId: detail.tenantTemplateInstanceId,
                providerKey: detail.providerKey,
                ok: true,
                message: 'Target already installed'
            });
            return;
        }

        const apiKeyCredentialProvider = buildApiKeyCredentialProvider(detail);
        await control.send(
            new CreateGatewayTargetCommand({
                gatewayIdentifier: gatewayId,
                name: detail.mcpTargetName,
                description: `${detail.providerKey} (AIW installed)`,
                targetConfiguration: { mcp: { openApiSchema: { s3: { uri: s3Uri } } } },
                credentialProviderConfigurations: isCustom
                    ? [
                          {
                              credentialProviderType: 'API_KEY',
                              credentialProvider: {
                                  apiKeyCredentialProvider
                              }
                          }
                      ]
                    : [
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

        if (isCustom) {
            await ensureCustomApiKeyGatewayPolicy(gatewayId, detail.mcpTargetName, detail.customApiKeyProviderArn);
        }

        console.info('Integration install succeeded', detail.mcpTargetName, gatewayId);

        if (detail.gaabUseCaseId) {
            try {
                const patch = await ensureAgentMcpGatewayInConfig({
                    agentUseCaseId: detail.gaabUseCaseId,
                    gatewayUseCaseId: detail.gaabMcpGatewayUseCaseId
                });
                if (patch.patched) {
                    console.info('Agent MCPServers patched after integration install', {
                        agentUseCaseId: detail.gaabUseCaseId,
                        gatewayUseCaseId: detail.gaabMcpGatewayUseCaseId
                    });
                } else if (patch.reason) {
                    console.warn('Agent MCPServers patch skipped', patch.reason);
                }
            } catch (patchErr) {
                const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
                console.warn('Agent MCPServers patch failed (install still succeeded)', patchMsg);
            }
        } else {
            console.warn('Install event missing gaabUseCaseId; agent MCPServers not patched');
        }

        if (isGithubCustomInstall(detail)) {
            await syncGithubRuntimeEnvAfterInstall(detail);
        }

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

