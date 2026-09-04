# 15_MODULE_SERVICE.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Service Module Specification
**Version:** 1.0 Draft
**Status:** Optional Module Deep-Dive
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§27, Service Domain)
- `06_DATABASE_SPECIFICATION.md` (§6.3, `modules.service_orders`)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§7–9, Sales/Inventory Domain — invoice/parts conversion targets)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§4, Allocation — parts consumption)
- `11_API_SPECIFICATION.md` (§18.3, Service Order Endpoints)
- `14_MODULE_QUOTATION.md` (§5.5, orchestration pattern this module reuses)

---

# 1. Purpose

এই document Optional Module series-এর দ্বিতীয় — `Service` module-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities & invariants
Status state machine (diagnosis -> repair -> completion)
Parts & Labour cost model
Use cases (intake, diagnose, quote, work, complete, invoice)
Warranty linkage
Database detail (beyond the 06 stub)
API contract detail (beyond the 11 stub)
UX flow (technician-facing + front-desk-facing)
Cross-module orchestration (Service -> Sale, Service -> Warranty)
```

**Module classification (per `02` §40, §53):** Optional Module. Applies equally to Electronics repair, AC/Electrical service, appliance service, and any "customer brings an asset/device, staff diagnoses and repairs it" workflow (`02` §27) — the framework is asset-agnostic, not Electronics-specific.

---

# 2. Why Optional, Not Core

A pure retail tenant (e.g. a stationery shop) never creates a Service Order. A Service tenant (`02` §2.2) may run with `sales` largely as a pass-through for the final invoice, while `service` carries the operational workflow. Enabled via `tenant_features.service = true` (`06` §4.7).

```text
Sales Domain (Core, always present)
        ↑
   [invoice step, at completion]
        │
   Service Order (this module)
        ↑
   [optional parts consumption]
        │
   Inventory Domain (Core)
```

---

# 3. Domain Entity: `ServiceOrder`

```text
ServiceOrder
├── id, tenantId, branchId
├── customerId
├── orderNumber                -- server-generated, tenant-scoped sequence
├── assetReference?             -- free text: device model/asset tag/
│                                  license plate/whatever the tenant
│                                  services — deliberately generic
│                                  (per Decision 002, 01)
├── problemDescription
├── diagnosis?
├── technicianUserId?
├── status: RECEIVED | DIAGNOSING | QUOTED | AWAITING_APPROVAL |
│           IN_PROGRESS | COMPLETED | CANCELLED | UNCLAIMED
├── lines: ServiceOrderLine[]
├── pricing: { subtotal, discountTotal, taxTotal, grandTotal }: Money
├── warrantyReferenceId?         -- if repair is warranty-covered
│                                   (per modules.warranties, 06 §6.6)
├── invoiceSaleId?                -- set only when converted to a Sale
├── receivedAt, promisedAt?, completedAt?
├── createdAt, updatedAt, operationId
```

## 3.1 Value Object: `ServiceOrderLine`

```text
ServiceOrderLine
├── type: PART | LABOUR
├── itemId?          -- required for PART (resolves to core.items,
│                        typically type=CONSUMABLE or PRODUCT with
│                        stock_tracked=true), null for LABOUR
├── description       -- required for LABOUR (e.g. "Diagnostic fee",
│                        "Screen replacement labour")
├── quantity: Quantity
├── unitPrice: Money
├── lineTotal: Money (derived)
```

**Design note:** `PART` lines are the bridge to Inventory — a PART line, once the order reaches `IN_PROGRESS`, triggers a `CONSUMPTION` stock movement (per `09` §2, movement type table). `LABOUR` lines never touch inventory; they exist purely for pricing/invoicing.

---

# 4. Status State Machine

```text
RECEIVED
  ↓ (assign technician)
DIAGNOSING
  ↓ (diagnosis complete, cost estimated)
QUOTED
  ↓ (customer approval — may be implicit for small repairs,
     explicit for costly ones per tenant configuration)
AWAITING_APPROVAL          -- optional intermediate state, only
  ↓                            entered if tenant requires explicit
IN_PROGRESS                    customer sign-off before work begins
  ↓ (parts consumed, labour recorded)
