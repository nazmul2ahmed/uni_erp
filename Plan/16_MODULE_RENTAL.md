# 16_MODULE_RENTAL.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Rental Module Specification
**Version:** 1.0 Draft
**Status:** Optional Module Deep-Dive
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§26, Rental Domain)
- `06_DATABASE_SPECIFICATION.md` (§6.4, `modules.rental_assets` / `modules.rental_orders`)
- `08_ACCOUNTING_ENGINE_SPECIFICATION.md` (§5, Posting Rules — extended here for damage/rental-specific events)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§4.4, §7, Reservation Allocation & Lifecycle)
- `11_API_SPECIFICATION.md` (§18.4, Rental Endpoints)

---

# 1. Purpose

এই document Optional Module series-এর তৃতীয় — `Rental` module-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities & invariants
RentalAsset lifecycle (distinct from generic Item stock)
Reservation -> Dispatch -> Return -> Inspection flow
Damage assessment & damage charge — including the accounting posting
  rules this document must newly define (not fully specified in 08)
Use cases
Database detail (beyond the 06 stub)
API contract detail (beyond the 11 stub)
UX flow
Cross-module orchestration (Rental -> Booking, Rental -> Inventory,
  Rental -> Accounting)
```

**Module classification (per `02` §40, §53):** Optional Module. Core to Decorator/Event businesses (`02` §23) and standalone Equipment/Furniture/Camera/Tool rental businesses (`02` §2.3) alike — the framework is asset-type-agnostic.

---

# 2. Why Optional, Not Core, and Why Not Just "Inventory"

A pure retail tenant never reserves an asset for a time window — it sells stock outright. Rental introduces a concept Core Inventory deliberately does **not** own: **time-bound commitment of a specific physical unit without transferring ownership.** This is why `RESERVATION`/`RELEASE` exist as movement types in Core (`09` §2) but the *business workflow* around them — asset condition tracking, dispatch/return logistics, damage assessment — lives in this Optional Module, not in Core Inventory.

```text
Core Inventory (Stock Ledger, Allocation Strategies)
        ↑
   [RESERVATION / RELEASE movement types, 09 §2, §7]
        │
   Rental Module (this document) — asset lifecycle, damage, charges
        ↑
   [optional]
        │
   Booking Module (18_MODULE_BOOKING.md) — time-window commitment UX
```

Enabled via `tenant_features.rental = true` (`06` §4.7).

---

# 3. Domain Entity: `RentalAsset`

Extends `core.items` (an item with `tracking.rental = true`, per `07` §6.1) with a physical-unit-level record — analogous to how `StockSerial` (`06` §5.10) tracks individual serialized units, but for rentable assets specifically.

```text
RentalAsset
├── id, tenantId, itemId FK -> core.items.id
├── assetTag?                -- optional physical label/barcode,
│                               distinct from a Serial (an asset may
│                               or may not also be serial-tracked)
├── status: AVAILABLE | RESERVED | DISPATCHED | RENTED | RETURNED |
│           MAINTENANCE | RETIRED
├── condition: GOOD | FAIR | DAMAGED | UNDER_REPAIR
├── createdAt, updatedAt
```

**Relationship to `Item`:** one `Item` (e.g. "Round Banquet Table — 8ft") may have many `RentalAsset` rows (physical unit #1, #2, #3...), mirroring the `Item` : `StockSerial` cardinality already established for serial-tracked items (`06` §5.10).

## 3.1 Domain Entity: `RentalOrder`

```text
RentalOrder
├── id, tenantId, branchId
├── customerId
├── bookingId?              -- nullable link back to modules.bookings
│                              (06 §6.2) if this rental originated
│                              from a formal Booking; a rental MAY
│                              also be created ad-hoc without a prior
│                              Booking (e.g. walk-in same-day rental)
├── orderNumber
├── status: RESERVED | DISPATCHED | RETURNED | CLOSED | CANCELLED
├── lines: RentalOrderLine[]
├── dispatchAt, expectedReturnAt, actualReturnAt?
├── pricing: { subtotal, discountTotal, taxTotal, grandTotal }: Money
├── damageCharge: Money (default 0)
├── operationId
```

## 3.2 Value Object: `RentalOrderLine`

```text
RentalOrderLine
├── rentalAssetId FK          -- specific physical unit, resolved via
│                                ReservationAllocationStrategy (09 §4.4)
├── itemId (denormalized for reporting convenience)
├── rate: Money
├── periodUnit: HOUR | DAY | EVENT
├── quantity: Quantity          -- number of periodUnits, not asset count
│                                  (one line = one specific asset over
│                                  N periods)
├── lineTotal: Money (derived = rate * quantity)
```

**Invariant:** one `RentalOrderLine` maps to exactly one `RentalAsset` (unlike `SaleLine`, which can represent an aggregate quantity of a non-serialized item). This mirrors the Serial allocation strategy's "serials are inherently qty=1 units" rule (`09` §4.3).

---

# 4. Asset Status vs Order Status — Two Coupled State Machines

This is the module's central design complexity: `RentalAsset.status` (a physical-unit concept) and `RentalOrder.status` (a transaction concept) move together but are not identical, matching the lifecycle diagram already established in `02` §26 and `09` §7.2.

```text
RentalAsset.status:        AVAILABLE
                               ↓ (ReserveRentalUseCase)
                            RESERVED
                               ↓ (DispatchRentalUseCase)
                            DISPATCHED
                               ↓ (implicit — no separate movement,
                                  per 09 §7.2 "no new stock_movement")
                            RENTED           -- MVP treats DISPATCHED
                                                and RENTED as the same
                                                asset status value
                                                (06 §6.4 enum has no
                                                separate RENTED state
                                                for the asset — only
                                                the order tracks
                                                "dispatched" as a
                                                transaction fact;
                                                DISPATCHED is the
                                                asset's terminal
                                                out-of-stock state
                                                until returned)
                               ↓ (ReturnRentalUseCase + inspection)
                            RETURNED
                               ↓ (inspection result)
                            AVAILABLE  (condition = GOOD/FAIR)
                                  or
                            MAINTENANCE  (condition = DAMAGED/
                                          UNDER_REPAIR)

