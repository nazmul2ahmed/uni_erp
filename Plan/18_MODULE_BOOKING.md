# 18_MODULE_BOOKING.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Booking Module Specification
**Version:** 1.0 Draft
**Status:** Optional Module Deep-Dive — Final document in the Module series
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§25, Booking Domain)
- `06_DATABASE_SPECIFICATION.md` (§6.2, `modules.bookings` — including the `EXCLUDE USING gist` concurrency constraint)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§4.4, ReservationAllocationStrategy — the mechanism this module's confirmed bookings ultimately trigger)
- `16_MODULE_RENTAL.md` (§3.1, `RentalOrder.bookingId` — the primary consumer of this module)
- `04_PLATFORM_ARCHITECTURE.md` (§93, Booking Concurrency)

---

# 1. Purpose

এই document Optional Module series-এর পঞ্চম এবং শেষ — `Booking` module-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entity & the "resource" abstraction
Relationship to Rental/Service/Venue as consuming modules
Overlap-prevention concurrency detail (concrete implementation of
  the 06 §6.2 EXCLUDE constraint + 04 §93 rule)
Status state machine
Use cases
Database detail (beyond the 06 stub)
API contract detail (beyond the 11 stub)
UX flow (calendar-first)
Cross-module orchestration — Booking is deliberately the THINNEST
  module in this series
```

**Module classification (per `02` §40, §53):** Optional Module. This is the most abstract module in the series — it is not itself a business transaction, but a **reusable time/resource commitment primitive** that other modules build on.

---

# 2. Why This Module Is Different From the Others

Every prior module document (Quotation, Service, Rental, Project) modeled a **business transaction** with its own pricing, invoicing, and accounting effects. Booking has **none of these** — it has no `pricing` field, no accounting posting rule, no invoice. Its entire domain responsibility is:

```text
"Is this resource available for this time window? If yes, hold it."
```

```text
Booking Module (this document)
  — a pure time/resource reservation primitive —
        ↑ consumed by ↑
   ┌────┴────┬────────┴─────┐
   │         │              │
Rental    Service        (future: Venue,
Module    Module          Appointment-only
(16)      (15, optional    businesses like
           appointment      salons/consultancy
           slotting)        per 02 §2.2)
```

Per `02` §25: "Booking হলো time/resource-based commitment... Event / Rental / Appointment / Service / Venue." This document treats all of those as **consumers of one shared primitive**, rather than modeling each as a separate concept — directly fulfilling BD-006 (`02` §57) and the Capability-over-Industry principle (`02` §47) at the module-design level itself.

Enabled via `tenant_features.booking = true` (`06` §4.7). **Rental (`16`) may function without Booking enabled** — `RentalOrder.bookingId` is nullable (`16` §3.1) precisely to support tenants who reserve assets ad hoc via `ReserveRentalUseCase` directly, without ever touching this module. Booking becomes valuable once a tenant wants a **calendar-first view across multiple resource types**, or wants to take a reservation *before* deciding which downstream module (Rental order? Service appointment?) will ultimately fulfill it.

---

# 3. Domain Entity: `Booking`

```text
Booking
├── id, tenantId, branchId
├── customerId
├── resourceType: text          -- polymorphic, e.g. "RENTAL_ASSET",
│                                   "TECHNICIAN", "VENUE", "SERVICE_SLOT"
│                                   — deliberately open-ended, not a
│                                   fixed enum (see §3.1)
├── resourceId: uuid             -- polymorphic pointer, no hard FK
│                                   (mirrors core.stock_movements.
│                                   reference_id pattern, 06 §5.10)
├── startsAt, endsAt: timestamptz
├── status: DRAFT | HOLD | CONFIRMED | IN_PROGRESS | COMPLETED |
│           CANCELLED
├── advanceAmount?: Money        -- optional deposit, recorded as a
│                                   plain reference amount only —
│                                   ACTUAL payment capture still goes
│                                   through Core Payment (07 §10),
│                                   this field is display/tracking only
├── notes
├── createdAt, updatedAt, operationId
```

## 3.1 Why `resourceType`/`resourceId` Is Polymorphic, Not a Fixed FK

```text
A fixed foreign key (e.g. rental_asset_id) would force this module to
know about Rental's schema, violating the module dependency rule
(04 §133 — "Pharmacy → Core Internal Implementation" forbidden,
generalized here to "Booking → Rental Internal Implementation"
forbidden).

