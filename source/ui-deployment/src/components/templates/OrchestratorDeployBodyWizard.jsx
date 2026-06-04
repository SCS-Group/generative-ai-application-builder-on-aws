// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Box,
    Checkbox,
    FormField,
    Input,
    Select,
    SpaceBetween,
    Textarea,
    Wizard
} from '@cloudscape-design/components';
import { BEDROCK_INFERENCE_TYPES } from '../../utils/constants';
import { FieldLabel } from '../commons/field-label';
import { MODEL_FAMILY_PROVIDER_OPTIONS, MODEL_PROVIDER_NAME_MAP } from '../wizard/steps-config';
import {
    buildWorkflowTemplateDeployBody,
    DEFAULT_TEMPLATE_BEDROCK_MODEL_ID,
    getDefaultTemplateModelState,
    getDefaultTemplateWorkflowState,
    parseWorkflowTemplateDeployBody
} from './buildWorkflowTemplateDeployBody';
import TemplateFoundationModelSelect from './TemplateBedrockModelFields';

const BEDROCK_INFERENCE_OPTIONS = [
    { label: 'Foundation / on-demand model (Model ID)', value: BEDROCK_INFERENCE_TYPES.OTHER_FOUNDATION_MODELS },
    { label: 'Inference profile', value: BEDROCK_INFERENCE_TYPES.INFERENCE_PROFILES },
    { label: 'Provisioned / custom model (Model ARN)', value: BEDROCK_INFERENCE_TYPES.PROVISIONED_MODELS }
];

function validateModel(model) {
    if (model.modelProvider.value === MODEL_PROVIDER_NAME_MAP.SageMaker) {
        if (!model.sagemakerEndpointName?.trim()) {
            return 'SageMaker endpoint name is required.';
        }
        try {
            JSON.parse(model.sagemakerInputSchema || '{}');
        } catch {
            return 'SageMaker input schema must be valid JSON.';
        }
        return null;
    }
    const t = model.bedrockInferenceType;
    if (t === BEDROCK_INFERENCE_TYPES.OTHER_FOUNDATION_MODELS && !model.modelName?.trim()) {
        return `Bedrock model ID is required (e.g. ${DEFAULT_TEMPLATE_BEDROCK_MODEL_ID}).`;
    }
    if (t === BEDROCK_INFERENCE_TYPES.INFERENCE_PROFILES && !model.inferenceProfileId?.trim()) {
        return 'Inference profile ID is required.';
    }
    if (t === BEDROCK_INFERENCE_TYPES.PROVISIONED_MODELS && !model.modelArn?.trim()) {
        return 'Model ARN is required for provisioned / custom models.';
    }
    return null;
}

function initialWizardStateFromDeployJson(initialDeployBodyJson) {
    if (initialDeployBodyJson?.trim()) {
        try {
            const parsed = parseWorkflowTemplateDeployBody(initialDeployBodyJson);
            return {
                useCaseName: parsed.useCaseName,
                model: parsed.model,
                workflow: parsed.workflow
            };
        } catch {
            // Fall through to defaults.
        }
    }
    return {
        useCaseName: '',
        model: getDefaultTemplateModelState(),
        workflow: getDefaultTemplateWorkflowState()
    };
}

