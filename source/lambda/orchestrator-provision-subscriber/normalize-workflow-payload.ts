// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_ORCHESTRATOR_MODEL_ID_ENV_VAR } from './utils/constants';
import type { AgentBuilderWorkflowAgentEntry } from './load-agent-builder-snapshot';

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function defaultBedrockModelId(): string {
    return (
        process.env[DEFAULT_ORCHESTRATOR_MODEL_ID_ENV_VAR]?.trim() ||
        'anthropic.claude-3-5-sonnet-20241022-v2:0'
    );
}

export type OrchestratorLlmOverrides = {
    modelId?: string | null;
    temperature?: number | null;
    streaming?: boolean | null;
};

/** GAAB workflow coordinator LlmParams with required ModelParams and Bedrock fields. */
export function defaultOrchestratorLlmParams(overrides?: OrchestratorLlmOverrides): Record<string, unknown> {
    const modelId = overrides?.modelId?.trim() || defaultBedrockModelId();
    const temperature =
        typeof overrides?.temperature === 'number' && Number.isFinite(overrides.temperature)
            ? overrides.temperature
            : 0.7;
    const streaming = typeof overrides?.streaming === 'boolean' ? overrides.streaming : true;

    return {
        ModelProvider: 'Bedrock',
        BedrockLlmParams: {
            ModelId: modelId,
            BedrockInferenceType: 'QUICK_START'
        },
        ModelParams: {},
        Temperature: temperature,
        Streaming: streaming,
        Verbose: false,
        RAGEnabled: false
    };
}

export function normalizeLlmParams(raw: unknown): Record<string, unknown> {
    const llm = asRecord(raw);
    if (!llm) {
        return defaultOrchestratorLlmParams();
    }

    const bedrock = asRecord(llm.BedrockLlmParams) ?? {};
    const modelId =
        typeof bedrock.ModelId === 'string' && bedrock.ModelId.trim()
            ? bedrock.ModelId.trim()
            : defaultBedrockModelId();
    const inferenceType =
        typeof bedrock.BedrockInferenceType === 'string' && bedrock.BedrockInferenceType.trim()
            ? bedrock.BedrockInferenceType.trim()
            : 'QUICK_START';

    const temperature =
        typeof llm.Temperature === 'number' && Number.isFinite(llm.Temperature) ? llm.Temperature : 0.7;
    const streaming = typeof llm.Streaming === 'boolean' ? llm.Streaming : true;
    const verbose = typeof llm.Verbose === 'boolean' ? llm.Verbose : false;
    const ragEnabled = typeof llm.RAGEnabled === 'boolean' ? llm.RAGEnabled : false;

    const normalized: Record<string, unknown> = {
        ModelProvider: typeof llm.ModelProvider === 'string' && llm.ModelProvider.trim() ? llm.ModelProvider : 'Bedrock',
        BedrockLlmParams: {
            ...bedrock,
            ModelId: modelId,
            BedrockInferenceType: inferenceType
        },
        ModelParams: asRecord(llm.ModelParams) ?? {},
        Temperature: temperature,
        Streaming: streaming,
        Verbose: verbose,
        RAGEnabled: ragEnabled
    };

    const multimodal = asRecord(llm.MultimodalParams);
    if (multimodal) {
        normalized.MultimodalParams = multimodal;
    }

    return normalized;
}

export function normalizeAgentBuilderParamsForWorkflow(raw: unknown): Record<string, unknown> {
    const params = asRecord(raw);
    if (!params?.SystemPrompt || typeof params.SystemPrompt !== 'string' || !params.SystemPrompt.trim()) {
        throw new Error('Specialist AgentBuilderParams.SystemPrompt is missing.');
    }

    const memory = asRecord(params.MemoryConfig);
    const longTerm =
        typeof memory?.LongTermEnabled === 'boolean' ? memory.LongTermEnabled : false;

    const normalized: Record<string, unknown> = {
        SystemPrompt: params.SystemPrompt.trim(),
        MemoryConfig: {
            LongTermEnabled: longTerm
        }
    };

    if (Array.isArray(params.MCPServers) && params.MCPServers.length > 0) {
        normalized.MCPServers = params.MCPServers;
    }
    if (Array.isArray(params.Tools) && params.Tools.length > 0) {
        normalized.Tools = params.Tools;
    }

    return normalized;
}

export function normalizeWorkflowAgentEntry(agent: AgentBuilderWorkflowAgentEntry): AgentBuilderWorkflowAgentEntry {
    return {
        UseCaseId: agent.UseCaseId,
        UseCaseType: 'AgentBuilder',
        UseCaseName: agent.UseCaseName,
        ...(agent.UseCaseDescription ? { UseCaseDescription: agent.UseCaseDescription } : {}),
        LlmParams: normalizeLlmParams(agent.LlmParams),
        AgentBuilderParams: normalizeAgentBuilderParamsForWorkflow(agent.AgentBuilderParams)
    };
}

export function resolveOrchestratorLlmParams(
    agents: AgentBuilderWorkflowAgentEntry[],
    overrides?: OrchestratorLlmOverrides
): Record<string, unknown> {
    const explicitModelId = overrides?.modelId?.trim();
    if (explicitModelId) {
        return defaultOrchestratorLlmParams(overrides);
    }
    if (agents.length > 0) {
        const inherited = normalizeLlmParams(agents[0].LlmParams);
        if (typeof overrides?.temperature === 'number' && Number.isFinite(overrides.temperature)) {
            inherited.Temperature = overrides.temperature;
        }
        if (typeof overrides?.streaming === 'boolean') {
            inherited.Streaming = overrides.streaming;
        }
        return inherited;
    }
    return defaultOrchestratorLlmParams(overrides);
}
