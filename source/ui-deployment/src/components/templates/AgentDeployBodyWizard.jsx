// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Checkbox,
    FormField,
    Input,
    Multiselect,
    Select,
    SpaceBetween,
    StatusIndicator,
    Textarea,
    Wizard
} from '@cloudscape-design/components';
import {
    BEDROCK_INFERENCE_TYPES,
    DEFAULT_AGENT_SYSTEM_PROMPT,
    USECASE_TYPES
} from '../../utils/constants';
import { useAgentResourcesQuery } from '../../hooks/useQueries';
import { MODEL_FAMILY_PROVIDER_OPTIONS, MODEL_PROVIDER_NAME_MAP } from '../wizard/steps-config';
import { buildAgentTemplateDeployBody, getDefaultTemplateModelState } from './buildAgentTemplateDeployBody';

const BEDROCK_INFERENCE_OPTIONS = [
    { label: 'Foundation / on-demand model (Model ID)', value: BEDROCK_INFERENCE_TYPES.OTHER_FOUNDATION_MODELS },
    { label: 'Inference profile', value: BEDROCK_INFERENCE_TYPES.INFERENCE_PROFILES },
    { label: 'Provisioned / custom model (Model ARN)', value: BEDROCK_INFERENCE_TYPES.PROVISIONED_MODELS }
];

function findMcpServerData(formattedResources, selectedValue) {
    const mcpServerOption = formattedResources
        .find((group) => group.label === 'MCP Servers')
        ?.options?.find((option) => option.value === selectedValue);
    if (mcpServerOption) {
        return {
            useCaseId: mcpServerOption.useCaseId,
            useCaseName: mcpServerOption.useCaseName,
            description: mcpServerOption.serverDescription,
            url: mcpServerOption.url,
            type: mcpServerOption.type,
            status: mcpServerOption.status
        };
    }
    return null;
}

function findStrandsToolData(formattedResources, selectedValue) {
    const toolOption = formattedResources
        .find((group) => group.label === 'Tools provided out of the box')
        ?.options?.find((option) => option.value === selectedValue);
    if (toolOption) {
        return {
            name: toolOption.label,
            description: toolOption.description,
            value: toolOption.value,
            type: 'STRANDS_TOOL'
        };
    }
    return null;
}

function processAgentResourceSelection(selectedOptions, formattedResources) {
    const mcpServers = [];
    const tools = [];
    selectedOptions.forEach((opt) => {
        const mcp = findMcpServerData(formattedResources, opt.value);
        if (mcp) {
            mcpServers.push(mcp);
            return;
        }
        const t = findStrandsToolData(formattedResources, opt.value);
        if (t) tools.push(t);
    });
    return { mcpServers, tools };
}

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
        return 'Bedrock model ID is required (e.g. anthropic.claude-3-5-sonnet-20240620-v1:0).';
    }
    if (t === BEDROCK_INFERENCE_TYPES.INFERENCE_PROFILES && !model.inferenceProfileId?.trim()) {
        return 'Inference profile ID is required.';
    }
    if (t === BEDROCK_INFERENCE_TYPES.PROVISIONED_MODELS && !model.modelArn?.trim()) {
        return 'Model ARN is required for provisioned / custom models.';
    }
    if (model.enableGuardrails) {
        if (!model.guardrailIdentifier?.trim() || !model.guardrailVersion?.trim()) {
            return 'Guardrail identifier and version are both required when guardrails are enabled.';
        }
    }
    return null;
}

/**
 * Guided flow to build the same JSON body as POST /deployments/agents for AgentBuilder.
 */
