// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export function extractDeployApiErrorMessage(body: string, statusCode?: number): string {
    const trimmed = body.trim();
    if (!trimmed) {
        return statusCode ? `Deployment API returned HTTP ${statusCode}.` : 'Deployment API failed.';
    }

    try {
        const parsed = JSON.parse(trimmed) as { message?: unknown; error?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
            return parsed.message.trim().slice(0, 800);
        }
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
            return parsed.error.trim().slice(0, 800);
        }
    } catch {
        /* plain text body */
    }

    return trimmed.slice(0, 800);
}
