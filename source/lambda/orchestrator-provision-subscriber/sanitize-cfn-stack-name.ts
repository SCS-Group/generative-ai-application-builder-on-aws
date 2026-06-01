// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export function sanitizeCfnStackNameBase(raw: string, maxLen = 200): string {
    const safe = raw
        .trim()
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    const normalized = safe || 'Agent';
    const startsOk = /^[a-zA-Z]/.test(normalized) ? normalized : `A${normalized}`;
    return startsOk.slice(0, maxLen);
}
