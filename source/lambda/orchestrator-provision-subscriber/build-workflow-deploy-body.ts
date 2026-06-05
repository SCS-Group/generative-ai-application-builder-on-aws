// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    loadAgentBuilderSnapshotForWorkflow,
    type AgentBuilderWorkflowAgentEntry
} from './load-agent-builder-snapshot';
import {
    normalizeWorkflowAgentEntry,
    resolveOrchestratorLlmParams,
    type OrchestratorLlmOverrides
} from './normalize-workflow-payload';
import { applyPlatformDeployFields } from './platform-deploy-fields';
import { sanitizeCfnStackNameBase } from './sanitize-cfn-stack-name';

export type OrchestratorMemberInput = {
    tenantTemplateInstanceId: string;
    gaabUseCaseId: string;
};

export type BuildWorkflowBodyInput = {
    tenantId: string;
    displayName: string;
    systemPrompt: string;
    useCaseDescription?: string | null;
    tenantAdminEmail?: string | null;
    memoryEnabled?: boolean;
    llmOverrides?: OrchestratorLlmOverrides;
    members: OrchestratorMemberInput[];
};

export type BuildWorkflowBodyResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; message: string };

export async function buildWorkflowDeployBody(input: BuildWorkflowBodyInput): Promise<BuildWorkflowBodyResult> {
    const displayName = input.displayName.trim();
    const systemPrompt = input.systemPrompt.trim();
    const tenantId = input.tenantId.trim();
    const useCaseDescription = input.useCaseDescription?.trim() ?? '';

    if (!displayName) {
        return { ok: false, message: 'Orchestrator display name is required.' };
    }
    if (!systemPrompt) {
        return { ok: false, message: 'Orchestrator system prompt is required.' };
    }
    if (!tenantId) {
        return { ok: false, message: 'Tenant id is required.' };
    }
    if (!input.members.length) {
        return { ok: false, message: 'Select at least one running specialist agent.' };
    }

    const agents: AgentBuilderWorkflowAgentEntry[] = [];
    for (const member of input.members) {
        const gaabUseCaseId = member.gaabUseCaseId?.trim();
        if (!gaabUseCaseId) {
            return { ok: false, message: 'A selected specialist is missing a GAAB use case id.' };
        }
        const loaded = await loadAgentBuilderSnapshotForWorkflow(gaabUseCaseId, tenantId);
        if (!loaded.ok) {
            return { ok: false, message: loaded.message };
        }
        try {
            agents.push(normalizeWorkflowAgentEntry(loaded.agent));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, message: msg || `Could not normalize specialist ${gaabUseCaseId}.` };
        }
    }

    const memoryEnabled = input.memoryEnabled === true;
    const orchestratorLlm = resolveOrchestratorLlmParams(agents, input.llmOverrides);

    const body: Record<string, unknown> = {
        UseCaseName: sanitizeCfnStackNameBase(displayName.slice(0, 200)),
        UseCaseType: 'Workflow',
        TenantId: tenantId,
        DeployUI: true,
        FeedbackParams: {
            FeedbackEnabled: false
        },
        LlmParams: orchestratorLlm,
        WorkflowParams: {
            SystemPrompt: systemPrompt,
            OrchestrationPattern: 'agents-as-tools',
            MemoryConfig: {
                LongTermEnabled: memoryEnabled
            },
            AgentsAsToolsParams: {
                Agents: agents
            }
        }
    };

    if (useCaseDescription) {
        body.UseCaseDescription = useCaseDescription.slice(0, 500);
    }

    const email = input.tenantAdminEmail?.trim();
    if (email) {
        body.DefaultUserEmail = email;
    }

    applyPlatformDeployFields(body);

    body.AgentRuntimeEnvVars = {
        ...(typeof body.AgentRuntimeEnvVars === 'object' &&
        body.AgentRuntimeEnvVars &&
        !Array.isArray(body.AgentRuntimeEnvVars)
            ? (body.AgentRuntimeEnvVars as Record<string, string>)
            : {}),
        AIW_TENANT_ID: tenantId
    };

    return { ok: true, body };
}
