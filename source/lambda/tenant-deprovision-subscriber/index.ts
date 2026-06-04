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
