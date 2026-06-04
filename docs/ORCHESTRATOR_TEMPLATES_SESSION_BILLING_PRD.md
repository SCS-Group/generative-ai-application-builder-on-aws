# GAAB Orchestrator Templates + AIW Catalog + Session-Based Billing (PRD)
Last updated: 2026-06-02

## Summary
We will add a **customer-facing Orchestrator Template** authoring and publishing flow in **GAAB** that publishes to the **AIW public catalog**. Orchestrator Templates are **model-bound per published version** (changing model creates a new version). Commercial terms for these templates are **subscription tiers priced per month with included sessions**, where a **session** is defined as:

- **Session start**: the **first run/launch of an orchestrator execution for an end-user request**.

We will implement **new session-based billing metering** that is **separate** from existing token/usage metering and is keyed by **`tenantId`** and **`modelId`**, plus the published template identity (catalog item + template version).

## Goals
- **GAAB Admins** can create and publish **Orchestrator Templates** to the AIW catalog.
- Published Orchestrator Templates expose **model-bound session-tier pricing** to AIW (tiers are **flexible**, not hardcoded).
- AIW public catalog listing shows tiers **based on the template’s published model** (no model selection at subscribe time).
- AIW users can subscribe, map required tool slots, deploy, and run.
- A new **session-based billing meter** enforces quotas and records usage with **`tenantId`** + **`modelId`** for price attribution.

## Non-goals
- Replacing existing GAAB token/usage metering (leave it unchanged).
- Building a new workflow runtime (reuse existing GAAB workflow/use-case runtime).
- Supporting “multi-model within one template version” (explicitly not supported; model change ⇒ new version).

## Key decisions (locked)
- **Catalog visibility**: **everyone can buy** (AIW public catalog).
- **Model change**: changing template model produces a **new, separate template version** (immutable model per published version).
- **Session start**: first run/launch of orchestrator execution for an end-user request.
- **Pricing**: session-tier pricing is defined in GAAB builder and published as immutable versioned data to AIW.

## Terminology
- **Template**: a GAAB-authored definition published to AIW.
- **Orchestrator Template**: a template that orchestrates tools/agents/use cases; requires “tool slot” mapping at deployment time.
- **Template version**: immutable published snapshot (includes model + tiers + required slots).
- **Catalog item**: AIW listing that references a published template version.
- **Session**: one counted unit for subscription quota enforcement.

---

## Product UX

### GAAB (Admin) UX
Entry point: GAAB → Templates → Create

#### Screen: Create Template (new type selector)
- **Template type**: `Agent Template` (existing) vs `Orchestrator Template` (new)

Acceptance criteria:
- Selecting `Orchestrator Template` opens the orchestrator-specific builder flow.

#### Screen: Orchestrator Template Builder (new)
Sections (draft-editable):
- **Marketing**: display name, short description, author, categories/tags, onboarding steps, SLA/terms
- **Technical (reuse)**: build workflow via existing GAAB “Create Use Case” workflow UI (or embed its payload editing flow)
- **Orchestrator requirements**: define required **tool slots** the AIW customer must map at deployment time
- **Model (required)**: select `modelId` used by orchestrator execution
- **Commercial (required)**: define **flexible subscription tiers (monthly)**
  - Each tier: `tierName`, `monthlyPriceCents`, `currency`, `includedSessions`
  - Optional fields: `description`, `maxConcurrentSessions`

Validation before publish:
- modelId present
- ≥ 1 tier
- tier fields valid (positive price, positive includedSessions, currency ISO-4217)
- required catalog fields complete (pricing, SLA, onboarding; aligns with existing catalog publish gate)

Publish behavior:
- Publish generates a **new immutable version** for the orchestrator template.
- Published versions are read-only; editing requires creating a new draft version.

Acceptance criteria:
- Admin can save drafts repeatedly.
- Admin can publish only after passing validation.
- Published version cannot be modified in place.

### AIW (Customer) UX

#### Screen: Public Catalog list
- Shows orchestrator template marketing card and indicates it is **session subscription**
- Shows “from $X/mo” or tier labels (exact UI may show top tier preview)

Acceptance criteria:
- Templates show tiers that were published from GAAB for that version/model.

#### Screen: Catalog detail
- Shows:
  - modelId (explicit)
  - tier cards with price + included sessions per month
  - required tool slots summary

