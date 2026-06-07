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
import { sanitizeCfnStackNameBase } from './sanitize-cfn-stack-name';
import { loadMcpSchemaUriMap, loadOAuthProviderMap } from './oauth-providers';
import {
    ACTIVE_STACK_STATUSES,
    DELETED_STACK_STATUSES,
    findUseCaseIdByName,
    getDeploymentProbe,
    IN_PROGRESS_STACK_STATUSES,
    waitForUseCaseReady,
    type UseCaseProbe
} from './provision-poll';
import { syncAgentRuntimeEnvFromConfig } from './sync-agent-runtime-env';
import { withPlatformAgentRuntimeDefaults } from './utils/platform-agent-runtime-env';
import { buildGithubRuntimeEnvVars, githubFieldsFromProvisionDetail } from './utils/github-runtime-env';
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
import {
    resolveSessionTierForProvision,
    sessionCommercialFromDetail
} from './session-commercial';

const PK = 'TenantId';

/** Leave headroom under the 15-minute Lambda timeout for cold start + deploy invokes. */
const PROVISION_WALL_CLOCK_BUDGET_MS = 840_000;

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
    let baseName: string;
    if (!merged.UseCaseName || typeof merged.UseCaseName !== 'string' || !merged.UseCaseName.trim()) {
        const label =
            (typeof detail.customerName === 'string' && detail.customerName.trim()) ||
            (typeof detail.organizationName === 'string' && detail.organizationName.trim()) ||
            tenantId.slice(0, 8);
        baseName = sanitizeCfnStackNameBase(`AIW-${label}`);
    } else {
        baseName = sanitizeCfnStackNameBase(merged.UseCaseName);
    }
    const instanceId =
        typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';
    merged.UseCaseName = agentUseCaseName(baseName, instanceId);
    return merged;
}

function agentUseCaseName(baseName: string, tenantTemplateInstanceId?: string): string {
    const base = sanitizeCfnStackNameBase(baseName.trim() || 'Agent');
    const instanceSuffix = tenantTemplateInstanceId?.trim().replace(/-/g, '').slice(0, 8);
    if (instanceSuffix) {
        return `${base}-${instanceSuffix}`.slice(0, 200);
    }
    return base.slice(0, 200);
}

function gatewayUseCaseName(agentUseCaseName: string, tenantTemplateInstanceId?: string): string {
    const base = sanitizeCfnStackNameBase(agentUseCaseName.trim() || 'Agent');
    const instanceSuffix = tenantTemplateInstanceId?.trim().replace(/-/g, '').slice(0, 8);
    if (instanceSuffix) {
        return `AIW-Tools-${base}-${instanceSuffix}`.slice(0, 200);
    }
    return `AIW-Tools-${base}`.slice(0, 200);
}

function remainingProvisionMs(provisionStartedAt: number): number {
    return Math.max(45_000, PROVISION_WALL_CLOCK_BUDGET_MS - (Date.now() - provisionStartedAt));
}

function isEmptyInstallGatewayShell(body: Record<string, unknown>): boolean {
    const mcpParams = body.MCPParams as Record<string, unknown> | undefined;
    const gatewayParams = mcpParams?.GatewayParams as Record<string, unknown> | undefined;
    const targetParams = gatewayParams?.TargetParams;
    return Array.isArray(targetParams) && targetParams.length === 0;
}

type ResumableDeploy =
    | { action: 'none' }
    | { action: 'resume'; useCaseId: string; probe: UseCaseProbe }
    | { action: 'removed'; message: string };

async function findResumableUseCase(
    useCaseName: string,
    tenantId: string,
    useCaseType: 'AgentBuilder' | 'MCPServer'
): Promise<ResumableDeploy> {
    const useCaseId = await findUseCaseIdByName(useCaseName, tenantId, { useCaseType });
    if (!useCaseId) {
        return { action: 'none' };
    }
    const probe = await getDeploymentProbe(useCaseId, useCaseName);
    if (DELETED_STACK_STATUSES.has(probe.status)) {
        // Stale row from a prior removal — start a fresh deploy instead of failing immediately.
        return { action: 'none' };
    }
    if (
        ACTIVE_STACK_STATUSES.has(probe.status) ||
        IN_PROGRESS_STACK_STATUSES.has(probe.status) ||
        !probe.status
    ) {
        return { action: 'resume', useCaseId, probe };
    }
    return { action: 'none' };
}

