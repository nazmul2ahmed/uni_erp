# 17_MODULE_PROJECT.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Project Module Specification
**Version:** 1.0 Draft
**Status:** Optional Module Deep-Dive
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§28–29, Project & Decorator Domain)
- `06_DATABASE_SPECIFICATION.md` (§6.5, `modules.projects` / `project_costs` / `project_invoices`)
- `08_ACCOUNTING_ENGINE_SPECIFICATION.md` (§5, extended here with cost-category posting rules)
- `14_MODULE_QUOTATION.md` (§5.5, conversion source)
- `16_MODULE_RENTAL.md` (§6, damage/asset accounting pattern reused here)

---

# 1. Purpose

এই document Optional Module series-এর চতুর্থ — `Project` module-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities & invariants
Project lifecycle
Cost category model & their individual accounting posting rules
Milestone billing
Profitability calculation
Use cases
Database detail (beyond the 06 stub)
API contract detail (beyond the 11 stub)
UX flow
Cross-module orchestration (Project <- Quotation, Project -> Rental,
  Project -> Sales/Invoice, Project -> Accounting)
```

**Module classification (per `02` §40, §53):** Optional Module. The primary vertical for this module is Decorator/Event (`02` §29) and any project-based business (construction, interior, marketing agency, software agency — `02` §2.4), but it is not Decorator-specific — Decorator is composed *from* this module plus Rental plus Booking (per `02` §29's explicit composition list).

---

# 2. Why Optional, Not Core

A retail or single-transaction service tenant never accumulates multi-week cost tracking against a single customer commitment. Project exists specifically for businesses where **revenue and cost are recognized over an extended engagement**, not at a single point-of-sale moment. Enabled via `tenant_features.project = true` (`06` §4.7).

```text
Sales Domain (Core) ←──────────┐
        ↑                       │ (milestone invoices,
   [invoice at milestones]      │  via project_invoices)
        │                       │
   Project Module (this doc) ───┘
        ↑              ↑
   [optional]      [optional]
        │              │
   Quotation      Rental Module
    Module        (16_MODULE_RENTAL.md)
```

---

# 3. Domain Entity: `Project`

```text
Project
├── id, tenantId, branchId
├── customerId
├── quotationId?             -- nullable link if this project
│                               originated from an accepted Quotation
│                               (14 §5.5b)
├── projectNumber
├── name
├── status: PLANNING | IN_PROGRESS | ON_HOLD | COMPLETED | CANCELLED
├── budgetAmount: Money
├── startDate, endDate
├── createdAt, updatedAt, operationId
```

## 3.1 Value Object: `ProjectCost`

```text
ProjectCost
├── category: MATERIAL | LABOUR | RENTAL | TRANSPORT | SUBCONTRACT |
│             OTHER
├── amount: Money
├── description
├── incurredAt: date
├── sourceReferenceType?     -- e.g. PURCHASE, RENTAL_ORDER,
│                                EXPENSE — traceability back to the
│                                originating Core/Module transaction
│                                when the cost was NOT entered
│                                manually (§6)
├── sourceReferenceId?
```

## 3.2 Value Object: `ProjectInvoice`

```text
ProjectInvoice
├── saleId FK -> core.sales.id   -- every ProjectInvoice IS a Sale
│                                    (never a parallel invoice concept)
├── milestoneLabel?               -- e.g. "50% Advance", "Final Billing"
```

**Design note:** `ProjectInvoice` is deliberately thin — it is a labeled pointer to a Core `Sale`, not a duplicate invoicing entity. This mirrors `ServiceOrder.invoiceSaleId` (`15` §3) and `Quotation.convertedSaleId` (`14` §3) — the platform-wide rule that **all customer-facing billing ultimately resolves to one `Sale` record**, regardless of which module initiated it (concrete reinforcement of Decision DOM-002, `07` §20).

---

# 4. Project Lifecycle

```text
PLANNING
  ↓ (StartProjectUseCase)
IN_PROGRESS
  ↓                    ↓
ON_HOLD              COMPLETED
  ↓ (resume)             ↓
IN_PROGRESS           (terminal)

Any of PLANNING/IN_PROGRESS/ON_HOLD -> CANCELLED
```

**Invariants:**
```text
1. Costs (ProjectCost) may only be recorded while status IN
   (PLANNING, IN_PROGRESS, ON_HOLD) — never against COMPLETED/CANCELLED
   (mirrors the "no destructive edit after completion" pattern, 07
   §7.3 inv. 5, applied to cost accumulation instead of a single
   transaction).
