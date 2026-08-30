# 14_MODULE_QUOTATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Quotation Module Specification
**Version:** 1.0 Draft
**Status:** Optional Module Deep-Dive
**Depends on:**
- `02_BUSINESS_DOMAIN_ANALYSIS.md` (§23, Quotation Domain)
- `06_DATABASE_SPECIFICATION.md` (§6.1, `modules.quotations`)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§7, Sales Domain — conversion target)
- `11_API_SPECIFICATION.md` (§18.1, Quotation Endpoints)
- `12_UX_SPECIFICATION.md` (§3.2, Conditional Navigation)

---

# 1. Purpose

এই document Optional Module series-এর প্রথম — `Quotation` module-কে সম্পূর্ণভাবে বিস্তারিত করে:

```text
Domain entities & invariants
Status state machine
Use cases (create, send, accept/reject, convert)
Database detail (beyond the 06 stub)
API contract detail (beyond the 11 stub)
UX flow
Cross-module orchestration (Quotation -> Sale / Project)
```

**Module classification (per `02` §40, §53):** Optional Module — not Core, not Industry. Any tenant may enable it regardless of business family; it is heavily used by Decorator/Project/Service tenants (per `02` §29) but equally applicable to a Retail tenant sending a formal estimate.

---

# 2. Why Optional, Not Core

Per BD-006 (`02`): Quotation is optional because POS-style retail (the MVP baseline, `03` §84) transacts directly via `Sale` without a prior estimate step. Tenants whose sales cycle requires a formal estimate/approval step before commitment (event businesses, B2B trading, project work) enable it via `tenant_features.quotation = true` (`06` §4.7).

```text
Sales Domain (Core, always present)
        ↑
   [optional pre-step]
        │
   Quotation (this module)
```

Quotation never becomes a hard dependency of `CompleteSaleUseCase` (`07` §7.6) — a Sale can always be created directly, with or without this module enabled.

---

# 3. Domain Entity: `Quotation`

```text
Quotation
├── id, tenantId, branchId
├── customerId
├── quotationNumber          -- server-generated, tenant-scoped sequence
├── status: DRAFT | SENT | VIEWED | ACCEPTED | REJECTED | EXPIRED | CONVERTED
├── lines: QuotationLine[]
├── pricing: { subtotal, discountTotal, taxTotal, grandTotal }: Money
├── validUntil: date
├── terms: text
├── convertedSaleId?: uuid    -- set only on CONVERTED
├── convertedProjectId?: uuid -- set only if converted into a Project instead
├── createdAt, updatedAt, createdBy, operationId
```

## 3.1 Value Object: `QuotationLine`

```text
QuotationLine
├── itemId?               -- nullable: a quotation may reference a
│                             free-text service description not yet
│                             an Item (e.g. "Custom decoration setup")
├── description
├── quantity: Quantity
├── unitPrice: Money
├── lineDiscount: Money
├── taxAmount: Money
├── lineTotal: Money (derived)
```

**Design note:** unlike `SaleLine` (`07` §7.2), `itemId` is optional here — a Quotation is allowed to be looser/estimate-grade before a formal Sale or Project locks in exact catalog items. This is deliberate: forcing full Item resolution at quotation time would defeat the purpose of a quick estimate (per `02` §23, "Estimated Total").

---

# 4. Status State Machine

```text
DRAFT
  ↓ (SendQuotationUseCase)
SENT
  ↓ (customer opens a shared link, tracked passively — optional)
VIEWED
  ↓                              ↓
ACCEPTED                      REJECTED
  ↓ (ConvertQuotationUseCase)     ↓
CONVERTED                    (terminal)
  (terminal)

Any of DRAFT/SENT/VIEWED -> EXPIRED
  (automatic, background job, when validUntil passes without
  ACCEPTED/REJECTED)
```

**Invariants:**
```text
1. Only DRAFT quotations may have lines edited freely.
2. SENT/VIEWED quotations require an explicit "Revise" action that
   creates a new DRAFT (a new quotationNumber, linked via
   supersedesQuotationId) rather than mutating a sent quotation —
   mirrors the Reversal-over-Destructive-Edit principle (02 §52)
   applied to a non-financial-but-customer-facing document.
3. CONVERTED is terminal — a converted quotation's lines are
   immutable historical record; corrections happen on the resulting
   Sale/Project, not by reopening the quotation.
4. EXPIRED quotations may be "Revived" only by explicit user action,
   which clones into a new DRAFT (never silently reactivated).
```

---

# 5. Use Cases

## 5.1 `CreateQuotationUseCase`

```text
Input: customerId, branchId, lines[], validUntil, terms, operationId

1. Idempotency check
2. Validate customer belongs to tenant
3. Calculate pricing (reuses SalePricingService, 07 §7.4 — pricing
   math is identical whether the target is a Quotation or a Sale)
4. Persist Quotation (status = DRAFT), generate quotationNumber
5. Audit log
```

## 5.2 `SendQuotationUseCase`