async function notifyProvisionStatus(
    detail: Record<string, unknown>,
    phase: 'provisioning_started' | 'stack_complete' | 'runtime_ready' | 'failed',
    opts?: {
        message?: string;
        gaabUseCaseId?: string;
        gaabMcpGatewayUseCaseId?: string;
        runtimeUiUrl?: string;
        agentRuntimeArn?: string;
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
            runtimeUiUrl: opts?.runtimeUiUrl,
            agentRuntimeArn: opts?.agentRuntimeArn
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

    const provisionStartedAt = Date.now();
    const agentFn = process.env[TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const mcpFn = process.env[TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR]!;
    const agentUseCaseName = String(deployBody.UseCaseName ?? '');
    let gaabMcpGatewayUseCaseId: string | undefined;

    const instanceId =
        typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';
    const providers = connectionsFromDevops(detail.devops);
    let emptyInstallGateway = false;
    if (providers.length > 0) {
        const gwName = gatewayUseCaseName(agentUseCaseName, instanceId);
        const existingGateway = await findResumableUseCase(gwName, tenantId, 'MCPServer');
        if (existingGateway.action === 'removed') {
            await notifyProvisionStatus(detail, 'failed', { message: existingGateway.message });
            return;
        }

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
            emptyInstallGateway = isEmptyInstallGatewayShell(built.body);
            if (existingGateway.action === 'resume') {
                gaabMcpGatewayUseCaseId = existingGateway.useCaseId;
                logger.info('Reusing existing MCP gateway deployment (idempotent provision)', {
                    gatewayUseCaseName: gwName,
                    gaabMcpGatewayUseCaseId,
                    stackStatus: existingGateway.probe.status || 'pending_stack_link'
                });
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
                        logger.warn(
                            'MCP gateway deploy accepted but use case id not found yet; agent deploy proceeds without gateway'
                        );
                    }
                }
            }
        }

        if (gaabMcpGatewayUseCaseId && !emptyInstallGateway) {
            const gatewayWaitMs = Math.min(120_000, remainingProvisionMs(provisionStartedAt));
            const gatewayUrl = await waitForGatewayUrl(gaabMcpGatewayUseCaseId, gatewayWaitMs);
            if (!gatewayUrl) {
                logger.warn('GatewayUrl not available before agent deploy; agent will deploy without MCP gateway', {
                    gaabMcpGatewayUseCaseId,
                    gatewayWaitMs
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
        } else if (gaabMcpGatewayUseCaseId && emptyInstallGateway) {
            const gwStackWaitMs = Math.min(300_000, remainingProvisionMs(provisionStartedAt));
            const gwStackReady = await waitForUseCaseReady(
                gaabMcpGatewayUseCaseId,
                gwStackWaitMs,
                15_000,
                gwName
            );
            if (!gwStackReady.ok) {
                await notifyProvisionStatus(detail, 'failed', {
                    message: `MCP gateway stack failed: ${gwStackReady.message}`,
                    gaabMcpGatewayUseCaseId
                });
                return;
            }
            logger.info('Install-mode empty gateway stack ready', {
                gaabMcpGatewayUseCaseId,
                stackStatus: gwStackReady.probe.status
            });
            const gatewayWaitMs = Math.min(120_000, remainingProvisionMs(provisionStartedAt));
            const gatewayUrl = await waitForGatewayUrl(gaabMcpGatewayUseCaseId, gatewayWaitMs);
            if (!gatewayUrl) {
                logger.warn('GatewayUrl not available after install-mode gateway ready; agent deploys without MCP gateway', {
                    gaabMcpGatewayUseCaseId,
                    gatewayWaitMs
                });
            } else {
                mergeAgentMcpServer(deployBody, {
                    useCaseId: gaabMcpGatewayUseCaseId,
                    useCaseName: gwName,
                    gatewayUrl
                });
                logger.info('Merged install-mode MCP gateway into agent MCPServers', {
                    gaabMcpGatewayUseCaseId,
                    gatewayUrl
                });
            }
        }
    }

    const runtimeEnv: Record<string, string> = withPlatformAgentRuntimeDefaults({
        ...(typeof deployBody.AgentRuntimeEnvVars === 'object' &&
        deployBody.AgentRuntimeEnvVars &&
        !Array.isArray(deployBody.AgentRuntimeEnvVars)
            ? (deployBody.AgentRuntimeEnvVars as Record<string, string>)
            : {}),
        AIW_TENANT_ID: tenantId
    });
    const { githubOwner, githubRepo } = githubFieldsFromProvisionDetail(detail);
    Object.assign(runtimeEnv, buildGithubRuntimeEnvVars({ tenantId, githubOwner, githubRepo }));
    const sessionStamp = sessionCommercialFromDetail(detail);
    if (sessionStamp) {
        const tier = resolveSessionTierForProvision(detail, sessionStamp);
        const includedFromDetail = Number(detail.includedSessionsPerMonth);
        const included =
            Number.isFinite(includedFromDetail) && includedFromDetail > 0
                ? Math.round(includedFromDetail)
                : tier?.includedSessionsPerMonth;
        if (included && included > 0) {
            runtimeEnv.AIW_SESSION_INCLUDED_PER_MONTH = String(included);
            runtimeEnv.AIW_SESSION_BILLING_MODEL_ID = sessionStamp.modelId;
            if (typeof detail.agentTemplateId === 'string' && detail.agentTemplateId.trim()) {
                runtimeEnv.AIW_AGENT_TEMPLATE_ID = detail.agentTemplateId.trim();
            }
            if (tier?.tierId) {
                runtimeEnv.AIW_SESSION_TIER_ID = tier.tierId;
            }
        }
    }
    if (gaabMcpGatewayUseCaseId) {
        runtimeEnv.AIW_MCP_GATEWAY_USE_CASE_ID = gaabMcpGatewayUseCaseId;
        runtimeEnv.AIW_OAUTH_WORKLOAD_NAME = gatewayWorkloadPrefixFromUseCaseId(gaabMcpGatewayUseCaseId);
    }
    deployBody.AgentRuntimeEnvVars = runtimeEnv;

    const existingAgent = await findResumableUseCase(agentUseCaseName, tenantId, 'AgentBuilder');
    if (existingAgent.action === 'removed') {
        await notifyProvisionStatus(detail, 'failed', {
            message: existingAgent.message,
            gaabMcpGatewayUseCaseId
        });
        return;
    }

    let gaabUseCaseId: string | undefined;
    if (existingAgent.action === 'resume') {
        gaabUseCaseId = existingAgent.useCaseId;
        logger.info('Reusing existing agent deployment (idempotent provision)', {
            agentUseCaseName,
            gaabUseCaseId,
            stackStatus: existingAgent.probe.status || 'pending_stack_link'
        });
    } else {
        const agentInvoke = await invokeDeployApi(agentFn, '/deployments/agents', deployBody);
        if (!agentInvoke.ok) {
            logger.error('Agent deployment invoke failed', { message: agentInvoke.message });
            await notifyProvisionStatus(detail, 'failed', {
                message: agentInvoke.message,
                gaabMcpGatewayUseCaseId
            });
            return;
        }

        gaabUseCaseId = await resolveUseCaseIdByName(agentUseCaseName, tenantId, 'AgentBuilder');
        if (!gaabUseCaseId) {
            await notifyProvisionStatus(detail, 'failed', {
                message: 'Agent deployment was accepted but the new use case could not be found. Check GAAB Deployments.',
                gaabMcpGatewayUseCaseId
            });
            return;
        }
    }

    await notifyProvisionStatus(detail, 'stack_complete', {
        gaabUseCaseId,
        gaabMcpGatewayUseCaseId
    });

    const agentPollMs = remainingProvisionMs(provisionStartedAt);
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

    let agentRuntimeArn: string | undefined;
    try {
        const syncResult = await syncAgentRuntimeEnvFromConfig(gaabUseCaseId);
        agentRuntimeArn = syncResult.agentRuntimeArn;
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
        runtimeUiUrl,
        agentRuntimeArn
    });
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
