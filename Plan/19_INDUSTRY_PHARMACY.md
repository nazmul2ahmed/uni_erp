# 19_INDUSTRY_PHARMACY.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Pharmacy Industry Extension Specification
**Version:** 1.0 Draft
**Status:** Industry Extension Deep-Dive — First document in the Industry series
**Depends on:**
- `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md` (entire document — primary source material)
- `06_DATABASE_SPECIFICATION.md` (§7.1, `industry.pharmacy_item_details` / `industry.pharmacy_batch_details`)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§6.1–6.2, Item tracking flags, `ItemTrackingPolicy`)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§4.2, FEFO allocation)
- `12_UX_SPECIFICATION.md` (§3.3, §8, Industry navigation additions & Dashboard widgets)

---

# 1. Purpose

এই document Industry Extension series-এর প্রথম — `Pharmacy` extension-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities specific to Pharmacy (beyond Core Item/Batch)
Prescription entity (net-new — not defined in any prior document)
FEFO activation mechanics (concrete, not just referenced)
Expiry alert rules and dashboard widget
Database detail (beyond the 06 §7.1 stub)
UX additions (Item form tab, navigation sub-items, per 12 §3.3)
Migration mapping from the legacy Pharmacy PWA (per 01)
Cross-cutting rule: what Pharmacy is NOT allowed to touch in Core
```

**Extension classification (per `02` §40, §53, `01` §33 Decision 001–002):** Industry Extension — composed entirely from Core (Item, Sale, Purchase, Inventory, Accounting) plus zero Optional Modules at minimum viable scope (a pure pharmacy retail counter needs none of Quotation/Service/Rental/Project/Booking). This is the **narrowest** extension in the series precisely because Pharmacy retail is close to the Core Retail baseline — its entire differentiation is tracking-flag configuration plus a handful of descriptive fields.

---

# 2. What "Pharmacy" Actually Adds

Per `01` §31 and Decision 002 (`01` §33), the audit already established that Pharmacy is **not** a separate data model — it is:

```text
Retail (Core)
  +
Inventory (Core) with batch_tracked=true, expiry_tracked=true
  +
FEFO (an Inventory allocation strategy Core already supports, 09 §4.2)
  +
A handful of descriptive fields (generic name, strength, dosage form)
  +
One new entity Core does not have at all: Prescription
```

```text
Sales Domain (Core, unmodified)
Purchase Domain (Core, unmodified)
Inventory Domain (Core, unmodified — FEFO already exists as a
                    strategy, this extension merely ensures Pharmacy
                    items always carry expiry_tracked=true)
        ↑
   [1:1 extension tables, per Decision DB-003, 06 §13]
        │
industry.pharmacy_item_details
industry.pharmacy_batch_details
        │
   [net-new entity, this document]
        │
