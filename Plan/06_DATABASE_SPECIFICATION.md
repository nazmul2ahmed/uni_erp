# 06_DATABASE_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Canonical Database Specification
**Version:** 2.0 — APPROVED (supersedes v1.0)
**Status:** ✅ Canonical baseline
**Reconciliation basis:** Phase 0.5 Documentation Baseline Audit + Second-Pass Verification Report + Second Reconciliation Pass (six ratified business/architecture decisions)
**Amendment declaration policy:** Option C — every amending document must self-declare its amendment (`Decision <PREFIX>-###` tag), AND this document maintains a central Amendment Ledger (§18) cross-referencing every merged change back to its source document/section.
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md`
- `04_PLATFORM_ARCHITECTURE.md`
- `05_MULTI_TENANT_ARCHITECTURE.md`

---

## Changelog (v1.0 → v2.0)

This is a genuine merge of the original v1.0 canonical schema (full DDL, every table's actual column list) with every schema amendment self-declared by documents `08` through `27`, plus the six business/architecture decisions ratified during Phase 0.5 Reconciliation (`Decision DOM-006`, `INV-007`, `BIL-007`, `TEN-001`, `TEN-002`, and the ADR/REQ-* process clarifications).

**Numbering rule (critical, deliberate deviation from an earlier draft of this merge):** §1–§13 below preserve their **exact original v1.0 section numbers**. This is required because `07_CORE_DOMAIN_SPECIFICATION.md` §17 and `13_SECURITY_SPECIFICATION.md` §4.2/§9.1 both cite `06 §9` directly (referring to the Cross-Cutting Constraints Summary / idempotency rule). An earlier merge draft renumbered §9–§14 to make room for new top-level sections — that would have silently broken those two citations. Instead, all genuinely new top-level content (Automation Schema, Billing Schema, Migration Schema, Required Extensions, Amendment Ledger) is appended as **new** §14–§18, after the original §13 (Decisions), with §14 (Next Document) renumbered to §19. No existing subsection number (`§4.x`, `§5.x`, `§6.x`, `§7.x`, `§8.x`) changes.

Where a table/field is unchanged from v1.0, it is presented with its full original content (not a stub) — this document is now a complete, standalone canonical reference; no other file needs to be consulted for base DDL.

---

# 1. Purpose

এই document platform-এর **canonical database schema** নির্ধারণ করে — PostgreSQL-এর ওপর ভিত্তি করে, Drizzle ORM দিয়ে বাস্তবায়িত হবে।

এই document আগের architectural decisions বাস্তব table structure-এ রূপান্তর করে:

```text
Control Plane Schema
      ↓
Core Business Schema
      ↓
Module Schema
      ↓
Industry Extension Schema
      ↓
Automation Schema        [NEW, §14]
      ↓
Billing Schema           [NEW, §15]
      ↓
Migration Schema         [NEW, §16]
```

প্রতিটি entity-এর জন্য নিম্নলিখিত metadata বাধ্যতামূলকভাবে নির্ধারণ করা হয়েছে (per Section 125, `05_MULTI_TENANT_ARCHITECTURE.md`):

```text
Purpose
Scope (Tenant / Branch / Warehouse / Global)
Fields & Types
Primary Key
Foreign Keys
Indexes
Unique Constraints
Lifecycle / Status
Audit
Soft Delete
```

---

# 2. Naming & Type Conventions

```text
Tables:        snake_case, plural       (e.g. sale_items)
Columns:       snake_case                (e.g. tenant_id)
TS mapping:    camelCase (ORM-handled)   (e.g. tenantId)
Primary Keys:  id (UUID)
Foreign Keys:  <entity>_id
Booleans:      is_/has_ prefix           (e.g. is_active)
Enums:         UPPER_SNAKE string values, stored as text + CHECK
              or native pg enum where stable
Money:         numeric(18,4) minor-unit safe, never float
Quantity:      numeric(18,4)
Timestamps:    timestamptz, stored UTC
```

Standard tenant-scoped base columns (Section 140, `05`):

```text
id            uuid PK, default gen_random_uuid() / uuidv7
tenant_id     uuid NOT NULL  (omitted only for global tables)
created_at    timestamptz NOT NULL default now()
updated_at    timestamptz NOT NULL default now()
created_by    uuid NULL  (references users.id)
updated_by    uuid NULL
deleted_at    timestamptz NULL (only where soft delete applies)
```

Not every table gets every field blindly — presence is decided per entity below.

---

# 3. Schema Grouping — AMENDED

**v1.0 declared four groups. v2.0 adds three (`automation`, `billing`, `migration`), per Phase 0.5 Finding 2.**

```text
schema: control     (Control Plane — platform-owned)
schema: core        (Tenant business core)
schema: modules     (Quotation, Booking, Service, Rental, Project)
schema: industry    (Pharmacy, Electronics, Decorator)
schema: automation  (Rules, executions, webhooks, tasks — per 23 §13, Decision AUT-002)
schema: billing     (Platform subscription invoices/payments — per 26 §3/§8, Decision BIL-SCHEMA-001/002)
schema: migration   (Staging tables for data migration — per 27 §2.3, Decision MIG-SCHEMA-001)
```

Shared-tenant mode: সব schema একই PostgreSQL database-এ থাকবে, `tenant_id` দিয়ে row isolated।
Dedicated-tenant mode: `core`, `modules`, `industry`, `automation` schema tenant-এর নিজস্ব database-এ থাকবে; `control`, `billing`, `migration` schema শুধু central control-plane database-এ থাকবে।

## 3.1 Control-Plane vs Tenant-Database Placement (clarification)

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

---

# 4. Control Plane Schema

## 4.1 `control.users` — AMENDED

**Purpose:** Platform-wide identity. একজন human একবারই এখানে থাকবে, একাধিক tenant-এ membership থাকতে পারে।
**Scope:** Global (not tenant-scoped)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text | UNIQUE, citext preferred |
| phone | text | UNIQUE NULLABLE |
| password_hash | text | nullable if SSO-only |
| full_name | text | |
| status | text | ACTIVE / SUSPENDED / DELETED |
| last_login_at | timestamptz | |
| `mfa_enabled` | boolean | NOT NULL DEFAULT false — per `13` §2.6 |
| `mfa_secret_ref` | text | nullable — pointer into secret manager, never a raw TOTP secret in plaintext — per `13` §2.6 |
| created_at / updated_at | timestamptz | |

**Indexes:** `UNIQUE(email)`, `UNIQUE(phone)` where not null
**Audit:** platform audit
**Soft delete:** status-based, not `deleted_at`
**Amendment:** `mfa_enabled`/`mfa_secret_ref` per Decision SEC-006-SCHEMA (Phase 0.5).

---

## 4.2 `control.tenants` — AMENDED

**Purpose:** একটি independent business workspace।
**Scope:** Global

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | business display name |
| slug | text | UNIQUE, used for subdomain/routing |
| status | text | PENDING / PROVISIONING / ACTIVE / SUSPENDED / GRACE / ARCHIVED |
| storage_mode | text | SHARED / DEDICATED |
| plan_id | uuid FK → control.plans.id | |
| base_currency | text | ISO 4217, default BDT |
| timezone | text | default Asia/Dhaka |
| template_key | text | e.g. PHARMACY, ELECTRONICS, DECORATOR, GENERIC_RETAIL |
| owner_membership_id | uuid | nullable until first owner assigned |
| created_at / updated_at | timestamptz | |

**Indexes:** `UNIQUE(slug)`, `INDEX(status)`, `INDEX(storage_mode)`
**FK safety:** `owner_membership_id` resolved after membership creation (nullable, deferred)
**Audit:** platform audit
**Lifecycle:** see `05_MULTI_TENANT_ARCHITECTURE.md` §6

**Amendment — `CONSTRAINT owner_required_when_active` (NEW, Phase 0.5 Reconciliation):**

Per `05` §75a (Decision TEN-001, INV-OWN-001):

```sql
ALTER TABLE control.tenants
  ADD CONSTRAINT owner_required_when_active
  CHECK (status != 'ACTIVE' OR owner_membership_id IS NOT NULL);
