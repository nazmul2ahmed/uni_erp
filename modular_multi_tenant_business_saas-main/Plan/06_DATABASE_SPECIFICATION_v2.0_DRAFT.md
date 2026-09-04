# 06_DATABASE_SPECIFICATION.md — v2.0 DRAFT

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Canonical Database Specification
**Version:** 2.0 DRAFT (Phase 0.5 Reconciliation)
**Status:** ⚠️ DRAFT — NOT YET APPROVED. Supersedes v1.0 only upon explicit sign-off.
**Reconciliation basis:** Phase 0.5 Documentation Baseline Audit + Second-Pass Verification Report
**Amendment declaration policy:** Option C (per Phase 0.5) — every amending document must self-declare its amendment (Decision tag), AND this document maintains a central Amendment Ledger (§16) cross-referencing every merged change back to its source document/section.

---

## 0. Changelog Preface (v1.0 → v2.0)

This revision performs **zero new design decisions**. It exclusively:

1. Merges every schema amendment that was already declared (explicitly or implicitly) in documents `08` through `27`, as catalogued in the Phase 0.5 Verification Report.
2. Adds three new top-level schema groups (`automation`, `billing`, `migration`) to §3, correcting the registry-drift finding.
3. Adds a new §15 "Required PostgreSQL Extensions" section (previously absent from any document).
4. Adds a new §16 "Amendment Ledger" satisfying the Option C policy.
5. Retroactively assigns amendment-declaration tags to `26_SAAS_BILLING_SPECIFICATION.md`, `27_MIGRATION_SPECIFICATION.md`, and `13_SECURITY_SPECIFICATION.md` §2.6, none of which had formally flagged their schema additions against this document.

**Nothing in this draft invents a business rule, resolves an open question, or changes a decision already made.** Where an amending document left a field's exact type/nullability ambiguous, that ambiguity is preserved and flagged inline as `[UNSPECIFIED — carried from source]`.

All original v1.0 content (§1–§14, renumbered as §1–§14 below with amendments inserted in place) is retained; nothing has been deleted.

---

# 1. Purpose

(Unchanged from v1.0.)

এই document platform-এর **canonical database schema** নির্ধারণ করে — PostgreSQL-এর ওপর ভিত্তি করে, Drizzle ORM দিয়ে বাস্তবায়িত হবে।

```text
Control Plane Schema
      ↓
Core Business Schema
      ↓
Module Schema
      ↓
Industry Extension Schema
      ↓
Automation Schema        [NEW in v2.0 — merged from 23]
      ↓
Billing Schema           [NEW in v2.0 — merged from 26]
      ↓
Migration Schema         [NEW in v2.0 — merged from 27]
```

---

# 2. Naming & Type Conventions

(Unchanged from v1.0 — see original document for full text.)

---

# 3. Schema Grouping — AMENDED

**v1.0 declared four groups. v2.0 adds three, per Phase 0.5 Finding 2.**

```text
schema: control     (Control Plane — platform-owned)
schema: core        (Tenant business core)
schema: modules     (Quotation, Booking, Service, Rental, Project)
schema: industry    (Pharmacy, Electronics, Decorator)
schema: automation  (Rules, executions, webhooks, tasks — NEW, per 23 §13, Decision AUT-002)
schema: billing     (Platform subscription invoices/payments — NEW, per 26 §3/§8, retroactively declared here as Decision BIL-006-SCHEMA)
schema: migration   (Staging tables for data migration — NEW, per 27 §2.3, retroactively declared here as Decision MIG-006-SCHEMA)
```

**Amendment note:** `23_AUTOMATION_ARCHITECTURE.md` §13 already explicitly declared the `automation` group as an amendment to this section — that declaration is honored verbatim. `26_SAAS_BILLING_SPECIFICATION.md` and `27_MIGRATION_SPECIFICATION.md` introduced `billing.*`/`migration.*` tables **without** an explicit schema-group-level amendment declaration (Phase 0.5 Finding 2, CONFIRMED). This v2.0 draft retroactively supplies that declaration; `26` and `27` should each receive a small addendum in a future pass acknowledging it, per the Option C dual-declaration policy.

Shared-tenant mode: `control`, `automation`, `billing`, `migration` schemas are platform/control-adjacent — `billing.*` and `migration.*` are **control-plane-scoped, not tenant-database-scoped** (see §3.1 below, a clarification not present in v1.0 and required by the merge).

## 3.1 Control-Plane vs Tenant-Database Placement — CLARIFICATION (new in v2.0)

