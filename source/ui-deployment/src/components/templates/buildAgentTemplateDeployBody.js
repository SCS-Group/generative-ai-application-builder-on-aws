// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createLLMParamsApiParams, createAgentBuilderApiParams } from '../wizard/params-builder';
import {
    DEFAULT_AGENT_SYSTEM_PROMPT,
    DEPLOYMENT_ACTIONS,
    BEDROCK_INFERENCE_TYPES,
    USECASE_TYPES
} from '../../utils/constants';
import { DEFAULT_STEP_INFO, MODEL_FAMILY_PROVIDER_OPTIONS, MODEL_PROVIDER_NAME_MAP } from '../wizard/steps-config';
import { mapModelStepInfoFromDeployment } from '../wizard/utils';

/** Bedrock foundation model for new template drafts (avoid EOL model IDs in examples). */
/** Active on-demand model in us-east-1 (Claude 4+ often requires inference profiles). */
export const DEFAULT_TEMPLATE_BEDROCK_MODEL_ID = 'amazon.nova-pro-v1:0';

/**
 * Builds the POST /deployments/agents body (same shape as the deployment wizard for AgentBuilder).
 * @param {Object} params
 * @param {string} params.useCaseName
 * @param {Object} params.model - Model step shape (see ModelStep / DEFAULT_STEP_INFO.model)
 * @param {Object} params.agentBuilder - { systemPrompt, memoryEnabled, mcpServers, tools }
 */
export function buildAgentTemplateDeployBody({ useCaseName, model, agentBuilder }) {
    const modelStepInfo = {
        ...DEFAULT_STEP_INFO.model,
        ...model,
        modelProvider: model.modelProvider || MODEL_FAMILY_PROVIDER_OPTIONS[0]
    };

    const llmPart = createLLMParamsApiParams(modelStepInfo, {
        isRagEnabled: false,
        deploymentAction: DEPLOYMENT_ACTIONS.CREATE
    });

    const agentPart = createAgentBuilderApiParams(agentBuilder);

    return {
        UseCaseName: useCaseName.trim(),
        UseCaseType: USECASE_TYPES.AGENT_BUILDER,
        ...llmPart,
        ...agentPart
    };
}

export function getDefaultTemplateModelState() {
    return {
        ...DEFAULT_STEP_INFO.model,
        modelProvider: MODEL_FAMILY_PROVIDER_OPTIONS[0],
        bedrockInferenceType: BEDROCK_INFERENCE_TYPES.OTHER_FOUNDATION_MODELS,
        modelName: DEFAULT_TEMPLATE_BEDROCK_MODEL_ID
    };
}

function resolveModelProvider(llmParams) {
    const providerName = llmParams?.ModelProvider || MODEL_PROVIDER_NAME_MAP.Bedrock;
    return (
        MODEL_FAMILY_PROVIDER_OPTIONS.find((option) => option.value === providerName) ??
        MODEL_FAMILY_PROVIDER_OPTIONS[0]
    );
}

function mapAgentParamsFromDeployBody(body) {
    const agentParams = body?.AgentParams || body?.AgentBuilderParams || {};
    const mcpServers =
        agentParams.MCPServers?.map((server) => ({
            useCaseId: server.UseCaseId,
            useCaseName: server.UseCaseName || server.UseCaseId,
            url: server.Url,
            type: server.Type,
            status: 'ACTIVE'
        })) ?? [];
    const tools =
        agentParams.Tools?.map((tool) => ({
            name: '',
            value: tool.ToolId,
            description: '',
            type: 'STRANDS_TOOL'
        })) ?? [];

    return {
        systemPrompt: agentParams.SystemPrompt || DEFAULT_AGENT_SYSTEM_PROMPT,
        memoryEnabled: agentParams.MemoryConfig?.LongTermEnabled || false,
        mcpServers,
        tools
    };
}

/**
 * Hydrates wizard state from a saved deploy request body (POST /deployments/agents shape).
 */
export function parseAgentTemplateDeployBody(deployRequestBody) {
    const body =
        typeof deployRequestBody === 'string' ? JSON.parse(deployRequestBody) : deployRequestBody;
    if (!body || typeof body !== 'object') {
        throw new Error('Deploy request body must be a JSON object.');
    }

    const modelProvider = resolveModelProvider(body.LlmParams);
    return {
        useCaseName: String(body.UseCaseName ?? '').trim(),
        model: mapModelStepInfoFromDeployment(body, modelProvider),
        agentBuilder: mapAgentParamsFromDeployBody(body)
    };
}
