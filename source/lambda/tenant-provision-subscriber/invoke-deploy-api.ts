// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { customAwsConfig } from 'aws-node-user-agent-config';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR } from './utils/constants';

const lambdaClient = new LambdaClient(customAwsConfig());

export function syntheticDeployEvent(path: string, body: Record<string, unknown>): APIGatewayProxyEvent {
    const systemUser = process.env[TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR] ?? 'system:aiw-tenant-provision';
    return {
        resource: path,
        path,
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
        body: JSON.stringify(body),
        isBase64Encoded: false
    };
}

export async function invokeDeployApi(
    functionName: string,
    path: string,
    body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; message: string }> {
    const payload = syntheticDeployEvent(path, body);
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
                ? parsed.body.slice(0, 500)
                : `Deployment API returned HTTP ${parsed.statusCode}.`;
        return { ok: false, message: bodyMsg };
    }

    return { ok: true };
}
