# 08_ACCOUNTING_ENGINE_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Accounting Engine Specification
**Version:** 1.0 Draft
**Status:** Domain Deep-Dive
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md`
- `06_DATABASE_SPECIFICATION.md`
- `07_CORE_DOMAIN_SPECIFICATION.md` (§13, `AccountingPostingService`)

---

# 1. Purpose

এই document `07_CORE_DOMAIN_SPECIFICATION.md`-এর §13-এ সংক্ষেপে বর্ণিত Accounting domain-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Chart of Accounts (full seed template)
Posting Rules (exhaustive, per transaction type)
Trial Balance / P&L / Balance Sheet / Cash Flow (query specification)
Period Closing
Multi-Branch Consolidation
Reversal & Adjustment workflows
```

**Foundational rule carried forward (non-negotiable, per `03` §90):**

> প্রতিটি financial event-এর জন্য balanced double-entry journal তৈরি হবে। `SUM(debit) = SUM(credit)` কখনো bypass করা যাবে না।

---

# 2. Accounting Model Summary

```text
Chart of Accounts
      ↓
Journal (one per business event)
      ↓
Journal Entries (≥2 rows, debit/credit balanced)
      ↓
Ledger (per-account running view, derived)
      ↓
Trial Balance (derived)
      ↓
P&L / Balance Sheet / Cash Flow (derived)
```

Nothing above the Journal Entry level is independently stored as authoritative — every report is a query (per Decision DOM restated, `07` §13.5).

---

# 3. Chart of Accounts — Seed Template

Every new tenant is seeded with this baseline chart at provisioning (`05` §49). Tenant may add sub-accounts but **system accounts** (`is_system_account = true`) cannot be deleted or have their `type` changed — only renamed/reorganized under a different parent.

## 3.1 ASSET

| Code | Name | System | Notes |
|---|---|---|---|
| 1000 | Cash | ✓ | default cash-in-hand |
| 1010 | Bank | ✓ | may have sub-accounts per bank account |
| 1100 | Accounts Receivable | ✓ | mirrors `core.receivables` in aggregate |
| 1200 | Inventory | ✓ | mirrors stock valuation |
| 1300 | Prepaid Expenses | | optional, future |
| 1400 | Fixed Assets | | optional, future |
| 1900 | Undeposited Funds | | transient, MFS/pending clearance |

## 3.2 LIABILITY

| Code | Name | System | Notes |
|---|---|---|---|
| 2000 | Accounts Payable | ✓ | mirrors `core.payables` in aggregate |
| 2100 | Tax Payable | ✓ | system-posted VAT/sales tax collected |
| 2200 | Accrued Expenses | | future |
| 2300 | Customer Advances | | prepayment not yet allocated |

## 3.3 EQUITY

| Code | Name | System | Notes |
|---|---|---|---|
| 3000 | Owner's Capital | ✓ | opening entry target |
| 3100 | Retained Earnings | ✓ | period-close target |
| 3200 | Owner's Drawings | | optional |

## 3.4 INCOME

| Code | Name | System | Notes |
|---|---|---|---|
| 4000 | Sales Revenue | ✓ | |
| 4100 | Service Revenue | | optional module-driven |
| 4200 | Rental Revenue | | optional module-driven |
| 4900 | Other Income | | |

## 3.5 EXPENSE

| Code | Name | System | Notes |
|---|---|---|---|
| 5000 | Cost of Goods Sold (COGS) | ✓ | |
| 5100 | Discount Given | ✓ | contra-income, modeled as expense for simplicity |
| 5200 | Rent Expense | | tenant-editable category |
| 5300 | Salary Expense | | |
| 5400 | Utility Expense | | |
| 5500 | Inventory Shrinkage/Expiry Expense | | **Decision ACC-007.** System-posted only: unsellable customer-return write-offs and field-rep custody write-offs (`30`); it also serves the "auto-post stock-count variance" account of `09`. Not selectable as an expense-category account. |
| 5900 | Other Expense | | catch-all, mapped from `core.expense_categories`. **Decision ACC-007:** inventory write-offs used to share this code (an implementation choice, not specified by `30` VAN-005, which only added `1250`); they now post to `5500`, so the P&L shows the two as separate lines. **Existing tenants:** postings already made to 5900 are NOT moved (a posted entry is never edited; reclassification would need an adjusting journal, and manual journals are not built). An untouched 5900 account that still carries the old label is renamed by `migrations-manual/0013_split_other_expense_account.sql`; one that already has postings keeps its label. |