RentalOrder.status:         RESERVED
                               ↓ (DispatchRentalUseCase)
                            DISPATCHED
                               ↓ (ReturnRentalUseCase)
                            RETURNED
                               ↓ (CloseRentalOrderUseCase — after
                                  damage charge, if any, is settled)
                            CLOSED

Any RESERVED/DISPATCHED order -> CANCELLED (asset released back to
AVAILABLE without a completed rental — e.g. customer cancels before
dispatch)
```

**Amendment note:** `06_DATABASE_SPECIFICATION.md` §6.4's `rental_assets.status` enum (`AVAILABLE/RESERVED/DISPATCHED/RENTED/RETURNED/MAINTENANCE`) includes a `RENTED` value that this document treats as functionally synonymous with `DISPATCHED` for the asset (only the Order distinguishes the moment of physical dispatch as a business event). This is flagged as a clarification, not a schema change — Decision RNT-004, §13.

---

# 5. Use Cases

## 5.1 `ReserveRentalUseCase`

```text
Input: customerId, branchId, requestedLines[] (itemId, periodUnit,
       quantity, startAt, endAt), bookingId?, operationId

1. Idempotency check
2. For each line: AllocationStrategy.selectStockFor via the
   ReservationAllocationStrategy (09 §4.4) — checks Booking-window
   overlap against modules.rental_assets WHERE status=AVAILABLE
3. If insufficient non-overlapping assets -> InsufficientStockError
4. Post RESERVATION movement per resolved asset (09 §2, §7.3 —
   affects quantity_reserved only, never quantity_on_hand)
5. RentalAsset.status -> RESERVED for each resolved asset
6. Persist RentalOrder (status = RESERVED), generate orderNumber
7. Audit log
```

## 5.2 `DispatchRentalUseCase`

```text
Input: rentalOrderId, dispatchAt, operationId

1. Validate order status = RESERVED
2. Validate each line's RentalAsset.status = RESERVED
3. RentalAsset.status -> DISPATCHED (per §4, no new stock_movement,
   per 09 §7.2)
4. RentalOrder.status -> DISPATCHED, dispatchAt recorded
5. If any advance payment is due at dispatch -> delegate to
   RecordCustomerPaymentUseCase (07 §10.3) — NOT reimplemented here
6. Audit log
```

## 5.3 `ReturnRentalUseCase`

```text
Input: rentalOrderId, actualReturnAt, inspectionResults[]
       (per rentalAssetId: condition, damageNotes?, operationId)

1. Validate order status = DISPATCHED
2. Post RELEASE movement per asset (09 §2, §7.4 — reserved -= qty)
3. For each asset, per inspectionResults:
     condition = GOOD/FAIR -> RentalAsset.status = AVAILABLE
     condition = DAMAGED/UNDER_REPAIR -> RentalAsset.status = MAINTENANCE
4. RentalOrder.status -> RETURNED, actualReturnAt recorded
5. If actualReturnAt > expectedReturnAt -> calculate late fee
   (tenant-configurable rule, §8 open question) and add as an
   additional RentalOrderLine or a separate charge line
