// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { syncAgentRuntimeEnvFromConfig } from './sync-agent-runtime-env';
import { ACTIVE_STACK_STATUSES, getDeploymentProbe } from './workflow-provision-poll';
import { USE_CASES_TABLE_NAME_ENV_VAR } from './utils/constants';
import { logger } from './power-tools-init';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(customAwsConfig()));

export type SyncAllWorkflowRuntimesResult = {
    ok: boolean;
    scanned: number;
    synced: number;
    skipped: number;
    failed: number;
    errors: string[];
};

function useCasesTable(): string {
    const name = process.env[USE_CASES_TABLE_NAME_ENV_VAR]?.trim();
    if (!name) {
        throw new Error(`${USE_CASES_TABLE_NAME_ENV_VAR} is not configured`);
    }
    return name;
}

/** All deployed workflow orchestrator use cases (any tenant). */
export async function listAllWorkflowUseCaseIds(): Promise<string[]> {
    const ids: string[] = [];
    let startKey: Record<string, unknown> | undefined;

    do {
        const out = await ddb.send(
            new ScanCommand({
                TableName: useCasesTable(),
                ExclusiveStartKey: startKey,
                ProjectionExpression: 'UseCaseId, UseCaseType, StackId',
                Limit: 100
            })
        );
        for (const row of out.Items ?? []) {
            const useCaseType = typeof row.UseCaseType === 'string' ? row.UseCaseType.trim() : '';
            const useCaseId = typeof row.UseCaseId === 'string' ? row.UseCaseId.trim() : '';
            const stackId = typeof row.StackId === 'string' ? row.StackId.trim() : '';
            if (useCaseType !== 'Workflow' || !useCaseId || !stackId) {
                continue;
            }
            ids.push(useCaseId);
        }
        startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);

    return [...new Set(ids)];
}

/**
 * After platform agent/workflow image rebuild, align every live workflow runtime with SSM
 * (image + AIW_DISABLE_GITHUB_DIRECT + config from use-case AgentRuntimeEnvVars).
 */
export async function syncAllWorkflowRuntimesFromPlatform(): Promise<SyncAllWorkflowRuntimesResult> {
    const useCaseIds = await listAllWorkflowUseCaseIds();
    let synced = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    logger.info('syncAllWorkflowRuntimes: starting', { count: useCaseIds.length });

    for (const useCaseId of useCaseIds) {
        try {
            const probe = await getDeploymentProbe(useCaseId);
            if (!ACTIVE_STACK_STATUSES.has(probe.status)) {
                skipped += 1;
                logger.info('syncAllWorkflowRuntimes: skip inactive stack', {
                    useCaseId,
                    stackStatus: probe.status || 'unknown'
                });
                continue;
            }

            await syncAgentRuntimeEnvFromConfig(useCaseId);
            synced += 1;
            logger.info('syncAllWorkflowRuntimes: synced', { useCaseId });
        } catch (e) {
            failed += 1;
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`${useCaseId}: ${msg}`);
            logger.error('syncAllWorkflowRuntimes: failed', { useCaseId, error: msg });
        }
    }

    const result: SyncAllWorkflowRuntimesResult = {
        ok: failed === 0,
        scanned: useCaseIds.length,
        synced,
        skipped,
        failed,
        errors: errors.slice(0, 25)
    };
    logger.info('syncAllWorkflowRuntimes: complete', result);
    return result;
}
