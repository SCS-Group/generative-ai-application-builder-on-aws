// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getUseCaseProbe, type UseCaseProbe } from './provision-stack-probe';
import { logger } from './power-tools-init';

export type { UseCaseProbe } from './provision-stack-probe';
export { findUseCaseIdByName } from './provision-stack-probe';

const ACTIVE_STACK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
const FAILED_STACK_STATUSES = new Set([
    'CREATE_FAILED',
    'DELETE_FAILED',
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'UPDATE_ROLLBACK_COMPLETE',
    'UPDATE_ROLLBACK_FAILED',
    'STACK_DELETED'
]);

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForUseCaseReady(
    useCaseId: string,
    maxWaitMs = 600_000,
    intervalMs = 20_000
): Promise<{ ok: true; probe: UseCaseProbe } | { ok: false; message: string }> {
    const deadline = Date.now() + maxWaitMs;
    let lastStatus = '';
    while (Date.now() < deadline) {
        try {
            const probe = await getUseCaseProbe(useCaseId);
            lastStatus = probe.status;
            if (ACTIVE_STACK_STATUSES.has(lastStatus)) {
                return { ok: true, probe };
            }
            if (FAILED_STACK_STATUSES.has(lastStatus)) {
                return { ok: false, message: `Stack status: ${lastStatus}` };
            }
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
