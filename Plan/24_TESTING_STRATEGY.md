# 24_TESTING_STRATEGY.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Testing Strategy Specification
**Version:** 1.0 Draft
**Status:** Cross-Cutting System Deep-Dive
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md` (§79–83, Testing Strategy/Financial/Inventory/Tenant Security/Offline Testing)
- `04_PLATFORM_ARCHITECTURE.md` (§122–125, Testing Stack/Test Pyramid/CI Pipeline/Linting)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§91–94, §162–164, Security Testing/Testing Model/Security Regression)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§19, Testing Obligations for This Layer)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§8, §12, Concurrency/Testing Obligations)
- `10_OFFLINE_SYNC_SPECIFICATION.md` (entire document — Offline Testing obligations scattered throughout)
- `13_SECURITY_SPECIFICATION.md` (§9, Tenant Isolation Security Testing — Concrete Test Matrix)
- `14`–`21` (each document's own §"Testing Obligations" section)
- `22_AI_ARCHITECTURE.md` (§10), `23_AUTOMATION_ARCHITECTURE.md` (§10)

---

# 1. Purpose

এই document platform জুড়ে ছড়িয়ে থাকা প্রতিটি "Testing Obligations" section (`07`–`23`)-কে একটি single, authoritative, **executable** test strategy-তে consolidate করে:

```text
Test pyramid — finalized layer definitions and ownership
Critical-path test matrices (Financial, Inventory, Tenant Isolation,
  Offline/Sync, Automation, AI) — one canonical checklist per domain,
  not 15 scattered lists
CI gate policy — what blocks merge unconditionally vs what is
  advisory
Test data / fixture strategy
Cross-module integration scenarios (the "full workflow" tests each
  module document already gestured toward, e.g. 21 §9's Decorator
  end-to-end test)
```

**Foundational rule carried forward (per `03` §79, restated as this document's organizing principle):**

> Critical domains (Accounting, Inventory, Payment, Tenant Isolation, Sync) সবচেয়ে বেশি test coverage পাবে — এবং সেই coverage কোনো module-এর নিজস্ব বিচ্ছিন্ন দায়িত্ব নয়, platform-wide non-negotiable gate।

---

# 2. Test Pyramid — Finalized

Per `04` §123, made concrete with ownership and tooling:

```text
                    E2E (Playwright)
                   /                \
          Integration (Vitest + real PostgreSQL)
             /                              \
      Domain/Unit (Vitest, no I/O)    API Contract (Vitest + supertest-
                                       style request against the app)
```

## 2.1 Layer Definitions

| Layer | Scope | I/O | Tooling | Speed |
|---|---|---|---|---|
| Domain/Unit | Pure functions: `SalePricingService`, `ReturnEligibilityPolicy`, `ConditionEvaluator` (`23` §6), `AllocationStrategy` implementations | None — no DB, no network | Vitest | Milliseconds, runs on every save |
| Integration | Use Case → Repository → real PostgreSQL (test database, per `04` §122's "শুধু mocks-এর ওপর নির্ভর করা যাবে না") | Real DB, mocked external providers (AI, email, webhook targets) | Vitest + test-DB fixtures | Seconds |
| API Contract | HTTP request → guard chain (`11` §20) → Use Case → response envelope (`04` §37) | Real DB + in-process HTTP | Vitest | Seconds |
| E2E | Full browser flow through real UI screens (`12`) | Real DB + real (test-mode) app | Playwright | Minutes, smallest suite |

## 2.2 Ownership Rule

```text
Every module document (07-23) is responsible for authoring its OWN
Domain/Unit and Integration tests as part of "Definition of Done"
(03 §91). This document does not re-author those tests — it defines
the SHAPE, the SHARED fixtures (§7), and the cross-cutting matrices
(§3-§6) that no single module document fully owns because they span
multiple modules by nature (e.g. tenant isolation touches every
tenant-scoped table at once).
```

---

# 3. Financial Testing Matrix (consolidates `03` §80, `07` §19, `08` §11)

**Mandatory before any release touching Sales/Purchase/Payment/Accounting.**

```text
[ ] Sale — full cash, exact-change
[ ] Sale — full due (0 paid)
[ ] Sale — partial payment (paidTotal between 0 and grandTotal)
[ ] Sale — with line discount, order discount, tax, all combined
[ ] Sale — rounding edge cases (fractional quantity × fractional
    price, per 04 §63-64 decimal-safety)