v1.0 did not state where `billing.*` and `migration.*` physically live relative to Shared vs Dedicated tenant databases. Per `26` §2 ("this separation is drawn as two disjoint diagrams") and `27` §2.3 ("mirrors automation's own schema addition pattern"), the following placement is inferred directly from those documents' own text and is recorded here as a **carried-forward clarification, not a new decision**:

```text
control       → Control Plane database only
billing       → Control Plane database only (per 26 §2's explicit
                 Control-Plane-only diagram)
migration     → Control Plane database only (staging area for
                 per-tenant import, not itself tenant-owned data)
automation    → Tenant-scoped (per 23 §13's tables all carry
                 tenant_id — lives alongside core/modules/industry
                 in Shared mode, or in the Dedicated tenant's own
                 database in Dedicated mode)
core/modules/
  industry     → Tenant-scoped (unchanged from v1.0)
```

**This placement is not explicitly stated as such in either `26` or `27`; it is the most literal reading of their diagrams. Flagged in the Amendment Ledger (§16) as requiring human confirmation, not silently asserted as settled.**

---

# 4. Control Plane Schema — AMENDED

## 4.1 `control.users` — AMENDED

**v1.0 fields unchanged.** Adds MFA hook fields per `13_SECURITY_SPECIFICATION.md` §2.6, which did not carry an explicit amendment-declaration tag against this document (Phase 0.5 Finding, "not flagged as amendment at all"). Retroactively declared here as **Decision SEC-006-SCHEMA**.

| Column | Type | Notes |
|---|---|---|
| *(all v1.0 columns unchanged)* | | |
| `mfa_enabled` | boolean | default false — per `13` §2.6 |
| `mfa_secret_ref` | text | nullable — pointer into secret manager, **never** a raw TOTP secret in plaintext (per `13` §2.6 explicit instruction) |

## 4.2 `control.tenants`

(Unchanged from v1.0.)

## 4.3 `control.memberships`

(Unchanged from v1.0.)

## 4.4 `control.roles` / `control.permissions` / `control.role_permissions`

(Unchanged from v1.0.)

## 4.5 `control.plans` / `control.subscriptions` — AMENDED

**v1.0 stub finalized** per `26_SAAS_BILLING_SPECIFICATION.md` §3.1, §3.2, §3.3, §4.1 (Decision BIL — not individually numbered per-field in `26`, treated here as one consolidated amendment).

```text
control.plans
  id, key (STARTER/PROFESSIONAL/BUSINESS/ENTERPRISE), name,
  price numeric(18,4), currency, billing_interval (MONTHLY/YEARLY),
  limits jsonb,                 -- shape per 26 §3.2, extensible
  module_entitlements jsonb,    -- shape per 26 §3.3, a CEILING not
                                    the actual runtime toggle
  is_active, is_publicly_visible boolean,
  created_at, updated_at

control.subscriptions
  id, tenant_id, plan_id FK,
  status (TRIAL/ACTIVE/PAST_DUE/CANCELLED/EXPIRED),   -- amended:
                                    v1.0 listed only TRIAL/ACTIVE/
                                    PAST_DUE/CANCELLED; 26 §4.1 adds
                                    EXPIRED (trial that never converted)
  current_period_start, current_period_end,
  trial_ends_at timestamptz nullable,
  cancelled_at timestamptz nullable,
  cancel_at_period_end boolean default false,
  payment_method_id FK -> billing.payment_methods.id nullable,
  created_at, updated_at
```

**Amendment flag:** Decision BIL-SCHEMA-001 (new, this document) — `control.subscriptions.status` enum extended with `EXPIRED`; `payment_method_id` FK added, pointing into the new `billing` schema (§11 below).

## 4.6 `control.tenant_databases`

(Unchanged from v1.0.)

## 4.7 `control.tenant_features`

(Unchanged from v1.0.)

## 4.8 `control.usage_events`

(Unchanged from v1.0 structurally. `22` §8.2 and `26` §5.1 both consume this table without schema modification — confirmed no amendment needed here, only usage-pattern documentation which lives in those source documents, not here.)

## 4.9 `control.audit_events_platform`

(Unchanged from v1.0.)

---

# 5. Core Business Schema — AMENDED

## 5.1 `core.business_profiles`

(Unchanged from v1.0.)

## 5.2 `core.branches`

(Unchanged from v1.0.)

## 5.3 `core.warehouses`

(Unchanged from v1.0.)

## 5.4 `core.customers`

(Unchanged from v1.0.)

## 5.5 `core.suppliers`

