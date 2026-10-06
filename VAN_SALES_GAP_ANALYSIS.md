# GAP ANALYSIS — Van / Route Sales (Dealer Field-Representative Model)

**Status:** Discussion draft — NOT a formal Plan/ specification, NOT implemented.
**Trigger:** User-described real-world requirement (dealership business: field sales reps carry stock from the warehouse, sell in the field, return unsold/damaged/expired stock, sometimes self-authorize discounts).
**Rule applied:** per the project's "Documentation-First" and "No Architectural Drift" principles — this is a genuine specification gap, not an implementation task. No code is written against this analysis until explicit decisions are made.

---

## 1. What This Business Pattern Actually Is

This is a well-known distribution pattern, usually called **Van Sales**, **Route Sales**, or **Secondary Sales / Pre-Sales** in ERP terminology — extremely common in pharma, FMCG, and general dealership distribution in Bangladesh and elsewhere. Concretely, per your description:

```text
Warehouse
   ↓ (a defined quantity handed to a rep for a trip/route/day)
Sales Representative — now holds stock in CUSTODY, not yet sold
   ↓ (field sales to end customers/retailers, cash or credit)
Customer
   ↑ (unsold, damaged, or expired stock brought back)
Warehouse (reconciliation)
```

Two things make this materially different from a normal POS sale:

1. **A person, not a location, temporarily holds stock.** Every existing Core/Module concept (`core.stock_movements`, `core.warehouses`) models location-based custody — there is no concept of "this quantity is currently with Rep X, not in any warehouse."
2. **The rep can authorize discounts in the field, unsupervised at the moment of the transaction** — this is explicitly a controlled-risk scenario you flagged yourself ("সাবধানে হ্যান্ডেল করতে হয়").

---

## 2. Confirmed: This Is a Genuine Specification Gap

Searched across all 29 documents for the closest analogous concepts:

