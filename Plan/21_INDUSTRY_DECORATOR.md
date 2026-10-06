# 21_INDUSTRY_DECORATOR.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Decorator/Event Industry Extension Specification
**Version:** 1.0 Draft
**Status:** Industry Extension Deep-Dive — Final document in the Industry series
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§29, Decorator Domain)
- `06_DATABASE_SPECIFICATION.md` (§7.3, `industry.decorator_events` / `industry.decorator_labour`)
- `14_MODULE_QUOTATION.md`, `16_MODULE_RENTAL.md`, `17_MODULE_PROJECT.md`, `18_MODULE_BOOKING.md` (all four — Decorator's primary consuming modules)
- `19_INDUSTRY_PHARMACY.md` (§1, narrowest-extension baseline), `20_INDUSTRY_ELECTRONICS.md` (§9.1, soft-dependency pattern) — contrast points

---

# 1. Purpose

এই document Industry Extension series-এর তৃতীয় এবং শেষ — `Decorator/Event` extension-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities specific to Decorator (Event, Labour)
Full module composition: Quotation + Booking + Project + Rental
  working together as ONE customer-facing workflow
Database detail (beyond the 06 §7.3 stub)
UX additions and the composed screen flow (not just isolated tabs)
Cross-cutting rule: why Decorator has HARD dependencies on Optional
  Modules, unlike Pharmacy (zero) and Electronics (one, soft)
```

**Extension classification (per `02` §40, §53, §29):** Industry Extension — but the **widest** in this series by Optional Module composition. Per `02` §29's own definition, restated as this document's organizing principle:

```text
Decorator = CRM + Quotation + Booking + Project + Rental +
            Inventory + Labour + Accounting
```

Where Pharmacy (`19`) needed zero Optional Modules and Electronics (`20`) had one soft dependency, **Decorator cannot function at all without Quotation, Booking, Project, and Rental all enabled simultaneously.** This document's primary job is therefore different in character from `19`/`20` — less about new fields, more about specifying **the order and handoffs** between four already-fully-specified modules.

---

# 2. What "Decorator" Actually Adds

```text
Quotation (14)  — customer sends enquiry, tenant sends estimate
       ↓ ConvertQuotationUseCase(targetType=PROJECT)
Project (17)    — the engagement container; budget, milestone
                  invoicing, cost tracking, profitability
       ↓ (Project needs to hold specific rental assets for the
          event window)
Booking (18)    — the event's time-window claim on Venue/Rental
                  Asset/Labour resources, preventing double-booking
       ↓ (Booking, once confirmed, is referenced when reserving
          actual physical assets)
Rental (16)     — the specific chairs/tables/lighting/decor items
                  physically reserved, dispatched, returned,
                  inspected for the event
       ↓ (accounting effects from all of the above flow through
          Project's cost tracking + Rental's own posting + Core
          Sales for milestone invoices)
Accounting (Core, 08) — receives postings from Project (17 §6),
                  Rental (16 §6), and Sales (07/08) — Decorator
                  introduces NO new accounting posting rules itself;
                  it is a pure orchestration of already-defined ones

industry.decorator_events  — descriptive Event metadata attached to
                              a Project (venue, date, theme, guest count)
industry.decorator_labour  — Decorator-specific labour cost entries,
                              a specialization of Project's generic
                              LABOUR cost category (17 §3.1)
```

**Restated non-negotiable (per `01` §55, `04` §133, `19` §11 / `20` §9's one-directional dependency rule):** despite composing four Optional Modules, Decorator still introduces zero branching into any of Quotation/Booking/Project/Rental's own domain code. Every composition point below is either (a) an existing cross-module call already specified in those documents (e.g. `ConvertQuotationUseCase` targeting `PROJECT`, already generic per `14` §5.5b), or (b) a new 1:1 extension table attached the same way `industry.pharmacy_item_details`/`industry.electronics_item_details` attach to Core.

---

# 3. Domain Entity: `industry.decorator_events` (extends `modules.projects`)

Already stubbed in `06` §7.3; this document finalizes the field set.

```text
DecoratorEventDetails
├── id, tenantId, projectId FK -> modules.projects.id UNIQUE
├── venueName
├── venueAddress
├── eventDate: date               -- distinct from Project's
│                                     startDate/endDate (17 §3) —
│                                     a Project may span weeks of
│                                     setup/planning while eventDate
│                                     is the single day the event
│                                     itself occurs (see §3.1)
├── theme?
├── guestCountEstimate?: integer
├── createdAt
```

## 3.1 Why `eventDate` Is Distinct From `Project.startDate`/`endDate`

```text
Project.startDate/endDate (17 §3) bound the ENGAGEMENT — from initial
planning/quotation acceptance through final teardown/invoice
settlement, which for a wedding might span 3-6 weeks.

DecoratorEventDetails.eventDate is the single calendar day (or date
range for multi-day events, per §9 open question) the actual event
occurs — the day the Rental assets are DISPATCHED and the day Labour
is primarily incurred.

This distinction matters concretely: the Booking (18) created for
this engagement (§4) uses eventDate (or a startsAt/endsAt window
derived from it) as its time-window, NOT Project.startDate/endDate —
booking the venue/assets for the entire 3-6 week planning window
would incorrectly block the resource from other customers during
weeks the tenant isn't actually using it.
```

---

# 4. Domain Entity: `industry.decorator_labour` (extends `modules.projects`, specializes `ProjectCost`)

Already stubbed in `06` §7.3; finalized here against the now-complete Project module (`17`).

```text
DecoratorLabourEntry
├── id, tenantId, projectId FK -> modules.projects.id
├── labourName                  -- individual worker name (Decorator
│                                  labour is typically day-labour/
│                                  crew, not a tenant staff member
│                                  with a Core Membership — see §4.1)
├── role                        -- e.g. "Setup Crew", "Electrician",
│                                  "Supervisor"
├── hours: numeric
├── rate: Money
├── amount: Money (derived = hours * rate)
├── workDate: date
├── projectCostId? FK -> modules.project_costs.id nullable
│                                -- linkage back to the generic Project
│                                  Cost entry this labour record
│                                  corresponds to (§4.2)
├── createdAt
```

## 4.1 Why Labour Is Not a Core `Membership`/Staff Record

```text
Per 06 §5.17, tenant staff (RBAC-capable users who log into the
system) are control.memberships rows. Decorator's setup/event-day
labour crew are typically day-hires, sometimes not even the same
individuals event-to-event, and critically DO NOT need system
login/RBAC access — they are a COST, not a system actor.

Modeling them as Membership rows would incorrectly imply they need
authentication/authorization, and would pollute staff management
screens (12 §4, Staff/Roles) with transient day-labour entries that
have nothing to do with system access control. DecoratorLabourEntry
is deliberately a plain cost-tracking record, structurally similar
to a PurchaseLine or ExpenseLine, not an identity concept.
```

## 4.2 Relationship to `ProjectCost` — Specialization, Not Duplication

```text
Per 17 §3.1, Project already has a generic LABOUR cost category:
  ProjectCost { category: LABOUR, amount, description, incurredAt }

DecoratorLabourEntry does not replace this — RecordDecoratorLabourUseCase
(§5.2) creates BOTH in one transaction:
  1. A modules.project_costs row (category=LABOUR, amount=hours*rate,
     description=auto-generated from labourName+role) — this is what
     RecordProjectCostUseCase (17 §5.3) already posts its accounting
     journal against (17 §6.2's LABOUR mapping: Salary Expense sub-
     account "Project Labour")
  2. An industry.decorator_labour row (this document) carrying the
     structured labourName/role/hours/rate breakdown a Decorator
     tenant wants for crew-scheduling and per-worker payment
     reconciliation, which generic ProjectCost.description (free
     text) cannot support as a queryable dimension

This is the SAME pattern already established twice in this series:
Pharmacy's PharmacyBatchDetails snapshot (19 §4) and Electronics'
ElectronicsRepairDetails (20 §6) — an industry extension adding a
structured, reportable annotation alongside (never instead of) the
generic Core/Module record that already carries the financial truth.
```

---

# 5. Use Cases

## 5.1 `CreateDecoratorEventUseCase`

```text
Input: projectId, venueName, venueAddress, eventDate, theme?,
       guestCountEstimate?, operationId

1. Validate projectId belongs to tenant
2. Persist DecoratorEventDetails
3. Audit log
```

**Typical caller sequence (the composed workflow, §1's diagram made concrete):**

```text
1. Customer enquiry -> CreateQuotationUseCase (14 §5.1)
2. Quotation sent/accepted -> ConvertQuotationUseCase(targetType=
   PROJECT) (14 §5.5b) -> CreateProjectUseCase (17 §5.1)
3. Staff attaches event specifics -> CreateDecoratorEventUseCase
   (this use case) -> DecoratorEventDetails linked to the new Project
4. Staff creates the venue/date hold -> CreateBookingUseCase (18 §6.1)
   with resourceType="VENUE" (or "RENTAL_ASSET" per specific chairs/
   equipment), startsAt/endsAt derived from DecoratorEventDetails.
   eventDate (per §3.1) — bookingId is NOT stored on Project or
   DecoratorEventDetails directly; it flows into the eventual
   RentalOrder.bookingId (16 §3.1) once assets are reserved
5. Staff reserves specific rental assets -> ReserveRentalUseCase
   (16 §5.1), bookingId from step 4 attached, and (per §5.3 below)
   RentalOrder cost-tagged back to the Project
6. Event day: DispatchRentalUseCase (16 §5.2) -> event occurs ->
   ReturnRentalUseCase (16 §5.3) -> CloseRentalOrderUseCase (16 §5.5)
   — this posts Rental's own accounting (16 §6.1) AND, because the
   RentalOrder was cost-tagged to the Project, automatically records
   a ProjectCost via the sourceReferenceType mechanism (17 §5.3's
   "automatic cost recording" note, 17 §6.3's non-double-post rule)
7. Milestone invoices throughout -> InvoiceProjectMilestoneUseCase
   (17 §5.4) — e.g. advance at booking confirmation, balance after
   event
8. Labour entries recorded as incurred -> RecordDecoratorLabourUseCase
   (§5.2)
9. Post-event -> CompleteProjectUseCase (17 §5.5), GetProjectProfitability
   UseCase (17 §5.6) shows the full picture: Sales (milestone
   invoices) vs Costs (materials, the Rental cost via source-tagging,
   labour, transport, subcontract)
```

**This sequence is the single most important artifact in this document** — it demonstrates that Decorator requires no new orchestration logic beyond what `14`, `16`, `17`, and `18` already independently specify. The "Decorator workflow" is entirely an emergent property of calling those Use Cases in this order from the UI layer (§7), not a new `DecoratorWorkflowUseCase` that itself touches Sales/Inventory/Accounting.

## 5.2 `RecordDecoratorLabourUseCase`

```text
Input: projectId, labourName, role, hours, rate, workDate, operationId

1. Idempotency check
2. Validate project status IN (PLANNING, IN_PROGRESS, ON_HOLD)
   (mirrors 17 §4 inv. 1 — reuses Project's own status gate, not a
   duplicate check)
3. Delegate to RecordProjectCostUseCase (17 §5.3) with category=
   LABOUR, amount=hours*rate, description=`${labourName} (${role})`,
   sourceReferenceType=null (this IS the manual-entry path per 17
   §6.4 — DecoratorLabourEntry is the structured form staff fill in,
   but it is not itself a Purchase/Expense/RentalOrder-originated
   cost, so RecordProjectCostUseCase posts its own journal per 17
   §6.1-6.2's LABOUR mapping)
4. Persist DecoratorLabourEntry, linking projectCostId to the row
   created in step 3
5. Audit log (inherited from RecordProjectCostUseCase's own audit
   step, per 17 §5.3 — not duplicated here)
```

**Note on step 3's `sourceReferenceType=null`:** this is a deliberate contrast with §4.2's earlier framing — the DecoratorLabourEntry itself doesn't "source from" another transaction the way a tagged Purchase does; rather, it **is** the originating manual entry, just captured through this extension's structured form instead of Project's generic cost-entry form. Both forms ultimately call the identical `RecordProjectCostUseCase`.

## 5.3 Cost-Tagging a RentalOrder to a Project (no new use case — a parameter addition)

```text
ReserveRentalUseCase (16 §5.1) gains an optional input field:
  projectId? (nullable, only meaningful when Rental and Project
  are both enabled)

When present, CloseRentalOrderUseCase (16 §5.5), upon successful
accounting posting (16 §6.1), additionally calls RecordProjectCostUseCase
(17 §5.3) with category=RENTAL, sourceReferenceType=RENTAL_ORDER,
sourceReferenceId=rentalOrderId — triggering 17 §6.3's non-double-
post handling (no separate journal, tracking row only).

This is the SAME narrow-extension-point pattern used throughout this
series (19 §6, 20 §5.2) — 16_MODULE_RENTAL.md's own use case gains
one optional, backward-compatible parameter; tenants without Project
enabled simply never pass it, and RentalOrder's behavior is otherwise
byte-for-byte unchanged.
```

**Amendment flag:** this is flagged as Decision DEC-004 (§12) — a narrow, backward-compatible parameter addition to `16_MODULE_RENTAL.md` §5.1's `ReserveRentalUseCase` input signature.

---

# 6. Database Detail (finalizes `06` §7.3)

```text
industry.decorator_events
  ... (as defined in 06 §7.3) ...
  -- no amendment needed; fields already match §3 above

industry.decorator_labour
  ... (as defined in 06 §7.3) ...
  + project_cost_id   uuid FK -> modules.project_costs.id nullable
                        -- amendment: 06 stub did not include this
                        traceability link (§4.2)
```

**Amendment flag:** Decision DEC-001 (§12) — `06_DATABASE_SPECIFICATION.md` §7.3's `industry.decorator_labour` gains `project_cost_id`.

**Indexes:** `INDEX(tenant_id, project_id)` on both tables (mirrors the pattern already used for `industry.pharmacy_batch_details`/`industry.electronics_repairs`'s parent-FK indexes).

---

# 7. UX Additions (extends `12` §3.3, §8)

Per `12` §3.3, already anticipated ("Projects → adds Event Details tab", "Rentals → primary daily workflow"):

```text
Project detail screen (17 §9.2's existing Overview/Costs/Invoices/
  Profitability tabs) -> gains one additional tab when Decorator
  extension active:
    "Event Details" tab: Venue, Date, Theme, Guest Count (§3) — a
    thin form, same progressive-disclosure principle as Pharmacy's
    Item tab (19 §9) and Electronics' Item tab (20 §8)

Project detail -> Costs tab -> "Add Labour" button (alongside the
  generic "Add Cost" button already specified, 17 §9.2) opens the
  structured DecoratorLabourEntry form (labourName, role, hours,
  rate, workDate) instead of the generic category/amount/description
  form — both ultimately land in the same Costs list, with labour
  entries showing their structured fields inline

Booking Calendar (18 §8) -> a Decorator tenant's primary planning
  view; the "Check Calendar" bridge already specified generically
  (18 §8.2) is how staff moves from a Project into reserving the
  event's venue/asset window — no Decorator-specific calendar UI,
  the generic Booking Calendar IS the Decorator planning tool

Rental Order creation (16 §9.1), when reached FROM a Project screen
  (rather than standalone) -> pre-fills customerId from the Project
  and silently carries projectId (§5.3) so cost-tagging happens
  without the user manually re-entering project context — this is
  the one piece of UI-level "glue" this extension contributes beyond
  what a bare composition of independent module screens would give,
  and it is presentation-layer only (no domain logic)

Navigation (12 §3.3): no new top-level item — Decorator is entirely
  composed from Quotation/Booking/Project/Rental's existing nav
  entries (12 §3.2), reinforcing (per §1) that this extension is
  pure orchestration, not new workflow surface.
```

---

# 8. Cross-Module Orchestration Rule

```text
Decorator extension -> extends -> modules.projects (industry.
                        decorator_events, 1:1)
Decorator extension -> extends -> modules.projects (industry.
                        decorator_labour, many, via RecordDecoratorLabourUseCase
                        delegating to Project's own RecordProjectCostUseCase)
Decorator extension -> adds an optional parameter to -> Rental's
                        ReserveRentalUseCase (§5.3, projectId)
Decorator extension domain layer -> has NO dependency on Quotation/
                        Booking/Project/Rental INTERNAL implementation
                        — every touchpoint is either a 1:1 extension
                        FK or a call through those modules' own
                        Application Service interfaces

Dependency direction (concrete):
  industry/decorator → project/application (interface, RecordProjectCostUseCase)
  industry/decorator → rental/application (interface, optional
                        projectId parameter on an existing use case)
  industry/decorator → quotation/application (read-only, no direct
                        calls — Quotation->Project conversion is
                        Quotation's own responsibility, per 14 §5.5b,
                        not orchestrated by this extension)
  industry/decorator → booking/application (read-only reference via
                        the UI bridge, §7 — no domain-layer call)
  project/*, rental/*, quotation/*, booking/* →
                        (no dependency on industry/decorator — every
                        one of these four modules was fully specified
                        in `14`-`18` with zero awareness that
                        Decorator would later compose them)
```

**This is the concrete proof-of-concept for the entire platform's core thesis (`03` §97):** four independently-specified Optional Modules (`14`, `16`, `17`, `18`), none of which reference Decorator or each other in a hardcoded way, combine into a fully-functional Decorator/Event business vertical through configuration (`tenant_features`) and two narrow, backward-compatible extension points (§4.2, §5.3) — not through a rewrite of any of the four.

---

# 9. Testing Obligations

```text
Full composed workflow:         an end-to-end test walking §5.1's
                                9-step sequence (Quotation -> Project
                                -> Event Details -> Booking -> Rental
                                Reserve/Dispatch/Return/Close ->
                                Milestone Invoice -> Labour -> Complete
                                -> Profitability) produces a correct
                                GetProjectProfitabilityUseCase result
                                combining Sales, Rental-sourced cost,
                                and manual Labour cost
Rental cost-tagging:            ReserveRentalUseCase with projectId
                                set correctly triggers exactly one
                                ProjectCost tracking row (no duplicate
                                journal, per 17 §6.3/§6.4 — this is
                                the same non-double-post regression
                                test class as 17 §11, now exercised
                                via the Decorator entry point)
Rental cost-tagging absent:     ReserveRentalUseCase WITHOUT projectId
                                behaves identically to a standalone
                                Rental tenant (16's own test suite,
                                unmodified) — confirms the optional
                                parameter (§5.3) is truly backward-
                                compatible
Labour dual-write:              RecordDecoratorLabourUseCase produces
                                both a ProjectCost row and a
                                DecoratorLabourEntry row, correctly
                                linked via project_cost_id, in one
                                transaction (partial-write rollback
                                test: if either insert fails, neither
                                persists)
Event/Booking date distinction: a Booking created for the event uses
                                eventDate-derived window, NOT the
                                Project's full startDate/endDate span
                                (§3.1 regression test)
Extension independence:          each of Quotation/Booking/Project/
                                Rental's own existing test suites
                                (14 §10, 16 §11, 17 §11, 18 §10) pass
                                completely unmodified with the
                                Decorator extension active — proving
                                the extension added behavior without
                                altering existing module contracts
```

---

# 10. Decisions Established by This Document

### Decision DEC-001
`06_DATABASE_SPECIFICATION.md` §7.3's `industry.decorator_labour` is amended to add `project_cost_id`, linking each structured labour entry to the generic `ProjectCost` row it was recorded alongside.

### Decision DEC-002
`DecoratorEventDetails.eventDate` is deliberately distinct from `Project.startDate`/`endDate` — Booking windows for venue/asset reservation derive from the former, never the latter, preventing the entire multi-week engagement span from incorrectly blocking a resource.

### Decision DEC-003
Decorator labour is modeled as a plain cost-tracking record (`DecoratorLabourEntry`), never as a `control.membership`/staff entity — day-labour/event crew are a cost dimension, not system actors requiring authentication or RBAC.

### Decision DEC-004
`16_MODULE_RENTAL.md` §5.1's `ReserveRentalUseCase` is amended with one optional, backward-compatible input parameter (`projectId`) enabling Rental-to-Project cost-tagging — Rental tenants without Project enabled are entirely unaffected.

### Decision DEC-005
The full Decorator customer journey (§5.1's 9-step sequence) is implemented entirely as UI-layer orchestration calling existing Quotation/Booking/Project/Rental Use Cases in order — no new `DecoratorWorkflowUseCase` or equivalent cross-cutting orchestrator exists; this extension's domain layer contains only the two 1:1 annotation entities (§3, §4) and the labour dual-write use case (§5.2).

---

# 11. Open Extension Questions

```text
1. Multi-day events (§3, eventDate as a single date vs a range) —
   does DecoratorEventDetails need eventStartDate/eventEndDate for
   multi-day festivals/conferences, or is single-date MVP-sufficient
   with multi-day handled as a Booking-level date range independent
   of a single "event date" field?
2. Should the Booking created in §5.1 step 4 be a single composite
   booking covering Venue + all Rental Assets + Labour slots
   atomically, or multiple independent Bookings (one per resource)?
   This directly echoes the still-open composite-booking question
   from `18` §12 Q3 — likely resolved together.
3. Labour crew as a reusable roster (a tenant's regular setup team,
   re-selectable across projects rather than re-typing labourName
   each time) — Phase 2 convenience feature, or does repeat-crew
   friction justify a lightweight `industry.decorator_crew_members`
   lookup table at MVP?
4. Should `RecordDecoratorLabourUseCase` (§5.2) support bulk entry
   (an entire crew's hours for one work day in one submission), given
   Decorator setup crews are typically 5-15+ people per event?
5. Damage charges from Rental (16 §5.4/§6.2, posted as Other Income)
   — when the rental assets are the tenant's own and used for a
   Decorator project, should a damage charge also reduce the
   Project's profitability calculation (17 §5.6), or does it remain
   purely a Rental-side financial event with no Project-side
   visibility? Currently unspecified — the cost-tagging mechanism
   (§5.3) only covers the base rental journal, not supplementary
   damage-adjustment journals (16 §6.3).
```

---

# 12. Industry Extension Series — Closing Note

এই document দিয়ে Industry Extension series (`19`–`21`) সম্পূর্ণ হলো। তিনটি extension একটি deliberate spectrum প্রদর্শন করেছে:

```text
Pharmacy (19)     — narrowest: zero Optional Module dependency,
                     one net-new entity (Prescription), one
                     pre-completion validation hook on Core Sales
Electronics (20)  — middle: one soft Optional Module dependency
                     (Service), zero schema amendments needed, one
                     post-completion side-effect hook on Core Sales
Decorator (21)    — widest: four hard Optional Module dependencies
                     (Quotation+Booking+Project+Rental), two 1:1
                     annotation entities, one narrow backward-
                     compatible parameter addition to an existing
                     Module use case, zero new Core-facing hooks
                     (all orchestration happens module-to-module,
                     not extension-to-Core)
```

**The pattern proven consistent across all three (the platform's central architectural claim, `03` §89, now demonstrated three separate ways):**

```text
1. Every extension attaches to Core/Module tables via 1:1 FK
   (industry.*.{item_id | stock_batch_id | service_order_id |
   project_id} UNIQUE) — never forking or duplicating a table
   (Decision DB-003, 06 §13).
2. Where an extension needs to influence a Core/Module use case's
   BEHAVIOR (not just add descriptive data), it does so via a
   documented, narrow, backward-compatible extension point — an
   optional hook or an optional parameter — never by Core/Module
   code branching on industry type.
3. No Core or Module test suite requires modification when an
   extension is introduced (§9's "Extension independence" test
   class, appearing in some form in all three documents).
4. Every extension's own domain layer is thin — the actual business
   capability (FEFO, serial allocation, repair workflow, rental
   reservation, project cost tracking) was already fully generic
   before the extension existed; the extension's job is
   configuration + a small number of structured annotations, never
   a parallel implementation of Core capability.
```

This closes the Documentation Hierarchy's Domain/Module/Industry arc (`03` §92, documents `01`–`21`). The remaining series (`22`–`29`) shifts from *what the platform does* to *how it is built, secured operationally, deployed, and delivered*.

---

# 13. Next Document

পরবর্তী document:

`22_AI_ARCHITECTURE.md`

এখানে AI layer সম্পূর্ণভাবে বিস্তারিত হবে — এই পর্যন্ত ছড়িয়ে থাকা AI-সংক্রান্ত সিদ্ধান্তগুলো (Decision DOM-005-এর AI-invoice-OCR human confirmation, `07` §8.4; AI provider abstraction, `04` §80-82; tenant-scoped AI context, `05` §39/§130; `03` §44-46-এর tool-calling pattern) একত্র করে একটি সম্পূর্ণ, বাস্তবায়নযোগ্য AI Architecture specification-এ রূপান্তরিত করবে:

```text
Provider adapter concrete interface
Tool catalog (getSalesSummary, getStockStatus, ইত্যাদি) — সম্পূর্ণ
  signature সহ
Natural-language query -> Intent -> Tool call -> Response pipeline
Document OCR pipeline detail (purchase invoice scanning-এর বাইরেও
  ভবিষ্যৎ document types)
AI usage metering (per 05 §73) এবং rate limiting (per 13 §5.1)
Prompt/context construction rules — tenant isolation-এর concrete
  enforcement (05 §39 বাস্তবায়ন)
Cost control এবং model selection strategy
```
