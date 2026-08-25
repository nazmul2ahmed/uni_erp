# 11_API_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** API Specification
**Version:** 1.0 Draft
**Status:** Contract Baseline
**Depends on:**
- `04_PLATFORM_ARCHITECTURE.md` (§35–44, API Architecture)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§17–20, Tenant Resolution)
- `07_CORE_DOMAIN_SPECIFICATION.md` (Use Cases per module)
- `10_OFFLINE_SYNC_SPECIFICATION.md` (§6, Sync API — referenced, not redefined here)

---

# 1. Purpose

এই document REST API-এর সম্পূর্ণ external contract নির্ধারণ করে — প্রতিটি Application-layer Use Case (`07`–`09`-এ সংজ্ঞায়িত) কীভাবে একটি HTTP endpoint হিসেবে expose হবে।

```text
Endpoint catalog per module
Request/response schemas
Error code -> HTTP status mapping (completes 04 §38)
Idempotency-Key header contract (formalizes 04 §39)
Pagination & filtering conventions
Authentication & authorization flow per endpoint class
```

**Rule carried forward (per `04` §87):** API route layer only does *Parse → Authenticate → Authorize → Call Use Case → Serialize*. No business logic lives here — every endpoint below is a thin wrapper over a Use Case already defined in `07`, `08`, or `09`.

---

# 2. Base Conventions

```text
Base path:        /api
Versioning:        unversioned initially (04 §104); breaking changes -> /api/v2
Content-Type:      application/json
Auth:              HTTP-only secure session cookie (04 §31), no bearer
                    token in localStorage
Tenant resolution:  derived from session + selected tenant, NEVER from
                    a client-supplied body/query tenantId (05 §17, §20)
```

## 2.1 Standard Response Envelope (per `04` §37)

```json
Success:
{
  "success": true,
  "data": { ... },
  "meta": { "requestId": "..." }
}

Error:
{
  "success": false,
  "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": {} },
  "requestId": "..."
}
```

## 2.2 Idempotency-Key Header

```text
Applies to all POST endpoints marked [Idempotent] below.

Header: Idempotency-Key: <uuid>

Server behavior (mirrors 07 §17 domain contract, exposed at API level):
  - Same (tenantId, endpoint, Idempotency-Key) seen before with a
    completed result -> return the stored response verbatim, same
    HTTP status, no re-execution.
  - Different payload with same key -> IDEMPOTENCY_KEY_REUSED error
    (409) — the key must represent one specific intended operation.
  - This header is REQUIRED (not optional) on financial mutation
    endpoints (Sales, Purchases, Payments, Returns, Expenses,
    Adjustments) — request rejected with VALIDATION_FAILED if absent.
  - Non-financial mutations (Customer/Supplier/Item CRUD) — OPTIONAL;
    if present, same idempotency semantics apply.
```

## 2.3 Pagination

```text
Cursor-based (preferred, per 04 §154):
  GET /api/sales?cursor=<opaque>&limit=50
  Response meta: { "nextCursor": "...", "hasMore": true }

Offset-based (acceptable only for small admin lists per 04 §154):
  GET /api/roles?page=1&pageSize=20
```

## 2.4 Filtering

```text
Common query params (per 04 §155), validated via Zod schema per endpoint:
  ?dateFrom=&dateTo=
  ?status=
  ?customerId= / ?supplierId=
  ?branchId= / ?warehouseId=
  ?categoryId=
  ?q=            -- free-text search
```

---

# 3. Error Code → HTTP Status Mapping

Completes the catalog started in `04` §38, now including codes introduced in `07`–`10`:

| Code | HTTP | Retryable (per `10` §4.2) |
|---|---|---|
| `VALIDATION_FAILED` | 400 | No |
| `IDEMPOTENCY_KEY_REUSED` | 409 | No |
| `IDEMPOTENCY_REPLAY` | 200/201 (original status) | N/A — not an error |
| `AUTHENTICATION_REQUIRED` | 401 | No |
| `PERMISSION_DENIED` | 403 | No |
| `TENANT_ACCESS_DENIED` | 403 | No |
| `TENANT_SUSPENDED` | 403 | No |
| `SALE_NOT_FOUND` / `*_NOT_FOUND` | 404 | No |
| `SALE_ALREADY_COMPLETED` | 409 | No |
| `INSUFFICIENT_STOCK` | 409 | No |
| `SERIAL_CONFLICT` | 409 | No |
| `RETURN_QTY_EXCEEDED` | 409 | No |
| `DISCOUNT_EXCEEDED` | 403 | No |
| `UNBALANCED_JOURNAL` | 500 (should never surface — internal invariant) | No |
| `PERIOD_LOCKED` | 409 | No |
| `DEPENDENCY_NOT_SYNCED` | 409 | Yes (sync path only, per `10` §5.2) |
| `ENTITY_ARCHIVED` | 409 | No |
| `TENANT_TEMP_UNAVAILABLE` | 503 | Yes |
| `RATE_LIMITED` | 429 | Yes (with backoff) |
| `INTERNAL_ERROR` | 500 | Yes (infra-class only) |

