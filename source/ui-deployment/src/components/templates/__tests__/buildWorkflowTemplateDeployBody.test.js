// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    buildWorkflowTemplateDeployBody,
    getDefaultOrchestratorTemplateModelState,
    getDefaultTemplateWorkflowState,
    parseWorkflowTemplateDeployBody
} from '../buildWorkflowTemplateDeployBody';

describe('buildWorkflowTemplateDeployBody', () => {
    it('defaults orchestrator model state to streaming on', () => {
        expect(getDefaultOrchestratorTemplateModelState().streaming).toBe(true);
    });

    it('emits Streaming true and LongTermEnabled false for feature-orchestrator-style defaults', () => {
        const body = buildWorkflowTemplateDeployBody({
            useCaseName: 'Feature Orchestrator',
            model: getDefaultOrchestratorTemplateModelState(),
            workflow: getDefaultTemplateWorkflowState()
        });

        expect(body.LlmParams.Streaming).toBe(true);
        expect(body.WorkflowParams.MemoryConfig.LongTermEnabled).toBe(false);
        expect(body.UseCaseType).toBe('Workflow');
    });

    it('round-trips streaming and memory through parseWorkflowTemplateDeployBody', () => {
        const body = buildWorkflowTemplateDeployBody({
            useCaseName: 'Test Orchestrator',
            model: { ...getDefaultOrchestratorTemplateModelState(), streaming: false },
            workflow: { ...getDefaultTemplateWorkflowState(), memoryEnabled: true }
        });

        const parsed = parseWorkflowTemplateDeployBody(body);
        expect(parsed.model.streaming).toBe(false);
        expect(parsed.workflow.memoryEnabled).toBe(true);
    });
});
