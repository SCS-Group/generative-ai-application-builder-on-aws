// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type ForbidInputFieldPattern = {
    field: string;
    pattern: string;
};

/**
 * Declarative rule: when active, contributes tool/input patterns to the single workspace tool forbid policy.
 * Add new integrations or risk classes here instead of new compile*Forbid functions.
 */
export type ForbidPatternRule = {
    id: string;
    /** When limits[limitKey] === limitWhenFalse (default false), rule is active. */
    limitKey?: string;
    limitWhenFalse?: boolean;
    toolPatterns?: string[];
    inputFieldPatterns?: ForbidInputFieldPattern[];
    /** When set, any matching policy text activates the rule (back-compat for prose-only policies). */
    textHeuristic?: (text: string) => boolean;
};

export type CollectedForbidPatterns = {
    toolPatterns: string[];
    inputFieldPatterns: ForbidInputFieldPattern[];
    activatedRuleIds: string[];
    explicitPatterns: string[];
};

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function readLimits(value: unknown): Record<string, string | number | boolean | null | string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string | number | boolean | null | string[]> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' || v === null) {
            out[k] = v;
        } else if (Array.isArray(v) && v.every((item) => typeof item === 'string')) {
            out[k] = v.map((item) => item.trim()).filter(Boolean);
        }
    }
    return out;
}

function policyTexts(policy: Record<string, unknown>): string[] {
    return [
        readString(policy.summary),
        ...readStringArray(policy.prohibitedActions),
        ...readStringArray(policy.customRules)
    ].filter(Boolean);
}

export function discordOutboundMentioned(text: string): boolean {
    const lower = text.toLowerCase();
    if (!lower.includes('discord')) return false;
    return (
        /\b(post|send|publish)\b/.test(lower) ||
        lower.includes('never post') ||
        lower.includes('must never post') ||
        lower.includes('do not post')
    );
}

/** Built-in allow* limits and heuristics. Extend this list for new tool classes. */
export const FORBID_PATTERN_REGISTRY: ForbidPatternRule[] = [
    {
        id: 'trade_execution',
        limitKey: 'allowTradeExecution',
        toolPatterns: ['*trade*'],
        inputFieldPatterns: [{ field: 'orderType', pattern: '*trade*' }]
    },
    {
        id: 'discord_posting',
        limitKey: 'allowDiscordPosting',
        toolPatterns: ['*discord*'],
        textHeuristic: discordOutboundMentioned
    },
    {
        id: 'github_merge',
        limitKey: 'allowMerge',
        limitWhenFalse: false,
        toolPatterns: ['*github_merge*']
    },
    {
        id: 'github_create_pull',
        limitKey: 'allowPullRequestCreate',
        limitWhenFalse: false,
        toolPatterns: ['*github_create_pull*']
    },
    {
        id: 'github_pull_review',
        limitKey: 'allowPullRequestReview',
        limitWhenFalse: false,
        toolPatterns: ['*github_create_pull_review*']
    }
];

function limitRuleActive(
    rule: ForbidPatternRule,
    limits: Record<string, string | number | boolean | null | string[]>
): boolean {
    if (!rule.limitKey) return false;
    const expected = rule.limitWhenFalse ?? false;
    return limits[rule.limitKey] === expected;
}

function textRuleActive(rule: ForbidPatternRule, texts: string[]): boolean {
    if (!rule.textHeuristic) return false;
    return texts.some(rule.textHeuristic);
}

function readExplicitForbiddenToolPatterns(
    limits: Record<string, string | number | boolean | null | string[]>
): string[] {
    const raw = limits.forbiddenToolPatterns;
    if (Array.isArray(raw)) {
        return raw.map((p) => p.trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
        return raw
            .split(/[\n,]+/)
            .map((p) => p.trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeToolPattern(pattern: string): string | undefined {
    const trimmed = pattern.trim();
    if (!trimmed) return undefined;
    return trimmed.includes('*') ? trimmed : `*${trimmed}*`;
}

function normalizeInputFieldPattern(field: string, pattern: string): ForbidInputFieldPattern | undefined {
    const normalizedField = field.trim().replace(/[^a-zA-Z0-9_]/g, '');
    const normalizedPattern = normalizeToolPattern(pattern);
    if (!normalizedField || !normalizedPattern) return undefined;
    return { field: normalizedField, pattern: normalizedPattern };
}

function dedupeInputFieldPatterns(patterns: ForbidInputFieldPattern[]): ForbidInputFieldPattern[] {
    const seen = new Set<string>();
    const out: ForbidInputFieldPattern[] = [];
    for (const entry of patterns) {
        const key = `${entry.field}:${entry.pattern}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

export function collectForbidPatterns(policy: Record<string, unknown>): CollectedForbidPatterns {
    const limits = readLimits(policy.limits);
    const texts = policyTexts(policy);
    const toolPatternSet = new Set<string>();
    const inputFieldPatterns: ForbidInputFieldPattern[] = [];
    const activatedRuleIds: string[] = [];

    for (const rule of FORBID_PATTERN_REGISTRY) {
        const active = limitRuleActive(rule, limits) || textRuleActive(rule, texts);
        if (!active) continue;
        activatedRuleIds.push(rule.id);
        for (const pattern of rule.toolPatterns ?? []) {
            const normalized = normalizeToolPattern(pattern);
            if (normalized) toolPatternSet.add(normalized);
        }
        for (const entry of rule.inputFieldPatterns ?? []) {
            const normalized = normalizeInputFieldPattern(entry.field, entry.pattern);
            if (normalized) inputFieldPatterns.push(normalized);
        }
    }

    const explicitPatterns = readExplicitForbiddenToolPatterns(limits).flatMap((pattern) => {
        const normalized = normalizeToolPattern(pattern);
        return normalized ? [normalized] : [];
    });
    for (const pattern of explicitPatterns) {
        toolPatternSet.add(pattern);
    }

    return {
        toolPatterns: [...toolPatternSet],
        inputFieldPatterns: dedupeInputFieldPatterns(inputFieldPatterns),
        activatedRuleIds,
        explicitPatterns
    };
}

function escapeCedarString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function fieldPatternConditions(field: string, patterns: string[]): string[] {
    return patterns.map(
        (pattern) =>
            `(context.input has ${field} && context.input.${field} like "${escapeCedarString(pattern)}")`
    );
}

export function buildToolForbidWhenClause(collected: CollectedForbidPatterns): string | undefined {
    const conditions: string[] = [
        ...fieldPatternConditions('operation', collected.toolPatterns),
        ...fieldPatternConditions('action', collected.toolPatterns),
        ...fieldPatternConditions('tool', collected.toolPatterns),
        ...collected.inputFieldPatterns.map(
            (entry) =>
                `(context.input has ${entry.field} && context.input.${entry.field} like "${escapeCedarString(entry.pattern)}")`
        )
    ];

    if (!conditions.length) return undefined;

    return ['context has input &&', '  (', ...conditions.map((c, i) => `    ${c}${i < conditions.length - 1 ? ' ||' : ''}`), '  )'].join(
        '\n'
    );
}
