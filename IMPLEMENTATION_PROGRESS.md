# Implementation Progress

**Purpose:** Track delivery against `Plan/28_IMPLEMENTATION_ROADMAP.md`. Update
this file for each completed milestone, code/documentation change, decision,
validation result, and blocker. The governing phase advances only after its
documented exit criteria have evidence.

## Current position — 2026-10-07

**Development direction:** Continue roadmap implementation locally; defer
external staging work until deployment/release readiness.

**Formal release gate:** Phase 1 — Platform Foundation is not formally exited.
The local Phase 1 code/test criteria have evidence, but isolated staging remains
open; this user-approved sequencing decision does not waive that criterion.

**Completed development milestone:** Phase 2 — Core Commerce. Its roadmap exit
criteria are locally verified and recorded below. Per the user's direction,
Phase 1 staging/release work remains deferred and does not block code-first
progression to Phase 3.

The repository contains substantial work beyond the current governed phase,
including Core Commerce and platform-operator surfaces. Their presence does
not by itself satisfy the roadmap's phase gates. Preserve existing behavior;
continue the next roadmap implementation milestone under the user's
code-first direction, while keeping unmet phase/release gates visible.

| Phase 1 exit criterion (`Plan/28` §4) | Current evidence | Status |
|---|---|---|
| User can register, log in, create a tenant, and become its Owner | New Playwright browser test completed signup, dashboard access, logout, and subsequent login against local Postgres | Verified locally |
| Membership, role, and permission resolve end-to-end | Same E2E test verified an ACTIVE workspace membership, `OWNER` role, and `reports.view` permission from `/api/auth/me` | Verified locally |
| Tenant Isolation Testing Matrix (`Plan/24` §5) passes for the Phase 1 slice | Real-Postgres use-case tests cover customer/supplier/item IDOR and RLS; Playwright now verifies Tenant A receives 403/`TENANT_ACCESS_DENIED` when selecting Tenant B without membership and that its active tenant stays unchanged. Non-Phase-1 matrix rows remain deferred to the phases that implement those capabilities | Verified locally for Phase 1 slice; staging still unverified |
| Shared-mode database routing works | Shared-mode registration and tenant-scoped RLS/use-case tests pass against local PostgreSQL; no staging-like acceptance yet | Verified locally |
| Development/staging topology is testable (`Plan/25` §§2–3; required by Phase 1) | Local Docker Compose works, but no isolated staging deployment/provider/domain is configured. User asked to defer staging for now | Blocked — staging deferred by user |

### Tenant-isolation matrix applicability

The matrix in `Plan/24` §5 also contains rows for files/object storage,
cache, background jobs, AI, automation/webhooks, offline queues, and dedicated
database routing. Those capabilities are not evidenced as implemented and are
not required to prove the Phase 1 shared-mode slice. They must be verified in
the phases that introduce them; they are not counted as passing here. The
current Phase 1 evidence covers shared-mode database isolation and real
customer/supplier/item use-case paths only.

### Current verification
- `pnpm -r test` — passed on 2026-10-07 (41 web test files, 461 tests; 1
  database RLS test).
- Focused Phase 2 regressions — 27 tests passed across FIFO/stock concurrency,
  weighted-average cost, taxes, customer/supplier settlement, returns, and
  sale cancellation.
- `pnpm -r typecheck` and `pnpm -r lint` — passed on 2026-10-07.
- `pnpm --filter web exec playwright test e2e/phase2-commerce.spec.ts
  --reporter=line` — passed on 2026-10-07 (2 browser tests), including
  Purchase → Stock → POS Sale → later Payment → Customer Due → Basic P&L,
  cancellation through the UI, and tax-profile/pricing setup. Test fixtures
  are cleaned up.
- `pnpm build` — passed on 2026-10-07. Next.js logged its dynamic-route notices
  while evaluating authenticated API routes; static generation and build
  completed successfully.
- `pnpm db:migrate` — passed locally; customer and supplier return settlement
  columns are present in local PostgreSQL.
- Local PostgreSQL and Redis Compose services were running during this check.
- No production or staging environment or backup restore was verified.

### Phase 2 exit evidence

