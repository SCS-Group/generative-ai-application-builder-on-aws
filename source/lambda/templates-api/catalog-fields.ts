// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Default catalog author for templates authored inside GAAB (SCS Group fork). */
export const DEFAULT_TEMPLATE_AUTHOR = 'SCS Group';

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

    if (body.billing !== undefined && typeof body.billing === 'object') {
        m.billing = { ...(m.billing as Record<string, unknown>), ...(body.billing as Record<string, unknown>) };
    }

    ensureCatalogAuthor(m);
    return m;
}

/**
 * Full validation before publish: tenants must see cost estimate, SLA reference, and post-deploy steps before commit (AIW gate aligns with contract §“Commercial / legal gate”).
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