COMPLETED
  ↓ (InvoiceServiceOrderUseCase)
[invoiceSaleId set — order remains COMPLETED, not a separate state]

Any of RECEIVED/DIAGNOSING/QUOTED/AWAITING_APPROVAL/IN_PROGRESS
  -> CANCELLED (customer withdraws, or unrepairable)

COMPLETED (device not picked up after N days, tenant-configurable)
  -> UNCLAIMED (informational status, does not block invoicing —
     invoicing may have already happened at COMPLETED)
```

**Invariants:**
```text
1. PART lines can only post CONSUMPTION stock movements once, at the
   IN_PROGRESS -> COMPLETED transition (or explicitly during
   IN_PROGRESS if tenant allows incremental parts posting) — never
   re-posted on re-save.
2. Once COMPLETED, lines are immutable — corrections happen via a
   new ServiceOrder or a Return-equivalent adjustment, mirroring the
   Sale invariant (07 §7.3 inv. 5).
3. CANCELLED orders that already consumed parts (via CONSUMPTION
   movement) require a compensating movement (mirrors CancelSaleUseCase
   pattern, 07 §7.7) — cancellation is never silent when inventory
   was already affected.
4. status transitions are one-directional except the explicit
   CANCELLED path, same shape as Sale (07 §7.3 inv. 4).
```

---

# 5. Use Cases

## 5.1 `CreateServiceOrderUseCase` (Intake)

```text
Input: customerId, branchId, assetReference?, problemDescription,
       operationId

1. Idempotency check
2. Validate customer belongs to tenant
3. Persist ServiceOrder (status = RECEIVED), generate orderNumber
4. Audit log
```

## 5.2 `AssignTechnicianUseCase`

```text
Input: serviceOrderId, technicianUserId

1. Validate technicianUserId is a member of tenant with an
   appropriate role/permission (service.technician-capable — per
   02 §43 feature flag pattern, e.g. `service.technician`)
2. status: RECEIVED -> DIAGNOSING (if not already past this point)
3. Audit log
```

## 5.3 `RecordDiagnosisUseCase`

```text
Input: serviceOrderId, diagnosis, proposedLines[] (parts+labour estimate)

1. Validate status = DIAGNOSING
2. Persist diagnosis text
3. Persist proposed lines as the QUOTED estimate (pricing calculated
   via the same SalePricingService math, 07 §7.4 — reused, not
   reimplemented, mirroring Decision from 14 §5.1)
4. status -> QUOTED
5. If tenant setting `service.requireApproval` = true -> status ->
   AWAITING_APPROVAL instead, and a customer-facing approval
   notification is dispatched (mirrors 14 §5.2's public-link pattern
   — a Service Order may reuse the same unguessable-token approval
   mechanism as Quotation, rather than inventing a parallel one)
6. Audit log
```

## 5.4 `ApproveServiceQuoteUseCase`

```text
Input: serviceOrderId (via approval token or authenticated staff
       recording verbal approval)

1. Validate status = AWAITING_APPROVAL
2. status -> IN_PROGRESS
3. Audit log
```

## 5.5 `RecordPartsUsedUseCase` / `RecordLabourUseCase`

```text
Input: serviceOrderId, lines[] (PART or LABOUR)

1. Validate status = IN_PROGRESS
2. For PART lines:
     a. AllocationStrategy.selectStockFor(itemId, warehouseId, qty)
        (09 §4 — same allocation engine Sales uses)
     b. Post CONSUMPTION movement (09 §2 movement table),
        referenceType=SERVICE_ORDER, referenceId=serviceOrderId
     c. If insufficient stock -> Result.fail(InsufficientStockError),
        same as Sales (07 §7.5)
3. For LABOUR lines: append to lines[], no inventory effect
4. Recalculate pricing
5. Audit log (inventory-adjacent action, per 07 §15.2 pattern)
```

## 5.6 `CompleteServiceOrderUseCase`

```text
Input: serviceOrderId, operationId

1. Validate status = IN_PROGRESS
2. Finalize pricing
3. status -> COMPLETED, completedAt = now
4. If warrantyReferenceId is set on completion (new repair covered
   under an existing Warranty, 06 §6.6) -> validate warranty is
   ACTIVE and not VOID
