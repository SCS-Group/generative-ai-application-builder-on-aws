# AIW ↔ GAAB integration via EventBridge

This document is the **handshake** between **Generative AI Application Builder (GAAB)** and **AI Agents Workforce (AIW)**. Integration is **pub/sub on Amazon EventBridge** (default event bus in the same AWS account unless you adopt a dedicated bus and IAM policies).

Canonical field names and semantics live in **`aiw-saas/contracts/AGENT_TEMPLATE_CONTRACT.md`** (§10.1 and the “Canonical flow” table).

---

## 1. GAAB → AIW: `TemplatePublished` (catalog definitions)

When a **template definition** is marked **published** in GAAB (no CloudFormation use-case deploy required), GAAB (or a small Lambda behind your Templates API) should call **`events:PutEvents`**:

| Property | Value |
|----------|--------|
| `EventBusName` | `default` |
| `Source` | `gaab.templates` |
| `DetailType` | `TemplatePublished` |
| `Detail` | JSON object (see below) |

### `Detail` payload (required / optional)

- **`gaabTemplateId`** (string, required): stable id in GAAB’s template store.
- **`slug`** (string, required): URL-safe unique key (AIW stores it on `AgentTemplate.slug`).
- **`schemaVersion`** (string, optional): contract version; AIW defaults to `0.1.0` if omitted.
- **`publishedAt`** (string, optional): ISO-8601; AIW uses “now” if invalid/omitted.
- **`publishedBy`** (string, optional).
- **`marketing`** (object, required): aligns with contract §2 (e.g. `displayName`, `shortDescription`, `billing`, **`author`**, **`pricing.summary`**, **`sla`**, **`recommendedOnboardingSteps`** — required in GAAB before publish so tenants see cost/SLA/onboarding before commit).
- **`devops`** (object, required): aligns with contract §3–§4 (`gaab.variant`, `gaab.provisioning.deployRequestBody`, etc.).
- **`source`** (object, optional): merged with `system: "gaab"` and `gaabTemplateId` in AIW.
- **`ratings`** (object, optional): **not** collected in GAAB UI; optional payload for AIW to store for a future tenant-rating feature. Omitted from GAAB admin API responses.

**Example (Node.js / AWS SDK v3):**

```typescript
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const eb = new EventBridgeClient({});
await eb.send(
  new PutEventsCommand({
    Entries: [
      {
        EventBusName: "default",
        Source: "gaab.templates",
        DetailType: "TemplatePublished",
        Detail: JSON.stringify({
          gaabTemplateId: "tmpl_01HZZZZ",
          slug: "support-copilot",
          schemaVersion: "0.1.0",
          publishedAt: new Date().toISOString(),
          publishedBy: "gaab-templates-api",
          marketing: {
            displayName: "Support copilot",
            shortDescription: "Tier-1 assist",
            author: "SCS Group",
            billing: { model: "contact_sales" },
            pricing: { summary: "Contact sales for enterprise pricing", detailUrl: "https://example.com/pricing" },
            sla: { link: "https://example.com/sla" },
            recommendedOnboardingSteps:
              "1. Assign an admin\n2. Connect identity provider\n3. Upload knowledge base",
          },
          devops: {
            gaab: {
              variant: "AgentBuilder",
              provisioning: {
                deployMethod: "POST",
                deployPath: "/deployments/agents",
                deployRequestBody: {
                  /* …GAAB POST body template… */
                },
              },
            },
          },
        }),
      },
    ],
  }),
);
```

**AIW** already deploys a rule + Lambda (`template-published-subscriber`) that listens for this pattern. Ensure the GAAB stack’s execution role allows **`events:PutEvents`** on `arn:aws:events:REGION:ACCOUNT:event-bus/default` (or your chosen bus).

### 1.1 `TemplateUnpublished` (decommission)

When an admin **decommissions** a published template in GAAB, the Templates API calls **`PutEvents`** with:

| Property | Value |
|----------|--------|
| `EventBusName` | Same as publish (`EVENT_BUS_NAME` on the templates Lambda, typically `default`) |
| `Source` | `gaab.templates` |
| `DetailType` | `TemplateUnpublished` |
| `Detail` | JSON object: **`gaabTemplateId`** (required), **`slug`**, **`schemaVersion`**, **`unpublishedAt`**, **`unpublishedBy`**, optional **`reason`**, optional **`source`** |

GAAB sets the template row to **`archived`** and records **`UnpublishedAt`** / **`UnpublishedBy`**. AIW’s **`template-unpublished-subscriber`** sets the matching **`AgentTemplate`** to **`archived`**, so it drops out of **`listPublicCatalog`** (which only lists `status: published`).

REST: **`POST /templates/{templateId}/unpublish`** (admin JWT).

---

## 2. AIW → GAAB: `TenantProvisionRequested` (deploy after tenant acceptance)