2. Milestone invoices (ProjectInvoice) may be created at any
   non-terminal status — a project commonly bills an advance during
   PLANNING, before work starts.
3. COMPLETED requires at minimum one ProjectInvoice to exist
   covering the full budgeted/quoted amount, OR an explicit
   tenant-permission override to close with an outstanding balance
   (flagged as a soft business rule, not a hard invariant — some
   tenants close projects with known outstanding receivables by design).
4. CANCELLED does not reverse already-posted costs or invoices —
   those remain as historical record; cancellation only stops further
   accumulation, consistent with reversal-over-destructive-edit (02 §52).
```

---

# 5. Use Cases

## 5.1 `CreateProjectUseCase`

```text
Input: customerId, branchId, name, budgetAmount, startDate, endDate,
       quotationId?, operationId

1. Idempotency check
2. Validate customer belongs to tenant
3. If quotationId provided: validate the Quotation status = ACCEPTED
   and not already converted (mirrors 14 §5.5 step 1-2 validation,
   reused not reimplemented)
4. Persist Project (status = PLANNING), generate projectNumber
5. Audit log
```

**Note:** as flagged in `14` §5.5b, this is the concrete implementation `ConvertQuotationUseCase` delegates to when `targetType = PROJECT`.

## 5.2 `StartProjectUseCase`

```text
Input: projectId

1. Validate status = PLANNING
2. status -> IN_PROGRESS
3. Audit log
```

## 5.3 `RecordProjectCostUseCase`

```text
Input: projectId, category, amount, description, incurredAt,
       sourceReferenceType?, sourceReferenceId?, operationId

1. Idempotency check
2. Validate project status IN (PLANNING, IN_PROGRESS, ON_HOLD)
   (§4 inv. 1)
3. Persist ProjectCost
4. Post accounting effect per category — see §6 (NEW posting rules
   this document defines, following the pattern established in
   16 §6)
5. Audit log
```

**Automatic cost recording (no separate manual entry needed):** when a `Purchase` (`07` §8.3) or `RentalOrder` close (`16` §5.5) or `Expense` (`07` §14.2) is explicitly tagged against a `projectId` at creation time, the originating Use Case internally calls `RecordProjectCostUseCase` as part of its own transaction — this is the mechanism behind `sourceReferenceType`/`sourceReferenceId` traceability (§3.1), preventing double-entry of the same cost once manually and once automatically.

## 5.4 `InvoiceProjectMilestoneUseCase`

```text
Input: projectId, milestoneLabel, lines[] (or a flat amount), operationId

1. Validate project status IN (PLANNING, IN_PROGRESS, ON_HOLD, COMPLETED)
2. Delegate to CreateSaleDraftUseCase (07 §7.8) pre-populated with
   the milestone lines/amount, customerId from the Project
3. Staff reviews/completes via CompleteSaleUseCase (07 §7.6) — same
   non-bypass principle as 14 §5.5 and 15 §5.7
4. Persist ProjectInvoice linking the resulting saleId
5. Audit log
```

## 5.5 `CompleteProjectUseCase`

```text
Input: projectId, forceCloseWithBalance?: boolean, operationId