6. If any inspectionResults report DAMAGED -> do NOT auto-charge;
   flag order for AssessDamageUseCase (§5.4) before it can close
7. Audit log
```

## 5.4 `AssessDamageUseCase`

```text
Input: rentalOrderId, rentalAssetId, damageCharge: Money,
       damageDescription, operationId

1. Validate order status = RETURNED
2. Validate rentalAssetId's inspection recorded condition = DAMAGED
   (§5.3 step 3) — cannot assess damage on an asset that wasn't
   flagged damaged at return
3. RentalOrder.damageCharge += damageCharge
4. Persist damage assessment record (linked to the asset + order)
5. Audit log
```

## 5.5 `CloseRentalOrderUseCase`

**Cross-module orchestration point — the accounting/payment settlement step.**

```text
Input: rentalOrderId, operationId

1. Validate order status = RETURNED
2. Validate no asset remains without a recorded inspection (§5.3
   step 3 must be complete for every line)
3. Calculate finalTotal = subtotal + lateFee (if any) + damageCharge
4. If finalTotal > amount already paid at dispatch (§5.2 step 5):
     delegate to RecordCustomerPaymentUseCase (07 §10.3) for the
     balance, OR create a Receivable (07 §11.1) if not paid on the spot
5. Post accounting journal — see §6 below (NEW posting rules this
   document defines)
6. RentalOrder.status -> CLOSED
7. Audit log
```

## 5.6 `CancelRentalUseCase`

```text
Input: rentalOrderId, reason, operationId

1. Validate order status IN (RESERVED, DISPATCHED)
2. Post RELEASE movement for every still-reserved asset (09 §7.4)
3. If status was DISPATCHED (asset physically out) -> RentalAsset.status
   reverts to AVAILABLE only after a return is separately confirmed —
   cancellation of a DISPATCHED order does not fabricate a return;
   it requires the asset to actually come back first (data-integrity
   guard against "cancelling" an order to hide a lost asset)
4. RentalOrder.status -> CANCELLED
5. Audit log
```

---

# 6. Accounting Posting Rules — New (Extends `08` §5)

`08_ACCOUNTING_ENGINE_SPECIFICATION.md` did not define Rental-specific posting rules (it covers Sale/Purchase/Payment/Return/Expense/Opening only). This document supplies the missing rules, following the exact notation of `08` §4.

## 6.1 Rental Revenue Recognized (at `CloseRentalOrderUseCase`, §5.5)

```text
Dr  Cash / Bank                  amountPaidNow
Dr  Accounts Receivable          amountStillDue     (if any)
    Cr  Rental Revenue           subtotal
    Cr  Tax Payable              taxTotal            (if any)
```

**Note:** Rental Revenue (account 4200, already seeded per `08` §3.4) is used here — this document activates a Chart of Accounts entry that `08` seeded but never posted to, since Core had no rental transaction type.

## 6.2 Damage Charge Recognized (part of the same Close journal, or a separate one if damage is assessed after initial close — see §6.3)

```text
Dr  Cash / Bank  or  Accounts Receivable    damageCharge
    Cr  Other Income                         damageCharge
        (damage recovery is modeled as Other Income, 4900, not
        Rental Revenue — it is not rental usage revenue, it is
        asset-damage compensation)
```

## 6.3 Timing Edge Case — Damage Assessed After Close

```text
If AssessDamageUseCase (§5.4) runs AFTER CloseRentalOrderUseCase
already posted a journal without the damage line (e.g. damage
discovered on later inspection), a SEPARATE supplementary journal is
posted at assessment time, referenceType=RENTAL_DAMAGE_ADJUSTMENT,
rather than reopening/editing the original Close journal — this
follows the Reversal/Adjustment-over-Destructive-Edit principle
(02 §52) already established platform-wide.
```

## 6.4 Rental Asset Is Not Inventory-Valued Like Sale Stock

```text
Critical distinction from Sale/Purchase posting (08 §5.1-5.2):
Rental transactions NEVER post a COGS/Inventory-relief entry, because
a RentalAsset is not consumed/transferred — it returns to AVAILABLE
stock. Only Sale of a rental asset (a tenant selling off old rental
stock, handled as a NORMAL Sale via Core, not this module) would ever
trigger COGS/Inventory posting.
```

---

# 7. Database Detail (extends `06` §6.4)

```text
modules.rental_assets
  ... (as defined in 06 §6.4) ...
  + asset_tag              text nullable
  + condition               text (GOOD/FAIR/DAMAGED/UNDER_REPAIR)
                              default GOOD

