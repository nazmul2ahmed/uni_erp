# 07_CORE_DOMAIN_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Core Domain Layer Specification
**Version:** 1.0 Draft
**Status:** Domain Baseline
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md`
- `04_PLATFORM_ARCHITECTURE.md`
- `05_MULTI_TENANT_ARCHITECTURE.md`
- `06_DATABASE_SPECIFICATION.md`

---

# 1. Purpose

এই document Core-এর **domain layer** নির্ধারণ করে — Entities, Value Objects, Invariants, Domain Services, এবং Application-layer Use Cases — `06_DATABASE_SPECIFICATION.md`-এর schema-কে ভিত্তি ধরে।

Layering reminder (per `04` §13–18):

```text
Presentation
     ↓
Application Layer   (use cases / orchestration)
     ↓
Domain Layer         (entities, invariants, policies)
     ↓
Repository Layer     (interfaces)
     ↓
Infrastructure       (PostgreSQL / Drizzle)
```

এই document শুধু **Domain + Application** layer সংজ্ঞায়িত করে। Repository/Infrastructure বাস্তবায়ন implementation phase-এ হবে।

---

# 2. Domain Modeling Conventions

```text
Entity        = has identity, mutable lifecycle (Sale, Purchase, Customer)
Value Object  = no identity, immutable (Money, Quantity, DateRange)
Policy        = pure business rule, injectable/testable
Domain Service = stateless operation spanning multiple entities
Use Case      = application-layer orchestration, one per user intent
```

Shared Value Objects (per §86, `04`):

```text
Money(amount: numeric, currency: string)
Quantity(value: numeric, unit: Unit)
DateRange(start, end)
Result<T, E>       — success/failure without throwing for expected business failures
ID                 — branded UUID type per entity
```

**Money rule:** never a raw `number`/float in domain logic. Arithmetic performed via decimal-safe library (per §64, `04`).

---

# 3. Domain Module Map

```text
core/
├── identity/        (User, Membership — thin, mostly control-plane passthrough)
├── customer/
├── supplier/
├── catalog/          (Item, Category, Brand, Unit)
├── sales/
├── purchase/
├── inventory/
├── payments/
├── receivables-payables/
├── returns/
├── expenses/
├── accounting/
└── audit/
```

Each module: `domain/`, `application/`, `schemas/` (Zod), `tests/` — per §85, `04`.

---

# 4. Customer Domain

## 4.1 Entity: `Customer`

```text
Customer
├── id
├── tenantId
├── type: INDIVIDUAL | ORGANIZATION
├── name
├── phone?
├── email?
├── address?
├── isWalkIn: boolean
├── isActive: boolean
```

**Invariants:**
- `phone` unique per tenant unless `isWalkIn = true`
- Cannot hard-delete if referenced by any `Sale`, `Receivable`, or `Return` — archive only (`isActive = false`)

## 4.2 Use Cases

```text
CreateCustomer(input) -> Customer
UpdateCustomer(id, input) -> Customer
ArchiveCustomer(id) -> void
SearchCustomers(query, tenantContext) -> Customer[]
GetCustomerLedger(id) -> { sales, returns, payments, receivableBalance }
```

`GetCustomerLedger` reads from `core.receivables` + `core.payments` — never a manually-maintained `dueBalance` field (per §49, `02` — One Source of Truth).

---

# 5. Supplier Domain

Structurally mirrors Customer (per §12, `02`).

```text
Supplier
├── id, tenantId, name, phone?, email?, address?, contactPerson?, isActive
```

**Use Cases:**

```text
CreateSupplier / UpdateSupplier / ArchiveSupplier / SearchSuppliers
GetSupplierLedger(id) -> { purchases, returns, payments, payableBalance }
```

---

# 6. Catalog Domain (Item)

## 6.1 Entity: `Item`

```text
Item
├── id, tenantId, sku?, name
├── type: PRODUCT | SERVICE | RAW_MATERIAL | CONSUMABLE | RENTAL_ASSET | NON_STOCK
├── categoryId?, brandId?, unitId
├── purchasePrice: Money, sellingPrice: Money
├── tracking: {
│     stock: boolean, batch: boolean, expiry: boolean,
│     serial: boolean, rental: boolean, warranty: boolean
│   }
├── isActive
```

**Invariants:**
- `expiry_tracked = true` requires `batch_tracked = true` (expiry is meaningless without a batch to attach to)
- `serial_tracked = true` implies `stock_tracked = true`
- `type = SERVICE` normally has `stock_tracked = false` (soft rule — tenant can override if selling a "service kit")

## 6.2 Policy: `ItemTrackingPolicy`

Determines which inventory allocation strategy applies to a given item (bridges to Inventory domain, §9):

```text
resolve(item: Item) -> AllocationStrategy
  if item.tracking.expiry -> FEFO
  else if item.tracking.serial -> SERIAL
  else if item.tracking.rental -> RESERVATION
  else -> FIFO (or tenant-configured default)