| Phase 2 exit criterion (`Plan/28` §4) | Evidence | Status |
|---|---|---|
| Phase 2-owned financial-matrix rows pass | Real-Postgres tests cover sale/purchase payment allocation and advances, balanced tax/discount postings, proportional customer/supplier return settlement with rounding, return quantity boundaries, cancellation and exact reversal, idempotency, and P&L; see `apps/web/test/tax.integration.test.ts`, `return-condition.integration.test.ts`, `sale-cancellation.integration.test.ts`, `expense.integration.test.ts`, and `profit-loss.integration.test.ts` | Verified locally |
| FIFO inventory matrix passes for Phase 2 scope | Purchase/batch creation, FIFO consumption, batch-specific COGS, weighted-average recalculation, aggregate duplicate-line rejection, concurrent last-unit sale, and atomic return behavior pass against local PostgreSQL; see `field-sale.integration.test.ts`, `tax.integration.test.ts`, and `return-condition.integration.test.ts` | Verified locally |
| Commerce workflow works entirely through the UI | Playwright completed Purchase → Stock → POS Sale → later Payment → settled Customer Due → Basic P&L, then sale cancellation; see `apps/web/e2e/phase2-commerce.spec.ts` | Verified locally |
| Returns reverse historical discounts/tax and preserve partial rounding; paid-sale cancellation is decided and tested | Customer and supplier settlement use the originating paid/due ratio and cumulative four-place rounding; cancellation refunds allocated amounts and reverses remaining due, with integration and browser coverage | Verified locally |

The remaining full-platform inventory rows (FEFO, serial selection,
reservations, transfers, offline-origin conflicts, stock-count workflow, and
background reconciliation) are explicitly outside the Phase 2 FIFO baseline
and remain assigned to their roadmap-owning phases. Opening entries, period
close, and manual journal adjustments remain Phase 3 work. Phase 1 staging is
still a separate release gate.

### Immediate next work, in roadmap order

1. Continue Phase 3 — Accounting Depth under `Plan/28` §4. Trial Balance is
   now available as a verified first report slice; opening entries, the
   remaining financial reports, aging, manual adjustments, and period close
   remain unimplemented and must not be treated as complete.
2. Keep isolated staging (`Plan/25` §§2–3) deferred as non-code deployment
   work. Do not describe Phase 1 as formally exited until staging and all
   other required criteria are verified.
3. When staging becomes available, record deployment, environment isolation,
   health-check, and migration evidence here; then re-evaluate release
   readiness.

### Phase 3 — Accounting Depth (in progress)

- Implemented Trial Balance per `Plan/08` §6.1 and `Plan/11` §14 as a
  tenant-scoped query and `GET /api/accounting/trial-balance`, plus a date-
  filterable Finance workspace view. The report uses exact four-decimal
  arithmetic, verifies total debits equal total credits, and logs/surfaces an
  integrity error if the ledger is out of balance.
- Real-PostgreSQL coverage verifies account totals, inclusive date boundaries,
  tenant isolation, empty-ledger behavior, and the imbalance alert/error path:
  `pnpm --filter web exec vitest run test/trial-balance.integration.test.ts`
  passed (3 tests). `pnpm --filter web typecheck` and targeted ESLint passed.
- `pnpm build` passed on 2026-10-07; Next.js emitted dynamic-route notices for
  authenticated API routes, then completed the production build successfully.
- Branch filtering is intentionally not exposed: `core.journals` has no
  `branch_id` yet, and `Plan/08` §6.2 identifies that as requiring a schema
  decision. Other Phase 3 targets remain open.

## Work log

### 2026-10-07 — Phase 3 Trial Balance

- Added exact, tenant-scoped Trial Balance aggregation, the accounting.view-
  guarded report endpoint, and a date-filtered view in Finance.
- Verified inclusive date filtering, per-account totals, tenant isolation,
  empty-ledger output, and observable imbalance detection with real PostgreSQL.
- Validation: focused integration suite (3 tests), web typecheck, and targeted
  ESLint passed. Phase 3 remains in progress.

### 2026-10-07 — Phase 2 Core Commerce exit