modules.rental_orders
  ... (as defined in 06 §6.4) ...
  + branch_id                uuid FK
  + subtotal, discount_total, tax_total, grand_total  numeric(18,4)
                              -- amendment: 06 stub only had
                              damage_charge, no base pricing fields
  + operation_id

modules.rental_order_items      -- already has rate/period_unit/
                                    quantity/line_total per 06 §6.4,
                                    no amendment needed

modules.rental_damage_assessments   (NEW table)
  id, tenant_id, rental_order_id FK, rental_asset_id FK,
  damage_charge numeric(18,4), damage_description text,
  assessed_by, assessed_at, created_at
```

**Amendment flag:** Decision RNT-001 (§13) — `06_DATABASE_SPECIFICATION.md` §6.4 revised accordingly; `modules.rental_damage_assessments` added as a new table.

**Unique:** `UNIQUE(tenant_id, order_number)` on `rental_orders`, `UNIQUE(tenant_id, operation_id)`

---

# 8. API Detail (extends `11` §18.4)

```text
GET    /api/rental-assets                        [rental.view]
GET    /api/rental-assets/:id                      [rental.view]
POST   /api/rental-assets                          [rental.manage]
                                                    -> registers a new
                                                       physical unit
                                                       against an Item
PATCH  /api/rental-assets/:id                        [rental.manage]
                                                    -> condition/retire

GET    /api/rental-orders                          [rental.view]
GET    /api/rental-orders/:id                        [rental.view]
POST   /api/rental-orders                            [rental.create]
                                                    [Idempotent REQUIRED]
                                                    -> ReserveRentalUseCase (§5.1)
POST   /api/rental-orders/:id/dispatch                 [rental.create]
                                                    [Idempotent REQUIRED]
                                                    -> DispatchRentalUseCase (§5.2)
POST   /api/rental-orders/:id/return                     [rental.create]
                                                    [Idempotent REQUIRED]
                                                    -> ReturnRentalUseCase (§5.3)
POST   /api/rental-orders/:id/damage-assessment           [rental.create]
                                                    [Idempotent REQUIRED]
                                                    -> AssessDamageUseCase (§5.4)
POST   /api/rental-orders/:id/close                        [rental.create][accounting.post]
                                                    [Idempotent REQUIRED]
                                                    -> CloseRentalOrderUseCase (§5.5)
POST   /api/rental-orders/:id/cancel                        [rental.cancel]
                                                    [Idempotent REQUIRED]
                                                    -> CancelRentalUseCase (§5.6)
```

---

# 9. UX Flow

## 9.1 Availability-First Reservation

```text
New Rental Order
  Customer selection/quick-create
  ↓
  Item search -> shows AVAILABLE asset count for the selected
  date range live (search-first + clear financial feedback
  principles, 12 §2)
  ↓
  Select quantity of periods + rate auto-fills from Item default
  (overridable)
  ↓
  Save -> Reserved, specific asset(s) auto-allocated (ReservationAllocationStrategy)
```

## 9.2 Dispatch Day

```text
Rental Order detail -> [Dispatch] button
  ↓
Confirm asset tags physically leaving (checklist UI, one row per
RentalOrderLine)
  ↓
Optional advance payment capture inline
  ↓
Dispatched — printable dispatch note
```

## 9.3 Return & Inspection

```text
Rental Order detail -> [Process Return] button
  ↓
Per-asset inspection checklist:
  Condition: Good / Fair / Damaged / Under Repair (radio)
  Notes (shown only if Damaged/Under Repair — progressive disclosure,
  per 12 §7.1)
  ↓
Submit -> assets flagged DAMAGED block order close until assessed
(visual warning banner: "Damage assessment required before closing")
```

## 9.4 Damage Assessment & Close

```text
[Assess Damage] (only visible if any asset flagged DAMAGED)
  ↓
Enter charge amount + description per damaged asset
  ↓
[Close Order] — shows final total breakdown (rental + late fee +
damage), payment capture for any balance due
  ↓
Closed — receipt/summary
```

---

# 10. Cross-Module Orchestration Rule

```text
Rental module -> calls -> Inventory application service (interface,
                           ReservationAllocationStrategy + RESERVATION/
                           RELEASE movement posting)
Rental module -> calls -> Payment application service (interface)
Rental module -> calls -> Accounting application service (interface,
                           §6 new posting rules implemented as
                           AccountingPostingService.postRentalJournal /
                           postDamageChargeJournal, extending 07 §13.4's
                           method set)
