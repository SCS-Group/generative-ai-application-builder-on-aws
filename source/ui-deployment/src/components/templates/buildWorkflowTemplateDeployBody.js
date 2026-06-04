// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createLLMParamsApiParams } from '../wizard/params-builder';
import {
    DEFAULT_WORKFLOW_SYSTEM_PROMPT,
    DEPLOYMENT_ACTIONS,
    ORCHESTRATION_PATTERN_TYPES,
    USECASE_TYPES
} from '../../utils/constants';
import { DEFAULT_STEP_INFO, MODEL_FAMILY_PROVIDER_OPTIONS, MODEL_PROVIDER_NAME_MAP } from '../wizard/steps-config';
import { mapModelStepInfoFromDeployment, mapWorkflowStepInfoFromDeployment } from '../wizard/utils';
import {
    DEFAULT_TEMPLATE_BEDROCK_MODEL_ID,
    getDefaultTemplateModelState
} from './buildAgentTemplateDeployBody';

/**
 * Builds POST /deployments/workflows body for orchestrator templates (no tenant agents yet).
 */
export function buildWorkflowTemplateDeployBody({ useCaseName, model, workflow }) {
    const modelStepInfo = {
        ...DEFAULT_STEP_INFO.model,
        ...model,
        modelProvider: model.modelProvider || MODEL_FAMILY_PROVIDER_OPTIONS[0]
    };

    const llmPart = createLLMParamsApiParams(modelStepInfo, {
        isRagEnabled: false,
        deploymentAction: DEPLOYMENT_ACTIONS.CREATE
    });

    return {
        UseCaseName: useCaseName.trim(),
        UseCaseType: USECASE_TYPES.WORKFLOW,
        ...llmPart,
        WorkflowParams: {
            SystemPrompt: workflow.systemPrompt?.trim() || DEFAULT_WORKFLOW_SYSTEM_PROMPT,
            OrchestrationPattern: ORCHESTRATION_PATTERN_TYPES.AGENTS_AS_TOOLS,
            MemoryConfig: {
                LongTermEnabled: Boolean(workflow.memoryEnabled)
            },
            AgentsAsToolsParams: {
                Agents: []
            }
        }
    };
}

export function getDefaultTemplateWorkflowState() {
    return {
        systemPrompt: DEFAULT_WORKFLOW_SYSTEM_PROMPT,
        memoryEnabled: false
    };
}

function resolveModelProvider(llmParams) {
    const providerName = llmParams?.ModelProvider || MODEL_PROVIDER_NAME_MAP.Bedrock;
    return (
        MODEL_FAMILY_PROVIDER_OPTIONS.find((option) => option.value === providerName) ??
        MODEL_FAMILY_PROVIDER_OPTIONS[0]
    );
}

export function parseWorkflowTemplateDeployBody(deployRequestBody) {
    const body =
        typeof deployRequestBody === 'string' ? JSON.parse(deployRequestBody) : deployRequestBody;
    if (!body || typeof body !== 'object') {
        throw new Error('Deploy request body must be a JSON object.');
    }

    const modelProvider = resolveModelProvider(body.LlmParams);
    const workflow = mapWorkflowStepInfoFromDeployment(body);

    return {
        useCaseName: String(body.UseCaseName ?? '').trim(),
        model: mapModelStepInfoFromDeployment(body, modelProvider),
        workflow: {
            systemPrompt: workflow.systemPrompt,
            memoryEnabled: workflow.memoryEnabled
        }
    };
}

export { DEFAULT_TEMPLATE_BEDROCK_MODEL_ID, getDefaultTemplateModelState };