**Contra accounts:** `Discount Given` (5100) and `Discount Received` (credited within COGS/Purchase entries — see §5.2) are modeled as expense-side reductions rather than true contra-revenue accounts, to keep MVP reporting simple. This is flagged as an open question in §12.

---

# 4. Posting Rule Notation

Each rule below is expressed as:

```text
EVENT
  Dr  <Account>          <amount expression>
  Cr  <Account>          <amount expression>
```

All amounts are `Money` (decimal-safe, per `04` §64). Every posting rule produces exactly one `Journal` with ≥2 balanced `JournalEntry` rows (per `06` §5.14).

---

# 5. Posting Rules — Exhaustive Table

## 5.1 Sale Completed (`CompleteSaleUseCase`, `07` §7.6)

**Case A — Full cash sale (paidTotal = grandTotal):**

```text
Dr  Cash / Bank                  grandTotal
Dr  Discount Given                discountTotal   (if > 0)
    Cr  Sales Revenue             subtotal
    Cr  Tax Payable               taxTotal          (if > 0)

Dr  COGS                          costOfLinesAtCost
    Cr  Inventory                 costOfLinesAtCost
```

**Case B — Full or partial due (paidTotal < grandTotal):**

```text
Dr  Cash / Bank                  paidTotal
Dr  Accounts Receivable          dueTotal
Dr  Discount Given                discountTotal   (if > 0)
    Cr  Sales Revenue             subtotal
    Cr  Tax Payable               taxTotal          (if > 0)

Dr  COGS                          costOfLinesAtCost
    Cr  Inventory                 costOfLinesAtCost
```

**Note:** two separate `Journal` rows are posted per sale — one for revenue recognition, one for COGS/inventory relief — sharing the same `referenceType='SALE', referenceId=sale.id`, distinguished by `description`.

## 5.2 Purchase Received (`ReceivePurchaseUseCase`, `07` §8.3)

```text
Dr  Inventory                     costTotal (lines at cost, post-discount)
    Cr  Cash / Bank                paidTotal
    Cr  Accounts Payable           dueTotal
    Cr  Discount Received          discountTotal    (if > 0, reduces cost)
```

Tax on purchase (if input-tax-credit applicable — future scope, see `03` §55) is deferred; MVP treats purchase tax as part of cost.

## 5.3 Customer Payment Received (`RecordCustomerPaymentUseCase`, `07` §10.3)

```text
Dr  Cash / Bank                  payment.amount
    Cr  Accounts Receivable       amount allocated to open Sales
    Cr  Customer Advances          amount unallocated (advance/credit)
```

## 5.4 Supplier Payment Made (`RecordSupplierPaymentUseCase`, `07` §10.4)

```text
Dr  Accounts Payable              amount allocated to open Purchases
Dr  (Prepaid / Supplier Advance)  amount unallocated (if applicable, future)
    Cr  Cash / Bank                payment.amount
```

## 5.5 Customer Return (`CompleteCustomerReturnUseCase`, `07` §12.3)

```text
Dr  Sales Revenue                  returnedSubtotal
Dr  Tax Payable                    returnedTax        (if any)
    Cr  Accounts Receivable        returnedGrandTotal (if sale was on due)
    Cr  Cash / Bank                returnedGrandTotal (if sale was paid — refund)

Dr  Inventory                      returnedCostTotal
    Cr  COGS                       returnedCostTotal
```

`returnedSubtotal` excludes the original line/order discounts and tax;
`returnedTax` is reversed from the sale-line tax snapshot; and the cash or
receivable settlement equals `returnedGrandTotal = returnedSubtotal +
returnedTax`. Sale/purchase line snapshots persist each proportional
order-discount allocation so partial returns do not recalculate against
current prices or tax profiles. Partial returns allocate remaining amounts
proportionally to remaining quantity; the last return receives any rounding
remainder.

Proportional allocation between Receivable-reduction vs Cash-refund follows
the originating sale's paid/due ratio at the time of sale, unless the tenant
configures return refunds as always-cash (a tenant setting, per §44 `02`
distinction between rule and configuration). The current MVP still uses the
existing all-cash-or-all-receivable settlement choice; the ratio/configuration
policy remains open.

## 5.6 Supplier Return

```text
Dr  Accounts Payable / Cash        returnedGrandTotal (mirrors 5.5 logic)
    Cr  Inventory                  returnedCostTotal
```

