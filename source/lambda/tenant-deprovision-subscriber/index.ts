// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { customAwsConfig } from 'aws-node-user-agent-config';
import middy from '@middy/core';
import { EventBridgeEvent } from 'aws-lambda';
import { runTenantDeprovision } from './run-tenant-deprovision';
import {
    PolicyEngineDeleteBlockedError,
    teardownWorkspacePolicyEngine
} from './teardown-workspace-policy-engine';
import { clearWorkspaceAgentCorePolicyFromUseCase } from './clear-workspace-agentcore-policy';
import { emitPolicyDetachStatus } from './emit-policy-detach-status';
import {
    REQUIRED_ENV_VARS,
    TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR
} from './utils/constants';
import { logger, tracer } from './power-tools-init';

const lambdaClient = new LambdaClient(customAwsConfig());
tracer.captureAWSv3Client(lambdaClient);

function checkEnv() {
    const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
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

export const lambdaHandler = async (event: EventBridgeEvent<string, unknown>) => {
    checkEnv();
    const detail = parseDetail(event.detail);

    if (event['detail-type'] === 'TenantPolicyDetachRequested') {
        if (String(detail.version) !== '1') {
            logger.warn('Skipping TenantPolicyDetachRequested: expected detail.version "1"');
            return;
        }
        const tenantTemplateInstanceId =
            typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';
        if (!tenantTemplateInstanceId) {
            logger.error('TenantPolicyDetachRequested missing tenantTemplateInstanceId');
            return;
        }
        const gaabMcpGatewayUseCaseId =
            typeof detail.gaabMcpGatewayUseCaseId === 'string' ? detail.gaabMcpGatewayUseCaseId.trim() : '';
        const gaabUseCaseId = typeof detail.gaabUseCaseId === 'string' ? detail.gaabUseCaseId.trim() : '';
        try {
            await emitPolicyDetachStatus({
                tenantTemplateInstanceId,
                phase: 'policy_detach_started',
                gaabUseCaseId: gaabUseCaseId || undefined,
                gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
            });
            await teardownWorkspacePolicyEngine({
                tenantTemplateInstanceId,
                gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
            });
            if (gaabUseCaseId) {
                await clearWorkspaceAgentCorePolicyFromUseCase(gaabUseCaseId);
            }
            await emitPolicyDetachStatus({
                tenantTemplateInstanceId,
                phase: 'policy_detach_complete',
                gaabUseCaseId: gaabUseCaseId || undefined,
                gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (e instanceof PolicyEngineDeleteBlockedError) {
                logger.warn('Policy engine delete blocked; completing logical detach', {
                    tenantTemplateInstanceId,
                    policyEngineId: e.policyEngineId,
                    message
                });
                if (gaabUseCaseId) {
                    await clearWorkspaceAgentCorePolicyFromUseCase(gaabUseCaseId);
                }
                await emitPolicyDetachStatus({
                    tenantTemplateInstanceId,
                    phase: 'policy_detach_complete',
                    message:
                        'Policy detached from workspace. AgentCore policy engine could not be deleted yet and may require cleanup after gateway removal.',
                    gaabUseCaseId: gaabUseCaseId || undefined,
                    gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
                });
                return;
            }
            logger.warn('TenantPolicyDetachRequested failed', {
                tenantTemplateInstanceId,
                message
            });
            await emitPolicyDetachStatus({
                tenantTemplateInstanceId,
                phase: 'policy_detach_failed',
                message,
                gaabUseCaseId: gaabUseCaseId || undefined,
                gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
            });
            throw e;
        }
        return;
    }

    if (event['detail-type'] === 'TenantPolicyEngineTeardownRequested') {
        if (String(detail.version) !== '1') {
            logger.warn('Skipping TenantPolicyEngineTeardownRequested: expected detail.version "1"');
            return;
        }
        const tenantTemplateInstanceId =
            typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';
        if (!tenantTemplateInstanceId) {
            logger.error('TenantPolicyEngineTeardownRequested missing tenantTemplateInstanceId');
            return;
        }
        const gaabMcpGatewayUseCaseId =
            typeof detail.gaabMcpGatewayUseCaseId === 'string' ? detail.gaabMcpGatewayUseCaseId.trim() : '';
        const gaabUseCaseId = typeof detail.gaabUseCaseId === 'string' ? detail.gaabUseCaseId.trim() : '';
        try {
            await teardownWorkspacePolicyEngine({
                tenantTemplateInstanceId,
                gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
            });
            if (gaabUseCaseId) {
                await clearWorkspaceAgentCorePolicyFromUseCase(gaabUseCaseId);
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn('TenantPolicyEngineTeardownRequested failed', {
                tenantTemplateInstanceId,
                message
            });
            throw e;
        }
        return;
    }

    if (String(detail.version) !== '1') {
        logger.warn('Skipping TenantDeprovisionRequested: expected detail.version "1"');
        return;
    }

    const gaabUseCaseId = typeof detail.gaabUseCaseId === 'string' ? detail.gaabUseCaseId.trim() : '';
    const gaabMcpGatewayUseCaseId =
        typeof detail.gaabMcpGatewayUseCaseId === 'string' ? detail.gaabMcpGatewayUseCaseId.trim() : '';
    const tenantTemplateInstanceId =
        typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';

    if (!gaabUseCaseId && !gaabMcpGatewayUseCaseId) {
        logger.error('TenantDeprovisionRequested missing gaabUseCaseId and gaabMcpGatewayUseCaseId');
        return;
    }

    if (!tenantTemplateInstanceId) {
        logger.error('TenantDeprovisionRequested missing tenantTemplateInstanceId');
        return;
    }

    const systemUser =
        process.env[TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR] ?? 'system:aiw-tenant-deprovision';
    const agentFn = process.env[TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const mcpFn = process.env[TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR]!;

    await runTenantDeprovision(lambdaClient, agentFn, mcpFn, systemUser, {
        tenantTemplateInstanceId,
        gaabUseCaseId: gaabUseCaseId || undefined,
        gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
    });
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
