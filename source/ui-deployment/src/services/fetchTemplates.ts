// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { API } from 'aws-amplify';
import { API_NAME, TEMPLATES_API_ROUTES } from '@/utils/constants';
import { generateToken } from '@/utils/utils';

export async function listTemplates(limit?: number, nextPageKey?: string) {
    const token = await generateToken();
    const query: Record<string, string> = {};
    if (limit != null) {
        query.limit = String(limit);
    }
    if (nextPageKey) {
        query.nextPageKey = nextPageKey;
    }
    return API.get(API_NAME, TEMPLATES_API_ROUTES.LIST, {
        ...(Object.keys(query).length > 0 ? { queryStringParameters: query } : {}),
        headers: { Authorization: token }
    });
}

export async function createTemplate(body: Record<string, unknown>) {
    const token = await generateToken();
    return API.post(API_NAME, TEMPLATES_API_ROUTES.CREATE, {
        body,
        headers: { Authorization: token }
    });
}

export async function getTemplate(templateId: string) {
    const token = await generateToken();
    return API.get(API_NAME, TEMPLATES_API_ROUTES.get(templateId), {
        headers: { Authorization: token }
    });
}

export async function updateTemplate(templateId: string, body: Record<string, unknown>) {
    const token = await generateToken();
    return API.patch(API_NAME, TEMPLATES_API_ROUTES.update(templateId), {
        body,
        headers: { Authorization: token }
    });
}

export async function publishTemplate(templateId: string, body: Record<string, unknown> = {}) {
    const token = await generateToken();
    return API.post(API_NAME, TEMPLATES_API_ROUTES.publish(templateId), {
        body,
        headers: { Authorization: token }
    });
}

export async function unpublishTemplate(templateId: string, body: Record<string, unknown> = {}) {
    const token = await generateToken();
    return API.post(API_NAME, TEMPLATES_API_ROUTES.unpublish(templateId), {
        body,
        headers: { Authorization: token }
    });
}
