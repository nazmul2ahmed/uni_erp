# 12_UX_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** UX Specification — Navigation, Screens, Forms & Interaction Design
**Version:** 1.0 Draft
**Status:** Design Baseline
**Depends on:**
- `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md` (§4, §23 — legacy navigation & UX patterns worth preserving)
- `03_MASTER_PROJECT_SPECIFICATION.md` (§49–51, UX/Accessibility Principles)
- `04_PLATFORM_ARCHITECTURE.md` (§6–8, Tailwind/shadcn Design System)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§7, §8 — Sale/Purchase use cases screens must trigger)
- `10_OFFLINE_SYNC_SPECIFICATION.md` (§10, Sync Visibility UX)
- `11_API_SPECIFICATION.md` (endpoint catalog every screen action maps to)

---

# 1. Purpose

এই document platform-এর **concrete UX layer** নির্ধারণ করে:

```text
Navigation structure (capability-driven, per 01 §4 / 02 §47)
Screen inventory per Core module + Optional module
Form layout conventions
High-frequency screen detailed interaction design (POS, Purchase)
Dashboard composition
Sync/offline visual states (formalizing 10 §10 in UI terms)
Responsive/mobile behavior
Accessibility baseline (per 03 §51)
```

**Rule carried forward (per `04` §88):** UI নিজে business calculation করবে না। প্রতিটি screen নিচে যা বর্ণনা করা হয়েছে তা `11_API_SPECIFICATION.md`-এর endpoint/Use Case-কে trigger করবে — UI শুধু input, display, local optimistic state, এবং offline queueing করবে।

---

# 2. UX Design Principles (Restated & Made Concrete)

Per `03` §49, প্রতিটি screen design করার সময় নিচের checklist apply হবে:

```text
[ ] Workflow-first        — grouped by task, not by database table
[ ] Search-first           — high-frequency entity lookup ≤ 1 keystroke-to-result feel
[ ] Minimal clicks          — POS/Purchase optimized for repetitive daily use
[ ] Progressive disclosure  — advanced fields collapsed by default
[ ] Clear financial feedback — subtotal/discount/tax/total/paid/due always visible
[ ] Offline visibility       — sync state never hidden from the user
[ ] Capability-aware         — hidden/shown based on tenant's enabled modules (02 §47),
                               never a hardcoded industry check
```

---

# 3. Navigation Structure

## 3.1 Top-Level Navigation (Core, always present)

Generalized from the legacy Pharmacy PWA's workflow-grouped sidebar (`01` §4), stripped of industry vocabulary per Decision 002 (`01`):

```text
Dashboard

Sales
 ├── POS
 ├── Sales History
 └── Returns (Customer)

Purchases
 ├── New Purchase
 ├── Purchase History
 ├── Invoice Scan (AI)
 └── Returns (Supplier)

Inventory
 ├── Stock Overview
 ├── Transfers
 ├── Adjustments
 └── Stock Count

Customers
 ├── Customer List
 └── Receivables

Suppliers
 ├── Supplier List
 └── Payables

Accounting
 ├── Chart of Accounts
 ├── Journals
 ├── Trial Balance
 ├── P&L
 ├── Balance Sheet
 ├── Cash Flow
 └── Expenses

Reports
 ├── Sales Summary
 ├── Stock Status
 └── Top Items

Team
 └── Staff / Roles

Administration
 ├── Business Profile
 ├── Branches / Warehouses
 └── Feature Flags

Settings
```

## 3.2 Conditional Navigation (Optional Modules)

Rendered **only** when `tenant_features` (per `06` §4.7) enables the corresponding module — this is the concrete UI mechanism for BD-002 (`02`) and §69 of `05` ("module isolation... UI hidden"):

```text
Quotations          (if quotation enabled)
Bookings            (if booking enabled)
Service Orders      (if service enabled)
Rentals             (if rental enabled)
Projects            (if project enabled)
```

## 3.3 Industry-Specific Navigation Additions

Industry extensions may add **sub-sections inside existing Core menus**, never a parallel top-level menu tree (per §55, `01` — no industry leakage into Core structure):