```

This is the concrete mechanism realizing Decision 003 (`01`) and BD-004 (`02`) — strategy derives from item capability, never from a hardcoded `businessType` check (per §47, `02`).

## 6.3 Use Cases

```text
CreateItem / UpdateItem / ArchiveItem
SearchItems(query) -> Item[]
GetItemStockSummary(itemId) -> { onHand, reserved, byWarehouse, byBatch }
```

---

# 7. Sales Domain

## 7.1 Entity: `Sale` (Aggregate Root)

```text
Sale
├── id, tenantId, branchId, invoiceNumber, localNumber?
├── customerId?
├── status: DRAFT | CONFIRMED | PARTIALLY_PAID | PAID | DUE | COMPLETED | CANCELLED
├── lines: SaleLine[]
├── pricing: { subtotal, discountTotal, taxTotal, grandTotal }: Money
├── paidTotal, dueTotal: Money
├── saleDate
├── operationId
```

## 7.2 Value Object: `SaleLine`

```text
SaleLine
├── itemId, description
├── quantity: Quantity
├── unitPrice: Money
├── lineDiscount: Money
├── taxAmount: Money
├── lineTotal: Money (derived)
├── batchId? / serialId?
├── warehouseId
```

## 7.3 Invariants

```text
1. lineTotal = (quantity * unitPrice) - lineDiscount + taxAmount   (derived, never stored independently of inputs)
2. grandTotal = SUM(lines.lineTotal) - discountTotal + taxTotal
3. paidTotal + dueTotal = grandTotal
4. status transitions are one-directional except explicit CANCELLED path:
   DRAFT -> CONFIRMED -> {PARTIALLY_PAID -> PAID | DUE} -> COMPLETED
   any non-terminal state -> CANCELLED (reversal, not deletion)
5. Once COMPLETED, no field mutation is permitted — only CANCELLED + compensating Return
6. quantity must be > 0 per line
7. If item.tracking.serial, each unit must resolve to a distinct StockSerial
```

## 7.4 Domain Service: `SalePricingService`

```text
calculateLineTotal(line) -> Money
calculateGrandTotal(lines, orderDiscount, tax) -> Money
```

Pure, side-effect-free — testable independent of persistence.

## 7.5 Domain Service: `SaleValidationService`

```text
validateStockAvailability(lines, warehouseId) -> Result<void, InsufficientStockError>
validateSerialAssignment(lines) -> Result<void, SerialConflictError>
validateDiscountLimits(lines, actorPermissions) -> Result<void, DiscountExceededError>
```

## 7.5a Domain Policy: `DiscountThresholdPolicy` (NEW — Phase 0.5 Reconciliation)

Resolves Open Question §21 Q2. Hybrid model per Decision DOM-006.

```text
DiscountThresholdPolicy.validate(line, actor, tenantSettings)
  -> tenantCeiling = tenant.settings.sales.maxDiscountPercent
       (tenant-configurable global default, per 02 §44 Configuration)
  -> if line.discountPercent <= tenantCeiling:
       ALLOW
     else if actor.permissions includes "sales.discount.override":
       ALLOW  -- role/user-specific bypass of the ceiling
     else:
       Result.fail(DiscountExceededError)