```

This is a null-safety guarantee only — it does not itself validate who a
legitimate owner is; that is enforced at the application layer
(`INV-OWN-002`/`INV-OWN-003`, per `05` §75a). It permits `NULL` during
the `PROVISIONING` window before the first membership is created,
consistent with the "FK safety" note above.

---

## 4.3 `control.memberships`

**Purpose:** User ↔ Tenant relationship, role attached.
**Scope:** Global (references two tenants' worth of identity, but row itself is control-plane)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → control.users.id | |
| tenant_id | uuid FK → control.tenants.id | |
| role_id | uuid FK → control.roles.id | |
| status | text | INVITED / ACTIVE / SUSPENDED / REMOVED |
| branch_scope | uuid[] | nullable = tenant-wide |
| joined_at | timestamptz | |
| created_at / updated_at | timestamptz | |

**Indexes:** `UNIQUE(user_id, tenant_id)`, `INDEX(tenant_id, status)`
**Audit:** platform + tenant audit (membership change is sensitive both ways)

(Unchanged from v1.0.)

---

## 4.4 `control.roles` / `control.permissions` / `control.role_permissions`

**Purpose:** Permission-based RBAC (per Decision 007, `01`).
**Scope:** `permissions` = Global (system-defined); `roles` = Tenant-scoped (preset + custom)

```text
control.permissions
  id, key (e.g. "sales.create"), description        -- GLOBAL, seeded

control.roles
  id, tenant_id (NULL for system preset roles), name,
  is_system_role, created_at, updated_at

control.role_permissions
  role_id, permission_id                              -- composite PK
```

**Unique:** `UNIQUE(tenant_id, name)` on roles; `UNIQUE(key)` on permissions
**Note:** System preset roles have `tenant_id = NULL` and are cloned/referenced at tenant onboarding, not mutated.

(Unchanged from v1.0.)

---

## 4.5 `control.plans` / `control.subscriptions` — AMENDED

**Purpose:** Commercial tiering & billing metadata (never mixed with tenant accounting — see `04` §160, `05` §74).

**Finalized per `26_SAAS_BILLING_SPECIFICATION.md` §3.1–§4.1** (consolidated as Decision BIL-SCHEMA-001):

```text
control.plans
  id, key (STARTER/PROFESSIONAL/BUSINESS/ENTERPRISE), name,
  price numeric(18,4), currency, billing_interval (MONTHLY/YEARLY),
  limits jsonb,                 -- shape per 26 §3.2, extensible
                                    (e.g. {"users": 5, "branches": 1,
                                    "monthlyInvoices": 500, ...} —
                                    absent key = unlimited)
  module_entitlements jsonb,    -- shape per 26 §3.3, a CEILING not
                                    the actual runtime toggle (that
                                    remains control.tenant_features, §4.7)
  is_active, is_publicly_visible boolean,
  created_at, updated_at

control.subscriptions
  id, tenant_id, plan_id FK,
  status (TRIAL/ACTIVE/PAST_DUE/CANCELLED/EXPIRED),   -- amended: v1.0
                                    listed only TRIAL/ACTIVE/PAST_DUE/
                                    CANCELLED; 26 §4.1 adds EXPIRED
                                    (trial that never converted)
  current_period_start, current_period_end,
  trial_ends_at timestamptz nullable,
  cancelled_at timestamptz nullable,
  cancel_at_period_end boolean default false,
  payment_method_id FK -> billing.payment_methods.id nullable,
  created_at, updated_at