**Rule:** production error responses never include stack traces (per `04` §37) — `details` contains only structured, safe-to-display business context (e.g. `{ requestedQty: 5, availableQty: 2 }` for `INSUFFICIENT_STOCK`).

---

# 4. Authentication & Session Endpoints

```text
POST   /api/auth/login              { email, password } -> session cookie
POST   /api/auth/logout             -> clears session
POST   /api/auth/register           (tenant owner signup flow)
GET    /api/auth/me                 -> current user + tenant memberships
POST   /api/auth/tenant/select      { tenantId } -> switches active tenant
                                      in session (per 05 §43-44)
POST   /api/auth/password/reset-request
POST   /api/auth/password/reset-confirm
```

**Authorization for this group:** `AUTHENTICATION_REQUIRED` only (no tenant/permission check needed pre-login, except `/tenant/select` which checks Membership per `05` §18).

---

# 5. Customer Endpoints

```text
GET    /api/customers                  [permission: customers.view]
GET    /api/customers/:id              [customers.view]
POST   /api/customers                  [customers.create] [Idempotent, optional]
PATCH  /api/customers/:id              [customers.update]
POST   /api/customers/:id/archive      [customers.update]
GET    /api/customers/:id/ledger       [customers.view]
                                        -> { sales, returns, payments, receivableBalance }
```

Maps to Use Cases in `07` §4.2. `GET .../ledger` is a Query, backed by `ReceivableAgingService` + read-model joins — never a manually-maintained due field (per `02` §49).

---

# 6. Supplier Endpoints

```text
GET    /api/suppliers                  [suppliers.view]
GET    /api/suppliers/:id              [suppliers.view]
POST   /api/suppliers                  [suppliers.create] [Idempotent, optional]
PATCH  /api/suppliers/:id              [suppliers.update]
POST   /api/suppliers/:id/archive      [suppliers.update]
GET    /api/suppliers/:id/ledger       [suppliers.view]
```

Mirrors §5, per `07` §5.

---

# 7. Catalog (Item) Endpoints

```text
GET    /api/items                      [catalog.view]
GET    /api/items/:id                  [catalog.view]
POST   /api/items                      [catalog.create] [Idempotent, optional]
PATCH  /api/items/:id                  [catalog.update]
POST   /api/items/:id/archive          [catalog.update]
GET    /api/items/:id/stock-summary    [inventory.view]
                                        -> { onHand, reserved, byWarehouse, byBatch }

GET    /api/item-categories            [catalog.view]
POST   /api/item-categories            [catalog.manage]
GET    /api/brands                     [catalog.view]
POST   /api/brands                     [catalog.manage]
GET    /api/units                      [catalog.view]
POST   /api/units                      [catalog.manage]
```

---

# 8. Sales Endpoints

```text
GET    /api/sales                            [sales.view]
GET    /api/sales/:id                         [sales.view]
POST   /api/sales/drafts                       [sales.create]
                                                -> CreateSaleDraftUseCase (07 §7.8)
PATCH  /api/sales/drafts/:id                    [sales.create]
POST   /api/sales                              [sales.create] [Idempotent REQUIRED]
                                                -> CompleteSaleUseCase (07 §7.6)
POST   /api/sales/:id/cancel                    [sales.cancel] [Idempotent REQUIRED]
                                                -> CancelSaleUseCase (07 §7.7)
GET    /api/sales/:id/receipt                   [sales.view]
                                                -> renders/returns receipt document
```

**Request body — `POST /api/sales` (illustrative shape):**

```json
{
  "customerId": "uuid | null",
  "branchId": "uuid",
  "lines": [
    {
      "itemId": "uuid",
      "quantity": "2.00",
      "unitPrice": "150.00",
      "lineDiscount": "0.00",
      "batchId": "uuid | null",
      "serialId": "uuid | null",
      "warehouseId": "uuid"
    }
  ],
  "orderDiscount": "0.00",
  "cashReceived": "300.00",
  "saleDate": "2026-08-23T10:00:00Z"
}
```

Validated by Zod schema aligned to `SaleLine` value object (`07` §7.2) — client validation for UX, server validation authoritative (per `04` §11–12).

