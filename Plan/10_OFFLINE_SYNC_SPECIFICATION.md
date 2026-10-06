# 10_OFFLINE_SYNC_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Offline & Synchronization Engine Specification
**Version:** 1.0 Draft
**Status:** Domain Deep-Dive
**Depends on:**
- `04_PLATFORM_ARCHITECTURE.md` (§49–56, Offline Storage/Sync/PWA)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§45–47, Offline Tenant Isolation)
- `06_DATABASE_SPECIFICATION.md` (§8, Offline/Sync Support Tables)
- `07_CORE_DOMAIN_SPECIFICATION.md` (§17, Idempotency Contract)
- `09_INVENTORY_ENGINE_SPECIFICATION.md` (§8.4, Offline-Origin Stock Conflict)

---

# 1. Purpose

এই document Offline-first architecture-এর সম্পূর্ণ operational specification নির্ধারণ করে:

```text
Client-side persistence model
Sync engine state machine
Conflict taxonomy & resolution strategy per class
Server-side sync API contract
Offline safety boundary (what's allowed offline, what isn't)
Multi-device / multi-tenant offline isolation
UX for sync visibility
```

**Foundational principle carried forward (per `04` §54):**

> Offline client কখনো `final accounting authority` হবে না। Server reconciliation authoritative।

---

# 2. Client-Side Persistence Model (IndexedDB / Dexie)

## 2.1 Store: `pendingOperations`

```text
operationId (PK, uuid, client-generated)
tenantId
userId
deviceId
entityType        -- SALE | PURCHASE | RETURN | PAYMENT | CUSTOMER | ...
entityId          -- client-local reference (may be a LOCAL- temp id)
operationType     -- CREATE | ACTION (e.g. "complete", "cancel")
payload           -- full serialized use-case input
status            -- PENDING | SYNCING | SYNCED | FAILED | PERMANENTLY_FAILED
createdAt
attemptCount
lastError
lastAttemptAt
```

**Indexes:** `[tenantId+status]`, `[tenantId+deviceId]`, `[tenantId+entityType+status]`

## 2.2 Store: `localCache`

```text
tenantId, entityType, entityId, payload, cachedAt
```

Read-optimized mirror of server data for offline browsing (customers, items, recent sales) — populated by `pull` sync (§6.2), never the source of pending mutations.

## 2.3 Store: `drafts`

Mirrors `core.drafts` (per `06` §5.16) locally — allows draft creation fully offline without entering the sync queue at all (drafts are not business transactions, per §96 `04`).

## 2.4 Store: `syncState`

```text
tenantId (PK)
lastPulledAt
lastPulledSequence   -- see §6.3, change feed cursor
lastSyncAttemptAt
```

**Per-tenant, not global** — one device may hold state for multiple tenants (per `05` §47).

## 2.5 Store: `deviceState`

```text
deviceId (PK, generated once, persisted in browser storage)
registeredAt
lastSeenAt
```

`deviceId` is stable per browser/installation, independent of which tenant or user is currently active on it.

---

# 3. Tenant & Device Partitioning Rule

Per `05` §45–47 (non-negotiable):

```text
Every record in pendingOperations, localCache, drafts, and syncState
carries tenantId as part of its key or index.

A pending operation created while Tenant A is active NEVER appears in
Tenant B's sync queue, even on the same device/browser.

On tenant switch (05 §44):
  1. Do NOT clear pendingOperations for the previous tenant (they must
     still sync eventually)
  2. Clear/hide localCache view for the previous tenant from active UI
  3. Load syncState + pendingOperations scoped to the newly active tenant
  4. Trigger a fresh pull for the new tenant
```

---

# 4. Sync Engine — State Machine

## 4.1 Per-Operation States

```text
PENDING
  ↓ (network available + engine picks it up)
SYNCING
  ↓ (server 2xx / idempotent success)          ↓ (server 4xx business rejection)
SYNCED                                          FAILED
                                                   ↓ (retry, up to maxAttempts)
                                                 SYNCING (retry)
                                                   ↓ (maxAttempts exceeded, or
                                                      non-retryable error class)
                                                 PERMANENTLY_FAILED
```

