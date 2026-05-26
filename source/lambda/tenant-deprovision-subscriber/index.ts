// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { customAwsConfig } from 'aws-node-user-agent-config';
import middy from '@middy/core';
import { APIGatewayProxyEvent, APIGatewayProxyResult, EventBridgeEvent } from 'aws-lambda';
import {
    REQUIRED_ENV_VARS,
    TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR,
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

function syntheticDeleteEvent(useCaseId: string): APIGatewayProxyEvent {
    const systemUser =
        process.env[TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR] ?? 'system:aiw-tenant-deprovision';
    return {
        resource: '/deployments/agents/{useCaseId}',
        path: `/deployments/agents/${useCaseId}`,
        httpMethod: 'DELETE',
        headers: {},
        multiValueHeaders: {},
        queryStringParameters: { permanent: 'true' },
        multiValueQueryStringParameters: null,
        pathParameters: { useCaseId },
        stageVariables: null,
        requestContext: {
            accountId: '',
            apiId: '',
            authorizer: { UserId: systemUser },
            protocol: 'HTTP/1.1',
            httpMethod: 'DELETE',
            path: `/deployments/agents/${useCaseId}`,
            stage: '',
            requestId: '',
            requestTimeEpoch: Date.now(),
            resourceId: '',
            resourcePath: '/deployments/agents/{useCaseId}',
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
        body: null,
        isBase64Encoded: false
    };
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
    if (!gaabUseCaseId) {
        logger.error('TenantDeprovisionRequested missing gaabUseCaseId');
        return;
    }

    const fnName = process.env[TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const payload = syntheticDeleteEvent(gaabUseCaseId);

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
        logger.error('Agent Lambda returned non-JSON payload on delete', { raw: raw.slice(0, 500) });
        return;
    }

    if (parsed?.statusCode && parsed.statusCode >= 400) {
        logger.error('Agent deployment delete invoke failed', {
            gaabUseCaseId,
            statusCode: parsed.statusCode,
            body: parsed.body
        });
        return;
    }

    logger.info('Tenant use case delete accepted', {
        gaabUseCaseId,
        tenantTemplateInstanceId: detail.tenantTemplateInstanceId
    });
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