```text
Pharmacy tenant:
  Inventory → adds "Expiry Alerts" sub-item
  Item form → adds Pharmacy Details tab (generic name, strength, dosage form)

Electronics tenant:
  Item form → adds Electronics Details tab (model, spec, warranty months)
  Sales → Service Orders sub-item auto-relevant (via Service module)

Decorator tenant:
  Projects → adds Event Details tab
  Rentals → primary daily workflow
```

## 3.4 Navigation Resolution Logic

```text
renderNavigation(tenantContext):
  1. Always render Core sections (§3.1)
  2. For each optional module in tenant_features WHERE enabled=true:
       insert module's nav section at its designated slot
  3. For each active industry extension:
       inject extension's sub-items into the relevant Core section
  4. Filter every item further by actor's RBAC permission
     (a module can be tenant-enabled but still hidden per-user if the
     user lacks e.g. accounting.view)
```

**Rule:** navigation is never independently hardcoded per business type — it is a pure function of `(enabledModules, activeIndustryExtensions, actorPermissions)`, mirroring Decision DOM-001 (`07`) applied to UI.

---

# 4. Screen Inventory (Core)

| Screen | Primary Use Cases Triggered | API Endpoints |
|---|---|---|
| Dashboard | (read-only) | `GET /api/reports/dashboard` |
| POS | `CompleteSaleUseCase`, `CreateSaleDraftUseCase` | `POST /api/sales`, `POST /api/sales/drafts` |
| Sales History | (read-only), `CancelSaleUseCase` | `GET /api/sales`, `POST /api/sales/:id/cancel` |
| Customer Return | `CompleteCustomerReturnUseCase` | `POST /api/returns/customer` |
| New Purchase | `ReceivePurchaseUseCase` | `POST /api/purchases` |
| Invoice Scan | `ConfirmPurchaseFromOCRUseCase` | `POST /api/purchases/documents`, `.../confirm` |
| Supplier Return | `CompleteSupplierReturnUseCase` | `POST /api/returns/supplier` |
| Stock Overview | (read-only) | `GET /api/inventory/balances` |
| Transfers | `TransferStockUseCase` | `POST /api/inventory/transfers` |
| Adjustments | `AdjustStockUseCase` | `POST /api/inventory/adjustments` |
| Stock Count | `StartStockCountUseCase`, `SubmitStockCountUseCase` | `POST /api/inventory/stock-counts(/:id/submit)` |
| Customer List/Form | `CreateCustomer`, `UpdateCustomer`, `ArchiveCustomer` | `/api/customers` |
| Receivables | (read-only) | `GET /api/receivables`, `/aging` |
| Supplier List/Form | mirrors Customer | `/api/suppliers` |
| Payables | (read-only) | `GET /api/payables`, `/aging` |
| Customer/Supplier Payment | `RecordCustomerPaymentUseCase` / `RecordSupplierPaymentUseCase` | `POST /api/payments/*` |
| Expenses | `RecordExpenseUseCase` | `POST /api/expenses` |
| Chart of Accounts | manage | `/api/accounting/chart-of-accounts` |
| Journals / Manual Entry | `CreateManualJournalUseCase` | `POST /api/accounting/journals` |
| Trial Balance / P&L / Balance Sheet / Cash Flow | (read-only) | `GET /api/accounting/*` |
| Period Close | `ClosePeriodUseCase` | `POST /api/accounting/periods/close` |
| Staff / Roles | membership + RBAC management | `/api/staff/*`, `/api/roles` |
| Business Profile / Branches / Warehouses | settings | `/api/tenant/*` |
| Feature Flags | module toggle | `PATCH /api/tenant/features` |

---

# 5. POS Screen — Detailed Interaction Design

## 5.1 Layout Zones