---

# 9. Purchase Endpoints

```text
GET    /api/purchases                          [purchase.view]
GET    /api/purchases/:id                       [purchase.view]
POST   /api/purchases                          [purchase.create] [Idempotent REQUIRED]
                                                -> ReceivePurchaseUseCase (07 §8.3)
POST   /api/purchases/documents                 [purchase.create]
                                                -> uploads invoice image/PDF,
                                                   triggers AI OCR (async),
                                                   returns purchase_document id
GET    /api/purchases/documents/:id             [purchase.create]
                                                -> poll for extracted_data
                                                   readiness
POST   /api/purchases/documents/:id/confirm      [purchase.create] [Idempotent REQUIRED]
                                                -> ConfirmPurchaseFromOCRUseCase
                                                   (07 §8.4), body = human-
                                                   verified line data
```

**Non-negotiable (per `07` §8.4, Decision DOM-005):** there is no endpoint that accepts `extracted_data` directly into `ReceivePurchaseUseCase` — `/documents/:id/confirm` is the only path from an AI-extracted document to a real Purchase, and it requires the human-edited/confirmed body, not a "just accept AI output" flag.

---

# 10. Inventory Endpoints

```text
GET    /api/inventory/balances                 [inventory.view]
                                                ?itemId=&warehouseId=
POST   /api/inventory/adjustments               [inventory.adjust] [Idempotent REQUIRED]
                                                -> AdjustStockUseCase (07 §9.4)
POST   /api/inventory/transfers                 [inventory.transfer] [Idempotent REQUIRED]
                                                -> TransferStockUseCase (07 §9.5)
GET    /api/inventory/movements                 [inventory.view]
                                                ?itemId=&warehouseId=&dateFrom=&dateTo=

POST   /api/inventory/reservations              [inventory.reserve] [Idempotent REQUIRED]
                                                -> ReserveStockUseCase (09 §7.3)
DELETE /api/inventory/reservations/:referenceId [inventory.reserve] [Idempotent REQUIRED]
                                                -> ReleaseReservationUseCase (09 §7.4)

POST   /api/inventory/stock-counts              [inventory.count]
                                                -> StartStockCountUseCase (09 §9.2)
POST   /api/inventory/stock-counts/:id/submit    [inventory.count] [Idempotent REQUIRED]
                                                -> SubmitStockCountUseCase (09 §9.3)
```

---

# 11. Returns Endpoints

```text
GET    /api/returns                             [returns.view]
GET    /api/returns/:id                          [returns.view]
POST   /api/returns/customer                     [returns.create] [Idempotent REQUIRED]
                                                -> CompleteCustomerReturnUseCase (07 §12.3)
POST   /api/returns/supplier                     [returns.create] [Idempotent REQUIRED]
                                                -> CompleteSupplierReturnUseCase (07 §12.3)
```

---

# 12. Payment Endpoints

```text
GET    /api/payments                            [payments.view]
POST   /api/payments/customer                    [payments.create] [Idempotent REQUIRED]
                                                -> RecordCustomerPaymentUseCase (07 §10.3)
POST   /api/payments/supplier                     [payments.create] [Idempotent REQUIRED]
                                                -> RecordSupplierPaymentUseCase (07 §10.4)
GET    /api/receivables                          [accounting.view]
                                                ?status=&customerId=
GET    /api/receivables/aging                    [accounting.view]
                                                -> ReceivableAgingService (07 §11.2)
GET    /api/payables                             [accounting.view]
GET    /api/payables/aging                       [accounting.view]
```

---

# 13. Expense Endpoints

```text
GET    /api/expenses                            [expenses.view]
POST   /api/expenses                            [expenses.create] [Idempotent REQUIRED]
                                                -> RecordExpenseUseCase (07 §14.2)
GET    /api/expense-categories                  [expenses.view]
POST   /api/expense-categories                  [expenses.manage]
```

---

# 14. Accounting Endpoints