Rental module -> optionally links -> Booking module (bookingId,
                           read-only reference, no hard dependency —
                           a rental can exist without a Booking)
Rental module domain layer -> has NO dependency on Inventory/Payment/
                               Accounting internals

Dependency direction (concrete):
  rental/application → inventory/application (interface)
  rental/application → payments/application (interface)
  rental/application → accounting/application (interface)
  rental/domain       → (no dependency on other domains)
```

---

# 11. Testing Obligations

```text
Reservation overlap:           two orders cannot reserve the same
                                physical RentalAsset for overlapping
                                windows (mirrors 09 §7.3 + 06 §6.2
                                exclusion constraint)
Asset/Order state coupling:    every RentalAsset status transition
                                matches the coupled RentalOrder
                                transition per §4's table — no
                                orphaned state (e.g. an asset stuck
                                RESERVED after its order is CANCELLED)
Damage gate:                   CloseRentalOrderUseCase rejects if any
                                DAMAGED asset lacks a completed
                                AssessDamageUseCase record
Accounting:                    postRentalJournal and
                                postDamageChargeJournal each produce a
                                balanced Journal (mirrors 07 §19
                                AccountingPostingService test pattern)
No COGS posting:                verify Rental Close journals never
                                touch Inventory/COGS accounts (§6.4)
Idempotency:                    replaying dispatch/return/close
                                operationId never double-posts
                                movements or journals
```

---

# 12. Decisions Established by This Document

### Decision RNT-001
`06_DATABASE_SPECIFICATION.md` §6.4 is amended: `rental_assets` gains `asset_tag`/`condition`; `rental_orders` gains `branch_id` and base pricing fields; a new table `modules.rental_damage_assessments` is added.

### Decision RNT-002
`08_ACCOUNTING_ENGINE_SPECIFICATION.md`'s posting rule catalog (§5) is extended with two new rules specific to this module: Rental Revenue recognition (§6.1) and Damage Charge recognition as Other Income, not Rental Revenue (§6.2) — both implemented via new `AccountingPostingService` methods, not ad hoc journal creation inside the Rental module.

### Decision RNT-003
Rental transactions never post COGS/Inventory-relief journal entries — a `RentalAsset` returning to `AVAILABLE` is fundamentally different from a `Sale`'s permanent stock relief, and this distinction is enforced as a test obligation (§11), not left to convention.

### Decision RNT-004
`RentalAsset.status` values `DISPATCHED` and `RENTED` (per the `06` §6.4 enum) are treated as functionally synonymous for MVP — no separate business logic distinguishes them; only the coupled `RentalOrder.status` marks the moment of dispatch as a discrete business event.

### Decision RNT-005
Cancelling a `DISPATCHED` rental order never fabricates an implicit return — the physical asset must go through `ReturnRentalUseCase` before its status can leave `DISPATCHED`, preventing cancellation from being used to silently write off a lost/unreturned asset.

---

# 13. Open Module Questions

```text
1. Late fee calculation (§5.3 step 5) — flat per-day rate, percentage
   of rental rate, or fully tenant-configurable formula? Currently
   unspecified beyond "tenant-configurable rule."
2. Should a DAMAGED asset automatically create a linked
   ServiceOrder (15_MODULE_SERVICE.md) for repair tracking, or does
   `MAINTENANCE` status stand alone until a separate manual process
   returns it to AVAILABLE?
3. Partial-order returns (customer returns 3 of 5 rented chairs on
   time, 2 late) — does ReturnRentalUseCase (§5.3) need to support
   per-line return timing, or is MVP whole-order-at-once only?
4. Should damage charges have a maximum cap tied to the asset's
   replacement/insured value (stored where — on Item or RentalAsset)?
5. Retired assets (`RETIRED` status, per 06 §6.4 enum) — full
   decommission workflow (write-off accounting entry?) needed at
   MVP, or is manual status-flip sufficient for now?
```

---

# 14. Next Document

পরবর্তী document:

`17_MODULE_PROJECT.md`

এখানে Project module (Budget, Resources, Materials, Labour, Milestones, Profitability — per `02` §28, `06` §6.5) বিস্তারিত হবে, বিশেষভাবে এই document-এর damage-charge posting pattern-এর মতো Project cost category (`MATERIAL/LABOUR/RENTAL/TRANSPORT/SUBCONTRACT/OTHER`, per `06` §6.5)-এর প্রতিটির accounting posting rule সংজ্ঞায়িত করে, এবং Rental module-এর সঙ্গে integration (একটি Decorator project যখন rental assets ব্যবহার করে) কীভাবে কাজ করবে তা নির্ধারণ করে।