export default function OrchestratorDeployBodyWizard({
    defaultUseCaseName,
    initialDeployBodyJson,
    onDeployBodyGenerated
}) {
    const [initial] = useState(() => initialWizardStateFromDeployJson(initialDeployBodyJson));
    const [useCaseName, setUseCaseName] = useState(initial.useCaseName);
    const [model, setModel] = useState(initial.model);
    const [systemPrompt, setSystemPrompt] = useState(initial.workflow.systemPrompt);
    const [memoryEnabled, setMemoryEnabled] = useState(initial.workflow.memoryEnabled);
    const [stepErrors, setStepErrors] = useState([null, null, null, null]);
    const [successMessage, setSuccessMessage] = useState(null);

    const buildDeployRequestBody = useCallback(() => {
        return buildWorkflowTemplateDeployBody({
            useCaseName,
            model,
            workflow: { systemPrompt, memoryEnabled }
        });
    }, [useCaseName, model, systemPrompt, memoryEnabled]);

    useEffect(() => {
        if (!onDeployBodyGenerated) {
            return;
        }
        try {
            const body = buildDeployRequestBody();
            onDeployBodyGenerated(JSON.stringify(body, null, 2));
        } catch {
            // Incomplete wizard state.
        }
    }, [buildDeployRequestBody, onDeployBodyGenerated]);

    useEffect(() => {
        const hint = (defaultUseCaseName || '').trim();
        if (!hint) return;
        setUseCaseName((prev) => (prev.trim() === '' ? hint : prev));
    }, [defaultUseCaseName]);

    const clearStepError = (index) => {
        setStepErrors((prev) => {
            const next = [...prev];
            next[index] = null;
            return next;
        });
    };

    const tryAdvanceFromStep = (fromIndex) => {
        if (fromIndex === 0) {
            if (!useCaseName.trim()) {
                setStepErrors((p) => {
                    const n = [...p];
                    n[0] = 'Use case name is required.';
                    return n;
                });
                return false;
            }
            clearStepError(0);
            return true;
        }
        if (fromIndex === 1) {
            const err = validateModel(model);
            if (err) {
                setStepErrors((p) => {
                    const n = [...p];
                    n[1] = err;
                    return n;
                });
                return false;
            }
            clearStepError(1);
            return true;
        }
        if (fromIndex === 2) {
            if (!systemPrompt.trim()) {
                setStepErrors((p) => {
                    const n = [...p];
                    n[2] = 'System prompt is required.';
                    return n;
                });
                return false;
            }
            clearStepError(2);
            return true;
        }
        return true;
    };

    const handleNavigate = (event) => {
        const { detail } = event;
        if (detail.reason === 'next') {
            const leaving = detail.requestedStepIndex - 1;
            if (leaving >= 0 && !tryAdvanceFromStep(leaving)) {
                event.preventDefault();
            }
        }
    };

    const handleSubmit = () => {
        if (!tryAdvanceFromStep(2)) {
            return;
        }
        try {
            const body = buildDeployRequestBody();
            onDeployBodyGenerated(JSON.stringify(body, null, 2));
            setSuccessMessage('Deploy request body was generated.');
        } catch (e) {
            setStepErrors((p) => {
                const n = [...p];
                n[3] = e?.message || String(e);
                return n;
            });
        }
    };

    const modelProviderSelectOptions = MODEL_FAMILY_PROVIDER_OPTIONS.map((o) => ({ label: o.label, value: o.value }));

    const steps = [
        {
            title: 'Use case name',
            description: 'Reference name for this workflow template definition.',
            errorText: stepErrors[0],
            content: (
                <FormField label={<FieldLabel required>Use case name</FieldLabel>}>
                    <Input value={useCaseName} onChange={({ detail }) => setUseCaseName(detail.value)} />
                </FormField>
            )
        },
        {
            title: 'Orchestrator model',
            description: 'Model bound to this template version (session tiers use this model).',
            errorText: stepErrors[1],
            content: (
                <SpaceBetween size="m">
                    <FormField label={<FieldLabel required>Model provider</FieldLabel>}>
                        <Select
                            selectedOption={model.modelProvider}
                            onChange={({ detail }) =>
                                setModel((m) => ({
                                    ...m,
                                    modelProvider: detail.selectedOption
                                }))
                            }
                            options={modelProviderSelectOptions}
                        />
                    </FormField>
                    {model.modelProvider?.value === MODEL_PROVIDER_NAME_MAP.Bedrock ? (
                        <SpaceBetween size="m">
                            <FormField label={<FieldLabel required>Bedrock inference type</FieldLabel>}>
                                <Select
                                    selectedOption={
                                        BEDROCK_INFERENCE_OPTIONS.find((o) => o.value === model.bedrockInferenceType) ??
                                        BEDROCK_INFERENCE_OPTIONS[0]
                                    }
                                    onChange={({ detail }) =>
                                        setModel((m) => ({
                                            ...m,
                                            bedrockInferenceType: detail.selectedOption.value
                                        }))
                                    }
                                    options={BEDROCK_INFERENCE_OPTIONS}
                                />
                            </FormField>
                            {model.bedrockInferenceType === BEDROCK_INFERENCE_TYPES.OTHER_FOUNDATION_MODELS ? (
                                <TemplateFoundationModelSelect model={model} setModel={setModel} />
                            ) : null}
                            {model.bedrockInferenceType === BEDROCK_INFERENCE_TYPES.INFERENCE_PROFILES ? (
                                <FormField label={<FieldLabel required>Inference profile ID</FieldLabel>}>
                                    <Input
                                        value={model.inferenceProfileId}
                                        onChange={({ detail }) =>
                                            setModel((m) => ({ ...m, inferenceProfileId: detail.value }))
                                        }
                                    />
                                </FormField>
                            ) : null}
                            {model.bedrockInferenceType === BEDROCK_INFERENCE_TYPES.PROVISIONED_MODELS ? (
                                <FormField label={<FieldLabel required>Model ARN</FieldLabel>}>
                                    <Input
                                        value={model.modelArn}
                                        onChange={({ detail }) => setModel((m) => ({ ...m, modelArn: detail.value }))}
                                    />
                                </FormField>
                            ) : null}
                        </SpaceBetween>
                    ) : (
                        <FormField label={<FieldLabel required>SageMaker endpoint name</FieldLabel>}>
                            <Input
                                value={model.sagemakerEndpointName}
                                onChange={({ detail }) =>
                                    setModel((m) => ({ ...m, sagemakerEndpointName: detail.value }))
                                }
                            />
                        </FormField>
                    )}
                </SpaceBetween>
            )
        },
        {
            title: 'Workflow client agent',
            description: 'Orchestrator prompt and memory. Specialists are tool slots mapped by tenants in AIW.',
            errorText: stepErrors[2],
            content: (
                <SpaceBetween size="m">
                    <FormField label={<FieldLabel required>System prompt</FieldLabel>}>
                        <Textarea
                            value={systemPrompt}
                            onChange={({ detail }) => setSystemPrompt(detail.value)}
                            rows={8}
                        />
                    </FormField>
                    <Checkbox checked={memoryEnabled} onChange={({ detail }) => setMemoryEnabled(detail.checked)}>
                        Long-term memory (MemoryConfig.LongTermEnabled)
                    </Checkbox>
                    <Alert type="info">
                        Pattern: <strong>Agents as Tools</strong>. Tenant specialists are attached at deploy time via
                        required tool slots.
                    </Alert>
                </SpaceBetween>
            )
        },
        {
            title: 'Generate JSON',
            description: 'POST /deployments/workflows body (Workflow use case, empty Agents list).',
            errorText: stepErrors[3],
            content: (
                <Box variant="p">
                    Click <strong>Generate JSON</strong> to update the deploy request body below.
                </Box>
            )
        }
    ];

    return (
        <SpaceBetween size="m">
            {successMessage ? (
                <Alert type="success" dismissible onDismiss={() => setSuccessMessage(null)}>
                    {successMessage}
                </Alert>
            ) : null}
            <Wizard
                steps={steps}
                submitButtonText="Generate JSON"
                onNavigate={handleNavigate}
                onSubmit={handleSubmit}
                i18nStrings={{
                    stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
                    collapsedStepsLabel: (stepNumber, stepsCount) => `Step ${stepNumber} of ${stepsCount}`,
                    skipToButtonLabel: (step, stepNumber) => `Skip to ${step.title}`,
                    navigationAriaLabel: 'Steps',
                    cancelButton: 'Cancel',
                    previousButton: 'Previous',
                    nextButton: 'Next',
                    optional: ''
                }}
            />
        </SpaceBetween>
    );
};