[ ] Sale cancellation — full reversal journal nets to zero (08 §11
    INV-ACC-006)
[ ] Customer/Supplier Return — exact-boundary quantity (=, >, <
    sold/purchased qty, per 07 §12.2)
[ ] Return refund vs receivable-reduction proportional split (08 §5.5)
[ ] Purchase — cash, due, partial, with discount
[ ] Customer/Supplier payment — full allocation, partial allocation,
    unallocated advance (07 §10.2 invariant)
[ ] Expense recording + correct category account posting
[ ] Opening entries — each of the 6 types (08 §5.8), idempotent by
    (tenantId, type, referenceId)
[ ] Every AccountingPostingService method produces SUM(debit) ==
    SUM(credit) (08 §11 INV-ACC-001/002)
[ ] Reversal journal — mechanical debit/credit mirror, never
    recalculated from current state (08 §5.9, Decision ACC-005)
[ ] Period close — locks postings with occurred_at inside the closed
    range; PERIOD_LOCKED surfaces correctly (08 §9.3)
[ ] Manual journal adjustment — requires accounting.post permission,
    rejects unbalanced input before persistence (08 §10.2)
[ ] Idempotency — replaying any financial mutation's operationId
    never double-posts (07 §17, 07 §19)
```

---

# 4. Inventory Testing Matrix (consolidates `03` §81, `09` §8, `09` §12)

**Mandatory before any release touching Inventory/Sales/Purchase stock effects.**

```text
[ ] Purchase → stock movement posts correctly, batch/serial created
    where applicable
[ ] Sale → stock deduction, correct AllocationStrategy invoked per
    item.tracking flags (09 §4.6)
[ ] FEFO ordering correctness — earliest expiry consumed first,
    including same-expiry-date tie-breaking (09 §4.2)
[ ] FIFO ordering correctness — earliest received consumed first
    (09 §4.1)
[ ] Serial allocation — no auto-pick, explicit selection required,
    SERIAL_CONFLICT on unavailable serial (09 §4.3)
[ ] Reservation allocation — Booking-window overlap correctly blocks
    (09 §4.4, cross-references 18 §10)
[ ] Transfer — atomic TRANSFER_OUT + TRANSFER_IN, both-or-neither
    (09 §5.1)
[ ] Concurrent sale against last unit — exactly one succeeds, the
    other gets INSUFFICIENT_STOCK, row-lock ordering prevents
    deadlock on multi-line transactions (09 §8.2-8.3)
[ ] Offline-origin stock conflict — late-synced offline sale against
    now-depleted stock surfaces as FAILED sync status, no silent
    auto-adjustment (09 §8.4, cross-references 10 §7)
[ ] Weighted Average Cost recalculation on each PURCHASE movement
    (09 §6.1)
[ ] Specific-identification costing for batch/serial items at Sale
    time (09 §6.3)
[ ] Stock Count — variance correctly posts ADJUSTMENT_IN/LOSS, never
    a direct balance UPDATE (09 §9.3)
[ ] Background reconciliation job — corrects drift between cached
    balance and full ledger fold without writing new movements
    (09 §10)
[ ] Return — stock reversal + financial effect happen atomically,
    never stock-only (07 §12.3, 01 §10)
```

---

# 5. Tenant Isolation Testing Matrix (consolidates `05` §91–94, §162–163, `13` §9.1 — the authoritative version)

**Non-overridable CI gate on every PR to `main` (per `13` §9.3, `05` §163) — this specific matrix supersedes/consolidates every duplicate list scattered across `05` and `13`.**

```text
[ ] Tenant A session cannot read Tenant B's customer/supplier/item/
    sale/purchase/etc. via direct ID substitution (IDOR) -> 404, never
    403 (13 §3.2, Decision SEC-001)
[ ] Tenant A cannot select Tenant B as activeTenantId without a
    Membership row -> 403 at /auth/tenant/select
[ ] Tenant A operationId reused against Tenant B's endpoint does NOT
    replay across tenants (UNIQUE(tenant_id, operation_id), 06 §9)