For the current MVP, purchase tax is capitalized into Inventory (§5.2), so
supplier returns reverse the original net-of-discount inventory cost plus
its snapshotted purchase tax; both the liability/cash settlement and
Inventory credit use that returned grand total.

## 5.7 Expense Recorded (`RecordExpenseUseCase`, `07` §14.2)

```text
Dr  <Expense Category Account>     expense.amount
    Cr  Cash / Bank                expense.amount
```

**Decision EXP-001/EXP-002/EXP-003 (implemented -- `postExpenseJournal` in `apps/web/lib/accounting.ts`):** the debit account is the one the expense's category maps to (`core.expense_categories.account_id`, an active `EXPENSE` account of the tenant; `5000`/`5100` refused). Cash = account `1000` when `paid_via = CASH`, Bank = `1010` when `BANK`. The journal's `posted_at` is the expense date (12:00 UTC of `expense_date`) so a backdated expense is reported in its own period; the real wall-clock time remains on `journal_entries.created_at`.

## 5.8 Opening Entries (onboarding, per `03` §14)

```text
Opening Cash:
  Dr  Cash                         amount
      Cr  Owner's Capital          amount

Opening Bank:
  Dr  Bank                         amount
      Cr  Owner's Capital          amount

Opening Stock:
  Dr  Inventory                    amount
      Cr  Owner's Capital          amount

Opening Customer Receivable:
  Dr  Accounts Receivable          amount
      Cr  Owner's Capital          amount

Opening Supplier Payable:
  Dr  Owner's Capital              amount
      Cr  Accounts Payable         amount

Opening Capital (direct):
  Dr  <balancing account>          amount
      Cr  Owner's Capital          amount
```

**Rule:** opening entries are the *only* place where `Owner's Capital` is credited/debited directly by a use case other than period-close (§9). They run once per tenant at onboarding, each individually idempotent by `(tenantId, type, referenceId)`.

## 5.9 Reversal (any of the above, per `07` §12.3 / `03` §25)

```text
For any original Journal J with entries [(Dr A, x), (Cr B, x), ...]:
Reversal Journal J' = [(Cr A, x), (Dr B, x), ...]   -- exact mirror
J'.referenceType = 'REVERSAL'
J'.referenceId   = J.id
```

`AccountingPostingService.postReversalJournal` (per `07` §13.4) is the only code path allowed to generate a reversal — it reads the original journal's entries and swaps debit/credit mechanically, never recalculates from business state (to guarantee exact reversal even if business rules changed since original posting).

**Decision EXP-005 (implemented -- `postReversalJournal` in `apps/web/lib/accounting.ts`):** `postReversalJournal(tx, ctx, { originalJournalId, operationId, reason, postedAt? })` reads the original journal's entries and inserts their exact mirror on the same accounts (`J'.reference_type = REVERSAL`, `J'.reference_id = J.id`). It never recalculates. `posted_at` defaults to the **original's** accounting date, so the original period nets to zero (INV-ACC-006); the real wall-clock time stays on `journal_entries.created_at` and in the audit log. A reversal cannot itself be reversed (re-post the business event instead). `UNIQUE (tenant_id, reference_id) WHERE reference_type = 'REVERSAL'` (`journals_one_reversal_per_original`) makes "a journal is reversed at most once" a database fact. The caller must pass an operation id distinct from the original posting's (use `deterministicSubOperationId`). **When period closing (§9.4, INV-ACC-005) is built, a reversal that falls in a CLOSED period must instead take the first open date** -- using the original date is only valid while that period is open.

**Reversal date policy -- confirmed (2026-10-04, the owner instructed to proceed with the recommended defaults):** the reversal takes the ORIGINAL expense's accounting date, so correcting a mistake restores the period it belonged to ("as if it never happened") and a reversal followed by a corrected re-entry leaves that period right. The cost is that a report already viewed for that period can change. The alternative (reversal dated at the moment of reversal) keeps old reports frozen but leaves the wrong figure in the old period and shows a negative in the current one; it is a one-line change (`postedAt` argument of `postReversalJournal`) and is what must be used once period closing exists and the period is closed.

---

# 6. Financial Report Specifications

All reports are **pure read queries** against `core.accounts` + `core.journal_entries` (joined through `core.journals`), scoped by `tenant_id` and an optional `branch_id`/date range. None maintain independent stored state.

## 6.1 Trial Balance

