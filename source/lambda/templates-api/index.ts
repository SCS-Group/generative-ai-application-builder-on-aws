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
import { customAwsConfig } from './lib/custom-aws-config';
import { AWSClientManager } from './lib/aws-client-manager';
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
    STATUS_IN_TESTING,
    STATUS_PUBLISHED,
    TESTING_DEPLOY_ACTIVE,
    TESTING_DEPLOY_DEPLOYING,
    TESTING_DEPLOY_FAILED,
    TESTING_DEPLOY_STALE,
    ACTIVE_STACK_STATUSES,
    FAILED_STACK_STATUSES,
    IN_PROGRESS_STACK_STATUSES
} from './utils/constants';
import {
    buildTestUseCaseName,
    deleteTestStack,
    deployRequestBodyFromDevops,
    deployTestStack,
    describeUseCaseStack,
    findUseCaseIdByName,
    getUseCaseProbe,
    isCfnRollbackOrDelete,
    resolveUseCaseIdAfterDeploy,
    runtimeUrlFromProbe
} from './template-testing';
import { formatError, formatResponse } from './utils/http-response-formatters';
import { logger, tracer } from './power-tools-init';
import {
    formatPricingSummaryFromCommercial,
    getBillingModel,
    mergeCatalogIntoMarketing,
    parseRatingsItem,
    ratingsFromBody,
    validateDevopsForPublish,
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
        marketing: parseJson<Record<string, unknown>>(item.Marketing as string, {}),
        devops: parseJson<Record<string, unknown>>(item.Devops as string, {}),
        wizardPayload: item.WizardPayload
            ? parseJson<Record<string, unknown>>(item.WizardPayload as string, {})
            : undefined,
        createdAt: item.CreatedAt,
        updatedAt: item.UpdatedAt,
        publishedAt: item.PublishedAt,
        publishedBy: item.PublishedBy,
        unpublishedAt: item.UnpublishedAt,
        unpublishedBy: item.UnpublishedBy,
        testingUseCaseId: item.TestingUseCaseId,
        testingUseCaseName: item.TestingUseCaseName,
        testingDeployStatus: item.TestingDeployStatus,
        testingValidatedAt: item.TestingValidatedAt,
        testingRuntimeUrl: item.TestingRuntimeUrl,
        testingStartedAt: item.TestingStartedAt,
        testingError: item.TestingError
    };
}

async function loadTemplateRecord(templateId: string): Promise<Record<string, unknown>> {
    const out = await ddb.send(
        new GetCommand({
            TableName: tableName(),
            Key: { [PK]: templateId }
        })
    );
    if (!out.Item) {
        throw Object.assign(new Error('Template not found'), { statusCode: '404' });
    }
    return out.Item as Record<string, unknown>;
}

/** Only these flows may delete the ephemeral test stack (never on refresh/sync/deploy poll). */
type TestStackTeardownReason = 'publish' | 'cancel_testing' | 'restart_testing';

async function teardownTestingStack(
    cur: Record<string, unknown>,
    reason: TestStackTeardownReason,
    options?: { bestEffort?: boolean }
): Promise<void> {
    const useCaseId = typeof cur.TestingUseCaseId === 'string' ? cur.TestingUseCaseId.trim() : '';
    if (!useCaseId) {
        return;
    }
    logger.info('Teardown test stack', { useCaseId, reason, bestEffort: Boolean(options?.bestEffort) });
    try {
        await deleteTestStack(useCaseId);
    } catch (e) {
        const err = e as Error;
        if (options?.bestEffort) {
            logger.warn('Best-effort test stack delete failed', { useCaseId, reason, message: err.message });
            return;
        }
        logger.error('Failed to delete test stack', { useCaseId, reason, message: err.message });
        throw new Error(`Could not delete test deployment: ${err.message}`);
    }
}

