# 09_INVENTORY_ENGINE_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Inventory Engine Specification
**Version:** 1.0 Draft
**Status:** Domain Deep-Dive
**Depends on:**
- `06_DATABASE_SPECIFICATION.md` (§5.10, Inventory Domain tables)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§9, Inventory Domain)
- `08_ACCOUNTING_ENGINE_SPECIFICATION.md` (§5.1–5.2, stock ↔ COGS/Inventory posting)

---

# 1. Purpose

এই document `07_CORE_DOMAIN_SPECIFICATION.md` §9-এ সংক্ষেপে বর্ণিত Inventory domain সম্পূর্ণভাবে বিস্তারিত করে:

```text
Full stock movement type table with posting semantics
Allocation algorithms (FIFO / FEFO / Serial / Reservation / Manual) — concrete
Multi-warehouse transfer flow
Stock valuation method
Reservation & release lifecycle
Concurrency & locking strategy
Stock reconciliation / physical count workflow
```

**Foundational rule carried forward (per `01` §8, `02` §13, `06` §5.10 Decision DB-001):**

> `core.stock_movements` হলো একমাত্র authoritative source। `core.stock_balances` সবসময় derived/recomputable cache।

---

# 2. Movement Type — Full Semantics Table

| Type | Sign | Trigger | Reference | Reverses To |
|---|---|---|---|---|
| `OPENING` | + | Tenant onboarding | opening_entry | — (never reversed, only corrected via ADJUSTMENT) |
| `PURCHASE` | + | `ReceivePurchaseUseCase` | purchase_id | `SUPPLIER_RETURN` or reversal |
| `SALE` | − | `CompleteSaleUseCase` | sale_id | `CUSTOMER_RETURN` or reversal |
| `CUSTOMER_RETURN` | + | `CompleteCustomerReturnUseCase` | return_id | — |
| `SUPPLIER_RETURN` | − | `CompleteSupplierReturnUseCase` | return_id | — |
| `ADJUSTMENT_IN` | + | `AdjustStockUseCase` | adjustment_id | `ADJUSTMENT_OUT` (manual counter-entry) |
| `ADJUSTMENT_OUT` | − | `AdjustStockUseCase` | adjustment_id | `ADJUSTMENT_IN` |
| `TRANSFER_OUT` | − | `TransferStockUseCase` (source) | transfer_id | `TRANSFER_IN` (destination, same transfer_id) |
| `TRANSFER_IN` | + | `TransferStockUseCase` (destination) | transfer_id | pairs with `TRANSFER_OUT` |
| `RESERVATION` | 0 (affects `reserved`, not `on_hand`) | Booking/Rental hold | booking_id / rental_order_id | `RELEASE` |
| `RELEASE` | 0 (affects `reserved`) | Reservation expiry/fulfillment | booking_id / rental_order_id | pairs with `RESERVATION` |
| `CONSUMPTION` | − | Project/Service material use | project_id / service_order_id | — |
| `DAMAGE` | − | Inspection finding | rental_order_id / inspection_id | — |
| `LOSS` | − | Stock count shortfall | reconciliation_id | — |

**Sign convention:** `quantity` on `core.stock_movements` is always signed relative to `on_hand`. `RESERVATION`/`RELEASE` do **not** move `quantity_on_hand` — they move `quantity_reserved` only (see §7).

---

# 3. Stock Balance Recomputation

## 3.1 Formula

```text
quantity_on_hand(item, warehouse, batch?) =
    SUM(stock_movements.quantity)
    WHERE movement_type NOT IN ('RESERVATION', 'RELEASE')
      AND tenant_id = :t AND item_id = :i AND warehouse_id = :w
      AND (batch_id = :b OR :b IS NULL)

quantity_reserved(item, warehouse, batch?) =
    SUM(CASE WHEN movement_type = 'RESERVATION' THEN quantity_delta
             WHEN movement_type = 'RELEASE' THEN -quantity_delta
        END)

quantity_available = quantity_on_hand − quantity_reserved
```

## 3.2 `InventoryLedgerService.recomputeBalance`

```text
recomputeBalance(itemId, warehouseId, batchId?) -> StockBalance
  1. Query all relevant stock_movements (indexed on tenant_id, item_id, warehouse_id)
  2. Fold per formula above
  3. UPSERT core.stock_balances (tenant_id, item_id, warehouse_id, batch_id)
  4. Return updated balance
```

