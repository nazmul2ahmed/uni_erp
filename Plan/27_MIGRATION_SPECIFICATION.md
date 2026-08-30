# 27_MIGRATION_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Migration Specification
**Version:** 1.0 Draft
**Status:** Cross-Cutting System Deep-Dive
**Depends on:**
- `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md` (§31, Migration Philosophy)
- `03_MASTER_PROJECT_SPECIFICATION.md` (§56–57, Data Import/Export; §68–69, Shared→Dedicated/Dedicated→Shared Migration)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§101–108, Migration/Verification/Rollback/Schema Version/Router Safety)
- `19_INDUSTRY_PHARMACY.md` (§10, legacy field mapping table — starting point this document completes)
- `25_DEPLOYMENT_ARCHITECTURE.md` (§6.2, §8, Provisioning/Migration-in-Deploy-Pipeline — schema migration, distinct from DATA migration covered here)

---

# 1. Purpose

এই document দুই স্বতন্ত্র কিন্তু পরিভাষায় সংঘর্ষপূর্ণ "migration" ধারণাকে স্পষ্টভাবে পৃথক করে এবং প্রতিটির জন্য concrete procedure নির্ধারণ করে:

```text
Schema Migration   — already covered, 25_DEPLOYMENT_ARCHITECTURE.md
                      §8 (Drizzle-generated DDL changes, applied on
                      every deploy) — NOT re-specified here.

Data Migration      — THIS document:
  (a) Legacy Pharmacy PWA → new platform (one-time, per-tenant,
      onboarding a pre-existing business's historical data)
  (b) Generic tenant import/export (CSV/Excel/JSON, per 03 §56-57 —
      any NEW tenant coming from ANY prior system, not just the
      legacy Pharmacy PWA)
  (c) Shared ↔ Dedicated tenant storage-mode migration (per 03
      §68-69, 05 §101-108 — an EXISTING platform tenant changing
      deployment mode, not importing external data at all)
```

These three are related (all move business data across a boundary and all require reconciliation) but are triggered differently, run on different schedules, and carry different risk profiles — conflating them was flagged as a terminology risk worth resolving explicitly (Decision MIG-001, §13).

