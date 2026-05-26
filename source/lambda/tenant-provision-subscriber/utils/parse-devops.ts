// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** AIW stores `devops` as AppSync JSON (often a string in EventBridge detail). */
export function parseDevopsRecord(devops: unknown): Record<string, unknown> | null {
    if (devops && typeof devops === 'object' && !Array.isArray(devops)) {
        return devops as Record<string, unknown>;
    }
    if (typeof devops === 'string') {
        try {
            const o = JSON.parse(devops) as unknown;
            if (o && typeof o === 'object' && !Array.isArray(o)) {
                return o as Record<string, unknown>;
            }
        } catch {
            return null;
        }
    }
    return null;
}

export function deployRequestBodyFromDevops(devops: unknown): Record<string, unknown> | undefined {
    const root = parseDevopsRecord(devops);
    const gaab = root?.gaab as Record<string, unknown> | undefined;
    const provisioning = gaab?.provisioning as Record<string, unknown> | undefined;
    const body = provisioning?.deployRequestBody as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
        return undefined;
    }
    return body;
}