```text
┌─────────────────────────────────────────────────────────┐
│ Header: Branch/Warehouse selector · Sync badge · User    │
├───────────────────────────────┬───────────────────────────┤
│                                │                           │
│  ITEM SEARCH (search-first)    │   CART                    │
│  - barcode/name/sku instant     │   - line items            │
│    search with debounce         │   - qty/price/discount    │
│  - disambiguation list if       │     inline-editable        │
│    multiple matches (per 01     │   - remove line            │
│    §23.3)                        │                           │
│                                │                           │
├───────────────────────────────┼───────────────────────────┤
│  CUSTOMER PANEL                │   TOTALS PANEL             │
│  - search/select/walk-in        │   Subtotal                │
│  - quick-create inline          │   Discount                │
│                                │   Tax                      │
│                                │   Grand Total               │
│                                │   Cash Received (input)     │
│                                │   Due (derived, live)       │
├───────────────────────────────┴───────────────────────────┤
│  Footer: Save Draft · Complete Sale · Sync status strip    │
└─────────────────────────────────────────────────────────┘
```

## 5.2 Interaction Flow

Mirrors the legacy PWA's proven flow (`01` §6), generalized to Core `Item`/`AllocationStrategy` vocabulary:

```text
1. Select/confirm Branch + Warehouse (persisted per session)
2. Search item
     -> if item.tracking.serial: prompt explicit serial picker (09 §4.3)
     -> if item.tracking.expiry: batch auto-suggested via FEFO, shown
        read-only unless user has override permission
     -> else: quantity-only entry
3. Adjust qty / unit price (if permitted) / line discount
4. Inline calculation updates (subtotal/discount/tax/total) on every
   keystroke — client-side SalePricingService mirror for instant
   feedback, but NEVER treated as authoritative (server recomputes
   on submit, per 07 §7.4)
5. Select or create customer (walk-in default)
6. Enter cash received -> due auto-calculates
7. Press "Complete Sale"
     -> client generates operationId (uuid) if not already present
        from a resumed draft
     -> if online: POST /api/sales with Idempotency-Key = operationId
     -> if offline: write to pendingOperations (10 §2.1), optimistic
        local receipt shown immediately with "Saved locally" badge
8. On success: show receipt (print/share), clear cart
9. On INSUFFICIENT_STOCK / SERIAL_CONFLICT: show inline error banner
   at the specific cart line, do NOT clear the cart (per 04 §37 error
   contract — actionable, not just a toast)
```

## 5.3 Draft Behavior

```text
Auto-save cart to local Draft (core.drafts type=SALE, 07 §7.8) every
N seconds of inactivity AND on navigation-away — never lost on
accidental tab close (per 01 §23.4, modal-based secondary workflow
preserved as a non-blocking draft panel, not a full navigation).

Draft list accessible via a slide-over panel — resuming a draft
restores cart + customer + not-yet-submitted state, but does NOT
carry over a stale operationId if the draft is significantly edited
(new operationId generated on structural change, per 04 §95 numbering
principle extended to idempotency safety).
```

## 5.4 Ambiguous Match / Disambiguation UX

Preserved verbatim as a UX pattern from `01` §23.3:

```text
Search "para" matches 3 items ->
  inline dropdown list showing: name, distinguishing attribute
  (strength for Pharmacy, model for Electronics, SKU generically),
  current stock at selected warehouse
  -> user clicks correct match -> added to cart
```

---

# 6. Purchase Screen — Detailed Interaction Design

## 6.1 Two Entry Paths

```text
Path A — Manual Entry
  Supplier -> Add Items -> Cost/Qty/Batch(optional)/Expiry(optional)
  -> Payment -> Submit -> ReceivePurchaseUseCase directly

Path B — AI Invoice Scan (per 01 §7, 07 §8.4, 11 §9)
  Upload image/PDF -> AI extraction (async) -> editable draft screen
  -> human reviews/corrects every line -> Confirm
  -> ConfirmPurchaseFromOCRUseCase -> ReceivePurchaseUseCase
```

## 6.2 AI Scan Review Screen — Non-Negotiable UX Rule

**This screen is the concrete UI enforcement of Decision DOM-005 (`07`) and API-002 (`11`).**

