// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type SessionTierStamp = {
    tierId: string;
    includedSessionsPerMonth: number;
};

export type SessionCommercialStamp = {
    modelId: string;
    tiers: SessionTierStamp[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, unknown>;
    }
    if (typeof v === 'string') {
        try {
            const o = JSON.parse(v) as unknown;
            if (o && typeof o === 'object' && !Array.isArray(o)) {
                return o as Record<string, unknown>;
            }
        } catch {
            return null;
        }
    }
    return null;
}

/** Parse `marketing` from TenantProvisionRequested detail for session-based billing. */
export function sessionCommercialFromDetail(detail: Record<string, unknown>): SessionCommercialStamp | null {
    const marketing = asRecord(detail.marketing);
    if (!marketing) {
        return null;
    }
    const billing = asRecord(marketing.billing);
    if (!billing || String(billing.model ?? '').trim() !== 'subscription_sessions') {
        return null;
    }
    const sessionCommercial = asRecord(billing.sessionCommercial);
    if (!sessionCommercial || String(sessionCommercial.schemaVersion ?? '') !== '1') {
        return null;
    }
    const modelId = String(sessionCommercial.modelId ?? '').trim();
    if (!modelId) {
        return null;
    }
    const tiersRaw = sessionCommercial.tiers;
    if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
        return null;
    }
    const tiers: SessionTierStamp[] = [];
    for (const t of tiersRaw) {
        const tier = asRecord(t);
        if (!tier) {
            continue;
        }
        const tierId = String(tier.tierId ?? '').trim();
        const included = Number(tier.includedSessions);
        if (!tierId || !Number.isFinite(included) || included < 1 || Math.round(included) !== included) {
            continue;
        }
        tiers.push({ tierId, includedSessionsPerMonth: Math.round(included) });
    }
    if (tiers.length === 0) {
        return null;
    }
    return { modelId, tiers };
}

/** Stripe subscription metadata tierId, or first tier on template when not stamped. */
export function resolveSessionTierForProvision(
    detail: Record<string, unknown>,
    stamp: SessionCommercialStamp
): SessionTierStamp | null {
    const tierId =
        (typeof detail.sessionTierId === 'string' && detail.sessionTierId.trim()) ||
        (typeof detail.tierId === 'string' && detail.tierId.trim()) ||
        '';
    if (tierId) {
        return stamp.tiers.find((t) => t.tierId === tierId) ?? null;
    }
    return stamp.tiers[0] ?? null;
}
