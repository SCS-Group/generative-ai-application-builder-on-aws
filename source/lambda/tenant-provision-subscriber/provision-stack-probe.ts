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
import { logger, tracer } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer));
const cfn = new CloudFormationClient(customAwsConfig());
tracer.captureAWSv3Client(cfn);

export type UseCaseProbe = {
    status: string;
    cloudFrontWebUrl?: string;
};

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

export async function findUseCaseIdByName(
    useCaseName: string,
    tenantId?: string
): Promise<string | undefined> {
    const name = useCaseName.trim();
    const tid = tenantId?.trim();
    let startKey: Record<string, unknown> | undefined;

    do {
        const out = await ddb.send(
            new ScanCommand({
                TableName: useCasesTable(),
                ExclusiveStartKey: startKey,
                ProjectionExpression: 'UseCaseId, #n, TenantId',
                ExpressionAttributeNames: { '#n': 'Name' },
                Limit: 50
            })
        );
        if (name) {
            const byName = (out.Items ?? []).find(
                (i) => typeof i.Name === 'string' && i.Name.trim() === name
            );
            if (byName && typeof byName.UseCaseId === 'string') {
                return byName.UseCaseId.trim();
            }
        }
        if (tid) {
            const byTenant = (out.Items ?? []).find(
                (i) => typeof i.TenantId === 'string' && i.TenantId.trim() === tid
            );
            if (byTenant && typeof byTenant.UseCaseId === 'string') {
                return byTenant.UseCaseId.trim();
            }
        }
        startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);

    return undefined;
}

export async function getUseCaseProbe(useCaseId: string): Promise<UseCaseProbe> {
    const row = await ddb.send(
        new GetCommand({
            TableName: useCasesTable(),
            Key: { UseCaseId: useCaseId }
        })
    );
    const stackArn = typeof row.Item?.StackId === 'string' ? row.Item.StackId : '';
    if (!stackArn) {
        return { status: '' };
    }
    const stackName = stackNameFromArn(stackArn);
    if (!stackName) {
        return { status: '' };
    }
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
        logger.warn('getUseCaseProbe DescribeStacks failed', { useCaseId, stackName, error: err });
        return { status: '' };
    }
}
