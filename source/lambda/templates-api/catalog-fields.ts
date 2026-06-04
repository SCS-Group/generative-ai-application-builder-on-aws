// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Default catalog author for templates authored inside GAAB (SCS Group fork). */
export const DEFAULT_TEMPLATE_AUTHOR = 'SCS Group';

/** Structured commercial terms for subscription templates (`marketing.billing.commercial`). */
export const BILLING_COMMERCIAL_SCHEMA_VERSION = '1';

/** Structured commercial terms for session-based subscription templates (`marketing.billing.sessionCommercial`). */
export const BILLING_SESSION_COMMERCIAL_SCHEMA_VERSION = '1';

export function getBillingModel(m: Record<string, unknown>): string {
    const b = m.billing as Record<string, unknown> | undefined;
    const raw = (b && typeof b.model === 'string' && b.model.trim()) || 'contact_sales';
    return raw;
}

function moneyFromCents(cents: unknown): string {
    const n = typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) : NaN;
    if (Number.isNaN(n) || n < 0) {
        return '';
    }
    return (n / 100).toFixed(2);
}

/**
 * Human-readable catalog line derived from `billing.commercial` (and currency / trial).
 * Used to auto-fill `pricing.summary` on publish when empty, and by GAAB UI “Generate summary”.
 */
export function formatPricingSummaryFromCommercial(m: Record<string, unknown>): string {
    const b = m.billing as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') {
        return '';
    }
    const currency = String(b.currency ?? 'USD').trim().toUpperCase() || 'USD';
    const commercial = b.commercial as Record<string, unknown> | undefined;
    if (!commercial || typeof commercial !== 'object') {
        return '';
    }
    const rec = commercial.recurring as Record<string, unknown> | undefined;
    const usage = commercial.usage as Record<string, unknown> | undefined;
    if (!rec || !usage || typeof rec !== 'object' || typeof usage !== 'object') {
        return '';
    }
    const interval = String(rec.interval ?? '').trim().toLowerCase();
    const amountStr = moneyFromCents(rec.amountCents);
    if (!amountStr || (interval !== 'month' && interval !== 'year')) {
        return '';
    }
    const includedUnits =
        typeof usage.includedBillableUnits === 'number' && Number.isFinite(usage.includedBillableUnits)
            ? usage.includedBillableUnits
            : NaN;
    const tpu =
        typeof usage.tokensPerBillableUnit === 'number' && Number.isFinite(usage.tokensPerBillableUnit)
            ? usage.tokensPerBillableUnit
            : NaN;
    const overageStr = moneyFromCents(usage.overageAmountCentsPerBillableUnit);
    if (
        Number.isNaN(includedUnits) ||
        includedUnits < 0 ||
        Number.isNaN(tpu) ||
        tpu < 1 ||
        !overageStr
    ) {
        return '';
    }
    const totalTokens = includedUnits * tpu;
    const period = interval === 'year' ? 'year' : 'month';
    let line = `${amountStr} ${currency} / ${period} — includes ${totalTokens.toLocaleString()} provider tokens (${includedUnits.toLocaleString()} billable units × ${tpu.toLocaleString()} tokens); overage ${currency} ${overageStr} per billable unit.`;
    const trial =
        typeof b.trialPeriodDays === 'number' && Number.isFinite(b.trialPeriodDays) && b.trialPeriodDays > 0
            ? Math.floor(b.trialPeriodDays)
            : null;
    if (trial) {
        line += ` ${trial}-day trial.`;
    }
    return line;
}

/**
 * Human-readable catalog line derived from `billing.sessionCommercial`.
 * Used to auto-fill `pricing.summary` on publish when empty.
 */