- Completed the Phase 2 financial-matrix review and documented its boundary
  against Phase 3 in `Plan/28`; FEFO, serial allocation, reservations, transfer,
  offline conflicts, stock counts, and ledger reconciliation remain in their
  roadmap-owning phases.
- Implemented and tested cumulative paid/due-ratio settlement for both customer
  and supplier returns. Outstanding receivable/payable reductions are capped
  at the live balance; the residual is refunded, and partial-return rounding
  is assigned cumulatively at four decimal places. Updated `Plan/08` to record
  this Phase 2 policy.
- Added return settlement snapshot columns and migration
  `packages/db/migrations/0016_pretty_wiccan.sql` / `0017_parched_klaw.sql`.
  Supplier payments and supplier returns now lock purchase/payable rows in
  stable order, preventing concurrent payment/return over-allocation.
- Added real-Postgres coverage for cumulative customer refund/receivable
  rounding, supplier cash/payable splits, customer/supplier payment allocation
  and advances, FIFO and batch costing, purchase weighted-average cost,
  concurrent last-unit sale, return over-boundary rejection, and cancellation.
- Validation on 2026-10-07: `pnpm -r test` passed (41 web test files, 461
  tests; 1 database RLS test); focused Phase 2 regressions passed (27 tests);
  workspace typecheck, lint, production build, migration, and the two Phase 2
  browser acceptance tests passed. Phase 1 staging remains deferred and is not
  claimed as passed.

### 2026-10-06 — Baseline and execution tracking

- Added this persistent roadmap execution register at the user's request.
- Confirmed the roadmap's current governed phase is Phase 1; Phase 2+ code is
  already present but is not evidence that Phase 1's full exit gate passed.
- Ran workspace tests, type checks, lint, and browser E2E; local results are
  recorded above. Isolated staging remains unverified and deferred.
- Compared existing tests to `Plan/24` §5: real-Postgres tenant onboarding and
  customer/supplier/item isolation are covered; RLS is covered for
  `core.business_profiles`; active-tenant HTTP selection is tested with mocks
  and a real-browser E2E against local PostgreSQL.
- Added a Playwright E2E path for the Phase 1 registration/login/owner
  acceptance and its fixture cleanup. No production application behavior,
  schema, migration, or environment file was changed.
- Pre-existing report edits (`apps/web/app/reports/page.tsx`,
  `apps/web/lib/report-normalizer.ts`, and
  `apps/web/test/report-page-shape.test.ts`) were left untouched.

### 2026-10-06 — Phase 1 onboarding browser acceptance

- Added `@playwright/test`, a Chromium project config, and
  `apps/web/e2e/phase1-onboarding.spec.ts`.
- The test provisions a unique account via the real registration screen,
  verifies the returned active workspace, `OWNER` membership, and permission,
  logs out, then signs in again and verifies the protected dashboard.
- Test cleanup removes sessions before the test user's workspace to respect
  the active-tenant foreign key; it targets only the exact unique email
  created by that test run.
- Added the local E2E command to `README.md`.
- Validation: web typecheck/lint passed; `pnpm --filter web test:e2e` passed
  (1 test). Initial runner-command and missing-browser-library problems were
  corrected. An initial cleanup attempt exposed the session foreign key and
  was fixed before the passing run.
- Final sequential verification after the E2E assertion was expanded:
  `pnpm -r test` passed (442 web tests + 1 database RLS test),
  `pnpm -r typecheck` passed, `pnpm -r lint` passed, and
  `pnpm --filter web test:e2e` passed (1 browser test).
- Tightened E2E cleanup to delete only the exact unique account created by
  that run, and ignored generated Playwright test results. Re-ran E2E,
  workspace typecheck, and workspace lint after this change; all passed.
- Extended the same browser acceptance with a separately provisioned tenant:
  selecting it without membership returns 403/`TENANT_ACCESS_DENIED`, and
  `/api/auth/me` confirms Tenant A remains active. Full workspace tests
  passed again (442 web tests + 1 database RLS test); typecheck and lint passed.
- Phase 1 shared-mode tenant isolation and registration/login/RBAC criteria
  now have local integration/browser evidence. Phase 1 remains open because
  the isolated staging topology required by `Plan/25` §§2–3 is not established
  or verified.