async function resetTemplateToDraftAfterTesting(templateId: string): Promise<void> {
    await persistTestingState(templateId, {
        status: STATUS_DRAFT,
        testingUseCaseName: null,
        testingUseCaseId: null,
        testingDeployStatus: null,
        testingRuntimeUrl: null,
        testingError: null,
        testingStartedAt: null,
        clearValidation: true
    });
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
            ProjectionExpression:
                '#tid, #slug, #status, #uct, #ca, #ua, #pa, #mkt, #upa, #upb, #tuid, #tun, #tds, #tva, #tru, #tsa, #terr',
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
                '#upb': 'UnpublishedBy',
                '#tuid': 'TestingUseCaseId',
                '#tun': 'TestingUseCaseName',
                '#tds': 'TestingDeployStatus',
                '#tva': 'TestingValidatedAt',
                '#tru': 'TestingRuntimeUrl',
                '#tsa': 'TestingStartedAt',
                '#terr': 'TestingError'
            }
        })
    );

    return {
        templates: (out.Items ?? []).map((i: Record<string, unknown>) => itemToApi(i)),
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
    const status = cur[ATTR_STATUS];
    if (status === STATUS_PUBLISHED) {
        throw new Error('Cannot update a published template.');
    }
    if (status === STATUS_ARCHIVED) {
        throw new Error('Cannot update a decommissioned template.');
    }
    if (status !== STATUS_DRAFT && status !== STATUS_IN_TESTING) {
        throw new Error(`Cannot update template in status "${String(status)}".`);
    }

    let nextMarketing = parseJson<Record<string, unknown>>(cur.Marketing as string, {});
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
        if (status === STATUS_IN_TESTING) {
            updates.push('#tds = :tds');
            names['#tds'] = 'TestingDeployStatus';
            values[':tds'] = TESTING_DEPLOY_STALE;
        }
    }
    if (body.wizardPayload !== undefined) {
        updates.push('#wp = :wp');
        names['#wp'] = 'WizardPayload';
        values[':wp'] = JSON.stringify(body.wizardPayload);
    }

    const ratingsOp = ratingsFromBody(body);
    let updateExpression = `SET ${updates.join(', ')}`;
    const removes: string[] = [];
    if (body.devops !== undefined && status === STATUS_IN_TESTING) {
        removes.push('#tva');
        names['#tva'] = 'TestingValidatedAt';
    }
    if (ratingsOp === '__REMOVE__') {
        removes.push('#rt');
        names['#rt'] = ATTR_RATINGS;
    } else if (ratingsOp) {
        updates.push('#rt = :rt');
        names['#rt'] = ATTR_RATINGS;
        values[':rt'] = ratingsOp;
        updateExpression = `SET ${updates.join(', ')}`;
    }
    if (removes.length) {
        updateExpression += ` REMOVE ${removes.join(', ')}`;
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
    const conflict = (out.Items ?? []).find((i: Record<string, unknown>) => i[PK] !== excludeTemplateId);
    if (conflict) {
        throw new Error(`Another published template already uses slug "${slug}".`);
    }
}

