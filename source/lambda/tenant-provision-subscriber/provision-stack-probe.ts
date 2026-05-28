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
import { AWSClientManager } from 'aws-sdk-lib';
import { USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { expectedAgentStackName } from './provision-stack-naming';
import { logger, tracer } from './power-tools-init';

export { expectedAgentStackName } from './provision-stack-naming';

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
const cfn = new CloudFormationClient(customAwsConfig());
tracer.captureAWSv3Client(cfn);

export type UseCaseProbe = {
    status: string;
    cloudFrontWebUrl?: string;
};

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

function stackNameFromArn(stackArn: string): string | undefined {
    const parts = stackArn.split('/');
    const idx = parts.indexOf('stack');
    if (idx >= 0 && parts[idx + 1]) {
        return parts[idx + 1];
    }
    return undefined;
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

export type FindUseCaseOptions = {
    /** When set, only return a row with this UseCaseType (e.g. AgentBuilder, MCPServer). */
    useCaseType?: string;
};

function matchesUseCaseType(item: Record<string, unknown>, useCaseType?: string): boolean {
    if (!useCaseType?.trim()) {
        return true;
    }
    return typeof item.UseCaseType === 'string' && item.UseCaseType.trim() === useCaseType.trim();
}

export async function findUseCaseIdByName(
    useCaseName: string,
    tenantId?: string,
    opts?: FindUseCaseOptions
): Promise<string | undefined> {
    const name = useCaseName.trim();
    const tid = tenantId?.trim();
    const useCaseType = opts?.useCaseType?.trim();
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

        if (name) {
            const byName = items.find(
                (i) =>
                    typeof i.Name === 'string' &&
                    i.Name.trim() === name &&
                    matchesUseCaseType(i, useCaseType)
            );
            if (byName && typeof byName.UseCaseId === 'string') {
                return byName.UseCaseId.trim();
            }
        } else if (tid) {
            const byTenant = items.find(
                (i) =>
                    typeof i.TenantId === 'string' &&
                    i.TenantId.trim() === tid &&
                    matchesUseCaseType(i, useCaseType)
            );
            if (byTenant && typeof byTenant.UseCaseId === 'string') {
                return byTenant.UseCaseId.trim();
            }
        }
        startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);

    return undefined;
}

async function describeStackFromArn(stackArn: string): Promise<UseCaseProbe> {
    const stackName = stackNameFromArn(stackArn);
    if (!stackName) {
        return { status: '' };
    }
    return describeStackByName(stackName);
}

export async function getUseCaseProbeByStackName(stackName: string): Promise<UseCaseProbe> {
    return describeStackByName(stackName.trim());
}

/**
 * Prefer DDB StackId when present; otherwise poll CloudFormation by the predictable stack name
 * so provisioning can complete before StackId is written to the use-cases table.
 */
export async function getDeploymentProbe(useCaseId: string, useCaseName?: string): Promise<UseCaseProbe> {
    const probe = await getUseCaseProbe(useCaseId);
    if (probe.status) {
        return probe;
    }
    const name = useCaseName?.trim();
    if (!name) {
        return probe;
    }
    const byStackName = await describeStackByName(expectedAgentStackName(name, useCaseId));
    return byStackName.status ? byStackName : probe;
}

/** Poll deployment status the same way template testing does (DDB StackId + CloudFormation). */
export async function getUseCaseProbe(useCaseId: string): Promise<UseCaseProbe> {
    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable(),
            Key: { UseCaseId: useCaseId }
        })
    );
    const stackArn = typeof row.Item?.StackId === 'string' ? row.Item.StackId.trim() : '';
    if (!stackArn) {
        return { status: '' };
    }
    return describeStackFromArn(stackArn);
}