- User elected to defer staging and complete the available local gates for
  now. Local Phase 1 acceptance is recorded as verified; the isolated-staging
  deployment requirement remains an explicit release blocker.
- User clarified that external, non-code deployment issues should not block
  continued software development. Updated this repository guidance to allow
  locally verified roadmap implementation to continue while retaining staging
  as an unmet release criterion. Phase 1 has not been declared complete.

### 2026-10-06 — Phase 2 audit and duplicate-line stock guard

- Audited the existing Phase 2 workflow and tests against
  `Plan/28` §4, `Plan/07`, `Plan/08`, `Plan/09`, and `Plan/24` §§3–4.
- Confirmed purchase/sale/payment/receivable/basic-P&L code paths exist, but a
  single end-to-end Purchase → Stock → Sale → later Payment → Due → P&L
  acceptance test and FIFO ordering evidence are still missing.
- Audit found sale stock availability was checked separately per line against
  the same balance, allowing duplicate lines to oversell in aggregate.
- Fixed `completeSale()` to aggregate demand by item/warehouse/batch, lock
  distinct balances in stable order, reject excess demand with
  `INSUFFICIENT_STOCK`, and preserve transactional rollback.
- Added a real-Postgres regression: 5 available units, duplicate lines of 3
  each; confirms rejection, unchanged balance, and no persisted sale or SALE
  movement.
- Validation: focused `field-sale.integration.test.ts` passed (9 tests);
  `pnpm -r typecheck` passed; `pnpm -r lint` passed; full `pnpm -r test`
  passed (38 web test files, 444 web tests, and the database RLS test).
- Duplicate-line oversell protection is complete and locally verified.
  FIFO allocation and complete commerce-workflow acceptance remain separate
  Phase 2 milestones. Phase 1 staging remains deferred as a release gate.

### 2026-10-06 — Phase 2 FIFO batch allocation

- Implemented automatic FIFO for non-expiry, batch-tracked stock, following
  `Plan/09` §4.1 and the Phase 2 scope in `Plan/28` §4. Expiry/FEFO, serial,
  and reservation allocation remain deferred to their roadmap phases.
- Sale demand is aggregated across duplicate lines; all candidate balance
  rows are locked in stable batch-ID order, then availability is consumed by
  `stock_batches.received_at ASC` (batch ID is the deterministic tie-breaker).
- A sale spanning batches is persisted as separate sale lines and stock
  movements. Line discounts/totals are apportioned without changing the
  original sale totals, and COGS uses each consumed batch's recorded cost.
- Updated the POS to stop requesting a manually typed batch ID for ordinary
  batch-tracked items; expiry-tracked items retain the existing explicit
  batch input. The server rejects a caller-supplied batch for FIFO-managed
  items instead of allowing it to bypass allocation order.
- Added a real-Postgres regression with two receipts at different dates and
  costs: a six-unit sale consumes five older units plus one newer unit,
  preserves the $13.33 line discount and $2,986.67 line total, leaves the
  expected balances, and posts $700 COGS from batch-specific costs.
- Validation: focused `field-sale.integration.test.ts` passed (10 tests);
  `pnpm --filter web typecheck` and `pnpm --filter web lint` passed; full
  `pnpm -r test` passed (38 web test files, 444 tests, and the database RLS
  test).
- The next Phase 2 milestone is the complete financial matrix and a browser
  acceptance for the Purchase → Stock → POS Sale → later Payment → Customer
  Due → basic P&L path.

### 2026-10-06 — Phase 2 commerce browser acceptance and finance fixes

- Added a real-browser flow that creates supplier, customer, and item fixtures,
  then completes Purchase → Stock → POS Sale with an initial partial payment →
  later customer payment → settled receivable → dashboard P&L through the UI.
  The test checks persisted purchase/sale/receivable values, stock ledger, and
  stock balance. Fixtures are tenant-scoped and removed after the run.
- The browser test exposed and fixed two production-path defects:
  - Drizzle runtime schema omitted `schema/relations.ts`, causing Finance
    receivable/payable relation queries to fail with `referencedTable`.
  - Payment allocation stored the receivable/payable row ID where subsequent
    updates look up by source sale/purchase ID; later payment rolled back with
    an undefined target. The allocation now retains the source transaction ID.
