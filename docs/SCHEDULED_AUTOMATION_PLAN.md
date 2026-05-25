# Scheduled automation (Path A) — implementation plan

**Status:** Planned (after AIW subscribe → workspace → deploy flow is stable).

**Goal:** Let operators define **scheduled, rules-based agent runs** in GAAB (templates and direct use-case deploy), and let AIW tenants **enable, pause, and monitor** automation after provision.

---

## Architecture summary

| Layer | Responsibility |
|--------|----------------|
| **GAAB Templates UI** | Author defaults: cron, timezone, rule profile, max runs, enabled-by-default. Stored in `devops.gaab.extensions.schedule` + existing `deployRequestBody`. |
| **GAAB Create use case wizard** | Same **Automation** section for deployments not tied to AIW catalog (operator-native use cases). |
| **Provision worker** | On `TenantProvisionRequested` (AIW) or GAAB-native deploy: create **EventBridge Scheduler** + **job Lambda** tagged with `tenantId` / `gaabUseCaseId`. |
| **Job Lambda** | Load tenant schedule config, respect `enabled` flag, invoke AgentBuilder runtime with job prompt, write run log. |
| **AIW Workspace → Automation** | Tenant: pause/resume, view last N runs, link to Billing. |
| **GAAB UseCaseView (optional)** | Operator break-glass pause + run log tail. |

**Billing recurrence (Stripe)** remains separate from **run recurrence (Scheduler)**.

---

## Phase 0 — Prerequisite (AIW)

- [x] Stripe checkout + Billing list subscriptions
- [ ] Subscribe automatically creates `TenantTemplateInstance` (webhook + Billing page) — **in progress**
- [ ] Request deployment → `TenantProvisionRequested` → GAAB deploy → `TenantProvisionStatus` → workspace **Running**

Do not start Phase 1 until Phase 0 E2E passes in prod.

---

## Phase 1 — Contract & storage (GAAB + AIW)

### 1.1 Extend template `devops` (GAAB catalog-fields + contract)

Add optional `devops.gaab.extensions.schedule`:

```json
{
  "schemaVersion": "1",
  "enabledByDefault": true,
  "cron": "cron(0 14 ? * MON-FRI *)",
  "timezone": "America/New_York",
  "ruleSetId": "property-manager-daily",
  "maxRunsPerDay": 24,
  "jobPromptTemplate": "Run the daily checklist for tenant {{tenantId}}…"
}
```

Validation (publish-time for subscription templates optional; required when `automationMode: "scheduled"`):

- `cron` valid EventBridge Scheduler expression
- `timezone` IANA
- `maxRunsPerDay` positive integer cap

### 1.2 Per-tenant runtime config (new GAAB DynamoDB or reuse Tenants table)

Table keyed by `tenantId` + `gaabUseCaseId` (or `scheduleId`):

| Field | Purpose |
|--------|---------|
| `enabled` | Pause without deprovisioning |
| `cron` / `timezone` | Override template default |
| `lastRunAt` / `lastStatus` | Quick health |
| `consecutiveFailures` | Auto-pause threshold |

AIW reads/writes via future GraphQL or GAAB REST proxy (Phase 3).

### 1.3 Run history

`AutomationRun` log (DynamoDB or S3):

- `runId`, `tenantId`, `useCaseId`, `startedAt`, `endedAt`, `status`, `summary`, `tokens`, `error`

Feeds monitoring UI and optional `AgentTemplate.ratings` rollup in AIW.

---

## Phase 2 — GAAB authoring UI

### 2.1 Templates → Create/Edit (`TemplateCreateView.jsx`)

New section **Scheduled automation** (after Agent configuration):

- Toggle: **Enable scheduled runs for this template**
- Cron builder (or raw expression + preview next 5 runs)
- Timezone select
- Rule set / job prompt (textarea or pick from library)
- **Generate JSON** merges into `devops` raw JSON (like AgentDeployBodyWizard)

Publish validation: if automation enabled, require schedule block.

### 2.2 Create use case wizard (`AgentBuilderUseCaseType` + shared component)