**Performance note:** for high-volume items, full re-fold on every movement is not scalable long-term. MVP approach: incremental update (`balance.quantity_on_hand += movement.quantity`) inside the same transaction as the movement insert, with periodic full-recompute as a background reconciliation job (§10) to catch drift.

---

# 4. Allocation Algorithms — Concrete

All implementations satisfy the `AllocationStrategy` interface (`07` §9.3):

```text
AllocationStrategy.selectStockFor(itemId, warehouseId, quantity) -> AllocatedUnit[]
```

## 4.1 FIFO

```text
1. Query stock_batches for item/warehouse ordered by received_at ASC
   (or, if item is not batch-tracked, treat all stock as one pseudo-batch
   ordered by earliest PURCHASE movement's occurred_at)
2. Walk batches accumulating available quantity until requested quantity is met
3. If total available < requested -> Result.fail(InsufficientStockError)
4. Return [{batchId, quantity}, ...] allocation plan
```

## 4.2 FEFO

```text
1. Query stock_batches for item/warehouse WHERE quantity_available > 0
   ORDER BY expiry_date ASC NULLS LAST
2. Walk batches accumulating available quantity until requested quantity is met
3. Same insufficient-stock handling as FIFO
4. Return allocation plan
```

**Pharmacy-specific configuration hook (per `01` §9):** FEFO is selected automatically whenever `item.tracking.expiry = true` — this is Core inventory logic, not pharmacy-specific code; Pharmacy items simply always carry that flag.

## 4.3 Serial

```text
1. Requires explicit serial selection by the user/UI — no auto-pick
   (per `07` §9.3 note)
2. validate: each requested core.stock_serials.id has status = 'IN_STOCK'
   AND item_id/warehouse_id match
3. If any requested serial is unavailable -> Result.fail(SerialConflictError)
4. Return [{serialId, quantity: 1}, ...] — serials are inherently qty=1 units
```

## 4.4 Reservation (Rental)

```text
1. Query modules.rental_assets WHERE item_id = itemId AND status = 'AVAILABLE'
2. Check for Booking overlap on the requested time window
   (uses the EXCLUDE constraint / overlap query from `06` §6.2)
3. If insufficient non-overlapping assets -> Result.fail(InsufficientStockError)
4. Return [{rentalAssetId, quantity: 1}, ...]
```

## 4.5 Manual

```text
1. User has already specified batchId/serialId/warehouseId in the input
2. Strategy only validates: does the specified allocation have sufficient
   quantity_available?
3. No auto-selection logic — pure validation pass-through
```

## 4.6 Strategy Selection Recap

```text
ItemTrackingPolicy.resolve(item):
  expiry_tracked    -> FEFO
  serial_tracked     -> SERIAL
  rental_tracked      -> RESERVATION
  batch_tracked only  -> FIFO (batch-aware)
  none of above       -> FIFO (movement-order, non-batch)
  tenant override      -> MANUAL (if tenant config explicitly disables auto-allocation)
```

---

## 4.7 Negative Stock Policy — Per-Item Opt-In (NEW — Phase 0.5 Reconciliation)

Resolves Open Question §13 Q2. Per-item opt-in, default forbidden, per
Decision INV-007.

```text
core.items.allow_negative_stock   boolean NOT NULL DEFAULT false

InventoryLedgerService.checkAvailability(itemId, warehouseId, quantity):
  1. Load item.allow_negative_stock
  2. IF false (default):
       quantity_available < requested -> Result.fail(InsufficientStockError)
  3. IF true:
       sale/adjustment proceeds even if resulting on_hand < 0
       (movement posts normally per §2's ledger-append rule;
        stock_balances.quantity_on_hand may go negative — this is a
        valid, tracked state, NOT a data-integrity error)
```

**Interaction with tracking flags:** for serial-tracked and
batch/FEFO-tracked items, `allow_negative_stock` has no practical effect
— `SerialAllocationStrategy` (§4.3) and `FEFOAllocationStrategy` (§4.2)
require resolving a specific, physically-available unit; there is no
concept of a "negative" serial or batch quantity. These items therefore
always behave as if `allow_negative_stock = false`, regardless of the
flag's stored value.

**Permission:** `inventory.allow_negative_stock` (required to toggle the
flag on an item — general staff cannot enable it; Manager/Owner-tier
only, mirrors the `inventory.adjust` elevated-permission pattern of §9.4).

---

# 5. Multi-Warehouse Transfer — Detailed Flow