```text
Input: quotationId, deliveryChannel (EMAIL/WHATSAPP/LINK), operationId

1. Validate status = DRAFT
2. Generate a shareable view link (tenant-branded, read-only render
   of the quotation — no auth required to view, but the link itself
   is an unguessable token, not a sequential ID — per IDOR principles
   in 13 §3.2 applied to a public-facing document)
3. status = SENT
4. Dispatch via Notification domain (02 §34) on the chosen channel
5. Audit log
```

## 5.3 `RecordQuotationViewedUseCase` (passive, triggered by the public link)

```text
Input: quotationId, viewedAt

1. If status = SENT -> status = VIEWED (one-directional; VIEWED
   does not revert to SENT on subsequent views)
2. No audit log required (non-sensitive, informational only)
```

## 5.4 `RespondToQuotationUseCase` (customer-facing accept/reject)

```text
Input: quotationId, decision (ACCEPT/REJECT), respondentNote?

1. Validate status IN (SENT, VIEWED)
2. status = ACCEPTED or REJECTED
3. Notify tenant staff (Notification domain event: QuotationAccepted /
   QuotationRejected, per 04 §43)
4. Audit log
```

**Security note:** this endpoint is reachable via the unguessable public link token (§5.2), not standard session auth — it is the one deliberate exception to `13` §3.1's guard chain, scoped narrowly to "can only ACCEPT/REJECT the one specific quotation the token was issued for," never a general tenant-data endpoint.

## 5.5 `ConvertQuotationUseCase`

**This is the canonical cross-module orchestration example for this document.**

```text
Input: quotationId, targetType (SALE | PROJECT), operationId

1. Validate status = ACCEPTED
2. Validate targetType is enabled for tenant (PROJECT requires the
   Project module, per 02 §40 matrix)
3. Branch:
   a. targetType = SALE:
        delegate to CreateSaleDraftUseCase (07 §7.8) pre-populated
        from quotation lines -> staff reviews/completes via normal
        POS/Sale flow (CompleteSaleUseCase, 07 §7.6) — conversion
        does NOT bypass normal Sale validation (stock availability
        may have changed since the quotation was drafted)
   b. targetType = PROJECT:
        delegate to CreateProjectUseCase (15_MODULE_PROJECT.md,
        forthcoming) pre-populated from quotation lines/pricing
4. Set quotation.convertedSaleId / convertedProjectId
5. status = CONVERTED
6. Audit log
```

**Non-negotiable (mirrors Decision DOM-002, `07` §20):** `ConvertQuotationUseCase` never directly writes Sale/Project/Inventory/Accounting tables itself — it only calls the already-existing Use Cases from those domains. This keeps Quotation a true "optional module" that composes Core capability rather than duplicating it.

## 5.6 `ExpireQuotationsJob` (background, per `04` §45)

```text
Scheduled (daily, tenant-timezone-aware per 05 §116):
  for each tenant, for each Quotation WHERE status IN (DRAFT, SENT,
  VIEWED) AND validUntil < today:
    status = EXPIRED
```

---

# 6. Database Detail (extends `06` §6.1)

```text
modules.quotations
  ... (as defined in 06 §6.1) ...
  + branch_id             uuid FK
  + supersedes_quotation_id uuid FK nullable  -- revision chain (§4)
  + valid_until            date
  + view_token             text UNIQUE        -- unguessable public
                                                 link credential (§5.2)
  + viewed_at               timestamptz nullable
  + responded_at             timestamptz nullable
  + respondent_note           text nullable
  + operation_id

modules.quotation_items
  ... (as defined in 06 §6.1) ...
  + line_discount, tax_amount, line_total   -- amendment: 06 stub
                                               omitted these; added
                                               here for pricing parity
                                               with SaleLine (07 §7.2)
```

**Amendment flag:** `06_DATABASE_SPECIFICATION.md` §6.1 should be revised to include the fields above — flagged as Decision QTN-001, §11.

**Unique:** `UNIQUE(tenant_id, quotation_number)`, `UNIQUE(tenant_id, operation_id)`, `UNIQUE(view_token)`

---

# 7. API Detail (extends `11` §18.1)

```text
GET    /api/quotations                           [quotation.view]
GET    /api/quotations/:id                        [quotation.view]
POST   /api/quotations                            [quotation.create]
                                                   [Idempotent, optional]
                                                   -> CreateQuotationUseCase (§5.1)
POST   /api/quotations/:id/send                    [quotation.create]
                                                   -> SendQuotationUseCase (§5.2)
POST   /api/quotations/:id/revise                   [quotation.create]
                                                   -> clones into new DRAFT (§4 inv. 2)
POST   /api/quotations/:id/convert                  [quotation.create][sales.create]
                                                   [Idempotent REQUIRED]
                                                   -> ConvertQuotationUseCase (§5.5)

Public (token-authenticated, not session-authenticated — §5.4):
GET    /api/public/quotations/:viewToken            -> read-only render,
                                                        triggers RecordQuotationViewedUseCase
POST   /api/public/quotations/:viewToken/respond      -> RespondToQuotationUseCase (§5.4)
```

