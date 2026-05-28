// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { customAwsConfig } from './lib/custom-aws-config';
import { AWSClientManager } from './lib/aws-client-manager';
import {
    TEMPLATE_TEST_AGENT_FUNCTION_NAME_ENV_VAR,
    TEMPLATE_TEST_SYSTEM_USER_ID_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR,
    ACTIVE_STACK_STATUSES,
    FAILED_STACK_STATUSES,
    TESTING_DEPLOY_ACTIVE,
    TESTING_DEPLOY_FAILED
} from './utils/constants';
import { logger, tracer } from './power-tools-init';

const lambdaClient = new LambdaClient(customAwsConfig());
tracer.captureAWSv3Client(lambdaClient);

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
const cfn = new CloudFormationClient(customAwsConfig());
tracer.captureAWSv3Client(cfn);

export function deployRequestBodyFromDevops(devops: Record<string, unknown>): Record<string, unknown> | undefined {
    const gaab = devops.gaab as Record<string, unknown> | undefined;
    const provisioning = gaab?.provisioning as Record<string, unknown> | undefined;
    const body = provisioning?.deployRequestBody as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
        return undefined;
    }
    return { ...body, UseCaseType: 'AgentBuilder' };
}

function syntheticEvent(
    method: string,
    resource: string,
    path: string,
    body?: Record<string, unknown>
): APIGatewayProxyEvent {
    const systemUser = process.env[TEMPLATE_TEST_SYSTEM_USER_ID_ENV_VAR] ?? 'system:template-testing';
    return {
        resource,
        path,
        httpMethod: method,
        headers: {},
        multiValueHeaders: {},
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        pathParameters: resource.includes('{useCaseId}')
            ? { useCaseId: path.split('/').pop() }
            : null,
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
            resourcePath: resource,
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

async function invokeAgent(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const fnName = process.env[TEMPLATE_TEST_AGENT_FUNCTION_NAME_ENV_VAR]!;
    const out = await lambdaClient.send(
        new InvokeCommand({
            FunctionName: fnName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(event), 'utf8')
        })
    );
    const raw = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
    if (!raw) {
        throw new Error('Agent management Lambda returned an empty response.');
    }
    return JSON.parse(raw) as APIGatewayProxyResult;
}

export async function findUseCaseIdByName(name: string): Promise<string | undefined> {
    const table = process.env[USE_CASES_TABLE_NAME_ENV_VAR]!;
    let startKey: Record<string, unknown> | undefined;
    do {
        const out = await ddb.send(
            new ScanCommand({
                TableName: table,
                FilterExpression: '#n = :n',
                ExpressionAttributeNames: { '#n': 'Name' },
                ExpressionAttributeValues: { ':n': name },
                ExclusiveStartKey: startKey,
                ProjectionExpression: 'UseCaseId, #n',
                Limit: 25
            })
        );
        const hit = (out.Items ?? []).find((i) => String(i.Name) === name);
        if (hit && typeof hit.UseCaseId === 'string') {
            return hit.UseCaseId;
        }
        startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return undefined;
}

export type UseCaseProbe = {
    status: string;
    cloudFrontWebUrl?: string;
    deployUI?: string;
};

/** Matches use-case-management stack naming ({UseCaseName}-{first8OfUseCaseId}). */
export function expectedAgentStackName(useCaseName: string, useCaseId: string): string {
    const name = useCaseName.trim();
    const shortUUID = useCaseId.trim().substring(0, 8);
    return `${name}-${shortUUID}`;
}

async function describeStackByName(stackName: string): Promise<CfnStackSummary> {
    try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = out.Stacks?.[0];
        const cloudFrontWebUrl = stack?.Outputs?.find((o) => o.OutputKey === 'CloudFrontWebUrl')?.OutputValue;
        return {
            stackStatus: stack?.StackStatus,
            stackStatusReason: stack?.StackStatusReason,
            cloudFrontWebUrl: cloudFrontWebUrl?.trim() || undefined
        };
    } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === 'ValidationError' && /does not exist/i.test(err.message)) {
            return {
                stackStatus: 'STACK_DELETED',
                stackStatusReason:
                    'CloudFormation stack was removed (often automatic rollback after a failed create — not the Publish step).'
            };
        }
        logger.warn('describeStackByName failed', { stackName, message: err.message });
        return {};
    }
}

/**
 * Poll deployment status via DDB StackId + CloudFormation (same as tenant provision worker).
 * Does not call agent-management GET — that route requires a user Authorization header.
 */
export async function getDeploymentProbe(useCaseId: string, useCaseName?: string): Promise<UseCaseProbe> {
    const fromRecord = await describeUseCaseStack(useCaseId);
    if (fromRecord.stackStatus) {
        return {
            status: fromRecord.stackStatus,
            cloudFrontWebUrl: fromRecord.cloudFrontWebUrl
        };
    }
    const name = useCaseName?.trim();
    if (!name) {
        return { status: '' };
    }
    const byName = await describeStackByName(expectedAgentStackName(name, useCaseId));
    return {
        status: byName.stackStatus ?? '',
        cloudFrontWebUrl: byName.cloudFrontWebUrl
    };
}