## 5.1 `TransferStockUseCase`

```text
Input: itemId, sourceWarehouseId, destinationWarehouseId, quantity,
       batchId? / serialIds?, reason, operationId

1. BEGIN transaction
2. Idempotency check (tenantId, operationId)
3. Validate sourceWarehouseId != destinationWarehouseId
4. Validate both warehouses belong to tenant (and, if branch-scoped
   permissions apply, actor has access to both)
5. Run AllocationStrategy.selectStockFor(itemId, sourceWarehouseId, quantity)
   -> resolves specific batch/serial units to move
6. Post TRANSFER_OUT movement(s) at source (negative quantity),
   referencing the resolved batch/serial
7. Post TRANSFER_IN movement(s) at destination (positive quantity),
   SAME batch/serial identity carried over (batch/serial records are
   warehouse-agnostic — only stock_movements carry warehouse_id)
8. Recompute balances at both warehouses
9. Audit log
10. COMMIT
```

**Design note:** `core.stock_batches` and `core.stock_serials` do not have a `warehouse_id` column (per `06` §5.10) — physical location is derived from the net of `stock_movements` for that batch/serial. This avoids a second source of truth for "where is this batch right now."

## 5.2 In-Transit Handling (deferred)

MVP treats transfer as instantaneous (single transaction, both legs posted together). A future `TRANSFER_PENDING` intermediate state (dispatch → in-transit → received, with discrepancy handling) is deferred — flagged in §11.

---

# 6. Stock Valuation Method

## 6.1 Decision

**Weighted Average Cost (WAC)** is selected as the MVP valuation method, computed per `(tenant_id, item_id, warehouse_id)` — not per batch, to keep COGS calculation tractable at MVP scale, **except** for serial-tracked and batch-tracked-with-explicit-FEFO items, which use **specific identification** (the actual cost of the specific batch/serial consumed).

```text
Non-batch, non-serial items:
  WAC_new = ((WAC_old * qty_on_hand_before) + (purchase_cost * qty_purchased))
            / (qty_on_hand_before + qty_purchased)
  -- recalculated on every PURCHASE movement, stored on core.stock_balances

Batch-tracked items (incl. FEFO/pharmacy):
  cost_of_sale = stock_batches.cost_price (specific identification,
                 the exact batch consumed via FEFO/FIFO allocation)

Serial-tracked items:
  cost_of_sale = the specific serial unit's recorded cost
                 (from core.purchase_items at time of receipt)
```

## 6.2 Schema Addendum

`core.stock_balances` (per `06` §5.10) requires an additional field for non-batch WAC tracking:

```text
core.stock_balances
  ... existing fields ...
  weighted_avg_cost   numeric(18,4)   -- null for batch/serial-valued items
```

This is flagged as an amendment to `06_DATABASE_SPECIFICATION.md` (see Decision INV-004, §12).

## 6.3 COGS Calculation at Sale Time

```text
CompleteSaleUseCase, for each SaleLine:
  1. AllocationStrategy resolves specific batch(es)/serial(s) or,
     for WAC items, simply uses current core.stock_balances.weighted_avg_cost
  2. costOfLine = allocated_quantity * unit_cost (batch/serial/WAC as applicable)
  3. Sum across lines -> costOfLinesAtCost, fed into AccountingPostingService
     (per `08` §5.1)
```

---

# 7. Reservation & Release Lifecycle

## 7.1 Purpose

Supports Rental (`modules.rental_orders`) and Booking (`modules.bookings`) — stock/assets must be held without reducing `on_hand`, so a sale of the same physical unit cannot double-commit it (per `02` §26, rental lifecycle).

## 7.2 Lifecycle

```text
AVAILABLE
   ↓ (Booking confirmed / Rental reserved)
RESERVED           -- stock_movements: RESERVATION posted, reserved += qty
   ↓ (Dispatch / fulfillment)
DISPATCHED/RENTED   -- no new stock_movement; reservation remains until return
   ↓ (Returned + inspected)
RELEASE posted, reserved -= qty
   ↓
AVAILABLE (or MAINTENANCE if damaged — see `08` §5.5/§5.6 for financial effect)
```

## 7.3 `ReserveStockUseCase`

```text
Input: itemId, warehouseId, quantity, referenceType (BOOKING/RENTAL_ORDER),
       referenceId, expiresAt?, operationId

1. Validate quantity_available >= quantity (on_hand - already_reserved)
2. Post RESERVATION movement
3. Recompute balance.quantity_reserved
4. If expiresAt provided and not fulfilled by then -> background job posts
   RELEASE automatically (prevents indefinite phantom holds)
```

