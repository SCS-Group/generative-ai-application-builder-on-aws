// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Normalize Amplify / API Gateway errors into a single user-visible string. */
export function templateApiErrorMessage(err: unknown): string {
    if (!err) return 'Request failed';
    if (typeof err === 'string') return err;
    const e = err as {
        message?: string;
        response?: { data?: unknown; status?: number };
    };
    const data = e.response?.data;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const msg = (data as { message?: string }).message;
        if (typeof msg === 'string' && msg.trim()) return msg.trim();
    }
    if (typeof e.message === 'string' && e.message.trim()) {
        const status = e.response?.status;
        return status ? `${e.message.trim()} (HTTP ${status})` : e.message.trim();
    }
    return 'Request failed';
}