(Unchanged from v1.0.)

## 5.6 `core.items` — AMENDED

Adds `low_stock_threshold`, per `23_AUTOMATION_ARCHITECTURE.md` §14.1 (Decision AUT-002, already self-declared as an amendment to this section).

| Column | Type | Notes |
|---|---|---|
| *(all v1.0 columns unchanged)* | | |
| `low_stock_threshold` | numeric(18,4) | nullable — per `23` §14.1; null = item never fires `StockLow` event; opt-in per item |

## 5.7 `core.item_categories` / `core.brands` / `core.units`

(Unchanged from v1.0.)

## 5.8 Sales Domain

### `core.sales` / `core.sale_items`

(Unchanged from v1.0. No amendment declared by any later document.)

## 5.9 Purchase Domain

### `core.purchases` / `core.purchase_items` / `core.purchase_documents`

(Unchanged from v1.0.)

## 5.10 Inventory Domain — AMENDED

### `core.stock_movements`

(Unchanged from v1.0.)

### `core.stock_balances` — AMENDED

Adds `weighted_avg_cost`, per `09_INVENTORY_ENGINE_SPECIFICATION.md` §6.2 (Decision INV-004, already self-declared).

```text
core.stock_balances
  tenant_id, item_id, warehouse_id, batch_id (nullable),
  quantity_on_hand, quantity_reserved, updated_at,
  weighted_avg_cost   numeric(18,4)   -- NEW, per 09 §6.2 — null for
                                          batch/serial-valued items
                                          (specific-identification
                                          costing used instead, per
                                          09 §6.1)
```

### `core.stock_batches` / `core.stock_serials`

(Unchanged from v1.0.)

### `core.stock_counts` / `core.stock_count_lines` — NEW (added in v2.0)

Per `09_INVENTORY_ENGINE_SPECIFICATION.md` §9.1 (Decision INV-005, already self-declared).

```text
core.stock_counts
  id, tenant_id, warehouse_id,
  status (DRAFT/IN_PROGRESS/COMPLETED/CANCELLED),
  counted_by, started_at, completed_at, created_at

core.stock_count_lines
  id, tenant_id, stock_count_id FK, item_id FK, batch_id? FK,
  system_quantity   numeric(18,4)   -- snapshot at count start
  counted_quantity   numeric(18,4)   -- entered by staff
  variance            numeric(18,4)   -- derived = counted - system
  created_at
```

### `core.accounting_periods` — NEW (added in v2.0)

Per `08_ACCOUNTING_ENGINE_SPECIFICATION.md` §9.4 (Decision ACC-004, already self-declared).

```text
core.accounting_periods
  id, tenant_id, period_start, period_end,
  status (OPEN/CLOSED), closed_at, closed_by,
  created_at
```

**Unique:** `UNIQUE(tenant_id, period_start, period_end)`, non-overlapping ranges enforced at application layer (per `08` §9.4).

## 5.11 Payment / Receivable / Payable Domain

(Unchanged from v1.0.)

## 5.12 Returns Domain

(Unchanged from v1.0.)

## 5.13 Expense Domain

(Unchanged from v1.0.)

## 5.14 Accounting Domain

(Unchanged from v1.0 — `core.accounts`, `core.journals`, `core.journal_entries`, `core.opening_entries`. `core.accounting_periods` is now documented under §5.10 per its natural grouping with inventory-adjacent lifecycle tables — cross-referenced here.)

## 5.15 Documents / Audit / Notifications — AMENDED

### `core.documents` / `core.audit_logs`

(Unchanged from v1.0.)

### `core.notifications`

(Unchanged from v1.0 structurally.)

### `core.notification_templates` — NEW (added in v2.0)

Per `23_AUTOMATION_ARCHITECTURE.md` §13 (Decision AUT-002, already self-declared as amending this section).

```text
core.notification_templates
  id, tenant_id nullable (null = platform default), template_key,
  channel, subject_template, body_template, updated_at
```

**Unique:** `UNIQUE(tenant_id, template_key, channel)` where `tenant_id IS NOT NULL`.

## 5.16 Drafts

(Unchanged from v1.0.)

## 5.17 Staff / RBAC

(Unchanged from v1.0.)

---

# 6. Module Schema (Optional Modules) — AMENDED

## 6.1 `modules.quotations` / `modules.quotation_items` — AMENDED

Per `14_MODULE_QUOTATION.md` §6 (Decision QTN-001, already self-declared).