1. Validate status = IN_PROGRESS or ON_HOLD
2. Calculate totalInvoiced (SUM of linked Sales' grandTotal) vs
   totalCost (SUM of ProjectCost.amount)
3. If totalInvoiced < budgetAmount AND forceCloseWithBalance != true
   -> reject with a warning-class response (not a hard error — per
   §4 inv. 3, this is tenant-discretionary), prompting the user to
   either invoice the remainder or explicitly confirm force-close
4. status -> COMPLETED
5. Audit log
```

## 5.6 `GetProjectProfitabilityUseCase` (Query)

```text
Input: projectId
Output: {
  totalInvoiced: Money,       -- SUM of linked Sales
  totalCost: Money,            -- SUM of ProjectCost.amount, by category
  costBreakdown: { MATERIAL, LABOUR, RENTAL, TRANSPORT, SUBCONTRACT, OTHER },
  grossProfit: Money,           -- totalInvoiced - totalCost
  marginPercent: number
}
```

Pure read query, derived entirely from `core.sales` (via `project_invoices`) and `modules.project_costs` — never an independently maintained "profit" field, consistent with One Source of Truth (`02` §49).

## 5.7 `CancelProjectUseCase`

```text
Input: projectId, reason, operationId

1. Validate status != CANCELLED, != COMPLETED
2. status -> CANCELLED, cancelledAt, cancelledReason
3. Already-posted costs/invoices remain (§4 inv. 4)
4. Audit log
```

---

# 6. Accounting Posting Rules — New, Per Cost Category (Extends `08` §5)

Following the same gap-filling pattern established in `16` §6 (Rental posting rules), this document supplies posting rules `08_ACCOUNTING_ENGINE_SPECIFICATION.md` did not define.

## 6.1 General Shape

```text
Every RecordProjectCostUseCase (§5.3) posts:

Dr  <Category-Mapped Expense Account>       amount
    Cr  Cash / Bank / Accounts Payable       amount
        (Cr side depends on how the cost was paid — cash-on-the-spot
        vs on account, mirrors Expense posting shape, 08 §5.7)
```

## 6.2 Category → Account Mapping

| ProjectCost.category | Debited Account | Notes |
|---|---|---|
| `MATERIAL` | Inventory (1200) or a dedicated "Project Material Cost" expense sub-account | If sourced from a `Purchase` tagged to the project (§5.3 auto-record), the Purchase's own `Inventory` debit (`08` §5.2) already covers it — `RecordProjectCostUseCase` in that case posts NO additional journal, only the tracking row (see §6.4) |
| `LABOUR` | Salary Expense (5300) sub-account "Project Labour" | Direct debit, cash/payable credit |
| `RENTAL` | (see §6.3 — sourced from Rental module, not double-posted) | |
| `TRANSPORT` | Other Expense (5900) sub-account "Transport" | Direct debit |
| `SUBCONTRACT` | Other Expense (5900) sub-account "Subcontract" | Direct debit |
| `OTHER` | Other Expense (5900) | Direct debit |

## 6.3 Rental Costs Are Never Double-Posted

```text
When a Decorator project uses Rental assets (16_MODULE_RENTAL.md),
CloseRentalOrderUseCase (16 §5.5) already posts its own Rental
Revenue/Cost journal (16 §6.1) from the RENTAL BUSINESS's perspective
(the tenant renting OUT its own assets to this project's customer —
an internal transfer, not an external cost, if the rental assets are
owned by the same tenant).

If instead the tenant RENTS FROM a third-party supplier for a
project (e.g. hiring an external generator), that is a normal
`Purchase` or `Expense` tagged to the project — category = RENTAL
in that case behaves like MATERIAL (§6.2): if sourced from a tagged
Purchase/Expense, no additional journal; if manually entered, posts
directly per §6.1's general shape.

This distinction — internal asset use vs external rental cost — is
resolved by `sourceReferenceType` (§3.1): if it references this
tenant's own `RentalOrder`, no cost journal is posted here at all
(the value already flows through Rental's own accounting); if it
references a `Purchase`/`Expense` or is manual, §6.1/§6.2 applies.
```

## 6.4 Auto-Recorded Costs Never Double-Post

```text
Rule (generalizing §6.2's MATERIAL note and §6.3's RENTAL note):

RecordProjectCostUseCase, when called internally by another Use
Case's transaction (Purchase/Expense/RentalOrder-close — per §5.3's
"automatic cost recording" note) with a non-null sourceReferenceType,
ALWAYS skips its own accounting posting step. The originating
transaction's own posting (already defined in 07 §8.3, 07 §14.2, or
16 §6.1) is the only journal produced. RecordProjectCostUseCase in
this mode persists ONLY the `ProjectCost` tracking row for
profitability reporting (§5.6) — it is a read-model contribution,
not a second financial event.

Only when sourceReferenceType is null (a manually entered project
cost with no originating Core/Module transaction) does
RecordProjectCostUseCase post its own journal per §6.1/§6.2.
```

This mirrors the non-double-deduction principle established in `15` §6 (Service module), applied here to accounting posting instead of inventory movement — the same class of problem (one business event, multiple modules potentially reacting to it) recurring in a different domain.

---

# 7. Database Detail (extends `06` §6.5)

```text
modules.projects
  ... (as defined in 06 §6.5) ...
  + branch_id           uuid FK
  + quotation_id          uuid FK -> modules.quotations.id nullable
  + project_number         text
  + cancelled_at            timestamptz nullable
  + cancelled_reason         text nullable
  + operation_id

modules.project_costs
  ... (as defined in 06 §6.5) ...
  + source_reference_type   text nullable  -- PURCHASE/RENTAL_ORDER/
                                              EXPENSE (§3.1, §6.4)
  + source_reference_id      uuid nullable
  + operation_id