**Rate limiting (extends `13` §5.1):** the public quotation endpoints get their own class — 30 requests/hour per `viewToken`, since they are unauthenticated and reachable by anyone with the link.

---

# 8. UX Flow (extends `12` §3.2, §4)

```text
Quotation List (filterable by status)
  ↓
New Quotation
  Customer selection/quick-create
  ↓
  Add lines (item search OR free-text description, per §3.1)
  ↓
  Set validUntil, terms
  ↓
  Save Draft  OR  Send
       ↓
  [Send] -> channel picker (Email/WhatsApp/Link) -> confirmation
       ↓
  Status badge updates live (DRAFT/SENT/VIEWED/ACCEPTED/REJECTED/
  EXPIRED/CONVERTED) — color-coded per 12 §7 form conventions
       ↓
  On ACCEPTED: [Convert to Sale] / [Convert to Project] buttons appear
  (only the module(s) the tenant has enabled are shown, per UX-001
  from 12 §12)
```

**Customer-facing view (public link):**

```text
Tenant-branded read-only quotation render
  ↓
[Accept] [Reject] buttons (only shown while status IN SENT/VIEWED)
  ↓
On response: thank-you confirmation screen, no further action exposed
```

---

# 9. Cross-Module Orchestration Rule

Per `04` §91 and Decision DOM-002 (`07` §20) extended to optional modules:

```text
Quotation module -> calls -> Sales application service (interface)
Quotation module -> calls -> Project application service (interface)
Quotation module domain layer -> has NO dependency on Sales/Project
                                  internals

Dependency direction (concrete):
  quotation/application → sales/application (interface)
  quotation/application → project/application (interface)
  quotation/domain      → (no dependency on other domains)
```

---

# 10. Testing Obligations

Per `03` §79–81 pattern, applied to this module:

```text
QuotationPricingService:     identical math coverage to SalePricingService
                              (reused, so covered by 07 §19 tests — no
                              duplicate test suite needed for the shared
                              calculation, only for Quotation-specific
                              wrapping)
Status state machine:        every valid transition + every invalid
                              transition attempt (e.g. converting a
                              REJECTED quotation must fail)
ConvertQuotationUseCase:     happy path to Sale, happy path to Project,
                              failure when target module not enabled,
                              failure when stock insufficient at
                              conversion time (delegated Sale validation)
Public link security:        token unguessability (sufficient entropy),
                              expired/converted quotation link becomes
                              read-only-informational (no longer accepts
                              Accept/Reject)
Idempotency:                 replaying convert operationId never
                              double-creates a Sale/Project
```

---

# 11. Decisions Established by This Document

### Decision QTN-001
`06_DATABASE_SPECIFICATION.md` §6.1 is amended to add `branch_id`, `supersedes_quotation_id`, `valid_until`, `view_token`, `viewed_at`, `responded_at`, `respondent_note`, and pricing fields (`line_discount`, `tax_amount`, `line_total`) on `modules.quotation_items`.

### Decision QTN-002
`QuotationLine.itemId` is nullable — Quotation is the one Core-adjacent line-item structure that permits a free-text, non-catalog description, distinct from `SaleLine`/`PurchaseLine` which always require a resolved `Item`.

### Decision QTN-003
Editing a `SENT`/`VIEWED` quotation is never done in place — a "Revise" action always creates a new linked `DRAFT` quotation, preserving the customer-facing document's integrity once shared.

### Decision QTN-004
`ConvertQuotationUseCase` is a pure orchestrator over existing Sales/Project Use Cases — it holds no independent Sale/Project/Inventory mutation logic.

### Decision QTN-005
The public quotation response endpoints (§7) are the one deliberate exception to the standard session-based guard chain (`13` §3.1), authorized instead by an unguessable per-quotation `view_token`, narrowly scoped to that single document.

---

# 12. Open Module Questions

```text
1. Should quotation-to-project conversion (§5.5b) wait for
   15_MODULE_PROJECT.md to be authored before this use case is
   implementable, or should it be stubbed/deferred to Phase 2
   independently of documentation order?
2. Multi-currency quotations (for tenants quoting international
   clients) — in scope for this module ever, or strictly bound by
   the tenant's single base currency (03 §54) like everything else?
3. E-signature / formal acceptance beyond a button click — needed
   for any target vertical, or is a simple Accept/Reject sufficient?
4. Quotation templates (reusable line-item bundles, e.g. a Decorator's
   "Standard Wedding Package") — Phase 2 feature or MVP-adjacent?
5. View-token expiry — should the public link itself expire
   independently of the quotation's validUntil (security hygiene),
   or are they the same deadline?
```

---

# 13. Next Document

পরবর্তী document:

`15_MODULE_SERVICE.md`

এখানে Service module (Service Order, Technician, Parts+Labour, Work Order lifecycle) একই pattern অনুসরণ করে বিস্তারিত হবে — Electronics repair এবং AC/Electrical service উভয়ের জন্য common framework হিসেবে (per `02` §27), Sales domain-এর সঙ্গে "invoice conversion" orchestration সহ (parts+labour → Sale, এই document-এর §5.5-এর মতো একই pattern অনুসরণ করে)।
