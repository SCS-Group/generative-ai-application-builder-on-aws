// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    CloudFormationClient,
    DescribeStacksCommand,
    StackStatus
} from '@aws-sdk/client-cloudformation';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { logger } from './power-tools-init';

const cfn = new CloudFormationClient(customAwsConfig());

export type StackDeletionWaitResult = 'deleted' | 'failed' | 'timeout';

const DELETE_COMPLETE: StackStatus = 'DELETE_COMPLETE';
const DELETE_FAILED: StackStatus = 'DELETE_FAILED';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stackNameFromId(stackId: string): string {
    const trimmed = stackId.trim();
    if (!trimmed) {
        return trimmed;
    }
    const slash = trimmed.lastIndexOf('/');
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isStackNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const name = 'name' in error ? String((error as { name?: string }).name) : '';
    const message = 'message' in error ? String((error as { message?: string }).message) : '';
    return name === 'ValidationError' && message.toLowerCase().includes('does not exist');
}

/**
 * Poll CloudFormation until the stack is gone or delete failed.
 * Used after permanent delete is invoked so MCP gateways are gone before agent stack teardown.
 */
export async function waitForStackDeletion(
    stackId: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number }
): Promise<StackDeletionWaitResult> {
    const maxWaitMs = options?.maxWaitMs ?? 12 * 60 * 1000;
    const pollIntervalMs = options?.pollIntervalMs ?? 15_000;
    const stackName = stackNameFromId(stackId);
    if (!stackName) {
        return 'deleted';
    }

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
            const status = resp.Stacks?.[0]?.StackStatus;
            if (status === DELETE_COMPLETE) {
                return 'deleted';
            }
            if (status === DELETE_FAILED) {
                logger.error('Stack delete failed', { stackName, stackStatusReason: resp.Stacks?.[0]?.StackStatusReason });
                return 'failed';
            }
        } catch (error) {
            if (isStackNotFound(error)) {
                return 'deleted';
            }
            throw error;
        }
        await sleep(pollIntervalMs);
    }

    logger.warn('Timed out waiting for stack deletion', { stackName, maxWaitMs });
    return 'timeout';
}