After a tenant accepts **cost / SLA / checkout** in AIW, AIW exposes the GraphQL mutation **`publishTenantProvisionRequest`**, which publishes:

| Property | Value |
|----------|--------|
| `EventBusName` | `default` (configurable on AIW Lambda env `EVENT_BUS_NAME`) |
| `Source` | `aiw.tenant` |
| `DetailType` | `TenantProvisionRequested` |
| `Detail` | JSON object including **`tenantId`**, optional **`organizationName`** (saved on AIW dashboard), **`customerName`** (display string for operators), **`tenantAdminEmail`** (Cognito email when present), plus instance/template ids, `ownerSub`, `marketing`/`devops` snapshot, etc. (see AIW contract §10.1). Detail `version` is **`2`**. |

### Example `Detail` (parsed JSON)

```json
{
  "version": "2",
  "tenantId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "organizationName": "Acme Corp",
  "customerName": "Acme Corp",
  "tenantAdminEmail": "admin@acme.example",
  "tenantTemplateInstanceId": "018f2e3a-0000-7000-8000-000000000001",
  "agentTemplateId": "018f2e3a-0000-7000-8000-0000000000aa",
  "ownerSub": "cognito-sub-of-user",
  "idempotencyKey": "cognito-sub-of-user:018f2e3a-0000-7000-8000-0000000000aa",
  "templateSlug": "support-copilot",
  "templateSchemaVersion": "0.1.0",
  "gaabTemplateId": "tmpl_01HZZZZ",
  "marketing": {},
  "devops": {}
}
```

### GAAB work to implement next

1. **Templates API**: `GET/POST /templates`, `GET/PATCH /templates/{templateId}`, `POST /templates/{templateId}/publish`, `POST /templates/{templateId}/unpublish` (authorizer: admin JWT). Publish / unpublish call `PutEvents` as in §1 and §1.1. UI: **Templates** in the deployment dashboard sidebar.
2. **EventBridge rule** on the same bus: `source` = `aiw.tenant`, `detail-type` = `TenantProvisionRequested`.
3. **Target**: Lambda or Step Functions that:
   - Parses `detail.devops` / `detail.marketing` / `detail.gaabTemplateId`.
   - Builds the final POST body (**tenant overlay**: unique `UseCaseName`, `DefaultUserEmail`, tags for **customer/tenant id**—see contract §4.3).
   - Calls **`POST`** `deployments` or **`POST`** `deployments/agents` on the Deployment Platform API with **automation credentials** (not the end-user JWT).
4. **Tagging**: persist **`detail.tenantId`** on the GAAB-side instance and apply stack or deployment tags (e.g. `AiwTenantId=<tenantId>`) so the GAAB UI/API can **filter by tenant**.

---

## 3. Why not call HTTP directly?

Direct browser → GAAB or tenant JWT → GAAB Deployment API violates the **Option C** split (contract §5). EventBridge keeps **AIW** and **GAAB** loosely coupled: schemas can version independently; consumers can be added without changing the publisher’s HTTP surface.

---

## 4. GAAB → AIW: `TenantProvisionStatus` (deploy lifecycle)

AIW cannot infer **CREATE_COMPLETE** / **UPDATE_COMPLETE** (or failure) on the GAAB stack by itself unless GAAB tells it. The recommended pattern is a **second event** on the same default bus after **`TenantProvisionRequested`** is processed.

| Property | Value |
|----------|--------|
| `EventBusName` | `default` |
| `Source` | `gaab.tenant` |
| `DetailType` | `TenantProvisionStatus` |
| `Detail` | JSON object (see below) |

### `Detail` payload

- **`tenantTemplateInstanceId`** (string, **required**): must match the id from **`TenantProvisionRequested`** so AIW updates the correct row.
- **`phase`** (string, **required**):
  - **`provisioning_started`** — GAAB accepted the work; stack / deployment creation is in flight.
  - **`stack_complete`** — optional milestone (e.g. CloudFormation stack reached a stable state); AIW may still wait for runtime URLs.
  - **`runtime_ready`** — terminal success for MVP: include **`runtimeUiUrl`** and optional Cognito/runtime identifiers when known.
  - **`failed`** — terminal failure; include **`message`** for **`TenantTemplateInstance.lastError`**.
- Optional: **`gaabUseCaseId`**, **`runtimeUiUrl`**, **`runtimeUserPoolId`**, **`runtimeClientId`**, **`runtimeRegion`**, **`cloudFormationStackId`**, **`version`**.

**GAAB work:** wire your provisioning worker (or a CloudFormation/EventBridge listener) to **`PutEvents`** with this shape when stack status transitions or when the Deployment Platform API reports a use case as ready. **AIW** deploys rule **`GaabTenantProvisionStatusToAiw`** → Lambda **`tenant-provision-status-subscriber`** (see **`aiw-saas/contracts/AGENT_TEMPLATE_CONTRACT.md`** §10.1).
