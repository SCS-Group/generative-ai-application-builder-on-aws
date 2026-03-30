// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createLLMParamsApiParams, createAgentBuilderApiParams } from '../wizard/params-builder';
import { DEPLOYMENT_ACTIONS, BEDROCK_INFERENCE_TYPES, USECASE_TYPES } from '../../utils/constants';
import { DEFAULT_STEP_INFO, MODEL_FAMILY_PROVIDER_OPTIONS } from '../wizard/steps-config';

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
        bedrockInferenceType: BEDROCK_INFERENCE_TYPES.OTHER_FOUNDATION_MODELS
    };
}