```

**Indexes:** `INDEX(tenant_id, status)`

---

## 4.6 `control.tenant_databases`

**Purpose:** Dedicated-tenant database registry (per `05` §16).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid FK, UNIQUE | one row per dedicated tenant |
| cluster_ref | text | infra identifier, not raw host |
| database_ref | text | logical name/reference |
| credential_ref | text | pointer into secret manager, never raw creds |
| schema_version | text | |
| status | text | PENDING/PROVISIONING/ACTIVE/FAILED/DECOMMISSIONED |
| provisioned_at | timestamptz | |
| last_health_check_at | timestamptz | |

**Critical rule:** No plaintext credentials in this table (Section 16, 31 of `05`).

(Unchanged from v1.0.)

---

## 4.7 `control.tenant_features`

**Purpose:** Module/feature flag resolution (per `05` §68–71, `26` §6's finalized 4-step Feature Resolution algorithm — Decision BIL-007).

```text
tenant_id, feature_key, enabled (bool), source (PLAN/OVERRIDE/MODULE),
updated_at, updated_by
```

**Unique:** `UNIQUE(tenant_id, feature_key)`

**Note (Phase 0.5 clarification):** this table is the **sole** runtime enablement source for Optional Modules (`14`–`18`) — no separate `moduleState` layer exists (Decision BIL-007, `26` §6, resolves `26` §14 Q2).

---

## 4.8 `control.usage_events`

**Purpose:** Metering (per `05` §73, `22` §8.2, `26` §5.1 — this table serves ALL metered metrics platform-wide, AI usage being one instance of a general mechanism).

```text
id, tenant_id, metric_key, quantity, period_start, period_end, recorded_at
```

**Indexes:** `INDEX(tenant_id, metric_key, period_start)`

(Unchanged from v1.0 structurally. `22` §8.2 and `26` §5.1 both consume this table without schema modification.)

---

## 4.9 `control.audit_events_platform`

**Purpose:** Platform-level audit (tenant created, plan changed, support access — per `05` §122).

```text
id, actor_user_id, action, target_type, target_id,
before jsonb, after jsonb, reason text,
ip_address, occurred_at
```

**Retention:** long retention, append-only, no update/delete from application layer.

(Unchanged from v1.0.)

---

# 5. Core Business Schema

All tables below are **tenant-scoped** unless explicitly marked otherwise. In shared mode, `tenant_id` + RLS policy `tenant_id = current_setting('app.tenant_id')::uuid`.

## 5.1 `core.business_profiles`

**Purpose:** Tenant's operational business identity (distinct from `control.tenants`, which is platform metadata).

```text
id, tenant_id UNIQUE, legal_name, display_name, phone, email, address,
logo_object_key, invoice_prefix, tax_registration_no,
created_at, updated_at
```

## 5.2 `core.branches`

```text
id, tenant_id, name, code, address, phone, is_active,
created_at, updated_at
```

**Unique:** `UNIQUE(tenant_id, code)`

## 5.3 `core.warehouses`

```text
id, tenant_id, branch_id FK, name, code, is_active,
created_at, updated_at
```

**Unique:** `UNIQUE(tenant_id, code)`
**Scope:** Tenant + Branch scoped

---

## 5.4 `core.customers`

**Purpose:** Central customer entity (per `02` §7).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid | |
| type | text | INDIVIDUAL / ORGANIZATION |
| name | text | |
| phone | text | |
| email | text | nullable |
| address | text | nullable |
| opening_receivable | numeric(18,4) | onboarding only |
| is_walk_in | boolean | default false |
| is_active | boolean | default true |
| deleted_at | timestamptz | soft delete (reference-sensitive, §97 of `04`) |
| created_at / updated_at / created_by / updated_by | | |

**Indexes:** `INDEX(tenant_id, phone)`, `INDEX(tenant_id, name)` (trigram/full-text candidate)
**Unique:** `UNIQUE(tenant_id, phone)` where `phone IS NOT NULL AND is_walk_in = false`

## 5.5 `core.suppliers`

Mirrors `customers` structurally:

```text
id, tenant_id, name, phone, email, address, contact_person,
opening_payable, is_active, deleted_at,
created_at, updated_at, created_by, updated_by
```

**Unique:** `UNIQUE(tenant_id, phone)` where applicable

---

## 5.6 `core.items` — AMENDED

**Purpose:** Generic Core product/service entity (per Decision 002, `01`; BD-003, `02`).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid | |
| sku | text | tenant-local |
| name | text | |
| type | text | PRODUCT / SERVICE / RAW_MATERIAL / CONSUMABLE / RENTAL_ASSET / NON_STOCK |
| category_id | uuid FK → core.item_categories.id | nullable |
| brand_id | uuid FK → core.brands.id | nullable |
| unit_id | uuid FK → core.units.id | |
| purchase_price | numeric(18,4) | last/default cost |
| selling_price | numeric(18,4) | default price |
| tax_profile_id | uuid FK | nullable |
| stock_tracked | boolean | |
| batch_tracked | boolean | |
| expiry_tracked | boolean | |
| serial_tracked | boolean | |
| rental_tracked | boolean | |
| warranty_tracked | boolean | |
| `low_stock_threshold` | numeric(18,4) | nullable — per `23` §14.1, Decision AUT-002; null = item never fires `StockLow` event; opt-in per item |
| `allow_negative_stock` | boolean | NOT NULL DEFAULT false — per `09` §4.7, Decision INV-007 (Phase 0.5 Reconciliation). No practical effect on serial/batch-tracked items (allocation strategy inherently blocks it — see `09` §4.7 for the full interaction rule). Toggling requires the `inventory.allow_negative_stock` permission. |
| is_active | boolean | |
| deleted_at | timestamptz | |
| created_at / updated_at / created_by / updated_by | | |

**Unique:** `UNIQUE(tenant_id, sku)` where `sku IS NOT NULL`
**Indexes:** `INDEX(tenant_id, name)`, `INDEX(tenant_id, category_id)`, `INDEX(tenant_id, type)`

**Design note (per `02` §12):** tracking flags are independent of `type` — e.g. a `PRODUCT` in Pharmacy has `batch_tracked = true, expiry_tracked = true`; a `RENTAL_ASSET` has `rental_tracked = true`.

## 5.7 `core.item_categories` / `core.brands` / `core.units`

```text
core.item_categories: id, tenant_id, name, parent_id (self-FK, nullable)
core.brands:          id, tenant_id, name
core.units:           id, tenant_id, name, symbol, is_decimal
```

**Unique:** `UNIQUE(tenant_id, name)` each

---

## 5.8 Sales Domain

### `core.sales`

**Purpose:** Sale header (per §17, `03`).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid | |
| branch_id | uuid FK | |
| invoice_number | text | canonical, server-generated |
| local_number | text | nullable, offline-generated `LOCAL-...` prior to sync |
| customer_id | uuid FK → core.customers.id | nullable (walk-in) |
| status | text | DRAFT / CONFIRMED / PARTIALLY_PAID / PAID / DUE / COMPLETED / CANCELLED |
| subtotal | numeric(18,4) | |
| discount_total | numeric(18,4) | |
| tax_total | numeric(18,4) | |
| grand_total | numeric(18,4) | |
| paid_total | numeric(18,4) | |
| due_total | numeric(18,4) | derived, may be cached |
| sale_date | timestamptz | business date |
| operation_id | uuid | idempotency key from client |
| device_id | uuid | nullable, offline origin |
| created_at / updated_at / created_by / updated_by | | |
| cancelled_at | timestamptz | nullable |
| cancelled_reason | text | nullable |

**Unique:** `UNIQUE(tenant_id, invoice_number)`, `UNIQUE(tenant_id, operation_id)`
**Indexes:** `INDEX(tenant_id, customer_id)`, `INDEX(tenant_id, sale_date)`, `INDEX(tenant_id, status)`
**Lifecycle:** no destructive edit after `COMPLETED`; corrections via `CANCELLED` + new sale or reversal (per §25, `03`)

**Note (per `07` §7.5a, Decision DOM-006):** discount ceiling/override enforcement (`sales.maxDiscountPercent`, `sales.discount.override` permission) lives in `core.business_profiles`' settings blob (§5.1), not on this table — no schema change required here for DOM-006.

### `core.sale_items`

```text
id, tenant_id, sale_id FK, item_id FK, description,
quantity, unit_price, line_discount, tax_amount, line_total,
batch_id FK nullable, serial_id FK nullable, warehouse_id FK,
created_at
```

**Indexes:** `INDEX(tenant_id, sale_id)`, `INDEX(tenant_id, item_id)`

---

## 5.9 Purchase Domain

### `core.purchases`

Mirrors `sales` structurally, supplier-facing:

```text
id, tenant_id, branch_id, purchase_number, local_number,
supplier_id FK, status (DRAFT/CONFIRMED/RECEIVED/PAID/PARTIALLY_PAID/CANCELLED),
subtotal, discount_total, tax_total, grand_total, paid_total, due_total,
purchase_date, operation_id, device_id,
created_at, updated_at, created_by, updated_by
```

**Unique:** `UNIQUE(tenant_id, purchase_number)`, `UNIQUE(tenant_id, operation_id)`

### `core.purchase_items`

```text
id, tenant_id, purchase_id FK, item_id FK, description,
quantity, cost_price, selling_price, line_discount, tax_amount, line_total,
batch_number, expiry_date, warehouse_id FK,
created_at
```

**Note:** `batch_number`/`expiry_date` here are input at purchase time; canonical batch record created via Inventory domain (§5.10) — avoids duplicating pharmacy vocabulary in Core (per §55, `01`) while still allowing generic batch capture.

### `core.purchase_documents`

**Purpose:** AI invoice OCR attachments (per §7, `01`; §46, `04`).

```text
id, tenant_id, purchase_id FK nullable (nullable pre-confirmation),
object_key, extracted_data jsonb, verified_by, verified_at,
created_at
```

---

## 5.10 Inventory Domain — AMENDED

### `core.stock_movements`

**Purpose:** Authoritative ledger (per §19, `03`; Decision 004, `01`). This is the single source of truth for stock — never `core.items.quantity`.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid | |
| item_id | uuid FK | |
| warehouse_id | uuid FK | |
| batch_id | uuid FK → core.stock_batches.id | nullable |
| serial_id | uuid FK → core.stock_serials.id | nullable |
| movement_type | text | OPENING/PURCHASE/SALE/CUSTOMER_RETURN/SUPPLIER_RETURN/ADJUSTMENT_IN/ADJUSTMENT_OUT/TRANSFER_IN/TRANSFER_OUT/RESERVATION/RELEASE/CONSUMPTION/DAMAGE/LOSS |
| quantity | numeric(18,4) | signed: positive = in, negative = out |
| reference_type | text | SALE/PURCHASE/RETURN/ADJUSTMENT/TRANSFER/... |
| reference_id | uuid | polymorphic pointer, no hard FK (cross-domain) |
| occurred_at | timestamptz | |
| operation_id | uuid | idempotency |
| created_at / created_by | | |

**Unique:** `UNIQUE(tenant_id, operation_id)`
**Indexes:** `INDEX(tenant_id, item_id, warehouse_id, occurred_at)`, `INDEX(tenant_id, reference_type, reference_id)`
**Immutability:** append-only; corrections via compensating movement, never UPDATE/DELETE on posted rows.

### `core.stock_balances` — AMENDED

**Purpose:** Derived/cached current balance (per §49, `02` — "One Source of Truth").

```text
core.stock_balances
  tenant_id, item_id, warehouse_id, batch_id (nullable),
  quantity_on_hand, quantity_reserved, updated_at,
  weighted_avg_cost   numeric(18,4)   -- NEW, per `09` §6.2, Decision
                                          INV-004 — null for batch/
                                          serial-valued items
                                          (specific-identification
                                          costing used instead, per
                                          09 §6.1)
