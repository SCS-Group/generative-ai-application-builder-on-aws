// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    CloudFormationClient,
    DescribeStacksCommand,
    type Output
} from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(customAwsConfig()));
const cfn = new CloudFormationClient(customAwsConfig());

export type UseCaseProbe = {
    status: string;
    cloudFrontWebUrl?: string;
};

export const ACTIVE_STACK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
export const IN_PROGRESS_STACK_STATUSES = new Set([
    'CREATE_IN_PROGRESS',
    'UPDATE_IN_PROGRESS',
    'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
    'UPDATE_ROLLBACK_IN_PROGRESS',
    'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
    'ROLLBACK_IN_PROGRESS'
]);

function useCasesTable(): string {
    return process.env[USE_CASES_TABLE_NAME_ENV_VAR]!;
}

function expectedStackName(useCaseName: string, useCaseId: string): string {
    const name = useCaseName.trim();
    const shortUUID = useCaseId.trim().substring(0, 8);
    return `${name}-${shortUUID}`;
}

function stackNameFromArn(stackArn: string): string | undefined {
    const trimmed = stackArn.trim();
    const marker = ':stack/';
    const idx = trimmed.indexOf(marker);
    if (idx < 0) {
        return undefined;
    }
    const after = trimmed.slice(idx + marker.length);
    const name = after.split('/')[0]?.trim();
    return name || undefined;
}

async function describeStackByName(stackName: string): Promise<UseCaseProbe> {
    try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = out.Stacks?.[0];
        const cloudFrontWebUrl = stack?.Outputs?.find(
            (o: Output) => o.OutputKey === 'CloudFrontWebUrl'
        )?.OutputValue;
        return {
            status: stack?.StackStatus ?? '',
            cloudFrontWebUrl: cloudFrontWebUrl?.trim() || undefined
        };
    } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === 'ValidationError' && /does not exist/i.test(err.message)) {
            return { status: 'STACK_DELETED' };
        }
        logger.warn('describeStackByName failed', { stackName, error: err });
        return { status: '' };
    }
}

export async function getDeploymentProbe(useCaseId: string, useCaseName?: string): Promise<UseCaseProbe> {
    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable(),
            Key: { UseCaseId: useCaseId }
        })
    );
    const stackArn = typeof row.Item?.StackId === 'string' ? row.Item.StackId.trim() : '';
    if (stackArn) {
        const stackName = stackNameFromArn(stackArn);
        if (stackName) {
            const probe = await describeStackByName(stackName);
            if (probe.status) {
                return probe;
            }
        }
    }
    const name = useCaseName?.trim();
    if (name) {
        return describeStackByName(expectedStackName(name, useCaseId));
    }
    return { status: '' };
}

export async function findWorkflowUseCaseIdByName(
    useCaseName: string,
    tenantId: string
): Promise<string | undefined> {
    const name = useCaseName.trim();
    const tid = tenantId.trim();
    let startKey: Record<string, unknown> | undefined;

    do {
        const out = await ddb.send(
            new ScanCommand({
                TableName: useCasesTable(),
                ExclusiveStartKey: startKey,
                ProjectionExpression: 'UseCaseId, #n, TenantId, UseCaseType',
                ExpressionAttributeNames: { '#n': 'Name' },
                Limit: 50
            })
        );
        const items = (out.Items ?? []) as Record<string, unknown>[];
        const match = items.find(
            (i) =>
                typeof i.Name === 'string' &&
                i.Name.trim() === name &&
                typeof i.UseCaseType === 'string' &&
                i.UseCaseType.trim() === 'Workflow' &&
                typeof i.TenantId === 'string' &&
                i.TenantId.trim() === tid
        );
        if (match && typeof match.UseCaseId === 'string') {
            return match.UseCaseId.trim();
        }
        startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);

    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForUseCaseReady(
    useCaseId: string,
    maxWaitMs = 900_000,
    intervalMs = 20_000,
    useCaseName?: string
): Promise<{ ok: true; probe: UseCaseProbe } | { ok: false; message: string }> {
    const deadline = Date.now() + maxWaitMs;
    let lastStatus = '';
    while (Date.now() < deadline) {
        const probe = await getDeploymentProbe(useCaseId, useCaseName);
        lastStatus = probe.status || 'pending_stack_link';
        if (ACTIVE_STACK_STATUSES.has(probe.status)) {
            return { ok: true, probe };
        }
        if (lastStatus.includes('FAILED') || lastStatus === 'ROLLBACK_COMPLETE') {
            return { ok: false, message: `Stack status: ${lastStatus}` };
        }
        await sleep(intervalMs);
    }
    return { ok: false, message: `Timed out waiting for workflow stack (last status: ${lastStatus}).` };
}

export async function resolveWorkflowUseCaseIdByName(
    useCaseName: string,
    tenantId: string
): Promise<string | undefined> {
    for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) {
            await sleep(5000);
        }
        const id = await findWorkflowUseCaseIdByName(useCaseName, tenantId);
        if (id) {
            return id;
        }
    }
    return undefined;
}