## 7.4 `ReleaseReservationUseCase`

```text
Input: referenceType, referenceId, operationId
1. Find matching open RESERVATION movement(s) for this reference
2. Post RELEASE movement(s) of equal quantity
3. Recompute balance
```

**Rule:** `RESERVATION` never blocks `AdjustStockUseCase` or `TransferStockUseCase` from moving `on_hand` stock — it only affects what `quantity_available` reports to the Sales/Booking domain. This is a deliberate simplification; hard-blocking reserved stock from adjustment is a future refinement (§11).

---

# 8. Concurrency & Locking Strategy — Detailed

## 8.1 Problem Restated (per `04` §94, `07` §9.6)

Two concurrent operations against the same item/warehouse/batch must not both succeed if only one unit remains.

## 8.2 Locking Approach

```text
Inside CompleteSaleUseCase / ReceivePurchaseUseCase / TransferStockUseCase / AdjustStockUseCase:

BEGIN transaction (READ COMMITTED, with explicit row lock)
  SELECT * FROM core.stock_balances
    WHERE tenant_id=:t AND item_id=:i AND warehouse_id=:w AND batch_id=:b
    FOR UPDATE                          -- row-level lock, blocks concurrent writers
  -- if no row exists yet (first movement for this combination), a
  -- unique-constraint-based upsert with ON CONFLICT DO UPDATE ... FOR UPDATE
  -- semantics is used instead

  check availability against locked row
  IF insufficient -> ROLLBACK, return InsufficientStockError

  INSERT stock_movement
  UPDATE stock_balance (incremental)
COMMIT  -- lock released
```

**Why row lock over SERIALIZABLE isolation:** row-level `FOR UPDATE` on the specific `stock_balances` row gives precise contention scoped to exactly the contended resource (one item/warehouse/batch combination), without the broader retry/abort overhead of full serializable transactions across unrelated concurrent operations on different items.

## 8.3 Deadlock Avoidance

```text
Rule: within any single use case, stock_balances rows are always
locked in a consistent order — e.g. sorted by (item_id, warehouse_id, batch_id) —
when a use case touches multiple lines (multi-item sale/transfer).
```

This prevents two concurrent multi-line sales from deadlocking by locking the same two rows in opposite order.

## 8.4 Offline-Origin Conflict

```text
Offline sale synced late, after another (online) sale already consumed the
last unit:

1. Sync endpoint attempts CompleteSaleUseCase with the offline operationId
2. Same locking/availability check applies — if insufficient stock now,
   the use case returns InsufficientStockError
3. This surfaces to the client as a sync FAILED status requiring manual
   review (per `05` §53 Conflict Resolution — "Financial transaction:
   No automatic overwrite")
4. UI presents: "Item X is no longer available in the quantity you sold
   offline — please review this sale."
```

No silent auto-adjustment of an offline sale's quantity — this is a `Business Rule Failure` conflict class (per `04` §42), requiring human resolution.

---

# 9. Reconciliation / Physical Stock Count

## 9.1 Entity: `StockCount` (new, addendum to `06`)

```text
core.stock_counts
  id, tenant_id, warehouse_id, status (DRAFT/IN_PROGRESS/COMPLETED/CANCELLED),
  counted_by, started_at, completed_at, created_at

core.stock_count_lines
  id, tenant_id, stock_count_id FK, item_id FK, batch_id? FK,
  system_quantity (snapshot at count start),
  counted_quantity (entered by staff),
  variance (derived = counted - system),
  created_at
```

## 9.2 `StartStockCountUseCase`

```text
1. Snapshot current core.stock_balances for the warehouse into
   stock_count_lines.system_quantity
2. status = IN_PROGRESS
```

## 9.3 `SubmitStockCountUseCase`

```text
1. Staff enters counted_quantity per line
2. On finalize, for each line where variance != 0:
     Post ADJUSTMENT_IN (variance > 0) or LOSS (variance < 0) movement
     referencing this stock_count_id
3. Recompute balances
4. Post accounting adjustment if tenant enables "auto-post inventory
   variance to P&L" (Dr/Cr Inventory Shrinkage Expense account — new
   optional account, tenant-configurable)
5. status = COMPLETED
6. Audit log — mandatory (stock adjustment-class action, per `02` §33)
```

