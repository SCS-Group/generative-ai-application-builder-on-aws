// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Keep in sync with source/lambda/templates-api/catalog-fields.ts DIGITAL_WORKER_ROLE_IDS */
export const DIGITAL_WORKER_ROLE_IDS = [
    'property_manager',
    'secretary',
    'portfolio_manager',
    'personal_assistant',
    'travel_coordinator',
    'wedding_coordinator',
    'marketing_manager',
    'software_engineer'
];

export const DIGITAL_WORKER_ROLE_LABELS = {
    property_manager: 'Property manager',
    secretary: 'Secretary',
    portfolio_manager: 'Portfolio manager',
    personal_assistant: 'Personal assistant',
    travel_coordinator: 'Travel coordinator',
    wedding_coordinator: 'Wedding coordinator',
    marketing_manager: 'Marketing manager',
    software_engineer: 'Software engineer'
};

export const DIGITAL_WORKER_ROLE_OPTIONS = DIGITAL_WORKER_ROLE_IDS.map((id) => ({
    label: DIGITAL_WORKER_ROLE_LABELS[id],
    value: id,
    description: 'AIW Policy tab on specialist workspaces uses this role for searchable policy starting points.'
}));

export function digitalWorkerRoleFromDevops(apiTemplate) {
    const gaab = apiTemplate?.devops?.gaab;
    const role = gaab?.specialist?.digitalWorkerRole ?? gaab?.orchestrator?.digitalWorkerRole;
    const trimmed = String(role ?? '').trim();
    return DIGITAL_WORKER_ROLE_IDS.includes(trimmed) ? trimmed : '';
}