```

`SaleValidationService.validateDiscountLimits` (§7.5) invokes this policy.
Permission `sales.discount.override` follows the standard `resource.action`
format (`04` §34). Preset seed mapping: Owner and Manager roles receive
this permission by default; Cashier/Staff do not — tenant may customize
via role management (`05` §77).

**Schema dependency:** `core.business_profiles.settings` (jsonb) carries
`sales.maxDiscountPercent` — no new table required, this lives inside
the existing settings blob per `04` §140's tenant-settings shape.

## 7.6 Use Case: `CompleteSaleUseCase`

**This is the canonical "Transaction over Screen" example (per §48, `02`).**

```text
Input: SaleDraftInput, tenantContext, operationId

1. BEGIN transaction
2. Idempotency check: if operationId already applied for tenant -> return prior result
3. Validate customer (if provided) belongs to tenant
4. Validate stock availability (InventoryService.checkAvailability)
5. Calculate pricing (SalePricingService)
6. Persist Sale + SaleLines (status = CONFIRMED)
7. Post stock movements (InventoryService.postSaleMovements) — type = SALE, negative quantity
8. Create Payment record if cash received (PaymentService.recordPayment)
9. Create/Update Receivable if due > 0 (ReceivableService.createOrUpdate)
10. Post accounting journal entry (AccountingService.postSaleJournal)
11. Write audit log
12. Update Sale.status based on paidTotal vs grandTotal
13. COMMIT
14. Emit domain event: SaleCompleted (async consumers only, per §44 of `04`)
```

**Failure handling:** any step 4–11 failure -> full ROLLBACK, no partial sale, no partial stock movement, no orphaned payment (per §40, `04` — Transaction Boundary).

## 7.7 Use Case: `CancelSaleUseCase`

```text
Input: saleId, reason, tenantContext

1. Validate sale.status != CANCELLED
2. Post compensating stock movements (reverse of original SALE movements)
3. Post reversal journal entry (per §25, `03`)
4. Reverse/close associated Receivable
5. status = CANCELLED, cancelledAt, cancelledReason
6. Audit log with before/after + reason
```

**Rule:** `CancelSaleUseCase` never deletes rows — this realizes Architectural Non-Negotiable and Decision DB-004 (`06`).

## 7.8 Use Case: `CreateSaleDraftUseCase`

```text
Input: partial cart, userId, deviceId
Output: Draft (core.drafts, type=SALE)
```

Drafts bypass full validation — only shape validation. Full business validation happens at `CompleteSaleUseCase`.

---

# 8. Purchase Domain

Structurally parallels Sales (per §18, `03`).

## 8.1 Entity: `Purchase`

```text
Purchase
├── id, tenantId, branchId, purchaseNumber, localNumber?
├── supplierId
├── status: DRAFT | CONFIRMED | RECEIVED | PAID | PARTIALLY_PAID | CANCELLED
├── lines: PurchaseLine[]
├── pricing: { subtotal, discountTotal, taxTotal, grandTotal }
├── paidTotal, dueTotal
├── purchaseDate, operationId
```

## 8.2 Value Object: `PurchaseLine`

```text
PurchaseLine
├── itemId, description, quantity, costPrice, sellingPrice?
├── lineDiscount, taxAmount, lineTotal
├── batchNumber?, expiryDate?
├── warehouseId
```

## 8.3 Use Case: `ReceivePurchaseUseCase`

```text
1. BEGIN transaction
2. Idempotency check (operationId)
3. Validate supplier belongs to tenant
4. Persist Purchase + PurchaseLines
5. For each line with batch/expiry data -> create/attach StockBatch (core.stock_batches)
6. Post stock movements — type = PURCHASE, positive quantity
7. Create/Update Payable if due > 0
8. Create Payment if paid at receipt
9. Post accounting journal entry (debit Inventory/COGS asset, credit Payable/Cash)
10. Audit log
11. COMMIT
12. Emit PurchaseReceived event
```

## 8.4 Use Case: `ConfirmPurchaseFromOCRUseCase`

**Realizes the AI-safety principle from §7, `01` and §46, `04`:**

```text
Input: purchaseDocumentId (already has AI-extracted draft data)

