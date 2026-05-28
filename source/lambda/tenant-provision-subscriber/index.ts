// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AWSClientManager } from 'aws-sdk-lib';
import middy from '@middy/core';
import { EventBridgeEvent } from 'aws-lambda';
import { buildGatewayDeployBody, mergeAgentMcpServer } from './build-gateway-deploy';
import { gatewayWorkloadPrefixFromUseCaseId } from './resolve-gateway-workload';
import { applyPlatformDeployFields } from './platform-deploy-fields';
import { emitTenantProvisionStatus } from './emit-provision-status';
import { invokeDeployApi } from './invoke-deploy-api';
import { loadMcpSchemaUriMap, loadOAuthProviderMap } from './oauth-providers';
import { findUseCaseIdByName, getDeploymentProbe, waitForUseCaseReady } from './provision-poll';
import { syncAgentRuntimeEnvFromConfig } from './sync-agent-runtime-env';
import { waitForGatewayUrl } from './provision-use-case-config';
import { logger, tracer } from './power-tools-init';
import { connectionsFromDevops } from './utils/connections';
import {
    REQUIRED_ENV_VARS,
    TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR,
    TENANTS_TABLE_NAME_ENV_VAR
} from './utils/constants';
import { deployRequestBodyFromDevops } from './utils/parse-devops';

const PK = 'TenantId';

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));

function checkEnv() {
    const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

function tableName(): string {
    return process.env[TENANTS_TABLE_NAME_ENV_VAR]!;
}

function parseDetail(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    return {};
}

async function upsertTenantFromDetail(detail: Record<string, unknown>) {
    const tenantId = typeof detail.tenantId === 'string' ? detail.tenantId.trim() : '';
    if (!tenantId) {
        return;
    }
    const now = new Date().toISOString();
    const existing = await ddb.send(
        new GetCommand({
            TableName: tableName(),
            Key: { [PK]: tenantId }
        })
    );
    const prev = existing.Item as Record<string, unknown> | undefined;
    const createdAt = prev && typeof prev.CreatedAt === 'string' ? String(prev.CreatedAt) : now;

    const item: Record<string, unknown> = {
        [PK]: tenantId,
        Source: 'aiw',
        UpdatedAt: now,
        CreatedAt: createdAt
    };
    if (typeof detail.organizationName === 'string') item.OrganizationName = detail.organizationName;
    if (typeof detail.customerName === 'string') item.CustomerName = detail.customerName;
    if (typeof detail.tenantAdminEmail === 'string') item.TenantAdminEmail = detail.tenantAdminEmail;
    if (typeof detail.tenantTemplateInstanceId === 'string') {
        item.TenantTemplateInstanceId = detail.tenantTemplateInstanceId;
    }

    await ddb.send(
        new PutCommand({
            TableName: tableName(),
            Item: item
        })
    );
}

function deployBodyFromDetail(detail: Record<string, unknown>, tenantId: string): Record<string, unknown> | undefined {
    const template = deployRequestBodyFromDevops(detail.devops);
    if (!template) {
        return undefined;
    }
    const merged: Record<string, unknown> = {
        ...template,
        TenantId: tenantId,
        UseCaseType: 'AgentBuilder'
    };
    if (!merged.UseCaseName || typeof merged.UseCaseName !== 'string' || !merged.UseCaseName.trim()) {
        const label =
            (typeof detail.customerName === 'string' && detail.customerName.trim()) ||
            (typeof detail.organizationName === 'string' && detail.organizationName.trim()) ||
            tenantId.slice(0, 8);
        merged.UseCaseName = `AIW ${label}`.slice(0, 200);
    }
    return merged;
}

function gatewayUseCaseName(agentUseCaseName: string): string {
    const base = agentUseCaseName.trim() || 'Agent';
    // MCP stacks enforce CloudFormation stack-name constraints. Use a safe, deterministic name to avoid
    // ValidationError on stack creation (spaces and punctuation are not allowed).
    const safe = base
        .replace(/[^a-zA-Z0-9-]/g, '-') // replace spaces/punct with dashes
        .replace(/-+/g, '-') // collapse
        .replace(/^-+|-+$/g, ''); // trim dashes
    const normalized = safe || 'Agent';
    // Must start with a letter for CFN pattern: [a-zA-Z][-a-zA-Z0-9]*
    const startsOk = /^[a-zA-Z]/.test(normalized) ? normalized : `A${normalized}`;
    return `AIW-Tools-${startsOk}`.slice(0, 200);
}

async function notifyProvisionStatus(
    detail: Record<string, unknown>,
    phase: 'provisioning_started' | 'stack_complete' | 'runtime_ready' | 'failed',
    opts?: {
        message?: string;
        gaabUseCaseId?: string;
        gaabMcpGatewayUseCaseId?: string;
        runtimeUiUrl?: string;
    }
): Promise<void> {
    const instanceId =
        typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';
    if (!instanceId) {
        return;
    }
    try {
        await emitTenantProvisionStatus({
            tenantTemplateInstanceId: instanceId,
            phase,
            message: opts?.message,
            gaabUseCaseId: opts?.gaabUseCaseId,
            gaabMcpGatewayUseCaseId: opts?.gaabMcpGatewayUseCaseId,
            runtimeUiUrl: opts?.runtimeUiUrl
        });
    } catch (e) {
        logger.error('Failed to emit TenantProvisionStatus', { phase, error: e });
    }
}

async function resolveUseCaseIdByName(
    useCaseName: string,
    tenantId: string,
    useCaseType: 'AgentBuilder' | 'MCPServer'
): Promise<string | undefined> {
    for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 5000));
        }
        try {
            const id = await findUseCaseIdByName(useCaseName, tenantId, { useCaseType });
            if (id) {
                return id;
            }
        } catch (e) {
            logger.warn('Could not list deployments to resolve use case id', {
                useCaseName,
                tenantId,
                useCaseType,
                error: e
            });
        }
    }
    return undefined;
}