export async function getUseCaseProbe(useCaseId: string, useCaseName?: string): Promise<UseCaseProbe> {
    return getDeploymentProbe(useCaseId, useCaseName);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForUseCaseReady(
    useCaseId: string,
    maxWaitMs = 600_000,
    intervalMs = 20_000
): Promise<{ deployStatus: typeof TESTING_DEPLOY_ACTIVE | typeof TESTING_DEPLOY_FAILED; probe: UseCaseProbe; message?: string }> {
    const deadline = Date.now() + maxWaitMs;
    let lastStatus = '';
    while (Date.now() < deadline) {
        try {
            const probe = await getUseCaseProbe(useCaseId);
            lastStatus = probe.status;
            if (ACTIVE_STACK_STATUSES.has(lastStatus)) {
                return { deployStatus: TESTING_DEPLOY_ACTIVE, probe };
            }
            if (FAILED_STACK_STATUSES.has(lastStatus)) {
                return {
                    deployStatus: TESTING_DEPLOY_FAILED,
                    probe,
                    message: `Stack status: ${lastStatus}`
                };
            }
        } catch (e) {
            logger.warn('Poll test deployment status failed', { useCaseId, error: e });
        }
        await sleep(intervalMs);
    }
    return {
        deployStatus: TESTING_DEPLOY_FAILED,
        probe: { status: lastStatus },
        message: `Timed out waiting for deployment (last status: ${lastStatus || 'unknown'}).`
    };
}

export function buildTestUseCaseName(slug: string, templateId: string): string {
    const suffix = templateId.replace(/-/g, '').slice(0, 8);
    const base = `tpl-test-${slug}-${suffix}`;
    return base.slice(0, 200);
}

export async function deployTestStack(deployBody: Record<string, unknown>): Promise<void> {
    const event = syntheticEvent('POST', '/deployments/agents', '/deployments/agents', deployBody);
    const res = await invokeAgent(event);
    if (res.statusCode && res.statusCode >= 400) {
        throw new Error(
            typeof res.body === 'string' && res.body.trim()
                ? res.body.slice(0, 500)
                : `Test deployment failed (HTTP ${res.statusCode}).`
        );
    }
    if (res.statusCode && res.statusCode >= 300) {
        throw new Error(`Test deployment returned HTTP ${res.statusCode}.`);
    }
}

export async function resolveUseCaseIdAfterDeploy(useCaseName: string): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
        const id = await findUseCaseIdByName(useCaseName);
        if (id) {
            return id;
        }
        await sleep(5000);
    }
    throw new Error('Test deployment started but use case record was not found. Try again in a minute.');
}

export async function deleteTestStack(useCaseId: string): Promise<void> {
    const event = syntheticEvent(
        'DELETE',
        '/deployments/agents/{useCaseId}',
        `/deployments/agents/${useCaseId}`
    );
    event.queryStringParameters = { permanent: 'true' };
    const res = await invokeAgent(event);
    if (res.statusCode && res.statusCode >= 400) {
        if (res.statusCode === 404) {
            return;
        }
        const body =
            typeof res.body === 'string' && res.body.trim() ? res.body.slice(0, 500) : '';
        if (/not found/i.test(body)) {
            return;
        }
        const msg = body || `Failed to delete test stack (HTTP ${res.statusCode}).`;
        throw new Error(msg);
    }
}

export function stackNameFromArn(stackArn: string): string | undefined {
    const parts = stackArn.split('/');
    const idx = parts.indexOf('stack');
    if (idx >= 0 && parts[idx + 1]) {
        return parts[idx + 1];
    }
    return undefined;
}

export type CfnStackSummary = {
    stackStatus?: string;
    stackStatusReason?: string;
    cloudFrontWebUrl?: string;
};

/** Reads UseCases table + CloudFormation — detects rollback/delete (not template publish teardown). */
export async function describeUseCaseStack(useCaseId: string, useCaseName?: string): Promise<CfnStackSummary> {
    const table = process.env[USE_CASES_TABLE_NAME_ENV_VAR]!;
    const row = await ddb.send(
        new GetCommand({
            TableName: table,
            Key: { UseCaseId: useCaseId }
        })
    );
    const stackArn = typeof row.Item?.StackId === 'string' ? row.Item.StackId : '';
    if (stackArn) {
        const stackName = stackNameFromArn(stackArn);
        if (stackName) {
            const summary = await describeStackByName(stackName);
            if (summary.stackStatus) {
                return summary;
            }
        }
    }
    const name = useCaseName?.trim();
    if (name) {
        return describeStackByName(expectedAgentStackName(name, useCaseId));
    }
    return {};
}

export function isCfnRollbackOrDelete(stackStatus?: string): boolean {
    if (!stackStatus) {
        return false;
    }
    return (
        stackStatus.includes('ROLLBACK') ||
        stackStatus.includes('DELETE') ||
        stackStatus === 'CREATE_FAILED' ||
        stackStatus === 'STACK_DELETED'
    );
}

export function runtimeUrlFromProbe(probe: UseCaseProbe): string | undefined {
    if (probe.cloudFrontWebUrl) {
        return probe.cloudFrontWebUrl;
    }
    if (probe.deployUI === 'true') {
        return undefined;
    }
    return undefined;
}