## 4.2 Retry Policy

```text
Retryable errors:   network timeout, 5xx, TENANT_TEMP_UNAVAILABLE
Non-retryable:      VALIDATION_FAILED, PERMISSION_DENIED,
                     INSUFFICIENT_STOCK, PERIOD_LOCKED,
                     TENANT_ACCESS_DENIED

Retryable -> exponential backoff (e.g. 5s, 15s, 60s, 5m, capped),
             up to maxAttempts (config, default 8) before
             auto-transition to PERMANENTLY_FAILED with lastError retained.

Non-retryable -> immediate transition to FAILED, surfaced to user for
                 manual review — never silently retried.
```

## 4.3 Engine Loop (client)

```text
on network online, on app foreground, on interval timer:
  1. Load pendingOperations WHERE tenantId = activeTenant AND status IN (PENDING, FAILED-retryable)
     ORDER BY createdAt ASC   -- preserves user-intended ordering
  2. For each, sequentially (see §5 Ordering):
       mark SYNCING
       POST /api/sync/push { operation }
       on success -> mark SYNCED, apply server-canonical result to localCache
       on failure -> classify (retryable/non-retryable), update status/lastError
  3. After push batch, run pull (§6.2)
```

---

# 5. Operation Ordering & Dependencies

## 5.1 Why Order Matters

```text
Example: Customer created offline (op A), then a Sale referencing that
customer created offline (op B). If op B syncs before op A, the server
cannot resolve the customer reference.
```

## 5.2 Ordering Rule

```text
Operations sync in strict createdAt order, per tenant, single-threaded
on the client (no parallel pushes within one tenant).

For cross-entity references created offline (e.g. Sale.customerId
pointing to a not-yet-synced Customer):
  payload carries the CLIENT-LOCAL id (e.g. "LOCAL-cust-<uuid>")
  server sync endpoint resolves LOCAL- ids by checking:
    "has an operation with this local id already been applied in
     this push batch or a prior one for this tenant?"
  if yes -> substitute canonical server id before executing the use case
  if no  -> reject with DEPENDENCY_NOT_SYNCED (retryable — will succeed
            once the dependency op is processed, since ordering is
            preserved)
```

## 5.3 Local ID Convention

```text
LOCAL-<entityType>-<clientUuid>     -- e.g. LOCAL-CUSTOMER-3f2a...

Applies to:
  Customer, Supplier (created inline during offline sale/purchase entry)
  Sale invoice number -> per 04 §95, becomes LOCAL-... until server
    assigns canonical INV-2026-00001 on sync
```

---

# 6. Server-Side Sync API

## 6.1 Push — `POST /api/sync/push`

```text
Request:
{
  operations: [
    { operationId, entityType, operationType, payload, clientCreatedAt }
  ]
}

Server processing, per operation, in array order:
  1. Authenticate + resolve TenantContext (per 05 §17-20)
  2. Idempotency check: core.sync_operations WHERE (tenantId, operationId)
     -> if APPLIED, return stored result_snapshot immediately (no re-execution)
  3. Resolve any LOCAL- references per §5.2
  4. Route to the appropriate Application Use Case (from 07/08/09)
     e.g. entityType=SALE, operationType=ACTION:complete -> CompleteSaleUseCase
  5. Use case runs its normal transaction (validation, posting, audit —
     unchanged from the online path; sync is just an alternate entry point,
     NOT a parallel code path with different rules)
  6. On success: persist core.sync_operations (status=APPLIED, result_snapshot),
     return canonical entity (with real IDs, invoice numbers, etc.)
  7. On business-rule failure: persist core.sync_operations (status=REJECTED,
     result_snapshot=error), return structured error

Response:
{
  results: [
    { operationId, status: "APPLIED" | "REJECTED", data?, error? }
  ]
}
```