```

**Primary key:** `(tenant_id, item_id, warehouse_id, batch_id)` — composite, treated as materialized cache recomputable from `stock_movements`.

**Uniqueness enforcement — AMENDED (Decision INV-008, Phase 0.5 Reconciliation, second reconciliation pass):**

The composite key above cannot be a literal PostgreSQL `PRIMARY KEY`, because `batch_id` is semantically nullable (non-batch-tracked items — most Electronics/general-retail stock — have no batch) and PostgreSQL forces every `PRIMARY KEY` column `NOT NULL`. A single `UNIQUE INDEX` spanning all four columns does **not** close this gap either: PostgreSQL treats `NULL <> NULL` in unique indexes, so multiple rows sharing the same `(tenant_id, item_id, warehouse_id)` with `batch_id = NULL` would silently pass such an index, breaking the "one balance row per item/warehouse" invariant this table exists to guarantee.

**Corrected implementation:** two partial unique indexes, applied via migration (not expressible cleanly through the ORM's standard index builder, same reasoning already established for `journal_entries`' debit/credit `CHECK` constraint, §5.14):

```sql
CREATE UNIQUE INDEX stock_balances_pk_batched
  ON core.stock_balances (tenant_id, item_id, warehouse_id, batch_id)
  WHERE batch_id IS NOT NULL;

CREATE UNIQUE INDEX stock_balances_pk_unbatched
  ON core.stock_balances (tenant_id, item_id, warehouse_id)
  WHERE batch_id IS NULL;
