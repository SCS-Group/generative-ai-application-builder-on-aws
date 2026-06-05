// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    GetPolicyCommand,
    GetPolicyEngineCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getAgentCoreControlClient } from './client';
import { logger } from '../power-tools-init';

const ACTIVE_STATUSES = new Set(['ACTIVE']);
const TERMINAL_FAILURE_STATUSES = new Set(['CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED']);

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPolicyEngineActive(policyEngineId: string, timeoutMs = 120_000): Promise<void> {
    const control = getAgentCoreControlClient();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const out = await control.send(new GetPolicyEngineCommand({ policyEngineId }));
        const status = out.status ?? '';
        if (ACTIVE_STATUSES.has(status)) {
            return;
        }
        if (TERMINAL_FAILURE_STATUSES.has(status)) {
            throw new Error(`Policy engine ${policyEngineId} failed with status ${status}`);
        }
        logger.info('Waiting for policy engine ACTIVE', { policyEngineId, status });
        await sleep(2000);
    }

    throw new Error(`Timed out waiting for policy engine ${policyEngineId} to become ACTIVE`);
}

export async function waitForPolicyActive(
    policyEngineId: string,
    policyId: string,
    timeoutMs = 120_000
): Promise<void> {
    const control = getAgentCoreControlClient();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const out = await control.send(new GetPolicyCommand({ policyEngineId, policyId }));
        const status = out.status ?? '';
        if (ACTIVE_STATUSES.has(status)) {
            return;
        }
        if (TERMINAL_FAILURE_STATUSES.has(status)) {
            throw new Error(`Policy ${policyId} failed with status ${status}`);
        }
        logger.info('Waiting for Cedar policy ACTIVE', { policyEngineId, policyId, status });
        await sleep(2000);
    }

    throw new Error(`Timed out waiting for policy ${policyId} to become ACTIVE`);
}
