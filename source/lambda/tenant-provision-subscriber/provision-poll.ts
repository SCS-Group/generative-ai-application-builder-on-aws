// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    getDeploymentProbe,
    IN_PROGRESS_STACK_STATUSES,
    type UseCaseProbe
} from './provision-stack-probe';
import { logger } from './power-tools-init';

export type { UseCaseProbe, FindUseCaseOptions } from './provision-stack-probe';
export { expectedAgentStackName } from './provision-stack-naming';
export {
    findUseCaseIdByName,
    getDeploymentProbe,
    getUseCaseProbe,
    getUseCaseProbeByStackName,
    IN_PROGRESS_STACK_STATUSES
} from './provision-stack-probe';

export const ACTIVE_STACK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
export const DELETED_STACK_STATUSES = new Set(['DELETE_IN_PROGRESS', 'DELETE_COMPLETE', 'STACK_DELETED']);
export const FAILED_STACK_STATUSES = new Set([
    'CREATE_FAILED',
    'DELETE_FAILED',
    'DELETE_IN_PROGRESS',
    'DELETE_COMPLETE',
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'UPDATE_ROLLBACK_COMPLETE',
    'UPDATE_ROLLBACK_FAILED',
    'STACK_DELETED'
]);

function failureMessageForStatus(status: string): string {
    if (DELETED_STACK_STATUSES.has(status)) {
        return 'Workspace was removed while provisioning (stack is being deleted).';
    }
    return `Stack status: ${status}`;
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
        try {
            const probe = await getDeploymentProbe(useCaseId, useCaseName);
            lastStatus = probe.status || 'pending_stack_link';
            if (ACTIVE_STACK_STATUSES.has(probe.status)) {
                return { ok: true, probe };
            }
            if (FAILED_STACK_STATUSES.has(probe.status)) {
                return { ok: false, message: failureMessageForStatus(probe.status) };
            }
            if (!probe.status || IN_PROGRESS_STACK_STATUSES.has(probe.status)) {
                await sleep(intervalMs);
                continue;
            }
            logger.info('Unexpected stack status while polling; continuing', {
                useCaseId,
                status: probe.status
            });
        } catch (e) {
            logger.warn('Poll tenant deployment status failed', { useCaseId, error: e });
        }
        await sleep(intervalMs);
    }
    return {
        ok: false,
        message: `Timed out waiting for deployment (last status: ${lastStatus || 'unknown'}).`
    };
}
