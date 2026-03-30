// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AWSClientManager } from 'aws-sdk-lib';
import middy from '@middy/core';
import { APIGatewayEvent } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { checkEnv } from './utils/check-env';
import { TENANTS_TABLE_NAME_ENV_VAR } from './utils/constants';
import { formatError, formatResponse } from './utils/http-response-formatters';
import { logger, tracer } from './power-tools-init';

const PK = 'TenantId';

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));

const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function tableName(): string {
    return process.env[TENANTS_TABLE_NAME_ENV_VAR]!;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw || raw === '') {
        return fallback;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
    if (!key || Object.keys(key).length === 0) {
        return undefined;
    }
    return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
    if (!cursor) {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function itemToApi(item: Record<string, unknown>) {
    return {
        tenantId: item[PK],
        organizationName: item.OrganizationName ?? undefined,
        customerName: item.CustomerName ?? undefined,
        tenantAdminEmail: item.TenantAdminEmail ?? undefined,
        source: item.Source ?? undefined,
        createdAt: item.CreatedAt,
        updatedAt: item.UpdatedAt
    };
}

async function listTenants(event: APIGatewayEvent) {
    const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '50', 10) || 50, 100);
    const startKey = decodeCursor(event.queryStringParameters?.nextPageKey);

    const out = await ddb.send(
        new ScanCommand({
            TableName: tableName(),
            Limit: limit,
            ExclusiveStartKey: startKey
        })
    );

    return {
        tenants: (out.Items ?? []).map((i) => itemToApi(i as Record<string, unknown>)),
        nextPageKey: encodeCursor(out.LastEvaluatedKey as Record<string, unknown> | undefined)
    };
}

async function createOrUpsertTenant(body: Record<string, unknown>) {
    const now = new Date().toISOString();
    let tenantId =
        typeof body.tenantId === 'string' && UUID_RE.test(body.tenantId.trim()) ? body.tenantId.trim() : '';

    if (!tenantId) {
        tenantId = randomUUID();
    }

    const organizationName =
        typeof body.organizationName === 'string' ? body.organizationName.trim() || undefined : undefined;
    const customerName =
        typeof body.customerName === 'string'
            ? body.customerName.trim() || undefined
            : typeof body.displayName === 'string'
              ? body.displayName.trim() || undefined
              : undefined;
    const tenantAdminEmail =
        typeof body.tenantAdminEmail === 'string' ? body.tenantAdminEmail.trim() || undefined : undefined;
    const source =
        typeof body.source === 'string' && (body.source === 'aiw' || body.source === 'manual')
            ? body.source
            : 'manual';

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
        UpdatedAt: now,
        CreatedAt: createdAt,
        Source: source
    };
    if (organizationName !== undefined) item.OrganizationName = organizationName;
    if (customerName !== undefined) item.CustomerName = customerName;
    if (tenantAdminEmail !== undefined) item.TenantAdminEmail = tenantAdminEmail;

    await ddb.send(
        new PutCommand({
            TableName: tableName(),
            Item: item
        })
    );

    return itemToApi(item);
}

export const lambdaHandler = async (event: APIGatewayEvent) => {
    checkEnv();

    try {
        const method = event.httpMethod;
        const resource = event.resource;

        if (method === 'GET' && resource === '/tenants') {
            return formatResponse(await listTenants(event));
        }

        if (method === 'POST' && resource === '/tenants') {
            const body = parseJson<Record<string, unknown>>(event.body, {});
            return formatResponse(await createOrUpsertTenant(body));
        }

        return formatError({
            message: `Unsupported ${method} ${resource}`,
            statusCode: '400'
        });
    } catch (error: unknown) {
        const err = error as Error & { statusCode?: string };
        logger.error(String(error));
        const status = err.statusCode ?? '400';
        return formatError({ message: err.message || 'Request failed', statusCode: status });
    }
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