1. Load extracted_data from core.purchase_documents
2. Present as editable draft — NOT yet a Purchase entity
3. Require explicit human confirmation of each line
4. On confirm -> delegate to ReceivePurchaseUseCase with human-verified input
5. Link core.purchase_documents.purchase_id to resulting Purchase
6. Set verified_by, verified_at
```

**Non-negotiable:** step 2–3 cannot be skipped programmatically. No code path allows `extracted_data` to flow directly into `ReceivePurchaseUseCase` without passing through human confirmation.

---

# 9. Inventory Domain

## 9.1 Entity: `StockMovement` (append-only ledger row)

```text
StockMovement
├── id, tenantId, itemId, warehouseId
├── batchId?, serialId?
├── movementType: OPENING | PURCHASE | SALE | CUSTOMER_RETURN | SUPPLIER_RETURN |
│                 ADJUSTMENT_IN | ADJUSTMENT_OUT | TRANSFER_IN | TRANSFER_OUT |
│                 RESERVATION | RELEASE | CONSUMPTION | DAMAGE | LOSS
├── quantity: signed decimal
├── referenceType, referenceId
├── occurredAt, operationId
```

**Invariant:** immutable once created. No `UpdateStockMovement` use case exists by design.

## 9.2 Domain Service: `InventoryLedgerService`

```text
postMovement(movement: NewStockMovement) -> StockMovement
recomputeBalance(itemId, warehouseId, batchId?) -> StockBalance
checkAvailability(itemId, warehouseId, quantity) -> Result<void, InsufficientStockError>
```

**Rule:** `core.stock_balances` is always derived by `recomputeBalance` — never independently mutated by other domains (Sales/Purchase call this service, they don't touch balances directly). This is the concrete mechanism for §90 of `03` — Inventory transaction integrity.

## 9.3 Allocation Strategy Interface

```text
AllocationStrategy {
  selectStockFor(itemId, warehouseId, quantity) -> AllocatedUnits[]
}

Implementations:
  FIFOAllocationStrategy
  FEFOAllocationStrategy      -- orders by StockBatch.expiryDate ascending
  SerialAllocationStrategy    -- requires explicit serial selection, no auto-pick
  ReservationAllocationStrategy -- for rental assets, checks Booking overlap
  ManualAllocationStrategy    -- user-selected batch/serial, service validates only
```

Selected via `ItemTrackingPolicy.resolve(item)` (§6.2). Sales/Purchase domain never hardcodes a strategy — this fulfills BD-004 and Decision 003.

## 9.4 Use Case: `AdjustStockUseCase`

```text
Input: itemId, warehouseId, quantityDelta, reason, actorPermissions