```

The application schema's own index on this table (if present) is a plain, non-unique lookup index only — it exists for query performance, not constraint enforcement.

### `core.stock_batches`

**Purpose:** Generic batch concept (Core, not pharmacy-specific — extended by `industry.pharmacy_batch_details`, §7.1).

```text
id, tenant_id, item_id FK, batch_number, expiry_date (nullable),
received_at, supplier_id FK nullable, cost_price,
created_at
```

**Unique:** `UNIQUE(tenant_id, item_id, batch_number)`
**Index:** `INDEX(tenant_id, item_id, expiry_date)` — used by FEFO allocation & expiry alerts

### `core.stock_serials`

```text
id, tenant_id, item_id FK, serial_number, status (IN_STOCK/SOLD/RETURNED/DAMAGED),
purchase_item_id FK nullable, sale_item_id FK nullable,
created_at, updated_at
```

**Unique:** `UNIQUE(tenant_id, item_id, serial_number)`

### `core.stock_counts` / `core.stock_count_lines` — NEW

Per `09_INVENTORY_ENGINE_SPECIFICATION.md` §9.1, Decision INV-005.

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

---

## 5.11 Payment / Receivable / Payable Domain

### `core.payments`

**Purpose:** Universal payment entity (per §20, `03`).

```text
id, tenant_id, party_type (CUSTOMER/SUPPLIER),
party_id, direction (IN/OUT), amount, method
  (CASH/BANK/MFS/CARD/CHEQUE/ONLINE/OTHER),
reference_no, paid_at, operation_id,
created_at, created_by
```

**Unique:** `UNIQUE(tenant_id, operation_id)`
**Indexes:** `INDEX(tenant_id, party_type, party_id)`, `INDEX(tenant_id, paid_at)`

### `core.payment_allocations`

**Purpose:** Payment → Invoice mapping (future multi-invoice allocation per §23, `03`).

```text
id, tenant_id, payment_id FK, allocated_to_type (SALE/PURCHASE/EXPENSE/ADVANCE),
allocated_to_id, amount, created_at
```

**Rule:** `SUM(payment_allocations.amount) <= payments.amount` — enforced at domain layer, CHECK where feasible.

### `core.receivables` / `core.payables`

```text
core.receivables:
  id, tenant_id, customer_id FK, sale_id FK,
  amount, paid_amount, balance, status (OPEN/PARTIAL/SETTLED),
  due_date nullable, created_at, updated_at

core.payables:
  id, tenant_id, supplier_id FK, purchase_id FK,
  amount, paid_amount, balance, status (OPEN/PARTIAL/SETTLED),
  due_date nullable, created_at, updated_at
```

**Rule:** `balance` derived, not independently editable — recomputed from linked payment_allocations (per §21–22, `03`, and §49 of `02`, "One Source of Truth").

---

## 5.12 Returns Domain

### `core.returns`

```text
id, tenant_id, type (CUSTOMER_RETURN/SUPPLIER_RETURN),
reference_sale_id FK nullable, reference_purchase_id FK nullable,
party_id, status (DRAFT/COMPLETED/CANCELLED),
subtotal, tax_total, grand_total,
return_date, operation_id,
created_at, created_by
```

**Unique:** `UNIQUE(tenant_id, operation_id)`

### `core.return_items`

```text
id, tenant_id, return_id FK, item_id FK,
sale_item_id FK nullable, purchase_item_id FK nullable,
quantity, unit_price, line_total,
created_at
```

**Business rule (enforced in domain layer, DB CHECK where practical):**
`return_items.quantity` cumulative ≤ originating `sale_items.quantity` / `purchase_items.quantity` (per §22, `02`; §61, `03`).

---

## 5.13 Expense Domain

### `core.expenses`

```text
id, tenant_id, branch_id, category_id FK → core.expense_categories.id,
amount, description, paid_via (CASH/BANK/...), expense_date,
operation_id, created_at, created_by
```

### `core.expense_categories`

```text
id, tenant_id, name, is_active
```

---

## 5.14 Accounting Domain — AMENDED

### `core.accounts` (Chart of Accounts)

```text
id, tenant_id, code, name,
type (ASSET/LIABILITY/EQUITY/INCOME/EXPENSE),
parent_id (self-FK, nullable), is_system_account, is_active,
created_at
```

**Unique:** `UNIQUE(tenant_id, code)`

### `core.journals` / `core.journal_entries` / `core.ledger_entries`

```text
core.journals
  id, tenant_id, reference_type, reference_id,
  description, posted_at, operation_id, created_by

core.journal_entries
  id, tenant_id, journal_id FK, account_id FK,
  debit numeric(18,4), credit numeric(18,4),
  created_at
```

**Invariant (per §26, `03`; Architectural Non-Negotiable #4, `03` §90):**
For a given `journal_id`: `SUM(debit) = SUM(credit)`. Enforced at application-transaction commit; recommended DB-level trigger as defense-in-depth.

**Reversal pattern (§25, `03`):** corrections create a new `journals` row of `reference_type = REVERSAL` pointing back to the original; original rows are never updated/deleted.

### `core.opening_entries`

```text
id, tenant_id, type
  (CASH/BANK/STOCK/CUSTOMER_RECEIVABLE/SUPPLIER_PAYABLE/CAPITAL),
reference_id nullable (e.g. customer_id/item_id when applicable),
amount, entry_date, created_at, created_by
```

### `core.accounting_periods` — NEW

Per `08_ACCOUNTING_ENGINE_SPECIFICATION.md` §9.4, Decision ACC-004.

```text
core.accounting_periods
  id, tenant_id, period_start, period_end,
  status (OPEN/CLOSED), closed_at, closed_by,
  created_at
```

**Unique:** `UNIQUE(tenant_id, period_start, period_end)`, non-overlapping ranges enforced at application layer (per `08` §9.4).

---

## 5.15 Documents / Audit / Notifications — AMENDED

### `core.documents`

```text
id, tenant_id, entity_type, entity_id,
object_key, filename, mime_type, size_bytes,
uploaded_by, created_at
```

**Object key convention:** `tenant/{tenant_id}/{entity_type}/{entity_id}/{filename}` (per §57, `04`).

### `core.audit_logs`

```text
id, tenant_id, user_id, action, entity_type, entity_id,
before jsonb, after jsonb, reason text,
request_id, ip_address, occurred_at
```

**Indexes:** `INDEX(tenant_id, entity_type, entity_id)`, `INDEX(tenant_id, occurred_at)`
**Retention:** append-only; retention period is an open product decision (§34 Q15, `01`).

### `core.notifications`

```text
id, tenant_id, recipient_user_id, channel (IN_APP/EMAIL/TELEGRAM/SMS/WHATSAPP),
event_type, payload jsonb, status (PENDING/SENT/FAILED),
created_at, sent_at
```

### `core.notification_templates` — NEW

Per `23_AUTOMATION_ARCHITECTURE.md` §13, Decision AUT-002.

```text
core.notification_templates
  id, tenant_id nullable (null = platform default), template_key,
  channel, subject_template, body_template, updated_at