**Critical architectural rule:** the sync endpoint calls the *same* Use Cases as the interactive REST API (`CompleteSaleUseCase`, `ReceivePurchaseUseCase`, etc.) — per Decision DOM-002 (`07` §20). There is no separate "offline business logic." This guarantees the server-authoritative principle (`04` §54) by construction rather than by discipline.

## 6.2 Pull — `GET /api/sync/pull?cursor=...`

```text
Request: cursor (opaque, from syncState.lastPulledSequence)

Server:
  1. Resolve TenantContext
  2. Query change feed (§6.3) for changes since cursor, scoped to tenant
     AND scoped to entities this user/role is authorized to see
     (per 05 §130 AI checklist analog — applies to sync too: no data
     beyond the user's permission scope should ever reach localCache)
  3. Return changes + new cursor

Response:
{
  changes: [ { entityType, entityId, payload, changeType: UPSERT|DELETE } ],
  nextCursor
}
```

## 6.3 Change Feed / Cursor Strategy

Per `04` §147–148:

```text
core.change_log (new table, addendum to 06)
  id, tenant_id, entity_type, entity_id, change_type,
  change_sequence (bigserial, per-tenant monotonic via trigger or
  application-level sequence), occurred_at

Every mutating Use Case, as part of its transaction, appends a
change_log row alongside its normal writes (via AuditLogger extension
or a dedicated ChangeLogService.record call).

Cursor = last-seen change_sequence value, NOT a timestamp
  (avoids same-timestamp collision issues noted in 04 §147).
```

This is flagged as a schema addendum — see §12, Decision SYNC-002.

---

# 7. Conflict Taxonomy & Resolution

Restating and completing the classes from `04` §42:

| Conflict Class | Example | Resolution Strategy |
|---|---|---|
| **No Conflict** | Straightforward create, no dependency issues | Apply normally |
| **Duplicate Operation** | Same `operationId` pushed twice (retry after network blip) | Idempotency replay — return stored result, no re-execution (§6.1 step 2) |
| **Dependency Not Synced** | Sale references a `LOCAL-` customer not yet applied | Retry automatically once dependency clears (§5.2) — client-visible as `SYNCING`, not `FAILED` |
| **Business Rule Failure** | Offline sale now exceeds available stock (per `09` §8.4) | REJECTED, surfaced to user for manual review — **no automatic overwrite** |
| **Stale Version** | Customer edited on Device A and Device B while both offline, both sync | Master data: last-write-wins by `updatedAt`, BUT flagged for user visibility if divergent fields are non-trivial (see §7.1) |
| **Concurrent Update** | Two devices both adjust the same item's stock offline | Each posts its own `ADJUSTMENT` movement on sync (movements are append-only, so this is naturally conflict-free — see §7.2) |
| **Permission Revoked** | User's role changed while offline, no longer allowed to `sales.create` | REJECTED with `PERMISSION_DENIED`, non-retryable, surfaced to user |
| **Deleted Entity** | Customer archived on server while offline device still references it | REJECTED with `ENTITY_NOT_FOUND` or `ENTITY_ARCHIVED` depending on entity semantics; sale offered for manual re-target |
| **Tenant Suspended** | Tenant suspended between offline operation creation and sync | REJECTED with `TENANT_ACCESS_DENIED`, non-retryable (per `05` §58) |

## 7.1 Master Data Conflict Detail (Stale Version)

```text
Applies to: Customer, Supplier, Item (non-transactional, editable records)

core.<entity>.updated_at is compared:
  server_version.updated_at vs operation.payload.baseUpdatedAt
    (client stores the updatedAt it last saw when it started the offline edit)

if server_version.updated_at > operation.baseUpdatedAt:
  -> conflict detected
  -> apply LAST-WRITE-WINS by default for MVP simplicity
  -> but log both versions to core.sync_operations.result_snapshot for
     traceability, and if the two versions differ in more than a
     trivial field set, flag status = APPLIED_WITH_CONFLICT so the UI
     can inform the user "this record was also edited elsewhere"

Financial/transactional entities (Sale, Purchase, Payment) NEVER use
last-write-wins — per 04 §53, "silent merge not allowed for financial
transactions." These are create-once, append-effect entities; there is
no concept of "editing" a completed one offline (per 07 §7.3 invariant 5).
```