export function formatPricingSummaryFromSessionCommercial(m: Record<string, unknown>): string {
    const b = m.billing as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') {
        return '';
    }
    const currency = String(b.currency ?? 'USD').trim().toUpperCase() || 'USD';
    const sessionCommercial = b.sessionCommercial as Record<string, unknown> | undefined;
    if (!sessionCommercial || typeof sessionCommercial !== 'object') {
        return '';
    }
    if (String(sessionCommercial.schemaVersion ?? '') !== BILLING_SESSION_COMMERCIAL_SCHEMA_VERSION) {
        return '';
    }
    const tiersRaw = sessionCommercial.tiers;
    if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
        return '';
    }
    const tiers = tiersRaw
        .map((t) => (t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>) : null))
        .filter(Boolean) as Record<string, unknown>[];
    if (tiers.length === 0) {
        return '';
    }
    const normalized = tiers
        .map((t) => {
            const recurring = t.recurring as Record<string, unknown> | undefined;
            const interval = String(recurring?.interval ?? '').trim().toLowerCase();
            const amountStr = moneyFromCents(recurring?.amountCents);
            const sessions = Number(t.includedSessions);
            if (!amountStr || interval !== 'month') {
                return null;
            }
            if (!Number.isFinite(sessions) || sessions < 1 || Math.round(sessions) !== sessions) {
                return null;
            }
            return { amountCents: Math.round(Number(recurring?.amountCents)), amountStr, sessions: Math.round(sessions) };
        })
        .filter(Boolean) as { amountCents: number; amountStr: string; sessions: number }[];
    if (normalized.length === 0) {
        return '';
    }
    normalized.sort((a, b) => a.amountCents - b.amountCents);
    const first = normalized[0];
    return `From ${first.amountStr} ${currency} / month — includes ${first.sessions.toLocaleString()} sessions.`;
}

export function validateSubscriptionCommercial(m: Record<string, unknown>): void {
    const b = m.billing as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') {
        throw new Error('Publish requires billing when model is subscription.');
    }
    const currency = String(b.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error('Publish requires billing.currency as a 3-letter ISO code (e.g. USD).');
    }
    if (b.trialPeriodDays !== undefined && b.trialPeriodDays !== null) {
        const t = Number(b.trialPeriodDays);
        if (!Number.isFinite(t) || t < 0 || Math.floor(t) !== t) {
            throw new Error('billing.trialPeriodDays must be a non-negative integer when set.');
        }
    }
    const commercial = b.commercial as Record<string, unknown> | undefined;
    if (!commercial || typeof commercial !== 'object') {
        throw new Error('Publish requires billing.commercial for subscription templates.');
    }
    if (String(commercial.schemaVersion ?? '') !== BILLING_COMMERCIAL_SCHEMA_VERSION) {
        throw new Error(`billing.commercial.schemaVersion must be "${BILLING_COMMERCIAL_SCHEMA_VERSION}".`);
    }
    const rec = commercial.recurring as Record<string, unknown> | undefined;
    if (!rec || typeof rec !== 'object') {
        throw new Error('billing.commercial.recurring is required for subscription templates.');
    }
    const interval = String(rec.interval ?? '').trim().toLowerCase();
    if (interval !== 'month' && interval !== 'year') {
        throw new Error('billing.commercial.recurring.interval must be "month" or "year".');
    }
    const amountCents = Number(rec.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || Math.round(amountCents) !== amountCents) {
        throw new Error('billing.commercial.recurring.amountCents must be a positive integer (minor units).');
    }
    const usage = commercial.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== 'object') {
        throw new Error('billing.commercial.usage is required for subscription templates.');
    }
    const included = Number(usage.includedBillableUnits);
    if (!Number.isFinite(included) || included < 0 || Math.round(included) !== included) {
        throw new Error('billing.commercial.usage.includedBillableUnits must be a non-negative integer.');
    }
    const tpu = Number(usage.tokensPerBillableUnit);
    if (!Number.isFinite(tpu) || tpu < 1 || Math.round(tpu) !== tpu) {
        throw new Error('billing.commercial.usage.tokensPerBillableUnit must be a positive integer (e.g. 1000).');
    }
    const overage = Number(usage.overageAmountCentsPerBillableUnit);
    if (!Number.isFinite(overage) || overage < 0 || Math.round(overage) !== overage) {
        throw new Error(
            'billing.commercial.usage.overageAmountCentsPerBillableUnit must be a non-negative integer (per billable unit).'
        );
    }
}

