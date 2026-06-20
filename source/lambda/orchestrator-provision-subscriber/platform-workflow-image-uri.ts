// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Written by DeploymentPlatformStack CodeBuild custom resource. */
export const GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM = '/gaab-deployment-platform/GaabStrandsAgentImageUri';

/** Written by DeploymentPlatformStack CodeBuild custom resource (same build as agent image). */
export const GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM = '/gaab-deployment-platform/GaabStrandsWorkflowAgentImageUri';

export const GAAB_STRANDS_AGENT_IMAGE_NAME = 'gaab-strands-agent';
export const GAAB_STRANDS_WORKFLOW_IMAGE_NAME = 'gaab-strands-workflow-agent';

export function isWorkflowRuntimeName(runtimeName: string): boolean {
    return runtimeName.trim().startsWith('gaab_workflow_');
}

/** Derive workflow ECR URI from the platform agent URI (same tag, different repository name). */
export function workflowImageUriFromAgentPlatformUri(agentUri: string): string {
    const trimmed = agentUri.trim();
    const needle = `/${GAAB_STRANDS_AGENT_IMAGE_NAME}:`;
    const idx = trimmed.indexOf(needle);
    if (idx < 0) {
        throw new Error(
            `Platform agent image URI must contain ${needle} (got ${trimmed.slice(0, 120)}...)`
        );
    }
    return (
        trimmed.slice(0, idx + 1) +
        `${GAAB_STRANDS_WORKFLOW_IMAGE_NAME}:` +
        trimmed.slice(idx + needle.length)
    );
}

export function isWorkflowContainerUri(uri: string | undefined): boolean {
    const trimmed = uri?.trim() ?? '';
    return trimmed.includes(`/${GAAB_STRANDS_WORKFLOW_IMAGE_NAME}:`);
}

export type ResolveWorkflowPlatformContainerUriInput = {
    platformWorkflowUri?: string;
    platformAgentUri?: string;
    currentUri?: string;
    runtimeName: string;
};

/**
 * Workflow orchestrator runtimes must use gaab-strands-workflow-agent (not gaab-strands-agent).
 * Prefer the workflow SSM param; fall back to swapping the image name on the agent SSM URI.
 */
export function resolveWorkflowPlatformContainerUri(input: ResolveWorkflowPlatformContainerUriInput): string {
    const { platformWorkflowUri, platformAgentUri, currentUri, runtimeName } = input;

    if (!isWorkflowRuntimeName(runtimeName)) {
        if (!platformAgentUri?.trim()) {
            throw new Error(
                `SSM ${GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM} is missing; run DeploymentPlatformStack platform-deploy first`
            );
        }
        return platformAgentUri.trim();
    }

    const workflowFromSsm = platformWorkflowUri?.trim();
    if (workflowFromSsm && isWorkflowContainerUri(workflowFromSsm)) {
        return workflowFromSsm;
    }

    const agentUri = platformAgentUri?.trim();
    if (agentUri) {
        return workflowImageUriFromAgentPlatformUri(agentUri);
    }

    const existing = currentUri?.trim();
    if (existing && isWorkflowContainerUri(existing)) {
        return existing;
    }

    throw new Error(
        `Workflow runtime ${runtimeName} requires ${GAAB_STRANDS_WORKFLOW_IMAGE_NAME}. ` +
            `Publish SSM ${GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM} (redeploy DeploymentPlatformStack) ` +
            `or ensure ${GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM} is set for derivation.`
    );
}