```sql
-- Illustrative shape
SELECT a.code, a.name, a.type,
       SUM(je.debit)  AS total_debit,
       SUM(je.credit) AS total_credit
FROM core.journal_entries je
JOIN core.journals j ON j.id = je.journal_id
JOIN core.accounts a ON a.id = je.account_id
WHERE j.tenant_id = :tenantId
  AND j.posted_at BETWEEN :from AND :to
GROUP BY a.code, a.name, a.type
ORDER BY a.code;
```

**Validity check:** `SUM(total_debit) == SUM(total_credit)` across the whole result set — if this ever fails, it indicates a data-integrity incident, not a business scenario, and should raise an alert (per observability, `04` §75).

## 6.2 Profit & Loss (Income Statement)

```text
Revenue
  Sales Revenue
  Service Revenue
  Rental Revenue
  Other Income
  ── Total Revenue

Less: Cost of Goods Sold
  COGS
  ── Gross Profit = Total Revenue − COGS

Less: Operating Expenses
  Discount Given
  Rent / Salary / Utility / Other Expense (per category)
  ── Total Operating Expenses

── Net Profit = Gross Profit − Total Operating Expenses
```

Derived by summing `JournalEntry` rows for `INCOME`/`EXPENSE`-type accounts within the date range, `credit - debit` for INCOME accounts and `debit - credit` for EXPENSE accounts.

**Decision ACC-006 (implemented -- `apps/web/lib/use-cases/profit-loss.ts`, `getProfitAndLoss`):** single shared implementation of this section, used by the dashboard Profit Snapshot widget (`12` §8) and, when built, `GET /api/accounting/profit-and-loss` (`11` §14). COGS = account `5000`; every other `EXPENSE` account (including `5100` Discount Given and `5900` shrinkage/write-off) is an operating expense. Date range filters on `journals.posted_at` (UTC calendar days, same convention as the sales report). Exact bigint arithmetic, tenant-scoped via `withTenantTransaction`. **Known limits (documented, not hidden):** (1) `core.journals` has no `branch_id`, so the `?branchId=` filter in `11` §14 is NOT supported yet -- needs a schema decision; (2) the Expense use case now exists (Decisions EXP-001..003) so rent/salary/utilities are postable via `POST /api/expenses`, but there is no Expenses UI and no default categories at onboarding yet -- until a tenant starts recording expenses, Net Profit still omits them; (3) period-close entries (`08` §8, `accounting.close_period`) are not implemented -- when they are, closing journals MUST be excluded from this report (by `reference_type`) or the closed period will show zero profit.

## 6.3 Balance Sheet

```text
Assets
  Cash + Bank + Accounts Receivable + Inventory + Fixed Assets + ...
  ── Total Assets

Liabilities
  Accounts Payable + Tax Payable + ...
  ── Total Liabilities

Equity
  Owner's Capital + Retained Earnings (incl. current period net profit) − Drawings
  ── Total Equity

Check: Total Assets == Total Liabilities + Total Equity
```

Computed as a point-in-time snapshot (`asOfDate`), summing all `JournalEntry` rows from tenant inception through `asOfDate` for `ASSET`/`LIABILITY`/`EQUITY`-type accounts — current-period P&L is folded into Equity as unposted "current earnings" until a formal period close (§9) moves it into Retained Earnings.

## 6.4 Cash Flow Statement (simplified, direct method)

MVP approach — derived from `Cash`/`Bank` account `JournalEntry` rows only, categorized by `journals.reference_type`:

```text
Operating Activities
  + Cash from Sales/Customer Payments
  − Cash for Purchases/Supplier Payments
  − Cash for Expenses

Investing Activities
  (future — Fixed Asset purchase/disposal)

Financing Activities
  + Owner Capital Injection
  − Owner Drawings

Net Cash Flow = sum of above
```

Full indirect-method cash flow (reconciling from Net Profit) is deferred — flagged in §12.

## 6.5 Receivable / Payable Aging

Not a Journal-derived report — reads directly from `core.receivables`/`core.payables` (per `07` §11.2, `ReceivableAgingService`):

```text
Bucket by (asOfDate - dueDate or saleDate):
  Current (not yet due)
  1–30 days
  31–60 days
  61–90 days
  90+ days
```

---

# 7. Multi-Branch Consolidation

Per `03` §13 and open question §34 Q1 of `01`:

```text
Branch-level report = filter journal_entries by branch_id (via journals.reference → sale/purchase.branch_id)
Tenant-level report = omit branch_id filter (all branches combined)
```