Extract `<ScheduleAutomationFields />` shared by:

- Template technical tab
- AgentBuilder deploy wizard review step

Persist into deploy payload extensions or parallel `ScheduleParams` object merged at POST time.

### 2.3 `catalog-fields.ts`

- `validateScheduleExtension(devops)`
- `formatPricingSummary` unchanged

---

## Phase 3 — Provision & AWS resources (GAAB)

### 3.1 `tenant-provision-subscriber` (AIW-driven deploy)

After successful AgentBuilder POST:

1. Read `devops.gaab.extensions.schedule` from event detail.
2. If present and `enabledByDefault !== false`:
   - Create Scheduler schedule `aiw-{tenantId}-{useCaseId}` (target = job Lambda ARN).
   - Pass payload: `{ tenantId, gaabUseCaseId, agentTemplateId, ownerSub }`.
3. Emit `TenantProvisionStatus` `runtime_ready` including `scheduleId` in detail (optional field).

### 3.2 GAAB-native deploy (non-AIW)

Same hook in deployment completion path (CloudFormation custom resource or post-deploy Lambda) when `ScheduleParams` on use case record.

### 3.3 Job Lambda (`schedule-agent-run`)

- Input from Scheduler
- Load schedule row → if `!enabled` exit 0
- Invoke use case inference endpoint / AgentCore with `jobPromptTemplate` rendered
- Append run log; on N failures set `enabled=false` and optionally `PutEvents` → AIW notification

### 3.4 IAM

- Scheduler → job Lambda
- Job Lambda → Bedrock / GAAB runtime API
- Job Lambda → run log table

---

## Phase 4 — AIW tenant UX

### 4.1 `/dashboard/workspace/[instanceId]/automation` or modal

- Status: Enabled / Paused
- Next run time (from Scheduler describe)
- Last 10 runs (from GAAB API or synced events)
- **Pause automation** → GAAB API sets `enabled=false` (does not cancel Stripe)
- **Resume**
- Link to **Billing** for subscription cancel

### 4.2 Monitoring / quality

- Surface GAAB **feedback** aggregates per use case (thumbs %) when `FeedbackEnabled`
- Optional tenant “rate this automation” → writes to `TenantTemplateInstance` or `AgentTemplate.ratings`
- CloudWatch alarm on `failed` run rate → SNS ops

### 4.3 Stop recurrence (product copy)

| Action | Stops |
|--------|--------|
| **Pause automation** | Scheduled runs only |
| **Cancel subscription** (Stripe portal) | Charges |
| **Deprovision use case** | Infra + schedules deleted |

---

## Phase 5 — Events (optional hardening)

| Event | Purpose |
|--------|---------|
| `gaab.automation` / `AutomationRunCompleted` | AIW live run feed |
| `aiw.automation` / `AutomationPaused` | GAAB ops audit |

---

## Testing checklist

1. Template with schedule published → AIW catalog unchanged (no schedule in marketing).
2. AIW provision → Scheduler exists, tagged with tenant.
3. Manual Lambda invoke → run log row, agent invoked.
4. Pause → no runs until resume.
5. GAAB-only use case deploy (no AIW) → same Scheduler behavior.
6. Failure threshold → auto-pause + tenant sees message in AIW.

---

## Estimated sequencing

| Sprint | Deliverable |
|--------|-------------|
| S0 | AIW workspace auto-reserve + deploy E2E |
| S1 | Contract + `catalog-fields` validation + template UI (save only) |
| S2 | Job Lambda + Scheduler on provision (AIW path) |
| S3 | AIW Automation page (pause/resume + run list) |
| S4 | Create use case wizard parity + GAAB-native deploy hook |
| S5 | Feedback/metrics rollup + auto-pause on failures |

---

## References

- `docs/AIW_EVENTBRIDGE.md` — provision events
- `aiw-saas/contracts/AGENT_TEMPLATE_CONTRACT.md` — template envelope
- `source/ui-deployment/src/components/templates/TemplateCreateView.jsx` — template authoring
- `source/lambda/tenant-provision-subscriber/` — AIW provision worker
