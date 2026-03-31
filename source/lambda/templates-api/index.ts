// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    ScanCommand,
    UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { AWSClientManager } from 'aws-sdk-lib';
import middy from '@middy/core';
import { APIGatewayEvent } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { checkEnv } from './utils/check-env';
import {
    AGENT_TEMPLATES_TABLE_NAME_ENV_VAR,
    EVENT_BUS_NAME_ENV_VAR,
    GSI_STATUS_SLUG,
    STATUS_ARCHIVED,
    STATUS_DRAFT,
    STATUS_PUBLISHED
} from './utils/constants';
import { formatError, formatResponse } from './utils/http-response-formatters';
import { logger, tracer } from './power-tools-init';
import {
    formatPricingSummaryFromCommercial,
    getBillingModel,
    mergeCatalogIntoMarketing,
    parseRatingsItem,
    ratingsFromBody,
    validateMarketingForPublish
} from './catalog-fields';

const PK = 'TemplateId';
const ATTR_SLUG = 'Slug';
const ATTR_STATUS = 'Status';
const ATTR_RATINGS = 'Ratings';

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
const eventBridge = new EventBridgeClient(customAwsConfig());
tracer.captureAWSv3Client(eventBridge);

function tableName(): string {
    return process.env[AGENT_TEMPLATES_TABLE_NAME_ENV_VAR]!;
}

function eventBusName(): string {
    return process.env[EVENT_BUS_NAME_ENV_VAR]!;
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

function normalizeSlug(slug: string): string {
    const s = slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
        throw new Error(
            'Invalid slug: use lowercase letters, digits, and single hyphens between segments (e.g. support-copilot).'
        );
    }
    return s;
}

function buildDefaultDevops(useCaseType: string, deployRequestBody: Record<string, unknown>): Record<string, unknown> {
    return {
        gaab: {
            variant: useCaseType,
            provisioning: {
                deployMethod: 'POST',
                deployPath: '/deployments/agents',
                deployRequestBody
            }
        }
    };
}

function itemToApi(item: Record<string, unknown>) {
    // Ratings are stored for AIW/future tenant scoring; never returned to GAAB dashboard clients.
    return {
        templateId: item[PK],
        slug: item[ATTR_SLUG],
        status: item[ATTR_STATUS],
        useCaseType: item.UseCaseType,
        marketing: parseJson(item.Marketing as string, {}),
        devops: parseJson(item.Devops as string, {}),
        wizardPayload: item.WizardPayload ? parseJson(item.WizardPayload as string, {}) : undefined,
        createdAt: item.CreatedAt,
        updatedAt: item.UpdatedAt,
        publishedAt: item.PublishedAt,
        publishedBy: item.PublishedBy,
        unpublishedAt: item.UnpublishedAt,
        unpublishedBy: item.UnpublishedBy
    };
}

async function listTemplates(event: APIGatewayEvent) {
    const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '20', 10) || 20, 50);
    const startKey = decodeCursor(event.queryStringParameters?.nextPageKey);

    const out = await ddb.send(
        new ScanCommand({
            TableName: tableName(),
            Limit: limit,
            ExclusiveStartKey: startKey,
            // Status is a DynamoDB reserved keyword; use ExpressionAttributeNames.
            ProjectionExpression: '#tid, #slug, #status, #uct, #ca, #ua, #pa, #mkt, #upa, #upb',
            ExpressionAttributeNames: {
                '#tid': PK,
                '#slug': ATTR_SLUG,
                '#status': ATTR_STATUS,
                '#uct': 'UseCaseType',
                '#ca': 'CreatedAt',
                '#ua': 'UpdatedAt',
                '#pa': 'PublishedAt',
                '#mkt': 'Marketing',
                '#upa': 'UnpublishedAt',
                '#upb': 'UnpublishedBy'
            }
        })
    );

    return {
        templates: (out.Items ?? []).map((i) => itemToApi(i as Record<string, unknown>)),
        nextPageKey: encodeCursor(out.LastEvaluatedKey as Record<string, unknown> | undefined)
    };
}