- Updated `Plan/28` to align Phase 2 finance gates with Phase 3 opening-entry,
  period-close, and manual-journal scope; tax remains a Phase 2 requirement.
- Validation: `pnpm --filter web exec playwright test
  e2e/phase2-commerce.spec.ts --reporter=line` passed (1 browser test);
  final `pnpm --filter web test:e2e` passed both Phase 1 and Phase 2 browser
  tests. `pnpm -r test` passed (38 web test files, 444 tests, and the
  database RLS test); workspace typecheck and lint passed.
- Remaining design blockers before Phase 2 can be called complete:
  tax profile/pricing semantics and `CancelSaleUseCase` treatment of already-
  received/allocated customer payments were unresolved. These affect financial
  behavior and will not be guessed. Staging remains a deferred release gate.

### 2026-10-06 — Phase 2 tax and return accounting

- Resolved `Plan/07` §21 Q6 and documented the Phase 2 pricing choice:
  listed sale prices and purchase costs are tax-exclusive; the server computes
  tax and purchase tax is capitalized into inventory cost.
- Added persisted proportional order-discount allocations on sale/purchase
  lines, plus return-header tax totals and return-line tax snapshots. The
  schema migration backfills historical order-discount allocations from the
  original transaction lines. The migration was applied locally; its
  backfill SQL was first syntax-checked in a rollback transaction, then
  applied to the local database.
- Updated customer returns to reverse net-of-discount sales subtotal and the
  original line tax into Tax Payable, and to settle the full returned total.
  Supplier returns reverse the original net acquisition value plus the
  capitalized purchase tax. Partial returns use remaining quantity/value and
  assign final rounding remainders to the last return.
- Serialized returns against source sale/purchase lines and reject duplicate
  source lines within one request, preventing concurrent or same-request
  over-return of a source line.
- Normalized API tax-rate and price values at both POS and Purchase UI
  boundaries. Purchase preview errors now display to the user instead of
  silently rendering missing totals.
- Added real-Postgres integration coverage for partial customer returns,
  balanced tax/revenue/refund journals, and supplier returns with discount
  allocation and tax capitalization. Targeted tax/return suites passed (6
  tests); the full workspace suite passed (450 web tests + 1 DB RLS test).
- Tax profile setup and tax-exclusive Purchase/Sale browser acceptance passed
  against the production server (2 Phase 2 browser tests); production build,
  workspace typecheck, lint, and `git diff --check` passed.
- The tax and return gates are locally complete. Sale cancellation remains
  blocked on the user's choice for sales with received/allocated payments;
  isolated staging remains a deferred Phase 1 release gate.

### 2026-10-06 — Sale cancellation and payment-settlement policy

- User decision: canceling a sale refunds the amounts paid toward that sale
  and reverses the unpaid due. Later payments allocated to other transactions
  or left as customer advances are not refunded by this cancellation.
- Added the idempotent `POST /api/sales/:id/cancel` flow with the existing
  `sales.cancel` permission, reason capture, append-only audit, exact reversal
  of sale revenue/COGS journals, stock restoration, and cancellation of the
  associated receivable. Original sale and payment records are retained.
- Refund records preserve each later payment's method; the original sale
  journal reversal handles the initial receipt so it is not refunded twice.
  Field sales and sales with completed returns are refused by this warehouse
  cancellation path.
- Serialized cancellation with customer payments and returns on the sale row;
  payment allocation now refreshes/locks receivables before posting to prevent
  concurrent over-allocation or reopening a cancelled sale.
- Added migration `0015_hesitant_jocasta.sql` for cancellation idempotency and
  applied it to the local database.
- Focused real-Postgres cancellation tests passed (6 tests), including paid,
  unpaid, later allocated payment, refunds, stock and receivable restoration,
  replay, cross-tenant protection, completed-return rejection, and concurrent
  payment allocation. Web typecheck, lint, `git diff --check`, and production
  build passed.
- Updated Phase 2 browser acceptance was attempted but the Next.js dev server
  refused connections during navigation; the cancellation UI browser flow
  remains unverified. The earlier Phase 2 browser results above predate this
  cancellation UI change.