**Design decision:** `core.journals` does not carry `branch_id` directly — it is derived via the `reference_id` join to the originating transaction (Sale/Purchase/etc.), which does carry `branch_id`. This avoids denormalizing branch onto every journal row while still enabling branch-level reports. Expense/opening-entry journals that are branch-specific must carry `branch_id` on their own reference row (`core.expenses.branch_id` already exists per `06` §5.13).

Consolidated multi-branch P&L/Balance Sheet is simply the tenant-level (unfiltered) report — no separate consolidation engine needed at MVP, since all branches share one Chart of Accounts.

---

# 8. Tax Handling (MVP Scope)

Per `03` §55 — MVP supports **No Tax** or **Single Tax** only.

```text
TaxProfile
├── id, tenantId, name, rate (percentage), isInclusive (boolean)
```

**Phase 2 implementation decision — tax-exclusive:** the listed sale price
and purchase cost are pre-tax. MVP profiles are exclusive (`isInclusive =
false`); inclusive pricing is not active. An item may have no profile (no
tax) or one profile (one non-compound tax). A profile's name and rate are
immutable after creation; create a new profile to use a changed rate. Each
purchase/sale line snapshots the profile ID, rate, and calculated tax amount
so later item assignment changes cannot rewrite transaction history.

Tax is calculated server-side to four decimal places using decimal arithmetic
and half-up rounding at the money scale. The taxable base is the line amount
after its line discount and a proportional allocation of any order discount.
The sale/purchase header total is `subtotal - discountTotal + taxTotal`.
Client-entered rates or tax amounts are never accepted.

**Posting impact:**

```text
Sale with tax:
  Cr  Tax Payable    taxTotal     (collected, owed to authority)

Purchase with tax (MVP — no input credit):
  tax folded into Inventory cost, no separate Tax Receivable
```

`Tax Payable` balance is what a tenant would remit — no automated remittance/filing at MVP (explicitly excluded, per `03` §85).

---

# 9. Period Closing

## 9.1 Concept

```text
Open Period (default — all transactions post freely)
     ↓
Period Close (optional, tenant-initiated)
     ↓
Locked Period (no new postings with occurred_at in this range)
```

## 9.2 `ClosePeriodUseCase`

```text
Input: tenantId, periodEnd date, actorPermissions (requires accounting.post + explicit close permission)

1. Verify no DRAFT sales/purchases remain with dates in the period (warn, don't block — tenant decides)
2. Compute period Net Profit (§6.2, bounded to period)
3. Post closing journal:
     Dr  Sales Revenue / Service Revenue / ...   (zero out period income)
     Dr / Cr  COGS / Expense accounts             (zero out period expenses)
         Cr  Retained Earnings                     net profit (or Dr if net loss)
4. Record core.accounting_periods row: status = CLOSED, closed_at, closed_by
5. Audit log
```

## 9.3 Locked Period Enforcement

Every posting use case (§5) checks: is `occurred_at`/`saleDate`/`purchaseDate` within a `CLOSED` period for this tenant? If so → reject with `PERIOD_LOCKED` error, unless actor has `accounting.reopen_period` permission (a deliberately rare, audited permission).

## 9.4 New Table: `core.accounting_periods`

```text
id, tenant_id, period_start, period_end,
status (OPEN/CLOSED), closed_at, closed_by,
created_at
```

**Unique:** `UNIQUE(tenant_id, period_start, period_end)`, non-overlapping ranges enforced at application layer.

**Note:** this table was not present in `06_DATABASE_SPECIFICATION.md` — flagged as an addendum; `06` should be revised to include it (see §13, Decision ACC-004).

---

# 10. Reversal & Adjustment Workflows — Detailed

## 10.1 Full Sale Cancellation (already-posted sale)

```text
CancelSaleUseCase (per 07 §7.7)
  → AccountingPostingService.postReversalJournal(originalSaleRevenueJournal)
  → AccountingPostingService.postReversalJournal(originalSaleCOGSJournal)
```

Both original journals for that sale get individually reversed — preserving full traceability (two originals in, two reversals out).

## 10.2 Manual Journal Adjustment

For cases outside the standard posting rules (rare correction, accountant-initiated):

```text
CreateManualJournalUseCase
  Input: entries[] (account, debit/credit pairs), description, actorPermissions

1. Require permission: accounting.post (elevated — not general staff)
2. Validate SUM(debit) == SUM(credit)
3. Validate no entry targets a CLOSED period
4. Persist Journal (referenceType = MANUAL_ADJUSTMENT)
5. Audit log — mandatory, flagged as sensitive (per §39, `03`)
```

