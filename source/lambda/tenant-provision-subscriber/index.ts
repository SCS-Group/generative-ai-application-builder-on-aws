// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { AWSClientManager } from 'aws-sdk-lib';
import middy from '@middy/core';
import { APIGatewayProxyEvent, APIGatewayProxyResult, EventBridgeEvent } from 'aws-lambda';
import {
    REQUIRED_ENV_VARS,
    TENANTS_TABLE_NAME_ENV_VAR,
    TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR
} from './utils/constants';
import { emitTenantProvisionStatus } from './emit-provision-status';
import { findUseCaseIdByName, waitForUseCaseReady } from './provision-poll';
import { deployRequestBodyFromDevops } from './utils/parse-devops';
import { logger, tracer } from './power-tools-init';

const PK = 'TenantId';

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
const lambdaClient = new LambdaClient(customAwsConfig());
tracer.captureAWSv3Client(lambdaClient);

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

function syntheticApiGatewayEvent(body: Record<string, unknown>): APIGatewayProxyEvent {
    const systemUser =
        process.env[TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR] ?? 'system:aiw-tenant-provision';
    return {
        resource: '/deployments/agents',
        path: '/deployments/agents',
        httpMethod: 'POST',
        headers: {},
        multiValueHeaders: {},
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        pathParameters: null,
        stageVariables: null,
        requestContext: {
            accountId: '',
            apiId: '',
            authorizer: { UserId: systemUser },
            protocol: 'HTTP/1.1',
            httpMethod: 'POST',
            path: '/deployments/agents',
            stage: '',
            requestId: '',
            requestTimeEpoch: Date.now(),
            resourceId: '',
            resourcePath: '/deployments/agents',
            identity: {
                accessKey: null,
                accountId: null,
                apiKey: null,
                apiKeyId: null,
                caller: null,
                clientCert: null,
                cognitoAuthenticationProvider: null,
                cognitoAuthenticationType: null,
                cognitoIdentityId: null,
                cognitoIdentityPoolId: null,
                principalOrgId: null,
                sourceIp: '',
                user: null,
                userAgent: null,
                userArn: null
            }
        } as APIGatewayProxyEvent['requestContext'],
        body: JSON.stringify(body),
        isBase64Encoded: false
    };
}

async function notifyProvisionStatus(
    detail: Record<string, unknown>,
    phase: 'provisioning_started' | 'stack_complete' | 'runtime_ready' | 'failed',
    opts?: { message?: string; gaabUseCaseId?: string; runtimeUiUrl?: string }
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
            runtimeUiUrl: opts?.runtimeUiUrl
        });
    } catch (e) {
        logger.error('Failed to emit TenantProvisionStatus', { phase, error: e });
    }
}

export const lambdaHandler = async (event: EventBridgeEvent<string, unknown>) => {
    checkEnv();
    const detail = parseDetail(event.detail);
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

    const fnName = process.env[TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const payload = syntheticApiGatewayEvent(deployBody);

    const out = await lambdaClient.send(
        new InvokeCommand({
            FunctionName: fnName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(payload), 'utf8')
        })
    );

    const raw = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
    let parsed: APIGatewayProxyResult | undefined;
    try {
        parsed = raw ? (JSON.parse(raw) as APIGatewayProxyResult) : undefined;
    } catch {
        logger.error('Agent Lambda returned non-JSON payload', { raw: raw.slice(0, 500) });
        await notifyProvisionStatus(detail, 'failed', {
            message: 'Deployment API returned an invalid response.'
        });
        return;
    }

    if (parsed && parsed.statusCode && parsed.statusCode >= 400) {
        logger.error('Agent deployment invoke failed', { statusCode: parsed.statusCode, body: parsed.body });
        const bodyMsg =
            typeof parsed.body === 'string' && parsed.body.trim()
                ? parsed.body.slice(0, 500)
                : `Deployment API returned HTTP ${parsed.statusCode}.`;
        await notifyProvisionStatus(detail, 'failed', { message: bodyMsg });
        return;
    }

    const useCaseName = String(deployBody.UseCaseName ?? '');
    const tenantIdForLookup = typeof deployBody.TenantId === 'string' ? deployBody.TenantId : '';
    let useCaseId: string | undefined;
    for (let attempt = 0; attempt < 12 && !useCaseId; attempt++) {
        if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 5000));
        }
        try {
            useCaseId = await findUseCaseIdByName(useCaseName, tenantIdForLookup);
        } catch (e) {
            logger.warn('Could not list deployments to resolve use case id', {
                useCaseName,
                tenantId: tenantIdForLookup,
                error: e
            });
        }
    }

    if (!useCaseId) {
        await notifyProvisionStatus(detail, 'failed', {
            message: 'Deployment was accepted but the new use case could not be found. Check GAAB Deployments.'
        });
        return;
    }

    await notifyProvisionStatus(detail, 'stack_complete', { gaabUseCaseId: useCaseId });

    const ready = await waitForUseCaseReady(useCaseId);
    if (!ready.ok) {
        await notifyProvisionStatus(detail, 'failed', {
            message: ready.message,
            gaabUseCaseId: useCaseId
        });
        return;
    }

    const runtimeUiUrl = ready.probe.cloudFrontWebUrl;
    await notifyProvisionStatus(detail, 'runtime_ready', {
        gaabUseCaseId: useCaseId,
        runtimeUiUrl
    });
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
