# AIW template catalog (GAAB) — product plan & release

This document describes **what** the GAAB “Templates” feature stores for **AI Agents Workforce (AIW)** tenants, and **how** this fork ships changes.

## Goals

Before a tenant commits (cost / SLA / checkout in AIW), the catalog must expose:

| Area | Where stored | GAAB UI |
|------|----------------|--------|
| **Price / commercial** | `marketing.pricing.summary` (+ optional `pricing.detailUrl`); complements `marketing.billing` | Yes — author fills before publish |
| **SLA / terms** | `marketing.sla.link` and/or `marketing.sla.document` | Yes |
| **Author** | `marketing.author` | Yes — defaults to **SCS Group** when created in GAAB |
| **Post-deploy onboarding** | `marketing.recommendedOnboardingSteps` (markdown) | Yes |
| **Ratings** | DynamoDB `Ratings` + optional EventBridge `detail.ratings` | **No** — reserved for future tenant ratings in AIW; GAAB APIs do not return it |

**Publish gate (GAAB):** `POST .../publish` runs validation: `displayName`, `shortDescription`, `pricing.summary`, SLA link or document, and non-empty `recommendedOnboardingSteps` must be present. Drafts may omit these.

Canonical field names and lifecycle: **`aiw-saas/contracts/AGENT_TEMPLATE_CONTRACT.md`** (§2 and §2.1).

## Technical pointers

- **API:** `source/lambda/templates-api/` (REST) + CDK routes under `/templates`.
- **Catalog merge helpers:** `source/lambda/templates-api/catalog-fields.ts`.
- **UI:** `source/ui-deployment/src/components/templates/`.
- **Handshake:** `docs/AIW_EVENTBRIDGE.md`.

## Shipping process (this fork / SCS Group)

1. **Branch** — Implement changes on a feature branch (e.g. `feature/template-catalog-fields`).
2. **Pull request** — Open a PR against `main` with a clear description (what changed, why, any schema/event contract updates).
3. **Review** — Address review feedback; ensure `source/lambda/templates-api` builds and infrastructure tests relevant to API/storage pass.
4. **Merge to `main`** — Per team practice, **merge to `main` is the cut for shipped code** (internal deployment pipelines or manual CDK deploy from `main` follow your existing GAAB deployment guide / `README.md` **Deployment** section).

Upstream AWS Solutions GAAB uses its own release train; this document applies to **your** workflow where **`main` is the shipping branch**.