export const lambdaHandler = async (event: EventBridgeEvent<string, unknown>) => {
    checkEnv();
    const detail = parseDetail(event.detail);
    try {
        await runTenantProvision(detail);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('Tenant provision worker failed', { error: e });
        await notifyProvisionStatus(detail, 'failed', {
            message: msg || 'Provision worker failed unexpectedly.'
        });
    }
};

async function runTenantProvision(detail: Record<string, unknown>) {
    if (String(detail.version) !== '2') {
        logger.warn('Skipping TenantProvisionRequested: expected detail.version "2"');
        return;
    }
    const tenantId = typeof detail.tenantId === 'string' ? detail.tenantId.trim() : '';
    if (!tenantId) {
        logger.error('TenantProvisionRequested missing tenantId');
        await notifyProvisionStatus(detail, 'failed', { message: 'Missing tenant id in provision request.' });
        return;
    }

    await upsertTenantFromDetail(detail);

    const deployBody = deployBodyFromDetail(detail, tenantId);
    if (!deployBody) {
        const msg =
            'Template is missing deploy configuration. In GAAB Templates, complete Agent configuration (Generate JSON) and republish.';
        logger.error('TenantProvisionRequested missing devops.gaab.provisioning.deployRequestBody');
        await notifyProvisionStatus(detail, 'failed', { message: msg });
        return;
    }

    await notifyProvisionStatus(detail, 'provisioning_started');

    const agentFn = process.env[TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const mcpFn = process.env[TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR]!;
    const agentUseCaseName = String(deployBody.UseCaseName ?? '');
    let gaabMcpGatewayUseCaseId: string | undefined;

    const providers = connectionsFromDevops(detail.devops);
    if (providers.length > 0) {
        const gwName = gatewayUseCaseName(agentUseCaseName);
        const built = buildGatewayDeployBody({
            tenantId,
            gatewayUseCaseName: gwName,
            providers,
            oauthProviderMap: loadOAuthProviderMap(),
            schemaUriByTargetName: loadMcpSchemaUriMap()
        });

        if (!built.ok) {
            logger.warn(
                'MCP gateway not deployed (missing OpenAPI schema keys or OAuth ARNs in SSM); agent deploy continues without gateway. See ToolConnectionMcpSchemaUris + TOOL_CONNECTION_OAUTH_PROVIDERS_JSON.',
                { message: built.message }
            );
        } else {
            applyPlatformDeployFields(built.body, deployBody);
            logger.info('Deploying per-tenant MCP gateway (Phase 1)', {
                gatewayUseCaseName: gwName,
                existingRestApiId: built.body.ExistingRestApiId,
                targetCount: (
                    (built.body.MCPParams as Record<string, unknown>)?.GatewayParams as Record<
                        string,
                        unknown
                    >
                )?.TargetParams
            });
        const gwInvoke = await invokeDeployApi(mcpFn, '/deployments/mcp', built.body);
        if (!gwInvoke.ok) {
            logger.warn('MCP gateway deployment failed; continuing with agent-only deploy', {
                message: gwInvoke.message
            });
        } else {

        gaabMcpGatewayUseCaseId = await resolveUseCaseIdByName(gwName, tenantId, 'MCPServer');
        if (!gaabMcpGatewayUseCaseId) {
            logger.warn('MCP gateway deploy accepted but use case id not found yet; agent deploy proceeds without gateway');
        } else {
            const gatewayUrl = await waitForGatewayUrl(gaabMcpGatewayUseCaseId, 300_000);
            if (!gatewayUrl) {
                logger.warn('GatewayUrl not available before agent deploy; agent will deploy without MCP gateway', {
                    gaabMcpGatewayUseCaseId
                });
            } else {
                mergeAgentMcpServer(deployBody, {
                    useCaseId: gaabMcpGatewayUseCaseId,
                    useCaseName: gwName,
                    gatewayUrl
                });
                logger.info('Merged tenant MCP gateway into agent MCPServers', {
                    gaabMcpGatewayUseCaseId,
                    gatewayUrl
                });
            }
        }
        }
        }
    }

    const runtimeEnv: Record<string, string> = {
        ...(typeof deployBody.AgentRuntimeEnvVars === 'object' &&
        deployBody.AgentRuntimeEnvVars &&
        !Array.isArray(deployBody.AgentRuntimeEnvVars)
            ? (deployBody.AgentRuntimeEnvVars as Record<string, string>)
            : {}),
        AIW_TENANT_ID: tenantId
    };
    if (gaabMcpGatewayUseCaseId) {
        runtimeEnv.AIW_MCP_GATEWAY_USE_CASE_ID = gaabMcpGatewayUseCaseId;
        runtimeEnv.AIW_OAUTH_WORKLOAD_NAME = gatewayWorkloadPrefixFromUseCaseId(gaabMcpGatewayUseCaseId);
    }
    deployBody.AgentRuntimeEnvVars = runtimeEnv;

    const agentInvoke = await invokeDeployApi(agentFn, '/deployments/agents', deployBody);
    if (!agentInvoke.ok) {
        logger.error('Agent deployment invoke failed', { message: agentInvoke.message });
        await notifyProvisionStatus(detail, 'failed', {
            message: agentInvoke.message,
            gaabMcpGatewayUseCaseId
        });
        return;
    }

    const gaabUseCaseId = await resolveUseCaseIdByName(agentUseCaseName, tenantId, 'AgentBuilder');
    if (!gaabUseCaseId) {
        await notifyProvisionStatus(detail, 'failed', {
            message: 'Agent deployment was accepted but the new use case could not be found. Check GAAB Deployments.',
            gaabMcpGatewayUseCaseId
        });
        return;
    }

    await notifyProvisionStatus(detail, 'stack_complete', {
        gaabUseCaseId,
        gaabMcpGatewayUseCaseId
    });

    const agentPollMs = providers.length > 0 ? 600_000 : 840_000;
    const ready = await waitForUseCaseReady(gaabUseCaseId, agentPollMs, 20_000, agentUseCaseName);
    const finalProbe = ready.ok ? ready.probe : await getDeploymentProbe(gaabUseCaseId, agentUseCaseName);
    const stackComplete =
        ready.ok ||
        finalProbe.status === 'CREATE_COMPLETE' ||
        finalProbe.status === 'UPDATE_COMPLETE';
    if (!stackComplete) {
        await notifyProvisionStatus(detail, 'failed', {
            message: ready.ok ? 'Deployment status could not be confirmed.' : ready.message,
            gaabUseCaseId,
            gaabMcpGatewayUseCaseId
        });
        return;
    }

    try {
        await syncAgentRuntimeEnvFromConfig(gaabUseCaseId);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('syncAgentRuntimeEnv failed after stack complete', { gaabUseCaseId, error: msg });
        await notifyProvisionStatus(detail, 'failed', {
            message: `Agent stack is up but runtime sync failed: ${msg}. Redeploy DeploymentPlatformStack and retry provision.`,
            gaabUseCaseId,
            gaabMcpGatewayUseCaseId
        });
        return;
    }

    const runtimeUiUrl = finalProbe.cloudFrontWebUrl;
    await notifyProvisionStatus(detail, 'runtime_ready', {
        gaabUseCaseId,
        gaabMcpGatewayUseCaseId,
        runtimeUiUrl
    });
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