5. Audit log
```

## 5.7 `InvoiceServiceOrderUseCase`

**This is the canonical cross-module orchestration example for this document — mirrors `ConvertQuotationUseCase` (`14` §5.5).**

```text
Input: serviceOrderId, operationId

1. Validate status = COMPLETED
2. Validate invoiceSaleId is not already set (prevents double-invoicing)
3. Delegate to CreateSaleDraftUseCase (07 §7.8) pre-populated from
   ServiceOrderLine[] (PART lines carry their already-consumed batch/
   serial reference so the Sale does NOT re-deduct stock — see §9
   below for the critical non-double-deduction rule)
4. Staff reviews/completes via CompleteSaleUseCase (07 §7.6)
5. Set serviceOrder.invoiceSaleId
6. Audit log
```

## 5.8 `CancelServiceOrderUseCase`

```text
Input: serviceOrderId, reason, operationId

1. Validate status != CANCELLED, != COMPLETED-with-invoice
2. If any PART lines already posted CONSUMPTION movements ->
   post compensating movements (mirrors 07 §7.7 pattern, reversing
   the consumption back to on-hand — or to a designated "scrapped
   parts" adjustment if the part was damaged/used, tenant-configurable)
3. status -> CANCELLED, cancelledAt, cancelledReason
4. Audit log
```

---

# 6. The Non-Double-Deduction Rule (Critical Integration Detail)

**This is the single most important integrity rule in this module — flagged prominently because Service is the one module where Inventory (Core) and Sales (Core) both touch the same physical stock through two different entry points.**

```text
Problem: Parts are deducted via CONSUMPTION at §5.5 (during repair).
If InvoiceServiceOrderUseCase (§5.7) naively created a Sale with the
same PART lines, CompleteSaleUseCase would ALSO post a SALE movement
for the same items — double-deducting stock that was already consumed.

Resolution:
  When CreateSaleDraftUseCase is invoked from §5.7, PART lines are
  marked with a flag: `inventoryAlreadyDeducted = true`
  (referencing the original CONSUMPTION movement's operationId).

  CompleteSaleUseCase (07 §7.6), when it encounters a SaleLine with
  this flag set, SKIPS step 7 (post stock movements) for that specific
  line — it still posts the Sale/Payment/Receivable/Accounting effects
  normally, just not a second inventory movement.

  This is a documented, narrow extension to CompleteSaleUseCase's
  contract (07 §7.6) — not a parallel code path, per Decision DOM-002
  (07 §20). The flag only ever originates from this module's
  orchestration, never from a client-supplied field on a normal POS sale.
```

This rule is flagged as **Decision SRV-003** (§13) and as an amendment requirement against `07_CORE_DOMAIN_SPECIFICATION.md` §7.6.

---

# 7. Warranty Linkage

Per `06` §6.6 (`modules.warranties`):

```text
A completed Sale (via §5.7 invoicing, or a prior direct Sale) may
spawn a Warranty record:
  CreateWarrantyUseCase(saleItemId/serialId, termsMonths) ->
    modules.warranties row, status = ACTIVE

A subsequent ServiceOrder may reference an existing warranty
(serviceOrder.warrantyReferenceId) — when present:
  - RecordDiagnosisUseCase (§5.3) proposed lines are typically
    zero-cost for covered parts/labour (tenant pricing rule, not a
    hard invariant — some tenants charge labour even under parts
    warranty)
  - CompleteServiceOrderUseCase (§5.6) validates the warranty is
    still ACTIVE (not EXPIRED/CLAIMED/VOID)
  - On completion, warranty.status may transition to CLAIMED
    (tenant-configurable: single-claim vs multi-claim warranties)
```

Full Warranty domain detail (creation triggers, expiry jobs, claim history) is out of scope for this document — flagged for a dedicated treatment if warranty complexity grows beyond this linkage description (§14 Q3).

---

# 8. Database Detail (extends `06` §6.3)

```text
modules.service_orders
  ... (as defined in 06 §6.3) ...
  + branch_id              uuid FK
  + subtotal, discount_total, tax_total, grand_total  numeric(18,4)
                                                        -- amendment:
                                                        06 stub had no
                                                        pricing fields
  + promised_at              timestamptz nullable
  + completed_at              timestamptz nullable
  + cancelled_at               timestamptz nullable
  + cancelled_reason            text nullable
  + operation_id

modules.service_order_items
  ... (as defined in 06 §6.3) ...
  + inventory_already_deducted  boolean default false  -- §6 flag
  + consumption_movement_id     uuid FK -> core.stock_movements.id
                                  nullable -- traceability link
```

**Amendment flag:** `06_DATABASE_SPECIFICATION.md` §6.3 revised per Decision SRV-001 (§13).

**Unique:** `UNIQUE(tenant_id, order_number)`, `UNIQUE(tenant_id, operation_id)`

---

# 9. API Detail (extends `11` §18.3)

```text
GET    /api/service-orders                        [service.view]
GET    /api/service-orders/:id                      [service.view]
POST   /api/service-orders                          [service.create]
                                                     [Idempotent, optional]
                                                     -> CreateServiceOrderUseCase (§5.1)
PATCH  /api/service-orders/:id                        [service.create]
                                                     -> general field updates
                                                        (problemDescription, etc.)
POST   /api/service-orders/:id/assign                  [service.create]
                                                     -> AssignTechnicianUseCase (§5.2)
POST   /api/service-orders/:id/diagnose                 [service.create]
                                                     -> RecordDiagnosisUseCase (§5.3)
POST   /api/service-orders/:id/approve                   [service.create]
                                                     -> ApproveServiceQuoteUseCase (§5.4)
POST   /api/service-orders/:id/parts                      [service.create][inventory.view]
                                                     [Idempotent REQUIRED]
                                                     -> RecordPartsUsedUseCase (§5.5)
POST   /api/service-orders/:id/labour                      [service.create]
                                                     -> RecordLabourUseCase (§5.5)
POST   /api/service-orders/:id/complete                     [service.create]
                                                     [Idempotent REQUIRED]
                                                     -> CompleteServiceOrderUseCase (§5.6)
POST   /api/service-orders/:id/invoice                       [service.create][sales.create]
                                                     [Idempotent REQUIRED]
                                                     -> InvoiceServiceOrderUseCase (§5.7)
POST   /api/service-orders/:id/cancel                         [service.cancel]
                                                     [Idempotent REQUIRED]
                                                     -> CancelServiceOrderUseCase (§5.8)

Public (token-authenticated, reuses 14 §5.4 pattern):
GET    /api/public/service-orders/:approvalToken       -> read-only quote view
POST   /api/public/service-orders/:approvalToken/approve  -> ApproveServiceQuoteUseCase
```

---

# 10. UX Flow

## 10.1 Front-Desk Intake

```text
New Service Order
  Customer selection/quick-create
  ↓
  Asset reference (free text) + Problem description
  ↓
  Save -> status RECEIVED, printable intake receipt/tag
```

## 10.2 Technician View (may be a simplified/mobile-optimized screen)

```text
My Assigned Orders (filtered to technicianUserId = current user)
  ↓
  Select order -> Diagnosis screen
    - free text diagnosis
    - proposed parts (item search-first, per 12 §5.2 pattern reused)
    - proposed labour (description + price)
  ↓
  Submit -> status QUOTED / AWAITING_APPROVAL
  ↓
  (once approved) -> Work screen
    - confirm parts actually used (may differ from proposed)
    - add labour entries as work progresses
  ↓
  Mark Complete
```

## 10.3 Customer Approval (public link, mirrors `14` §8's customer-facing view)

```text
Tenant-branded read-only quote render (diagnosis + itemized cost)
  ↓
[Approve] button (only shown while AWAITING_APPROVAL)
  ↓
Confirmation screen
```

## 10.4 Invoicing

```text
Completed Service Order detail screen
  ↓
[Create Invoice] button (only if invoiceSaleId not yet set)
  ↓
Pre-filled Sale screen (12 §5, POS-style) — customer/lines locked
from the service order, cashier confirms payment method/amount
  ↓
Complete Sale -> receipt, service order shows "Invoiced: INV-..."
```

---

# 11. Cross-Module Orchestration Rule

```text
Service module -> calls -> Sales application service (interface)
Service module -> calls -> Inventory application service (interface,
                            for AllocationStrategy + movement posting)
Service module -> calls -> Warranty application service (interface,
                            §7 linkage)
Service module domain layer -> has NO dependency on Sales/Inventory
                                internals

Dependency direction (concrete):
  service/application → sales/application (interface)
  service/application → inventory/application (interface)
  service/application → warranty/application (interface)
  service/domain       → (no dependency on other domains)
```

---

# 12. Testing Obligations

```text
Status state machine:         every valid transition + invalid
                               transition rejection (e.g. cannot
                               invoice a non-COMPLETED order)
Parts consumption:             CONSUMPTION movement posted exactly
                                once per part-line, InsufficientStockError
                                surfaces correctly (mirrors 07 §19
                                InventoryLedgerService concurrent test)
Non-double-deduction (§6):     the critical test — invoice a completed
                                service order, verify exactly ONE
                                stock movement exists per part (the
                                original CONSUMPTION), not two
Cancellation with consumed
  parts:                       compensating movement correctly reverses
                                on-hand quantity
Warranty linkage:              completing a service order against an
                                EXPIRED/VOID warranty is rejected
Idempotency:                   replaying invoice operationId never
                                double-creates a Sale
```

---

# 13. Decisions Established by This Document

### Decision SRV-001
`06_DATABASE_SPECIFICATION.md` §6.3 is amended to add pricing fields, `promised_at`/`completed_at`/`cancelled_at`/`cancelled_reason`, and `operation_id` on `modules.service_orders`, plus `inventory_already_deducted`/`consumption_movement_id` on `modules.service_order_items`.

### Decision SRV-002
`ServiceOrderLine` supports two distinct line types (`PART`, `LABOUR`) with different validation and inventory-effect rules — `PART` requires a resolved `itemId`, `LABOUR` never touches inventory.

### Decision SRV-003
`CompleteSaleUseCase` (`07` §7.6) is extended with a narrow, documented skip-condition: a `SaleLine` flagged `inventoryAlreadyDeducted = true` (originating only from `InvoiceServiceOrderUseCase`, never client-settable on a normal sale) causes the use case to skip re-posting a stock movement for that line, preventing double-deduction of parts already consumed during repair.

### Decision SRV-004
Service Order customer approval reuses the same unguessable-token public-link authorization pattern established for Quotation (`14` §5.4/§7), rather than introducing a second parallel mechanism.

---

# 14. Open Module Questions

```text
1. Should `service.requireApproval` (§5.3) be a single tenant-wide
   toggle, or configurable per cost-threshold (e.g. auto-approve
   under a set amount, require explicit approval above it)?
2. Multi-technician orders (a repair requiring two specialists) —
   single `technicianUserId` is MVP-sufficient, or does this need a
   many-to-many assignment model from the start?
3. Full Warranty domain (§7) — deferred to its own document if
   claim-history/multi-claim complexity grows, or does this module's
   linkage description remain sufficient indefinitely?
4. Should `CancelServiceOrderUseCase`'s "scrapped parts" option (§5.8)
   post a distinct `DAMAGE` movement (per `09` §2 table) instead of a
   plain reversal, when the technician indicates the part was
   destroyed/unusable rather than simply unused?
5. SLA/turnaround tracking (`promisedAt` vs `completedAt` variance
   reporting) — Phase 2 reporting feature, or needed at module launch?
```

---

# 15. Next Document

পরবর্তী document:

`16_MODULE_RENTAL.md`

এখানে Rental module (Rental Asset lifecycle, Reservation/Dispatch/Return/Damage, per `06` §6.4 এবং `09` §7 Reservation & Release lifecycle) বিস্তারিত হবে — Decorator/Event এবং Equipment rental উভয় vertical-এর জন্য common framework হিসেবে, এই document-এর §6-এর মতো একটি critical non-obvious integration rule (damage charge posting-এর accounting effect, per `08` §5.5/§5.6) সহ।