export default function AgentDeployBodyWizard({ defaultUseCaseName, onDeployBodyGenerated }) {
    const [useCaseName, setUseCaseName] = useState('');
    const [model, setModel] = useState(() => getDefaultTemplateModelState());
    const [systemPrompt, setSystemPrompt] = useState(DEFAULT_AGENT_SYSTEM_PROMPT);
    const [memoryEnabled, setMemoryEnabled] = useState(false);
    const [mcpServers, setMcpServers] = useState([]);
    const [tools, setTools] = useState([]);
    const [stepErrors, setStepErrors] = useState([null, null, null, null]);
    const [successMessage, setSuccessMessage] = useState(null);

    const { data: agentResources, isPending, isError, error } = useAgentResourcesQuery();
    const formattedResources = agentResources?.formatted;

    useEffect(() => {
        const hint = (defaultUseCaseName || '').trim();
        if (!hint) return;
        setUseCaseName((prev) => (prev.trim() === '' ? hint : prev));
    }, [defaultUseCaseName]);

    const multiselectSelected = useMemo(() => {
        if (!formattedResources) return [];
        const mcpOpts = (mcpServers || []).map((server) => ({
            label: `${String(server.type).toUpperCase()}: ${server.useCaseName}`,
            value: server.useCaseId,
            description: server.description || server.url
        }));
        const toolOpts = (tools || []).map((tool) => ({
            label: tool.name,
            value: tool.value,
            description: tool.description
        }));
        return [...mcpOpts, ...toolOpts];
    }, [mcpServers, tools, formattedResources]);

    const onResourcesChange = useCallback(
        (detail) => {
            if (!formattedResources) return;
            const { mcpServers: nextMcp, tools: nextTools } = processAgentResourceSelection(
                detail.selectedOptions,
                formattedResources
            );
            setMcpServers(nextMcp);
            setTools(nextTools);
        },
        [formattedResources]
    );

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
                    n[0] = 'Provisioned use case name is required.';
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
        // Only block sequential Next; step links / skip do not run intermediate validation.
        if (detail.reason === 'next') {
            const leaving = detail.requestedStepIndex - 1;
            if (leaving >= 0 && !tryAdvanceFromStep(leaving)) {
                event.preventDefault();
            }
        }
    };

    const handleSubmit = () => {
        setStepErrors((p) => {
            const n = [...p];
            n[3] = null;
            return n;
        });
        if (!tryAdvanceFromStep(2)) {
            return;
        }
        try {
            const body = buildAgentTemplateDeployBody({
                useCaseName,
                model,
                agentBuilder: {
                    systemPrompt,
                    memoryEnabled,
                    mcpServers,
                    tools
                }
            });
            const json = JSON.stringify(body, null, 2);
            onDeployBodyGenerated(json);
            setSuccessMessage('Deploy request body was generated. You can edit raw JSON below if needed.');
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
            title: 'Provisioned use case name',
            description:
                'This becomes UseCaseName in the deploy payload — the display name for the agent instance for the tenant (same as in the deployment wizard).',
            errorText: stepErrors[0],
            content: (
                <FormField label="Use case name" description="Required. Shown to operators and mapped to UseCaseName in POST /deployments/agents.">
                    <Input value={useCaseName} onChange={({ detail }) => setUseCaseName(detail.value)} />
                </FormField>
            )
        },
        {
            title: 'Model (LLM)',
            description: 'Same fields as the “Select model” step for AgentBuilder deployments. Uses Bedrock or SageMaker.',
            errorText: stepErrors[1],
            content: (
                <SpaceBetween size="m">
                    <FormField label="Model provider">
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
                            <FormField label="Bedrock inference type">
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
                                <FormField
                                    label="Model ID"
                                    description="Foundation model ID, e.g. anthropic.claude-3-5-sonnet-20240620-v1:0"
                                >
                                    <Input value={model.modelName} onChange={({ detail }) => setModel((m) => ({ ...m, modelName: detail.value }))} />
                                </FormField>
                            ) : null}
                            {model.bedrockInferenceType === BEDROCK_INFERENCE_TYPES.INFERENCE_PROFILES ? (
                                <FormField label="Inference profile ID">
                                    <Input
                                        value={model.inferenceProfileId}
                                        onChange={({ detail }) => setModel((m) => ({ ...m, inferenceProfileId: detail.value }))}
                                    />
                                </FormField>
                            ) : null}
                            {model.bedrockInferenceType === BEDROCK_INFERENCE_TYPES.PROVISIONED_MODELS ? (
                                <FormField label="Model ARN">
                                    <Input value={model.modelArn} onChange={({ detail }) => setModel((m) => ({ ...m, modelArn: detail.value }))} />
                                </FormField>
                            ) : null}
                            <FormField label="Temperature">
                                <Input
                                    type="number"
                                    step={0.1}
                                    value={String(model.temperature)}
                                    onChange={({ detail }) => setModel((m) => ({ ...m, temperature: parseFloat(detail.value) || 0 }))}
                                />
                            </FormField>
                            <Checkbox checked={model.streaming} onChange={({ detail }) => setModel((m) => ({ ...m, streaming: detail.checked }))}>
                                Streaming
                            </Checkbox>
                            <Checkbox checked={model.verbose} onChange={({ detail }) => setModel((m) => ({ ...m, verbose: detail.checked }))}>
                                Verbose
                            </Checkbox>
                            <Checkbox
                                checked={model.enableGuardrails}
                                onChange={({ detail }) => setModel((m) => ({ ...m, enableGuardrails: detail.checked }))}
                            >
                                Enable Bedrock guardrails
                            </Checkbox>
                            {model.enableGuardrails ? (
                                <SpaceBetween size="s">
                                    <FormField label="Guardrail identifier">
                                        <Input
                                            value={model.guardrailIdentifier}
                                            onChange={({ detail }) => setModel((m) => ({ ...m, guardrailIdentifier: detail.value }))}
                                        />
                                    </FormField>
                                    <FormField label="Guardrail version">
                                        <Input
                                            value={model.guardrailVersion}
                                            onChange={({ detail }) => setModel((m) => ({ ...m, guardrailVersion: detail.value }))}
                                        />
                                    </FormField>
                                </SpaceBetween>
                            ) : null}
                        </SpaceBetween>
                    ) : (
                        <SpaceBetween size="m">
                            <FormField label="SageMaker endpoint name">
                                <Input
                                    value={model.sagemakerEndpointName}
                                    onChange={({ detail }) => setModel((m) => ({ ...m, sagemakerEndpointName: detail.value }))}
                                />
                            </FormField>
                            <FormField label="Model input payload schema (JSON)" description="JSON schema for the endpoint input.">
                                <Textarea
                                    value={model.sagemakerInputSchema}
                                    onChange={({ detail }) => setModel((m) => ({ ...m, sagemakerInputSchema: detail.value }))}
                                    rows={6}
                                />
                            </FormField>
                            <FormField label="Model output JSONPath" description="Optional; path to model text in the response.">
                                <Input
                                    value={model.sagemakerOutputSchema}
                                    onChange={({ detail }) => setModel((m) => ({ ...m, sagemakerOutputSchema: detail.value }))}
                                />
                            </FormField>
                            <FormField label="Temperature">
                                <Input
                                    type="number"
                                    step={0.1}
                                    value={String(model.temperature)}
                                    onChange={({ detail }) => setModel((m) => ({ ...m, temperature: parseFloat(detail.value) || 0 }))}
                                />
                            </FormField>
                            <Checkbox checked={model.streaming} onChange={({ detail }) => setModel((m) => ({ ...m, streaming: detail.checked }))}>
                                Streaming
                            </Checkbox>
                            <Checkbox checked={model.verbose} onChange={({ detail }) => setModel((m) => ({ ...m, verbose: detail.checked }))}>
                                Verbose
                            </Checkbox>
                        </SpaceBetween>
                    )}
                </SpaceBetween>
            )
        },
        {
            title: 'Agent configuration',
            description: 'System prompt, memory, MCP servers, and Strands tools — same as the AgentBuilder wizard.',
            errorText: stepErrors[2],
            content: (
                <SpaceBetween size="m">
                    <FormField label="System prompt" description="Required. Becomes AgentParams.SystemPrompt.">
                        <Textarea value={systemPrompt} onChange={({ detail }) => setSystemPrompt(detail.value)} rows={10} />
                    </FormField>
                    <Checkbox checked={memoryEnabled} onChange={({ detail }) => setMemoryEnabled(detail.checked)}>
                        Long-term memory (MemoryConfig.LongTermEnabled)
                    </Checkbox>
                    <FormField
                        label="MCP servers and tools"
                        description="Optional. Lists match deployed MCP servers and built-in tools from the same API as the deployment wizard."
                    >
                        {isPending ? <StatusIndicator type="loading">Loading MCP servers and tools…</StatusIndicator> : null}
                        {isError ? (
                            <Alert type="error" header="Could not load resources">
                                {error?.message || String(error)}
                            </Alert>
                        ) : null}
                        {!isPending && !isError && formattedResources ? (
                            <Multiselect
                                selectedOptions={multiselectSelected}
                                onChange={({ detail }) => onResourcesChange(detail)}
                                deselectAriaLabel={(e) => `Remove ${e.label}`}
                                options={formattedResources}
                                placeholder="Choose MCP servers and tools"
                                selectedAriaLabel="Selected"
                            />
                        ) : null}
                    </FormField>
                </SpaceBetween>
            )
        },
        {
            title: 'Generate JSON',
            description:
                'Produces the exact body shape required for POST /deployments/agents (UseCaseName, UseCaseType, LlmParams, AgentParams). UseCaseType is AgentBuilder.',
            errorText: stepErrors[3],
            content: (
                <SpaceBetween size="m">
                    <Box variant="p">
                        <strong>Use case name:</strong> {useCaseName || '—'}
                    </Box>
                    <Box variant="p">
                        <strong>Provider:</strong> {model.modelProvider?.label || '—'}
                    </Box>
                    <Box variant="p">
                        <strong>Use case type in JSON:</strong> {USECASE_TYPES.AGENT_BUILDER}
                    </Box>
                    <Box variant="p">Click <strong>Generate JSON</strong> to load the deploy request body into the field below the wizard.</Box>
                </SpaceBetween>
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
                    optional: 'optional'
                }}
            />
        </SpaceBetween>
    );
}