Instead, Booking knows only: "some resource, identified by a type tag
and an ID, is busy during this window." The consuming module
(Rental, Service, etc.) is responsible for interpreting resourceId
against its own domain when it reads Booking data.

This mirrors the same polymorphic-reference pattern already
established in Core for core.stock_movements.reference_id (06 §5.10)
and core.audit_logs.entity_id (06 §5.15) — Booking is simply the
same pattern applied to time-window commitments.
```

## 3.2 Distinction From `RESERVATION` Stock Movement

```text
09 §2's RESERVATION/RELEASE movement types operate on core.items/
core.stock_balances (quantity_reserved) — they are Inventory-domain
concepts with no time dimension beyond "reserved until released."

modules.bookings operates on a resourceType/resourceId with an
explicit startsAt/endsAt WINDOW — it is a Booking-domain concept.

Rental (16 §5.1) uses BOTH: a Booking may exist first to hold the
calendar slot (this module), and separately, ReserveRentalUseCase
posts the RESERVATION stock movement (09 §7.3) when the specific
RentalAsset is allocated. The two are complementary, not the same
mechanism — a Booking can exist for a resourceType that has no
Inventory-tracked stock at all (e.g. resourceType="TECHNICIAN",
which Service uses for a technician's calendar, with no stock
movement involved whatsoever).
```

---

# 4. Concurrency — Overlap Prevention (Concrete Detail)

Per `06` §6.2 and `04` §93, this document specifies the exact mechanism.

## 4.1 Database Constraint

```sql
-- Illustrative shape, per 06 §6.2
ALTER TABLE modules.bookings
  ADD CONSTRAINT no_overlapping_bookings
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_type WITH =,
    resource_id WITH =,
    tsrange(starts_at, ends_at) WITH &&
  )
  WHERE (status IN ('HOLD', 'CONFIRMED', 'IN_PROGRESS'));
```

**Requires `btree_gist` PostgreSQL extension** (per `06` §6.2 note).

**Why the `WHERE` clause matters:** `DRAFT`, `COMPLETED`, and `CANCELLED` bookings do NOT participate in the exclusion — a `DRAFT` is a tentative hold not yet worth blocking others (§5.1), and `COMPLETED`/`CANCELLED` are historical/terminal and must never block a new booking for the same now-free window.

## 4.2 Application-Level Check (Defense in Depth, per `05` §26)

```text
CreateBookingUseCase / ConfirmBookingUseCase:
  1. Query existing bookings for (tenantId, resourceType, resourceId)
     WHERE status IN (HOLD, CONFIRMED, IN_PROGRESS)
       AND tsrange(starts_at, ends_at) && tsrange(:newStart, :newEnd)
  2. If any found -> Result.fail(ResourceOverlapError) BEFORE even
     attempting the insert
  3. Attempt insert inside the transaction anyway (the DB constraint
     is the authoritative guard against a race between step 1's
     check and the insert — mirrors the InsufficientStockError
     pattern's belt-and-suspenders design, 09 §8)
  4. If the DB constraint itself rejects (23P01 exclusion violation)
     -> translate to the same ResourceOverlapError the application
     check would have produced, so the API contract (§7) is uniform
     regardless of which layer caught it
```

This is the concrete fulfillment of `04` §93: *"শুধু frontend availability check যথেষ্ট নয়"* — application check gives fast, friendly UX; the DB constraint is what actually prevents double-booking under concurrent load.

---

# 5. Status State Machine

```text
DRAFT
  ↓ (HoldBookingUseCase — optional, some tenants skip straight to
     CONFIRMED)
HOLD
  ↓ (ConfirmBookingUseCase)
CONFIRMED
  ↓ (StartBookingUseCase — optional, only meaningful for resources
     with a distinct "in use now" moment, e.g. a Service technician
     slot; a pure Rental-window booking may skip directly to COMPLETED)
IN_PROGRESS
  ↓ (CompleteBookingUseCase)
COMPLETED

Any of DRAFT/HOLD/CONFIRMED/IN_PROGRESS -> CANCELLED
```

**Invariants:**
```text
1. Only HOLD/CONFIRMED/IN_PROGRESS participate in overlap exclusion
   (§4.1) — a DRAFT never blocks another booking.
2. HOLD bookings auto-expire (background job, mirrors the Reservation
   auto-release pattern from 09 §7.3 step 4) if not CONFIRMED within
   a tenant-configurable grace window (e.g. 15 minutes) — prevents a
   customer's abandoned checkout flow from permanently locking a
   resource.
3. CONFIRMED -> CANCELLED does not require the consuming module
   (Rental/Service) to also be cancelled automatically — Booking
   fires a domain event (BookingCancelled, per 04 §43) that the
   consuming module's own Use Case (e.g. CancelRentalUseCase, 16
   §5.6) subscribes to and handles on its own terms, rather than
   this module reaching into Rental's tables directly (mirrors the
   cross-module orchestration rule, §9).
