// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mirror explicit workspace policy limits onto the agent runtime env so direct REST
 * GitHub tools (which bypass the MCP gateway) honor the same limits as Cedar forbid rules.
 * Only values present in policy.limits are written; omitted limits mean no runtime block.
 */

export const AIW_POLICY_ALLOW_MERGE_ENV = 'AIW_POLICY_ALLOW_MERGE';
export const AIW_POLICY_ALLOW_PULL_REQUEST_CREATE_ENV = 'AIW_POLICY_ALLOW_PULL_REQUEST_CREATE';
export const AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW_ENV = 'AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW';

const POLICY_LIMIT_ENV_KEYS: ReadonlyArray<readonly [string, string]> = [
    ['allowMerge', AIW_POLICY_ALLOW_MERGE_ENV],
    ['allowPullRequestCreate', AIW_POLICY_ALLOW_PULL_REQUEST_CREATE_ENV],
    ['allowPullRequestReview', AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW_ENV]
];

function readLimits(value: unknown): Record<string, boolean | null> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, boolean | null> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'boolean' || v === null) {
            out[k] = v;
        }
    }
    return out;
}

function limitToEnvValue(value: boolean | null): string {
    return value === true ? 'true' : 'false';
}

export function allPolicyLimitRuntimeEnvKeys(): string[] {
    return POLICY_LIMIT_ENV_KEYS.map(([, envKey]) => envKey);
}

/** Env patch from explicit policy.limits only (no role inference). */
export function policyLimitRuntimeEnvPatch(policy: Record<string, unknown>): Record<string, string> {
    const limits = readLimits(policy.limits);
    const patch: Record<string, string> = {};
    for (const [limitKey, envKey] of POLICY_LIMIT_ENV_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(limits, limitKey)) continue;
        patch[envKey] = limitToEnvValue(limits[limitKey] ?? false);
    }
    return patch;
}

export function clearPolicyLimitRuntimeEnv(
    envVars: Record<string, unknown>
): Record<string, unknown> {
    for (const key of allPolicyLimitRuntimeEnvKeys()) {
        delete envVars[key];
    }
    return envVars;
}