```text
modules.quotations
  id, tenant_id, customer_id FK, status
    (DRAFT/SENT/VIEWED/ACCEPTED/REJECTED/EXPIRED/CONVERTED),
  valid_until, subtotal, discount_total, tax_total, grand_total,
  terms, converted_sale_id FK nullable,
  created_at, updated_at, created_by,
  -- NEW fields, per 14 §6:
  branch_id                  uuid FK
  supersedes_quotation_id      uuid FK nullable
  view_token                    text UNIQUE
  viewed_at                      timestamptz nullable
  responded_at                    timestamptz nullable
  respondent_note                  text nullable
  operation_id

modules.quotation_items
  id, tenant_id, quotation_id FK, item_id FK nullable,
  description, quantity, unit_price, line_total,
  -- NEW fields, per 14 §6:
  line_discount, tax_amount   -- pricing parity with SaleLine (07 §7.2)
```

**Unique:** `UNIQUE(tenant_id, quotation_number)`, `UNIQUE(tenant_id, operation_id)`, `UNIQUE(view_token)`.

## 6.2 `modules.bookings` — AMENDED

Per `18_MODULE_BOOKING.md` §7 (Decision BKG-001, already self-declared).

```text
modules.bookings
  id, tenant_id, customer_id FK, resource_type, resource_id,
  starts_at, ends_at, status (DRAFT/HOLD/CONFIRMED/IN_PROGRESS/
    COMPLETED/CANCELLED),
  advance_amount, notes,
  created_at, updated_at,
  -- NEW fields, per 18 §7:
  branch_id                  uuid FK
  operation_id
  cancelled_at                 timestamptz nullable
  cancelled_reason               text nullable
```

**Concurrency constraint — confirmed canonical DDL (per `18` §4.1, previously only conceptually described in v1.0):**

```sql
ALTER TABLE modules.bookings
  ADD CONSTRAINT no_overlapping_bookings
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_type WITH =,
    resource_id WITH =,
    tsrange(starts_at, ends_at) WITH &&
  )
  WHERE (status IN ('HOLD', 'CONFIRMED', 'IN_PROGRESS'));
```

**Requires the `btree_gist` PostgreSQL extension — see §15.**

**Unique:** `UNIQUE(tenant_id, operation_id)`. No `UNIQUE` on resource+window (the exclusion constraint enforces non-overlap, not a UNIQUE constraint).

## 6.3 `modules.service_orders` / `modules.service_order_items` — AMENDED

Per `15_MODULE_SERVICE.md` §8 (Decision SRV-001, already self-declared).

```text
modules.service_orders
  id, tenant_id, customer_id FK, asset_reference text nullable,
  problem_description, diagnosis, technician_user_id FK nullable,
  status (RECEIVED/DIAGNOSING/QUOTED/AWAITING_APPROVAL/IN_PROGRESS/
    COMPLETED/CANCELLED/UNCLAIMED),   -- amended: v1.0 listed a
    shorter status set; 15 §4 adds AWAITING_APPROVAL and UNCLAIMED
  warranty_reference_id FK nullable,
  invoice_sale_id FK nullable,
  created_at, updated_at,
  -- NEW fields, per 15 §8:
  branch_id                    uuid FK
  subtotal, discount_total, tax_total, grand_total   numeric(18,4)
  promised_at                    timestamptz nullable
  completed_at                     timestamptz nullable
  cancelled_at                       timestamptz nullable
  cancelled_reason                     text nullable
  operation_id

modules.service_order_items
  id, tenant_id, service_order_id FK,
  type (PART/LABOUR), item_id FK nullable, description,
  quantity, unit_price, line_total,
  -- NEW fields, per 15 §8:
  inventory_already_deducted   boolean default false
  consumption_movement_id        uuid FK -> core.stock_movements.id
                                  nullable
```

**Unique:** `UNIQUE(tenant_id, order_number)`, `UNIQUE(tenant_id, operation_id)`.

## 6.4 `modules.rental_assets` / `modules.rental_orders` / `modules.rental_order_items` — AMENDED

Per `16_MODULE_RENTAL.md` §7 (Decision RNT-001, already self-declared). New table added.