## 7.2 Why Stock Movements Are Naturally Conflict-Free

```text
Because core.stock_movements is append-only (per 09 §2), two offline
adjustments from two devices don't overwrite each other — they both
become distinct movement rows, and the balance recompute (09 §3) folds
both in. The only conflict surface is availability at SALE time
(handled as Business Rule Failure above, not a merge conflict).
```

---

# 8. Offline Safety Boundary — Concrete List

Per `04` §43, finalized here:

## 8.1 Allowed Offline

```text
- POS Sale (CompleteSaleUseCase) — subject to post-sync stock validation
- Purchase entry (without AI/OCR — that requires connectivity)
- Customer / Supplier creation
- Draft creation/editing (any type)
- Basic stock adjustment (small quantity, no approval-required threshold)
- Payment recording against a known (already-synced) Sale/Purchase
- Browsing localCache (customers, items, recent sales — read-only, may
  be stale)
```

## 8.2 Restricted — Requires Connectivity

```text
- Account/period closing (08 §9)
- Large/approval-required stock adjustment (09 §7 threshold — approval
  workflow cannot be evaluated offline against current permission state)
- User role/permission changes
- Accounting manual journal adjustments (08 §10.2 — elevated permission,
  requires live authorization check)
- Purchase invoice OCR/AI extraction (requires AI provider connectivity,
  per 04 §80)
- Tenant configuration/settings changes
- Multi-branch stock transfer above a configurable threshold (optional
  tenant setting — smaller transfers may be allowed offline)
```

## 8.3 Enforcement

```text
Client UI hides/disables restricted actions when navigator.onLine = false
(soft UX guard).

Server is the authoritative enforcement point regardless: any operation
in the "Restricted" list arriving via /api/sync/push is still executed
through its normal Use Case, which independently re-validates permission/
state — an offline-queued restricted operation is not rejected merely
for being restricted, but because its live validation (permission,
period-lock, approval state) is now checked against CURRENT server
state, which may reject it for the same reasons it wasn't allowed
offline in the first place.
```

---

# 9. Multi-Device Identity

## 9.1 Device Registration

```text
On first app load per browser/installation:
  1. Generate deviceId (uuid), persist in localStorage (not IndexedDB,
     to survive IndexedDB clears) and mirror into deviceState store
  2. On first authenticated action, POST device registration
     { deviceId, userAgent, registeredAt } -> server tracks in a
     lightweight control-plane or tenant-scoped device registry
     (design choice: control-plane, since a device isn't tenant-bound —
     per 05 §47, "deviceId global, local DATA tenant+device scoped")
```

## 9.2 Device ID Is Not Authentication

Per `04` §145 — `deviceId` accompanies operations for traceability/debugging and offline-queue partitioning, but every sync request still requires a valid authenticated session. A stolen `deviceId` alone grants nothing.

---

# 10. Sync Visibility UX

Per `03` §49.6, `01` §23.6:

```text
Per-operation badge states (mapped from pendingOperations.status):
  PENDING            -> "Saved locally"
  SYNCING            -> "Syncing..."
  SYNCED             -> "Synced" (then removed from active view after
                         a short confirmation window)
  FAILED             -> "Needs attention" + reason (business rule
                         failures shown with specific message, e.g.
                         "Stock unavailable — please review")
  PERMANENTLY_FAILED -> "Sync failed" + manual retry/discard actions

Global sync indicator (header/sidebar):
  count of PENDING + SYNCING + FAILED operations for active tenant
  tapped -> opens Sync Panel listing all non-SYNCED operations
```

## 10.1 Sync Panel Actions

```text
Retry (manual)       -- re-attempts a FAILED/PERMANENTLY_FAILED op
Discard              -- removes a PERMANENTLY_FAILED op from queue
                        (does NOT undo any local UI state derived from
                        it — user must manually correct, e.g. re-enter
                        the sale with adjusted stock)
View details         -- shows payload + lastError for troubleshooting
```

---

