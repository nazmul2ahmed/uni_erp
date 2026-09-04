# 26_SAAS_BILLING_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** SaaS Billing & Subscription Specification
**Version:** 1.0 Draft
**Status:** Cross-Cutting System Deep-Dive
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md` (§70–75, SaaS Commercial Model/Tenant Billing/Plan Limits/Enterprise Dedicated Plan/Control Plane vs Business Plane)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§68–74, Module Enablement/Plan-Based Feature/Feature Resolution/Tenant Limits/Usage Metering/Billing Separation; §100–101, Tenant Tier Strategy; §151–152, Cost Visibility/Commercial Benefit)
- `06_DATABASE_SPECIFICATION.md` (§4.5, `control.plans`/`control.subscriptions`; §4.8, `control.usage_events`)
- `13_SECURITY_SPECIFICATION.md` (§11, API Key/Service Account Security — future public API billing hook)
- `22_AI_ARCHITECTURE.md` (§8.2, AI-specific usage metering — one metric feeding this document's general mechanism)

---

# 1. Purpose

এই document platform-এর **commercial/billing layer**-কে concrete specification-এ রূপান্তর করে — `03` §70–75 এবং `05` §68–74/§100–101-এ যা conceptually established হয়েছিল তার বাস্তবায়নযোগ্য রূপ:

```text
Plan definition schema (extends control.plans, 06 §4.5)
Subscription lifecycle (TRIAL → ACTIVE → PAST_DUE → CANCELLED)
Usage metering aggregation + plan-limit enforcement mechanism
  (general-purpose, of which 22 §8.2's AI metering is one instance)
Payment gateway integration boundary (deferred in 04 §160, specified
  here)
Platform subscription invoicing (distinct from tenant BUSINESS
  invoicing, per Billing Separation, 05 §74)
Plan upgrade/downgrade transition rules
Dunning / past-due handling
```

**Foundational rule carried forward (per `05` §74, restated as this document's central boundary):**

> Billing subsystem (subscription/invoice/payment/usage) কে ERP-এর operational accounting (`core.sales`, `core.accounts`, `core.journals`)-এর সঙ্গে গুলিয়ে ফেলা যাবে না। Platform billing এবং tenant business accounting সম্পূর্ণ আলাদা domain — একই `Payment`/`Invoice` শব্দ ব্যবহৃত হলেও তারা ভিন্ন entity, ভিন্ন schema, ভিন্ন lifecycle।

---

# 2. Billing Domain Map

```text
CONTROL PLANE (platform-owned, per 05 §11)
        │
   control.plans ────────┐
        │                │
   control.subscriptions │
        │                │
   control.usage_events ─┘
        │
   billing.invoices          (NEW — this document)
   billing.payment_methods    (NEW — this document)
   billing.payment_attempts    (NEW — this document)
        │
   Payment Gateway Adapter (§7)


TENANT BUSINESS PLANE (per 05 §12, entirely separate)
        │
   core.sales / core.payments / core.accounts / core.journals
        │
   (a tenant's OWN customers paying THAT tenant — never touched by
   this document)
```

**This separation is drawn as two disjoint diagrams deliberately** — there is no schema-level or code-level bridge between them beyond `control.tenants.id` being the shared foreign key both sides reference independently.

---

# 3. Plan Definition — Finalized Schema

Extends `06` §4.5's stub.

## 3.1 `control.plans`

```text
id, key (STARTER/PROFESSIONAL/BUSINESS/ENTERPRISE), name,
price: Money, currency, billingInterval (MONTHLY/YEARLY),
limits: jsonb, moduleEntitlements: jsonb, isActive,
isPubliclyVisible (boolean — ENTERPRISE is typically sales-assisted,
  not self-serve, per 03 §73's "optional" framing),
createdAt, updatedAt
```

## 3.2 `limits` Shape (per `03` §72, `05` §72)

```text
{
  "users": 5,
  "branches": 1,
  "warehouses": 2,
  "monthlyInvoices": 500,
  "storageGb": 5,
  "aiRequestsPerMonth": 200,
  "automationExecutionsPerMonth": 1000
}

A null/absent key means "unlimited" for that metric on that plan
(ENTERPRISE typically has most keys absent). This jsonb shape,
NOT a fixed column set, is deliberate — new limit dimensions (e.g.
a future "apiCallsPerMonth" once the public API ships, per 05 §136)
can be added without a schema migration, only a plan-config update.
```

## 3.3 `moduleEntitlements` Shape (per `05` §70's "Plan-Based Feature")

```text
{
  "quotation": true, "booking": true, "service": true,
  "rental": true, "project": true,
  "pharmacy": true, "electronics": true, "decorator": true
}

This is a CEILING, not the tenant's actual enabled-module set
(tenant_features, 06 §4.7, remains the actual runtime toggle) — a
plan entitlement of `true` means the tenant MAY enable that module;
tenant_features still governs whether it actually IS enabled. This
two-layer design is the concrete mechanism behind 05 §71's Feature
Resolution chain: "Platform Flag + Plan Entitlement + Tenant
Override + Module State + User Permission -> Allowed/Denied."
```

**Rule (restated per `05` §70, Decision BIL-001 §14):** business/domain logic never hardcodes a plan check (e.g. `if (tenant.plan === 'ENTERPRISE')`) — it always resolves through the Feature Resolution chain (`05` §71), which happens to consult `moduleEntitlements` as one input among several. This keeps plan structure changeable without a code deploy.

---

# 4. Subscription Lifecycle

## 4.1 `control.subscriptions` — Finalized

Extends `06` §4.5's stub:

```text
id, tenantId, planId FK,
status: TRIAL | ACTIVE | PAST_DUE | CANCELLED | EXPIRED,
currentPeriodStart, currentPeriodEnd,
trialEndsAt: timestamptz nullable,
cancelledAt: timestamptz nullable,
cancelAtPeriodEnd: boolean default false,
paymentMethodId FK -> billing.payment_methods.id nullable,
createdAt, updatedAt
```

## 4.2 State Machine

```text
TRIAL
  ↓ (trial ends, valid payment method on file -> auto-transition;
     per §4.3)
ACTIVE
  ↓ (payment attempt fails, per §8)
PAST_DUE
  ↓ (successful retry payment)          ↓ (dunning period exhausted)
ACTIVE                                CANCELLED
  ↓ (owner-initiated, or dunning exhausted)
CANCELLED
  ↓ (grace period elapses without reactivation, per 05 §59's Tenant
     Deletion multi-step process — subscription CANCELLED triggers
     the TENANT lifecycle's own Suspended/Grace states, 05 §6, but
     is a DISTINCT state machine from Tenant.status; see §4.4)

TRIAL (no payment method attached by trialEndsAt) -> EXPIRED
  (terminal, distinct from CANCELLED — a tenant that never converted
  from trial, vs one that actively cancelled a paid subscription;
  useful analytics distinction, per 05 §150's Operational Dashboard)
```

## 4.3 Trial-to-Active Transition

```text
TrialConversionJob (scheduled, per 04 §45):
  for each Subscription WHERE status=TRIAL AND trialEndsAt <= now:
    if paymentMethodId is set AND payment gateway confirms the
    method is valid:
       attempt first charge (§7) -> on success: status=ACTIVE,
       currentPeriodStart/End set
       on failure: status=PAST_DUE (enters dunning, §8, immediately —
       no "trial grace" beyond trialEndsAt itself)
    else:
       status=EXPIRED
```

## 4.4 Relationship to `control.tenants.status` (per `05` §6)

```text
Subscription.status and Tenant.status (05 §6's PROSPECT/PROVISIONING/
ACTIVE/SUSPENDED/GRACE/ARCHIVED) are DELIBERATELY SEPARATE state
machines, linked by a one-way rule:

  Subscription CANCELLED or dunning-exhausted
        ↓ (drives, does not equal)
  Tenant.status -> SUSPENDED -> GRACE -> (eventual ARCHIVED per
        05 §59's deletion workflow)

  Tenant.status is never driven the other direction — a platform
  admin manually suspending a Tenant for a non-billing reason (e.g.
  05 §57's abuse/ToS scenario, or a security incident per 13 §12)
  does NOT touch Subscription.status at all; the two systems answer
  different questions ("is this tenant paid up" vs "is this tenant
  allowed to operate") and a tenant CAN be billing-current but
  administratively suspended.
```

This is flagged as **Decision BIL-002** (§14) precisely because conflating these two state machines is a common design mistake this document explicitly avoids.

---

# 5. Usage Metering — General Mechanism

Extends `05` §73 and generalizes `22` §8.2's AI-specific instance.

## 5.1 `control.usage_events` — Already Defined (per `06` §4.8), Usage Pattern Finalized

```text
Every metered action across the platform (not just AI) writes:
  tenantId, metricKey, quantity, periodStart, periodEnd, recordedAt

Metric keys (canonical list, extensible):
  "invoice_created"          -- one per completed Sale (07 §7.6)
  "user_seat_active"         -- recorded monthly per active
                                Membership, not per-event (§5.3)
  "storage_uploaded_bytes"    -- per Document upload (04 §56)
  "ai_assistant_query" |
  "ai_document_extraction" |
  "ai_draft_generation"        -- per 22 §8.2, unchanged, now
                                explicitly one instance of this
                                general mechanism
  "automation_execution"       -- per 23 §10.2's AutomationExecution,
                                one usage_event per rule evaluation
                                (matched or not — evaluation itself
                                is the metered cost, per §5.4)
```

## 5.2 `UsageMeteringService.record`

```text
record(tenantId, metricKey, quantity) -> void
  1. Append a control.usage_events row (append-only, never updated —
     mirrors the Stock Movement / Journal Entry ledger-first pattern,
     06 §9's cross-cutting principle applied to usage instead of
     money/stock)
  2. This is a FIRE-AND-FORGET call from the originating Use Case's
     perspective for non-blocking metrics (storage, automation) —
     but for LIMIT-ENFORCED metrics (§5.4), it is preceded by a
     synchronous check, not merely logged after the fact
```

## 5.3 Seat-Based Metrics (Users)

```text
Unlike event-driven metrics (invoice_created, ai_assistant_query),
"user_seat_active" is a POINT-IN-TIME snapshot, not a cumulative
counter — a scheduled job (monthly, aligned to
currentPeriodStart/End, per §4.1) counts
control.memberships WHERE tenant_id=:t AND status=ACTIVE and records
ONE usage_event per period, quantity=that count. This avoids
double-counting a user who was active the whole month vs. one who
joined mid-period under a naive per-event scheme.
```

## 5.4 Fail-Closed Limit Enforcement (per `05` §159, restated for billing)

```text
Before any action that would exceed a plan.limits[metricKey] value:
  1. Sum current-period control.usage_events for (tenantId, metricKey)
  2. If sum + this action's quantity > plan.limits[metricKey]:
       reject BEFORE the action executes, error code
       PLAN_LIMIT_EXCEEDED (new, extends 11 §3's error catalog)
  3. Only metrics with a non-null limit in the plan (§3.2) are
     enforced this way — metrics with no limit key (unlimited) skip
     step 1 entirely for performance

This mirrors 22 §8.2's AI-quota check exactly — that section was
already the concrete worked example of this general rule; this
document formalizes it as the platform-wide pattern (Decision
BIL-003, §14) rather than an AI-specific mechanism.
```

## 5.5 What Is NOT Fail-Closed

```text
Storage usage (storage_uploaded_bytes) and monthlyInvoices are
typically SOFT limits at MVP — exceeding them does not block the
action mid-transaction (a blocked Sale completion due to a billing
quota would be a severe UX/trust failure for a financial system,
inconsistent with 03 §4.5's Financial Integrity First principle
taking priority over commercial enforcement). Instead: the tenant
is flagged (control.tenant_features or a dedicated notification,
per 23 §7.1) and platform/tenant-admin is notified for a manual
upgrade conversation. Which metrics are hard-fail-closed (§5.4)
vs soft-flagged (this subsection) is a PER-METRIC plan-configuration
choice, not a blanket rule — flagged §15 Q1 for the exact per-metric
classification to finalize before launch.
```

---

# 6. Feature Resolution — Concrete Algorithm

Completes `05` §71's abstract chain.

```text
resolveFeature(tenantContext, featureKey) -> boolean:
  1. platformFlag = globalKillSwitch(featureKey)   -- platform-wide
     emergency disable, rare, e.g. a feature with a discovered bug
     -> if platformFlag == false: return false (overrides everything
        below, fail-closed)
  2. planEntitlement = plan.moduleEntitlements[featureKey] ?? false
     -> if false: return false (tenant's plan simply doesn't include
        this capability, regardless of tenant_features)
  3. tenantOverride = control.tenant_features WHERE
     tenant_id=:t AND feature_key=:featureKey
     -> if explicitly false: return false (tenant chose to disable
        a capability their plan includes)
     -> if explicitly true (and planEntitlement allowed it): continue
     -> if absent: default to planEntitlement's value
  4. moduleState = is this an Optional Module (14-18) that also has
     its own internal "enabled" toggle distinct from tenant_features?
     (per 06 §4.7, tenant_features already IS this toggle for
     Optional Modules — no separate layer needed at MVP; flagged as
     a potential redundancy to collapse, §15 Q2)
  5. userPermission = does the current actor's role include the
     relevant resource.action permission? (04 §34 — orthogonal to
     billing entirely, RBAC not plan-driven)
  6. return ALL of steps 1-5 pass
```

**This function is called from the SAME navigation-resolution and API-authorization code paths already specified in `12` §3.4 and `11` §20** — this document adds no new call site; it only finalizes what `resolveFeature`'s internals actually check, since `12`/`05` referenced it without full algorithmic detail.

---

# 7. Payment Gateway Integration Boundary

Concretizes the deferred concept from `04` §160.

## 7.1 Adapter Interface

```text
interface PaymentGatewayAdapter {
  createPaymentMethod(tenantId, gatewayToken) -> PaymentMethodRef
  charge(paymentMethodRef, amount: Money, idempotencyKey) ->
    Result<ChargeResult, ChargeError>
  refund(chargeRef, amount: Money) -> Result<RefundResult, RefundError>
  handleWebhook(payload, signature) -> GatewayEvent
}

Implementations: one per supported gateway (e.g. Stripe-compatible,
  a regional Bangladesh gateway such as bKash/SSLCommerz-style
  provider — EXACT gateway choice deferred, per 03 §174's "Payment
  gateway choices" explicit-product-approval category, unchanged
  from that document's original flag).
```

## 7.2 Idempotency (per `04` §39's pattern, applied to billing charges)

```text
Every charge() call carries an idempotencyKey derived from
(tenantId, subscriptionId, currentPeriodStart) for a regular renewal
charge — retrying a renewal attempt (e.g. after a transient network
failure) never double-charges the tenant, mirroring the platform-
wide idempotency contract already established for every OTHER
financial mutation (07 §17) but applied here to the CONTROL PLANE's
own billing charges rather than tenant business transactions.
```

## 7.3 Webhook Handling (gateway → platform)

```text
Most payment gateways report asynchronous outcomes (charge success/
failure, chargeback, subscription-relevant events) via THEIR OWN
webhook to the platform — this is architecturally the INBOUND
counterpart to 23 §9's OUTBOUND webhook delivery, and reuses the
identical signature-verification discipline (13 §7's secret handling,
23 §9.2's HMAC pattern) in reverse: the platform verifies the
gateway's signature before trusting the payload, never processes an
unsigned/unverifiable billing webhook.

Received gateway events update billing.payment_attempts (§8.1) and,
where relevant, drive the Subscription state machine (§4.2) —
e.g. a gateway-reported failed renewal charge transitions
ACTIVE -> PAST_DUE.
```

## 7.4 What the Gateway Adapter Never Touches

```text
Per the Billing Separation principle (05 §74, §2 above): the Payment
Gateway Adapter NEVER writes to core.payments, core.receivables, or
any tenant-business-plane table. A gateway charge against a tenant's
OWN saved card for their PLATFORM SUBSCRIPTION fee is entirely
distinct from that same tenant recording a payment FROM THEIR
CUSTOMER in core.payments (07 §10) — even if, coincidentally, both
happen to use the same underlying gateway PROVIDER at the
infrastructure level, they are two separate PaymentGatewayAdapter
configurations/credentials (platform-level vs tenant-level, per 13
§7's category distinction), never shared state.
```

---

# 8. Platform Subscription Invoicing

## 8.1 `billing.invoices` (NEW table)

```text
id, tenantId, subscriptionId FK, planId FK (snapshot at issue time —
  see §8.3), amount: Money, currency, status (DRAFT/ISSUED/PAID/
  VOID/UNCOLLECTIBLE), periodStart, periodEnd, issuedAt, dueAt,
  paidAt nullable, createdAt

billing.payment_attempts
  id, tenantId, invoiceId FK, gatewayChargeRef, status (SUCCEEDED/
  FAILED), failureReason nullable, attemptedAt, idempotencyKey
```

## 8.2 Generation Flow

```text
GenerateSubscriptionInvoiceUseCase (scheduled, per §4.1's
  currentPeriodEnd approaching, or triggered by §4.3's trial
  conversion):
  1. Snapshot plan.price/currency at THIS moment into the Invoice row
     (§8.3 — protects historical invoices from a later plan price
     change)
  2. Persist Invoice (status=ISSUED)
  3. Attempt charge via PaymentGatewayAdapter (§7.2)
  4. On success: Invoice.status=PAID, Subscription period advances
  5. On failure: Invoice remains ISSUED (unpaid), Subscription ->
     PAST_DUE, dunning begins (§9)
```

## 8.3 Why Invoice Snapshots the Plan Price

```text
Mirrors the platform-wide "never retroactively mutate historical
records" principle (02 §52, already applied to PharmacyBatchDetails'
genericNameSnapshot, 19 §4.1, for an identical reason) — if a plan's
price changes between when a tenant subscribed and when a later
invoice is generated, that LATER invoice reflects the price in
effect AT ISSUE TIME (which may itself differ from the ORIGINAL
subscription price if the tenant was grandfathered — grandfathering
logic is out of scope for this document, flagged §15 Q3), but a
PAST, already-issued invoice never silently changes.
```

## 8.4 Tenant-Visible Billing History

```text
GET /api/tenant/billing/invoices  [settings.view, Owner-only per
  §11's permission note]
  -> lists billing.invoices for the tenant's own subscription,
  entirely separate from GET /api/sales (07/11) which lists the
  tenant's OWN customer-facing sales — same "Invoice" word, two
  disjoint API surfaces, per §2's diagram.
```

---

# 9. Dunning / Past-Due Handling

## 9.1 Dunning Schedule

```text
Subscription enters PAST_DUE (§4.2) on first failed charge:
  Day 0:  PAST_DUE, in-app banner + email notification (via the
          Automation/Notification mechanism, 23 §11 — dunning
          notifications are themselves just AutomationRule-triggered
          NOTIFICATION actions on a "SubscriptionPastDue" platform
          event, reusing 23's existing engine rather than inventing
          a parallel notification path)
  Day 3:  automatic retry charge attempt (§7.2, new idempotencyKey
          scoped to this retry)
  Day 7:  second retry
  Day 14: final retry; if still failing -> Subscription -> CANCELLED,
          Tenant.status driven toward SUSPENDED per §4.4's one-way
          rule

Exact day offsets are placeholder values pending product input,
flagged §15 Q4 (mirrors similar placeholder-value patterns already
accepted elsewhere in this series, e.g. 10 §15 Q1's retry backoff
schedule).
```

## 9.2 Grace Behavior During PAST_DUE

```text
A PAST_DUE tenant is NOT immediately suspended (05 §57-58's
Suspension mechanics do not activate until CANCELLED is reached,
per §4.4) — business operations continue normally during the
dunning window, since immediately locking out a tenant on the FIRST
failed payment (which is very often a transient card-decline, not
an intentional non-payment) would be a disproportionate response
inconsistent with 03 §4.5's Financial Integrity First principle
prioritizing the TENANT'S OWN business continuity over the
PLATFORM'S collection aggressiveness.
```

---

# 10. Plan Upgrade / Downgrade

## 10.1 Upgrade (immediate effect)

```text
UpgradeSubscriptionUseCase:
  1. Validate target plan exists, is active, is publicly visible OR
     the tenant has explicit sales-assisted access (ENTERPRISE, §3.1)
  2. Prorate: charge the price difference for the remaining current
     period (standard SaaS proration — exact formula is an
     implementation detail, not an architecture-freeze item)
  3. Subscription.planId updates IMMEDIATELY (moduleEntitlements
     ceiling raises immediately, per §6's resolution algorithm
     re-evaluating on next request — no caching staleness concern,
     since §6 is a per-request resolution, not a cached snapshot)
  4. Audit log (platform-level, per 06 §4.9)
```

## 10.2 Downgrade (deferred to period end)

```text
DowngradeSubscriptionUseCase:
  1. Subscription.cancelAtPeriodEnd-style field records the pending
     planId change, NOT applied immediately
  2. At currentPeriodEnd (§4.1), a scheduled job applies the new
     planId
  3. If the tenant currently has MORE enabled modules/usage than the
     target plan's limits allow (e.g. downgrading from BUSINESS to
     STARTER while having 3 branches but STARTER limits to 1):
       the downgrade is NOT silently blocked, but tenant_features
       for modules the new plan doesn't entitle are force-disabled
       at the transition moment, and usage OVER a hard limit (§5.4)
       is grandfathered read-only (existing data is never deleted
       for exceeding a plan limit — per 04 §97's soft-delete/archive
       philosophy applied to plan-limit overflow, not just entity
       deletion) but NEW creation against that limit is blocked
       going forward until usage drops or the tenant upgrades again
```

**Rule (Decision BIL-004, §14):** downgrading a plan never destroys or hides a tenant's existing business data — it only constrains what NEW actions the tenant can take going forward, consistent with the platform-wide principle that commercial/plan mechanics are configuration, never a vector for data loss (`02` §52 restated once more, applied to commercial state rather than transaction correction).

---

# 11. API Detail (extends `11`)

```text
GET    /api/tenant/billing/subscription     [settings.view]
POST   /api/tenant/billing/subscription/upgrade  [settings.manage,
                                              Owner-only]
                                              -> UpgradeSubscriptionUseCase
POST   /api/tenant/billing/subscription/downgrade [settings.manage,
                                              Owner-only]
                                              -> DowngradeSubscriptionUseCase
POST   /api/tenant/billing/subscription/cancel     [settings.manage,
                                              Owner-only]
                                              -> sets
                                              cancelAtPeriodEnd=true
GET    /api/tenant/billing/invoices          [settings.view]
GET    /api/tenant/billing/usage             [settings.view]
                                              -> current-period
                                              usage_events summary
                                              per metricKey vs plan
                                              limits (powers a
                                              tenant-facing usage
                                              dashboard, mirroring
                                              05 §151's platform-side
                                              cost-visibility concept
                                              from the tenant's own
                                              vantage point)
POST   /api/tenant/billing/payment-method     [settings.manage,
                                              Owner-only]
                                              -> stores a new
                                              gateway token via
                                              PaymentGatewayAdapter.
                                              createPaymentMethod (§7.1)

Webhook (inbound, gateway -> platform, §7.3):
POST   /api/webhooks/payment-gateway          -> signature-verified,
                                              no session auth (mirrors
                                              14 §5.4's public-
                                              endpoint-with-alternate-
                                              auth pattern, here using
                                              gateway signature instead
                                              of a view-token)
```

**Owner-only note:** billing-mutating endpoints require the Owner role specifically (not merely `settings.manage`, which a Manager might also hold) — flagged as `Decision BIL-005` (§14), since commercial/financial-obligation decisions for the tenant's OWN subscription warrant the platform's narrowest role, consistent with `05` §75's "Tenant Owner" concept and distinct from the tenant's own internal `accounting.post`-style elevated permissions which govern the tenant's BUSINESS accounting, not their platform bill.

---

# 12. Testing Obligations

```text
[ ] Subscription state machine — every valid/invalid transition,
    especially TRIAL->EXPIRED vs TRIAL->ACTIVE branching on payment
    method presence (§4.2-4.3)
[ ] Feature Resolution (§6) — a comprehensive matrix test: platform
    kill-switch overrides plan entitlement overrides tenant override
    overrides default, at every layer-combination
[ ] Usage metering fail-closed enforcement (§5.4) — an action at
    exactly the limit succeeds, one unit over is rejected with
    PLAN_LIMIT_EXCEEDED (mirrors the platform's general exact-
    boundary testing methodology, 24 §12 point 4)
[ ] Charge idempotency (§7.2) — retrying a renewal charge after a
    simulated network failure never double-charges (mirrors 07 §19's
    idempotency-replay test class, applied to billing.payment_attempts)
[ ] Invoice price snapshot (§8.3) — changing a plan's price after an
    invoice is issued never retroactively alters that invoice
[ ] Downgrade grandfathering (§10.2) — existing over-limit data is
    never deleted; new creation against the exceeded limit is blocked
[ ] Dunning schedule (§9.1) — correct notification/retry timing,
    eventual CANCELLED transition, Tenant.status correctly driven
    per §4.4's one-way rule
[ ] Billing/Business plane isolation (§2, §7.4) — a test asserting
    NO code path in PaymentGatewayAdapter ever writes to
    core.payments/core.receivables (a static/architectural test,
    mirroring the class of test already used for 23 §4.3's
    action-type inventory check)
```

---

# 13. Decisions Established by This Document

### Decision BIL-001
Business/domain logic never hardcodes a plan-tier check; every capability gate resolves through the Feature Resolution algorithm (§6), keeping plan structure changeable via configuration alone.

### Decision BIL-002
`Subscription.status` and `Tenant.status` are deliberately separate state machines linked by one one-directional rule (subscription cancellation drives tenant suspension, never the reverse) — a tenant can be billing-current but administratively suspended, or (during a dunning grace window) billing-delinquent but still operationally active.

### Decision BIL-003
The fail-closed usage-limit enforcement pattern first specified for AI usage (`22` §8.2) is generalized as the platform-wide `UsageMeteringService` mechanism (§5.4) — AI metering was always meant as one instance of this general rule, not a special case.

### Decision BIL-004
Downgrading a subscription plan never deletes or hides existing tenant business data exceeding the new plan's limits — it only blocks new creation against the exceeded limit going forward, consistent with the platform's reversal/archive-over-destructive-edit principle applied to commercial state.

### Decision BIL-005
Subscription-mutating endpoints (upgrade/downgrade/cancel/payment-method) require the tenant's Owner role specifically, distinct from the general `settings.manage` permission a Manager role might also hold.

### Decision BIL-006
The Payment Gateway Adapter used for platform subscription billing is architecturally and credential-wise entirely separate from any payment gateway a tenant might configure for their own customer-facing transactions (`03` §160's future module) — even when the same underlying provider is used by both, they are configured, authenticated, and coded as two independent integrations, never shared state or a shared adapter instance.

---

# 14. Open Billing Questions

```text
1. Per-metric fail-closed vs soft-flagged classification (§5.5) —
   which specific metrics beyond AI usage (already fail-closed, 22
   §8.2) get hard enforcement vs soft notification? Needs a full
   metric-by-metric decision before launch.
2. Is `moduleState` (§6 step 4) a genuinely necessary fourth layer,
   or is it redundant with `tenant_features` (step 3) at MVP scale —
   should it be collapsed out of the resolution algorithm entirely?
3. Grandfathered pricing (§8.3's aside) — does the platform need to
   support "this tenant keeps their original signup price even after
   the public plan price changes," and if so, does that require a
   per-subscription price override field distinct from plan.price?
4. Exact dunning schedule day-offsets (§9.1) — placeholder values
   pending product/finance input, same category as several other
   placeholder-value decisions already accepted elsewhere in this
   series (e.g. session timeout, `13` §14 Q1).
5. Does a public self-serve signup flow (STARTER/PROFESSIONAL,
   per §3.1's "publicly visible" plans) ship at MVP, or is the
   platform's first commercial vertical (`03` §87, Electronics +
   Service) entirely sales-assisted onboarding regardless of plan
   tier, deferring self-serve billing UI to a later phase?
```

---

# 15. Next Document

পরবর্তী document:

`27_MIGRATION_SPECIFICATION.md`

এখানে data migration architecture বিস্তারিত হবে — `01` §31 (Migration Philosophy, legacy Pharmacy PWA থেকে), `03` §68–69 (Shared → Dedicated / Dedicated → Shared tenant migration), `05` §101–105 (Migration Verification/Rollback/Schema Version), এবং `19` §10 (legacy field mapping table, ইতিমধ্যে শুরু হয়েছে)-কে একত্র করে একটি সম্পূর্ণ migration specification:

```text
Legacy Pharmacy PWA data export/transform/import pipeline (concrete,
  building on 19 §10's field-mapping table)
Canonical ERP data model validation rules for imported data
Shared ↔ Dedicated tenant migration — concrete step-by-step procedure
  (extends 05 §101-105's conceptual flow)
Reconciliation checklist (row counts, financial totals, stock
  totals — extends 05 §103)
Rollback procedure for a failed migration
Generic tenant data import/export framework (per 03 §56-57, CSV/
  Excel/JSON — for onboarding NEW tenants from other systems, not
  just the one legacy Pharmacy PWA)
```