Acceptance criteria:
- No “pick model” step; tiers are already tied to template version’s model.

#### Subscribe flow
- Customer chooses a tier for a template version.
- Subscription record is pinned to:
  - `tenantId`, `catalogItemId`, `templateVersionId`, `modelId`, `tierId`

Acceptance criteria:
- Subscribe stores the modelId from template version; it cannot drift.

#### Configure deployment (tool mapping)
- Customer maps required slots to their own use cases/agents/tools.
- Save as a deployment config pinned to template version.

Acceptance criteria:
- Cannot deploy until required slots are mapped.

---

## Data contracts

### 1) GAAB → AIW: `TemplatePublished` EventBridge detail (extended)
Existing GAAB emits:
- `Source: gaab.templates`
- `DetailType: TemplatePublished`
- `detail` includes `marketing` + `devops`

Extend `marketing.billing` for orchestrator templates with a new **session-tier subscription** schema.

#### `marketing.billing` (new: `subscription_sessions`)
```json
{
  "model": "subscription_sessions",
  "currency": "USD",
  "sessionCommercial": {
    "schemaVersion": "1",
    "modelId": "bedrock.foundation-model-id",
    "tiers": [
      {
        "tierId": "starter",
        "name": "Starter",
        "recurring": { "interval": "month", "amountCents": 2000 },
        "includedSessions": 100
      }
    ]
  }
}
```

Rules:
- `modelId` is required and immutable for published version.
- `tiers[]` is required and immutable for published version.

#### `devops` (orchestrator-specific additions)
We will add an orchestrator-specific block (versioned) without breaking existing agent templates:
```json
{
  "gaab": {
    "variant": "WorkflowOrchestrator",
    "provisioning": {
      "deployMethod": "POST",
      "deployPath": "/deployments/workflows",
      "deployRequestBody": { }
    },
    "orchestrator": {
      "schemaVersion": "1",
      "requiredToolSlots": [
        { "slotId": "crm", "label": "CRM Agent", "type": "agent", "required": true }
      ]
    }
  }
}
```

Note: exact deployPath/variant must match the existing GAAB “Create Use Case” workflow deployment API you already have.

### 2) AIW storage (high level)
AIW persists:
- Template versions published from GAAB (catalog entries)
- Customer subscriptions (tier chosen)
- Customer deployment configs (tool slot mappings)

---

## Session-based billing metering (new, separate)

### Requirements
- Must **not** reuse token metering paths/tables.
- Must be keyed by **`tenantId`** and **`modelId`**.
- Must be **idempotent** per “session start”.
- Must support “used this month” queries for enforcement.

### Events & storage
We will implement a dedicated billing meter with:
- **Session ledger** record: one per `sessionId` (prevents double-charging)
- **Monthly aggregate** record: increments `sessionCount` for fast enforcement

Minimum fields recorded per session:
- `tenantId`
- `modelId`
- `catalogItemId`
- `templateVersionId`
- `subscriptionId` (or equivalent)
- `deploymentConfigId`
- `sessionId` (idempotency key)
- timestamps

### Enforcement point
- On orchestrator execution start:
  - compute `sessionId` deterministically from request identity
  - write ledger if absent + increment aggregate
  - check aggregate count against subscription tier includedSessions
  - block if exceeded

---

## Versioning rules
- Published template versions are immutable.
- **Model change ⇒ new version** (modelId is immutable per published version).
- Pricing changes are done by publishing a new version (tier data immutable for that version).

---

## Acceptance criteria (end-to-end)
- GAAB can create/publish orchestrator templates with:
  - modelId
  - flexible tiers (monthly price + included sessions)
  - required tool slots
- AIW public catalog shows the published model and tiers (no model selection at checkout).
- AIW subscription pinned to template version/model.
- New session-based billing metering:
  - records sessions with tenantId + modelId
  - enforces includedSessions per billing period
  - is idempotent and does not affect token metering

---

## Implementation milestones (engineering)
- Extend GAAB Templates API + UI to support `subscription_sessions` billing model and tier authoring.
- Extend publish validation for orchestrator templates (model + tiers + required slots).
- Extend AIW ingestion/subscription surfaces to display and persist session-tier plans.
- Add billing meter storage + runtime enforcement at session start.