| Existing Concept | How Close Is It? |
|---|---|
| `09` §2 Movement types (`TRANSFER_OUT`/`TRANSFER_IN`) | Close, but `TRANSFER` is warehouse→warehouse only — no movement type represents "warehouse→person" |
| `16_MODULE_RENTAL.md`'s `RentalAsset` lifecycle (AVAILABLE→RESERVED→DISPATCHED→RETURNED) | **Structurally the closest analogy** — a rep's custody is conceptually "dispatch, use, return, inspect, reconcile," exactly like a rental asset. But Rental tracks ONE serialized/countable ASSET returning to the SAME state; a rep's custody is a CONSUMABLE quantity that partially converts into Sales, partially into Returns, partially into Loss/Damage — a genuinely different shape. |
| `07` §7.5a `DiscountThresholdPolicy` (Decision DOM-006, already implemented this session) | **Directly reusable** — the ceiling+override-permission model is exactly the right shape for "rep can discount up to X% unsupervised, beyond that needs approval." This is NOT a gap; it is the correct existing tool, that a new role (`SALES_REP` or similar) with a tighter ceiling would use as-is. |
| `10_OFFLINE_SYNC_SPECIFICATION.md` (POS sale is an offline-allowed operation, §8.1) | Directly reusable — a field rep very plausibly has no connectivity; the offline queue/sync engine already supports "POS Sale" as an offline operation type. |
| `08_ACCOUNTING_ENGINE_SPECIFICATION.md` posting rules | **No existing rule** covers "stock issued to a rep, not yet sold" (no revenue should post at that point — it's a custody transfer, not a sale) or "expired/damaged stock returned from a rep" (a loss/write-off, distinct from a normal customer return). |

**Conclusion:** This requires a new Optional Module — structurally most similar to how `16_MODULE_RENTAL.md` was built (reusing Core Inventory's movement ledger + a new lifecycle-tracking entity), but is NOT Rental and should not be forced into that module.

---

## 3. Proposed Conceptual Model (OPTIONS — not decided)

### 3.1 Core new entity: `RepStockAssignment` (working name)

```text
RepStockAssignment
├── id, tenantId, branchId, warehouseId (source)
├── repMembershipId          -- the sales rep (a control.membership,
│                                per 05 §77's existing Staff Access
│                                model — a rep IS staff, just with a
│                                field-sales role, not a new identity
│                                concept)
├── status: ISSUED | RECONCILING | RECONCILED | CANCELLED
├── issuedAt, reconciledAt?
├── lines: RepStockAssignmentLine[]
│     itemId, batchId?, quantityIssued, quantitySold (derived),
│     quantityReturnedGood (derived), quantityReturnedDamaged (derived),
│     quantityReturnedExpired (derived)
├── operationId
```

### 3.2 New Inventory movement types (extends `09` §2's table)

```text
REP_ISSUE     — warehouse → rep custody (negative at warehouse,
                does NOT touch quantity_on_hand the way a SALE does —
                needs its own "quantity_with_rep" dimension, OR is
                modeled as a special TRANSFER to a synthetic
                "rep-custody" pseudo-warehouse — OPEN QUESTION, §5.1)
REP_RETURN_GOOD      — rep custody → warehouse (unsold, resellable)
REP_RETURN_DAMAGED   — rep custody → written off (mirrors DAMAGE)
REP_RETURN_EXPIRED   — rep custody → written off (mirrors LOSS, but
                       distinct reporting category — expiry is not
                       the same root cause as breakage)
```

### 3.3 Field Sale — reuses `CompleteSaleUseCase` almost entirely

A rep's sale to an end customer is still a `Sale` (per `07` §7.6) — same entity, same accounting posting, same discount policy. The ONLY difference: stock availability is checked against the **rep's custody balance**, not the warehouse's, and the sale is very likely created **offline** (`10` §2.1). This is the same "narrow extension point" pattern already used three times this session (Pharmacy's `4.5`, Service's step-7 skip, Electronics' `12.5`, per `07` §7.6a's registry) — a candidate **step 4.5b** hook: *"if actor is a Rep with an active RepStockAssignment, check availability against custody balance instead of warehouse balance."*

### 3.4 Discount control — mostly already solved

Per `07` §7.5a (Decision DOM-006, already live this session): create a `SALES_REP` preset or tenant-custom role with:
- `sales.create` (can sell)
- **NOT** `sales.discount.override` (cannot exceed the tenant's discount ceiling)
- A tenant sets `maxDiscountPercent` deliberately low for this role's practical ceiling, OR (bigger design question, §5.3 below) the ceiling becomes **per-role**, not just tenant-wide, so Owner/Manager can have a higher ceiling than reps without needing the blanket override permission for everyone above the rep.

### 3.5 Reconciliation

```text
ReconcileRepAssignmentUseCase (working name)
  quantityIssued = SUM(quantitySold + quantityReturnedGood +
                        quantityReturnedDamaged + quantityReturnedExpired)
  — variance (shortfall not accounted for by any of the above) is
    flagged, NOT silently absorbed — mirrors 09 §9's StockCount
    variance-never-silent principle exactly.
```

---

## 4. Accounting Treatment (needs its own posting-rule additions, per the pattern `16`/`17` used to extend `08`)

```text
REP_ISSUE:        no revenue posting (not a sale yet) — at most a
                   memo/tracking entry, NOT a P&L event
Field Sale:        identical to 08 §5.1 (normal Sale posting) —
                   unchanged
REP_RETURN_GOOD:   no P&L event (stock simply returns to sellable
                   inventory)
REP_RETURN_DAMAGED/EXPIRED:
                   Dr Inventory Shrinkage/Expiry Expense
                       Cr Inventory (at cost) — mirrors 09 §9.3's
                   stock-count LOSS posting pattern
Unreconciled variance:
                   flagged for manual review — NOT auto-posted as a
                   loss (mirrors "never silently absorbed," above)
```

---

## 5. Explicit Open Questions — Need Your Decision Before Any Spec Is Written

### 5.1 How does "stock with a rep" fit the location model?
- **Option A:** Treat each active Rep as a synthetic/virtual warehouse (`core.warehouses` row with a `type = REP_CUSTODY` flag). Reuses 100% of existing `stock_balances`/`stock_movements` machinery — cheapest to build, but "warehouse" becomes a slightly overloaded concept.
- **Option B:** A genuinely new custody-tracking dimension (`RepStockAssignment` as its own ledger, separate from `core.stock_balances`). Cleaner conceptually, but duplicates inventory-ledger logic that Core already has.
- **My recommendation:** Option A — it is dramatically less new code, and "a rep is a warehouse-of-one" is a defensible modeling choice (similar to how `09` §7's Reservation already reuses the stock ledger for a non-physical-movement concept). But this is your call, not mine to silently decide.

### 5.2 Is a rep's field sale mandatory-offline, or online-capable too?
Affects whether this is built on top of the *existing* offline/sync engine (`10`) unchanged, or needs its own sync-priority handling.

### 5.3 Tenant-wide discount ceiling, or per-role ceiling?
Currently (Decision DOM-006, this session) `maxDiscountPercent` is **one number per tenant**. For reps to have a meaningfully tighter ceiling than Owner/Manager without giving everyone above them the blanket override permission, the ceiling itself may need to become **role-scoped** — a real extension to `07` §7.5a, not a trivial one.

### 5.4 Approval workflow for damaged/expired returns?
Should a large damaged/expired return require Manager sign-off before the inventory write-off posts (mirroring `03` §38's Approval Model), or is rep-reported condition trusted at face value with post-hoc audit?

### 5.5 Cash collection reconciliation — in scope now or later?
You mentioned discounting specifically; cash collected in the field (versus credit sales) is a closely related but separate reconciliation problem (rep owes the till a specific cash amount). Should this analysis's first version include cash-custody tracking, or stay scoped to stock custody + discount control only?

### 5.6 New module or extension of Rental?
Given the structural similarity to `16_MODULE_RENTAL.md` noted in §2, should this be built as its own new module (my recommendation, since the entity shapes genuinely differ — consumable vs. serialized asset), or as a Rental extension?

---

## 6. Recommended Next Step

This is architecturally significant enough (new movement types, new accounting posting rules, a new entity, a discount-policy extension) that per the project's own rule — *"Do NOT introduce... undocumented workflows... without identifying gap first"* — I recommend:

1. You decide §5.1–§5.6 (or tell me your own preferences/constraints not covered above — you know the dealership business reality better than I can infer).
2. I then draft a formal module specification (matching the existing `14`–`18` series' structure: entities, state machine, use cases, database detail, API detail, cross-module orchestration rule, testing obligations) as a new Plan/ document.
3. Only after that spec is written and approved do I implement it — same discipline as every other module in this codebase.

**আমি এখনই কোনো কোড বা schema লিখছি না।** আপনার সিদ্ধান্ত/অগ্রাধিকার শুনে তারপর formal spec draft করব।
