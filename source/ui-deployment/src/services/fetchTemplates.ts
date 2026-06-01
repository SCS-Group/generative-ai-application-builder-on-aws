// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { API } from 'aws-amplify';
import { API_NAME, TEMPLATES_API_ROUTES } from '@/utils/constants';
import { generateToken } from '@/utils/utils';
import { templateApiErrorMessage } from './templateApiError';

async function templatesPost(path: string, body?: Record<string, unknown>) {
    const token = await generateToken();
    try {
        return await API.post(API_NAME, path, {
            ...(body !== undefined ? { body } : {}),
            headers: { Authorization: token }
        });
    } catch (err) {
        throw new Error(templateApiErrorMessage(err));
    }
}

async function templatesGet(path: string, query?: Record<string, string>) {
    const token = await generateToken();
    try {
        return await API.get(API_NAME, path, {
            ...(query && Object.keys(query).length > 0 ? { queryStringParameters: query } : {}),
            headers: { Authorization: token }
        });
    } catch (err) {
        throw new Error(templateApiErrorMessage(err));
    }
}

export type TemplateListStatusFilter = 'published' | 'draft' | 'archived';

export async function listTemplates(
    limit?: number,
    nextPageKey?: string,
    statusFilter: TemplateListStatusFilter = 'published'
) {
    const query: Record<string, string> = { statusFilter };
    if (limit != null) {
        query.limit = String(limit);
    }
    if (nextPageKey) {
        query.nextPageKey = nextPageKey;
    }
    return templatesGet(TEMPLATES_API_ROUTES.LIST, query);
}

export async function createTemplate(body: Record<string, unknown>) {
    return templatesPost(TEMPLATES_API_ROUTES.CREATE, body);
}

export async function getTemplate(templateId: string) {
    return templatesGet(TEMPLATES_API_ROUTES.get(templateId));
}

export async function updateTemplate(templateId: string, body: Record<string, unknown>) {
    const token = await generateToken();
    try {
        return await API.patch(API_NAME, TEMPLATES_API_ROUTES.update(templateId), {
            body,
            headers: { Authorization: token }
        });
    } catch (err) {
        throw new Error(templateApiErrorMessage(err));
    }
}

export async function publishTemplate(templateId: string, body: Record<string, unknown> = {}) {
    return templatesPost(TEMPLATES_API_ROUTES.publish(templateId), body);
}

export async function unpublishTemplate(templateId: string, body: Record<string, unknown> = {}) {
    return templatesPost(TEMPLATES_API_ROUTES.unpublish(templateId), body);
}

export async function startTemplateTesting(templateId: string) {
    return templatesPost(TEMPLATES_API_ROUTES.startTesting(templateId));
}

export async function cancelTemplateTesting(templateId: string) {
    return templatesPost(TEMPLATES_API_ROUTES.cancelTesting(templateId));
}

export async function restartTemplateTesting(templateId: string) {
    return templatesPost(TEMPLATES_API_ROUTES.restartTesting(templateId));
}

export async function markTemplateTestingValidated(templateId: string) {
    return templatesPost(TEMPLATES_API_ROUTES.markTestingValidated(templateId));
}

export async function refreshTemplateTestingStatus(templateId: string) {
    return templatesPost(TEMPLATES_API_ROUTES.refreshTestingStatus(templateId));
}