```text
modules.rental_assets
  id, tenant_id, item_id FK, status
    (AVAILABLE/RESERVED/DISPATCHED/RENTED/RETURNED/MAINTENANCE/
     RETIRED),   -- amended: v1.0 lacked RETIRED; 16 §3 adds it
  created_at, updated_at,
  -- NEW fields, per 16 §7:
  asset_tag       text nullable
  condition        text (GOOD/FAIR/DAMAGED/UNDER_REPAIR) default GOOD

modules.rental_orders
  id, tenant_id, customer_id FK, booking_id FK nullable,
  status (RESERVED/DISPATCHED/RETURNED/CLOSED/CANCELLED),   -- amended:
    v1.0 lacked CANCELLED; 16 §4 adds it
  dispatch_at, expected_return_at, actual_return_at,
  damage_charge numeric(18,4) default 0,
  created_at, updated_at,
  -- NEW fields, per 16 §7:
  branch_id                    uuid FK
  subtotal, discount_total, tax_total, grand_total   numeric(18,4)
  operation_id
  -- NEW field, per 21 §5.3 (Decorator extension, Decision DEC-004):
  project_id                    uuid FK -> modules.projects.id
                                 nullable   -- optional, backward-
                                 compatible parameter added to
                                 ReserveRentalUseCase's input;
                                 tenants without Project enabled
                                 never populate this

modules.rental_order_items
  id, tenant_id, rental_order_id FK, rental_asset_id FK,
  rate, period_unit (HOUR/DAY/EVENT), quantity, line_total
  -- no amendment; already complete per v1.0
```

### `modules.rental_damage_assessments` — NEW (added in v2.0)

Per `16_MODULE_RENTAL.md` §7 (Decision RNT-001).

```text
modules.rental_damage_assessments
  id, tenant_id, rental_order_id FK, rental_asset_id FK,
  damage_charge numeric(18,4), damage_description text,
  assessed_by, assessed_at, created_at
```

**Unique:** `UNIQUE(tenant_id, order_number)` on `rental_orders`, `UNIQUE(tenant_id, operation_id)`.

## 6.5 `modules.projects` / `modules.project_costs` / `modules.project_invoices` — AMENDED

Per `17_MODULE_PROJECT.md` §7 (Decision PRJ-001, already self-declared).

```text
modules.projects
  id, tenant_id, customer_id FK, quotation_id FK nullable,
  name, status (PLANNING/IN_PROGRESS/ON_HOLD/COMPLETED/CANCELLED),
  budget_amount, start_date, end_date,
  created_at, updated_at,
  -- NEW fields, per 17 §7:
  branch_id             uuid FK
  project_number          text
  cancelled_at               timestamptz nullable
  cancelled_reason             text nullable
  operation_id

modules.project_costs
  id, tenant_id, project_id FK,
  category (MATERIAL/LABOUR/RENTAL/TRANSPORT/SUBCONTRACT/OTHER),
  amount, description, incurred_at, created_at,
  -- NEW fields, per 17 §7:
  source_reference_type   text nullable  -- PURCHASE/RENTAL_ORDER/
                                             EXPENSE
  source_reference_id       uuid nullable
  operation_id

modules.project_invoices
  id, tenant_id, project_id FK, sale_id FK,
  milestone_label nullable, created_at
  -- no amendment; already minimal per design (17 §3.2)
```

**Unique:** `UNIQUE(tenant_id, project_number)`, `UNIQUE(tenant_id, operation_id)`.

## 6.6 `modules.warranties`

(Unchanged from v1.0 — no amendment declared by `15`, `20`, or any other document.)

---

# 7. Industry Extension Schema — AMENDED

## 7.1 Pharmacy — `industry.pharmacy_item_details` / `industry.pharmacy_batch_details`

(Unchanged from v1.0 — `19_INDUSTRY_PHARMACY.md` §8 explicitly confirms "no amendment needed" for these two.)

### `industry.prescriptions` — NEW (added in v2.0)

Per `19_INDUSTRY_PHARMACY.md` §8 (Decision PHM-001, already self-declared).

```text
industry.prescriptions
  id, tenant_id, customer_id FK nullable, sale_id FK nullable,
  prescribing_doctor text nullable, document_id FK nullable,
  notes text nullable, created_at, created_by
```

**Indexes:** `INDEX(tenant_id, sale_id)`, `INDEX(tenant_id, customer_id)`.

## 7.2 Electronics — `industry.electronics_item_details` / `industry.electronics_repairs`

(Unchanged from v1.0 — `20_INDUSTRY_ELECTRONICS.md` §7 explicitly confirms "no amendment needed" for either table; Decision ELC-001.)

## 7.3 Decorator/Event — `industry.decorator_events` / `industry.decorator_labour` — AMENDED

Per `21_INDUSTRY_DECORATOR.md` §6 (Decision DEC-001, already self-declared).