modules.project_invoices
  ... (as defined in 06 §6.5) ...
  -- no amendment needed; already minimal per design note §3.2
```

**Amendment flag:** Decision PRJ-001 (§13) — `06_DATABASE_SPECIFICATION.md` §6.5 revised accordingly.

**Unique:** `UNIQUE(tenant_id, project_number)`, `UNIQUE(tenant_id, operation_id)` on `projects` and on `project_costs` where cost is independently idempotent-mutation-originated.

---

# 8. API Detail (extends `11` §18.5)

```text
GET    /api/projects                             [project.view]
GET    /api/projects/:id                          [project.view]
POST   /api/projects                              [project.create]
                                                   [Idempotent, optional]
                                                   -> CreateProjectUseCase (§5.1)
POST   /api/projects/:id/start                      [project.create]
                                                   -> StartProjectUseCase (§5.2)
POST   /api/projects/:id/costs                       [project.create]
                                                   [Idempotent REQUIRED]
                                                   -> RecordProjectCostUseCase (§5.3)
POST   /api/projects/:id/invoices                     [project.create][sales.create]
                                                   [Idempotent REQUIRED]
                                                   -> InvoiceProjectMilestoneUseCase (§5.4)
POST   /api/projects/:id/complete                       [project.create]
                                                   [Idempotent REQUIRED]
                                                   -> CompleteProjectUseCase (§5.5)
GET    /api/projects/:id/profitability                   [project.view]
                                                   -> GetProjectProfitabilityUseCase (§5.6)
POST   /api/projects/:id/cancel                            [project.cancel]
                                                   [Idempotent REQUIRED]
                                                   -> CancelProjectUseCase (§5.7)
```

---

# 9. UX Flow

## 9.1 Project Creation (from Quotation or fresh)

```text
[From accepted Quotation]           [Fresh Project]
  Quotation detail ->                  Projects list -> [New Project]
  [Convert to Project]                     ↓
       ↓                                Customer selection
  Pre-filled Project form                  ↓
  (customer, estimated total ->        Name, budget, dates
   budgetAmount)                           ↓
       ↓                                Save -> PLANNING
  Save -> PLANNING