```

**Unique:** `UNIQUE(tenant_id, template_key, channel)` where `tenant_id IS NOT NULL`.

---

## 5.16 Drafts

### `core.drafts`

**Purpose:** Generic draft container (per §20, `01`).

```text
id, tenant_id, user_id, type (SALE/PURCHASE/QUOTATION/BOOKING/SERVICE_ORDER/PROJECT),
title, payload jsonb, created_at, updated_at
```

**Indexes:** `INDEX(tenant_id, user_id, type)`

---

## 5.17 Staff / RBAC (tenant-facing view)

Tenant-facing role/permission views reuse `control.roles`/`control.permissions`/`control.role_permissions` (Section 4.4). No separate tenant-schema duplication — Core references Control Plane by `tenant_id`-scoped rows, keeping RBAC a single source of truth across shared/dedicated modes.

---

# 6. Module Schema (Optional Modules) — AMENDED

## 6.1 `modules.quotations` / `modules.quotation_items` — AMENDED

Per `14_MODULE_QUOTATION.md` §6, Decision QTN-001.

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

Per `18_MODULE_BOOKING.md` §7, Decision BKG-001.

```text
id, tenant_id, customer_id FK, resource_type, resource_id,
starts_at, ends_at, status (DRAFT/HOLD/CONFIRMED/IN_PROGRESS/COMPLETED/CANCELLED),
advance_amount, notes,
created_at, updated_at,
-- NEW fields, per 18 §7:
branch_id                  uuid FK
operation_id
cancelled_at                 timestamptz nullable
cancelled_reason               text nullable
```

**Concurrency (per §93, `04`) — confirmed canonical DDL:**

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

**Requires the `btree_gist` PostgreSQL extension — see §17.**

**Unique:** `UNIQUE(tenant_id, operation_id)`. No `UNIQUE` on resource+window (the exclusion constraint enforces non-overlap, not a UNIQUE constraint).

## 6.3 `modules.service_orders` — AMENDED

Per `15_MODULE_SERVICE.md` §8, Decision SRV-001.

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

## 6.4 `modules.rental_assets` / `modules.rental_orders` — AMENDED

Per `16_MODULE_RENTAL.md` §7, Decision RNT-001. New table added.

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

### `modules.rental_damage_assessments` — NEW

Per `16_MODULE_RENTAL.md` §7, Decision RNT-001.

```text
modules.rental_damage_assessments
  id, tenant_id, rental_order_id FK, rental_asset_id FK,
  damage_charge numeric(18,4), damage_description text,
  assessed_by, assessed_at, created_at
```

**Unique:** `UNIQUE(tenant_id, order_number)` on `rental_orders`, `UNIQUE(tenant_id, operation_id)`.

## 6.5 `modules.projects` — AMENDED

Per `17_MODULE_PROJECT.md` §7, Decision PRJ-001.

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

```text
id, tenant_id, item_id FK nullable, sale_item_id FK nullable,
serial_id FK nullable, starts_at, ends_at,
terms, status (ACTIVE/EXPIRED/CLAIMED/VOID),
created_at
```

(Unchanged from v1.0 — no amendment declared by `15`, `20`, or any other document.)

---

# 7. Industry Extension Schema — AMENDED

Industry schemas **extend** Core entities by reference (foreign key to `core.items`, `core.sales`, etc.) — they never duplicate or fork Core tables (per §55, `01`; §133, `04`).

## 7.1 Pharmacy — `industry.pharmacy_item_details` / `industry.pharmacy_batch_details` — AMENDED

```text
id, tenant_id, item_id FK → core.items.id UNIQUE,
generic_name, strength, dosage_form, manufacturer,
requires_prescription boolean,
created_at
```

### `industry.pharmacy_batch_details`

```text
id, tenant_id, stock_batch_id FK → core.stock_batches.id UNIQUE,
generic_name_snapshot, strength_snapshot,
created_at
```

**Note:** `expiry_date` and `batch_number` already live on `core.stock_batches` (Core, generic) — Pharmacy only attaches domain-specific descriptive fields, per Decision 002.

### `industry.prescriptions` — NEW

Per `19_INDUSTRY_PHARMACY.md` §8, Decision PHM-001.

```text
industry.prescriptions
  id, tenant_id, customer_id FK nullable, sale_id FK nullable,
  prescribing_doctor text nullable, document_id FK nullable,
  notes text nullable, created_at, created_by
```

**Indexes:** `INDEX(tenant_id, sale_id)`, `INDEX(tenant_id, customer_id)`.

## 7.2 Electronics — `industry.electronics_item_details` / `industry.electronics_repairs`

```text
id, tenant_id, item_id FK UNIQUE,
model, specification jsonb, default_warranty_months,
created_at
```

### `industry.electronics_repairs`

```text
id, tenant_id, service_order_id FK → modules.service_orders.id UNIQUE,
imei_or_serial, fault_category, repair_notes,
created_at
```

(Unchanged from v1.0 — `20_INDUSTRY_ELECTRONICS.md` §7 explicitly confirms "no amendment needed" for either table; Decision ELC-001.)

## 7.3 Decorator/Event — `industry.decorator_events` / `industry.decorator_labour` — AMENDED

```text
id, tenant_id, project_id FK → modules.projects.id UNIQUE,
venue_name, venue_address, event_date, theme,
guest_count_estimate,
created_at
```

### `industry.decorator_labour`

Per `21_INDUSTRY_DECORATOR.md` §6, Decision DEC-001.

```text
id, tenant_id, project_id FK → modules.projects.id,
labour_name, role, hours, rate, amount,
work_date, created_at,
-- NEW field, per 21 §6:
project_cost_id   uuid FK -> modules.project_costs.id nullable
```

**Indexes:** `INDEX(tenant_id, project_id)` on both tables.

---

# 8. Offline / Sync Support Tables — AMENDED

These are **client-side (IndexedDB/Dexie)** structures, documented here for schema-parity with server tables — not PostgreSQL tables (except §8.3–§8.5, which are server-side).

## 8.1 Client `pendingOperations`

```text
operationId (PK), tenantId, userId, deviceId,
entityType, entityId, operationType (CREATE/UPDATE/ACTION),
payload, status (PENDING/SYNCING/SYNCED/FAILED/PERMANENTLY_FAILED),
createdAt, attemptCount, lastError, lastAttemptAt
```

**Indexes:** `[tenantId+status]`, `[tenantId+deviceId]` (per §46, `05`)

## 8.2 Client `localCache`

```text
tenantId, entityType, entityId, payload, cachedAt
```

## 8.3 Server-side counterpart: `core.sync_operations`

**Purpose:** Server-side idempotency ledger for offline pushes (per §41, `04`; §52, `04`).

```text
id, tenant_id, operation_id UNIQUE per tenant, device_id, user_id,
entity_type, entity_id, status (APPLIED/REJECTED),
result_snapshot jsonb, applied_at
```

**Unique:** `UNIQUE(tenant_id, operation_id)` — this is the concrete idempotency-replay mechanism referenced throughout `03`/`04`/`05`.

## 8.4 `core.change_log` — NEW

Per `10_OFFLINE_SYNC_SPECIFICATION.md` §12, Decision SYNC-002.

```text
core.change_log
  id, tenant_id, entity_type, entity_id,
  change_type (UPSERT/DELETE), change_sequence bigserial per tenant,
  occurred_at
