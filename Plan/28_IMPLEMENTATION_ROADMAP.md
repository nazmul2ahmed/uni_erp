# 28_IMPLEMENTATION_ROADMAP.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Implementation Roadmap
**Version:** 1.0 Draft
**Status:** Cross-Cutting System Deep-Dive — Synthesis Document
**Depends on:** All prior documents (`01`–`27`) — this document sequences their implementation, it does not introduce new architecture.

---

# 1. Purpose

এই document `03_MASTER_PROJECT_SPECIFICATION.md` §86-এর abstract Phase Roadmap (Phase 0–8)-কে একটি **concrete, dependency-aware, sequenced implementation plan**-এ রূপান্তর করে — এখন পর্যন্ত সম্পূর্ণ ২৭টি specification document-এর ওপর ভিত্তি করে।

```text
Build order — which module/document maps to which implementation
  milestone, and in what order
Dependency chain — what MUST exist before what can be built
First commercial vertical delivery sequence (Electronics + Service,
  per 03 §87)
Definition of Done applied per milestone (03 §91)
Team/workstream sequencing guidance
Risk register — carried forward from every document's own "Open
  Questions" section, consolidated
```

**Foundational rule carried forward (per `03` §76, restated as this document's organizing principle):**

> Development হবে: Documentation → Architecture → Specification → Implementation → Testing → Review → Release। এই sequence ইতিমধ্যে সম্পন্ন (`01`–`27`)। এই document সেই specification-কে actual build calendar-এ রূপান্তর করে — specification-এর কোনো সিদ্ধান্ত এখানে পরিবর্তন করা হবে না।

---

# 2. What This Document Is Not

```text
- Not a re-specification of any domain rule — every business/
  technical decision already made in 01-27 is treated as frozen
  input here (per 04 §170's Architecture Freeze Rule)
- Not a time/calendar estimate — this document sequences by
  DEPENDENCY, not by week/sprint number, since team size/velocity
  is an external variable this specification series does not control
- Not a task-tracker replacement — this is the dependency GRAPH a
  project-management tool (Jira/Linear/etc.) would be seeded from,
  not the tool itself
```

---

# 3. Global Dependency Graph — Document to Build-Order Mapping

```text
                    01, 02, 03  (Foundational — read, not built)
                          │
                    04, 05, 06  (Platform/Tenant/Database — Phase 1)
                          │
                    07, 08, 09  (Core Domain/Accounting/Inventory —
                                 Phase 2, the platform's spine)
                          │
                    10, 11       (Offline/Sync + API — Phase 2/4,
                                 API is continuous, Offline is a
                                 distinct sub-phase)
                          │
                    12, 13       (UX + Security — cross-cutting,
                                 threaded through every phase, not a
                                 single sequential block)
                          │
              ┌───────────┼────────────┐
              │           │            │
        14-18            19-21       22, 23
       (Optional        (Industry   (AI, Automation
        Modules)        Extensions)  — layered on top,
              │           │            not a hard
              └─────┬─────┘            dependency of
                    │                  MVP commerce)
              24, 25, 13(again)
           (Testing/Deployment/
            Security hardening —
            continuous, not a
            terminal phase)
                    │
                26, 27
           (Billing, Migration —
            required before FIRST
            paying/onboarding
            tenant, not before
            first LINE of code)
                    │
                   28 (this document)
```

**Key reading rule:** this graph shows *logical* dependency (what must be architecturally settled before what), not team-parallelism constraints. Multiple workstreams (§7) can and should run concurrently once Phase 1–2's spine is stable.

---

# 4. Phase Mapping — `03` §86 Made Concrete

## Phase 0 — Documentation (COMPLETE)

```text
01-27 constitute Phase 0's deliverable. This roadmap (28) is the
final Phase 0 artifact. Phase 0 is CLOSED once this document is
accepted — no further foundational-document authoring blocks
Phase 1 code from starting.
```

## Phase 1 — Platform Foundation

**Build targets, sourced from:**

```text
04 (stack freeze) -> repository scaffold (04 §129-132)
05 (multi-tenant) -> Auth, Tenant, Membership, RBAC (05 §173 Phase 1-3)
06 (database) -> control.* schema + core.* schema (Control Plane
                 tables first, per 06 §4, since nothing else can be
                 seeded without control.users/tenants/memberships)
13 (security) -> Authentication lifecycle (13 §2), Authorization
                 middleware shape (13 §3) — built alongside Auth,
                 not bolted on after
25 (deployment, §2-§6 only at this phase) -> Dev/Staging environment
                 topology, so Phase 1 work is testable in a
                 production-like shape from day one
```

**Phase 1 exit criteria (concrete, extends `05` §174's acceptance criteria):**

```text
[ ] A user can register, log in, create a tenant, become its Owner
[ ] Membership/Role/Permission resolve correctly end-to-end
[ ] Tenant Isolation Testing Matrix (24 §5) passes for this minimal
    slice — even before Sales/Inventory exist, the ISOLATION
    mechanism itself must already be proven, since every later
    phase depends on it being structurally sound, not retrofitted
[ ] Shared-mode database routing works (Dedicated routing, §5's
    Phase 4, is NOT required yet — per 05 §165's "Default new tenant
    = SHARED" rule, Dedicated is deliberately deferred)
```

## Phase 2 — Core Commerce

**Build targets, sourced from:**

```text
07 (core domain) -> Customer, Supplier, Item, Sales, Purchase,
                    Payment, Receivable, Payable use cases
08 (accounting)  -> Chart of Accounts seed (08 §3), Posting Rules
                    (08 §5) — built ALONGSIDE Sales/Purchase, not
                    after, since 07 §7.6/§8.3's Use Cases call
                    AccountingPostingService WITHIN their own
                    transaction (Decision DOM-003, 07 §20) — these
                    cannot be sequenced as "Sales first, Accounting
                    later" without violating that non-negotiable
09 (inventory)   -> Stock Movement ledger, Allocation Strategies
                    (FIFO minimum for MVP baseline; FEFO/Serial/
                    Reservation activate only once 19/20/21's
                    industries are reached, §5)
11 (API, Core
    endpoints only, §5-§16) -> REST surface for the above
12 (UX, Core
    screens only, §4-§8)     -> POS, Purchase, Customer/Supplier,
                              Dashboard screens
```

**Phase 2 exit criteria:**

```text
[ ] Financial Testing Matrix (24 §3) passes in full
[ ] Inventory Testing Matrix (24 §4) passes for FIFO (batch/serial/
    FEFO deferred to their owning phase, §5)
[ ] A tenant can complete: Purchase -> Stock -> POS Sale -> Payment
    -> Customer Due -> Basic P&L, entirely through the UI (03 §84's
    MVP Definition, now testable end-to-end)
```

## Phase 3 — Accounting Depth

```text
Already largely built AS PART OF Phase 2 (per Phase 2's note above
that Accounting cannot trail Sales/Purchase). This phase's REMAINING
scope, per 08:
  Period Closing (08 §9)
  Manual Journal Adjustments (08 §10.2)
  Trial Balance / P&L / Balance Sheet / Cash Flow report UI (08 §6,
    12 §4's report screens)
  Receivable/Payable Aging (07 §11.2, 08 §6.5)
```

## Phase 4 — Offline/PWA

**Build targets, sourced from `10`:**

```text
IndexedDB/Dexie client stores (10 §2)
Sync Engine state machine (10 §4)
Server sync API (10 §6) — push/pull, core.sync_operations,
  core.change_log (Decision SYNC-002)
Conflict resolution (10 §7)
Sync visibility UX (10 §10, 12 §11)
```

**Why Phase 4, not earlier:** offline sync's push endpoint calls the **identical** Use Cases already built in Phase 2 (Decision SYNC-001, `10` §14) — building Sync before Core Commerce exists would have nothing to sync against. This is a hard sequencing dependency, not merely a convenient grouping.

**Phase 4 exit criteria:**

```text
[ ] Offline/Sync Testing Matrix (24 §6) passes in full
[ ] A POS sale can be completed with no network connection, and
    correctly reconciles on reconnect, per 09 §8.4's conflict class
```

## Phase 5 — Modules

**Build targets, sourced from `14`–`18`, in the SAME dependency order those documents were authored (each explicitly built on the prior):**

```text
14 Quotation  -> first, since Service/Project/Booking's own
                 documents reference converting FROM an accepted
                 Quotation (14 §5.5b feeds 17 §5.1)
15 Service    -> second, introduces the non-double-deduction
                 pattern (15 §6) later modules reuse
16 Rental     -> third, depends on Booking CONCEPTUALLY (16 §3.1's
                 nullable bookingId) but does NOT require Booking to
                 be BUILT first (ad-hoc reservation works standalone,
                 per 16 §2) — so Rental can build in parallel with
                 or before Booking
17 Project    -> fourth, depends on Quotation (conversion target)
                 and Rental (cost-tagging, 17 §5.3) already existing
18 Booking    -> fifth in documentation order but has ZERO outbound
                 dependencies (18 §9, Decision BKG-005) — could
                 technically build FIRST or in parallel with anything
                 above; sequenced last here only because Rental/
                 Service's OWN standalone paths don't strictly
                 require it, so deferring it doesn't block anything
```

**Each module activates independently per `tenant_features`** — Phase 5 does not require ALL FIVE modules before ANY commercial tenant can go live; a tenant needing only Quotation+Service can launch once those two are done, without waiting on Rental/Project/Booking.

**Phase 5 exit criteria (per-module, extends each document's own §"Testing Obligations"):**

```text
[ ] Module & Extension Regression Matrix (24 §8), the relevant rows
    per module actually built
[ ] Each module's own cross-module orchestration rule (e.g. 15 §11,
    17 §10) verified — no module reaches into another's internal
    tables
```

## Phase 6 — Industry Extensions

**Build targets, sourced from `19`–`21`, and this phase is where the platform's first commercial vertical (§6 below) actually becomes sellable:**

```text
19 Pharmacy      -> narrowest (19 §1) — zero Optional Module
                    dependency, buildable as soon as Phase 2 (Core)
                    is done, does NOT need to wait for Phase 5
20 Electronics    -> needs Phase 2 (Core, serial tracking) fully,
                    and SOFT-depends on Service (15, Phase 5) — per
                    20 §9.1, Electronics without Service still works,
                    just without repair-detail annotation
21 Decorator      -> needs Phase 5's Quotation+Booking+Project+Rental
                    ALL FOUR complete (21 §1) — the platform's
                    widest-composition extension, correctly sequenced
                    LAST since it has the most upstream dependencies
```

**Critical parallelism insight (restated from `21` §12's closing note):** Pharmacy (`19`) can ship commercially **before** Phase 5 (Modules) is even started, since it needs zero Optional Modules. This means the roadmap is **not** strictly Phase-N-then-Phase-N+1 in wall-clock time — Phase 6's Pharmacy work can run in parallel with Phase 5's Module work, and this is the concrete reason `03` §35's template list puts both Pharmacy and Electronics+Service forward as early commercial candidates.

## Phase 7 — SaaS Platform

**Build targets, sourced from `05` (Dedicated mode), `25` (deployment automation), `26` (billing):**

```text
05's Dedicated Tenant routing (deferred from Phase 1, per §4's note)
25 §6.2's DedicatedTenantProvisioningJob
26's full Plan/Subscription/Usage/Payment Gateway/Dunning stack
```

**Why Phase 7, not Phase 1:** per `05` §165, "Default new tenant = SHARED" — Dedicated-mode infrastructure and full commercial billing are NOT required to onboard the platform's first pilot tenants (who can run Shared-mode, even on a manually-tracked/free trial basis during early validation). Building the full billing engine before there is a single paying tenant to bill would be premature per `04` §151's "Premature optimization করা হবে না" principle, generalized here to commercial infrastructure.

## Phase 8 — AI/Automation

**Build targets, sourced from `22`, `23`:**

```text
22 AI            -> Conversational Assistant (query-only, §5),
                    Document Intelligence/OCR (§6), Draft Generation
                    (§7) — each independently activatable
23 Automation     -> Rule engine (§3-§10), n8n/Webhook delivery (§8-9),
                    Notification adapters (§11)
```

**Why last, not first, despite being architecturally independent of Phase 5/6:** both `22` and `23` are explicitly **assistive** layers (per `01` §21's core AI principle and `04` §156's automation-after-truth principle) — they enhance an already-functioning business platform, they do not gate it. A tenant can run a complete, correct, audited business on the platform with ZERO AI or automation features enabled. Sequencing them last reflects this dependency reality, not a judgment that they are less valuable.

**Exception — Purchase OCR (`22` §6):** this specific AI capability is referenced as early as `01` §7 and `07` §8.4 as part of the CORE Purchase workflow's optional enhancement. Teams MAY pull `22` §6 (OCR only, not the full Assistant/Automation stack) earlier, into Phase 2/3, if the Electronics+Service commercial vertical's pilot tenants specifically request it — flagged as an explicit, documented exception to phase ordering, not a precedent for reordering the rest of Phase 8.

---

# 5. First Commercial Vertical — Concrete Delivery Sequence

Per `03` §87's designation of **Electronics + Service** as the first commercial validation target, this section sequences the MINIMUM slice of the full roadmap needed to sell that vertical:

```text
1. Phase 1 (Platform Foundation) — complete, unconditional
2. Phase 2 (Core Commerce) — complete, unconditional
3. Phase 4 (Offline/PWA) — complete BEFORE launch, since POS
   offline-capability is a core UX differentiator carried from the
   legacy Pharmacy PWA (01 §17-18) and explicitly required by 03 §84
4. Phase 5, Service module (15) ONLY — Quotation/Rental/Project/
   Booking are NOT required for this vertical (02 §30's Electronics
   domain composition is Retail+Inventory+Serial+Warranty+Service,
   nothing else)
5. Phase 6, Electronics extension (20) — depends on step 4 (soft
   dependency, 20 §9.1) being at least started
6. Phase 3 (Accounting Depth) — Period Closing/Manual Journals can
   trail slightly behind initial launch (a pilot tenant's FIRST
   month doesn't need Period Close yet), but Trial Balance/P&L
   should be ready at launch (basic financial visibility, 03 §84)
7. Phase 7, Shared-mode billing ONLY — full Dedicated-tier
   provisioning (25 §6.2) and the complete Dunning/Payment-Gateway
   stack (26 §7-9) are NOT required for a small number of
   hand-onboarded pilot tenants; a minimal Subscription record
   (manually created, status=ACTIVE, no live payment gateway wired
   yet) is sufficient to validate the commercial model before
   automating collection
8. Phase 8, OCR exception ONLY (per §4's flagged exception) — full
   AI Assistant/Automation deferred past first-vertical launch
```

**This sequence deliberately EXCLUDES:** Quotation (14), Rental (16), Project (17), Booking (18), Pharmacy (19), Decorator (21), Dedicated-tenant infrastructure (05/25's Dedicated path), full Billing/Dunning (26), and the AI Assistant/Automation engines (22/23 beyond OCR) — all remain valid, already-specified future work, simply not gating the first commercial release.

---

# 6. Workstream Parallelism Guidance

Once Phase 1–2's spine (§3–4) is stable, the following can run as **independent, concurrently-staffed workstreams** without blocking each other, based strictly on each document's own stated dependencies:

```text
Workstream A — Offline/Sync (10)          — depends only on Phase 2
Workstream B — Security Hardening (13)     — threaded throughout,
                                              never a separate phase
Workstream C — Service + Electronics
               (15, 20)                    — the first-vertical path
Workstream D — Quotation/Rental/Project/
               Booking (14, 16, 17, 18)     — the Decorator-vertical
                                              path, independently
                                              staffable once Phase 2
                                              is done
Workstream E — Pharmacy (19)                — independently staffable
                                              once Phase 2 is done,
                                              zero Module dependency
Workstream F — Deployment/CI-CD (25)         — must be ready BEFORE
                                              Phase 1 exit (a team
                                              cannot validate Phase 1
                                              exit criteria without a
                                              working staging
                                              environment), so this
                                              workstream actually
                                              STARTS before Phase 1's
                                              feature work, not after
Workstream G — Billing (26)                  — can start design/
                                              schema work early, but
                                              full implementation
                                              trails per §5's minimal-
                                              slice guidance
Workstream H — AI/Automation (22, 23)         — can start provider-
                                              adapter/plumbing work
                                              early (no business
                                              dependency), but
                                              feature completion
                                              trails per §4 Phase 8
```

**Rule:** no workstream above may merge a change that breaks the Tenant Isolation Testing Matrix (`24` §5) or the Financial/Inventory matrices (`24` §3–4) relevant to files it touches — the CI Gate Policy (`24` §11) applies identically regardless of which workstream authored the change.

---

# 7. Definition of Done — Applied Per Milestone

Restates `03` §91 as a per-phase-exit checklist, so "done" is never informally negotiated at delivery time:

```text
For each Phase's exit (§4's per-phase criteria are the DOMAIN-
specific instance of this general list):

[ ] Business Rule documented (already true — carried from 01-23)
[ ] Data model documented (already true — carried from 06 + module
    amendments)
[ ] API/use case documented (already true — carried from 07-23, 11)
[ ] UX documented (already true — carried from 12 + module UX
    sections)
[ ] Validation implemented (Zod + domain, per 04 §12)
[ ] Authorization implemented (guard chain, 11 §20, 13 §3)
[ ] Audit implemented (07 §15, per-module extensions)
[ ] Offline behavior defined (10, where applicable — some modules
    are explicitly NOT offline-eligible, per 10 §8.2)
[ ] Error handling implemented (11 §3's code catalog)
[ ] Unit tests (24 §2's Domain/Unit layer)
[ ] Integration tests (24 §2's Integration layer)
[ ] E2E tests where applicable (24 §2's E2E layer, advisory per
    24 §11.2 but still authored)
[ ] Documentation updated (this series itself — if implementation
    reveals a genuine specification gap, the amendment flag pattern
    already used throughout 14-23 applies: update the SOURCE
    document, don't silently diverge from it)
```

---

# 8. Consolidated Risk Register

Every prior document flagged its own "Open Questions" section. This section does not repeat them exhaustively (they remain individually authoritative in their source documents) — it groups them by **roadmap impact**, so the team knows which open questions genuinely block a phase versus which can be resolved during/after implementation.

## 8.1 Blocks Phase 1 (must resolve before foundational build starts)

```text
- None. Phase 1's scope (04-06, 13's auth shape) has no unresolved
  open question that blocks starting — all Phase 1 open items
  (e.g. 13 §14 Q1's exact session timeout) are placeholder-value
  items that can ship with a reasonable default and be tuned later.
```

## 8.2 Blocks Phase 2 (must resolve before Core Commerce ships)

```text
- 07 §21 Q2: Discount approval threshold — needed before
  DiscountExceededError's exact trigger point can be implemented
- 08 §12 Q1: Discount Given/Received as Expense-side vs true
  contra-revenue — affects P&L presentation shape, should be decided
  before the first Trial Balance/P&L report ships, not after
- 09 §13 Q2: Negative stock policy (forbidden vs tenant-configurable)
  — affects a core validation branch in AdjustStockUseCase/
  CompleteSaleUseCase, must be decided before those Use Cases are
  considered feature-complete
```

## 8.3 Blocks First Commercial Vertical Launch (§5) specifically

```text
- 03 §87 / commercial: exact pricing/plan limits for the pilot
  tenants (03 §174's explicit-product-approval category) — a
  business decision, not an engineering one, but it blocks §5 step 7
- 26 §14 Q5: does self-serve signup ship at MVP, or fully
  sales-assisted onboarding? Directly determines whether Phase 7's
  minimal-slice billing (§5 step 7) needs a public signup UI at all
- 22 §12 Q2 / 20 §12 Q2: barcode/IMEI camera scanning — flagged as
  "not MVP-mandated" repeatedly, but if pilot tenant feedback during
  Phase 6 (Electronics) surfaces this as a hard requirement, it
  re-enters scope; tracked here as a WATCH item, not currently
  blocking
```

## 8.4 Does Not Block Any Phase (safe to resolve opportunistically)

```text
- Every "Phase 2/3 refinement" flagged open question across
  09 §13 (rack/bin granularity, landed cost), 10 §15 (background
  sync platform matrix, peer-aware conflict UI), 16 §13 (late fee
  formula), 17 §13 (multi-currency projects), 18 §12 (composite
  bookings), 21 §11 (multi-day events), 23 §15 (OR-condition
  groups), 25 §13 (multi-region readiness) — all explicitly deferred
  in their own source documents as Phase 2+/future scope, and
  nothing in THIS roadmap depends on them being resolved earlier
  than their own document already scheduled.
```

---

# 9. Decisions Established by This Document

### Decision ROAD-001
Accounting (`08`) is built **concurrently with**, not after, Core Commerce (`07`)'s Sales/Purchase Use Cases — because those Use Cases call `AccountingPostingService` within their own transaction (Decision DOM-003, `07` §20), a "Sales first, Accounting later" sequencing would be architecturally incoherent, not merely inefficient.

### Decision ROAD-002
Offline/Sync (`10`) is sequenced strictly after Core Commerce (`07`–`09`) because the sync push endpoint invokes the identical Use Cases Core Commerce already builds (Decision SYNC-001, `10` §14) — there is nothing for Sync to synchronize against until Phase 2 exists.

### Decision ROAD-003
Pharmacy (`19`) and Electronics (`20`) may build in parallel with, or even ahead of, Phase 5's Optional Modules (`14`–`18`), since Pharmacy has zero Module dependency and Electronics has only a soft one (`20` §9.1) — Decorator (`21`) is the only Industry Extension that must wait for Phase 5's full completion, per its hard four-module dependency (`21` §1).

### Decision ROAD-004
The platform's first commercial vertical (Electronics + Service, `03` §87) requires only a defined minimal slice of the full roadmap (§5) — Dedicated-tenant infrastructure, full Dunning/Payment-Gateway automation, the AI Assistant, and the Automation rule engine are all explicitly deferrable past first launch without violating any prior document's non-negotiables.

### Decision ROAD-005
Deployment/CI-CD workstream work (`25`) begins **before**, not after, Phase 1's feature work, since Phase 1's own exit criteria (§4) require a working staging environment to validate against.

### Decision ROAD-006
Open questions across `01`–`27` are triaged by roadmap impact (§8), not treated as a single undifferentiated backlog — only items in §8.1–8.3 require resolution before their associated phase/milestone; §8.4 items are explicitly safe to resolve opportunistically without blocking any currently-planned work.

---

# 10. Open Roadmap Questions

```text
1. Team size/velocity is unknown to this specification series —
   should a companion (non-architectural) staffing/timeline document
   be produced once team composition is known, referencing this
   roadmap's dependency graph (§3) as its sole input?
2. Should Workstream parallelism (§6) be formally tracked in a
   project-management tool as a literal dependency graph import, or
   does this document's table remain the source of truth with manual
   translation?
3. Given §5's minimal-slice sequencing, should a SEPARATE lighter-
   weight "Pilot Launch Checklist" document be produced that only
   contains §5's steps + §8.3's blocking items, for a non-technical
   stakeholder audience distinct from this full roadmap?
4. Does `29_AI_CODING_PROTOCOL.md` (referenced in `03` §92's original
   Documentation Hierarchy but not yet authored) still belong in the
   series, given that `03` §77–78 and `04` §127–128 already establish
   the AI-coding guardrails at a principle level? Or has enough of
   that document's intended content already been distributed across
   existing documents that a dedicated `29` is now redundant?
```

---

# 11. Documentation Series — Closing Note

এই document দিয়ে Documentation Hierarchy (`03` §92)-এর মূল sequence — `01` থেকে `28` — সম্পূর্ণ হলো।

```text
01-03   Foundational (Audit, Domain, Master Spec)
04-06   Architecture (Platform, Multi-Tenant, Database)
07-09   Domain Engines (Core, Accounting, Inventory)
10-13   Cross-Cutting Core Systems (Offline/Sync, API, UX, Security)
14-18   Optional Modules (Quotation, Service, Rental, Project, Booking)
19-21   Industry Extensions (Pharmacy, Electronics, Decorator)
22-23   Intelligence & Automation Layers (AI, Automation)
24-27   Delivery Systems (Testing, Deployment, Billing, Migration)
28      This Roadmap (Synthesis)
```

**The platform's central architectural claim (`03` §97), restated one final time now that the full series is complete:**

> এটি কোনো Electronics ERP বা Decorator ERP নয়। এটি একটি Modular Multi-Tenant Business ERP Platform, যেখানে Core business primitives-এর ওপর capability modules এবং industry extensions বসে — এবং এই ২৮টি document মিলে সেই claim-কে শুধু vision হিসেবে নয়, বরং একটি traceable, dependency-ordered, testable build plan হিসেবে প্রমাণ করে।

Whether `29_AI_CODING_PROTOCOL.md` is authored as a discrete follow-on document (per §10 Q4's open question) is the one remaining decision before this specification series is considered fully closed.