async function persistTestingState(
    templateId: string,
    fields: {
        status?: string;
        testingUseCaseId?: string | null;
        testingUseCaseName?: string | null;
        testingDeployStatus?: string | null;
        testingRuntimeUrl?: string | null;
        testingError?: string | null;
        testingStartedAt?: string | null;
        clearValidation?: boolean;
    }
): Promise<void> {
    const now = new Date().toISOString();
    const sets: string[] = ['#ua = :ua'];
    const names: Record<string, string> = { '#ua': 'UpdatedAt' };
    const values: Record<string, unknown> = { ':ua': now };
    const removes: string[] = [];

    if (fields.status) {
        sets.push('#st = :st');
        names['#st'] = ATTR_STATUS;
        values[':st'] = fields.status;
    }
    if (fields.testingUseCaseName !== undefined) {
        if (fields.testingUseCaseName === null) {
            removes.push('#tun');
            names['#tun'] = 'TestingUseCaseName';
        } else {
            sets.push('#tun = :tun');
            names['#tun'] = 'TestingUseCaseName';
            values[':tun'] = fields.testingUseCaseName;
        }
    }
    if (fields.testingUseCaseId !== undefined) {
        if (fields.testingUseCaseId === null) {
            removes.push('#tuc');
            names['#tuc'] = 'TestingUseCaseId';
        } else {
            sets.push('#tuc = :tuc');
            names['#tuc'] = 'TestingUseCaseId';
            values[':tuc'] = fields.testingUseCaseId;
        }
    }
    if (fields.testingDeployStatus !== undefined) {
        if (fields.testingDeployStatus === null) {
            removes.push('#tds');
            names['#tds'] = 'TestingDeployStatus';
        } else {
            sets.push('#tds = :tds');
            names['#tds'] = 'TestingDeployStatus';
            values[':tds'] = fields.testingDeployStatus;
        }
    }
    if (fields.testingRuntimeUrl !== undefined) {
        if (fields.testingRuntimeUrl === null) {
            removes.push('#tru');
            names['#tru'] = 'TestingRuntimeUrl';
        } else {
            sets.push('#tru = :tru');
            names['#tru'] = 'TestingRuntimeUrl';
            values[':tru'] = fields.testingRuntimeUrl;
        }
    }
    if (fields.testingError !== undefined) {
        if (fields.testingError === null) {
            removes.push('#terr');
            names['#terr'] = 'TestingError';
        } else {
            sets.push('#terr = :terr');
            names['#terr'] = 'TestingError';
            values[':terr'] = fields.testingError;
        }
    }
    if (fields.testingStartedAt !== undefined) {
        if (fields.testingStartedAt === null) {
            removes.push('#tsa');
            names['#tsa'] = 'TestingStartedAt';
        } else {
            sets.push('#tsa = :tsa');
            names['#tsa'] = 'TestingStartedAt';
            values[':tsa'] = fields.testingStartedAt;
        }
    }
    if (fields.clearValidation) {
        removes.push('#tva');
        names['#tva'] = 'TestingValidatedAt';
    }

    let updateExpression = `SET ${sets.join(', ')}`;
    if (removes.length) {
        updateExpression += ` REMOVE ${removes.join(', ')}`;
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
}

async function syncTestingDeployStatus(templateId: string, cur: Record<string, unknown>) {
    let useCaseId = typeof cur.TestingUseCaseId === 'string' ? cur.TestingUseCaseId.trim() : '';
    const testName = typeof cur.TestingUseCaseName === 'string' ? cur.TestingUseCaseName.trim() : '';
    if (!useCaseId && testName) {
        useCaseId = (await findUseCaseIdByName(testName)) ?? '';
        if (useCaseId) {
            await persistTestingState(templateId, { testingUseCaseId: useCaseId });
        }
    }
    if (!useCaseId) {
        await persistTestingState(templateId, {
            testingDeployStatus: TESTING_DEPLOY_DEPLOYING,
            testingError: 'Waiting for test deployment record…'
        });
        return getTemplate(templateId);
    }

    const cfnStack = await describeUseCaseStack(useCaseId, testName);
    if (isCfnRollbackOrDelete(cfnStack.stackStatus)) {
        const reason =
            cfnStack.stackStatusReason ??
            `CloudFormation status: ${cfnStack.stackStatus ?? 'unknown'}. The test stack did not finish creating. This is an automatic rollback — not Publish/Cancel from Templates.`;
        // If the stack is already gone, drop back to draft so the operator can Start testing again.
        // Keeping a template "in_testing" with no stack is confusing and blocks testing.
        if (cfnStack.stackStatus === 'STACK_DELETED') {
            await persistTestingState(templateId, {
                status: STATUS_DRAFT,
                testingUseCaseId: null,
                testingUseCaseName: null,
                testingDeployStatus: null,
                testingStartedAt: null,
                testingRuntimeUrl: null,
                testingError: null,
                clearValidation: true
            });
        } else {
            await persistTestingState(templateId, {
                testingDeployStatus: TESTING_DEPLOY_FAILED,
                testingRuntimeUrl: null,
                testingError: reason
            });
        }
        return getTemplate(templateId);
    }

    let probe: Awaited<ReturnType<typeof getUseCaseProbe>> = { status: '' };
    try {
        probe = await getUseCaseProbe(useCaseId, testName);
    } catch (e) {
        logger.warn('getUseCaseProbe failed during template test sync; using CloudFormation status only', {
            useCaseId,
            error: e
        });
    }
    const cfnStatus = cfnStack.stackStatus ?? '';
    const probeStatus = probe.status ?? '';
    let deployStatus = TESTING_DEPLOY_DEPLOYING;
    let testingError: string | null = null;
    if (ACTIVE_STACK_STATUSES.has(probeStatus)) {
        deployStatus = TESTING_DEPLOY_ACTIVE;
        testingError = null;
    } else if (ACTIVE_STACK_STATUSES.has(cfnStatus)) {
        deployStatus = TESTING_DEPLOY_ACTIVE;
        testingError = null;
        logger.info('Test deploy active via CloudFormation status', { useCaseId, cfnStatus, probeStatus });
    } else if (IN_PROGRESS_STACK_STATUSES.has(probeStatus) || IN_PROGRESS_STACK_STATUSES.has(cfnStatus)) {
        deployStatus = TESTING_DEPLOY_DEPLOYING;
        testingError = null;
    } else if (FAILED_STACK_STATUSES.has(probeStatus) || FAILED_STACK_STATUSES.has(cfnStatus)) {
        deployStatus = TESTING_DEPLOY_FAILED;
        testingError = `Stack status: ${probeStatus || cfnStatus}. Test stack is kept — use Cancel testing to remove it, or Restart testing to try again.`;
    }
    const runtimeUrl = runtimeUrlFromProbe(probe) ?? cfnStack.cloudFrontWebUrl;
    await persistTestingState(templateId, {
        testingDeployStatus: deployStatus,
        testingRuntimeUrl: runtimeUrl ?? null,
        testingError
    });
    return getTemplate(templateId);
}

async function startTesting(templateId: string) {
    const cur = await loadTemplateRecord(templateId);
    const status = cur[ATTR_STATUS];

    if (status === STATUS_IN_TESTING) {
        const deployStatus = cur.TestingDeployStatus;
        if (deployStatus === TESTING_DEPLOY_ACTIVE || deployStatus === TESTING_DEPLOY_FAILED) {
            return getTemplate(templateId);
        }
        return syncTestingDeployStatus(templateId, cur);
    }

    if (status !== STATUS_DRAFT) {
        throw new Error('Only draft templates can start testing.');
    }

    const devops = parseJson<Record<string, unknown>>(cur.Devops as string, {});
    validateDevopsForPublish(devops);
    const deployBody = deployRequestBodyFromDevops(devops);
    if (!deployBody) {
        throw new Error('Missing deploy configuration. Complete the Agent wizard and Generate JSON before testing.');
    }

    const slug = String(cur[ATTR_SLUG]);
    const testName = buildTestUseCaseName(slug, templateId);
    deployBody.UseCaseName = testName;
    const startedAt = new Date().toISOString();

    const existingId = await findUseCaseIdByName(testName);
    if (existingId) {
        await persistTestingState(templateId, {
            status: STATUS_IN_TESTING,
            testingUseCaseName: testName,
            testingUseCaseId: existingId,
            testingDeployStatus: TESTING_DEPLOY_DEPLOYING,
            testingStartedAt: startedAt,
            testingRuntimeUrl: null,
            testingError: null,
            clearValidation: true
        });
        return syncTestingDeployStatus(templateId, {
            ...cur,
            [ATTR_STATUS]: STATUS_IN_TESTING,
            TestingUseCaseId: existingId,
            TestingUseCaseName: testName,
            TestingDeployStatus: TESTING_DEPLOY_DEPLOYING
        });
    }

    await persistTestingState(templateId, {
        status: STATUS_IN_TESTING,
        testingUseCaseName: testName,
        testingDeployStatus: TESTING_DEPLOY_DEPLOYING,
        testingStartedAt: startedAt,
        testingRuntimeUrl: null,
        testingError: null,
        clearValidation: true
    });

    try {
        await deployTestStack(deployBody);
        const useCaseId = await resolveUseCaseIdAfterDeploy(testName);
        await persistTestingState(templateId, {
            testingUseCaseId: useCaseId,
            testingDeployStatus: TESTING_DEPLOY_DEPLOYING,
            testingError: null
        });
    } catch (e) {
        const err = e as Error;
        logger.error('startTesting deploy failed', { templateId, message: err.message });
        const useCaseAfterError = await findUseCaseIdByName(testName);
        if (useCaseAfterError) {
            await persistTestingState(templateId, {
                status: STATUS_IN_TESTING,
                testingUseCaseName: testName,
                testingUseCaseId: useCaseAfterError,
                testingDeployStatus: TESTING_DEPLOY_DEPLOYING,
                testingError: err.message || 'Deploy in progress or recoverable — use Refresh status.',
                clearValidation: true
            });
            return getTemplate(templateId);
        }
        await persistTestingState(templateId, {
            status: STATUS_DRAFT,
            testingUseCaseId: null,
            testingUseCaseName: null,
            testingDeployStatus: null,
            testingStartedAt: null,
            testingRuntimeUrl: null,
            testingError: null,
            clearValidation: true
        });
        throw new Error(err.message || 'Test deployment failed to start.');
    }

    return getTemplate(templateId);
}

async function cancelTesting(templateId: string) {
    const cur = await loadTemplateRecord(templateId);
    if (cur[ATTR_STATUS] !== STATUS_IN_TESTING) {
        throw new Error('Only templates in testing can be cancelled.');
    }
    await resetTemplateToDraftAfterTesting(templateId);
    await teardownTestingStack(cur, 'cancel_testing', { bestEffort: true });
    return getTemplate(templateId);
}

async function restartTesting(templateId: string) {
    const cur = await loadTemplateRecord(templateId);
    if (cur[ATTR_STATUS] !== STATUS_IN_TESTING) {
        throw new Error('Restart testing is only available while in testing.');
    }
    await resetTemplateToDraftAfterTesting(templateId);
    await teardownTestingStack(cur, 'restart_testing', { bestEffort: true });
    return startTesting(templateId);
}

async function markTestingValidated(templateId: string) {
    const cur = await loadTemplateRecord(templateId);
    if (cur[ATTR_STATUS] !== STATUS_IN_TESTING) {
        throw new Error('Only templates in testing can be marked as validated.');
    }
    if (cur.TestingDeployStatus !== TESTING_DEPLOY_ACTIVE) {
        throw new Error('Test deployment must be active before you can confirm validation.');
    }
    const now = new Date().toISOString();
    await ddb.send(
        new UpdateCommand({
            TableName: tableName(),
            Key: { [PK]: templateId },
            UpdateExpression: 'SET #tva = :tva, #ua = :ua',
            ExpressionAttributeNames: {
                '#tva': 'TestingValidatedAt',
                '#ua': 'UpdatedAt'
            },
            ExpressionAttributeValues: {
                ':tva': now,
                ':ua': now
            }
        })
    );
    return getTemplate(templateId);
}

async function refreshTestingStatus(templateId: string) {
    const cur = await loadTemplateRecord(templateId);
    if (cur[ATTR_STATUS] !== STATUS_IN_TESTING) {
        const slug = String(cur[ATTR_SLUG] ?? '');
        const testName = buildTestUseCaseName(slug, templateId);
        const orphanedId = await findUseCaseIdByName(testName);
        if (orphanedId && cur[ATTR_STATUS] === STATUS_DRAFT) {
            const startedAt = new Date().toISOString();
            await persistTestingState(templateId, {
                status: STATUS_IN_TESTING,
                testingUseCaseName: testName,
                testingUseCaseId: orphanedId,
                testingDeployStatus: TESTING_DEPLOY_DEPLOYING,
                testingStartedAt: startedAt,
                clearValidation: true
            });
            return syncTestingDeployStatus(templateId, {
                ...cur,
                [ATTR_STATUS]: STATUS_IN_TESTING,
                TestingUseCaseId: orphanedId,
                TestingUseCaseName: testName
            });
        }
        throw new Error('Only templates in testing have a deployment status to refresh.');
    }
    return syncTestingDeployStatus(templateId, cur);
}

async function publishTemplate(templateId: string, body: Record<string, unknown>) {
    const cur = await loadTemplateRecord(templateId);
    if (cur[ATTR_STATUS] === STATUS_PUBLISHED) {
        throw new Error('Template is already published.');
    }
    if (cur[ATTR_STATUS] !== STATUS_IN_TESTING) {
        throw new Error(
            'Publish requires in_testing status. Start testing from the templates list, validate the deployment, then publish.'
        );
    }
    if (cur.TestingDeployStatus !== TESTING_DEPLOY_ACTIVE) {
        throw new Error('Test deployment must be active before publish.');
    }
    if (!cur.TestingValidatedAt) {
        throw new Error(
            'Confirm test validation before publish (mark testing validated after you smoke-test the deployment).'
        );
    }

    const slug = String(cur[ATTR_SLUG]);
    await assertSlugAvailableForPublish(slug, templateId);

    const marketing = parseJson<Record<string, unknown>>(cur.Marketing as string, {});
    const devops = parseJson<Record<string, unknown>>(cur.Devops as string, {});

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
    validateDevopsForPublish(devops);
    const marketingNeedsPersist = JSON.stringify(marketing) !== marketingBeforePatch;

    // Tear down test stack only after all publish gates pass (active deploy + operator validation).
    await teardownTestingStack(cur, 'publish');

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
            UpdateExpression:
                'SET #st = :st, #pa = :pa, #pb = :pb, #ua = :ua REMOVE #tuc, #tun, #tds, #tsa, #tru, #terr, #tva',
            ExpressionAttributeNames: {
                '#st': ATTR_STATUS,
                '#pa': 'PublishedAt',
                '#pb': 'PublishedBy',
                '#ua': 'UpdatedAt',
                '#tuc': 'TestingUseCaseId',
                '#tun': 'TestingUseCaseName',
                '#tds': 'TestingDeployStatus',
                '#tsa': 'TestingStartedAt',
                '#tru': 'TestingRuntimeUrl',
                '#terr': 'TestingError',
                '#tva': 'TestingValidatedAt'
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

        if (method === 'POST' && resource === '/templates/{templateId}/start-testing') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            return formatResponse(await startTesting(id));
        }

        if (method === 'POST' && resource === '/templates/{templateId}/cancel-testing') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            return formatResponse(await cancelTesting(id));
        }

        if (method === 'POST' && resource === '/templates/{templateId}/restart-testing') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            return formatResponse(await restartTesting(id));
        }

        if (method === 'POST' && resource === '/templates/{templateId}/mark-testing-validated') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            return formatResponse(await markTestingValidated(id));
        }

        if (method === 'POST' && resource === '/templates/{templateId}/refresh-testing-status') {
            const id = event.pathParameters?.templateId;
            if (!id) {
                return formatError({ message: 'templateId is required', statusCode: '400' });
            }
            return formatResponse(await refreshTestingStatus(id));
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
