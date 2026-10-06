# 23_AUTOMATION_ARCHITECTURE.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Automation Architecture Specification
**Version:** 1.0 Draft
**Status:** Cross-Cutting System Deep-Dive
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§34, §38, Notification/Automation Domain)
- `03_MASTER_PROJECT_SPECIFICATION.md` (§38, Approval Model — event-driven parallel; §47, Notification System)
- `04_PLATFORM_ARCHITECTURE.md` (§43–44, Event Architecture/Domain Event Rule; §78–79, Webhooks/n8n Integration; §158–163, Notification/External Integration/Telegram/Google)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§38–41, Tenant-Aware Notifications/n8n/Webhook Signature; §156–157, Tenant Automation/AI Boundary)
- `06_DATABASE_SPECIFICATION.md` (§5.15, `core.notifications`)
- `13_SECURITY_SPECIFICATION.md` (§5.1, Rate Limiting; §7, Secret Management — webhook signing keys)
- `22_AI_ARCHITECTURE.md` (§9, explicit boundary — this document is the non-AI counterpart)

---

# 1. Purpose

এই document platform জুড়ে ছড়িয়ে থাকা automation-সংক্রান্ত সিদ্ধান্তগুলো (domain events, notification channels, n8n integration boundary, webhook delivery contract, §38 `02`-এর Automation Domain) একত্র করে একটি সম্পূর্ণ, বাস্তবায়নযোগ্য specification-এ রূপান্তর করে:

```text
Rule-based (non-AI) automation engine — Event → Condition → Action
Trigger event catalog (sourced from every domain module already
  specified in 07–21)
Action types: Notification, Webhook, n8n trigger, Task creation
n8n integration boundary (concrete implementation of ADR-009, 04 §115)
Webhook delivery/retry/signature contract (concretizes 04 §78, 05 §41)
Notification channel adapters (In-App/Email/Telegram/SMS/WhatsApp)
Database schema (new — not previously defined in 06)
Tenant isolation for automation (concrete application of 05 §156)
```