1. Require permission: inventory.adjust
2. May require approval workflow (per §38, `03`) if above threshold
3. Post movement (ADJUSTMENT_IN or ADJUSTMENT_OUT)
4. Recompute balance
5. Audit log (mandatory — stock adjustment is a sensitive action per §33, `02`)
```

## 9.5 Use Case: `TransferStockUseCase`

```text
1. Validate source warehouse has sufficient available (non-reserved) stock
2. Post TRANSFER_OUT at source
3. Post TRANSFER_IN at destination
4. Both movements share one operationId + a linking transferId
5. Atomic — both or neither
```

## 9.6 Concurrency Rule (per §94, `04`)

```text
checkAvailability + postMovement occur inside the same DB transaction
with row-level locking (SELECT ... FOR UPDATE on stock_balances row,
or serializable isolation for the movement insert + balance recompute)
so two concurrent sales cannot both succeed against the same last unit.
```

---

# 10. Payment Domain

## 10.1 Entity: `Payment`

```text
Payment
├── id, tenantId
├── partyType: CUSTOMER | SUPPLIER
├── partyId, direction: IN | OUT
├── amount: Money, method
├── referenceNo?, paidAt, operationId
```

## 10.2 Value Object: `PaymentAllocation`

```text
PaymentAllocation
├── paymentId, allocatedToType: SALE | PURCHASE | EXPENSE | ADVANCE
├── allocatedToId, amount
```

**Invariant:** `SUM(allocations.amount) <= payment.amount` (unallocated remainder = advance/credit).

## 10.3 Use Case: `RecordCustomerPaymentUseCase`

```text
1. Idempotency check
2. Persist Payment (direction=IN, partyType=CUSTOMER)
3. Allocate to specified Sale(s) / oldest-due-first if unspecified
4. Update Receivable.paidAmount / balance
5. Post accounting journal (debit Cash/Bank, credit Receivable)
6. Audit log
```

## 10.4 Use Case: `RecordSupplierPaymentUseCase`

Mirrors §10.3 with `direction=OUT`, `partyType=SUPPLIER`, updates Payable.

---

# 11. Receivable / Payable Domain

## 11.1 Entity: `Receivable`

```text
Receivable
├── id, tenantId, customerId, saleId
├── amount, paidAmount, balance (derived = amount - paidAmount)
├── status: OPEN | PARTIAL | SETTLED
├── dueDate?
```

**Derivation rule:** `balance` and `status` are recomputed whenever a `PaymentAllocation` targeting this receivable is created — never set directly by UI or dashboard code (per §21, `03`; §49, `02`).

## 11.2 Domain Service: `ReceivableAgingService`

```text
getAgingBuckets(tenantId) -> { current, days1to30, days31to60, days61to90, over90 }
```

Read-only, feeds Reporting domain (§13).

---

# 12. Returns Domain

## 12.1 Entity: `Return`

```text
Return
├── id, tenantId, type: CUSTOMER_RETURN | SUPPLIER_RETURN
├── referenceSaleId? / referencePurchaseId?
├── partyId, status: DRAFT | COMPLETED | CANCELLED
├── lines: ReturnLine[]
├── pricing: { subtotal, taxTotal, grandTotal }
├── returnDate, operationId
```

## 12.2 Domain Service: `ReturnEligibilityPolicy`

**This is the canonical "Business Rule vs Configuration" example from §44, `02`.**

```text
validate(returnLine, originatingSaleLine) -> Result<void, ReturnExceededError>
  # HARD INVARIANT (code-enforced, not configurable):
  cumulativeReturnedQty(saleLineId) + returnLine.quantity <= saleLine.quantity

  # SOFT CONFIGURATION (tenant-configurable, checked separately):
  isWithinReturnWindow(sale.saleDate, tenant.settings.returnWindowDays)
```

## 12.3 Use Case: `CompleteCustomerReturnUseCase`

```text
1. BEGIN transaction
2. Validate ReturnEligibilityPolicy for every line
3. Persist Return + ReturnLines
4. Post stock movements — type = CUSTOMER_RETURN, positive quantity
5. Reduce Receivable.balance (or issue refund Payment if already fully paid)
6. Post accounting journal (reverse portion of original sale journal)
7. Audit log
8. COMMIT
```

`CompleteSupplierReturnUseCase` mirrors this against Payable/Purchase.

**Critical rule (per §10, `01`):** a Return is never *only* a stock quantity change — every completed return produces both inventory AND financial effects atomically, enforced by this single use case never being split across two separate calls.

---

# 13. Accounting Domain

## 13.1 Entity: `Account` (Chart of Accounts)

```text
Account
├── id, tenantId, code, name
├── type: ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
├── parentId?, isSystemAccount
```

**System accounts** (seeded per tenant onboarding, not user-deletable): Cash, Bank, Accounts Receivable, Accounts Payable, Inventory, Sales Revenue, COGS, Discount Given, Discount Received, Owner's Equity.

## 13.2 Entity: `Journal` + `JournalEntry`

```text
Journal
├── id, tenantId, referenceType, referenceId, description, postedAt, operationId

JournalEntry
├── id, tenantId, journalId, accountId
├── debit: Money, credit: Money   -- exactly one is non-zero per row
```

## 13.3 Invariant: Double Entry

```text
For every Journal:
  SUM(entries.debit) == SUM(entries.credit)