```text
industry.decorator_events
  id, tenant_id, project_id FK -> modules.projects.id UNIQUE,
  venue_name, venue_address, event_date, theme,
  guest_count_estimate,
  created_at
  -- no amendment; fields already complete per 21 §3

industry.decorator_labour
  id, tenant_id, project_id FK -> modules.projects.id,
  labour_name, role, hours, rate, amount,
  work_date, created_at,
  -- NEW field, per 21 §6:
  project_cost_id   uuid FK -> modules.project_costs.id nullable
```

**Indexes:** `INDEX(tenant_id, project_id)` on both tables.

---

# 8. Offline / Sync Support Tables — AMENDED

## 8.1 Client `pendingOperations`

(Unchanged from v1.0.)

## 8.2 Client `localCache`

(Unchanged from v1.0.)

## 8.3 Server-side counterpart: `core.sync_operations`

(Unchanged from v1.0.)

## 8.4 `core.change_log` — NEW (added in v2.0)

Per `10_OFFLINE_SYNC_SPECIFICATION.md` §12 (Decision SYNC-002, already self-declared).

```text
core.change_log
  id, tenant_id, entity_type, entity_id,
  change_type (UPSERT/DELETE), change_sequence bigserial per tenant,
  occurred_at
```

**Index:** `INDEX(tenant_id, change_sequence)`.

## 8.5 `control.devices` — NEW (added in v2.0)

Per `10_OFFLINE_SYNC_SPECIFICATION.md` §12 (Decision SYNC-003, already self-declared — control-plane, not tenant-scoped, since a device is user-bound not tenant-bound).

```text
control.devices
  id (=deviceId), user_id, first_seen_at, last_seen_at, user_agent
```

---

# 9. Automation Schema — NEW SECTION (added in v2.0)

Per `23_AUTOMATION_ARCHITECTURE.md` §13 (Decision AUT-002, already self-declared, including the schema-group-level amendment to §3 which this v2.0 draft honors).

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
```

**Unique:** `UNIQUE(tenant_id, name)` on `automation_rules`.
**Indexes:** `INDEX(tenant_id, trigger_event, is_active)` on `automation_rules`; `INDEX(tenant_id, status)` on `webhook_deliveries`.

---

# 10. Billing Schema — NEW SECTION (added in v2.0)

Per `26_SAAS_BILLING_SPECIFICATION.md` §8.1. **No prior amendment-declaration tag existed against this document for these tables (Phase 0.5 Finding, CONFIRMED gap) — retroactively declared here as Decision BIL-SCHEMA-002.**

```text
billing.invoices
  id, tenant_id, subscription_id FK, plan_id FK (snapshot at issue
    time, per 26 §8.3), amount numeric(18,4), currency,
  status (DRAFT/ISSUED/PAID/VOID/UNCOLLECTIBLE),
  period_start, period_end, issued_at, due_at,
  paid_at nullable, created_at

billing.payment_attempts
  id, tenant_id, invoice_id FK, gateway_charge_ref,
  status (SUCCEEDED/FAILED), failure_reason nullable,
  attempted_at, idempotency_key

billing.payment_methods
  -- referenced by control.subscriptions.payment_method_id (§4.5)
  -- and by billing.payment_attempts indirectly; exact field list
  -- NOT fully enumerated in 26 — 26 §7.1 describes the
  -- PaymentGatewayAdapter.createPaymentMethod() return shape
  -- (PaymentMethodRef) but does not give a table DDL.
  -- [UNSPECIFIED — carried from source; flagged in Amendment Ledger]
  id, tenant_id, gateway_token_ref, created_at   -- inferred minimum,
                                                    NOT an authoritative
                                                    field list
```

**Critical placement note (restated from §3.1):** this entire schema group is **Control-Plane-only** — `billing.*` NEVER writes to or reads from any `core.*` tenant-business-plane table (per `26` §7.4, §2's Billing Separation principle, restated as a non-negotiable in that document).

---

# 11. Migration Schema — NEW SECTION (added in v2.0)

Per `27_MIGRATION_SPECIFICATION.md` §2.3. **No prior amendment-declaration tag existed against this document for these tables — retroactively declared here as Decision MIG-SCHEMA-001.**

```text
migration.staging_items
migration.staging_customers
migration.staging_suppliers
migration.staging_sales
migration.staging_purchases
migration.staging_expenses
  -- one staging table per target Core entity, per 27 §2.3
  -- Exact column-level DDL is NOT specified in 27 — that document
  -- describes the STAGING PATTERN (mirror of target schema,
  -- pre-validation) but does not enumerate every staging table's
  -- columns individually.
  -- [UNSPECIFIED — carried from source; flagged in Amendment Ledger]