Manual journals are the **only** posting path not triggered by a business Use Case in `07` — and therefore carry the strictest permission + audit requirement.

## 10.3 Correcting a Miscategorized Expense

```text
1. Original expense journal reversed (postReversalJournal)
2. New Expense record created with correct category
3. New journal posted normally via postExpenseJournal
```

No direct `UPDATE core.expenses.category_id` on a posted expense — this would silently change historical journal without an audit trail, violating §97/§25 (`04`/`03`) reversal-over-destructive-edit principle.

**Decision EXP-005 (implemented -- `reverseExpense`, `POST /api/expenses/:id/reverse`):** step 1 above is `ReverseExpenseUseCase`: one tenant transaction that posts the mirror journal, writes one `core.expense_reversals` row (who, when, why, which journal) and one audit entry carrying the reason. Step 2 is an ordinary `POST /api/expenses` (the UI offers "Enter the corrected expense next", which pre-fills the form). The original expense row is never touched; it stays in the history marked *Reversed*. An expense can be reversed once. Reversing needs the separate permission `expenses.reverse` (OWNER + MANAGER; not STAFF) and a mandatory reason of 3-500 characters.

---

# 11. Accounting Domain — Additional Invariants (supplementing `07` §13.3)

```text
INV-ACC-001: Every JournalEntry row has exactly one of {debit, credit} > 0, never both.
INV-ACC-002: A Journal always has >= 2 JournalEntry rows.
INV-ACC-003: No JournalEntry may reference an account with type mismatch to its
             posting rule (e.g. postSaleJournal never credits an EXPENSE account).
INV-ACC-004: System accounts (is_system_account=true) cannot change `type` post-creation.
INV-ACC-005: A CLOSED period accepts no new JournalEntry with occurred_at inside it,
             except the closing journal itself and explicitly authorized reopenings.
INV-ACC-006: Reversal journals always net to zero when combined with their original
             (sum of original + reversal entries per account = 0).
```

---

# 12. Open Accounting Questions

```text
1. Discount Given/Received modeled as Expense-side — should this instead be
   true contra-revenue/contra-COGS presentation in the P&L? (affects §3.5, §6.2)
2. Input VAT credit on purchases — deferred to future tax module (§8) — confirm
   this is acceptable for the first commercial vertical (Electronics + Service, per `03` §87)
3. Indirect-method Cash Flow — needed for MVP or deferrable to Phase 3+?
4. Should ClosePeriodUseCase be mandatory monthly, or fully optional/tenant-discretion?
5. Multi-currency chart of accounts hooks — add now as dormant fields or fully defer?
6. Does "Undeposited Funds" (1900) get used at MVP, or is it a Phase 2 refinement
   for MFS/cheque clearance timing?
7. accounting.reopen_period permission — who can hold it? Owner-only, or
   configurable per tenant?
```

---

# 13. Decisions Established by This Document

### Decision ACC-001
Chart of Accounts seed template (§3) is fixed at provisioning; system accounts are immutable in `type`, renamable/reparentable only.

### Decision ACC-002
Every business event that requires accounting effect posts through `AccountingPostingService` (`07` §13.4) inside the same transaction as the originating event — no exceptions among Sale/Purchase/Payment/Expense/Return.

### Decision ACC-003
Manual journal adjustments require the `accounting.post` permission distinct from general transaction-creation permissions, and are always audited.

### Decision ACC-004
`core.accounting_periods` is added to the canonical schema (amendment to `06_DATABASE_SPECIFICATION.md` §5.14) to support period closing.

### Decision ACC-005
Reversal journals are generated by mechanical debit/credit mirroring of the original journal's entries — never recalculated from current business state.

---

# 14. Next Document

পরবর্তী document:

`09_INVENTORY_ENGINE_SPECIFICATION.md`

এখানে Inventory domain (per `07` §9) আরও গভীরে বিস্তারিত হবে:

```text
Full stock movement type table with posting semantics
FEFO/FIFO/Serial/Reservation allocation algorithms (concrete pseudocode)
Multi-warehouse transfer detailed flow
Stock valuation method (weighted average vs FIFO cost — decision needed)
Reservation & release lifecycle for rental/booking integration
Concurrency & locking strategy in full detail
Stock reconciliation / physical count workflow
```