```

This is checked by `AccountingService.postJournal` before commit — the use case **refuses to persist** an unbalanced journal (application-layer gate), backed by an optional DB trigger as defense-in-depth (per Decision DB-005/§26 of `06`).

## 13.4 Domain Service: `AccountingPostingService`

```text
postSaleJournal(sale) -> Journal
  # debit: Cash/Receivable (by paid/due split), Discount Given (if any)
  # credit: Sales Revenue, Tax Payable (if any)
  # additionally: debit COGS, credit Inventory (at cost, from stock movement)

postPurchaseJournal(purchase) -> Journal
  # debit: Inventory (at cost)
  # credit: Cash/Payable (by paid/due split)

postPaymentJournal(payment) -> Journal
postExpenseJournal(expense) -> Journal
postReversalJournal(originalJournalId, reason) -> Journal
  # mirrors original entries with debit/credit swapped
```

Every Sale/Purchase/Payment/Expense/Return use case in §7–12 calls into this service **within the same DB transaction** — accounting is never a decoupled async side-effect for these core flows (per §41, `04`).

## 13.5 Use Case: `GenerateTrialBalanceUseCase` / `GenerateProfitAndLossUseCase` / `GenerateBalanceSheetUseCase`

```text
Input: tenantId, dateRange
Output: read-only report derived entirely from Account + JournalEntry rows
```

No independently-maintained "P&L cache" as source of truth — reports are queries, not stored state (per §48, `03`).

---

# 14. Expense Domain

## 14.1 Entity: `Expense`

```text
Expense
├── id, tenantId, branchId, categoryId
├── amount, description, paidVia, expenseDate, operationId
```

## 14.2 Use Case: `RecordExpenseUseCase`

```text
1. Idempotency check
2. Persist Expense
3. Post accounting journal (debit Expense category account, credit Cash/Bank)
4. Audit log
```

---

# 15. Audit Domain

## 15.1 Domain Service: `AuditLogger`

```text
record(entry: {
  tenantId, userId, action, entityType, entityId,
  before?, after?, reason?, requestId
}) -> void
```

**Rule:** every Use Case in §7–14 that mutates financial or stock state calls `AuditLogger.record` as its final step, inside the same transaction (per §39, `03`; §142, `04`).

## 15.2 What Gets Audited (minimum set, per module)

```text
Sales:        CompleteSale, CancelSale
Purchase:     ReceivePurchase, ConfirmPurchaseFromOCR
Inventory:    AdjustStock, TransferStock
Payment:      RecordCustomerPayment, RecordSupplierPayment
Returns:      CompleteCustomerReturn, CompleteSupplierReturn
Accounting:   any manual JournalEntry (non-auto-posted)
```

---

# 16. Cross-Domain Orchestration Rules

Per §89–91, `04`:

```text
1. Sales domain calls Inventory/Payment/Accounting/Audit — never touches
   their tables directly.
2. Purchase domain calls Inventory/Payment/Accounting/Audit — same rule.
3. Returns domain calls Inventory/Payment(or Receivable)/Accounting/Audit.
4. No domain module imports another domain's repository directly;
   only its public Application Service interface.
5. Cross-module orchestration lives in Application Layer Use Cases
   (§7.6, §8.3, §12.3 above) — not inside any single domain's entity.
```

## 16.1 Dependency Direction (concrete)

```text
sales/application  → inventory/application (interface)
sales/application  → payments/application (interface)
sales/application  → accounting/application (interface)
sales/application  → audit/application (interface)