```

## 9.2 Cost Tracking (during IN_PROGRESS)

```text
Project detail screen
  Tabs: Overview | Costs | Invoices | Profitability
  ↓
  Costs tab:
    List grouped by category (per §6.2 mapping, visually)
    [Add Cost] -> category picker, amount, description, date
    Auto-recorded costs (from tagged Purchase/Rental/Expense) show
    a "linked" badge with a click-through to the source transaction
    (traceability from §3.1's sourceReferenceType/Id made visible)
```

## 9.3 Milestone Invoicing

```text
Invoices tab
  ↓
  [New Milestone Invoice] -> milestone label + amount/lines
  ↓
  Pre-filled Sale screen (12 §5 POS-style, customer locked)
  ↓
  Complete Sale -> appears in Invoices tab list with milestone label
```

## 9.4 Profitability Dashboard

```text
Profitability tab
  Total Invoiced vs Total Cost (bar or summary cards)
  Cost breakdown by category (donut/list, per 12 §8 dashboard
  widget pattern — this is itself effectively a project-scoped
  dashboard widget, reusing the same visual language)
  Margin % prominently displayed
```

## 9.5 Completion Guard

```text
[Complete Project] button
  ↓
  If totalInvoiced < budgetAmount:
    Warning dialog: "This project has an outstanding balance of
    [amount]. Complete anyway?" [Invoice Remainder] [Force Complete]
    [Cancel] — matches the "warning-class response" from §5.5 step 3,
    never a silent auto-proceed
```

---

# 10. Cross-Module Orchestration Rule

```text
Project module -> calls -> Sales application service (interface,
                            milestone invoicing)
Project module -> calls -> Accounting application service (interface,
                            §6 new posting rules)
Project module -> reads (link only) -> Quotation module (quotationId,
                            never mutates a Quotation from Project)
Project module -> reads (link only) -> Rental module (via
                            sourceReferenceType tracking, never
                            triggers Rental use cases directly)
Project module domain layer -> has NO dependency on Sales/Accounting/
                                Quotation/Rental internals

Dependency direction (concrete):
  project/application → sales/application (interface)
  project/application → accounting/application (interface)
  project/domain       → (no dependency on other domains)
```

---

# 11. Testing Obligations

```text
Lifecycle state machine:       every valid/invalid transition,
                                especially cost-recording rejection
                                once COMPLETED/CANCELLED (§4 inv. 1)
Cost category posting:          each of the 6 categories produces the
                                correct account mapping (§6.2) when
                                manually entered
No double-posting:               a Purchase tagged to a project posts
                                exactly ONE journal (its own Purchase
                                journal, 07 §8.3) — NOT a second one
                                via RecordProjectCostUseCase (§6.4) —
                                this is the critical test, mirroring
                                15 §12's non-double-deduction test
Rental cost distinction:         internal RentalOrder use vs external
                                rental Purchase are categorized/posted
                                correctly per §6.3
Profitability calculation:       GetProjectProfitabilityUseCase
                                produces correct totals against a
                                fixture with mixed auto-recorded and
                                manual costs plus multiple milestone
                                invoices
Completion guard:                CompleteProjectUseCase rejects
                                without forceCloseWithBalance when
                                underinvoiced, succeeds with the flag
Idempotency:                     replaying cost/invoice/complete
                                operationId never double-posts
```

---

# 12. Decisions Established by This Document

### Decision PRJ-001
`06_DATABASE_SPECIFICATION.md` §6.5 is amended: `projects` gains `branch_id`, `quotation_id`, `project_number`, `cancelled_at`/`cancelled_reason`, `operation_id`; `project_costs` gains `source_reference_type`/`source_reference_id`/`operation_id`.

### Decision PRJ-002
`08_ACCOUNTING_ENGINE_SPECIFICATION.md`'s posting rule catalog is extended with a category-mapped Project Cost posting rule set (§6.1–6.2), implemented via new `AccountingPostingService` methods.

### Decision PRJ-003
`RecordProjectCostUseCase` never posts a duplicate accounting journal when the cost originates from an already-posting Core/Module transaction (Purchase, Expense, RentalOrder close) — in that mode it persists only the tracking row for profitability reporting, generalizing the non-double-posting principle first established for inventory in `15` §6 to the accounting domain.

### Decision PRJ-004
`ProjectInvoice` is a thin label over a Core `Sale` — Project introduces no parallel invoicing/billing entity; all customer billing across every module (Quotation, Service, Rental, Project) resolves to exactly one `core.sales` record per invoice event.

### Decision PRJ-005
Completing a Project with an outstanding invoiced-vs-budget balance is a soft, tenant-overridable warning (`forceCloseWithBalance`), not a hard invariant — distinct from the hard invariants (e.g. return-quantity limits, `07` §12.2) enforced elsewhere in the platform.

---

# 13. Open Module Questions

```text
1. Should `budgetAmount` support revision over the project's life
   (scope change / change orders), and if so, does that need its own
   audit trail distinct from the general audit log?
2. Multi-currency projects (an agency billing an international
   client) — same open question as flagged in 14 §12 Q2 for
   Quotation; likely the same answer applies platform-wide.
3. Resource/task-level planning (Gantt-style scheduling, per `02`
   §28's "Tasks/Resources/Milestone" mention) — explicitly out of
   scope for this document's MVP cut (§5 has no Task entity); confirm
   this is acceptable to defer to a future Phase per `03` §85's
   "Advanced Project Management" exclusion.
4. Should `CompleteProjectUseCase`'s underinvoiced-balance check
   (§5.5) also block if `totalCost > totalInvoiced` (a loss-making
   project), as a distinct warning class from the budget check?
5. Category-to-account mapping (§6.2) — fixed platform-wide, or
   tenant-configurable (some tenants may want their own chart-of-
   account sub-structure for project costs)?
```

---

# 14. Next Document

পরবর্তী document:

`18_MODULE_BOOKING.md`

এখানে Booking module (time/resource-based commitment — Event, Rental, Appointment, Service, Venue — per `02` §25, `06` §6.2) বিস্তারিত হবে। এটি Module series-এর শেষ document, এবং বিশেষভাবে এই পর্যন্ত তৈরি Quotation/Service/Rental/Project মডিউলগুলোর সঙ্গে Booking-এর সম্পর্ক স্পষ্ট করবে — Booking মূলত একটি **time-window reservation primitive** যা অন্য মডিউলগুলো (বিশেষত Rental, §5.1-এ ইতিমধ্যে `bookingId` reference হিসেবে দেখা গেছে) নিজেদের workflow-এ compose করে ব্যবহার করে, বরং একটি স্বতন্ত্র transaction টাইপ হিসেবে নয়।