async function createTemplate(body: Record<string, unknown>) {
    const slug = normalizeSlug(String(body.slug ?? ''));
    const useCaseType = String(body.useCaseType ?? 'AgentBuilder');
    let marketing =
        (body.marketing as Record<string, unknown>) ??
        ({
            displayName: String(body.displayName ?? slug),
            shortDescription: String(body.shortDescription ?? ''),
            billing: { model: 'contact_sales' }
        } as Record<string, unknown>);
    marketing = mergeCatalogIntoMarketing(marketing, body);

    let devops = body.devops as Record<string, unknown> | undefined;
    if (!devops) {
        const deployBody = (body.deployRequestBody as Record<string, unknown>) ?? {};
        devops = buildDefaultDevops(useCaseType, deployBody);
    }

    const wizardPayload = (body.wizardPayload as Record<string, unknown>) ?? undefined;
    const ratingsSerialized = ratingsFromBody(body);
    const now = new Date().toISOString();
    const id = randomUUID();

    const item: Record<string, unknown> = {
        [PK]: id,
        [ATTR_SLUG]: slug,
        [ATTR_STATUS]: STATUS_DRAFT,
        UseCaseType: useCaseType,
        Marketing: JSON.stringify(marketing),
        Devops: JSON.stringify(devops),
        ...(wizardPayload ? { WizardPayload: JSON.stringify(wizardPayload) } : {}),
        CreatedAt: now,
        UpdatedAt: now
    };
    if (ratingsSerialized && ratingsSerialized !== '__REMOVE__') {
        item[ATTR_RATINGS] = ratingsSerialized;
    }

    await ddb.send(
        new PutCommand({
            TableName: tableName(),
            Item: item
        })
    );

    return itemToApi({
        [PK]: id,
        [ATTR_SLUG]: slug,
        [ATTR_STATUS]: STATUS_DRAFT,
        UseCaseType: useCaseType,
        Marketing: JSON.stringify(marketing),
        Devops: JSON.stringify(devops),
        WizardPayload: wizardPayload ? JSON.stringify(wizardPayload) : undefined,
        CreatedAt: now,
        UpdatedAt: now
    });
}

async function getTemplate(templateId: string) {
    const out = await ddb.send(
        new GetCommand({
            TableName: tableName(),
            Key: { [PK]: templateId }
        })
    );
    if (!out.Item) {
        throw Object.assign(new Error('Template not found'), { statusCode: '404' });
    }
    return itemToApi(out.Item as Record<string, unknown>);
}