```text
GET    /api/accounting/chart-of-accounts         [accounting.view]
POST   /api/accounting/chart-of-accounts         [accounting.manage]
                                                -> add tenant-custom sub-account

GET    /api/accounting/trial-balance             [accounting.view]
                                                ?dateFrom=&dateTo=&branchId=
                                                -> per 08 §6.1
GET    /api/accounting/profit-and-loss           [accounting.view]
                                                ?dateFrom=&dateTo=&branchId=
                                                -> per 08 §6.2
GET    /api/accounting/balance-sheet             [accounting.view]
                                                ?asOfDate=&branchId=
                                                -> per 08 §6.3
GET    /api/accounting/cash-flow                 [accounting.view]
                                                ?dateFrom=&dateTo=
                                                -> per 08 §6.4

POST   /api/accounting/journals                  [accounting.post] [Idempotent REQUIRED]
                                                -> CreateManualJournalUseCase (08 §10.2)
POST   /api/accounting/opening-entries            [accounting.post] [Idempotent REQUIRED]
                                                -> per 08 §5.8, onboarding only

POST   /api/accounting/periods/close              [accounting.close_period] [Idempotent REQUIRED]
                                                -> ClosePeriodUseCase (08 §9.2)
POST   /api/accounting/periods/:id/reopen          [accounting.reopen_period] [Idempotent REQUIRED]
                                                -> requires the rare elevated permission
                                                   noted in 08 §9.3
```

---

# 15. Tenant / Staff / RBAC Endpoints

```text
GET    /api/tenant/profile                       [settings.view]
PATCH  /api/tenant/profile                       [settings.manage]
                                                -> business_profiles update

GET    /api/tenant/branches                      [settings.view]
POST   /api/tenant/branches                      [settings.manage]
GET    /api/tenant/warehouses                    [settings.view]
POST   /api/tenant/warehouses                    [settings.manage]

GET    /api/staff/members                        [staff.manage]
POST   /api/staff/invite                          [staff.manage]
PATCH  /api/staff/members/:membershipId           [staff.manage]
                                                -> role/status change

GET    /api/roles                                [staff.manage]
POST   /api/roles                                [staff.manage]
                                                -> tenant custom role
PATCH  /api/roles/:id                             [staff.manage]

GET    /api/tenant/features                       [settings.view]
PATCH  /api/tenant/features                        [settings.manage]
                                                -> module enable/disable
```

---

# 16. Audit & Documents Endpoints

```text
GET    /api/audit-logs                           [audit.view]
                                                ?entityType=&entityId=&dateFrom=&dateTo=

POST   /api/documents/upload                      [documents.upload]
                                                -> returns signed object key
                                                   reference (per 04 §56-58)
GET    /api/documents/:id/download-url            [documents.view]
                                                -> signed, short-lived URL
```

---

# 17. Sync Endpoints (reference only — full contract in `10`)

```text
POST   /api/sync/push                           per 10 §6.1
GET    /api/sync/pull                           per 10 §6.2
```

Not redefined here to avoid duplication/drift — `10_OFFLINE_SYNC_SPECIFICATION.md` is authoritative for this pair.

---

# 18. Module Endpoints (Optional Modules)

## 18.1 Quotation

```text
GET    /api/quotations                           [quotation.view]
POST   /api/quotations                           [quotation.create] [Idempotent, optional]
POST   /api/quotations/:id/send                   [quotation.create]
POST   /api/quotations/:id/convert                [quotation.create][sales.create]
                                                  [Idempotent REQUIRED]
                                                  -> creates a Sale from quotation
```

## 18.2 Booking

```text
GET    /api/bookings                             [booking.view]
POST   /api/bookings                             [booking.create] [Idempotent REQUIRED]
                                                  -> concurrency-checked (09 §4.4 /
                                                     06 §6.2 exclusion constraint)
PATCH  /api/bookings/:id/status                    [booking.create]
```

## 18.3 Service Orders

```text
GET    /api/service-orders                       [service.view]
POST   /api/service-orders                       [service.create]
PATCH  /api/service-orders/:id                     [service.create]
POST   /api/service-orders/:id/invoice             [service.create][sales.create]
                                                  [Idempotent REQUIRED]
                                                  -> converts parts+labour to a Sale
```

## 18.4 Rental

```text
GET    /api/rental-orders                        [rental.view]
POST   /api/rental-orders                         [rental.create] [Idempotent REQUIRED]
POST   /api/rental-orders/:id/dispatch              [rental.create]
POST   /api/rental-orders/:id/return                [rental.create] [Idempotent REQUIRED]
                                                  -> triggers inspection + optional
                                                     damage charge (08 §5.5/5.6 effect)
```

## 18.5 Project

```text
GET    /api/projects                             [project.view]
POST   /api/projects                              [project.create]
POST   /api/projects/:id/costs                     [project.create] [Idempotent REQUIRED]
POST   /api/projects/:id/invoices                   [project.create][sales.create]
                                                  [Idempotent REQUIRED]
GET    /api/projects/:id/profitability              [project.view]
```

---

# 19. Reporting Endpoints