**Foundational rule carried forward (per `01` §31, restated as this document's governing philosophy):**

> পুরনো data সরাসরি কপি করা হবে না। বরং: Export → Transform → Canonical ERP Data Model → Validation → Import → Reconciliation। প্রতিটি ধাপ independently verifiable এবং প্রতিটি failure বিন্দুতে rollback সম্ভব হতে হবে।

---

# 2. Migration Category A — Legacy Pharmacy PWA Import

## 2.1 Pipeline

```text
Legacy Firestore Export (per 01 §2.1's existing Firestore-backed
  system)
        ↓
Raw JSON Dump (per-collection: medicines, customers, suppliers,
  sales, purchases, expenses, staff, opening entries)
        ↓
TransformService (per legacy field, §2.2's mapping table)
        ↓
Canonical ERP Staging Tables (NOT core.* directly — see §2.3)
        ↓
Validation Pass (§2.4)
        ↓
Import (Use-Case-driven, §2.5 — NEVER raw SQL INSERT into core.*)
        ↓
Reconciliation Report (§4)
```

## 2.2 Field Mapping — Extends `19` §10

`19_INDUSTRY_PHARMACY.md` §10 already established the conceptual mapping table for Pharmacy-specific concepts. This document extends it to the full legacy dataset, including Core-generic entities the Pharmacy audit (`01`) also touched:

| Legacy Collection/Field (`01`) | New Location | Transform Notes |
|---|---|---|
| `medicines` | `core.items` + `industry.pharmacy_item_details` | Split per `19` §3; `type` always `PRODUCT` |
| Medicine `stock` (mutable field) | **Discarded** — never imported as a balance | Per Decision DB-001 (`06` §13); instead, an `OPENING` stock movement is synthesized (§2.6) from the legacy value at cutover time |
| `customers` | `core.customers` | `dueBalance` (legacy mutable field) discarded; opening receivable synthesized as an Opening Entry (`08` §5.8), never copied as a live balance |
| `suppliers` | `core.suppliers` | Same discard-and-synthesize rule for `duePayable` |
| `sales` (historical) | `core.sales` + `core.sale_items` | Imported as **already-`COMPLETED`** records — historical sales are never re-run through `CompleteSaleUseCase`'s live validation (stock availability, etc. — see §2.5's import-mode distinction) |
| `purchases` (historical) | `core.purchases` + `core.purchase_items` + `core.stock_batches` | Same completed-record import mode |
| `expenses` | `core.expenses` | Category mapped via a new `expense_categories` seed derived from legacy free-text categories (deduplicated during transform) |
| `staff` | `control.memberships` + `control.roles` | Legacy `Owner/Manager/Cashier` (`01` §15) mapped to seeded preset roles (`06` §4.4); custom permission tweaks, if any existed informally, are **not** auto-migrated — flagged for manual tenant review post-migration |
| Legacy `pendingWrites` (IndexedDB offline queue) | **Not migrated** | Transient client-side state has no server-side equivalent to import into; any legacy unsynced writes must be resolved (synced or discarded) in the OLD system before export begins (§2.7's pre-migration checklist) |

## 2.3 Staging Tables — Why Not Direct `core.*` Writes

```text
A dedicated migration.staging_* schema (mirrors automation's own
schema addition pattern, 23 §13) holds transformed-but-not-yet-
validated rows:

  migration.staging_items, migration.staging_customers,
  migration.staging_sales, ... (one per target entity)

This exists so validation (§2.4) can run repeatedly against a
STABLE snapshot without re-running the transform, and so a failed
validation never leaves partially-imported core.* data — core.*
receives writes ONLY after §2.4 passes in full for a given tenant's
entire dataset.
```

## 2.4 Validation Pass

```text
MigrationValidationService.validate(tenantId) -> ValidationReport:
  Structural:
    - every staged row has required fields (per the target table's
      NOT NULL constraints, 06 §9)
    - foreign key references resolve WITHIN the staged set (e.g.
      every staged sale_item.item_id exists in staging_items)
  Business:
    - staged Sale.grandTotal == subtotal - discount + tax (07 §7.3
      invariant 2 — historical data must satisfy the SAME invariants
      new data does, even though it bypasses the live Use Case path)
    - staged financial totals net to a balanced position (§4.2)
  Referential completeness:
    - no orphaned sale_item referencing a missing legacy medicine
      (logged as a WARNING with the row skipped + reported, not a
      hard failure that blocks the entire tenant's import — a single
      corrupt legacy row must not block 10,000 valid ones)

ValidationReport is presented to a human (typically the implementing
engineer, not the tenant) for review BEFORE import proceeds — no
automatic pass-then-import chaining without an explicit go-ahead
(mirrors the AI OCR human-confirmation gate's spirit, 07 §8.4,
applied here to bulk historical-data trust rather than a single
purchase invoice).
```

## 2.5 Import Execution — Two Distinct Modes

```text
Mode 1 — HISTORICAL (used for all migration Category A data):
  Bypasses live Use Case validation (a 2-year-old completed Sale
  cannot be re-validated against TODAY's stock levels — that
  validation was already satisfied at the time, in the old system).
  Writes directly to core.sales/core.purchases/etc. via a dedicated
  ImportHistoricalTransactionService, but STILL:
    - creates the corresponding core.stock_movements (type=OPENING
      or PURCHASE/SALE as appropriate, per §2.6)
    - STILL posts a balanced accounting Journal per transaction
      (08 §4's posting rules apply identically — historical data is
      NOT exempt from double-entry integrity, only from LIVE
      re-validation)
    - STILL runs inside a single atomic transaction per record,
      per-tenant, so a partial import never leaves an unbalanced
      Journal or an orphaned SaleItem

Mode 2 — LIVE (used for NEW data entered after cutover):
  Standard path, per 07/08/09 — CompleteSaleUseCase etc., unchanged
  by this document.

The cutover moment (§2.7) is the precise timestamp separating which
mode applies to which record — never ambiguous, always tenant-
specific and explicitly recorded.
```

## 2.6 Opening Stock/Balance Synthesis

```text
Rather than importing a legacy `medicine.stock` NUMBER as a fake
"balance row" (which would violate Decision DB-001, 06 §13 —
core.stock_balances must always be DERIVED, never a primary write
target), the migration synthesizes an OPENING stock_movement
(per 09 §2's movement type table) dated at the tenant's cutover
timestamp, quantity = the legacy stock value at export time.

Balance is then correctly DERIVED from this movement by the normal
InventoryLedgerService.recomputeBalance (09 §3.2) — no special-cased
"import balance" code path exists; the import literally uses the
same mechanism live OPENING entries use (08 §5.8), just with a
migration-sourced quantity instead of a manually-entered one.
```

## 2.7 Pre-Migration Checklist (per tenant)

```text
[ ] All legacy pendingWrites (offline queue) synced or explicitly
    discarded — confirmed zero rows remain in the legacy system
[ ] Legacy system placed in read-only/frozen mode for the export
    window (prevents a write occurring AFTER export snapshot but
    BEFORE cutover from being silently lost)
[ ] Export snapshot taken, cutover timestamp recorded
[ ] Staging + validation (§2.3-2.4) completed and reviewed
[ ] Tenant stakeholder sign-off on the Validation Report (business-
    side confirmation, not just an engineering checkbox)
[ ] New tenant record fully provisioned (05 §48-50) and reachable
    BEFORE import begins — import never provisions infrastructure
    as a side effect
```

---

# 3. Migration Category B — Generic Tenant Import/Export Framework

Per `03` §56–57, for tenants onboarding from **any** prior system (spreadsheets, a different ERP, or no prior system at all — a fresh business).

## 3.1 Supported Formats & Targets (MVP scope)

```text
Formats:  CSV, Excel (.xlsx), JSON
Targets (per 03 §56):
  Customers, Suppliers, Items, Opening Stock,
  Opening Receivable, Opening Payable
```

## 3.2 Pipeline (background job, per `04` §156)

```text
Upload (12's file-upload pattern, 13 §6) -> ImportJob created
        ↓
Background Worker parses file -> maps columns to target schema
  (column-mapping UI lets the tenant/admin align THEIR spreadsheet
  headers to the canonical field names — never assumes a fixed
  column order)
        ↓
Row-level validation (same MigrationValidationService shape as §2.4,
  reused not duplicated — Decision MIG-002, §13)
        ↓
Preview screen: N valid rows, M rows with errors (shown inline,
  per-row, per 04 §156's "Preview Errors" step) — tenant can
  correct the source file and re-upload, or proceed importing only
  the valid rows
        ↓
Commit -> valid rows imported via the SAME Use Cases a human using
  the UI would call (CreateCustomerUseCase, CreateItemUseCase, etc.
  — per 05 §112's "seed via the same Use Cases" principle, restated
  here for tenant-initiated import rather than platform-seeded
  fixtures) — this is Mode 2 (LIVE) validation, NOT Mode 1
  (HISTORICAL), since a fresh CSV import of a Customer list has no
  "was already valid at the time" exemption to claim
```

**Distinction from Category A (Decision MIG-003, §13):** generic CSV import always runs LIVE validation (§2.5 Mode 2) — it is architecturally a bulk-UI-entry convenience, not a historical-data trust exception. Only the legacy-Pharmacy-PWA path (Category A) is permitted to use Mode 1's bypassed validation, and only for records provably already-completed in a prior system.

## 3.3 Export (mirror path, per `03` §57)

```text
GET /api/export/{entityType}  -> ExportJob (04 §157's async pattern
  — CSV/Excel/JSON generated in the background, delivered via
  signed object-storage URL, per 04 §56-58) — never a synchronous
  large-payload HTTP response, consistent with 04 §156's import
  pipeline symmetry.

Tenant isolation enforced identically to every other data-access
path (05 §21-23) — an export job is just another tenant-scoped
Application Service call, nothing exempted.
```

---

# 4. Reconciliation — Concrete Checklist (Extends `05` §103)

Run after **any** migration category (A, B, or C/§5) completes, before the migration is considered successful:

```text
[ ] Row counts match between source and destination (per entity type)
[ ] Financial totals reconcile:
      SUM(imported core.sales.grandTotal) == SUM(legacy sales total)
      SUM(imported core.journal_entries.debit) ==
        SUM(imported core.journal_entries.credit)  (08 §11
        INV-ACC-001, must hold for imported data exactly as for
        live data — no exemption)
[ ] Stock totals reconcile: derived core.stock_balances (post-import
    recompute, 09 §3.2) matches the legacy system's last-known
    per-item stock figure at cutover
[ ] Open Receivables total == sum of imported customer opening
    balances + any imported historical unpaid sales' due amounts
[ ] Open Payables total == mirrored supplier-side check
[ ] Attachments/documents (legacy invoice scans, if any existed)
    correctly re-associated with their imported parent records,
    accessible via the standard signed-URL path (13 §6)
[ ] User/staff accounts: every legacy staff member has exactly one
    corresponding control.membership, no duplicates, no orphans
[ ] Settings (currency, timezone, numbering prefix) correctly
    carried into core.business_profiles / tenant settings (05 §119)
```

A migration is **not** marked complete until every checklist item passes — partial/best-effort completion is explicitly rejected (mirrors `05` §103's own phrasing, "reconciliation" as a hard gate, not a nice-to-have report).

---

# 5. Migration Category C — Shared ↔ Dedicated Storage-Mode Migration

Concretizes `03` §68–69 and `05` §101–108 into an executable procedure. **This category moves an EXISTING platform tenant's data between two platform databases — it involves no external system and no legacy-format transform (§2, §3 do not apply here).**

## 5.1 Shared → Dedicated

```text
1. Freeze writes for the tenant (per 05 §101 — a brief, explicitly
   communicated maintenance window; the tenant's UI shows a
   "migration in progress, writes temporarily paused" state rather
   than a silent failure)
2. Export a CONSISTENT snapshot — all tenant-scoped rows across
   every core/modules/industry table, using a single transaction-
   consistent read (PostgreSQL REPEATABLE READ or a logical
   replication slot snapshot, exact mechanism an implementation
   choice) — consistency here means no row is missed or duplicated
   due to a concurrent write slipping between the freeze and the
   snapshot
3. Provision the new dedicated database (05 §50, 25 §6.2's
   DedicatedTenantProvisioningJob — REUSED, not reimplemented,
   Decision MIG-004 §13)
4. Import the snapshot into the new dedicated database (schema
   already migrated per provisioning's own step, 25 §6.2 step 4)
5. Reconciliation (§4's full checklist, run against OLD shared rows
   vs NEW dedicated rows)
6. Switch routing: control.tenant_databases.storage_mode updates to
   DEDICATED, control.tenants.storage_mode mirrors it (06 §4.2)
7. Resume writes -> now routed to the NEW dedicated database (05
   §27's Database Router picks this up automatically on the next
   request, no application code change)
8. OLD shared-mode rows for this tenant are RETAINED (not deleted)
   for a defined retention window (§5.3) — enabling rollback (§5.4)
   without needing a fresh re-export if something is discovered
   wrong shortly after cutover
```

## 5.2 Dedicated → Shared

```text
Mirrors §5.1 in reverse, with one added step: validate SCHEMA
COMPATIBILITY first (05 §102) — a dedicated tenant that has been
running on an OLDER schema_version (05 §54's per-tenant migration
tracking) than the shared cluster's current version must first
receive the SAME rolling schema migrations the shared tenants
already have, via the normal deploy pipeline (25 §8), before its
data can import cleanly into the shared cluster's current schema
shape. This is why 05 §102 flags "Validate compatibility" as its
own explicit first step — it is not optional or assumed.
```

## 5.3 Old-Storage Retention Window

```text
Per §5.1 step 8: the pre-migration storage location's data is
retained for a MINIMUM of 7 days post-cutover (placeholder value,
flagged §14 Q1 pending an operational-cost/risk tradeoff decision)
before being decommissioned (dedicated database destroyed, per 05
§61) or archived-and-purged (shared-mode rows, per 05 §60).
```

## 5.4 Rollback

```text
Per 05 §104: if reconciliation (§4) FAILS after cutover (§5.1 step
6-7 already executed) but BEFORE the retention window (§5.3)
expires:
  1. Switch routing BACK to the old storage location (reverses step
     6 — the old data was never deleted, per step 8)
  2. Any writes that occurred AFTER cutover but BEFORE rollback
     (against the NEW location) must be manually reconciled back
     into the OLD location — this is the one scenario in this
     entire document where a fully-automatic rollback is NOT
     guaranteed, and is flagged explicitly (§14 Q2) as needing a
     documented manual procedure, since it depends on how much
     write volume occurred in the (hopefully brief) window between
     cutover and failure detection
  3. If validation fails BEFORE cutover (step 5, before step 6) —
     rollback is trivial: routing was never switched, the new
     database is simply discarded/re-attempted, zero tenant-visible
     impact
```

---

# 6. Testing Obligations

```text
[ ] Field mapping (§2.2) — every legacy field either maps to a
    canonical field or is explicitly documented as discarded (no
    silent data loss — a mapping-completeness test asserts every
    legacy schema field appears in the mapping table)
[ ] Historical import mode (§2.5 Mode 1) — an imported historical
    Sale produces a balanced Journal identical in shape to what
    CompleteSaleUseCase would have produced at the time, WITHOUT
    invoking live stock-availability validation
[ ] Opening stock synthesis (§2.6) — imported balance, when derived
    via the normal recomputeBalance path, exactly matches the
    legacy stock figure — no discrepancy between "what was imported"
    and "what the ledger now says," proving no shortcut balance-
    table write occurred
[ ] Generic CSV import (§3.2) — malformed rows are reported per-row
    with actionable error detail, never a whole-file reject; valid
    rows import correctly even when interspersed with invalid ones
[ ] Reconciliation checklist (§4) — a deliberately-corrupted test
    fixture (mismatched totals) is correctly caught and blocks
    completion
[ ] Shared→Dedicated migration (§5.1) — full round-trip test:
    migrate a fixture tenant, verify byte-for-byte data parity via
    §4's checklist, verify routing switches correctly (05 §27's
    Database Router test)
[ ] Rollback (§5.4) — pre-cutover failure rolls back with zero
    impact; post-cutover failure is caught by the reconciliation
    gate and correctly flags for the documented manual procedure
```

---

# 7. Decisions Established by This Document

### Decision MIG-001
"Migration" in this platform's documentation refers to three distinct procedures — Schema Migration (`25` §8, deploy-time DDL), Data Migration Category A/B (this document, historical/bulk data import), and Storage-Mode Migration Category C (this document §5, Shared↔Dedicated) — each with its own trigger, schedule, and risk profile; they are never conflated in implementation planning.

### Decision MIG-002
`MigrationValidationService` is a single shared validation engine used identically by Category A (legacy import) and Category B (generic CSV import) — the same structural/business/referential checks apply regardless of data source, avoiding two independently-drifting validation implementations.

### Decision MIG-003
Only Category A (legacy Pharmacy PWA import) is permitted to use Historical import mode (§2.5 Mode 1, bypassing live Use Case validation) — Category B (generic tenant CSV/Excel import) always runs through Live mode (standard Use Cases), since a fresh spreadsheet upload has no "already validated at the time" claim to make.

### Decision MIG-004
Category C's Shared→Dedicated migration reuses the identical `DedicatedTenantProvisioningJob` (`25` §6.2) already built for brand-new dedicated tenant onboarding — provisioning a database is the same operation whether the tenant is new or migrating from Shared mode, never a second parallel implementation.

### Decision MIG-005
Old-storage data is never deleted immediately upon a storage-mode migration's cutover — it is retained for a defined window (§5.3) specifically to make pre-expiry rollback (§5.4) possible without a fresh re-export.

---

# 8. Open Migration Questions

```text
1. Old-storage retention window exact duration (§5.3) — currently a
   7-day placeholder; needs an operational cost/risk tradeoff
   decision, similar in category to several other placeholder values
   already accepted in this series (dunning schedule, `26` §14 Q4;
   backup retention, `25` §13 Q2).
2. Post-cutover rollback (§5.4 step 2) — does this need a fully
   automated "replay writes from new to old" mechanism eventually,
   or does manual reconciliation remain acceptable indefinitely
   given how rare a post-cutover failure should be if pre-cutover
   validation (§4) is thorough?
3. Should Category A (legacy import) support a PARTIAL/incremental
   re-run (e.g. a tenant's legacy system stays live for a week after
   initial import, and a second delta-import catches up newly-created
   records), or is single-shot cutover (§2.7) the only supported mode?
4. Generic import (§3) MVP scope is limited to Customers/Suppliers/
   Items/Opening balances (per `03` §56) — does Sales/Purchase
   HISTORY import ever get added to the generic framework (for a
   tenant migrating from a non-Pharmacy prior system with rich
   transaction history), or does that remain a bespoke, one-off
   engineering effort per such tenant, distinct from the generic
   CSV pipeline?
5. Does the reconciliation report (§4) need to be a tenant-visible
   artifact (trust/transparency for a business owner watching their
   own data migrate) or is it purely an internal engineering/
   platform-admin document?
```

---

# 9. Next Document

পরবর্তী document:

`28_IMPLEMENTATION_ROADMAP.md`

এখানে `03` §86's Phase Roadmap (Phase 0–8)-কে concrete, sequenced, dependency-aware implementation plan-এ রূপান্তর করা হবে — এই পর্যন্ত সম্পূর্ণ ২৭টি specification document-এর ওপর ভিত্তি করে actual build order, milestone-এর মধ্যে dependency chain, এবং প্রথম commercial vertical (Electronics + Service, per `03` §87)-এর জন্য concrete delivery sequence নির্ধারণ করবে।
