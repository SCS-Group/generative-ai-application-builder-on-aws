// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CompiledCedarPolicy } from './types';

const WORKSPACE_GOVERNANCE_POLICY_NAME = 'aiw_workspace_governance';

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function readLimits(value: unknown): Record<string, string | number | boolean | null> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' || v === null) {
            out[k] = v;
        }
    }
    return out;
}

function formatLimitComment(limits: Record<string, string | number | boolean | null>): string[] {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(limits)) {
        if (value === null || value === '') continue;
        lines.push(`// limit ${key}: ${value === true ? 'yes' : value === false ? 'no' : String(value)}`);
    }
    return lines;
}

function tradeExecutionForbidden(limits: Record<string, string | number | boolean | null>): boolean {
    return limits.allowTradeExecution === false;
}

function buildResourceClause(gatewayArn?: string): string {
    const arn = gatewayArn?.trim();
    if (!arn) return 'resource';
    return `resource == AgentCore::Gateway::"${arn.replace(/"/g, '\\"')}"`;
}

/**
 * Compiles workspace policy JSON (v2 digital worker policy) into Cedar for AgentCore Policy.
 * Phase 1 uses LOG_ONLY on the gateway; statements are intentionally conservative.
 */
export function compileCedarFromWorkspacePolicy(
    policy: Record<string, unknown>,
    opts?: { gatewayArn?: string }
): CompiledCedarPolicy {
    const title = readString(policy.title) || 'Workspace policy';
    const summary = readString(policy.summary);
    const role = readString(policy.digitalWorkerRole) || 'digital_worker';
    const prohibited = readStringArray(policy.prohibitedActions);
    const customRules = readStringArray(policy.customRules);
    const limits = readLimits(policy.limits);
    const resourceClause = buildResourceClause(opts?.gatewayArn);

    const commentLines = [
        `// AIW workspace policy`,
        `// title: ${title}`,
        `// role: ${role}`,
        ...(summary ? [`// summary: ${summary}`] : []),
        ...formatLimitComment(limits),
        ...prohibited.map((p) => `// prohibited: ${p}`),
        ...customRules.map((r) => `// rule: ${r}`)
    ];

    const statements: string[] = [
        [
            ...commentLines,
            'permit(',
            '  principal,',
            '  action,',
            `  ${resourceClause}`,
            ');'
        ].join('\n')
    ];

    if (tradeExecutionForbidden(limits)) {
        statements.push(
            [
                '// Deny tool actions that look like trade execution when allowTradeExecution is false.',
                'forbid(',
                '  principal,',
                '  action,',
                `  ${resourceClause}`,
                ') when {',
                '  context has input &&',
                '  (',
                '    (context.input has operation && context.input.operation like "*trade*") ||',
                '    (context.input has action && context.input.action like "*trade*") ||',
                '    (context.input has orderType && context.input.orderType like "*trade*")',
                '  )',
                '};'
            ].join('\n')
        );
    }

    return {
        name: WORKSPACE_GOVERNANCE_POLICY_NAME,
        description: `AIW workspace governance (${role}): ${title}`,
        statement: statements.join('\n\n')
    };
}