```

**Index:** `INDEX(tenant_id, change_sequence)`.

## 8.5 `control.devices` — NEW

Per `10_OFFLINE_SYNC_SPECIFICATION.md` §12, Decision SYNC-003 — control-plane, not tenant-scoped, since a device is user-bound, not tenant-bound.

```text
control.devices
  id (=deviceId), user_id, first_seen_at, last_seen_at, user_agent
```

---

# 9. Cross-Cutting Constraints Summary

| Rule | Mechanism |
|---|---|
| Tenant isolation | `tenant_id` column + RLS policy + repository scoping |
| No cross-tenant FK | application validation on write; composite tenant-aware FKs where PostgreSQL allows |
| Idempotent mutation | `UNIQUE(tenant_id, operation_id)` on all mutation-origin tables |
| Debit = Credit | application transaction + recommended trigger on `core.journal_entries` |
| Stock non-negative (unless allowed) | domain validation before movement insert; `core.items.allow_negative_stock` (§5.6, Decision INV-007) opts a specific item out per-item; DB CHECK optional per tenant config |
| Return ≤ sold qty | domain validation against `core.sale_items`/`core.purchase_items` |
| No destructive financial edit | no UPDATE path exposed for `sales.status = COMPLETED`; reversal-only |
| Tenant-local uniqueness | all `UNIQUE` constraints are composite with `tenant_id` |
| Owner always assigned while ACTIVE | `control.tenants` CHECK `owner_required_when_active` (§4.2, Decision TEN-001) |

(Content unchanged from v1.0 except the two rows noted above — **this section's number, §9, is deliberately preserved unchanged** since `07` §17 and `13` §4.2/§9.1 cite it directly; see the Changelog's numbering-rule note.)

---

# 10. Row Level Security — Reference Policy Shape

```sql
-- Example shape, illustrative only — final DDL in migration package.
ALTER TABLE core.sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_sales ON core.sales
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Applied uniformly to every `core.*` and `modules.*` and `industry.*` table with a `tenant_id` column, per §24–26 of `05`.

**Connection Pooling Mode (Phase 0.5 Reconciliation, Decision TEN-002):** Phase 1 deployment uses **session-mode connection pooling** (per `05` §25 addendum, reflected in `25_DEPLOYMENT_ARCHITECTURE.md`). The `SET LOCAL app.tenant_id` discipline (used to populate `current_setting` above) is pooling-mode-agnostic — its effect clears at transaction commit/rollback, before the connection returns to the pool — so a future transition to transaction-mode pooling (e.g. PgBouncer) requires no application code or policy change here, only an infrastructure/pooler configuration change. This resolves Phase 0.5 Finding 10.

---

# 11. Indexing Strategy Summary (per §152, `04`)

Standard composite indexes applied by default where the table has `tenant_id`:

```text
(tenant_id, created_at)
(tenant_id, status)        -- where status exists
(tenant_id, <primary FK>)  -- e.g. (tenant_id, customer_id)
```

Additional targeted indexes as listed per-entity above (invoice_number, expiry_date, phone, sku, etc.)

---

# 12. Open Schema Questions (carried from `01`/`02`, to resolve before migration freeze)

```text
1. Native PostgreSQL ENUM vs text+CHECK for status fields — decide per volatility
   (frequently-extended statuses → text+CHECK; stable ones → enum)
2. UUID v4 vs UUIDv7 — UUIDv7 preferred for index locality; confirm library support
3. Partial vs full RLS coverage for read-heavy reporting tables
4. Materialized view strategy for core.stock_balances at scale
5. Multi-currency schema hooks (deferred fields) — add now as nullable or defer entirely?
6. Whether core.receivables/payables should be fully derived (view) vs cached table
7. Exact CHECK constraint set enforceable at DB level vs domain-only
8. Branch/warehouse scoping columns on control.memberships — array vs join table
```

**Items resolved since v1.0 (Phase 0.5 Reconciliation) — moved to §13 as ratified Decisions, not listed here:** discount approval threshold (→ Decision DOM-006), negative stock policy (→ Decision INV-007), moduleState redundancy (→ Decision BIL-007), owner-membership invariant (→ Decision TEN-001), RLS/connection-pooling mode (→ Decision TEN-002). Items 1–8 above remain genuinely open.

---

# 13. Decisions Established by This Document — AMENDED

### Decision DB-001
`core.stock_movements` is the sole authoritative inventory source; `core.stock_balances` is a recomputable cache.

### Decision DB-002
All idempotency is enforced via `UNIQUE(tenant_id, operation_id)`, not application-only checks.

### Decision DB-003
Industry schemas attach to Core via 1:1 foreign keys on Core primary keys — never fork or duplicate Core tables.

### Decision DB-004
Financial transaction tables (`sales`, `purchases`, `journal_entries`, `payments`) have no destructive UPDATE path once completed — correction is reversal-only.

### Decision DB-005
Every tenant-owned table carries `tenant_id` and is protected by both application scoping and PostgreSQL RLS (defense-in-depth, not either/or).

### Decision DB-006 (v2.0)
Three additional schema groups — `automation`, `billing`, `migration` — are formally added to the canonical schema-group registry (§3), correcting the registry-drift gap identified in Phase 0.5.