```text
GET    /api/reports/dashboard                    [reports.view]
                                                  -> per capability-based dashboard
                                                     model (01 §5)
GET    /api/reports/sales-summary                [reports.view]
GET    /api/reports/stock-status                  [reports.view]
                                                  -> low stock, out of stock,
                                                     expiry alerts (if applicable)
GET    /api/reports/top-items                     [reports.view]
```

These back the AI tool functions referenced in `03` §44 (`getSalesSummary()`, `getStockStatus()`, etc.) — the AI layer calls these same endpoints/services, never a separate data path (per `04` §81).

---

# 20. Authorization Flow — Applied Per Endpoint

Every endpoint above follows the sequence from `04` §33 / `05` §18:

```text
1. Authenticate (session valid?)
2. Resolve TenantContext (active tenant from session, per 10 §2)
3. Verify Membership (user belongs to this tenant, status ACTIVE)
4. Check permission (the bracketed [resource.action] per endpoint above)
5. Resource ownership check (does :id actually belong to this tenant? —
   prevents IDOR, per 05 §92)
6. Validate payload (Zod schema)
7. Call Use Case
8. Serialize response
```

Steps 1–5 are implemented once as shared middleware/guard composition, not duplicated per route handler — consistent with the "no accidental omission" principle from `05` §22–23.

---

# 21. New API Checklist Applied

Per `05` §127, every endpoint catalogued above satisfies:

```text
[x] Authentication           — session middleware
[x] Tenant resolution        — TenantContext middleware
[x] Permission               — bracketed permission per endpoint
[x] Resource ownership       — repository queries always tenant-scoped
[x] Validation                — Zod schema per request body
[x] Idempotency if mutation   — marked [Idempotent] / [Idempotent REQUIRED]
[x] Audit if sensitive        — inherited from underlying Use Case (07 §15)
[x] Error code                — mapped in §3
[ ] Rate limit if needed      — applied selectively, see §22
```

---

# 22. Rate Limiting Application

Per `04` §77, applied to this concrete endpoint set:

```text
Strict:     /api/auth/login, /api/auth/password/reset-request
Moderate:   /api/reports/*, /api/accounting/trial-balance,
            /api/accounting/profit-and-loss (expensive queries)
Standard:   all other mutation endpoints (per-tenant quota, per 05 §72)
Elevated:   /api/documents/upload (size + frequency)
```

Exact thresholds are deferred to `13_SECURITY_SPECIFICATION.md`.

---

# 23. Deferred to Other Documents

```text
Exact rate-limit thresholds        -> 13_SECURITY_SPECIFICATION.md
Full request/response Zod schemas  -> generated alongside implementation,
                                       referenced from packages/validation
OpenAPI/Swagger document generation -> tooling task, post-freeze
Webhook payload contracts           -> 23_AUTOMATION_ARCHITECTURE.md
AI tool-calling endpoint contracts   -> 22_AI_ARCHITECTURE.md
```

---

# 24. Decisions Established by This Document

### Decision API-001
Idempotency-Key is a REQUIRED header (not optional) on every financial mutation endpoint (Sales, Purchases, Payments, Returns, Expenses, Inventory Adjustments/Transfers, Accounting postings) — requests without it are rejected at the validation layer before reaching any Use Case.

### Decision API-002
There is exactly one endpoint (`POST /api/purchases/documents/:id/confirm`) through which AI-extracted purchase data can become a real Purchase — no endpoint accepts raw OCR output as authoritative input.

### Decision API-003
Authorization steps 1–5 (§20) are implemented as shared, composable middleware applied uniformly — no per-route reimplementation of tenant/permission checks.

### Decision API-004
Reporting/AI-tool data endpoints (§19) are the single source both the UI dashboard and the AI assistant layer query — no separate "AI data path" exists.

---

# 25. Open API Questions

```text
1. Should GET endpoints ever require Idempotency-Key? (No — confirmed
   here, but flagged for explicit exclusion in implementation docs)
2. Bulk operations (bulk import per 04 §156) — separate endpoint family
   or reuse POST with array payload + job queuing?
3. Webhook-triggering endpoints — do they need their own permission
   scope distinct from the underlying business action's permission?
4. Should /api/reports/* support CSV/PDF export inline, or always
   redirect to the async export job pattern (04 §157)?
```

---

# 26. Next Document

পরবর্তী document:

`12_UX_SPECIFICATION.md`

এখানে প্রতিটি module-এর জন্য concrete screen flows, navigation structure (বিদ্যমান Pharmacy PWA-এর workflow-first pattern থেকে generalized, per `01` §4), form layouts, এবং POS/Purchase-এর মতো high-frequency screen-এর detailed interaction design নির্ধারণ করা হবে — এই API contract-কে ভিত্তি ধরে।
