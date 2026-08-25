# 20_INDUSTRY_ELECTRONICS.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Electronics Industry Extension Specification
**Version:** 1.0 Draft
**Status:** Industry Extension Deep-Dive
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§30, Electronics Domain)
- `06_DATABASE_SPECIFICATION.md` (§7.2, `industry.electronics_item_details` / `industry.electronics_repairs`)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§6.1–6.2, Item tracking flags, `ItemTrackingPolicy`)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§4.3, Serial allocation)
- `15_MODULE_SERVICE.md` (entire document — Electronics' primary consuming module)
- `19_INDUSTRY_PHARMACY.md` (§2, §6, §11 — pattern this document reuses)

---

# 1. Purpose

এই document Industry Extension series-এর দ্বিতীয় — `Electronics` extension-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities specific to Electronics (beyond Core Item/Serial)
Warranty issuance mechanics (concrete, building on 15 §7's linkage
  description)
Repair record detail (industry.electronics_repairs)
Serial/IMEI capture at Sale and Purchase time
Database detail (beyond the 06 §7.2 stub)
UX additions (Item form tab, POS serial capture, per 12 §3.3)
Cross-cutting rule: why Electronics is the WIDEST extension in this
  series (contrast to Pharmacy, 19 §1)
```

**Extension classification (per `02` §40, §53):** Industry Extension — but unlike Pharmacy (`19`, which needs zero Optional Modules), a full Electronics + Service retail tenant composes Core **plus** the Service Module (`15`) **plus**, optionally, Warranty tracking. This is deliberately the platform's **first commercial validation target** (`03` §87 — "Electronics + Service" candidate vertical), so this document is written with that production-readiness bar in mind.

```text
Retail (Core)
  +
Inventory (Core) with serial_tracked=true
  +
Serial Allocation Strategy (Core, 09 §4.3)
  +
Service Module (15) — repair workflow
  +
Warranty (modules.warranties, 06 §6.6 — technically an Optional
  Module table, but Electronics is its primary consumer)
  +
A handful of descriptive fields (model, specification, default
  warranty months)
  +
One extension-specific record: Repair detail (industry.electronics_
  repairs) — a thin annotation on top of Service's ServiceOrder,
  NOT a parallel repair-tracking entity
```

---

# 2. What "Electronics" Actually Adds

Per `06` §7.2's existing stub and `02` §30, this extension's job is narrower than it might first appear — most of the actual capability (serial tracking, repair workflow) already exists in Core and the Service Module. Electronics supplies:

```text
1. industry.electronics_item_details  — descriptive fields on core.items
2. industry.electronics_repairs        — a 1:1 annotation on
                                          modules.service_orders,
                                          storing Electronics-specific
                                          repair vocabulary (IMEI/
                                          fault category) without
                                          polluting Service's generic
                                          ServiceOrderLine model
3. CreateElectronicsItemUseCase        — the equivalent of Pharmacy's
                                          item-creation wrapper (19
                                          §3), forcing serial_tracked
                                          = true and wiring a default
                                          warranty period
4. Warranty issuance automation at Sale-completion time (§5)
```

**Restated non-negotiable (per `01` §55, `04` §133, `19` §11's one-directional dependency rule):** Core's `sales/`, `inventory/`, and `07`'s use cases contain zero Electronics-aware branching. Where Electronics needs to influence a Core flow, it registers against an already-defined extension point (mirrors `19` §6's `CompleteSaleUseCase` hook pattern) rather than Core special-casing it.

---

# 3. Domain Entity: `industry.electronics_item_details` (extends `core.items`)

Already stubbed in `06` §7.2; this document finalizes the field set.

```text
ElectronicsItemDetails
├── id, tenantId, itemId FK -> core.items.id UNIQUE
├── model
├── specification: jsonb        -- free-form key/value spec sheet
│                                  (e.g. {"RAM": "8GB", "Storage":
│                                  "128GB"}) — deliberately schemaless
│                                  since spec fields vary wildly by
│                                  product category (phone vs TV vs
│                                  appliance) and a fixed column set
│                                  would force frequent schema
│                                  amendments (§9 open question notes
│                                  the tradeoff)
├── defaultWarrantyMonths: integer nullable
├── createdAt
```

**Auto-configuration rule (mirrors `19` §3's `CreatePharmacyItemUseCase` pattern exactly):**

```text
CreateElectronicsItemUseCase (thin wrapper over Core's CreateItem,
07 §6.3):
  1. Delegate to CreateItem(coreItemInput) with tracking flags forced:
       tracking.serial = true
       tracking.stock = true      -- implied per 07 §6.1 invariant
                                     ("serial_tracked=true implies
                                     stock_tracked=true")
       tracking.warranty = true   (if defaultWarrantyMonths provided)
  2. On success, persist ElectronicsItemDetails row linked to the
     new itemId
  3. Both writes occur in one transaction (identical shape to 19 §3
     step 3)
```

This guarantees `ItemTrackingPolicy.resolve()` (`07` §6.2) selects `SerialAllocationStrategy` (`09` §4.3) for every Electronics item — same mechanism as Pharmacy's FEFO guarantee (`19` §3), applied to a different tracking flag.

---

# 4. Serial/IMEI Capture — At Purchase and At Sale

Core already defines `core.stock_serials` (`06` §5.10) and `SerialAllocationStrategy` (`09` §4.3: *"Requires explicit serial selection by the user/UI — no auto-pick"*). This extension adds no new table for serial storage itself — Electronics simply **is** the primary tenant type that exercises this already-generic Core capability at full depth.

## 4.1 At Purchase (`ReceivePurchaseUseCase`, `07` §8.3)

```text
When an Electronics item (serial_tracked=true) is received:
  For each unit, staff enters/scans the serial/IMEI ->
  core.stock_serials row created, status = IN_STOCK,
  purchase_item_id linked (per 06 §5.10 schema, unmodified by this
  extension — no amendment needed here, unlike Pharmacy's batch
  snapshot table)

No industry.* table involvement at this step — serial capture is
already fully generic in Core.
```

## 4.2 At Sale (`CompleteSaleUseCase`, `07` §7.6)

```text
Per 07 §7.3 invariant 7: "If item.tracking.serial, each unit must
resolve to a distinct StockSerial." SerialAllocationStrategy (09
§4.3) requires the UI to present an explicit picker — POS screen
(12 §5.2) already specifies this: "if item.tracking.serial: prompt
explicit serial picker."

On sale completion: core.stock_serials.status -> SOLD,
sale_item_id linked (per 06 §5.10 schema).

Again, no industry.* involvement — this is Core behavior that
Electronics items simply trigger by virtue of their tracking flags.
```

**This section exists primarily to make explicit what this extension does NOT need to build** — a common failure mode in industry-extension design is duplicating Core capability under industry-specific names (the exact anti-pattern `01` §55 warns against). Serial/IMEI handling is Core; Electronics only configures items to use it.

---

# 5. Warranty Issuance

Per `06` §6.6 (`modules.warranties`, an Optional Module table) and `15` §7 (which described the *linkage* from a ServiceOrder's perspective but deferred creation-trigger detail — "flagged for a dedicated treatment," `15` §14 Q3). This document supplies that creation-trigger detail, scoped to Electronics as its primary consumer.

## 5.1 `IssueWarrantyUseCase`

```text
Input: saleItemId (or serialId), termsMonths, operationId

1. Idempotency check
2. Validate the referenced SaleItem/Serial belongs to tenant and to
   a COMPLETED Sale (07 §7.3 — cannot issue a warranty against a
   DRAFT or CANCELLED sale)
3. Persist modules.warranties row:
     item_id, sale_item_id, serial_id (if serial-tracked item),
     starts_at = sale.saleDate, ends_at = saleDate + termsMonths,
     status = ACTIVE
4. Audit log
```

## 5.2 Automatic Trigger at Sale Completion (extension-point pattern, mirrors `19` §6)

```text
CompleteSaleUseCase (07 §7.6), after step 12 (update Sale.status),
gains an optional post-completion hook:

  12.5. If tenant has Electronics extension active:
          For each completed SaleLine where
          item.electronicsDetails.defaultWarrantyMonths IS NOT NULL:
            delegate to IssueWarrantyUseCase (§5.1) with
            termsMonths = item.electronicsDetails.defaultWarrantyMonths

This hook is a no-op for tenants without the Electronics extension
active, identical in shape to Pharmacy's PrescriptionRequirementPolicy
hook (19 §6) — registered BY the extension against a Core-exposed
extension point, never written INTO Core's sales/domain code.

Difference from Pharmacy's hook: this one runs AFTER successful
completion (a side-effect of a successful Sale) rather than BEFORE
completion as a gating validation (19 §6's hook can fail the sale;
this one cannot — a missing/failed warranty issuance is logged as a
non-fatal warning, never rolls back an otherwise-valid completed
Sale, since warranty issuance is a convenience automation, not a
financial integrity concern).
```

**Manual override:** staff may also call `IssueWarrantyUseCase` (§5.1) directly for a warranty not tied to `defaultWarrantyMonths` (e.g. an extended warranty sold as a separate line item) — the automatic hook is a convenience default, not the only path.

---

# 6. Domain Entity: `industry.electronics_repairs` (1:1 extension of `modules.service_orders`)

Already stubbed in `06` §7.2; finalized here against the now-complete Service module (`15`).

```text
ElectronicsRepairDetails
├── id, tenantId, serviceOrderId FK -> modules.service_orders.id UNIQUE
├── imeiOrSerial               -- may duplicate a core.stock_serials
│                                  value if the device was originally
│                                  sold by this tenant (traceable via
│                                  §5.1's serial_id), OR be a
│                                  customer-brought device never sold
│                                  by this tenant (free text in that
│                                  case — no FK constraint, since Core
│                                  has no record of a device it never
│                                  sold)
├── faultCategory                -- tenant-extensible free text/
│                                    picklist (e.g. "Screen", "Battery",
│                                    "Water Damage", "Software")
├── repairNotes
├── createdAt
```

**Design note — why this is NOT a duplicate of `ServiceOrder`:** `15` §3's `ServiceOrder.assetReference` field is already generic free text ("device model/asset tag/license plate/whatever the tenant services"). `ElectronicsRepairDetails` does not replace that field — it is an **additional**, optional 1:1 annotation for Electronics tenants who want structured `faultCategory` reporting (e.g. "which fault category generates the most repeat repairs this quarter") that free-text `assetReference`/`problemDescription` cannot support as a groupable dimension.

## 6.1 Use Case: `AttachElectronicsRepairDetailsUseCase`

```text
Input: serviceOrderId, imeiOrSerial?, faultCategory?, repairNotes?

1. Validate serviceOrderId belongs to tenant
2. Upsert ElectronicsRepairDetails (create or update — unlike
   Prescription (19 §5), this is a mutable annotation, not a
   compliance-audit record, since it's purely descriptive/reporting
   metadata with no regulatory weight)
3. Audit log NOT required (non-financial, non-compliance descriptive
   data — contrast with 19 §5's Prescription which is audited)
```

**Called from:** the Service module's existing `RecordDiagnosisUseCase` (`15` §5.3) UI flow — front-desk/technician optionally fills Electronics-specific fields inline on the same Diagnosis screen (`15` §10.2), rather than a separate screen, per progressive disclosure (`03` §49.4).

---

# 7. Database Detail (finalizes `06` §7.2)

```text
industry.electronics_item_details
  ... (as defined in 06 §7.2) ...
  -- no amendment needed; fields already match §3 above

industry.electronics_repairs
  ... (as defined in 06 §7.2) ...
  -- no amendment needed; fields already match §6 above
```

**No schema amendments required for this extension** — unlike Pharmacy (`19` §8, which needed a net-new `industry.prescriptions` table), Electronics' two stub tables from `06` §7.2 were already sufficient. This is itself a notable contrast: Electronics is the "wider" extension in terms of Core/Module composition (§1) but the "narrower" one in terms of net-new schema, because its heavy lifting (serial tracking, repair workflow) was already built generically into Core and the Service module.

**Tenant setting addition (mirrors `19` §8 pattern):** `tenant.settings.electronics.autoIssueWarranty` (boolean, default true) controls whether §5.2's automatic hook fires at all — a tenant preferring fully manual warranty issuance can disable it without losing `IssueWarrantyUseCase` (§5.1) as a manual action.

---

# 8. UX Additions (extends `12` §3.3)

Per `12` §3.3, already anticipated:

```text
Item form -> "Electronics Details" tab (shown only when Electronics
             extension active):
  Model, Specification (dynamic key/value editor for the jsonb field,
  §3), Default Warranty (months)

Purchase screen (12 §6.3) -> Serial capture UI already generic per
  Core's item.tracking.serial rule — no Electronics-specific branching;
  a barcode/IMEI scanner input (mobile camera, per 12 §13 Q3's open
  question extended here) is a natural fit but not MVP-mandated.

POS screen (12 §5.2) -> serial picker already generic per Core rule
  (§4.2) — Electronics triggers it via tracking flags, no UI-layer
  Electronics-specific code.

Service module's Diagnosis screen (15 §10.2) -> gains two optional
  inline fields when Electronics extension active: Fault Category
  (picklist), IMEI/Serial (text, pre-fillable if the device's serial
  is resolvable from a prior Sale by this tenant) -> persisted via
  §6.1's AttachElectronicsRepairDetailsUseCase alongside the existing
  diagnosis submission, not a separate save action.

Sales History / Item detail -> "Warranty" badge shown on completed
  sale lines where a Warranty record exists (§5), linking to warranty
  status/expiry — read-only surface over modules.warranties, no new
  UI concept beyond what 06 §6.6 already implies.

Navigation (12 §3.3): no new top-level or sub-item beyond what
  Service (15) and the Item form tab above already provide — this is
  itself notable: Electronics adds screens to EXISTING module UIs
  rather than introducing new navigation sections, reinforcing that
  it is fundamentally a configuration/composition extension, not a
  new workflow.
```

---

# 9. Cross-Module Orchestration Rule

```text
Electronics extension -> extends -> core.items (industry.electronics_
                          item_details)
Electronics extension -> extends -> modules.service_orders
                          (industry.electronics_repairs, 1:1, only
                          meaningful if Service module is also enabled
                          — see §9.1 dependency note)
Electronics extension -> registers a hook on -> Sales application
                          service (§5.2, warranty auto-issuance)
Electronics extension -> calls -> Warranty application service
                          (interface, IssueWarrantyUseCase §5.1)
Electronics extension domain layer -> has NO dependency on Core's
                                       sales/inventory internals beyond
                                       the registered hook interface

Dependency direction (concrete):
  industry/electronics → core/catalog (1:1 extension FK)
  industry/electronics → core/sales (registered hook, per §5.2)
  industry/electronics → warranty/application (interface, §5.1)
  industry/electronics → service/application (interface, only active
                          if tenant_features.service = true — see §9.1)
  core/*                → (no dependency on industry/electronics)
  service/*              → (no dependency on industry/electronics —
                            modules.service_orders is extended FROM
                            outside, per Decision DB-003, 06 §13;
                            Service's own code never imports anything
                            Electronics-specific)
```

## 9.1 Soft Dependency on the Service Module

```text
Unlike Pharmacy (19), which needs zero Optional Modules, Electronics'
industry.electronics_repairs table has a foreign key to
modules.service_orders.id — meaningless if tenant_features.service
= false.

Resolution: ElectronicsRepairDetails simply goes unused (never
created) for an Electronics tenant who has NOT enabled the Service
module (e.g. a pure electronics retail counter with no in-house
repair capability) — this is not an error state, just an unused
optional annotation. The extension itself does not force Service to
be enabled; it only becomes relevant once Service is.

This is flagged explicitly because it is the first case in this
series where an Industry Extension has a soft (optional, not
enforced) dependency on an Optional Module rather than purely on
Core — worth distinguishing from a hard dependency, which would
violate the "never a hard dependency" principle already established
for Quotation->Sales (14 §2) and similar.
```

---

# 10. Testing Obligations

```text
Item creation:                  CreateElectronicsItemUseCase always
                                forces serial_tracked=true;
                                ItemTrackingPolicy.resolve() correctly
                                selects SerialAllocationStrategy
Serial capture round-trip:       a serial captured at Purchase
                                correctly resolves as SOLD at Sale
                                completion, with no industry.*
                                table involvement (§4 regression test
                                — confirms no duplicate serial
                                tracking was introduced)
Warranty auto-issuance:          completing a Sale for an item with
                                defaultWarrantyMonths set produces
                                exactly one Warranty record with
                                correct start/end dates; a failed
                                warranty-issuance does NOT roll back
                                the Sale (§5.2's non-fatal contract)
Warranty manual issuance:        IssueWarrantyUseCase succeeds
                                independent of the automatic hook
Repair details optionality:      ServiceOrder diagnosis flow succeeds
                                identically whether or not
                                ElectronicsRepairDetails is attached
                                — this field is never required
Extension-point isolation:       a non-Electronics tenant's
                                CompleteSaleUseCase shows zero
                                behavioral difference (mirrors 19
                                §12's identical regression pattern)
Soft Service dependency:         an Electronics tenant WITHOUT Service
                                enabled never encounters
                                industry.electronics_repairs in any
                                code path (no orphaned/dangling
                                reference, no error)
```

---

# 11. Decisions Established by This Document

### Decision ELC-001
No schema amendment is required against `06_DATABASE_SPECIFICATION.md` §7.2 — the existing stub tables (`industry.electronics_item_details`, `industry.electronics_repairs`) are sufficient as originally defined.

### Decision ELC-002
Serial/IMEI capture at both Purchase and Sale is entirely Core behavior (`core.stock_serials`, `SerialAllocationStrategy`) — this extension introduces no parallel serial-tracking mechanism; it only guarantees Electronics items carry `serial_tracked = true`.

### Decision ELC-003
Warranty issuance has both an automatic path (a non-fatal, post-completion hook on `CompleteSaleUseCase`, tenant-toggleable via `autoIssueWarranty`) and a manual path (`IssueWarrantyUseCase` called directly) — the automatic hook's failure never rolls back an otherwise-valid completed Sale, distinguishing it from Pharmacy's pre-completion gating hook (`19` §6), which can.

### Decision ELC-004
`industry.electronics_repairs` is an optional 1:1 annotation on `modules.service_orders`, not a replacement for `ServiceOrder.assetReference`/`problemDescription` — it exists purely to add a structured, reportable `faultCategory` dimension.

### Decision ELC-005
This extension has a soft (not hard) dependency on the Service module — `industry.electronics_repairs` simply goes unused for Electronics tenants who have not enabled Service, with no error state or enforced coupling.

---

# 12. Open Extension Questions

```text
1. Should `specification` (§3, jsonb free-form) have a
   tenant-configurable schema/template (e.g. a tenant defines "RAM,
   Storage, Color" as expected keys for a "Phone" category), or
   remain fully freeform indefinitely?
2. Barcode/IMEI camera scanning (mentioned in §8 as "not MVP-
   mandated") — same open question already flagged in `12` §13 Q3
   for POS generally; confirm Electronics doesn't need it sooner
   given IMEI entry is more error-prone via manual typing than a
   generic barcode.
3. Should `faultCategory` (§6) be a fixed platform picklist,
   tenant-configurable list, or freeform — mirrors the identical
   open question already flagged for Pharmacy's `dosageForm`
   (`19` §14 Q1); likely the same platform-wide answer applies to
   both.
4. Multi-serial warranty bundling (a single Sale of multiple serial
   units where the customer wants ONE combined warranty record
   rather than one per unit) — is per-unit (§5.1's current shape)
   always correct, or does a bundled case need explicit support?
5. Should a `RETURNED`/`REPLACED` warranty claim automatically adjust
   `core.stock_serials.status` (e.g. a warranty replacement swaps
   the serial on file) — this touches Core's serial state and would
   need its own extension-point design if built, currently out of
   scope for this document.
```

---

# 13. Next Document

পরবর্তী document:

`21_INDUSTRY_DECORATOR.md`

এখানে Decorator/Event extension বিস্তারিত হবে — Industry series-এর শেষ document, এবং এই পর্যন্ত তৈরি সবচেয়ে বেশি composition দেখাবে: Quotation + Booking + Project + Rental + Inventory + Accounting একসঙ্গে (per `02` §29)। Pharmacy (narrowest, zero Optional Modules) এবং Electronics (soft dependency on one Optional Module, §9.1) থেকে বিপরীতে, Decorator একাধিক Optional Module-এর ওপর hard-নির্ভরশীল একটি composition pattern প্রদর্শন করবে — `industry.decorator_events` / `industry.decorator_labour` (per `06` §7.3)-এর সম্পূর্ণ specification সহ।