[ ] Tenant A file download-url request for Tenant B's document
    object key -> 403/404, never a valid signed URL
[ ] Tenant A cache key collision test — tenant:{id}: prefix isolation
    (05 §34)
[ ] Tenant A background job payload never resolves against Tenant
    B's database connection (05 §113-114)
[ ] Tenant A AI request context never includes Tenant B data, even
    under a crafted prompt (05 §39, §130, 22 §10)
[ ] Tenant A automation rule never fires against a Tenant B event,
    and Tenant A's webhook/n8n payload never contains Tenant B data
    (23 §4, §9 — new for this consolidated matrix)
[ ] Offline: Tenant A pendingOperations queue never appears under
    Tenant B's active queue on tenant switch (05 §45-47, 10 §3)
[ ] Webhook signature from a forged/replayed source is rejected
    (05 §41, 23 §9.2)
[ ] Unknown/unresolvable tenant fails closed at every guard step —
    no default-allow branch anywhere (05 §159, 13 §3.3, Decision
    SEC-002)
[ ] Dedicated-tenant database router never misroutes a query to the
    wrong tenant's database (05 §106-108, connection metadata
    verification)
```

---

# 6. Offline/Sync Testing Matrix (consolidates `10`, scattered throughout)

```text
[ ] Offline create (Customer/Supplier) syncs correctly, LOCAL- id
    resolved to canonical id on dependent operation sync (10 §5.2-5.3)
[ ] Offline sale — full flow: local save, optimistic receipt, queue,
    sync, canonical invoice number assigned (10 §2.1, 04 §95)
[ ] Reconnect after extended offline period — full queue drains in
    createdAt order, no reordering (10 §5.2)
[ ] Retry — retryable error classes (5xx, timeout) back off correctly
    and eventually succeed or hit PERMANENTLY_FAILED at maxAttempts
    (10 §4.2)
[ ] Duplicate request — idempotency replay returns stored result
    without re-execution (10 §7, core.sync_operations)
[ ] Server rejection (business rule) — surfaces as FAILED, requires
    manual review, no silent retry (10 §7 Business Rule Failure class)
[ ] Permission changed while offline — operation rejected with
    PERMISSION_DENIED on sync, non-retryable (10 §7)
[ ] Stale master data (Customer/Supplier/Item edited on two devices)
    — last-write-wins + APPLIED_WITH_CONFLICT flag when fields
    diverge non-trivially (10 §7.1)
[ ] Financial/transactional entity — NEVER last-write-wins, confirmed
    via a deliberate attempted-conflict test (10 §7.1, Decision
    SYNC-004)
[ ] Device restart / browser restart — pendingOperations persist and
    resume correctly (IndexedDB durability)
[ ] Tenant switch while offline operations pending — Tenant A's queue
    untouched, Tenant B's queue loads independently (10 §3)
```

---

# 7. Automation & AI Testing Matrix (consolidates `22` §10, `23` §10)

```text
Automation (23):
[ ] AutomationEngine.handleEvent runs async, outside the originating
    transaction — a rule/action failure never rolls back or delays
    the source business transaction (23 §10.1, Decision AUT-004)
[ ] No action type can invoke a Core financial/stock mutation —
    verified via a fixed, closed inventory of action-type
    implementations (23 §4.3, Decision AUT-001)
[ ] Webhook delivery retry/backoff/dead-letter matches the specified
    schedule; signature verification detail is correct (23 §9.1-9.2)
[ ] Periodic event dedup — ExpiryApproaching/WarrantyExpiring fire
    exactly once per threshold-band crossing, not once per daily
    scan (23 §9.3)

AI (22):
[ ] AI request for Tenant A's context never includes Tenant B data,
    even under a crafted prompt (22 §10, also folded into §5 above)
[ ] Assistant responses to factual/numeric questions always
    originate from a tool call result, never unprompted generation
    (22 §5.1, §5.3)
[ ] Permission-filtered tool catalog — a Cashier-role actor never
    sees accounting.view-gated tools (22 §4.1 step 3)