**Rule:** variance-driven movements always use `ADJUSTMENT_IN`/`LOSS`, never a direct `UPDATE` on `core.stock_balances` — preserving the ledger-first principle even for reconciliation.

---

# 10. Background Reconciliation Job

Per §3.2 performance note — a scheduled job periodically re-derives `core.stock_balances` from a full fold of `core.stock_movements` and compares against the incrementally-maintained value:

```text
ReconcileStockBalancesJob (per-tenant, scheduled)
  1. For each (item, warehouse, batch) touched since last run:
       recomputed = full fold of stock_movements
       cached = current stock_balances row
       IF recomputed != cached:
         log discrepancy (structured log + optional alert)
         correct the cached row to match recomputed (source of truth wins)
  2. This job never writes stock_movements — only repairs the derived cache
```

This is an operational integrity safeguard, not a business workflow — distinct from the user-facing `StockCount` in §9, which reconciles *system vs physical reality*, while this job reconciles *cache vs ledger*.

---

# 11. Deferred / Future Scope

```text
1. In-transit transfer state (dispatch/receive as two separate confirmations)
2. Hard-blocking reserved stock from ADJUSTMENT/TRANSFER (currently soft)
3. Rack/Bin sub-warehouse location granularity (per `02` §15 — MVP stays at warehouse level)
4. Landed cost allocation (freight/customs apportioned into batch cost)
5. Negative stock policy — per-tenant toggle to allow oversell with backorder tracking
6. Serial-level warranty auto-linking at sale time (bridges to modules.warranties)
```

---

# 12. Decisions Established by This Document

### Decision INV-001
FIFO/FEFO/Serial/Reservation/Manual allocation algorithms are defined as pure, testable functions independent of the persistence layer, consuming only `stock_batches`/`stock_serials`/`rental_assets` read models.

### Decision INV-002
Stock valuation is Weighted Average Cost for non-batch/non-serial items, and specific identification (actual batch/serial cost) for batch- or serial-tracked items.

### Decision INV-003
Concurrency control uses row-level `SELECT ... FOR UPDATE` on `core.stock_balances`, with consistent multi-line lock ordering to prevent deadlocks — not full SERIALIZABLE isolation.

### Decision INV-004
`core.stock_balances.weighted_avg_cost` is added to the canonical schema (amendment to `06_DATABASE_SPECIFICATION.md` §5.10).

### Decision INV-005
`core.stock_counts` / `core.stock_count_lines` are added to the canonical schema (amendment to `06_DATABASE_SPECIFICATION.md` §5.10) to support physical reconciliation.

### Decision INV-006
Reservation (`RESERVATION`/`RELEASE`) affects only `quantity_reserved`, never `quantity_on_hand` — physical stock movement and commitment tracking remain distinct ledgers within the same table.

### Decision INV-007 (NEW — Phase 0.5 Reconciliation)
Negative stock is forbidden by default (`core.items.allow_negative_stock
= false`), opt-in per item via the `inventory.allow_negative_stock`
permission (§4.7). Serial- and batch/FEFO-tracked items are unaffected
by this flag since their allocation strategies inherently require a
specific, available physical unit. Resolves `09` §13 Q2 (Phase 0.5
Reconciliation, human-approved).

---

# 13. Open Inventory Questions

```text
1. Should reserved stock hard-block ADJUSTMENT_OUT/TRANSFER_OUT, or is the
   current soft (advisory-only) approach acceptable through MVP?
2. [RESOLVED — see Decision INV-007, §4.7] Negative stock — forbidden by
   default, or tenant-configurable per item?
3. Landed cost (freight/duty) allocation — Phase 2 feature or architecture
   hook needed now in `core.purchase_items`?
4. Auto-release of expired reservations — background job interval, and does
   it need tenant-configurable grace period?
5. Should StockCount support partial-warehouse (category/location subset)
   counts, or always full-warehouse at MVP?
```

---

# 14. Next Document

পরবর্তী document:

`10_OFFLINE_SYNC_SPECIFICATION.md`

এখানে Offline/Sync architecture (per `04` §49–54, `05` §45–47) বিস্তারিত হবে — বিশেষভাবে এই document-এর §8.4 (offline-origin stock conflict) কে ভিত্তি করে পুরো conflict taxonomy, resolution UX, এবং sync engine-এর concrete state machine সংজ্ঞায়িত করা হবে।