export function validateSessionSubscriptionCommercial(m: Record<string, unknown>): void {
    const b = m.billing as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') {
        throw new Error('Publish requires billing when model is subscription_sessions.');
    }
    const currency = String(b.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error('Publish requires billing.currency as a 3-letter ISO code (e.g. USD).');
    }
    const sessionCommercial = b.sessionCommercial as Record<string, unknown> | undefined;
    if (!sessionCommercial || typeof sessionCommercial !== 'object') {
        throw new Error('Publish requires billing.sessionCommercial for session-based subscriptions.');
    }
    if (String(sessionCommercial.schemaVersion ?? '') !== BILLING_SESSION_COMMERCIAL_SCHEMA_VERSION) {
        throw new Error(
            `billing.sessionCommercial.schemaVersion must be "${BILLING_SESSION_COMMERCIAL_SCHEMA_VERSION}".`
        );
    }
    const modelId = String(sessionCommercial.modelId ?? '').trim();
    if (!modelId) {
        throw new Error('billing.sessionCommercial.modelId is required for session-based subscriptions.');
    }
    const tiersRaw = sessionCommercial.tiers;
    if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
        throw new Error('billing.sessionCommercial.tiers must be a non-empty array.');
    }
    for (let i = 0; i < tiersRaw.length; i++) {
        const t = tiersRaw[i];
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
            throw new Error(`billing.sessionCommercial.tiers[${i}] must be an object.`);
        }
        const tier = t as Record<string, unknown>;
        const tierId = String(tier.tierId ?? '').trim();
        if (!tierId) {
            throw new Error(`billing.sessionCommercial.tiers[${i}].tierId is required.`);
        }
        const name = String(tier.name ?? '').trim();
        if (!name) {
            throw new Error(`billing.sessionCommercial.tiers[${i}].name is required.`);
        }
        const included = Number(tier.includedSessions);
        if (!Number.isFinite(included) || included < 1 || Math.round(included) !== included) {
            throw new Error(`billing.sessionCommercial.tiers[${i}].includedSessions must be a positive integer.`);
        }
        const recurring = tier.recurring as Record<string, unknown> | undefined;
        if (!recurring || typeof recurring !== 'object') {
            throw new Error(`billing.sessionCommercial.tiers[${i}].recurring is required.`);
        }
        const interval = String(recurring.interval ?? '').trim().toLowerCase();
        if (interval !== 'month') {
            throw new Error(`billing.sessionCommercial.tiers[${i}].recurring.interval must be "month".`);
        }
        const amountCents = Number(recurring.amountCents);
        if (!Number.isFinite(amountCents) || amountCents <= 0 || Math.round(amountCents) !== amountCents) {
            throw new Error(`billing.sessionCommercial.tiers[${i}].recurring.amountCents must be a positive integer.`);
        }
    }
}

export function ensureCatalogAuthor(marketing: Record<string, unknown>): void {
    const a = marketing.author;
    if (typeof a !== 'string' || !a.trim()) {
        marketing.author = DEFAULT_TEMPLATE_AUTHOR;
    }
}

/**
 * Build / merge tenant-facing catalog fields (price, SLA, onboarding) into `marketing`.
 * Flat body keys match the deployment dashboard form; nested `marketing` on the body still merges.
 */
export function mergeCatalogIntoMarketing(
    marketing: Record<string, unknown>,
    body: Record<string, unknown>
): Record<string, unknown> {
    const m = { ...marketing };

    if (body.displayName !== undefined) {
        m.displayName = String(body.displayName);
    }
    if (body.shortDescription !== undefined) {
        m.shortDescription = String(body.shortDescription);
    }
    if (body.author !== undefined) {
        m.author = String(body.author);
    }

    const prevPricing = (m.pricing as Record<string, unknown>) || {};
    if (body.pricing !== undefined && typeof body.pricing === 'object' && body.pricing !== null) {
        m.pricing = { ...prevPricing, ...(body.pricing as Record<string, unknown>) };
    } else {
        if (body.pricingSummary !== undefined || body.pricingDetailUrl !== undefined) {
            m.pricing = {
                ...prevPricing,
                ...(body.pricingSummary !== undefined ? { summary: String(body.pricingSummary) } : {}),
                ...(body.pricingDetailUrl !== undefined
                    ? { detailUrl: String(body.pricingDetailUrl) || undefined }
                    : {})
            };
        }
    }

    const prevSla = (m.sla as Record<string, unknown>) || {};
    if (body.sla !== undefined && typeof body.sla === 'object' && body.sla !== null) {
        m.sla = { ...prevSla, ...(body.sla as Record<string, unknown>) };
    } else {
        if (body.slaLink !== undefined || body.slaDocument !== undefined) {
            m.sla = {
                ...prevSla,
                ...(body.slaLink !== undefined ? { link: String(body.slaLink) } : {}),
                ...(body.slaDocument !== undefined ? { document: String(body.slaDocument) } : {})
            };
        }
    }

    if (body.recommendedOnboardingSteps !== undefined) {
        m.recommendedOnboardingSteps = String(body.recommendedOnboardingSteps);
    }

    if (body.billing !== undefined && typeof body.billing === 'object' && body.billing !== null) {
        m.billing = { ...(body.billing as Record<string, unknown>) };
    }

    ensureCatalogAuthor(m);
    return m;
}