**Foundational rule carried forward (per `04` §156–157, restated as this document's central boundary):**

> Automation চলে business truth তৈরির **পরে**, কখনো তার প্রতিস্থাপক হিসেবে নয়। n8n বা কোনো automation rule কখনো `CompleteSaleUseCase`-এর মতো Core transaction directly trigger করবে না — automation শুধু ইতিমধ্যে-committed business event-এর ওপর react করে।

---

# 2. Relationship to AI Architecture — Explicit Boundary

Per `22` §9, this document is deliberately the **non-AI** counterpart:

```text
22_AI_ARCHITECTURE.md          23_AUTOMATION_ARCHITECTURE.md (this doc)
  Model-inferred intent          Human-authored condition
  Natural-language query          Structured Event/Condition/Action rule
  Non-deterministic response      Deterministic evaluation
  Provider adapter (LLM)          n8n / webhook / notification adapter
  Query-only (never mutates)      Action MAY mutate (e.g. create a
                                   Notification row, POST a webhook) —
                                   but NEVER a Core financial/stock
                                   mutation (§4.3 below)
```

**Rule (restated as Decision AUT-001, §16):** an `AutomationRule`'s action list may never contain an action type that calls a Core Use Case capable of mutating Sales/Purchase/Inventory/Accounting state (`CompleteSaleUseCase`, `AdjustStockUseCase`, etc.). The only mutation an automation Action is permitted to perform is against its **own** domain — `core.notifications`, `automation.webhook_deliveries`, or a downstream **external** system via webhook/n8n. This is the concrete enforcement of `04` §156's "n8n → complete sale" prohibition, generalized to the rule engine as a whole, not just to n8n specifically.

---

# 3. Automation Domain Map

Per `02` §38 and `04` §43–45:

```text
Business Event (Domain Event, emitted by a Use Case per 07 §7.6
  step 14, 16 §5.2 step 6, etc.)
        ↓
Event Bus (in-process, async consumers only — per 04 §44's Domain
  Event Rule: financial/stock mutation NEVER depends on an event
  handler; events are for automation/notification, not for the
  originating transaction's own effects)
        ↓
AutomationRule Matching (tenant-scoped, per §5)
        ↓
Condition Evaluation (§6)
        ↓
Action Execution (§7) — Notification | Webhook | n8n Trigger |
  Task Creation
        ↓
AutomationExecution log (§10.2 — audit/traceability, mirrors
  core.audit_logs shape but scoped to automation)
```

---

# 4. Domain Event Catalog

This is the concrete, exhaustive list `04` §43 sketched abstractly — every event below is already emitted (or is amended here to be emitted) by a Use Case already specified in `07`–`21`.

## 4.1 Core Events

```text
SaleCompleted          — CompleteSaleUseCase (07 §7.6 step 14)
SaleCancelled          — CancelSaleUseCase (07 §7.7)
PurchaseReceived        — ReceivePurchaseUseCase (07 §8.3 step 12)
CustomerPaymentReceived  — RecordCustomerPaymentUseCase (07 §10.3)
SupplierPaymentMade      — RecordSupplierPaymentUseCase (07 §10.4)
CustomerReturnCompleted   — CompleteCustomerReturnUseCase (07 §12.3)
SupplierReturnCompleted    — CompleteSupplierReturnUseCase (07 §12.3)
StockLow                    — emitted by InventoryLedgerService.
                               recomputeBalance (09 §3.2) when the
                               post-movement balance crosses below
                               item.lowStockThreshold (new field,
                               §14.1 amendment)
StockOutOfZero                — emitted alongside StockLow when
                               quantity_available reaches exactly 0
ExpiryApproaching               — emitted by a scheduled tenant-
                               timezone-aware job (mirrors 05 §116)
                               scanning GetExpiryAlertsUseCase (19
                               §7.1) results daily, one event per
                               newly-crossed threshold band (never
                               re-fired daily for the same batch —
                               see §9.3 dedup rule)
PeriodClosed                  — ClosePeriodUseCase (08 §9.2)
```

## 4.2 Module Events

```text
QuotationSent / QuotationAccepted / QuotationRejected / QuotationExpired
  — SendQuotationUseCase, RespondToQuotationUseCase, ExpireQuotationsJob
    (14 §5.2, §5.4, §5.6)
ServiceOrderQuoted / ServiceOrderCompleted
  — RecordDiagnosisUseCase, CompleteServiceOrderUseCase (15 §5.3, §5.6)
RentalDispatched / RentalReturned / RentalDamageAssessed
  — DispatchRentalUseCase, ReturnRentalUseCase, AssessDamageUseCase
    (16 §5.2–5.4)
ProjectMilestoneInvoiced / ProjectCompleted
  — InvoiceProjectMilestoneUseCase, CompleteProjectUseCase (17 §5.4, §5.5)
BookingConfirmed / BookingCancelled
  — ConfirmBookingUseCase, CancelBookingUseCase (18 §6.2, §6.4 — already
    referenced as domain events in 18 §5 inv. 3 and §9)
WarrantyExpiring                — scheduled job scanning
                                 modules.warranties.ends_at (06 §6.6),
                                 same dedup pattern as ExpiryApproaching
```

## 4.3 What Is Explicitly NOT an Event Consumer Target

```text
No event handler in this architecture may call:
  CompleteSaleUseCase, ReceivePurchaseUseCase, AdjustStockUseCase,
  RecordCustomerPaymentUseCase, CreateManualJournalUseCase, or any
  other Use Case classified as a financial/stock mutation in 07/08/09.

This is not a convention — it is enforced at the Action-type level
(§7): the automation engine's action executor has NO action type
whose implementation invokes a mutating Core Use Case. Adding such
an action type would require amending this document explicitly
(mirrors the Architecture Freeze Rule, 04 §170).
```

---

# 5. Domain Entity: `AutomationRule`

```text
AutomationRule
├── id, tenantId
├── name
├── triggerEvent: text            -- one of §4's catalog values
├── conditions: Condition[]        -- §6, empty array = always match
├── actions: Action[]               -- §7, ordered, all execute unless
│                                     one action type is configured
│                                     to short-circuit (not MVP — see
│                                     §15 Q2)
├── isActive: boolean
├── createdAt, updatedAt, createdBy
```

## 5.1 Value Object: `Condition`

```text
Condition
├── field           -- dot-path into the event payload, e.g.
│                       "receivable.daysOverdue", "sale.grandTotal"
├── operator         -- EQ | NEQ | GT | GTE | LT | LTE | CONTAINS |
│                       IN
├── value             -- comparison value (typed per field)
```

**Evaluation is pure and side-effect-free** — `Condition[]` are ANDed together (no OR/grouping at MVP, flagged §15 Q1). This mirrors `02` §38's example (`Invoice Due → Due > 7 days → Send Reminder`) directly:

```text
triggerEvent: "CustomerPaymentReceivable"  (a periodic scan event,
              not a direct Use Case event — see §9.4 for how
              periodic/derived events differ from direct domain events)
conditions: [{ field: "receivable.daysOverdue", operator: "GT", value: 7 }]
actions: [{ type: "NOTIFICATION", channel: "EMAIL", template: "due_reminder" }]
```

## 5.2 Value Object: `Action`

```text
Action
├── type: NOTIFICATION | WEBHOOK | N8N_TRIGGER | TASK_CREATION
├── config: jsonb        -- shape depends on type, per §7
├── order: integer        -- execution order within the rule
```

---

# 6. Condition Evaluation

```text
ConditionEvaluator.evaluate(conditions: Condition[], eventPayload) -> boolean
  1. For each condition, resolve `field` against eventPayload via
     dot-path lookup (missing field -> condition evaluates false,
     never throws — a malformed/mismatched rule fails closed on
     matching, per the platform-wide Fail Closed Principle, 05 §159,
     applied here to rule matching rather than security)
  2. Apply `operator` against `value`
  3. AND all results
  4. Return final boolean
```

**Pure, side-effect-free, independently unit-testable function** — mirrors the design shape already established for `SalePricingService` (`07` §7.4) and `ReturnEligibilityPolicy` (`07` §12.2): business logic as a pure function, orchestration as a separate concern.

---

# 7. Action Types

## 7.1 `NOTIFICATION`

```text
config: {
  channel: IN_APP | EMAIL | TELEGRAM | SMS | WHATSAPP
  template: string          -- references a tenant/platform template
                                key, per §11
  recipientResolver: "EVENT_ACTOR" | "SALE_CUSTOMER" |
                      "SPECIFIC_USER:<userId>" | "ROLE:<roleKey>"
                      -- resolves WHO receives it from the event
                      payload/tenant role assignments, never a
                      hardcoded external address baked into the rule
}

Execution: persists a core.notifications row (06 §5.15, unmodified
schema) with status=PENDING, then delegates to the matching Channel
Adapter (§11) for actual delivery, updating status=SENT/FAILED.
```

## 7.2 `WEBHOOK`

```text
config: {
  webhookSubscriptionId: uuid  -- references automation.
                                  webhook_subscriptions (§14.2), NOT
                                  a raw URL inline in the rule — this
                                  indirection lets a tenant rotate/
                                  disable a webhook endpoint without
                                  editing every rule that targets it
}

Execution: delegates to the Webhook Delivery pipeline (§9) — this
action type does not itself perform the HTTP call; it enqueues a
delivery job.
```

## 7.3 `N8N_TRIGGER`

```text
config: {
  n8nWebhookUrl: string    -- tenant-configured n8n instance webhook
                              URL (per 05 §139, stored as an
                              encrypted tenant secret, referenced by
                              ID here, never plaintext in the rule
                              row itself — mirrors 06 §4.6's
                              credential_ref pattern)
}

Execution: functionally IS a Webhook delivery (§9) to a
tenant-configured n8n endpoint — architecturally there is no
separate "n8n delivery pipeline"; N8N_TRIGGER is a thin alias over
§9's mechanism with n8n-specific payload conventions (§8), kept as a
distinct Action type only for UX clarity (§12) and analytics
(differentiating "webhook to my own system" from "webhook to my n8n
automation" in usage reporting).
```

## 7.4 `TASK_CREATION`

```text
config: {
  title: string (may reference event payload via template
         interpolation, e.g. "Follow up on overdue invoice
         {{sale.invoiceNumber}}")
  assigneeResolver: same shape as NOTIFICATION's recipientResolver
}

Execution: creates a lightweight internal task record (new table,
automation.tasks, §14.3) — deliberately NOT a full task-management
module (Kanban boards, etc. are explicitly out of scope per 03 §85's
"Complex CRM"/"Advanced Workflow Builder" exclusions); this is a
simple assigned-reminder record surfaced in-app, closer to a
to-do than a project-management primitive.
```

---

# 8. n8n Integration Boundary — Concrete

Per `04` §79 (ADR-009) and `05` §156.

## 8.1 What n8n Is

```text
n8n = Automation / Integration Layer
  ERP Event → Webhook (N8N_TRIGGER action, §7.3) → n8n workflow →
  Telegram / Email / Google Sheets / CRM / any n8n-supported node
```

## 8.2 What n8n Is Not

```text
n8n is never:
  - a source of business truth (04 §79 — "ERP-এর authoritative
    transaction n8n-এর ওপর নির্ভর করবে না")
  - a code path back INTO the ERP that bypasses the standard API
    guard chain (11 §20) — if an n8n workflow needs to write back to
    the ERP (e.g. "after sending an invoice via n8n, mark it as
    sent"), it does so via the platform's own public API (05 §136,
    future scope) with a scoped API key, subject to the identical
    authentication/authorization/tenant-resolution pipeline as any
    other API caller — NOT a privileged n8n-only backdoor endpoint
  - permitted to trigger a Core financial/stock mutation directly
    (§4.3's rule applies regardless of which system initiates the
    call — an n8n-originated request hitting the public API is
    authorized exactly as strictly as a browser-originated one)
```

## 8.3 Payload Convention

```text
Every N8N_TRIGGER (and generic WEBHOOK, §9) delivery body:

{
  "eventId": "uuid",
  "eventType": "SaleCompleted",
  "tenantId": "uuid",
  "occurredAt": "2026-08-24T10:00:00Z",
  "data": { ...event-specific payload... }
}
```

This is the concrete payload shape `05` §40 referenced abstractly ("tenantId, eventId, eventType, payload, signature").

---

# 9. Webhook Delivery Pipeline

Concretizes `04` §78 and `05` §41.

## 9.1 Delivery Flow

```text
Action Executed (WEBHOOK or N8N_TRIGGER)
        ↓
Enqueue automation.webhook_deliveries row (status=PENDING)
        ↓
Background Worker (per 04 §45-46, Redis-backed queue)
        ↓
HTTP POST to subscription's target URL, body per §8.3, signed (§9.2)
        ↓
2xx response -> status=DELIVERED
non-2xx / timeout -> status=RETRYING, exponential backoff
  (mirrors the client-side sync retry policy shape, 10 §4.2:
  5s, 15s, 60s, 5m, capped, maxAttempts default 8)
        ↓
maxAttempts exceeded -> status=DEAD_LETTERED, surfaced in a tenant-
  visible Webhook Delivery Log (§13) for manual inspection/retry
```

## 9.2 Signature

```text
Every outbound webhook body is signed:
  X-Webhook-Signature: HMAC-SHA256(payload, subscription.signingSecret)

Receiver-side verification is the receiver's responsibility (n8n
supports this natively via its Webhook node's signature-check
option; a tenant's own custom endpoint must implement verification
itself — documented in tenant-facing webhook setup docs, out of
scope for this specification).

signingSecret is generated at subscription creation, stored via the
same secret-reference pattern as §7.3's n8n URL (13 §7 — "Tenant
secrets... encrypted at rest... referenced by opaque ID"), rotatable
without re-creating the subscription (mirrors 13 §7's rotation
procedure).
```

## 9.3 Idempotency & Deduplication

```text
Every webhook_deliveries row carries eventId (§8.3) as an idempotency
key from the receiver's perspective — a receiver that has already
processed a given eventId can safely ignore a retried delivery of
the same event (this is guidance for receiver implementation; the
ERP-side retry mechanism itself does not deduplicate deliveries it
sends, since retries are only issued after a non-success response,
meaning the receiver's own prior processing — if any — is unconfirmed
from the sender's point of view).

Separately, EVENT emission itself is deduplicated at the source:
scheduled/periodic events (ExpiryApproaching, WarrantyExpiring, §4.1)
track a "last fired" watermark per (tenantId, entityId, thresholdBand)
in automation.periodic_event_watermarks (§14.4) so the same batch
crossing the same 30-day threshold does not re-fire the event (and
therefore does not re-trigger downstream rules) on every daily scan —
only once per threshold-band crossing.
```

## 9.4 Direct Domain Events vs. Periodic/Derived Events

```text
Direct Domain Events (§4.1's SaleCompleted, PurchaseReceived, etc.):
  emitted synchronously as part of the originating Use Case's
  transaction commit (04 §44) — one event per one business
  transaction, no deduplication concern (the transaction itself is
  already idempotent per 07 §17).

Periodic/Derived Events (ExpiryApproaching, WarrantyExpiring):
  emitted by a scheduled job (§4.1) that queries current state and
  compares against a watermark (§9.3) — these require explicit
  dedup logic since the same underlying condition (a batch expiring
  in 25 days) remains true across many consecutive daily scans.
```

---

# 10. Rule Matching & Execution — Engine Detail

## 10.1 `AutomationEngine.handleEvent`

```text
Input: DomainEvent { eventId, eventType, tenantId, occurredAt, data }

1. Query automation.automation_rules WHERE tenant_id = :tenantId
   AND trigger_event = :eventType AND is_active = true
2. For each matching rule:
     a. ConditionEvaluator.evaluate(rule.conditions, data) (§6)
     b. If true: execute rule.actions in `order` (§7), each wrapped
        in its own failure isolation (§10.3)
     c. Persist an AutomationExecution row (§10.2) regardless of
        match outcome (matched=false rows are lightweight, useful
        for rule-debugging UX, §12)
3. This entire handler runs as an ASYNC consumer of the event bus
   (04 §44) — it NEVER runs inside the originating Use Case's
   database transaction. A failure here can never roll back a Sale/
   Purchase/Payment (concrete fulfillment of the Domain Event Rule).
```

## 10.2 Entity: `AutomationExecution`

```text
AutomationExecution
├── id, tenantId, ruleId FK, eventId, eventType
├── matched: boolean
├── actionResults: jsonb    -- per-action outcome (SUCCESS/FAILED +
│                              error detail), for troubleshooting
├── executedAt
```

Serves the same "traceability of a non-authoritative side-effect
system" role `10` §12's `core.change_log` serves for sync — a
diagnostic/audit trail, never itself a source of business truth.

## 10.3 Failure Isolation

```text
One action's failure (e.g. a webhook endpoint is down) does NOT
prevent other actions in the same rule, or other rules matching the
same event, from executing. Each action is individually retried
(§9.1 for WEBHOOK/N8N_TRIGGER; NOTIFICATION failures are logged and
surfaced in the Sync/Notification UI equivalent — a failed email
send does not retry indefinitely, it is logged as FAILED after the
channel adapter's own delivery attempt, since most email/SMS
providers already handle their own retry at the transport level).
```

---

# 11. Notification Channel Adapters

Per `02` §34 and `04` §158–163.

```text
NotificationChannelAdapter interface:
  send(notification: { recipient, template, data }) -> Result<void, DeliveryError>

Implementations:
  InAppAdapter       — writes directly to core.notifications,
                        delivered via the existing client sync/pull
                        mechanism (10 §6.2) or a lightweight realtime
                        channel (future scope, not required at MVP —
                        polling via the standard pull is sufficient)
  EmailAdapter        — provider abstraction per 04 §161, transactional
                        email service (SMTP/API-based, provider TBD
                        at implementation)
  TelegramAdapter      — per 04 §162, tenant-configured bot token
                        (13 §7 tenant secret)
  SmsAdapter            — provider abstraction, future/plan-gated
  WhatsAppAdapter        — provider abstraction, future/plan-gated
```

**Template resolution:** `template` keys (e.g. `"due_reminder"`) resolve against a small set of platform-seeded templates per event type (§4), with `{{field}}` interpolation from the event payload (same interpolation syntax as §7.4's Task title) — a tenant may override the platform default per template key via `core.notification_templates` (new table, flagged §14.5), but the *set* of available template keys is platform-defined, not arbitrary tenant-authored HTML (mirrors `04` §165's "Arbitrary CSS injection allow করা হবে না" principle applied to notification bodies).

---

# 12. UX Flow

## 12.1 Rule Builder (Administration)

```text
Automation Rules list (Administration section, per 12 §3.1's
  existing nav — this module adds a sub-item, no new top-level menu,
  same pattern as every Optional Module's navigation addition, 12 §3.2)
  ↓
[New Rule]
  Trigger Event picker (grouped by domain — Sales/Purchase/Inventory/
    Module events, per §4 — only events relevant to the tenant's
    enabled modules are listed, mirroring Decision UX-001's
    capability-driven filtering, 12 §12)
  ↓
  Condition builder (field/operator/value rows, per §5.1 — field
    picker is scoped to the selected trigger event's known payload
    shape, never a freeform string the user could mistype)
  ↓
  Action builder (add one or more Actions, per §7 — Webhook/N8N_TRIGGER
    actions require selecting an already-configured Subscription,
    §13, never a raw URL typed inline here)
  ↓
  Save -> isActive toggle available immediately
```

## 12.2 Execution Log / Debugging

```text
Rule detail screen -> "Recent Executions" tab
  Lists AutomationExecution rows (§10.2), matched/unmatched,
  per-action SUCCESS/FAILED status — lets a tenant admin answer
  "why didn't my reminder fire" without engineering support,
  mirroring the transparency principle already established for
  Sync (10 §10) and AI tool-grounding (22 §5.1)
```

---

# 13. Database Detail (NEW — schema addendum to `06`)

```text
automation.automation_rules
  id, tenant_id, name, trigger_event, conditions jsonb,
  actions jsonb, is_active, created_at, updated_at, created_by

automation.automation_executions
  id, tenant_id, rule_id FK, event_id, event_type,
  matched boolean, action_results jsonb, executed_at

automation.webhook_subscriptions
  id, tenant_id, name, target_url, signing_secret_ref
    (pointer per 13 §7, never plaintext), is_active,
  created_at, updated_at

automation.webhook_deliveries
  id, tenant_id, webhook_subscription_id FK, event_id, event_type,
  payload jsonb, status (PENDING/DELIVERED/RETRYING/DEAD_LETTERED),
  attempt_count, last_attempted_at, last_error, created_at

automation.tasks
  id, tenant_id, title, assignee_user_id, source_rule_id FK nullable,
  status (OPEN/DONE), created_at, completed_at

automation.periodic_event_watermarks
  id, tenant_id, entity_type, entity_id, threshold_band,
  last_fired_at

core.notification_templates          -- amendment to 06 §5.15's
                                        notification domain
  id, tenant_id nullable (null = platform default), template_key,
  channel, subject_template, body_template, updated_at
```

**Amendment flag:** Decision AUT-002 (§16) — `06_DATABASE_SPECIFICATION.md` §3 gains a new schema group `automation` (alongside `control`/`core`/`modules`/`industry`), and §5.15 is amended to add `core.notification_templates`.

**Unique:** `UNIQUE(tenant_id, name)` on `automation_rules`; `UNIQUE(tenant_id, template_key, channel)` on `core.notification_templates` where `tenant_id IS NOT NULL`.

**Indexes:** `INDEX(tenant_id, trigger_event, is_active)` on `automation_rules` (the hot-path lookup for `AutomationEngine.handleEvent`, §10.1 step 1); `INDEX(tenant_id, status)` on `webhook_deliveries` (retry worker's polling query).

---

# 14. Schema Amendment Details Referenced Above

## 14.1 `core.items.low_stock_threshold` (amendment to `06` §5.6)

```text
New nullable column: low_stock_threshold numeric(18,4)

Populated per-item (tenant-configurable), consumed by §4.1's
StockLow event emission — a null threshold means the item never
fires StockLow (opt-in per item, not a blanket tenant setting,
since threshold-worthy items vary widely by turnover rate).
```

## 14.2–14.5

Already specified inline in §13's table above (`webhook_subscriptions`, `tasks`, `periodic_event_watermarks`, `notification_templates`).

---

# 15. Open Automation Questions

```text
1. Should Condition support OR-groups / nested logic, or is flat AND
   sufficient through MVP (§6)? Current spec is AND-only, matching
   the single worked example in 02 §38.
2. Should an Action be able to short-circuit remaining actions in
   the same rule on failure (e.g. "only send the webhook if the
   notification succeeded")? Currently all actions execute
   independently regardless of sibling outcomes (§10.3).
3. Rule authoring permission — a dedicated `automation.manage`
   permission (mirrors the resource.action pattern, 04 §34), or
   folded into the existing `settings.manage` permission?
4. Should the platform ship a starter library of pre-built rule
   templates (e.g. "Overdue Receivable Reminder," "Low Stock Alert")
   that a tenant can enable/customize with one click, rather than
   building every rule from scratch? Strongly suggested by the UX
   principle of minimal setup friction (03 §49) but not yet specified.
5. Webhook delivery dead-letter retention/cleanup — indefinite, or
   time-bounded (mirrors the identical open question already flagged
   for offline sync's device registry, 10 §15 Q3)?
6. Should `TASK_CREATION` (§7.4) eventually grow into a full
   lightweight task list per user (with due dates, completion
   tracking beyond OPEN/DONE), or remain a minimal reminder primitive
   indefinitely, consistent with the "Advanced Workflow Builder"
   MVP exclusion (03 §85)?
```

---

# 16. Decisions Established by This Document

### Decision AUT-001
No `Action` type in the automation engine may invoke a Core financial/stock-mutating Use Case (Sale/Purchase/Inventory/Accounting completion or adjustment) — the only permitted mutations are within the automation domain itself (`core.notifications`, `automation.*` tables) or via outbound calls to external systems (webhook/n8n). This generalizes `04` §156's n8n-specific prohibition to the automation engine as a whole and is enforced by the action executor's fixed, closed set of action-type implementations, not by convention.

### Decision AUT-002
A new `automation` schema is added to the canonical database (amendment to `06_DATABASE_SPECIFICATION.md` §3), containing `automation_rules`, `automation_executions`, `webhook_subscriptions`, `webhook_deliveries`, `tasks`, and `periodic_event_watermarks`; `core.notification_templates` is added to `06` §5.15.

### Decision AUT-003
`N8N_TRIGGER` is architecturally a specialization of the generic `WEBHOOK` action/delivery pipeline (§9), not a separate integration mechanism — this keeps exactly one retry/signature/dead-letter implementation to maintain, with n8n treated as one configured webhook target among potentially many.

### Decision AUT-004
Domain event handling by the automation engine (`AutomationEngine.handleEvent`, §10.1) always runs as an asynchronous consumer outside the originating Use Case's database transaction — a failure or slowdown in rule evaluation, notification delivery, or webhook delivery can never roll back or delay a Sale/Purchase/Payment/Return, concretely fulfilling the Domain Event Rule (`04` §44).

### Decision AUT-005
Periodic/derived events (`ExpiryApproaching`, `WarrantyExpiring`) are deduplicated via a per-`(tenantId, entityId, thresholdBand)` watermark (`automation.periodic_event_watermarks`), distinct from direct domain events, which require no deduplication since they are emitted exactly once per already-idempotent business transaction.

### Decision AUT-006
Webhook and n8n endpoint credentials/signing secrets are never stored as plaintext on the `AutomationRule`/`webhook_subscriptions` row itself — they are referenced by opaque ID into the tenant secret store, following the identical pattern already established for dedicated-database credentials (`06` §4.6) and other tenant secrets (`13` §7).

---

# 17. Next Document

পরবর্তী document:

`24_TESTING_STRATEGY.md`

এখানে platform-wide testing strategy একত্র ও চূড়ান্ত করা হবে — `03` §79–83-এ যা সংক্ষেপে বর্ণিত হয়েছিল, এবং প্রতিটি module document (`07`–`23`)-এ ছড়িয়ে থাকা "Testing Obligations" section-গুলো একটি সমন্বিত test plan-এ রূপান্তরিত হবে:

```text
Test pyramid finalization (Unit/Integration/Domain/API/E2E, per 04
  §122–123)
Financial/Inventory/Tenant-Isolation/Offline critical-path test
  matrices (consolidating 03 §80–83, 09 §12, 10 test obligations,
  13 §9.1)
Automation/AI test obligations consolidation (this document's §10 +
  22 §10)
CI gate policy (what blocks merge vs what is advisory, extending 04
  §124, 13 §9.3)
Test data/fixture strategy per module
Cross-module integration test scenarios (e.g. the full Decorator
  workflow test from 21 §9)
```
