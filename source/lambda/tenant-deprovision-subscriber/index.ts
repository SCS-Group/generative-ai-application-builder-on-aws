// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { customAwsConfig } from 'aws-node-user-agent-config';
import middy from '@middy/core';
import { EventBridgeEvent } from 'aws-lambda';
import { invokePermanentDeleteUseCase } from './invoke-delete-use-case';
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

    const gaabUseCaseId =
        typeof detail.gaabUseCaseId === 'string' ? detail.gaabUseCaseId.trim() : '';
    const gaabMcpGatewayUseCaseId =
        typeof detail.gaabMcpGatewayUseCaseId === 'string' ? detail.gaabMcpGatewayUseCaseId.trim() : '';

    if (!gaabUseCaseId && !gaabMcpGatewayUseCaseId) {
        logger.error('TenantDeprovisionRequested missing gaabUseCaseId and gaabMcpGatewayUseCaseId');
        return;
    }

    const systemUser =
        process.env[TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR] ?? 'system:aiw-tenant-deprovision';
    const agentFn = process.env[TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const mcpFn = process.env[TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR]!;
    const instanceId = detail.tenantTemplateInstanceId;

    if (gaabUseCaseId) {
        const agentDelete = await invokePermanentDeleteUseCase(
            lambdaClient,
            agentFn,
            'agents',
            gaabUseCaseId,
            systemUser
        );
        if (!agentDelete.ok) {
            logger.error('Agent deployment delete invoke failed', {
                gaabUseCaseId,
                tenantTemplateInstanceId: instanceId,
                statusCode: agentDelete.statusCode,
                body: agentDelete.body
            });
        } else {
            logger.info('Agent use case delete accepted', {
                gaabUseCaseId,
                tenantTemplateInstanceId: instanceId
            });
        }
    }

    if (gaabMcpGatewayUseCaseId) {
        const mcpDelete = await invokePermanentDeleteUseCase(
            lambdaClient,
            mcpFn,
            'mcp',
            gaabMcpGatewayUseCaseId,
            systemUser
        );
        if (!mcpDelete.ok) {
            logger.error('MCP gateway delete invoke failed', {
                gaabMcpGatewayUseCaseId,
                tenantTemplateInstanceId: instanceId,
                statusCode: mcpDelete.statusCode,
                body: mcpDelete.body
            });
        } else {
            logger.info('MCP gateway use case delete accepted', {
                gaabMcpGatewayUseCaseId,
                tenantTemplateInstanceId: instanceId
            });
        }
    }
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