/**
 * Full validation before publish: tenants must see cost estimate, SLA reference, and post-deploy steps before commit.
 */
export function validateMarketingForPublish(m: Record<string, unknown>): void {
    const displayName = String(m.displayName ?? '').trim();
    const shortDescription = String(m.shortDescription ?? '').trim();
    if (!displayName) {
        throw new Error('Publish requires displayName.');
    }
    if (!shortDescription) {
        throw new Error('Publish requires shortDescription.');
    }

    const pricing = m.pricing as Record<string, unknown> | undefined;
    const summary = String(pricing?.summary ?? '').trim();
    if (!summary) {
        throw new Error(
            'Publish requires pricing.summary — a short statement of what the tenant pays or how pricing works before they commit.'
        );
    }

    const sla = m.sla as Record<string, unknown> | undefined;
    const link = String(sla?.link ?? '').trim();
    const document = String(sla?.document ?? '').trim();
    if (!link && !document) {
        throw new Error(
            'Publish requires sla.link (URL to SLA or terms) and/or sla.document (inline SLA or terms text).'
        );
    }

    const steps = String(m.recommendedOnboardingSteps ?? '').trim();
    if (!steps) {
        throw new Error(
            'Publish requires recommendedOnboardingSteps — what the tenant should do after the use case is deployed.'
        );
    }

    const model = getBillingModel(m);
    if (model === 'subscription') {
        validateSubscriptionCommercial(m);
    }
    if (model === 'subscription_sessions') {
        validateSessionSubscriptionCommercial(m);
    }
}

export const ORCHESTRATOR_GAAB_VARIANT = 'WorkflowOrchestrator';

const ORCHESTRATOR_VARIANT = ORCHESTRATOR_GAAB_VARIANT;

/** Workflow orchestrator catalog templates skip GAAB test-stack deploy; specialists attach in AIW. */
export function isWorkflowOrchestratorDevops(devops: unknown): boolean {
    if (!devops || typeof devops !== 'object' || Array.isArray(devops)) {
        return false;
    }
    const gaab = (devops as Record<string, unknown>).gaab as Record<string, unknown> | undefined;
    return gaab?.variant === ORCHESTRATOR_GAAB_VARIANT;
}

function validateRequiredToolSlotsForPublish(gaab: Record<string, unknown>): void {
    const orchestrator = gaab.orchestrator as Record<string, unknown> | undefined;
    if (!orchestrator || typeof orchestrator !== 'object') {
        throw new Error('Publish requires devops.gaab.orchestrator for Workflow Orchestrator templates.');
    }
    if (String(orchestrator.schemaVersion ?? '') !== '1') {
        throw new Error('devops.gaab.orchestrator.schemaVersion must be "1".');
    }
    const slots = orchestrator.requiredToolSlots;
    if (!Array.isArray(slots) || slots.length === 0) {
        throw new Error('Publish requires at least one required tool slot (orchestrator requirements).');
    }
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
            throw new Error(`requiredToolSlots[${i}] must be an object.`);
        }
        const s = slot as Record<string, unknown>;
        const slotId = String(s.slotId ?? '').trim();
        const label = String(s.label ?? '').trim();
        const type = String(s.type ?? '').trim();
        if (!slotId || !/^[a-z][a-z0-9_-]*$/.test(slotId)) {
            throw new Error(`requiredToolSlots[${i}].slotId must be a lowercase id (e.g. crm-agent).`);
        }
        if (!label) {
            throw new Error(`requiredToolSlots[${i}].label is required.`);
        }
        if (type !== 'agent') {
            throw new Error(`requiredToolSlots[${i}].type must be "agent".`);
        }
        const catalogId = String(s.catalogAgentTemplateId ?? '').trim();
        const catalogSlug = String(s.catalogTemplateSlug ?? '').trim();
        if (catalogId && !catalogSlug) {
            throw new Error(`requiredToolSlots[${i}].catalogTemplateSlug is required when catalogAgentTemplateId is set.`);
        }
        if (catalogSlug && catalogSlug !== slotId) {
            throw new Error(`requiredToolSlots[${i}].slotId must match catalogTemplateSlug when both are set.`);
        }
    }
}