### Decision DB-007 (v2.0)
`billing.*` and `migration.*` are Control-Plane-only schema groups, never present in a tenant's Shared or Dedicated business database; `automation.*` is tenant-scoped, colocated with `core`/`modules`/`industry` (§3.1).

### Decision DB-008 (v2.0)
Required PostgreSQL extensions (`pgcrypto`, `btree_gist`) are now formally documented (§17) as a prerequisite for both Shared-cluster provisioning and every Dedicated-tenant provisioning run.

### Decision DB-009 (v2.0)
An Amendment Ledger (§18) is a mandatory, permanent section of this document — every future schema-affecting document MUST both (a) self-declare its amendment via a `Decision <PREFIX>-###` tag in its own text, per the existing pattern set by `08`–`23`, AND (b) have that amendment appended to §18 the next time this document is revised.

### Decision DB-010 (v2.0 — Phase 0.5 Reconciliation)
`control.tenants` gains `CONSTRAINT owner_required_when_active` (per `05` §75a, Decision TEN-001) and `core.items` gains `allow_negative_stock boolean NOT NULL DEFAULT false` (per `09` §4.7, Decision INV-007) — both ratified during Phase 0.5 Reconciliation, human-approved.

### Decision INV-008 (v2.0 — Phase 0.5 Reconciliation, second reconciliation pass)
`core.stock_balances`' uniqueness enforcement is corrected from a single `UNIQUE INDEX(tenant_id, item_id, warehouse_id, batch_id)` — which does not actually enforce the intended invariant, since PostgreSQL treats `NULL <> NULL` in unique indexes and `batch_id` is legitimately `NULL` for every non-batch-tracked item — to two partial unique indexes (`batch_id IS NOT NULL` / `batch_id IS NULL`), per §5.10's amended text. Discovered during the `commerce.ts`-vs-spec verification pass; corrected in both the canonical schema text (§5.10) and the implementation (`packages/db/schema/commerce.ts`, `migrations-manual/0005_rls_policies_commerce.sql`).

---

# 14. Automation Schema — NEW

Per `23_AUTOMATION_ARCHITECTURE.md` §13, Decision AUT-002 (including the schema-group-level amendment to §3, honored above).

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

# 15. Billing Schema — NEW

Per `26_SAAS_BILLING_SPECIFICATION.md` §8.1, Decision BIL-SCHEMA-002.

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

**Critical placement note (restated from §3.1):** this entire schema group is **Control-Plane-only** — `billing.*` NEVER writes to or reads from any `core.*` tenant-business-plane table (per `26` §7.4, §2's Billing Separation principle).

---

# 16. Migration Schema — NEW

Per `27_MIGRATION_SPECIFICATION.md` §2.3, Decision MIG-SCHEMA-001.

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

# 17. Required PostgreSQL Extensions — NEW

| Extension | Required By | Reason |
|---|---|---|
| `pgcrypto` (or native PG13+ `gen_random_uuid()`) | Every table using `id uuid PK, default gen_random_uuid()` (§2, platform-wide convention) | UUID primary key generation |
| `btree_gist` | `modules.bookings` (§6.2) | Required for the `EXCLUDE USING gist (... tsrange ...)` overlap-prevention constraint (per `18` §4.1) |

**Provisioning requirement:** both extensions MUST be enabled during database provisioning — for Shared mode, once at cluster/database level; for Dedicated mode, as a mandatory step in `DedicatedTenantProvisioningJob` (`25` §6.2), inserted before schema migration (`25` §6.2 step 4).

---

# 18. Amendment Ledger — NEW

Every schema change merged into this canonical document, traced to its source document and section, in the order originally declared:

| # | Source Doc | Source § | Change | Target Table(s) | Declared As |
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
| 16 | `26` | §3, §8 | New schema group + tables (retroactive) | `billing.invoices`, `billing.payment_methods` [partially unspecified], `billing.payment_attempts`; `control.plans`/`control.subscriptions` field finalization | Decision BIL-SCHEMA-001, BIL-SCHEMA-002 |
| 17 | `27` | §2.3 | New schema group + tables (retroactive) | `migration.staging_*` [column-level detail unspecified] | Decision MIG-SCHEMA-001 |
| 18 | `13` | §2.6 | New columns (retroactive) | `control.users.mfa_enabled`, `mfa_secret_ref` | Decision SEC-006-SCHEMA |
| 19 | `07` | §7.5a (new) | No schema change — policy only | — | Decision DOM-006 |
| 20 | `09` | §4.7 (new) | New column | `core.items.allow_negative_stock` (boolean, default false) | Decision INV-007 |
| 21 | `05` | §75a (new) | New CHECK constraint | `control.tenants` (owner_required_when_active) | Decision TEN-001 |
| 22 | `05` | §25 (amended) | No schema change — deployment/config only | — | Decision TEN-002 |
| 23 | `26` | §6 (amended) | No schema change — algorithm simplification | — | Decision BIL-007 |
| 24 | `packages/db/schema/commerce.ts` verification pass | §5.10 (amended) | Corrected uniqueness mechanism: single nullable-column unique index replaced with two partial unique indexes (`stock_balances_pk_batched` / `stock_balances_pk_unbatched`), applied via `migrations-manual/0005_rls_policies_commerce.sql` | `core.stock_balances` | Decision INV-008 |

**Items requiring further human decision before these are fully closed:**

- `billing.payment_methods` — full field list not specified anywhere in `26`; a minimum inferred shape is shown in §15 marked `[UNSPECIFIED]`.
- `migration.staging_*` — column-level DDL not specified anywhere in `27`; only the pattern (mirror target schema) is given.
- §3.1's control-plane-vs-tenant-database placement inference for `billing`/`migration`/`automation` — logically derived from source documents, not explicitly stated verbatim in them; treated as settled for this canonical document but flagged here for completeness.
- Rows 16–18's retroactive Decision tags are recorded here; `26`, `27`, and `13` themselves should receive a small addendum acknowledging them in a future pass, per the Option C dual-declaration requirement.
- v1.0's original §12 Open Schema Questions items 1–8 remain genuinely open (see §12).

---

# 19. Next Document

পরবর্তী document:

`07_CORE_DOMAIN_SPECIFICATION.md`

এখানে প্রতিটি Core module-এর (Sales, Purchase, Inventory, Payment, Accounting) **domain layer** — entities, value objects, invariants, use cases, application services — বিস্তারিতভাবে নির্ধারণ করা হবে, এই database schema-কে ভিত্তি ধরে।