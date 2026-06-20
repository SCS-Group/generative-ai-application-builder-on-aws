// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM,
    isWorkflowContainerUri,
    isWorkflowRuntimeName,
    resolveWorkflowPlatformContainerUri,
    workflowImageUriFromAgentPlatformUri
} from '../platform-workflow-image-uri';

const AGENT_URI =
    '635434164361.dkr.ecr.us-east-1.amazonaws.com/deploymentplatformstack/gaab-strands-agent:v4.1.23-platform';
const WORKFLOW_URI =
    '635434164361.dkr.ecr.us-east-1.amazonaws.com/deploymentplatformstack/gaab-strands-workflow-agent:v4.1.23-platform';

describe('isWorkflowRuntimeName', () => {
    it('detects gaab_workflow_* runtimes', () => {
        expect(isWorkflowRuntimeName('gaab_workflow_ca7e78ec')).toBe(true);
        expect(isWorkflowRuntimeName('gaab_agent_ca7e78ec')).toBe(false);
    });
});

describe('workflowImageUriFromAgentPlatformUri', () => {
    it('swaps repository name and keeps tag', () => {
        expect(workflowImageUriFromAgentPlatformUri(AGENT_URI)).toBe(WORKFLOW_URI);
    });
});

describe('resolveWorkflowPlatformContainerUri', () => {
    it('prefers workflow SSM URI for workflow runtimes', () => {
        expect(
            resolveWorkflowPlatformContainerUri({
                runtimeName: 'gaab_workflow_ca7e78ec',
                platformWorkflowUri: WORKFLOW_URI,
                platformAgentUri: AGENT_URI
            })
        ).toBe(WORKFLOW_URI);
    });

    it('derives workflow URI from agent SSM when workflow SSM is missing', () => {
        expect(
            resolveWorkflowPlatformContainerUri({
                runtimeName: 'gaab_workflow_ca7e78ec',
                platformAgentUri: AGENT_URI
            })
        ).toBe(WORKFLOW_URI);
    });

    it('keeps existing workflow container when SSM params are unavailable', () => {
        expect(
            resolveWorkflowPlatformContainerUri({
                runtimeName: 'gaab_workflow_ca7e78ec',
                currentUri: WORKFLOW_URI
            })
        ).toBe(WORKFLOW_URI);
    });

    it('uses agent URI for non-workflow runtimes', () => {
        expect(
            resolveWorkflowPlatformContainerUri({
                runtimeName: 'gaab_agent_6148084a',
                platformAgentUri: AGENT_URI
            })
        ).toBe(AGENT_URI);
    });

    it('throws when workflow runtime has no resolvable workflow image', () => {
        expect(() =>
            resolveWorkflowPlatformContainerUri({
                runtimeName: 'gaab_workflow_ca7e78ec',
                currentUri: AGENT_URI
            })
        ).toThrow(GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM);
    });
});

describe('isWorkflowContainerUri', () => {
    it('identifies workflow agent images', () => {
        expect(isWorkflowContainerUri(WORKFLOW_URI)).toBe(true);
        expect(isWorkflowContainerUri(AGENT_URI)).toBe(false);
    });
});