[ ] OCR human-confirmation gate — no code path allows extracted_data
    to reach ReceivePurchaseUseCase without ConfirmPurchaseFromOCRUseCase
    (22 §6.1, 07 §8.4, 11 §9 — three-document non-negotiable, tested
    once here as the canonical regression test)
[ ] Extraction schema parity — AI extraction schema identical to
    manual Purchase form schema, not independently drifting copies
    (22 §6.1 step 2, Decision AI-004)
[ ] AI rate limit / plan-quota enforcement — rejected before reaching
    the provider, fail-closed (22 §8.2)
```

---

# 8. Module & Extension Regression Matrix

Every Optional Module (`14`–`18`) and Industry Extension (`19`–`21`) document already specifies its own obligations; this section only records the **cross-cutting regression class** each introduced, so it is never lost in a single module's own section:

```text
[ ] Quotation (14): converting an ACCEPTED quotation never
    double-creates a Sale/Project on operationId replay
[ ] Service (15): the non-double-deduction test — invoicing a
    completed ServiceOrder produces exactly ONE stock movement per
    part (the original CONSUMPTION), never two
[ ] Rental (16): no COGS/Inventory posting on Rental Close journals
    (§6.4) — Rental assets are never valued like Sale stock
[ ] Project (17): a Purchase/Expense/RentalOrder tagged to a project
    posts exactly ONE accounting journal, not a duplicate via
    RecordProjectCostUseCase (§6.4, the same non-double-posting class
    as Service's, applied to accounting instead of inventory)
[ ] Booking (18): overlap prevention — two concurrent booking
    requests for the same resource/window, exactly one succeeds
    (EXCLUDE constraint + application check, §4)
[ ] Pharmacy (19): CompleteSaleUseCase execution path shows ZERO
    behavioral difference for a non-Pharmacy tenant (extension-point
    isolation regression)
[ ] Electronics (20): same extension-point isolation regression,
    applied to the warranty auto-issuance hook
[ ] Decorator (21): each of Quotation/Booking/Project/Rental's own
    existing test suites pass completely UNMODIFIED with the
    Decorator extension active (21 §9, "Extension independence")
```

**Rule (restated as Decision TST-001, §13):** every extension-point regression test above (Pharmacy, Electronics, Decorator's "isolation"/"independence" tests) is run in CI against the **shared** Core/Module test fixtures (§9), not against extension-specific fixtures — a passing isolation test on stale/mocked Core behavior would give false confidence.

---

# 9. Test Data / Fixture Strategy

## 9.1 Fixture Tenants

```text
Every integration/API/E2E test suite operates against at least TWO
seeded tenants (mirrors 05 §111's "tenant-a-test, tenant-b-test"):

  tenant-a-test   — primary fixture, full Core + all Optional
                    Modules + no Industry extension (generic retail
                    baseline)
  tenant-b-test    — isolation-counterpart, minimal data, used ONLY
                    to prove tenant-a-test cannot see it (§5's matrix)
  tenant-pharmacy-test, tenant-electronics-test, tenant-decorator-test
                    — one per Industry Extension, seeded with that
                    extension's template (03 §35) and module set,
                    used for the extension's own regression suite (§8)
```

## 9.2 Fixture Data Principles

```text
- Deterministic — fixture creation scripts produce identical data
  every run (no random dates/amounts that could flake a boundary
  test, e.g. return-quantity-exact-boundary tests need EXACT
  reproducibility)
- Minimal — a test's fixture setup includes only what that test
  needs; shared "mega-fixtures" that every test partially depends on
  make failures hard to isolate (violates 04 §86's "no god utility"
  principle, applied to test data)
- Seed via the SAME Use Cases as production onboarding (05 §112 —
  "Seed script tenant context ছাড়া tenant-owned data create করবে
  না") — fixtures are created via CreateCustomerUseCase,
  ReceivePurchaseUseCase, etc., never via direct SQL INSERT bypassing
  domain validation, so fixture data is guaranteed valid by
  construction
```

## 9.3 External Provider Mocking

```text
AI Provider (22 §3): mocked in Integration/API tests with
  deterministic tool-call responses; a SEPARATE, smaller "live
  provider" smoke-test suite (not part of the main CI gate, run on a
  schedule) validates the real provider integration still works,
  since live-model output is inherently non-deterministic and
  unsuitable for a blocking gate.

Webhook/n8n targets (23 §9): a local mock HTTP server captures
  delivered payloads for assertion; retry/backoff timing tests use
  a fake clock (no real multi-minute waits in CI).

Email/SMS/Telegram adapters (23 §11): mocked at the adapter interface
  boundary — tests assert the adapter was CALLED with correct
  arguments, not that a real message was delivered.

Object storage (04 §56): a local/in-memory S3-compatible mock for
  Integration tests; a smoke test against real object storage runs
  separately, same rationale as the AI provider split above.
```

---

# 10. Cross-Module Integration Scenarios

These are full end-to-end (or near-E2E, Integration-layer) scenarios spanning multiple modules — the concrete tests each module document referenced but which no single module document can fully own.

```text
[ ] Full Decorator workflow (21 §9's 9-step sequence): Quotation →
    Project → Event Details → Booking → Rental Reserve/Dispatch/
    Return/Close → Milestone Invoice → Labour → Complete → correct
    GetProjectProfitabilityUseCase result
[ ] Electronics repair-to-invoice: Sale with serial-tracked item →
    ServiceOrder → parts consumption (CONSUMPTION) → invoice
    (delegates to Sale, non-double-deduction verified) → Warranty
    auto-issued
[ ] Pharmacy full retail cycle: CreatePharmacyItemUseCase → Purchase
    with batch/expiry → FEFO-driven POS sale → PrescriptionRequirementPolicy
    enforcement toggled on/off → expiry alert correctly surfaces the
    batch as it approaches threshold
[ ] Offline-to-online reconciliation under contention: two devices
    (one offline, one online) both attempt to sell the last unit of
    an item; the online sale succeeds immediately, the offline sale
    later syncs and correctly surfaces INSUFFICIENT_STOCK per 09 §8.4
[ ] Multi-tenant concurrent load: Tenant A and Tenant B simultaneously
    run POS sales, purchases, and payments — no cross-tenant data
    bleed, no cross-tenant idempotency collision, no performance
    degradation attributable to noisy-neighbor effects (05 §98)
```

---

# 11. CI Gate Policy

Extends `04` §124 with concrete blocking/advisory classification.

## 11.1 Blocking (merge is impossible if any of these fail)

```text
- Lint, Typecheck (strict mode, 04 §125)
- Domain/Unit tests — full suite
- Integration tests — full suite (real test-DB)
- API Contract tests — full suite
- Tenant Isolation matrix (§5) — unconditional, no override path
  (05 §163, Decision SEC-005 restated)
- Financial Testing matrix (§3) — for any PR touching sales/
  purchase/payment/accounting/returns modules
- Inventory Testing matrix (§4) — for any PR touching inventory/
  sales/purchase modules
- Build (production build must succeed)
```

## 11.2 Advisory / Scheduled (does not block merge, monitored separately)

```text
- E2E (Playwright) full suite — runs on merge to main and nightly,
  not on every PR (too slow to gate every commit); a FAILING E2E
  suite on main blocks the NEXT deploy, not the triggering PR itself
- Live AI provider smoke tests (§9.3)
- Live object storage smoke tests (§9.3)
- Performance/load tests (baseline per 04 §151 — not a hard gate at
  MVP, monitored for regression trend)
```

## 11.3 Path-Based Matrix Selection

```text
CI determines which of §3/§4/§7/§8's matrices are mandatory for a
given PR based on changed file paths (e.g. a PR touching only
modules/rental/* triggers Rental's own regression suite (§8) plus
the always-mandatory Tenant Isolation matrix (§5), but not the full
Pharmacy extension suite unless shared Core files were also touched)
— this keeps CI runtime proportional to change scope while never
skipping the platform-wide non-negotiables (§5, §11.1).
```

---

# 12. Testing Anti-Patterns — Explicitly Rejected

```text
1. Mocking the database in Integration tests (04 §122 — "শুধু
   mocks-এর ওপর নির্ভর করা যাবে না") — Integration tests use a real
   PostgreSQL test instance, always.
2. Testing tenant isolation only "when convenient" or only before a
   major release — it is a per-PR gate (§11.1), not periodic (05 §163).
3. Snapshot-testing entire API responses for financial endpoints
   without asserting the underlying invariant (e.g. debit=credit) —
   a snapshot can pass while silently encoding a wrong number if the
   snapshot itself was captured from buggy output; financial tests
   assert invariants and exact expected values, not "matches last
   run."
4. Skipping the exact-boundary case in favor of only "clearly valid"
   and "clearly invalid" inputs — every quantity-limit test (returns,
   discounts) MUST include the `=` boundary, not just `<` and `>`
   (07 §12.2, restated as a testing-methodology rule here).
5. Sharing mutable fixture state across tests within a suite (a test
   that depends on execution order is a flaky test waiting to happen)
   — every test creates its own isolated fixture data or resets
   state explicitly.
```

---

# 13. Decisions Established by This Document

### Decision TST-001
Extension-point isolation/independence regression tests (Pharmacy `19`, Electronics `20`, Decorator `21`) always run against the shared Core/Module test fixtures (§9), never extension-specific mocks — ensuring the "zero behavioral difference for non-extension tenants" claim is verified against real, current Core behavior.

### Decision TST-002
The Tenant Isolation Testing Matrix (§5) is the single canonical version of this checklist platform-wide, superseding the partially-overlapping lists in `05` §91/§162 and `13` §9.1 — those documents' lists are considered historical drafts folded into this one.

### Decision TST-003
CI blocking scope (§11.1) is path-based (§11.3): the Tenant Isolation matrix and the core test suites are always mandatory; Financial/Inventory matrices are mandatory only for PRs touching their respective domains, keeping CI runtime proportional to change scope without ever skipping platform-wide non-negotiables.

### Decision TST-004
Live external-provider tests (AI, object storage) are explicitly advisory/scheduled, never part of the blocking merge gate, because non-deterministic third-party behavior is unsuitable for a hard gate — correctness against these providers is validated via mocked contract tests in the blocking suite instead (§9.3).

### Decision TST-005
Exact-boundary test cases (quantity `=` limits, threshold crossings) are a mandatory testing-methodology requirement for every domain policy that enforces a numeric limit — a test suite covering only clearly-valid and clearly-invalid inputs is incomplete by definition (§12 point 4).

---

# 14. Open Testing Questions

```text
1. Test database provisioning strategy for CI — one shared test-DB
   instance reset between runs, or ephemeral per-PR database
   containers (affects CI cost/speed tradeoff, per 04 §117's cost
   philosophy)?
2. E2E flakiness budget — what retry/quarantine policy applies to a
   Playwright test that fails intermittently, before it's treated as
   a genuine regression vs infrastructure noise?
3. Load/performance testing cadence — scheduled nightly, pre-release
   only, or continuously trend-monitored (§11.2)? No baseline SLA is
   fixed yet (04 §151 defers this explicitly).
4. Mutation testing (verifying the test suite itself catches
   deliberately-introduced bugs) — worth adopting for the Financial/
   Inventory domains given their criticality, or deferred as
   process-maturity overhead not justified at MVP team size?
5. Should the Cross-Module Integration Scenarios (§10) be authored
   and owned by a single "platform QA" concern, or split and
   co-owned by each contributing module's maintainers? Affects how
   `28_IMPLEMENTATION_ROADMAP.md` sequences this work.
```

---

# 15. Next Document

পরবর্তী document:

`25_DEPLOYMENT_ARCHITECTURE.md`

এখানে deployment architecture বিস্তারিত হবে — `04` §69–78, §117–118-এ যা baseline হিসেবে নির্ধারিত হয়েছিল (Docker, VPS, single-region, no Kubernetes at MVP) তার concrete, বাস্তবায়নযোগ্য রূপ:

```text
Environment topology (dev/staging/production, per 04 §67)
Docker image build/publish pipeline
Database provisioning (shared cluster + dedicated-tenant provisioning
  automation, per 05 §48-56)
Secrets injection at deploy time (concretizing 13 §7's categories)
Zero/low-downtime deployment strategy
Rollback procedure (concretizing 04 §169)
Health check / readiness wiring for the reverse proxy (04 §76)
Backup/restore automation (concretizing 04 §99-100, 05 §63-64)
Observability stack wiring (concretizing 04 §75, 13 §8)
```