async function updateTemplate(templateId: string, body: Record<string, unknown>) {
    const existing = await ddb.send(
        new GetCommand({
            TableName: tableName(),
            Key: { [PK]: templateId }
        })
    );
    if (!existing.Item) {
        throw Object.assign(new Error('Template not found'), { statusCode: '404' });
    }
    const cur = existing.Item as Record<string, unknown>;
    if (cur[ATTR_STATUS] === STATUS_PUBLISHED) {
        throw new Error('Cannot update a published template.');
    }
    if (cur[ATTR_STATUS] === STATUS_ARCHIVED) {
        throw new Error('Cannot update a decommissioned template.');
    }

    let nextMarketing = parseJson(cur.Marketing as string, {});
    if (body.marketing !== undefined && typeof body.marketing === 'object' && body.marketing !== null) {
        nextMarketing = { ...nextMarketing, ...(body.marketing as Record<string, unknown>) };
    }
    nextMarketing = mergeCatalogIntoMarketing(nextMarketing, body);

    const updates: string[] = ['#ua = :ua', '#mk = :mk'];
    const names: Record<string, string> = { '#ua': 'UpdatedAt', '#mk': 'Marketing' };
    const values: Record<string, unknown> = {
        ':ua': new Date().toISOString(),
        ':mk': JSON.stringify(nextMarketing)
    };

    if (body.slug !== undefined) {
        updates.push('#sl = :sl');
        names['#sl'] = ATTR_SLUG;
        values[':sl'] = normalizeSlug(String(body.slug));
    }
    if (body.useCaseType !== undefined) {
        updates.push('#ut = :ut');
        names['#ut'] = 'UseCaseType';
        values[':ut'] = String(body.useCaseType);
    }
    if (body.devops !== undefined) {
        updates.push('#dv = :dv');
        names['#dv'] = 'Devops';
        values[':dv'] = JSON.stringify(body.devops);
    }
    if (body.wizardPayload !== undefined) {
        updates.push('#wp = :wp');
        names['#wp'] = 'WizardPayload';
        values[':wp'] = JSON.stringify(body.wizardPayload);
    }

    const ratingsOp = ratingsFromBody(body);
    let updateExpression = `SET ${updates.join(', ')}`;
    if (ratingsOp === '__REMOVE__') {
        updateExpression += ' REMOVE #rt';
        names['#rt'] = ATTR_RATINGS;
    } else if (ratingsOp) {
        updates.push('#rt = :rt');
        names['#rt'] = ATTR_RATINGS;
        values[':rt'] = ratingsOp;
        updateExpression = `SET ${updates.join(', ')}`;
    }

    await ddb.send(
        new UpdateCommand({
            TableName: tableName(),
            Key: { [PK]: templateId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values
        })
    );

    return getTemplate(templateId);
}

async function assertSlugAvailableForPublish(slug: string, excludeTemplateId: string) {
    const out = await ddb.send(
        new QueryCommand({
            TableName: tableName(),
            IndexName: GSI_STATUS_SLUG,
            KeyConditionExpression: '#s = :s AND #g = :g',
            ExpressionAttributeNames: { '#s': ATTR_STATUS, '#g': ATTR_SLUG },
            ExpressionAttributeValues: { ':s': STATUS_PUBLISHED, ':g': slug }
        })
    );
    const conflict = (out.Items ?? []).find((i) => (i as Record<string, unknown>)[PK] !== excludeTemplateId);
    if (conflict) {
        throw new Error(`Another published template already uses slug "${slug}".`);
    }
}

async function publishTemplate(templateId: string, body: Record<string, unknown>) {
    const existing = await ddb.send(
        new GetCommand({
            TableName: tableName(),
            Key: { [PK]: templateId }
        })
    );
    if (!existing.Item) {
        throw Object.assign(new Error('Template not found'), { statusCode: '404' });
    }
    const cur = existing.Item as Record<string, unknown>;
    if (cur[ATTR_STATUS] === STATUS_PUBLISHED) {
        throw new Error('Template is already published.');
    }

    const slug = String(cur[ATTR_SLUG]);
    await assertSlugAvailableForPublish(slug, templateId);

    const marketing = parseJson(cur.Marketing as string, {});
    const devops = parseJson(cur.Devops as string, {});

    const marketingBeforePatch = JSON.stringify(marketing);
    if (getBillingModel(marketing) === 'subscription') {
        const pricing = (marketing.pricing as Record<string, unknown>) || {};
        const summary = String(pricing.summary ?? '').trim();
        if (!summary) {
            const line = formatPricingSummaryFromCommercial(marketing);
            if (line) {
                marketing.pricing = { ...pricing, summary: line };
            }
        }
    }
    validateMarketingForPublish(marketing);
    const marketingNeedsPersist = JSON.stringify(marketing) !== marketingBeforePatch;

    const publishedAt = new Date().toISOString();
    const publishedBy = String(body.publishedBy ?? 'gaab-templates-api');
    const schemaVersion = String(body.schemaVersion ?? '0.1.0');

    const ratingsParsed = parseRatingsItem(cur[ATTR_RATINGS]);

    const detail: Record<string, unknown> = {
        gaabTemplateId: templateId,
        slug,
        schemaVersion,
        publishedAt,
        publishedBy,
        marketing,
        devops,
        source: { system: 'gaab', gaabTemplateId: templateId }
    };
    if (ratingsParsed !== undefined) {
        detail.ratings = ratingsParsed;
    }

    if (marketingNeedsPersist) {
        await ddb.send(
            new UpdateCommand({
                TableName: tableName(),
                Key: { [PK]: templateId },
                UpdateExpression: 'SET #mk = :mk, #ua = :ua',
                ExpressionAttributeNames: { '#mk': 'Marketing', '#ua': 'UpdatedAt' },
                ExpressionAttributeValues: {
                    ':mk': JSON.stringify(marketing),
                    ':ua': publishedAt
                }
            })
        );
    }

    await eventBridge.send(
        new PutEventsCommand({
            Entries: [
                {
                    EventBusName: eventBusName(),
                    Source: 'gaab.templates',
                    DetailType: 'TemplatePublished',
                    Detail: JSON.stringify(detail)
                }
            ]
        })
    );

    await ddb.send(
        new UpdateCommand({
            TableName: tableName(),
            Key: { [PK]: templateId },
            UpdateExpression: 'SET #st = :st, #pa = :pa, #pb = :pb, #ua = :ua',
            ExpressionAttributeNames: {
                '#st': ATTR_STATUS,
                '#pa': 'PublishedAt',
                '#pb': 'PublishedBy',
                '#ua': 'UpdatedAt'
            },
            ExpressionAttributeValues: {
                ':st': STATUS_PUBLISHED,
                ':pa': publishedAt,
                ':pb': publishedBy,
                ':ua': publishedAt
            }
        })
    );

    return {
        ...itemToApi({
            ...cur,
            [ATTR_STATUS]: STATUS_PUBLISHED,
            PublishedAt: publishedAt,
            PublishedBy: publishedBy,
            UpdatedAt: publishedAt
        }),
        eventPublished: true
    };
}

async function unpublishTemplate(templateId: string, body: Record<string, unknown>) {
    const existing = await ddb.send(
        new GetCommand({
            TableName: tableName(),
            Key: { [PK]: templateId }
        })
    );
    if (!existing.Item) {
        throw Object.assign(new Error('Template not found'), { statusCode: '404' });
    }
    const cur = existing.Item as Record<string, unknown>;
    if (cur[ATTR_STATUS] !== STATUS_PUBLISHED) {
        throw new Error('Only published templates can be decommissioned.');
    }

    const slug = String(cur[ATTR_SLUG]);
    const schemaVersion = String(body.schemaVersion ?? '0.1.0');
    const unpublishedAt = new Date().toISOString();
    const unpublishedBy = String(body.unpublishedBy ?? 'gaab-templates-api');
    const reason = body.reason !== undefined ? String(body.reason) : undefined;

    const detail: Record<string, unknown> = {
        gaabTemplateId: templateId,
        slug,
        schemaVersion,
        unpublishedAt,
        unpublishedBy,
        source: { system: 'gaab', gaabTemplateId: templateId }
    };
    if (reason) {
        detail.reason = reason;
    }

    await eventBridge.send(
        new PutEventsCommand({
            Entries: [
                {
                    EventBusName: eventBusName(),
                    Source: 'gaab.templates',
                    DetailType: 'TemplateUnpublished',
                    Detail: JSON.stringify(detail)
                }
            ]
        })
    );

    await ddb.send(
        new UpdateCommand({
            TableName: tableName(),
            Key: { [PK]: templateId },
            UpdateExpression: 'SET #st = :st, #ua = :ua, #uua = :uua, #uub = :uub',
            ExpressionAttributeNames: {
                '#st': ATTR_STATUS,
                '#ua': 'UpdatedAt',
                '#uua': 'UnpublishedAt',
                '#uub': 'UnpublishedBy'
            },
            ExpressionAttributeValues: {
                ':st': STATUS_ARCHIVED,
                ':ua': unpublishedAt,
                ':uua': unpublishedAt,
                ':uub': unpublishedBy
            }
        })
    );

    return {
        ...itemToApi({
            ...cur,
            [ATTR_STATUS]: STATUS_ARCHIVED,
            UpdatedAt: unpublishedAt,
            UnpublishedAt: unpublishedAt,
            UnpublishedBy: unpublishedBy
        }),
        eventUnpublished: true
    };
}

export const lambdaHandler = async (event: APIGatewayEvent) => {
    checkEnv();

    try {
        const method = event.httpMethod;
        const resource = event.resource;

        if (method === 'GET' && resource === '/templates') {
            return formatResponse(await listTemplates(event));
        }

        if (method === 'POST' && resource === '/templates') {
            const body = parseJson<Record<string, unknown>>(event.body, {});
            if (!body.slug) {
                return formatError({ message: 'slug is required', statusCode: '400' });
            }
            return formatResponse(await createTemplate(body));
        }

        if (method === 'GET' && resource === '/templates/{templateId}') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            return formatResponse(await getTemplate(id));
        }

        if (method === 'PATCH' && resource === '/templates/{templateId}') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            const body = parseJson<Record<string, unknown>>(event.body, {});
            return formatResponse(await updateTemplate(id, body));
        }

        if (method === 'POST' && resource === '/templates/{templateId}/publish') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            const body = parseJson<Record<string, unknown>>(event.body, {});
            return formatResponse(await publishTemplate(id, body));
        }

        if (method === 'POST' && resource === '/templates/{templateId}/unpublish') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            const body = parseJson<Record<string, unknown>>(event.body, {});
            return formatResponse(await unpublishTemplate(id, body));
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