```

**Design note (restated from `27` §2.3):** these tables exist so `MigrationValidationService` (`27` §2.4) can validate a stable snapshot repeatedly without re-running the transform, and so `core.*` never receives a partial/unvalidated import.

---

# 12. Cross-Cutting Constraints Summary

(Unchanged from v1.0. All rules — tenant isolation, idempotency, debit=credit, stock non-negative, return≤sold, no destructive financial edit, tenant-local uniqueness — remain in force and are not altered by any amendment merged in this draft.)

---

# 13. Row Level Security — Reference Policy Shape

(Unchanged from v1.0. **Note:** Phase 0.5 Finding 10 flags an unresolved operational question — `SET LOCAL app.tenant_id` compatibility with transaction-pooling connection poolers (e.g. PgBouncer) — as requiring validation before Phase 1 exit. This is **not** a schema change and is **not** resolved by this v2.0 draft; it remains an open item, tracked in the Amendment Ledger §16 and in the Phase 0.5 report's own §4/§10.)

---

# 14. Indexing Strategy Summary

(Unchanged from v1.0, extended implicitly by the per-table indexes already listed alongside each new/amended table above in §5–§11.)

---

# 15. Required PostgreSQL Extensions — NEW SECTION (added in v2.0)

**This section did not exist in v1.0 or in `25_DEPLOYMENT_ARCHITECTURE.md`. It is added per Phase 0.5 Finding 6 (CONFIRMED BLOCKER).**

| Extension | Required By | Reason |
|---|---|---|
| `pgcrypto` (or native PG13+ `gen_random_uuid()`) | Every table using `id uuid PK, default gen_random_uuid()` (§2, platform-wide convention) | UUID primary key generation |
| `btree_gist` | `modules.bookings` (§6.2) | Required for the `EXCLUDE USING gist (... tsrange ...)` overlap-prevention constraint (per `18` §4.1) |

**Provisioning requirement (new, this document):** both extensions MUST be enabled during database provisioning — for Shared mode, once at cluster/database level; for Dedicated mode, as a mandatory step in `DedicatedTenantProvisioningJob` (`25` §6.2), inserted before schema migration (`25` §6.2 step 4). **This provisioning-pipeline change is a recommendation for a future revision of `25`, not itself made here** — this v2.0 draft only documents the requirement at the schema-specification level, which was the missing piece per Finding 6.

---

# 16. Amendment Ledger — NEW SECTION (added in v2.0, Option C policy)

Every schema change merged into this v2.0 draft, traced to its source document and section, in the order it was originally declared:

| # | Source Doc | Source §  | Change | Target Table(s) | Declared As |
|---|---|---|---|---|---|
| 1 | `08` | §9.4 | New table | `core.accounting_periods` | Decision ACC-004 |
| 2 | `09` | §6.2 | New column | `core.stock_balances.weighted_avg_cost` | Decision INV-004 |
| 3 | `09` | §9.1 | New tables | `core.stock_counts`, `core.stock_count_lines` | Decision INV-005 |
| 4 | `10` | §12 | New table | `core.change_log` | Decision SYNC-002 |
| 5 | `10` | §12 | New table | `control.devices` | Decision SYNC-003 |
| 6 | `14` | §6 | New columns | `modules.quotations` (+7 fields), `modules.quotation_items` (+3 fields) | Decision QTN-001 |
| 7 | `15` | §8 | New columns | `modules.service_orders` (+6 fields), `modules.service_order_items` (+2 fields) | Decision SRV-001 |
| 8 | `16` | §7 | New columns + table | `modules.rental_assets`, `modules.rental_orders` (+several fields), `modules.rental_damage_assessments` (new) | Decision RNT-001 |
| 9 | `17` | §7 | New columns | `modules.projects`, `modules.project_costs` (+several fields) | Decision PRJ-001 |
| 10 | `18` | §7 | New columns + DDL confirmation | `modules.bookings` (+4 fields), `EXCLUDE USING gist` confirmed canonical | Decision BKG-001 |
| 11 | `19` | §8 | New table | `industry.prescriptions` | Decision PHM-001 |
| 12 | `20` | §7 | None (confirmed no amendment) | — | Decision ELC-001 |
| 13 | `21` | §6 | New column | `industry.decorator_labour.project_cost_id` | Decision DEC-001 |
| 14 | `21` | §5.3 | New column | `modules.rental_orders.project_id` | Decision DEC-004 |
| 15 | `23` | §13/§14 | New schema group + 6 tables + 1 column + 1 table | `automation.*` (6 tables), `core.items.low_stock_threshold`, `core.notification_templates` | Decision AUT-002 |
| 16 | `26` | §3, §8 | New schema group + tables (**not self-declared — retroactive**) | `billing.invoices`, `billing.payment_methods` [partially unspecified], `billing.payment_attempts`; `control.plans`/`control.subscriptions` field finalization | Decision BIL-SCHEMA-001, BIL-SCHEMA-002 (new, assigned in this document) |
| 17 | `27` | §2.3 | New schema group + tables (**not self-declared — retroactive**) | `migration.staging_*` [column-level detail unspecified] | Decision MIG-SCHEMA-001 (new, assigned in this document) |
| 18 | `13` | §2.6 | New columns (**not self-declared — retroactive**) | `control.users.mfa_enabled`, `mfa_secret_ref` | Decision SEC-006-SCHEMA (new, assigned in this document) |

**Items requiring further human decision before final v2.0 sign-off (not resolved by this draft):**

- `billing.payment_methods` — full field list not specified anywhere in `26`; a minimum inferred shape is shown in §10 marked `[UNSPECIFIED]`.
- `migration.staging_*` — column-level DDL not specified anywhere in `27`; only the pattern (mirror target schema) is given.
- §3.1's control-plane-vs-tenant-database placement inference for `billing`/`migration`/`automation` — logically derived, not explicitly stated in source documents; requires confirmation.
- The retroactive Decision tags assigned in rows 16–18 above are **proposed** tags, not yet reflected back into `26`, `27`, or `13` themselves — those three documents still need a small addendum acknowledging them, per the Option C dual-declaration requirement.

---

# 17. Decisions Established by This Document (v2.0 additions only)

**v1.0's original Decisions DB-001 through DB-005 remain in force, unchanged, and are not restated here to avoid duplication — see v1.0 §13.**

### Decision DB-006 (NEW, v2.0)
Three additional schema groups — `automation`, `billing`, `migration` — are formally added to the canonical schema-group registry (§3), correcting the registry-drift gap identified in Phase 0.5.

### Decision DB-007 (NEW, v2.0)
`billing.*` and `migration.*` are Control-Plane-only schema groups, never present in a tenant's Shared or Dedicated business database; `automation.*` is tenant-scoped, colocated with `core`/`modules`/`industry` (§3.1).

### Decision DB-008 (NEW, v2.0)
Required PostgreSQL extensions (`pgcrypto`, `btree_gist`) are now formally documented (§15) as a prerequisite for both Shared-cluster provisioning and every Dedicated-tenant provisioning run — closing the gap identified in Phase 0.5 Finding 6. (Note: the corresponding change to `25_DEPLOYMENT_ARCHITECTURE.md`'s provisioning pipeline steps is a **separate, future action**, not performed by this document.)

### Decision DB-009 (NEW, v2.0)
An Amendment Ledger (§16) is now a mandatory, permanent section of this document — every future schema-affecting document MUST both (a) self-declare its amendment via a `Decision <PREFIX>-###` tag in its own text, per the existing pattern set by `08`–`23`, AND (b) have that amendment appended to §16 the next time this document is revised. This is the concrete, permanent implementation of the Phase 0.5 "Option C" policy.

---

# 18. Open Items Carried Forward (NOT resolved by this draft)

```text
1. billing.payment_methods full field schema — needs explicit
   definition (currently inferred minimum only, §10)
2. migration.staging_* column-level DDL per entity — needs explicit
   definition (currently pattern-only, §11)
3. Control-plane vs tenant-database placement of automation/billing/
   migration (§3.1) — logically inferred, needs explicit confirmation
4. RLS + connection-pooling (SET LOCAL vs transaction-pooling mode)
   compatibility — unresolved, flagged in §13, tracked separately in
   Phase 0.5 report
5. All v1.0 §12 "Open Schema Questions" remain open and are not
   addressed by this merge (ENUM vs text+CHECK, UUIDv4 vs UUIDv7,
   partial RLS coverage, materialized view strategy for
   stock_balances, multi-currency hooks, receivables/payables
   derived-vs-cached, exact CHECK constraint set, branch/warehouse
   scoping on memberships)
6. 26/27/13's retroactive Decision tags (§16) need to be written
   back into those source documents in a future, separate small
   revision pass
```

---

**End of v2.0 DRAFT. Pending human review and approval before this replaces `06_DATABASE_SPECIFICATION.md` v1.0 as the project's canonical baseline.**
