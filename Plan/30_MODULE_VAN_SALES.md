# 30_MODULE_VAN_SALES.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Van/Route Sales (Dealer Field-Representative) Module Specification
**Version:** 1.0 Draft
**Status:** Optional Module Deep-Dive — new addition to the Module series (`14`–`18`), post-`29` closure
**Depends on:**
- `07_CORE_DOMAIN_SPECIFICATION.md` (§6–9, §12 — Item/Inventory/Returns domains extended here)
- `08_ACCOUNTING_ENGINE_SPECIFICATION.md` (§5 — posting rules extended here)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§2 — movement types; this module deliberately does NOT add to this table — see §4)
- `10_OFFLINE_SYNC_SPECIFICATION.md` (§8 — offline boundary; field sale is offline-COMPATIBLE, not offline-mandatory, per this session's Decision VAN-002)
- `16_MODULE_RENTAL.md` (§2 — structural precedent: asset-out/asset-back lifecycle, explicitly NOT reused directly — see §2 below for why)
- `VAN_SALES_GAP_ANALYSIS.md` (this session's preceding discussion draft — superseded by this document)

---

# 1. Purpose

এই document dealer/distribution business-এর একটা সাধারণ, বহুল-প্রচলিত pattern-কে formalize করে: **field sales representative রা warehouse থেকে নির্দিষ্ট পরিমাণ stock নিজেদের custody-তে নিয়ে ফিল্ডে বিক্রি করে, অবিক্রিত/damaged/expired stock ফেরত দেয়, এবং মাঝে মাঝে নিজেরাই discount authorize করে।**

```text
Domain entities & invariants
Custody ledger (Rep Stock Assignment) — separate from Core inventory
Two distinct return flows (custody-origin vs post-sale customer return)
Per-role discount ceiling (extends 07 §7.5a)
Cash collection reconciliation
Accounting posting rules (new, extends 08 §5)
A required, narrow extension to Core's Return domain (07 §12) —
  discovered during this analysis, applicable platform-wide, not
  Van-Sales-specific
Use cases, database detail, API detail, UX flow
Cross-module orchestration rule
```

**Module classification:** Optional Module — enabled via `tenant_features.van_sales = true` (per `06` §4.7 pattern, extends the known-feature-key list in `packages/validation/tenant-features.ts`).

---

# 2. Why This Is Not Built as a Rental Extension

`16_MODULE_RENTAL.md` was the closest structural precedent considered (asset dispatched to a party, later returned, inspected). It is **not reused directly** because:

```text
RentalAsset: ONE serialized/countable physical unit, returns to the
             SAME identity (chair #47 comes back as chair #47).

RepStockAssignment: a QUANTITY of a consumable item that FRAGMENTS
             into three distinct outcomes (sold / returned-good /
             written-off) — there is no single "unit" that "comes
             back." This is a fundamentally different shape, closer
             to how a Purchase's stock receipt fragments into many
             future Sale/Return events over time.
```

Forcing this into `RentalAsset`'s per-unit lifecycle state machine would require treating every issued item unit as a serialized asset, which is false for the vast majority of dealership goods (loose FMCG/pharma units are not serialized). This module therefore introduces its own custody ledger (§4).

---

# 3. Domain Entity: `RepStockAssignment` (Aggregate Root)

```text
RepStockAssignment
├── id, tenantId, branchId
├── warehouseId              -- source warehouse (Core, unmodified)
├── repMembershipId FK -> control.memberships.id
│                              -- the rep IS staff (05 §77's existing
│                                 Staff Access model) — a "SALES_REP"
│                                 role, not a new identity concept
├── status: ISSUED | RECONCILING | RECONCILED | CANCELLED
├── issuedAt, expectedReturnAt?, reconciledAt?
├── lines: RepStockAssignmentLine[]
├── expectedCashCollected: Money (derived)
├── cashRemitted: Money (entered at reconciliation)
├── cashVariance: Money (derived = expectedCashCollected - cashRemitted)
├── varianceAcknowledgedBy?, varianceNote?
│                              -- per §7.5, a non-zero variance NEVER
│                                 silently blocks or silently zeroes —
│                                 it requires explicit acknowledgment
│                                 (mirrors 09 §9.3's StockCount variance
│                                 discipline, applied here to cash too)
├── operationId
```

## 3.1 Value Object: `RepStockAssignmentLine`

```text
RepStockAssignmentLine
├── itemId, batchId?
├── quantityIssued
├── quantitySold (derived — see §4.3)
├── quantityReturnedGood (derived)
├── quantityReturnedDamaged (derived — BOTH origins, §5, folded into
│                              one total; origin is distinguishable
│                              via modules.rep_stock_movements.
│                              reference_type for detailed reporting,
│                              not duplicated as separate columns)
├── quantityReturnedExpired (derived — same note)
├── quantityVariance (derived = issued - (sold + returnedGood +
│                       returnedDamaged + returnedExpired) — NEVER
│                       silently absorbed, per §7.5)
```

## 3.2 `quantityPendingReturn` (per Decision VAN-011)

A Flow-2 resellable return (§5.3) does not increment `quantityReturnedGood` at return time — it increments a separate `modules.rep_custody_balances.quantityPendingReturn` counter (§4), explicitly excluded from `quantityOnHand` (i.e., NOT sellable). `SellFromCustodyUseCase`'s availability check (§4.3) reads only `quantityOnHand`. Reconciliation (§6.1) resolves `quantityPendingReturn` into `quantityReturnedGood` and clears it to zero for that item/batch.

---

# 4. Custody Ledger — `modules.rep_stock_movements` (NEW, Decision VAN-001)

**Decision VAN-001 (this document, per your ratified §5.1 = Option B):** rep custody is tracked in its own append-only ledger, structurally mirroring `core.stock_movements` (Decision DB-001's discipline applied to a second domain) — **not** folded into `core.stock_balances`/`core.stock_movements` itself, and **not** modeled as a synthetic warehouse. `core.stock_balances` only ever reflects physical warehouse on-hand stock.

```text
modules.rep_stock_movements
  id, tenantId, repStockAssignmentId FK, itemId FK, batchId? FK,
  movementType: ISSUE | SALE | RETURN_GOOD | RETURN_DAMAGED | RETURN_EXPIRED
                | RETURN_PENDING,   -- RETURN_PENDING: Flow-2 resellable return (§5.3, VAN-011)
  quantity (signed decimal),
  referenceType, referenceId  -- polymorphic, mirrors core.stock_
                                 movements.reference_id pattern (06
                                 §5.10) — referenceType=SALE for a
                                 field sale, =CUSTOMER_RETURN for a
                                 Flow-2 damaged return (§6.2), =CUSTODY
                                 for a Flow-1 direct write-off (§6.1)
  occurredAt, operationId

modules.rep_custody_balances (derived cache, per the SAME "ledger is
  authoritative, balance is recomputable" discipline as core.stock_
  balances — Decision DB-001, applied here as Decision VAN-001a)
  tenantId, repMembershipId, itemId, batchId?, quantityOnHand,
  quantityPendingReturn  -- Decision VAN-011: Flow-2 resellable
                            returns land here, NEVER in quantityOnHand,
                            until reconciliation resolves them
```

## 4.1 Core's Own Ledger — Exactly Two New Movement Types

`core.stock_movements` (`09` §2) gains exactly two new types — the warehouse-facing half of custody transfer. Everything else (sold, damaged, expired) is a `modules.rep_stock_movements`-only event, since that stock is never physically at a warehouse again until/unless it returns as resellable:

```text
REP_ISSUE     — warehouse OUT (negative), posted by IssueRepStockUseCase
REP_RETURN_GOOD — warehouse IN (positive), posted by
                  ReturnRepStockUseCase, ONLY for the resellable-return
                  case — damaged/expired custody stock NEVER re-enters
                  core.stock_balances at all (§6.1)
```

**Amendment flag:** `09_INVENTORY_ENGINE_SPECIFICATION.md` §2's movement-type table gains these two rows — Decision VAN-002.

## 4.2 `IssueRepStockUseCase`

```text
Input: repMembershipId, warehouseId, branchId, lines[] (itemId, batchId?,
       quantity), operationId

1. Idempotency check
2. Validate repMembershipId belongs to tenant, holds a role with
   sales.create (mirrors 07's actor-permission validation pattern)
3. Decisions VAN-009 + VAN-008 (combined gate — AMENDED, Phase 4
   implementation finding; see VAN-008 amendment note in §11) —
   find any assignment for repMembershipId with status IN (ISSUED,
   RECONCILING):
     - if it exists AND expectedReturnAt < now  -> ASSIGNMENT_OVERDUE
     - if it exists otherwise                    -> ASSIGNMENT_ALREADY_ACTIVE
   Both are UNCONDITIONAL rejections: the database partial unique
   index (§9) has no exception for any permission, so no application-
   layer override can make a second active assignment insertable.
   Two error codes exist purely so the UI can explain WHY.
4. (merged into step 3 above — retained as a numbered placeholder so
   later step references remain stable)
5. AllocationStrategy.selectStockFor(...) per line (09 §4 — REUSED,
   not reimplemented; FEFO/FIFO/Serial all apply identically to which
   physical batch/unit is handed to the rep)
6. Post REP_ISSUE movement per line (core.stock_movements, negative)
7. Post ISSUE movement per line (modules.rep_stock_movements, positive
   custody, quantityOnHand)
8. Post accounting: Dr "Stock With Sales Reps" (NEW asset sub-account,
   §7.1) at cost, Cr Inventory — a TRANSFER, not an expense (the
   value remains an asset until sold or written off, §7.2-7.3)
9. Persist RepStockAssignment (status=ISSUED) + lines
10. Audit log
```

## 4.3 Field Sale — Reuses `CompleteSaleUseCase` via Two New Extension Points (AMENDED during Phase 4 implementation, approved by Nazmul)

**Registered in `07` §7.6a's Extension Points Registry as two rows (superseding this section's original single-hook, "no other change required" draft — that draft was found, during implementation, to double-deduct inventory and double-credit Inventory; see the correctness note below):**

```text
Hook Position: step 4.5b (pre-completion, alongside Pharmacy's 4.5)
Registered By: Van Sales
Purpose: if the sale carries a repAssignmentId (Decision VAN-013,
  below), stock availability is checked against
  modules.rep_custody_balances instead of core.stock_balances.
Effect on Sale if Hook Fails: fails the sale (InsufficientStockError),
  full rollback -- same failure contract as every other 07 §7.6 hook.

Hook Position: step 7, CONDITIONAL BRANCH (not an addition alongside
  step 7 -- a REPLACEMENT of step 7's core-ledger effect for a field
  sale's stock-tracked lines)
Registered By: Van Sales
Purpose (Decision VAN-012): a field-sale line does NOT post a core
  `SALE` movement and does NOT decrement core.stock_balances -- the
  goods already left warehouse on-hand at issue time (REP_ISSUE,
  §4.2 step 6). Instead it posts a `SALE` movement to
  modules.rep_stock_movements and decrements
  modules.rep_custody_balances. COGS (step 8/accounting, §7.5 below)
  credits 1250 (Stock With Sales Reps), not 1200 (Inventory).
Effect if Hook Fails: same as any stock-insufficiency failure --
  full rollback.
```

**Correctness note, found during implementation (not silently fixed):** this section's original text read "No other change to `CompleteSaleUseCase` is required... [the SALE-to-custody movement is] the ONLY new side effect" -- i.e. it described step 7's custody-ledger write as ADDITIVE, on top of Core's own unchanged SALE-movement/stock_balances/1200-credit behavior. That would double-deduct: the same physical unit would leave `core.stock_balances` twice (once at issue, once at "sale") and `1200 Inventory` would be credited twice for one unit's cost, while `1250 Stock With Sales Reps` (debited at issue) would never be relieved. Step 7's field-sale behavior is a **branch that replaces** Core's stock-ledger/1200-credit effect for that line, exactly as Service's `inventoryAlreadyDeducted` flag (`15` §6) replaces (not adds to) `CompleteSaleUseCase`'s normal movement-posting for a part already consumed during repair -- the same class of problem, the same class of fix. §7.5 below is amended to match.

### Decision VAN-013 (new, this amendment) — Field-Sale Detection

A sale is a field sale if and only if the request carries an explicit `repAssignmentId`. This is NOT inferred from "the actor happens to hold an ACTIVE assignment" (this section's original framing) -- a rep can still ring up an ordinary counter sale, and an Owner/Manager who also happens to hold a rep assignment must not have every sale they make silently redirected to custody. The server never trusts the id at face value: it must resolve to an assignment that is (a) this tenant's, (b) `status = ISSUED`, (c) `repMembershipId` equal to the ACTOR's own membership, and (d) the same `branchId`/`warehouseId` as the sale's lines -- any mismatch is rejected (`RESOURCE_NOT_FOUND` for a foreign/unknown id, per `13` §3.2's cross-tenant-existence non-disclosure principle applied here to a cross-actor boundary; `VALIDATION_FAILED` for a wrong-status/branch match on the caller's own assignment). Serial-tracked lines are out of scope for a field sale (mirrors `30` §3's `RepStockAssignmentLine` never carrying a `serialId` -- issuing serials to a rep was never specified).

---

---

# 5. Two Return Flows (per your ratified §5.4)

## 5.1 Flow 1 — Custody-Origin Damage/Expiry (never sold)

Stock discovered damaged (transport) or expired **while still with the rep**, before any sale.

```text
RecordCustodyWriteOffUseCase
Input: repStockAssignmentId, lines[] (itemId, batchId?, quantity,
       reason: DAMAGED | EXPIRED), operationId

0. (Decisions VAN-015/VAN-016) Caller must hold `vansales.writeoff`
   (seeded OWNER + MANAGER, never the rep role). The assignment must be
   ISSUED (row-locked); any other status is rejected.
1. Validate quantity <= modules.rep_custody_balances.quantityOnHand
   for that item/batch (cannot write off more than currently held)
2. Post RETURN_DAMAGED / RETURN_EXPIRED movement (modules.rep_stock_
   movements only — core.stock_balances is NEVER touched, since this
   stock does not return to the warehouse, per §4.1)
3. Post accounting (§7.3), at the ISSUE-TIME unit-cost snapshot
   (Decision VAN-014, never today's WAC): Dr Inventory Shrinkage/Expiry Expense,
   Cr "Stock With Sales Reps" (reverses the asset booked at issue,
   §4.2 step 6 — NOT Cr Inventory directly, since the value already
   left the Inventory account at issue time)
4. Audit log (sensitive — stock write-off, per 02 §33)
```

## 5.2 Flow 2 — Post-Sale Customer Return, Later Found Damaged/Expired

This is the flow you specifically flagged — a customer returns a **previously-sold** item to the rep in the field, and it's damaged/expired (not merely "customer changed their mind" with a resellable item).

**This exposes a genuine gap in Core's Return domain (`07` §12), applicable platform-wide, not Van-Sales-specific — flagged and resolved here as a Core extension, per the escalation procedure (`29` §8):**

### Decision VAN-003 (extends `07_CORE_DOMAIN_SPECIFICATION.md` §12 — Core Returns domain)

```text
ReturnLine (07 §12.1) gains one new optional field:

  condition: RESELLABLE | UNSELLABLE   (default RESELLABLE — fully
                                          backward compatible; every
                                          existing return in every
                                          other module/industry
                                          continues to behave
                                          identically)

CompleteCustomerReturnUseCase (07 §12.3) step 4 ("Post stock
movements — type = CUSTOMER_RETURN, positive quantity") becomes
conditional:

  IF condition = RESELLABLE (default):
     unchanged — CUSTOMER_RETURN movement, stock becomes sellable
     again, exactly as specified today.

  IF condition = UNSELLABLE:
     Post CUSTOMER_RETURN movement AS BEFORE (the financial/
     receivable/revenue-reversal effects, 08 §5.5, are IDENTICAL
     regardless of physical condition — the customer's money/credit
     effect doesn't change), but IMMEDIATELY followed, within the
     SAME transaction, by a write-off movement (LOSS type, 09 §2)
     for the same quantity — net effect on core.stock_balances is
     ZERO (it never actually becomes available sellable stock), while
     the accounting correctly shows: revenue reversed (08 §5.5,
     unchanged) AND a separate Inventory Shrinkage Expense posted for
     the unsellable unit's cost (mirrors §5.1's Flow-1 posting
     shape) — the return doesn't just vanish from the books, it is
     visibly written off.
```

**Why this belongs in Core, not this module:** any tenant — a plain retail shop, not just a dealer with field reps — can receive a defective/damaged customer return. This is a general-purpose fix your Van Sales question surfaced, not a Van-Sales-specific mechanism. Van Sales (below) is simply this general capability's first concrete CONSUMER.

## 5.3 `CompleteFieldCustomerReturnUseCase` (this module, thin orchestrator)

```text
Input: repStockAssignmentId, saleId (the original field sale),
       lines[] (saleItemId, quantity, condition: RESELLABLE | UNSELLABLE),
       operationId

1. Delegate ENTIRELY to CompleteCustomerReturnUseCase (07 §12.3,
   now condition-aware per Decision VAN-003) — this module does NOT
   reimplement return financial logic.
2. If any line's condition = UNSELLABLE: the write-off (§5.2) already
   happened inside step 1's delegated call — no double-posting here.
3. If any line's condition = RESELLABLE: the returned unit is
   physically back with the REP in the field, not yet at the
   warehouse — post a RETURN_PENDING entry into modules.rep_stock_
   movements, incrementing modules.rep_custody_balances.
   quantityPendingReturn (NEVER quantityOnHand, per Decision VAN-011
   — the rep cannot resell it before formal reconciliation)
4. Audit log
```

---

# 6. Reconciliation

## 6.1 `ReconcileRepAssignmentUseCase`

```text
Input: repStockAssignmentId, lines[] (itemId, batchId?, quantityReturnedGood),
       cashRemitted, varianceNote?, operationId

1. For each line with quantityReturnedGood > 0 (this figure is
   STAFF-ENTERED at reconciliation — physically counted stock handed
   back — NOT auto-derived from quantityPendingReturn, since the rep
   might also be handing back never-sold unsold units at the same
   moment; both are physically indistinguishable once back at the
   warehouse and are reconciled together in one count):
     Post RETURN_GOOD (modules.rep_stock_movements, negative custody
       — clears BOTH quantityOnHand and quantityPendingReturn for this
       item/batch as applicable, per Decision VAN-011)
     Post REP_RETURN_GOOD (core.stock_movements, positive warehouse —
       per §4.1, this IS one of the two Core-facing movement types)
     Post accounting: Dr Inventory, Cr "Stock With Sales Reps" (the
       resellable-return mirror of §4.2 step 6's issue posting)
2. Compute per-line quantityVariance (§3.1) — if any line has a
   non-zero variance, `varianceNote` is REQUIRED (validation error if
   omitted) — mirrors 09 §9.3's StockCount variance discipline exactly.
3. Compute cashVariance = expectedCashCollected - cashRemitted
   (expectedCashCollected is a derived query over all Sales
   referencing this assignment where payment method = CASH — never a
   manually-entered field, per 02 §49 One Source of Truth)
4. If cashVariance != 0: varianceAcknowledgedBy is REQUIRED (the
   caller's own membershipId, captured as an explicit acknowledgment
   — NOT auto-approval). Per your open policy question (§5.5's
   original framing): whether a cash shortfall becomes a Receivable
   against the rep or a direct Expense write-off is a TENANT-
   CONFIGURABLE setting (`tenant.settings.vanSales.cashShortfallPolicy:
   RECEIVABLE | EXPENSE`), not a hard platform decision — flagged as
   Decision VAN-004 (soft configuration, per 02 §44's Business Rule
   vs Configuration distinction, exactly like Return Window Days
   already is).
5. status -> RECONCILED, reconciledAt = now
6. Audit log (mandatory — cash/stock variance closure is sensitive)
```

---

# 7. Accounting — New Posting Rules (extends `08` §5)

## 7.1 New Chart of Accounts Entry

```text
1250  Stock With Sales Reps   (ASSET, system account, added to the
                                seed template per 08 §3.1's ASSET
                                table — sits alongside 1200 Inventory)
```

**Amendment flag:** `08_ACCOUNTING_ENGINE_SPECIFICATION.md` §3.1 gains this row — Decision VAN-005.

**Decision ACC-007 (clarification):** this section only adds `1250`. The write-off debit of Flow 1 (§5.1, §7.3) and of the customer-return write-off posts to **`5500 Inventory Shrinkage/Expiry Expense`**, a separate system account (`08` §3.5), not to `5900 Other Expense`.

## 7.2 Issue Posting (§4.2 step 6)

```text
Dr  Stock With Sales Reps        costOfIssuedLines
    Cr  Inventory                 costOfIssuedLines
```

## 7.3 Custody Write-Off Posting (§5.1 step 3)

```text
Dr  Inventory Shrinkage/Expiry Expense   costOfWrittenOffLines
    Cr  Stock With Sales Reps             costOfWrittenOffLines
```

`costOfWrittenOffLines` = Σ (`rep_stock_assignment_lines.unit_cost` × quantity), per Decision VAN-014. Zero-cost write-offs post no journal (INV-ACC-001), as for §7.2.

## 7.4 Reconciliation — Resellable Return Posting (§6.1 step 1)

```text
Dr  Inventory                     costOfReturnedGoodLines
    Cr  Stock With Sales Reps      costOfReturnedGoodLines
```

## 7.5 Field Sale Posting (AMENDED, Decision VAN-012)

Revenue recognition (Dr Cash/Receivable, Cr Sales Revenue, Cr Tax Payable if any, per `08` §5.1) is **unchanged** -- a field sale is a real Sale to a real customer, and that side of the books does not know or care where the goods physically came from.

COGS is **not** unchanged: the inventory-relief account is `1250 Stock With Sales Reps`, not `1200 Inventory`:

```text
Dr  COGS (5000)                    costOfLinesAtCost
    Cr  Stock With Sales Reps (1250)  costOfLinesAtCost
```

`costOfLinesAtCost` for a field sale is Σ (`rep_stock_assignment_lines.unit_cost` × quantity) -- the cost at which the goods entered custody (Decision VAN-014) -- NOT the warehouse's current WAC. Otherwise a WAC change between issue and sale would leave an unreconciled residual in 1250.

(An ordinary, non-field sale is byte-for-byte unaffected -- it still credits 1200, exactly as `08` §5.1 always specified.)

## 7.6 Cash Shortfall Posting (§6.1 step 4, per Decision VAN-004's tenant-configurable policy)

```text
IF cashShortfallPolicy = RECEIVABLE:
  Dr  Accounts Receivable (party = rep, via a Receivable record
      keyed to the rep's membership rather than a Customer — a
      SMALL, flagged extension: 07 §11.1's Receivable currently
      assumes customerId; this needs partyType alongside it, mirroring
      Payment's existing partyType: CUSTOMER | SUPPLIER pattern (07
      §10.1) generalized to include REP — Decision VAN-006)
      cashVariance
      Cr  Cash/Bank                cashVariance (reverses the expected-
                                     but-not-received cash)

IF cashShortfallPolicy = EXPENSE:
  Dr  Other Expense (Cash Shortfall)   cashVariance
      Cr  Cash/Bank                     cashVariance
```

---

# 8. Per-Role Discount Ceiling (extends `07` §7.5a, Decision VAN-007)

**Resolves your ratified §5.3.**

```text
Current (Decision DOM-006, this session): tenant.settings.sales.
  maxDiscountPercent is ONE number for the whole tenant.

NEW shape:
  tenant.settings.sales.discountCeilings: {
    default: number,                    -- fallback (existing default,
                                            20, per this session's
                                            implementation default)
    byRoleKey: Record<string, number>   -- e.g. { "SALES_REP": 5,
                                            "MANAGER": 30 }
  }

DiscountThresholdPolicy resolution (07 §7.5a, amended):
  ceiling = discountCeilings.byRoleKey[actor.roleKey]
            ?? discountCeilings.default
            ?? DEFAULT_MAX_DISCOUNT_PERCENT

Everything else about the policy (sales.discount.override permission
bypasses the resolved ceiling entirely, 0-100% hard bound, audit flag
on override) is UNCHANGED — only WHICH ceiling number is looked up
changes.
```

**Implementation note:** this requires `TenantContext` to carry the actor's role KEY (not just `roleId`) — a small addition to `requireTenantContext()` (`lib/guard.ts`), resolved once per request alongside `permissions`, the same pattern already established this session.

---

# 9. Database Detail (new tables, `modules` schema)

```text
modules.rep_stock_assignments
  id, tenant_id, branch_id, warehouse_id, rep_membership_id,
  status (ISSUED/RECONCILING/RECONCILED/CANCELLED),
  issued_at, expected_return_at, reconciled_at,
  expected_cash_collected, cash_remitted, cash_variance,
  variance_acknowledged_by, variance_note,
  operation_id, created_at, updated_at

-- Decision VAN-009 (defense-in-depth, mirrors Decision INV-008's
-- partial-unique-index pattern):
UNIQUE INDEX rep_one_active_assignment
  ON modules.rep_stock_assignments(tenant_id, rep_membership_id)
  WHERE status IN ('ISSUED', 'RECONCILING')

modules.rep_stock_assignment_lines
  id, tenant_id, assignment_id FK, item_id FK, batch_id? FK,
  quantity_issued, unit_cost (Decision VAN-014: issue-time cost snapshot),
  quantity_sold, quantity_returned_good,
  quantity_returned_damaged, quantity_returned_expired,
  quantity_variance

modules.rep_stock_movements
  id, tenant_id, rep_stock_assignment_id FK, item_id FK, batch_id? FK,
  movement_type (ISSUE/SALE/RETURN_GOOD/RETURN_DAMAGED/RETURN_EXPIRED/RETURN_PENDING),
  quantity, reference_type, reference_id, occurred_at, operation_id

modules.rep_custody_balances
  tenant_id, rep_membership_id, item_id, batch_id?, quantity_on_hand,
  quantity_pending_return
  (composite PK, derived/recomputable cache — Decision VAN-001a)
```

**Amendments to existing schema:**
```text
core.stock_movements.movement_type   -- +REP_ISSUE, +REP_RETURN_GOOD
                                          (Decision VAN-002)
core.return_lines                     -- +condition (RESELLABLE/
                                          UNSELLABLE), default
                                          RESELLABLE (Decision VAN-003)
core.receivables                      -- party_type (CUSTOMER/REP),
                                          generalizing customer_id-only
                                          assumption (Decision VAN-006)
core.accounts seed template            -- +1250 Stock With Sales Reps
                                          (Decision VAN-005)
control.tenant_features                -- +van_sales known key
```

---

# 10. Testing Obligations

```text
Custody ledger integrity:      IssueRepStockUseCase decrements
                                core.stock_balances AND increments
                                modules.rep_custody_balances
                                atomically; a field sale decrements
                                custody, never core.stock_balances
                                directly
Flow 1 vs Flow 2 distinction:  a custody-origin write-off (Flow 1)
                                posts NO revenue-reversal journal;
                                a Flow 2 return posts BOTH the
                                revenue-reversal (unchanged 08 §5.5)
                                AND the write-off, with net-zero
                                effect on core.stock_balances
Core Return backward
  compatibility (CRITICAL):    every EXISTING return in every OTHER
                                module/industry (Pharmacy, Electronics,
                                plain retail) behaves byte-for-byte
                                identically with condition defaulting
                                to RESELLABLE — this is the same
                                "extension-point isolation" regression
                                class used throughout this series (19
                                §12, 20 §10)
Per-role discount ceiling:     a SALES_REP-role actor is blocked at
                                their lower ceiling; a MANAGER-role
                                actor is not, from the SAME tenant
                                settings object
Cash variance never silent:    reconciliation with a non-zero
                                cashVariance and no varianceAcknowledgedBy
                                is rejected, not defaulted
Stock variance never silent:   same, for quantityVariance
Idempotency:                   replaying issue/return/reconcile
                                operationId never double-posts
```

---

# 11. Decisions Established by This Document

### Decision VAN-001
Rep custody is tracked in a dedicated append-only ledger (`modules.rep_stock_movements`) with a derived cache (`modules.rep_custody_balances`) — mirroring Decision DB-001's ledger-over-mutable-field discipline in a second domain, per your ratified Option B.

### Decision VAN-002
`core.stock_movements` gains exactly two new types (`REP_ISSUE`, `REP_RETURN_GOOD`) — the warehouse-facing half of custody transfer only; damaged/expired custody stock never re-enters `core.stock_balances`.

### Decision VAN-003 (Core Return domain extension — platform-wide, not Van-Sales-specific)
`ReturnLine` gains an optional `condition: RESELLABLE | UNSELLABLE` field (default `RESELLABLE`, fully backward compatible) — `CompleteCustomerReturnUseCase` posts an additional write-off movement, net-zero on `core.stock_balances`, when a returned unit is unsellable.

### Decision VAN-004
Cash-shortfall disposition (Receivable-against-rep vs direct Expense) is tenant-configurable soft policy, not a hard platform invariant — defaulting to `RECEIVABLE` (Decision VAN-010) unless the tenant explicitly configures otherwise.

### Decision VAN-005
Chart of Accounts gains `1250 Stock With Sales Reps` (ASSET, system account).

### Decision VAN-006
`core.receivables` gains `party_type: CUSTOMER | REP`, generalizing its previously customer-only assumption — required for cash-shortfall-as-receivable (Decision VAN-004).

### Decision VAN-007
Discount ceiling resolution (`07` §7.5a) becomes role-scoped (`discountCeilings.byRoleKey`), falling back to the existing tenant-wide default — per your ratified §5.3.

### Decision VAN-008 (ratified, AMENDED during Phase 4 implementation — approved by Nazmul)
An overdue (`expectedReturnAt < now`) unreconciled `RepStockAssignment` **strictly blocks** new issuance to that rep, returning `ASSIGNMENT_OVERDUE` (more specific than `ASSIGNMENT_ALREADY_ACTIVE`, for UI messaging).

**Amendment:** the originally ratified text allowed `vansales.override` to bypass this block. That is not implementable alongside Decision VAN-009: the database-level partial unique index `rep_one_active_assignment` covers `ISSUED` **and** `RECONCILING`, has no permission carve-out, and would turn an override into a raw unique-violation at INSERT. Resolution: **`vansales.override` does not affect `IssueRepStockUseCase`.** An overdue assignment must be reconciled (or cancelled) before more stock is issued. The permission remains seeded (OWNER-only) and is reserved for a future action (e.g. force-reconcile, or a top-up-into-existing-assignment use case — deliberately NOT specified here; needs its own decision if the business need appears).

### Decision VAN-009 (ratified)
A rep may hold **at most one** assignment in `ISSUED` or `RECONCILING` status at any time — enforced at the application layer AND as a database-level partial unique index (`UNIQUE(tenant_id, rep_membership_id) WHERE status IN ('ISSUED','RECONCILING')`), mirroring the defense-in-depth discipline already established for `core.stock_balances` (Decision INV-008).

### Decision VAN-010 (ratified)
`cashShortfallPolicy` defaults to `RECEIVABLE` for every tenant unless explicitly overridden — a shortfall is presumed collectible from the rep until a tenant deliberately configures otherwise.

### Decision VAN-012 (new, Phase 4 implementation amendment, approved by Nazmul)
A field sale's stock-tracked lines post to the custody ledger (`modules.rep_stock_movements`/`rep_custody_balances`) INSTEAD OF Core's (`core.stock_movements`/`core.stock_balances`), and its COGS journal credits `1250 Stock With Sales Reps` instead of `1200 Inventory` -- a branch/replacement of `07` §7.6 step 7 and this document's §7.5, not an addition alongside them. Corrects this document's original "no other change required" framing, found incorrect during implementation (§4.3).

### Decision VAN-013 (new, Phase 4 implementation amendment, approved by Nazmul)
A sale is a field sale only when it carries an explicit, server-verified `repAssignmentId` belonging to the acting membership -- never inferred from the actor merely holding an active assignment. See §4.3.

### Decision VAN-014 (new, Phase 4 Flow 1 gap analysis, approved by Nazmul -- DATABASE CHANGE)
Custody carries a cost basis. `modules.rep_stock_assignment_lines.unit_cost numeric(18,4) NOT NULL DEFAULT 0` snapshots the issue-time unit cost (the same WAC-else-purchasePrice basis that debits 1250 at issue, §7.2). Every later relief of 1250 for that item/batch -- field-sale COGS (§7.5, **amends VAN-012's costing**: cost comes from custody, not the warehouse balance), custody write-off (§7.3), reconciliation return (§7.4) -- uses this snapshot, so 1250 nets to zero per assignment regardless of later WAC movement. Per-line truncation to 4 dp can leave a sub-0.0001 residual per line; accepted, not corrected. The `DEFAULT 0` exists only so pre-VAN-014 rows migrate; the module is pre-launch.

### Decision VAN-015 (new, Phase 4 Flow 1 gap analysis, approved by Nazmul)
Permission `vansales.writeoff` gates `RecordCustodyWriteOffUseCase` (§5.1). Seeded OWNER + MANAGER; deliberately NOT granted to the field-rep (STAFF) role -- a rep must not be able to write off the stock they are accountable for. Checked inside the use case (defense in depth), not only at the route. Open: whether a MANAGER who is also the assignment's rep may write off their own custody is NOT restricted here (audit-logged only); needs a segregation-of-duties decision if the business requires it.

### Decision VAN-016 (new, Phase 4 Flow 1 gap analysis, approved by Nazmul)
A custody write-off is allowed only while the assignment is `ISSUED` (row-locked for the duration, so it cannot race a status transition). `RECONCILING`/`RECONCILED`/`CANCELLED` reject it. Idempotency needs no header table: each line's custody movement carries a deterministic operationId derived from the caller's operationId; replay returns the original movements, and reusing the key on a different assignment is rejected. Write-offs are recorded in the custody ledger only; the stored `quantityReturnedDamaged/Expired` columns on assignment lines are derived per §3.1 and are computed from the ledger at reconciliation, not maintained per write-off.

### Decision VAN-011 (ratified)
A Flow-2 (§5.2/§5.3) resellable return is **never** immediately sellable by the same rep — it is tracked in a distinct `quantityPendingReturn` custody bucket (§4, amended), excluded from `modules.rep_custody_balances.quantityOnHand` entirely, and only resolved into warehouse-sellable stock at formal reconciliation (§6.1). This is a deliberate control point (quality/fraud oversight on field-returned goods), not an oversight.

---

# 12. Open Questions — RESOLVED (per your ratification)

All four questions originally posed here are now closed — see Decisions VAN-008 through VAN-011 (§11). No open architectural questions remain blocking implementation.

---

# 13. Next Step

এই spec approve হলে implementation order (dependency-ordered, matching this codebase's own established discipline):

```text
1. Schema: modules.rep_stock_assignments/lines/movements/balances,
   core.return_lines.condition, core.accounts seed +1250,
   core.receivables.party_type
2. Core Return domain extension (Decision VAN-003) — smallest,
   highest-leverage change; benefits the WHOLE platform immediately
3. Per-role discount ceiling (Decision VAN-007)
4. IssueRepStockUseCase, field-sale extension point, Flow 1/2 return
   use cases, ReconcileRepAssignmentUseCase
5. API routes + tests (matching this session's established pattern:
   real-PostgreSQL integration tests, not mocks, for anything
   touching accounting/inventory correctness)
```