function validateWorkflowOrchestratorDeployBody(body: Record<string, unknown>): void {
    const workflowParams = body.WorkflowParams as Record<string, unknown> | undefined;
    const systemPrompt = workflowParams?.SystemPrompt;
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
        throw new Error('Publish requires WorkflowParams.SystemPrompt in deployRequestBody (Workflow wizard step).');
    }
    const llm = body.LlmParams;
    if (!llm || typeof llm !== 'object' || Array.isArray(llm)) {
        throw new Error('Publish requires LlmParams in deployRequestBody (Model wizard step).');
    }
    const useCaseType = String(body.UseCaseType ?? '').trim();
    if (useCaseType && useCaseType !== 'Workflow') {
        throw new Error('Orchestrator template deployRequestBody.UseCaseType must be Workflow.');
    }
}

function validateAgentBuilderDeployBody(body: Record<string, unknown>): void {
    const agentParams = body.AgentParams as Record<string, unknown> | undefined;
    const systemPrompt = agentParams?.SystemPrompt;
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
        throw new Error('Publish requires AgentParams.SystemPrompt in deployRequestBody (Agent wizard step).');
    }
    const llm = body.LlmParams;
    if (!llm || typeof llm !== 'object' || Array.isArray(llm)) {
        throw new Error('Publish requires LlmParams in deployRequestBody (Model wizard step).');
    }
    const useCaseType = String(body.UseCaseType ?? '').trim();
    if (useCaseType && useCaseType !== 'AgentBuilder') {
        throw new Error('Template deployRequestBody.UseCaseType must be AgentBuilder for the guided template builder.');
    }
}

/**
 * Ensures AIW provision worker receives a usable deploy body (not `{}`).
 */
export function validateDevopsForPublish(devops: Record<string, unknown>): void {
    const gaab = devops.gaab as Record<string, unknown> | undefined;
    if (!gaab || typeof gaab !== 'object') {
        throw new Error('Publish requires devops.gaab (use the configuration wizard and Generate JSON).');
    }
    const provisioning = gaab.provisioning as Record<string, unknown> | undefined;
    if (!provisioning || typeof provisioning !== 'object') {
        throw new Error('Publish requires devops.gaab.provisioning.');
    }
    const body = provisioning.deployRequestBody as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
        throw new Error(
            'Publish requires devops.gaab.provisioning.deployRequestBody — complete Technical wizard steps, click Generate JSON, then save before publish.'
        );
    }
    const variant = String(gaab.variant ?? '').trim();
    if (variant === ORCHESTRATOR_VARIANT) {
        const deployPath = String(provisioning.deployPath ?? '').trim();
        if (deployPath !== '/deployments/workflows') {
            throw new Error('Orchestrator templates must use deployPath /deployments/workflows.');
        }
        validateWorkflowOrchestratorDeployBody(body);
        validateRequiredToolSlotsForPublish(gaab);
        return;
    }
    validateAgentBuilderDeployBody(body);
}

/** Persist ratings JSON, or `__REMOVE__` when body explicitly sets `ratings: null`. */
export function ratingsFromBody(body: Record<string, unknown>): string | '__REMOVE__' | undefined {
    if (!('ratings' in body)) {
        return undefined;
    }
    const r = body.ratings;
    if (r === null) {
        return '__REMOVE__';
    }
    if (r !== undefined && typeof r === 'object') {
        return JSON.stringify(r);
    }
    return undefined;
}

export function parseRatingsItem(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== 'string' || !raw.trim()) {
        return undefined;
    }
    try {
        const o = JSON.parse(raw) as unknown;
        if (o && typeof o === 'object' && !Array.isArray(o)) {
            return o as Record<string, unknown>;
        }
    } catch {
        return undefined;
    }
    return undefined;
}
