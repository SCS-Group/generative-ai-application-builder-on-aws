// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const ORCHESTRATOR_GAAB_VARIANT = 'WorkflowOrchestrator';

/** Workflow orchestrator catalog templates skip GAAB test deploy; tool slots resolve in AIW. */
export function isOrchestratorCatalogTemplate(item) {
    if (!item || typeof item !== 'object') {
        return false;
    }
    const variant = item?.devops?.gaab?.variant;
    if (variant === ORCHESTRATOR_GAAB_VARIANT) {
        return true;
    }
    return String(item.useCaseType ?? '').trim() === 'Workflow';
}