```

---

# 6. Use Cases

## 6.1 `CreateBookingUseCase`

```text
Input: customerId, branchId, resourceType, resourceId, startsAt,
       endsAt, advanceAmount?, notes?, operationId

1. Idempotency check
2. Overlap check (§4.2 step 1-2)
3. Persist Booking (status = DRAFT or HOLD per caller's intent —
   most consuming-module flows create directly at HOLD)
4. Audit log
```

## 6.2 `ConfirmBookingUseCase`

```text
Input: bookingId, operationId

1. Validate status IN (DRAFT, HOLD)
2. Re-run overlap check (§4.2) — window may have been contested
   since creation
3. status -> CONFIRMED
4. Emit BookingConfirmed domain event (consuming modules may react —
   e.g. Rental sending a confirmation notification)
5. Audit log
```

## 6.3 `StartBookingUseCase` / `CompleteBookingUseCase`

```text
Input: bookingId, operationId

StartBooking:   validate CONFIRMED -> IN_PROGRESS
CompleteBooking: validate IN_PROGRESS (or CONFIRMED, if the resource
                 type has no meaningful "start" moment) -> COMPLETED
Both: audit log, emit corresponding domain event
```

## 6.4 `CancelBookingUseCase`

```text
Input: bookingId, reason, operationId