# 11. Background Sync (Service Worker)

Per `04` §55:

```text
Where browser supports Background Sync API:
  register a sync event that wakes the service worker to flush
  pendingOperations even if the app tab is closed (best-effort, not
  guaranteed across all browsers/platforms)

Where unsupported (iOS Safari PWA limitations, etc.):
  fallback to foreground-only sync (on app open/foreground/online event)
  — this is a known, accepted platform limitation, not a bug to solve
    at MVP (flagged §13)
```

Service worker does **not** duplicate business logic (per `04` §55) — it only triggers the same client-side sync engine loop (§4.3) that runs in the foreground.

---

# 12. Schema Addenda From This Document

### `core.sync_operations` (already defined in `06` §8.3 — confirmed, no change)

### `core.change_log` (new — Decision SYNC-002)

```text
id, tenant_id, entity_type, entity_id,
change_type (UPSERT/DELETE), change_sequence (bigserial per tenant),
occurred_at
```

**Index:** `INDEX(tenant_id, change_sequence)`

### `control.devices` (new — Decision SYNC-003, control-plane per §9.1 reasoning)

```text
id (=deviceId), user_id, first_seen_at, last_seen_at, user_agent
```

---

# 13. Deferred / Future Scope

```text
1. True Background Sync API support matrix per platform — documented
   in a future ops runbook, not blocking MVP
2. Peer-aware conflict UI (showing WHO made the conflicting edit, not
   just that one occurred) — needs richer change_log actor tracking
3. Configurable per-tenant offline allowlist (some tenants may want to
   restrict even POS sales offline, e.g. high-value jewelry) — deferred,
   MVP boundary in §8 is fixed platform-wide
4. Partial sync (priority queue — sync sales before drafts) — MVP uses
   simple createdAt FIFO ordering (§5.2) only
```

---

# 14. Decisions Established by This Document

### Decision SYNC-001
The sync push endpoint invokes the identical Application Use Cases used by the interactive REST API — there is no parallel "offline business logic" implementation, guaranteeing server-authoritative behavior by construction.

### Decision SYNC-002
`core.change_log` is added to the canonical schema to support cursor-based pull sync via monotonic per-tenant `change_sequence`, avoiding timestamp-collision cursor issues.

### Decision SYNC-003
`control.devices` is added to the canonical schema as a control-plane (not tenant-scoped) registry, since a device is user-bound, not tenant-bound.

### Decision SYNC-004
Financial/transactional entities never use last-write-wins conflict resolution; only non-transactional master data (Customer/Supplier/Item edits) may use last-write-wins, with conflict visibility logging.

### Decision SYNC-005
The offline safety boundary (§8) is enforced softly on the client (UX guard) and strictly on the server (identical live validation regardless of operation origin) — the two are complementary, not redundant.

---

# 15. Open Sync Questions

```text
1. maxAttempts and backoff schedule — final values need load-testing
   before freeze (currently placeholder: 8 attempts, capped exponential)
2. Should APPLIED_WITH_CONFLICT (§7.1) block further edits until user
   acknowledges, or just show a passive notice?
3. Device registry retention/cleanup policy — indefinite, or expire
   after N months of inactivity?
4. Does Purchase entry offline (without OCR) still create a
   core.purchase_documents placeholder, or skip AI entirely for that path?
5. Should large stock transfers be blocked offline platform-wide, or
   left to tenant configuration (ties into 09 §13 open question)?
```

---

# 16. Next Document

পরবর্তী document:

`11_API_SPECIFICATION.md`

এখানে REST API-এর সম্পূর্ণ contract নির্ধারণ করা হবে:

```text
Endpoint catalog per module (Sales, Purchase, Inventory, Payments,
Accounting, Sync, Auth, Tenant)
Request/response schemas (Zod-aligned)
Error code -> HTTP status mapping (completing the table started in 04 §38)
Idempotency-Key header contract (formalizing 04 §39 for the
non-offline/interactive path)
Pagination & filtering conventions (applying 04 §154–155 concretely)
Authentication & authorization flow per endpoint class
```
