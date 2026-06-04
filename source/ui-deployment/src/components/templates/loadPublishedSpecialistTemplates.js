// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { listTemplates } from '../../services/fetchTemplates';

const WORKFLOW_ORCHESTRATOR_VARIANT = 'WorkflowOrchestrator';

function isSpecialistCatalogTemplate(template, excludeTemplateId) {
    if (!template?.templateId) {
        return false;
    }
    if (excludeTemplateId && template.templateId === excludeTemplateId) {
        return false;
    }
    const variant = template?.devops?.gaab?.variant;
    if (variant === WORKFLOW_ORCHESTRATOR_VARIANT) {
        return false;
    }
    if (String(template?.useCaseType ?? '').trim() === 'Workflow') {
        return false;
    }
    return true;
}

function displayNameFromMarketing(marketing) {
    const name = marketing?.displayName;
    return typeof name === 'string' && name.trim() ? name.trim() : '';
}

/**
 * Loads all published AgentBuilder catalog templates suitable as orchestrator tool slots.
 * @param {string | undefined} excludeTemplateId - Current orchestrator draft (avoid self-reference).
 */
export async function loadPublishedSpecialistTemplates(excludeTemplateId) {
    const all = [];
    let nextPageKey;
    do {
        const res = await listTemplates(50, nextPageKey, 'published');
        all.push(...(res.templates ?? []));
        nextPageKey = res.nextPageKey;
    } while (nextPageKey);

    return all
        .filter((t) => isSpecialistCatalogTemplate(t, excludeTemplateId))
        .map((t) => ({
            templateId: t.templateId,
            slug: String(t.slug ?? '').trim(),
            displayName: displayNameFromMarketing(t.marketing) || String(t.slug ?? '').trim(),
            shortDescription: String(t.marketing?.shortDescription ?? '').trim()
        }))
        .filter((t) => t.slug)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