industry.prescriptions
```

**Critical constraint restated (per `01` §55, `04` §133):** nothing in this document introduces `medicineBatch`, `patientPrescription`-style Core vocabulary, or any Pharmacy-aware branching inside `07_CORE_DOMAIN_SPECIFICATION.md`'s use cases. Every Pharmacy behavior is either (a) a Core capability already generic (FEFO, batch tracking) that Pharmacy items simply configure on, or (b) a genuinely new entity confined to the `industry` schema.

---

# 3. Domain Entity: `industry.pharmacy_item_details` (extends `core.items`)

Already stubbed in `06` §7.1; this document finalizes the field set and its editing rules.

```text
PharmacyItemDetails
├── id, tenantId, itemId FK -> core.items.id UNIQUE
├── genericName            -- e.g. "Paracetamol" (the item.name itself
│                              is typically the brand name, e.g. "Napa")
├── strength                -- e.g. "500mg"
├── dosageForm               -- e.g. TABLET | CAPSULE | SYRUP |
│                                INJECTION | CREAM | DROPS | INHALER |
│                                OTHER (tenant-extensible list, not a
│                                hard enum — per §9 open question)
├── manufacturer
├── requiresPrescription: boolean
├── createdAt
```

**Invariant:** `PharmacyItemDetails` may only be attached to an `core.items` row where the tenant has the Pharmacy extension active (`tenant_features` check, mirrors `06` §4.7 pattern) — this is an application-layer gate, not a DB-level one, since `industry.*` schema has no awareness of `tenant_features` by design (keeping the extension schema itself simple, per `06` §7).

**Auto-configuration rule (concrete fulfillment of `07` §6.2's `ItemTrackingPolicy`):**

```text
CreatePharmacyItemUseCase (thin wrapper over Core's CreateItem, 07 §6.3):
  1. Delegate to CreateItem(coreItemInput) with tracking flags forced:
       tracking.batch = true
       tracking.expiry = true
       tracking.stock = true
  2. On success, persist PharmacyItemDetails row linked to the new
     itemId
  3. Both writes occur in one transaction — a Pharmacy item is never
     left in a state where the Core Item exists but its Pharmacy
     details don't (or vice versa)
```

This use case is the concrete mechanism by which `ItemTrackingPolicy.resolve()` (`07` §6.2) ends up selecting FEFO for every Pharmacy item — the extension does not modify `ItemTrackingPolicy` itself; it simply guarantees every Pharmacy item is created with the flag combination that policy already interprets as "use FEFO" (`09` §4.2 note: "FEFO is selected automatically whenever `item.tracking.expiry = true`").

---

# 4. Domain Entity: `industry.pharmacy_batch_details` (extends `core.stock_batches`)

```text
PharmacyBatchDetails
├── id, tenantId, stockBatchId FK -> core.stock_batches.id UNIQUE
├── genericNameSnapshot     -- copied at batch-creation time, not a
│                              live FK-follow — see §4.1
├── strengthSnapshot
├── createdAt
```

## 4.1 Why Snapshot, Not Live Reference

```text
core.stock_batches already carries expiry_date and batch_number
(Core, generic — per 06 §5.10). This extension adds ONLY the two
descriptive fields a pharmacist needs on a printed batch label/receipt
even if the parent Item's generic name is later edited (e.g. a data
correction to the Item master six months after a batch was received
— the batch's printed/historical record should not silently change).

This mirrors the platform-wide principle of not retroactively
mutating historical transaction-adjacent records (02 §52, reversal-
over-destructive-edit) applied to a descriptive-data edge case rather
than a financial one.
```

**Population trigger:** `ReceivePurchaseUseCase` (`07` §8.3 step 5, "create/attach StockBatch") is extended — when the Item being purchased has an attached `PharmacyItemDetails` row, the same transaction also inserts the corresponding `PharmacyBatchDetails` snapshot. This is a documented, narrow extension point on an existing Core use case, following the identical pattern already established in `15` §6 (Service module's `inventoryAlreadyDeducted` flag) and `17` §6.4 — **the recurring cross-cutting pattern from `18` §13 point 3** (non-double-effect / narrow documented extension rather than a parallel code path).

---

# 5. Domain Entity: `industry.prescriptions` (NEW — not previously defined anywhere)

Per `01` §27 ("Prescription" listed as a Pharmacy-specific entity, never schema-detailed until now) and `02` §31.

```text
Prescription
├── id, tenantId
├── customerId? FK -> core.customers.id       -- nullable: a walk-in
│                                                 sale of an OTC item
│                                                 never needs one; a
│                                                 prescription-required
│                                                 item SHOULD have one
│                                                 attached, per §5.2
├── saleId? FK -> core.sales.id nullable        -- set once the
│                                                  prescription is
│                                                  linked to an actual
│                                                  sale (§5.1)
├── prescribingDoctor?: text                     -- free text, no
│                                                    doctor registry
│                                                    at MVP (§9 open
│                                                    question)
├── documentId? FK -> core.documents.id nullable -- optional scanned/
│                                                    photographed
│                                                    prescription image,
│                                                    reuses Core
│                                                    Document domain
│                                                    (06 §5.15) rather
│                                                    than a parallel
│                                                    file concept
├── notes
├── createdAt, createdBy
```

**Design note:** `Prescription` is deliberately thin and has **no status state machine** — unlike every transactional entity in the Module series (`14`–`18`), a Prescription is a **record of compliance**, not a workflow. It exists to be attached to a Sale for audit/regulatory traceability, not to be tracked through DRAFT/CONFIRMED/etc. states.

## 5.1 Use Case: `AttachPrescriptionUseCase`

```text
Input: saleId (may be a Draft Sale, per 07 §7.8, not yet completed),
       customerId?, prescribingDoctor?, documentId?, notes?, operationId

1. Validate the referenced Sale belongs to tenant
2. Persist Prescription, linked via saleId
3. Audit log
```

**Non-negotiable ordering (mirrors the AI-confirmation pattern's spirit, `07` §8.4, applied to a compliance concern rather than a financial one):** this use case does NOT itself validate "does this sale contain a prescription-required item" — that check lives in `ValidatePrescriptionRequirementPolicy` (§5.2), invoked by `CompleteSaleUseCase`'s Pharmacy-aware extension point (§6), not duplicated here.

## 5.2 Domain Policy: `PrescriptionRequirementPolicy`

```text
validate(saleLines, tenantSettings) -> Result<void, PrescriptionRequiredError>
  # SOFT CONFIGURATION (tenant-configurable, per 02 §44 Business Rule
  # vs Configuration distinction):
  if tenant.settings.pharmacy.enforcePrescriptionCheck = false:
      -> always pass (some tenants choose not to hard-enforce, e.g.
         smaller pharmacies operating on trust/manual compliance)

  # WHEN ENFORCEMENT IS ON:
  for each saleLine where item.pharmacyDetails.requiresPrescription:
      require at least one Prescription record linked to this Sale
      (via saleId) covering that line's item
      -> if missing: Result.fail(PrescriptionRequiredError)
```

**Classification:** this is explicitly a **soft, tenant-configurable check**, not a hard platform invariant like `ReturnEligibilityPolicy`'s quantity cap (`07` §12.2) — because prescription-enforcement rigor varies by jurisdiction, tenant risk tolerance, and local regulatory reality, which this platform does not adjudicate (mirrors the tax/VAT scope limitation already established in `03` §55/§85).

---

# 6. Cross-Cutting Extension Point on `CompleteSaleUseCase`

**This is the second documented, narrow extension to `07` §7.6 in this series (the first being Service module's inventory flag, `15` §6).**

```text
CompleteSaleUseCase (07 §7.6), between step 4 (validate stock
availability) and step 5 (calculate pricing), gains an optional
policy hook:

  4.5. If tenant has Pharmacy extension active:
         PrescriptionRequirementPolicy.validate(lines, tenantSettings)
         -> if fail: Result.fail(PrescriptionRequiredError), same
            ROLLBACK/no-partial-effect guarantee as any other step
            4-11 failure (07 §7.6's existing failure-handling
            contract, unchanged)

This hook is a no-op (skipped entirely) for tenants without the
Pharmacy extension active — Core's CompleteSaleUseCase contract is
otherwise byte-for-byte identical to 07 §7.6. No Pharmacy-specific
branching exists inside Core's own module folder (per 04 §133) — the
hook itself is registered BY the Pharmacy extension module against a
Core-exposed extension point, not written INTO Core's sales/domain
code.
```

This distinction — **extension-registers-hook** vs **Core-contains-industry-branch** — is the concrete architectural mechanism that keeps Decision 002 (`01`) true in practice, and is flagged as Decision PHM-004 (§13).

---

# 7. Expiry Alerts

Per `01` §5 ("Expiry alerts for medicines" listed as Pharmacy-specific Dashboard responsibility) and `12` §8 (Dashboard widget self-registration).

## 7.1 `GetExpiryAlertsUseCase` (Query)

```text
Input: tenantId, warehouseId?, daysThreshold (tenant-configurable,
       default 90)
Output: [{ itemId, itemName, batchId, batchNumber, expiryDate,
          quantityOnHand, daysUntilExpiry }]

Query shape: core.stock_batches WHERE tenant_id=:t
  AND expiry_date IS NOT NULL
  AND expiry_date <= (today + daysThreshold)
  AND quantity_on_hand > 0  -- joins core.stock_balances, per 09 §3.1
  ORDER BY expiry_date ASC

This is a pure Core query (core.stock_batches.expiry_date already
exists generically, indexed per 06 §5.10: "INDEX(tenant_id, item_id,
expiry_date) — used by FEFO allocation & expiry alerts"). The
Pharmacy extension supplies no new table for this — it only supplies
the Dashboard widget (§7.2) and the default threshold configuration
surface.
```

**Note:** this query works for ANY expiry-tracked item regardless of industry (a Grocery tenant with `expiry_tracked=true` on perishables gets the identical capability for free) — Pharmacy is simply the first extension to register a Dashboard widget consuming it, per the Capability-over-Industry principle (`02` §47) restated once more.

## 7.2 Dashboard Widget Registration (extends `12` §8)

```text
Widget: "Expiry Alerts"
Registers itself when: tenant has Pharmacy extension active
                        (could also self-register for any tenant with
                        expiry-tracked items, per the note above —
                        flagged as an open question, §9)
Displays: top N soonest-expiring batches, grouped by urgency band
          (< 30 days = red, 30-60 = amber, 60-90 = yellow)
Click-through: Stock Overview screen (12 §4), pre-filtered to
               expiring batches
```

---

# 8. Database Detail (finalizes `06` §7.1)

```text
industry.pharmacy_item_details
  ... (as defined in 06 §7.1) ...
  -- no amendment needed; fields already match §3 above

industry.pharmacy_batch_details
  ... (as defined in 06 §7.1) ...
  -- no amendment needed; fields already match §4 above

industry.prescriptions          (NEW table, per §5)
  id, tenant_id, customer_id FK nullable, sale_id FK nullable,
  prescribing_doctor text nullable, document_id FK nullable,
  notes text nullable, created_at, created_by
```

**Amendment flag:** Decision PHM-001 (§13) — `06_DATABASE_SPECIFICATION.md` §7.1 is amended to add `industry.prescriptions`.

**Indexes:** `INDEX(tenant_id, sale_id)`, `INDEX(tenant_id, customer_id)`

**Tenant setting addition (extends `06` §4.7 pattern):** `tenant_features` or a dedicated `tenant.settings.pharmacy` JSONB key stores `enforcePrescriptionCheck` (§5.2) and `expiryAlertDaysThreshold` (§7.1) — not a new top-level table, consistent with `05` §119's general Tenant Settings shape.

---

# 9. UX Additions (extends `12` §3.3, §6.3, §8)

Per `12` §3.3, already anticipated:

```text
Item form -> "Pharmacy Details" tab (shown only when Pharmacy
             extension active, progressive disclosure per 03 §49.4):
  Generic Name, Strength, Dosage Form, Manufacturer,
  Requires Prescription (checkbox)

Purchase screen (12 §6.3) -> Batch/Expiry fields already shown per
  Core's existing item.tracking.batch/expiry rule — no Pharmacy-
  specific UI branching needed, since PharmacyItemDetails guarantees
  those flags are always true (§3) for Pharmacy items; the Purchase
  screen's existing generic progressive-disclosure logic naturally
  reveals them.

POS screen (12 §5) -> when a prescription-required item is added to
  cart and PrescriptionRequirementPolicy enforcement is ON (§5.2):
  an inline banner appears: "This item requires a prescription —
  attach one before completing sale" with an [Attach Prescription]
  action opening a lightweight capture form (customer/doctor/photo
  upload via Core Document upload, 04 §58) — this does NOT block
  cart building, only blocks CompleteSaleUseCase per §6's hook, so
  the cashier gets the same actionable-error UX pattern already
  established (12 §5.2 step 9) rather than a silent rejection.

Navigation (12 §3.3):
  Inventory -> adds "Expiry Alerts" sub-item (links to §7.1's query,
               pre-filtered view)

Dashboard (12 §8):
  "Expiry Alerts" widget registers per §7.2
```

---

# 10. Migration Mapping from Legacy Pharmacy PWA (per `01`)

Per `01` §31 Migration Philosophy — no direct database migration, but this table makes the conceptual mapping explicit for the eventual data-transform script (deferred to `27_MIGRATION_SPECIFICATION.md`):

| Legacy Field/Concept (`01`) | New Location |
|---|---|
| Medicine master (`js/modules/`) | `core.items` + `industry.pharmacy_item_details` |
| Generic/Strength | `industry.pharmacy_item_details.genericName/strength` |
| Batch + Expiry | `core.stock_batches` (Core, generic) |
| `deductStockFEFO()` | `FEFOAllocationStrategy` (`09` §4.2, Core, generic) |
| Expiry alerts (Dashboard) | `GetExpiryAlertsUseCase` (§7.1, Core query) + Pharmacy widget (§7.2) |
| Prescription (mentioned, never implemented per audit) | `industry.prescriptions` (§5, net-new) |
| Supplier/representative relationship (`01` §12) | Generic `core.suppliers` + `SupplierContact` (per `02` §8) — **not** re-introduced as Pharmacy-specific, per `01` §12's own recommendation |

---

# 11. Cross-Module Orchestration Rule

```text
Pharmacy extension -> extends -> core.items (industry.pharmacy_item_details)
Pharmacy extension -> extends -> core.stock_batches (industry.pharmacy_batch_details)
Pharmacy extension -> registers a hook on -> Sales application service
                       (§6, PrescriptionRequirementPolicy)
Pharmacy extension -> reads -> core.stock_batches / core.stock_balances
                       (§7.1, Expiry Alerts query — read-only)
Pharmacy extension -> introduces -> industry.prescriptions (net-new,
                       no other module reads/writes this table)
Pharmacy extension domain layer -> has NO dependency on any Optional
                                    Module (14-18) — a pure Pharmacy
                                    retail tenant needs none of them

Dependency direction (concrete):
  industry/pharmacy → core/catalog (1:1 extension FK)
  industry/pharmacy → core/inventory (1:1 extension FK, read-only query)
  industry/pharmacy → core/sales (registered policy hook, per §6)
  core/*             → (no dependency on industry/pharmacy — Core never
                        imports or references anything in industry/*)
```

**The dependency arrow is strictly one-directional, industry → core, never the reverse** — this is the sharpest concrete test of Decision 002 (`01`) and the "No industry-specific leakage into generic Core" non-negotiable (`03` §90 point 11): if any Core module folder ever needs to `import` something from `industry/pharmacy`, that is an architecture violation, full stop.

---

# 12. Testing Obligations

```text
Item creation:                CreatePharmacyItemUseCase always forces
                               batch_tracked/expiry_tracked/stock_tracked
                               = true; ItemTrackingPolicy.resolve()
                               correctly selects FEFO for the result
Batch snapshot:                 ReceivePurchaseUseCase for a Pharmacy
                               item correctly creates the paired
                               PharmacyBatchDetails row; editing the
                               parent Item's genericName afterward
                               does NOT retroactively change the
                               snapshot (§4.1)
Prescription enforcement:        CompleteSaleUseCase rejects with
                               PrescriptionRequiredError when
                               enforcement is ON and no Prescription
                               is linked; succeeds when OFF regardless
                               of missing prescription (§5.2 soft-
                               configuration test)
Extension-point isolation:       a non-Pharmacy tenant's
                               CompleteSaleUseCase execution path
                               shows zero behavioral difference
                               (no policy hook invoked at all) —
                               this is the concrete regression test
                               for §6's "byte-for-byte identical"
                               claim
Expiry alerts:                   GetExpiryAlertsUseCase correctly
                               filters/sorts/thresholds; identical
                               query correctness test applies whether
                               or not the tenant has Pharmacy active
                               (per §7.1's industry-agnostic note)
```

---

# 13. Decisions Established by This Document

### Decision PHM-001
`06_DATABASE_SPECIFICATION.md` §7.1 is amended to add `industry.prescriptions`.

### Decision PHM-002
`Prescription` has no status state machine — unlike every Optional Module transactional entity (`14`–`18`), it is a compliance record attached to a Sale, not a workflow entity.

### Decision PHM-003
`PharmacyBatchDetails` stores `genericNameSnapshot`/`strengthSnapshot` as point-in-time copies, not live references to the parent Item — historical batch records never silently change if the Item master is later corrected.

### Decision PHM-004
`CompleteSaleUseCase` (`07` §7.6) exposes a policy-hook extension point (§6) that the Pharmacy extension registers against — Core's own code contains no Pharmacy-aware branching; the hook is a no-op for tenants without the extension active. This is the concrete architectural pattern industry extensions in general must follow when they need to influence a Core use case's validation.

### Decision PHM-005
`PrescriptionRequirementPolicy` (§5.2) is a soft, tenant-configurable check, not a hard platform invariant — prescription-enforcement rigor is a jurisdiction/tenant decision the platform does not adjudicate, consistent with the existing tax/VAT scope limitation (`03` §55).

### Decision PHM-006
Expiry Alerts (§7.1) are implemented as a Core, industry-agnostic query against `core.stock_batches.expiry_date` — Pharmacy contributes only the Dashboard widget registration and default threshold configuration, not a new query mechanism, since any expiry-tracked item (regardless of industry) already qualifies.

---

# 14. Open Extension Questions

```text
1. Should `dosageForm` be a tenant-extensible list (free text with
   autocomplete suggestions) or a fixed platform enum? Currently
   specified as "tenant-extensible" (§3) but not schema-detailed.
2. Should the Expiry Alerts widget (§7.2) self-register for ANY
   tenant with expiry-tracked items (fully industry-agnostic), or
   remain gated specifically behind the Pharmacy extension flag as
   currently specified? This affects whether a Grocery tenant with
   perishables sees the same widget without enabling "Pharmacy."
3. Doctor registry — free-text `prescribingDoctor` (§5) is MVP-
   sufficient, or does a future phase need a structured
   `industry.prescribers` entity (name, registration number,
   specialty) for regulatory reporting in stricter jurisdictions?
4. Should `requiresPrescription` support partial/quantity-limited
   rules (e.g. "up to 10 units without prescription, prescription
   required beyond that"), or is MVP's boolean-only sufficient?
5. Controlled-substance handling (a stricter sub-category beyond
   general prescription requirement, with potential regulatory
   reporting obligations) — explicitly out of scope for this
   document; confirm whether it needs its own future extension
   layer or fits within `industry.pharmacy_item_details` as an
   additional flag.
```

---

# 15. Next Document

পরবর্তী document:

`20_INDUSTRY_ELECTRONICS.md`

এখানে Electronics extension বিস্তারিত হবে — Serial/IMEI tracking (Core `serial_tracked` flag এবং `SerialAllocationStrategy`, per `09` §4.3), Warranty linkage (ইতিমধ্যে `15_MODULE_SERVICE.md` §7-এ established), এবং `industry.electronics_item_details` / `industry.electronics_repairs` (per `06` §7.2)-এর সম্পূর্ণ specification। এই document Pharmacy-এর "narrowest extension" contrast হিসেবে কাজ করবে — Electronics একই সময়ে Core, Serial tracking, এবং পুরো Service module-এর ওপর নির্ভর করে, তাই এটি Industry series-এর মধ্যে সবচেয়ে বেশি Optional Module composition দেখাবে।