1. Validate status != CANCELLED, != COMPLETED
2. status -> CANCELLED, cancelledAt, cancelledReason
3. Emit BookingCancelled domain event (§5 inv. 3)
4. Audit log
```

## 6.5 `ExpireHeldBookingsJob` (background, per `04` §45, mirrors `14` §5.6)

```text
Scheduled (frequent — e.g. every 5 minutes, since HOLD windows are
short, unlike Quotation's day-scale validUntil):
  for each tenant, for each Booking WHERE status = HOLD AND
  createdAt < (now - tenant.settings.bookingHoldGraceMinutes):
    status -> CANCELLED, cancelledReason = "HOLD_EXPIRED"
```

## 6.6 `GetResourceAvailabilityUseCase` (Query)

```text
Input: tenantId, resourceType, resourceId?, dateRangeStart, dateRangeEnd
Output: Booking[] (HOLD/CONFIRMED/IN_PROGRESS only, within range)

Powers the calendar UX (§8) — a pure read query, the same data the
overlap check (§4.2) itself relies on, exposed for UI consumption.
```

---

# 7. Database Detail (extends `06` §6.2)

```text
modules.bookings
  ... (as defined in 06 §6.2) ...
  + branch_id            uuid FK
  + operation_id
  + cancelled_at           timestamptz nullable
  + cancelled_reason         text nullable
  -- resource_type / resource_id already present per 06 §6.2 stub
```

**Amendment flag:** Decision BKG-001 (§11) — `06_DATABASE_SPECIFICATION.md` §6.2 revised to add `branch_id`, `operation_id`, `cancelled_at`/`cancelled_reason`; the `EXCLUDE USING gist` constraint (§4.1 above) is confirmed as the canonical DDL for that section (previously only described conceptually in `06` §6.2).

**Unique:** `UNIQUE(tenant_id, operation_id)`. No `UNIQUE` on resource+window (the exclusion constraint, not a UNIQUE constraint, is what enforces non-overlap — a resource can have many non-overlapping bookings).

---

# 8. UX Flow — Calendar-First

Unlike the transaction-form-first flows of prior modules, Booking's primary UX artifact is a **calendar/timeline view**, since its core value proposition is visual availability.

```text
Booking Calendar
  ┌─────────────────────────────────────────────────┐
  │ Resource Type filter: [All / Rental Asset /       │
  │ Technician / Venue / ...]                          │
  ├─────────────────────────────────────────────────┤
  │  Week/Day view, one row per resourceId              │
  │  ▓▓▓▓ = CONFIRMED    ░░░░ = HOLD                    │
  │  (color intensity distinguishes status, never        │
  │  color-alone per accessibility baseline, 12 §9 —       │
  │  a status label/icon accompanies every block)          │
  ├─────────────────────────────────────────────────┤
  │  Click empty slot -> quick-create Booking form         │
  │  (customer, resource pre-filled from clicked row/       │
  │  slot, startsAt/endsAt pre-filled from click-drag)        │
  └─────────────────────────────────────────────────┘
```

## 8.1 Quick-Create Interaction

```text
Click-drag on an empty calendar slot
  ↓
Inline popover: Customer select, notes, [Hold] or [Confirm Directly]
  ↓
On overlap rejection (ResourceOverlapError, §4.2): the calendar
re-renders the conflicting existing booking highlighted, with a
message identifying exactly which booking conflicts — never a bare
"unavailable" with no context (per 04 §37 error contract, actionable
detail)
```

## 8.2 From a Consuming Module

```text
Rental Order creation (16 §9.1) may optionally start from
"Check Calendar" -> Booking Calendar filtered to resourceType=
RENTAL_ASSET -> select slot -> booking created at HOLD -> returns
to Rental Order form with bookingId pre-filled, continuing 16 §5.1's
ReserveRentalUseCase flow with the booking reference attached.

This is the concrete UX bridge between the two modules — Booking
never redirects INTO a Rental screen automatically; the consuming
module's screen pulls FROM Booking when the user opts to check
availability first.
```

---

# 9. Cross-Module Orchestration Rule

**This module has the strictest dependency direction in the series — it depends on nothing else.**

```text
Booking module -> calls -> (nothing outside its own domain)
Booking module emits -> domain events (BookingConfirmed,
                          BookingCancelled, etc.) that OTHER modules
                          (Rental, Service) may subscribe to
Rental module -> reads -> Booking (via nullable bookingId FK, 16 §3.1)
Service module -> MAY reference -> Booking (if a tenant uses Booking
                          for technician appointment slots — not
                          detailed as a hard dependency in 15, since
                          15 §3's ServiceOrder has no bookingId field;
                          flagged as an open question, §12 Q2)

Dependency direction (concrete):
  booking/application → (no dependency on other domains)
  booking/domain       → (no dependency on other domains)

  rental/application  → booking/application (interface, read + event
                          subscription only)
```

**Why this matters architecturally:** Booking is the clearest illustration in this entire documentation series of Capability-over-Industry (`02` §47) — it has zero knowledge of Rental, Service, Decorator, or any industry vocabulary. It is pure time/resource arithmetic. Every other module in this series depends on Core; Booking depends on **nothing**, which is precisely what makes it safely reusable by any future module (a future Appointment-only Salon vertical, for instance, could consume it identically without this document requiring a single change).

---

# 10. Testing Obligations

```text
Overlap prevention:            two concurrent CreateBookingUseCase
                                calls for the same resource/
                                overlapping window — exactly one
                                succeeds (mirrors 07 §19's concurrent-
                                sale-against-last-unit test pattern,
                                applied here via the EXCLUDE
                                constraint instead of row locking)
Non-overlap allowed:            adjacent (touching, not overlapping)
                                windows for the same resource both
                                succeed — boundary test (tsrange
                                exclusivity/inclusivity correctness)
Status exclusion scope:          a CANCELLED booking's former window
                                is immediately bookable by a new
                                request (§4.1's WHERE clause coverage)
HOLD expiry:                     ExpireHeldBookingsJob correctly
                                cancels only bookings past the grace
                                window, never a fresh HOLD
Polymorphic resource isolation:  a booking for resourceType=
                                "TECHNICIAN" never conflicts with one
                                for resourceType="RENTAL_ASSET" even
                                if resourceId values coincidentally
                                match (composite exclusion key
                                correctness, §4.1)
Idempotency:                     replaying create/confirm/cancel
                                operationId never double-creates or
                                double-transitions
```

---

# 11. Decisions Established by This Document

### Decision BKG-001
`06_DATABASE_SPECIFICATION.md` §6.2 is amended to add `branch_id`, `operation_id`, `cancelled_at`/`cancelled_reason`; the `EXCLUDE USING gist` constraint (§4.1) is confirmed as canonical DDL for that section, requiring the `btree_gist` PostgreSQL extension.

### Decision BKG-002
`Booking.resourceType`/`resourceId` is a polymorphic reference with no hard foreign key — Booking has zero schema/domain knowledge of Rental, Service, or any other consuming module, mirroring the existing `stock_movements.reference_id` pattern (`06` §5.10).

### Decision BKG-003
Only `HOLD`, `CONFIRMED`, and `IN_PROGRESS` bookings participate in overlap exclusion; `DRAFT`, `COMPLETED`, and `CANCELLED` never block a new booking for the same window.

### Decision BKG-004
`HOLD` bookings auto-expire via a background job after a tenant-configurable grace period, preventing abandoned reservation flows from permanently locking a resource — mirroring the auto-release pattern already established for stock reservations (`09` §7.3).

### Decision BKG-005
Booking has no outbound dependency on any other domain module — it is the single module in this series with a fully empty "calls" list in its cross-module orchestration rule (§9), making it the platform's most reusable primitive.

---

# 12. Open Module Questions

```text
1. Should `advanceAmount` (§3, currently display/tracking-only) be
   formally linked to a Core Payment record at HOLD/CONFIRMED time,
   or does that responsibility always belong entirely to the
   consuming module (Rental's own advance-payment step, 16 §5.2 step 5)?
2. Should ServiceOrder (15 §3) gain an optional `bookingId` field
   (symmetric to RentalOrder's, 16 §3.1) for tenants who want
   technician-appointment-slot calendaring through this module,
   or does Service intentionally stay Booking-independent at MVP?
3. Multi-resource bookings (a single event booking that holds a
   Venue AND multiple Rental Assets AND a Technician simultaneously,
   as one atomic customer-facing "Event Booking") — is this a
   Phase-2 composite-booking concept layered on top of this
   document's single-resource-per-row model, or should the atomicity
   requirement be designed in now?
4. Recurring bookings (weekly technician slot, monthly venue booking)
   — out of scope for MVP per the general Roadmap Phase boundaries
   (03 §86 Phase 5), confirm no schema hook is needed now vs deferred
   entirely?
5. Should the Booking Calendar UX (§8) be its own top-level navigation
   item, or always entered contextually from a consuming module
   screen (per §8.2's "Check Calendar" pattern) — affects `12
   _UX_SPECIFICATION.md`'s conditional navigation rule (§3.2)?
```

---

# 13. Module Series — Closing Note

এই document দিয়ে Optional Module series (`14`–`18`) সম্পূর্ণ হলো। পাঁচটি module একটি consistent pattern অনুসরণ করেছে:

```text
Quotation (14)  — pre-commitment estimate, converts to Sale/Project
Service (15)    — diagnose/repair workflow, invoices to Sale,
                   introduced the non-double-deduction principle
Rental (16)     — physical-asset time-bound commitment, introduced
                   new accounting posting rules + the coupled
                   asset/order state machine
Project (17)    — multi-cost-category engagement tracking, extended
                   the non-double-posting principle to accounting
Booking (18)    — the underlying time/resource primitive the above
                   compose, depending on nothing itself
```

**Recurring cross-cutting patterns established across this series** (relevant for the forthcoming Industry Extension documents, `19`–`21`):

```text
1. Every module's "invoice" step delegates to Core Sales — never a
   parallel billing entity (14 §5.5, 15 §5.7, 17 §5.4).
2. Every module's accounting-relevant action posts through
   AccountingPostingService, extending its method catalog rather
   than hand-rolling journals inline (16 §6, 17 §6).
3. Where one business event could trigger effects in two places
   (inventory or accounting), an explicit non-double-effect rule is
   documented rather than left to convention (15 §6, 17 §6.4).
4. Public/customer-facing actions (quotation approval, service
   quote approval) reuse one unguessable-token authorization
   pattern rather than each module inventing its own (14 §5.4,
   15 §5.4/§9 endpoints).
5. Cross-module coupling is always via each other's Application
   Service interface, never internal table access — enforced
   explicitly in every module's §9/§10/§11 "Cross-Module
   Orchestration Rule" section.
```

---

# 14. Next Document

পরবর্তী document:

`19_INDUSTRY_PHARMACY.md`

এখান থেকে Industry Extension series শুরু হবে। Pharmacy extension ইতিমধ্যে `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md`-এর মাধ্যমে সবচেয়ে বেশি reference material পেয়েছে — এই document সেই audit-এর findings-কে Core (Item tracking flags, FEFO allocation, per `07` §6.2, `09` §4.2) এবং এখন-সম্পূর্ণ Module layer-এর ওপর ভিত্তি করে চূড়ান্ত industry-specific specification-এ রূপান্তর করবে: `industry.pharmacy_item_details` / `industry.pharmacy_batch_details` (per `06` §7.1)-এর সম্পূর্ণ ব্যবহার, Prescription entity (যা এখনও কোথাও schema-level define হয়নি), এবং Expiry Alert dashboard widget (per `12` §8)-এর concrete rule সহ।