```text
┌─────────────────────────────────────────────────────────┐
│  [Invoice image thumbnail, zoomable]                       │
├─────────────────────────────────────────────────────────┤
│  AI-extracted lines (EDITABLE, none pre-confirmed):         │
│   Item | Qty | Cost | Batch# | Expiry | [confidence hint]  │
├─────────────────────────────────────────────────────────┤
│  Banner: "Review each line before confirming — this has    │
│  not yet been recorded as a purchase."                     │
├─────────────────────────────────────────────────────────┤
│  [Confirm & Create Purchase]   [Discard]                    │
└─────────────────────────────────────────────────────────┘
```

```text
There is NO "accept all" shortcut that bypasses per-line visibility.
Low-confidence fields (per AI extraction metadata) are visually
flagged (e.g. amber border) but still require the same explicit
confirm action — no differential trust shortcut for "high confidence"
fields, since the human-review step exists precisely because AI
extraction is not authoritative (per 01 §21, AI must not own Price/
Quantity/Stock).
```

## 6.3 Batch / Expiry Progressive Disclosure

```text
Batch number + expiry date fields are HIDDEN by default per line.
Shown automatically only if item.tracking.batch / item.tracking.expiry
is true for the selected item (per 03 §49.4, progressive disclosure)
— a non-pharmacy tenant purchasing a non-batch item never sees these
fields at all.
```

---

# 7. Form Layout Conventions

## 7.1 Standard Form Anatomy

```text
Title + optional description
   ↓
Primary fields (always visible)
   ↓
[Show advanced options] (collapsed, per 03 §49.4)
   ↓
Actions: [Cancel] [Save] — Save always right-aligned, primary color
```

## 7.2 Field-Level Conventions

```text
Required fields: label suffix "*", not color-only (accessibility, §9)
Money fields: right-aligned, currency symbol prefix, 2-decimal display
              (internal precision per 04 §62 unaffected by display)
Quantity fields: decimal-aware per item.unit.isDecimal (06 §5.7)
Date fields: shadcn/ui Date Picker, tenant timezone-aware display
             (server stores UTC per 04 §61)
Search/Combobox fields: debounced (≈250ms), minimum 2 characters,
                         shows recent/frequent items when empty
                         (search-first principle, 03 §49.2)
```

## 7.3 Validation Feedback

```text
Client-side (Zod + React Hook Form, per 04 §11-12):
  inline, field-level, on-blur + on-submit

Server-side rejection (business rule, e.g. RETURN_QTY_EXCEEDED):
  surfaces as a form-level banner AND highlights the offending field
  where the error `details` payload identifies one (per 04 §37, 11 §3)

Never silently swallow a server validation error as a generic toast
only — the field-level context from `details` must be used when present.
```

---

# 8. Dashboard Composition

Per `01` §5 (capability-based dashboard) and `02` §40 (Universal vs Module vs Industry matrix):

```text
Dashboard Widget Registry
 ├── Sales Summary          (Core, always)
 ├── Cash Position           (Core, always)
 ├── Receivables Due          (Core, always)
 ├── Payables Due             (Core, always)
 ├── Low Stock / Out of Stock (Core Inventory, always)
 ├── Profit Snapshot          (Core, requires accounting.view)
 ├── Expiry Alerts            (Pharmacy extension only — registers
                               itself if industry=PHARMACY active)
 ├── Upcoming Bookings         (Booking module, if enabled)
 ├── Open Service Orders        (Service module, if enabled)
 ├── Rental Utilization          (Rental module, if enabled)
 ├── Project Profitability        (Project module, if enabled)
```

**Rule:** a widget registers itself with the Dashboard Engine (per `01` §5, "Industry module নিজের capability register করবে") — the Dashboard screen itself contains no `if industry == 'pharmacy'` branching logic.

---

# 9. Accessibility Baseline

Per `03` §51, concretely applied:

```text
[ ] All interactive elements reachable via Tab, logical order
[ ] Visible focus ring (never `outline: none` without replacement)
[ ] Color contrast >= WCAG AA for text/background pairs
[ ] Errors communicated via text/icon, not color alone
[ ] Form inputs have associated <label> (shadcn/ui Form primitive
    enforces this by default, per 04 §7)
[ ] Modals/Sheets trap focus and restore focus on close
[ ] Data tables have header scope + sortable-column aria labels
[ ] POS numeric keypad (mobile) is a native/large-touch-target input
```