sales/domain       → (no dependency on other domains' internals)
```

---

# 17. Idempotency Contract (applies to every Use Case in this document)

```text
Every mutating Use Case signature includes: operationId

Behavior:
  if a completed record with (tenantId, operationId) already exists:
    return the prior result without re-executing side effects
  else:
    execute normally, persist operationId as part of the transaction
```

Concretely backed by `core.sync_operations` (offline-origin) and the `UNIQUE(tenant_id, operation_id)` constraints defined per-table in `06` §9 (Decision DB-002).

---

# 18. Error Model

Domain-level failures return typed `Result<T, DomainError>` rather than throwing, for **expected** business-rule violations:

```text
InsufficientStockError
ReturnExceededError
DiscountExceededError
SerialConflictError
UnbalancedJournalError
DuplicateOperationError (idempotency replay — not a failure, returns prior result)
TenantMismatchError
```

These map to the API error codes catalog in `04` §38 (`INSUFFICIENT_STOCK`, `RETURN_QTY_EXCEEDED`, etc.) at the Application/API boundary — the mapping table is owned by `11_API_SPECIFICATION.md`.

**Unexpected** failures (infra errors, constraint violations not anticipated by domain logic) propagate as exceptions and trigger transaction rollback + 5xx at the API boundary.

---

# 19. Testing Obligations for This Layer

Per §79–81, `03`, the following domain behaviors require dedicated unit + integration tests before a module is "Done" (§91, `03`):

```text
SalePricingService:        line/order discount math, tax math, rounding
SaleValidationService:     stock shortage, serial conflicts, discount limits
ReturnEligibilityPolicy:   exact-boundary return qty (=, >, < sold qty)
InventoryLedgerService:    concurrent sale against last unit (§9.6)
AllocationStrategy:        FEFO ordering correctness, FIFO ordering correctness
AccountingPostingService:  every posting method produces a balanced Journal
CompleteSaleUseCase:       full happy path + each rollback trigger point
Idempotency:               replaying the same operationId never double-posts
```

---

# 20. Decisions Established by This Document

### Decision DOM-001
Allocation strategy is resolved per-item via `ItemTrackingPolicy`, never hardcoded per industry — concrete fulfillment of Decision 003 (`01`) / BD-004 (`02`).

### Decision DOM-002
`CompleteSaleUseCase`, `ReceivePurchaseUseCase`, and the Return use cases are the **only** entry points that may mutate Sales/Purchase/Return + Inventory + Payment + Accounting together — no other code path is permitted to partially apply these effects.

### Decision DOM-003
Accounting posting happens synchronously inside the same transaction as the originating business event for Sale/Purchase/Payment/Expense/Return — not as an async event-driven side effect (refines §44, `04` for these five flows specifically; other flows may use async events).

### Decision DOM-004
All financial/stock domain errors are modeled as typed `Result` values, not exceptions, at the domain boundary.

### Decision DOM-005
AI-extracted purchase data must pass through `ConfirmPurchaseFromOCRUseCase`'s human-confirmation step; no use case accepts unverified AI output as direct input to `ReceivePurchaseUseCase`.

### Decision DOM-006 (NEW — Phase 0.5 Reconciliation)
Discount approval enforcement uses a hybrid model: a tenant-configurable
global ceiling (`tenant.settings.sales.maxDiscountPercent`), overridable
only by actors holding the `sales.discount.override` permission (§7.5a).
This resolves `07` §21 Q2 (Phase 0.5 Reconciliation, human-approved).

---

# 21. Open Domain Questions

```text
1. Should PaymentAllocation support partial allocation across multiple
   open Sales in one payment at MVP, or single-sale-only initially?
2. [RESOLVED — see Decision DOM-006, §7.5a] Discount approval threshold —
   global tenant setting or per-role limit?
3. Does AdjustStockUseCase require approval workflow at MVP, or logged-only?
4. Serial allocation UX: must user pick serial at sale time, or can
   system auto-suggest with override?
5. Reversal journal for partial returns — one reversal per return,
   or proportional single-line adjustment?
6. Where does tax calculation live — Sales domain or a separate
   shared Tax domain service consumed by both Sales and Purchase?
```

---

# 22. Next Document

পরবর্তী document:

`08_ACCOUNTING_ENGINE_SPECIFICATION.md`

এখানে Accounting domain (§13 এখানে যা সংক্ষেপে দেখানো হয়েছে) আরও গভীরে বিস্তারিত হবে:

```text
Full Chart of Accounts template
Posting rules per transaction type (exhaustive table)
Trial Balance / P&L / Balance Sheet / Cash Flow query specifications
Period closing behavior
Multi-branch consolidation
Reversal & adjustment workflows in full detail
```

এরপর `09_INVENTORY_ENGINE_SPECIFICATION.md`-তে একইভাবে Inventory domain গভীরে বিস্তারিত হবে।
