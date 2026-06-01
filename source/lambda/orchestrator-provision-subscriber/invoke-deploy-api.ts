// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { customAwsConfig } from 'aws-node-user-agent-config';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR } from './utils/constants';
import { extractDeployApiErrorMessage } from './extract-deploy-api-error';

const lambdaClient = new LambdaClient(customAwsConfig());

export function syntheticApiEvent(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>
): APIGatewayProxyEvent {
    const systemUser = process.env[TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR] ?? 'system:aiw-orchestrator-provision';
    return {
        resource: path,
        path,
        httpMethod: method,
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
            httpMethod: method,
            path,
            stage: '',
            requestId: '',
            requestTimeEpoch: Date.now(),
            resourceId: '',
            resourcePath: path,
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
        body: body ? JSON.stringify(body) : null,
        isBase64Encoded: false
    };
}

export async function invokeDeployApi(
    functionName: string,
    path: string,
    body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; message: string }> {
    const payload = syntheticApiEvent('POST', path, body);
    const out = await lambdaClient.send(
        new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(payload), 'utf8')
        })
    );

    const raw = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
    if (out.FunctionError) {
        const msg =
            typeof raw === 'string' && raw.trim()
                ? raw.slice(0, 500)
                : `Deployment Lambda failed (${out.FunctionError}).`;
        return { ok: false, message: msg };
    }

    let parsed: APIGatewayProxyResult | undefined;
    try {
        parsed = raw ? (JSON.parse(raw) as APIGatewayProxyResult) : undefined;
    } catch {
        return { ok: false, message: 'Deployment API returned an invalid response.' };
    }

    if (parsed && parsed.statusCode && parsed.statusCode >= 400) {
        const bodyMsg =
            typeof parsed.body === 'string' && parsed.body.trim()
                ? extractDeployApiErrorMessage(parsed.body, parsed.statusCode)
                : `Deployment API returned HTTP ${parsed.statusCode}.`;
        return { ok: false, message: bodyMsg };
    }

    return { ok: true };
}

export async function invokePermanentDeleteWorkflow(
    functionName: string,
    useCaseId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
    const path = `/deployments/workflows/${useCaseId}`;
    const payload = syntheticApiEvent('DELETE', path);
    payload.queryStringParameters = { permanent: 'true' };

    const out = await lambdaClient.send(
        new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(payload), 'utf8')
        })
    );

    const raw = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
    if (out.FunctionError) {
        return {
            ok: false,
            message: raw?.slice(0, 500) || `Delete Lambda failed (${out.FunctionError}).`
        };
    }

    let parsed: APIGatewayProxyResult | undefined;
    try {
        parsed = raw ? (JSON.parse(raw) as APIGatewayProxyResult) : undefined;
    } catch {
        return { ok: false, message: 'Delete API returned an invalid response.' };
    }

    if (parsed && parsed.statusCode && parsed.statusCode >= 400) {
        const bodyMsg =
            typeof parsed.body === 'string' && parsed.body.trim()
                ? extractDeployApiErrorMessage(parsed.body, parsed.statusCode)
                : `Delete API returned HTTP ${parsed.statusCode}.`;
        return { ok: false, message: bodyMsg };
    }

    return { ok: true };
}