---

# 10. Responsive / Mobile Behavior

Per `03` §50:

```text
Desktop  — full sidebar + multi-column layouts (POS: search+cart
           side-by-side, per §5.1)
Tablet   — collapsible sidebar, POS retains side-by-side where width
           allows (≥768px), else stacked
Mobile   — bottom nav or drawer nav; POS becomes a stacked flow:
           Search -> Cart (as a bottom sheet) -> Totals (sticky footer)
           — cart-totals sticky footer must always remain visible
           during item search (per "clear financial feedback", §49.5)
```

---

# 11. Sync Visibility UX — Screen-Level Application

Formalizes `10` §10 into concrete UI placement:

```text
Global header: persistent sync indicator (icon + count badge)
  tap/click -> opens Sync Panel (slide-over)

Per-transaction (e.g. a POS sale just completed offline):
  inline badge on the Sales History row: "Saved locally" ->
  "Syncing..." -> disappears (replaced by canonical invoice number)
  on SYNCED, or -> "Needs attention" (red) with tap-to-view reason
  on FAILED/PERMANENTLY_FAILED (per 10 §10, §10.1 actions surfaced
  inline as well as in the Sync Panel)

Offline-restricted actions (10 §8.2) are visually disabled (not
hidden) when navigator.onLine = false, with a tooltip explaining
why — hiding entirely would be confusing since the action reappears
without page reload once back online.
```

---

# 12. Decisions Established by This Document

### Decision UX-001
Navigation is rendered as a pure function of `(enabledModules, activeIndustryExtensions, actorPermissions)` — no screen or menu section is conditionally rendered based on a hardcoded business-type check.

### Decision UX-002
The AI Invoice Scan review screen (§6.2) has no "accept all" or differential-trust shortcut — every extracted line requires the same explicit human confirmation regardless of AI confidence score, concretely enforcing Decision DOM-005 (`07`) at the UI layer.

### Decision UX-003
Batch/expiry/serial input fields are progressively disclosed per-item based on `item.tracking.*` flags (`06` §5.6) — never shown by default, never hardcoded to a specific industry's item type.

### Decision UX-004
Dashboard widgets self-register against a capability-driven registry; the Dashboard screen itself contains no industry-conditional branching.

### Decision UX-005
Offline-restricted actions (per `10` §8.2) are disabled-with-explanation in the UI rather than hidden, since server-side enforcement (`10` §8.3) is authoritative regardless of client display state.

---

# 13. Open UX Questions

```text
1. Should the POS cart support multi-tab (multiple concurrent draft
   carts) for busy cashier stations, or single-cart-at-a-time at MVP?
2. Receipt template customization — how much tenant branding
   flexibility (04 §165 constrains to design-system bounds) is
   exposed as user-configurable at MVP vs Phase 2?
3. Mobile POS — is barcode scanning via device camera required at
   MVP, or manual search only?
4. Dashboard widget layout — fixed per-role default, or
   user-customizable (drag/reorder) at MVP?
5. Disambiguation list (§5.4) — how many concurrent matches before
   switching from inline dropdown to a full search modal?
6. Sync Panel (§11) — auto-open on new FAILED operation, or purely
   pull (user must tap the badge)?
```

---

# 14. Next Document

পরবর্তী document:

`13_SECURITY_SPECIFICATION.md`

এখানে security architecture আরও গভীরে বিস্তারিত হবে — বিশেষভাবে এই UX layer-কে ভিত্তি করে:

```text
Authentication flow detail (session lifecycle, MFA future-readiness)
Authorization middleware implementation shape
Rate limiting exact thresholds (referenced as deferred in 11 §22)
Input sanitization standards per field type
File upload security detail (referenced from 04 §103)
Secret management concrete procedures
Security testing checklist tied to 05 §91, §162-163
Incident response outline
```
