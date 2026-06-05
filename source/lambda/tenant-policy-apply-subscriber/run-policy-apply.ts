// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { syncAgentRuntimeEnvFromConfig } from './sync-agent-runtime-env';
import { emitPolicyApplyStatus } from './emit-policy-apply-status';
import { invokePolicyMemorySeed } from './invoke-policy-memory-seed';
import { patchUseCaseWorkspacePolicy } from './patch-use-case-policy';
import { WORKSPACE_POLICY_MEMORY_ENFORCEMENT_ENV_VAR } from './utils/constants';
import { logger } from './power-tools-init';

function memoryEnforcementEnabled(): boolean {
    const v = process.env[WORKSPACE_POLICY_MEMORY_ENFORCEMENT_ENV_VAR]?.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

export type TenantPolicyApplyDetail = {
    tenantTemplateInstanceId: string;
    gaabUseCaseId: string;
    policyBlock: string;
    policyVersion: string;
    policy: Record<string, unknown>;
    memoryEnabled: boolean;
    aiwTenantId?: string;
    agentRuntimeArn?: string;
};

export async function runPolicyApply(detail: TenantPolicyApplyDetail): Promise<void> {
    const instanceId = detail.tenantTemplateInstanceId.trim();
    const useCaseId = detail.gaabUseCaseId.trim();
    const policyBlock = detail.policyBlock?.trim() ?? '';
    const policyVersion = detail.policyVersion?.trim() ?? '';

    if (!instanceId || !useCaseId) {
        throw new Error('tenantTemplateInstanceId and gaabUseCaseId are required');
    }
    if (!policyBlock || !policyVersion) {
        throw new Error('policyBlock and policyVersion are required');
    }

    await emitPolicyApplyStatus({
        tenantTemplateInstanceId: instanceId,
        phase: 'policy_apply_started',
        gaabUseCaseId: useCaseId
    });

    try {
        await patchUseCaseWorkspacePolicy(useCaseId, {
            policyBlock,
            policyVersion,
            policy: detail.policy,
            memoryEnabled: detail.memoryEnabled === true
        });

        const sync = await syncAgentRuntimeEnvFromConfig(useCaseId);
        const runtimeArn = detail.agentRuntimeArn?.trim() || sync.agentRuntimeArn?.trim();
        const runtimeUserId = detail.aiwTenantId?.trim() || '';

        if (
            detail.memoryEnabled &&
            memoryEnforcementEnabled() &&
            runtimeArn &&
            runtimeUserId
        ) {
            await invokePolicyMemorySeed({
                agentRuntimeArn: runtimeArn,
                runtimeUserId,
                tenantTemplateInstanceId: instanceId,
                policyBlock,
                policyVersion
            });
        } else if (detail.memoryEnabled && memoryEnforcementEnabled()) {
            logger.warn('Skipping policy_memory_seed: missing agentRuntimeArn or aiwTenantId', {
                instanceId,
                hasArn: Boolean(runtimeArn),
                hasTenant: Boolean(runtimeUserId)
            });
        }

        await emitPolicyApplyStatus({
            tenantTemplateInstanceId: instanceId,
            phase: 'policy_apply_complete',
            gaabUseCaseId: useCaseId,
            ...(runtimeArn ? { agentRuntimeArn: runtimeArn } : {})
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error('Policy apply failed', { instanceId, useCaseId, message });
        await emitPolicyApplyStatus({
            tenantTemplateInstanceId: instanceId,
            phase: 'policy_apply_failed',
            message,
            gaabUseCaseId: useCaseId
        });
        throw e;
    }
}
