// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { associateGatewayPolicyEngine } from './agentcore-policy/associate-gateway-policy-engine';
import { compileCedarFromWorkspacePolicy } from './agentcore-policy/compile-cedar-from-workspace-policy';
import { ensurePolicyEngine } from './agentcore-policy/ensure-policy-engine';
import { patchUseCaseAgentCorePolicy } from './agentcore-policy/patch-use-case-agentcore-policy';
import { loadUseCaseConfig } from './agentcore-policy/read-use-case-config';
import { resolveGatewayId } from './agentcore-policy/resolve-gateway-id';
import { resolveMcpGatewayUseCaseId } from './agentcore-policy/resolve-mcp-gateway-use-case-id';
import { resolvePolicyEngineMode } from './agentcore-policy/resolve-policy-engine-mode';
import { upsertCedarPolicies } from './agentcore-policy/upsert-cedar-policy';
import { emitPolicyApplyStatus } from './emit-policy-apply-status';
import { logger } from './power-tools-init';

export type TenantPolicyApplyDetail = {
    tenantTemplateInstanceId: string;
    gaabUseCaseId: string;
    gaabMcpGatewayUseCaseId?: string;
    policyBlock?: string;
    policyVersion: string;
    policy: Record<string, unknown>;
    memoryEnabled: boolean;
    aiwTenantId?: string;
    agentRuntimeArn?: string;
};

export async function runPolicyApply(detail: TenantPolicyApplyDetail): Promise<void> {
    const instanceId = detail.tenantTemplateInstanceId.trim();
    const useCaseId = detail.gaabUseCaseId.trim();
    const policyVersion = detail.policyVersion?.trim() ?? '';

    if (!instanceId || !useCaseId) {
        throw new Error('tenantTemplateInstanceId and gaabUseCaseId are required');
    }
    if (!policyVersion) {
        throw new Error('policyVersion is required');
    }
    if (!detail.policy || typeof detail.policy !== 'object' || Array.isArray(detail.policy)) {
        throw new Error('policy object is required');
    }

    await emitPolicyApplyStatus({
        tenantTemplateInstanceId: instanceId,
        phase: 'policy_apply_started',
        gaabUseCaseId: useCaseId
    });

    try {
        const mcpGatewayUseCaseId = await resolveMcpGatewayUseCaseId({
            gaabMcpGatewayUseCaseId: detail.gaabMcpGatewayUseCaseId,
            gaabUseCaseId: useCaseId,
            aiwTenantId: detail.aiwTenantId
        });
        const gateway = await resolveGatewayId(mcpGatewayUseCaseId);
        const useCaseConfig = await loadUseCaseConfig(useCaseId);

        const policyEngine = await ensurePolicyEngine({
            tenantTemplateInstanceId: instanceId,
            gaabUseCaseId: useCaseId,
            existing: useCaseConfig.agentCorePolicy
                ? {
                      policyEngineId: useCaseConfig.agentCorePolicy.policyEngineId,
                      policyEngineArn: useCaseConfig.agentCorePolicy.policyEngineArn
                  }
                : undefined
        });

        const policyMode = resolvePolicyEngineMode();
        const compiled = compileCedarFromWorkspacePolicy(detail.policy, { gatewayArn: gateway.gatewayArn });
        const cedarPolicies = await upsertCedarPolicies({
            policyEngineId: policyEngine.policyEngineId,
            compiled,
            existingPolicyIds: useCaseConfig.agentCorePolicy?.cedarPolicyIds
        });

        const cedarPolicyIds: Record<string, string> = {};
        for (const [name, ref] of Object.entries(cedarPolicies.byName)) {
            cedarPolicyIds[name] = ref.policyId;
        }

        await associateGatewayPolicyEngine({
            gatewayId: gateway.gatewayId,
            policyEngineArn: policyEngine.policyEngineArn,
            tenantTemplateInstanceId: instanceId,
            mode: policyMode
        });

        const updatedAt = new Date().toISOString();
        await patchUseCaseAgentCorePolicy(useCaseConfig.configKey, useCaseConfig.config, {
            policyEngineId: policyEngine.policyEngineId,
            policyEngineArn: policyEngine.policyEngineArn,
            gatewayId: gateway.gatewayId,
            gatewayArn: gateway.gatewayArn,
            gaabMcpGatewayUseCaseId: mcpGatewayUseCaseId,
            cedarPolicyId: cedarPolicies.primary.policyId,
            cedarPolicyArn: cedarPolicies.primary.policyArn,
            cedarPolicyIds,
            policyVersion,
            policy: detail.policy,
            mode: policyMode,
            updatedAt
        });

        const runtimeArn = detail.agentRuntimeArn?.trim();
        await emitPolicyApplyStatus({
            tenantTemplateInstanceId: instanceId,
            phase: 'policy_apply_complete',
            gaabUseCaseId: useCaseId,
            ...(runtimeArn ? { agentRuntimeArn: runtimeArn } : {}),
            policyEngineArn: policyEngine.policyEngineArn,
            gaabMcpGatewayUseCaseId: mcpGatewayUseCaseId
        });

        logger.info('AgentCore policy apply complete', {
            instanceId,
            useCaseId,
            gatewayId: gateway.gatewayId,
            policyEngineArn: policyEngine.policyEngineArn,
            cedarPolicyId: cedarPolicies.primary.policyId,
            policyMode
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
