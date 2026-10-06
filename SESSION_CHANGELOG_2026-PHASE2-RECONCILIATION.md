# SESSION_CHANGELOG_2026-PHASE2-RECONCILIATION.md

**Date:** This session (Phase 0.5 documentation closure + Phase 2 code-verification pass)
**Scope:** Documentation reconciliation (§A) + real-database code verification and fixes (§B)

---

## §A — Documentation Changes

### `Plan/07_CORE_DOMAIN_SPECIFICATION.md`
- **Added §7.6a** — "Registered Extension Points on `CompleteSaleUseCase`" — canonical registry table indexing the three hooks already implied by `15`, `19`, `20` (Pharmacy prescription gate, Service non-double-deduction skip, Electronics warranty auto-issuance). No behavior change — documentation-only, closes Phase 0.5 Finding 3.
- **Added Decision DOM-007** to §20 (Decisions Established).

### `Plan/25_DEPLOYMENT_ARCHITECTURE.md`
- **Added §6.2a** — "Required PostgreSQL Extensions" — formalizes the provisioning-pipeline placement of `pgcrypto`/`btree_gist`, closing a live gap where `docker/init-extensions.sql`'s own header comment cited this section before it existed.
- **Added Decision DEP-006** to §14 (Decisions Established).

### `Plan/06_DATABASE_SPECIFICATION.md`
- **Amendment Ledger (§18):** split row 22 into 22a (TEN-002, connection pooling) and 22b (DEP-006, extension provisioning) — these were two unrelated decisions previously conflated under one row. Added row 24 (DOM-007).
- **Added Decision DB-011** to §13 — records this session's three findings (two doc gaps, one code defect) in one place.

**No schema/migration changes were required by §A — policy/process documentation only.**

---

## §B — Code Changes (all verified against a real PostgreSQL 16 instance, not mocks)

### 🔴 Fix 1 — `DiscountThresholdPolicy` (Decision DOM-006) was undocumented-as-unenforced

**Files:** `apps/web/lib/guard.ts`, `apps/web/lib/use-cases/sale.ts`, `packages/shared/errors.ts`

**Before:** `sales.discount.override` was seeded as a permission (`packages/db/seed/seed-control-plane.ts`) and referenced in a validation-layer comment (`packages/validation/sale.ts`), but `completeSale()` never checked a discount ceiling or the override permission at all — any actor holding `sales.create` could apply a 100% discount.

**After:**
- `TenantContext` (`guard.ts`) now carries a resolved `permissions: string[]`, populated once per request by a new exported `resolvePermissions(roleId)` helper (also reused by the new integration test, avoiding a duplicate implementation).
- `requirePermission()` refactored to read from `ctx.permissions` instead of a per-call DB query (net reduction in DB round-trips for routes checking multiple permissions).
- New `hasPermission(ctx, key): boolean` non-throwing check for use inside domain logic.
- `completeSale()` now loads the tenant's `sales.maxDiscountPercent` (from `core.business_profiles.settingsJson`, default `20` if unset — flagged in code as an implementation-detail default, not a ratified business decision) and enforces it per line **and** at the order-discount level (the order-level check is a flagged, recommended extension of `07` §7.5a's literal scope — not silently invented, called out in both the code comment and this changelog).
- New error code `DISCOUNT_EXCEEDED` (403) added to the shared catalog, matching `11_API_SPECIFICATION.md` §3's existing table.
- Audit entries for `sale.complete` now include a `discountOverrideApplied: boolean` flag when the override permission was actually exercised.

**New test:** `apps/web/test/sale-discount-policy.integration.test.ts` — 6 cases run against a real database with real seeded roles (OWNER has the override permission, STAFF does not), including the `=` ceiling boundary, the over-ceiling rejection, the override-permitted path, the order-level-discount bypass attempt, the audit-flag assertion, and an idempotency-replay check.

### 🔴 Fix 2 — `core.journals.operation_id` (uuid column) was receiving a non-UUID string

**File:** `apps/web/lib/accounting.ts`

**Before:** `postSaleJournal`/`postCustomerReturnJournal` built each sub-journal's idempotency key as `` `${operationId}:revenue` `` / `` `${operationId}:cogs` `` — a plain string concatenation inserted into a `uuid`-typed column. **This meant every sale that reached the accounting-posting step (i.e. every completing sale) would crash against a real PostgreSQL database** with `invalid input syntax for type uuid`. This was undetected prior to this session because the accounting posting path had only ever been exercised through mocks.

**After:** a new `deterministicSubOperationId(baseOperationId, suffix)` helper derives an RFC 4122 UUIDv5-style value (SHA-1, fixed namespace) from the pair — a valid UUID, and still deterministic, so the original design intent ("each half gets its own operationId suffix so either can independently replay-guard," per the function's own docblock) is preserved rather than discarded.

**Verification:** confirmed via the new integration test suite (§ above) — sales that reach `postSaleJournal` now complete successfully end-to-end against a live database.

### Minor — two bugs in this session's own new test file, fixed before being counted as passing
- Cleanup code attempted to `DELETE` from `core.audit_logs`, which is intentionally append-only at the database grant level (`migrations-manual/0006_rls_audit_logs.sql` revokes UPDATE/DELETE from `erp_app` by design, per `07` §15.1) — removed that delete, left audit rows as harmless test-DB debris.
- Assertions compared `numeric(18,4)` column values (always returned with 4 decimal places by PostgreSQL) against un-padded literals — corrected to match actual column precision.

---

## Verification Summary

```text
pnpm -r typecheck   → clean, 0 errors (all 4 workspace packages)
pnpm -r test        → 44 passed, 0 failed
  packages/db         1 test  (RLS tenant-scoping)
  apps/web           43 tests (8 suites: 6 mocked route suites [19
                      tests, unchanged from before this session] +
                      tenant-isolation.integration.test.ts [18 tests,
                      real DB — pre-existing, now confirmed passing
                      against a real instance for the first time this
                      session] + sale-discount-policy.integration.
                      test.ts [6 tests, NEW])
```

Verified against a freshly-provisioned local PostgreSQL 16 instance (roles `erp`/`erp_app`, extensions, migrations, and seed all applied via the project's own standard scripts — `docker/init-roles.sql`, `docker/init-extensions.sql`, `pnpm db:migrate`, `pnpm db:seed` — no shortcuts).

---

## Not Done In This Session (explicitly out of scope, not silently skipped)

- Staff/Membership/Role management API (`app/api/staff/*`, `app/api/roles/*`) — still does not exist. `INV-OWN-002`/`INV-OWN-003` (owner-transfer, membership-removal guards, per `05` §75a) remain undemonstrated at the application layer because there is no use case to demonstrate them in yet. This is expected Phase 1-remaining-scope, not a regression from this session.
- COGS costing WAC-fallback approximation (`lib/use-cases/sale.ts`'s own code comment, pre-existing, self-flagged) — untouched; out of scope for this pass.
- `06 §12` Open Schema Questions items 1–8 — untouched, genuinely still open.

---

## §C — Staff/Membership API (second pass, same session continuation)

**Governing spec:** `05_MULTI_TENANT_ARCHITECTURE.md` §75a–78, `11_API_SPECIFICATION.md` §15, `06_DATABASE_SPECIFICATION.md` §4.3–4.4.

### New files

```text
packages/validation/staff.ts        — inviteStaffSchema, updateMembershipSchema,
                                        transferOwnershipSchema
packages/validation/role.ts         — createRoleSchema, updateRoleSchema
apps/web/lib/platform-audit.ts      — recordPlatformAudit(), targets
                                        control.audit_events_platform
                                        (distinct from tenant-business
                                        core.audit_logs — 06 §4.9 vs §15.2)
apps/web/lib/use-cases/staff.ts     — listStaff, inviteStaff, updateMembership,
                                        transferOwnership
apps/web/lib/use-cases/role.ts      — listRoles, createRole, updateRole
apps/web/app/api/staff/members/route.ts                              (GET)
apps/web/app/api/staff/invite/route.ts                                (POST)
apps/web/app/api/staff/members/[membershipId]/route.ts                (PATCH)
apps/web/app/api/staff/members/[membershipId]/transfer-ownership/route.ts (POST — NEW endpoint, see below)
apps/web/app/api/roles/route.ts                                        (GET, POST)
apps/web/app/api/roles/[id]/route.ts                                   (PATCH)
apps/web/test/staff-membership.integration.test.ts                     (17 tests, real DB)
```

### Key design points

- **`INV-OWN-002`/`INV-OWN-003` (05 §75a) implemented literally**: `updateMembership()` rejects with `OWNER_TRANSFER_REQUIRED` (409) unconditionally whenever the target is the tenant's canonical `owner_membership_id` — even for a would-be no-op change — per the spec's literal algorithm. `transferOwnership()` performs the pointer move atomically, requires the caller to currently BE the owner, requires the target membership to be `ACTIVE`, and does NOT auto-reassign the previous owner's role (spec marks that step optional; left to a future explicit action rather than silently invented).
- **Control-plane vs tenant-business audit boundary respected**: staff/role/ownership mutations write to `control.audit_events_platform` via the new `recordPlatformAudit()`, never `core.audit_logs` — mirrors the Control-Plane/Business-Plane separation already established for billing (`26` §2).
- **`control.*` tables carry no RLS** (`05` §11–13) — `withPlatformTransaction()` is used (not `withTenantTransaction()`), with explicit `tenantId` filtering on every query, since RLS cannot provide defense-in-depth here the way it does for `core.*`.
- **Multi-tenant membership (05 §12) honored**: inviting an email that already belongs to a platform user adds a new membership for the existing user rather than erroring or duplicating the user row; inviting a genuinely new email creates the user with a random, argon2id-hashed, one-time temporary password returned in the API response (no email delivery integration exists yet — Automation/Notification is Phase 8 — flagged explicitly in code, not silently assumed).
- **IDOR-safe role references**: a `roleId` supplied to invite/update must resolve to either a platform preset (`tenantId IS NULL`) or the caller's own tenant's custom role — never another tenant's — verified by a dedicated cross-tenant test.

### Documented, flagged specification extension (not silently invented)

`11_API_SPECIFICATION.md` §15's endpoint list did not include a transfer-ownership endpoint, leaving `INV-OWN-002` a structural dead end (an owner's membership could never be modified, with no path forward). Added `POST /api/staff/members/:membershipId/transfer-ownership` as **Decision API-005**, merged directly into `Plan/11_API_SPECIFICATION.md` §15/§24 in this same session (per the project's "Option C" dual-declaration discipline) rather than left as a code-only comment for a future pass.

### Verification

```text
pnpm -r typecheck   → clean, 0 errors
pnpm -r test        → 61 passed, 0 failed
  packages/db         1 test
  apps/web           60 tests (9 suites — the 43 from §B's fixes,
                      unchanged/still passing, + 17 new staff-membership
                      integration tests: owner-invariant enforcement,
                      ownership-transfer atomicity + audit trail,
                      two distinct cross-tenant IDOR checks, duplicate-
                      membership rejection, unknown-permission-key
                      rejection, and the multi-tenant shared-user path)
```

### Not done in this pass (flagged, not silently skipped)

- `GET/PATCH /api/tenant/profile`, `/api/tenant/branches`, `/api/tenant/warehouses`, `/api/tenant/features` (rest of `11` §15) — out of scope for "Staff/Membership API" specifically; `tenant/profile` already exists from an earlier pass, `warehouse` use-cases exist but aren't yet wired to `/api/tenant/warehouses`, `branches`/`features` have no use case yet.
- Reauthentication/step-up-auth before `transferOwnership` (`05` §76 suggests it "may be required") — no such mechanism exists anywhere in this codebase (`13` §14 Q2, open platform-wide); a `confirm: true` body field is a minimal placeholder, not a substitute.
- A real invite-acceptance flow (`status = INVITED` → user sets their own password on first login) — deferred to Phase 8 per `10` §14 point 3 / `28` §4's Automation/Notification phase boundary.

---

## §E — Van/Route Sales Module: Phases 1–3 (fourth pass, same session continuation)

**Governing spec:** `30_MODULE_VAN_SALES.md` (new document, this session).

### Phase 1 — Schema (complete)
```text
packages/db/schema/modules.ts        — NEW file, first table set in the
                                        `modules` PostgreSQL schema:
                                        rep_stock_assignments,
                                        rep_stock_assignment_lines,
                                        rep_stock_movements,
                                        rep_custody_balances
packages/db/schema/commerce.ts       — core.return_lines.condition
                                        (Decision VAN-003); core.
                                        receivables generalized to
                                        partyType CUSTOMER|REP
                                        (Decision VAN-006);
                                        core.stock_movements gains
                                        REP_ISSUE/REP_RETURN_GOOD
                                        (Decision VAN-002)
packages/db/drizzle.config.ts        — schemaFilter now includes
                                        "modules"
migrations/0006_low_chameleon.sql    — auto-generated
migrations-manual/0007_grant_and_rls_modules.sql
                                      — modules schema grants, RLS on
                                        all 4 new tables, Decision
                                        VAN-009's partial unique index
                                        (one active assignment per
                                        rep), rep_custody_balances'
                                        partial unique indexes (same
                                        NULL-uniqueness fix as
                                        Decision INV-008), CHECK
                                        constraints for every
                                        Drizzle-enum-typed column
                                        (confirmed Drizzle's
                                        text(enum:[...]) is TS-only,
                                        NOT DB-enforced — verified by
                                        inspecting the generated DDL)
```

### Phase 2 — Core Return Domain Extension, Decision VAN-003 (complete, tested)
`core.return_lines.condition` (RESELLABLE default / UNSELLABLE) — `CompleteCustomerReturnUseCase` (`lib/use-cases/returns.ts`) now nets an UNSELLABLE return's stock effect to zero and posts an additional write-off journal (`Dr 5900 Inventory Shrinkage/Expiry Expense, Cr 1200 Inventory`), while the revenue-reversal journal is unchanged either way. New system accounts `1250 Stock With Sales Reps` / `5900 Inventory Shrinkage/Expiry Expense` added to `lib/accounting.ts`'s lazy-provisioning catalog. **3 new tests** (`test/return-condition.integration.test.ts`) — including a mixed RESELLABLE+UNSELLABLE-in-one-return case and an explicit backward-compatibility check.

### Phase 3 — Per-Role Discount Ceiling, Decision VAN-007 (complete, tested)
`TenantContext` gained `roleKey` (`resolveRoleKey()`, mirroring `resolvePermissions()`'s pattern). `DiscountThresholdPolicy` (`lib/use-cases/sale.ts`) now resolves `discountCeilings.byRoleKey[roleKey] ?? discountCeilings.default ?? legacy flat maxDiscountPercent ?? 20`. **Found and fixed one leftover bug from an in-progress edit** (a stale call to a since-renamed `parseDiscountSettings` function) during this session's continuity check — confirmed via `pnpm -r typecheck` before proceeding. **3 new tests** added to `test/sale-discount-policy.integration.test.ts` covering role-specific override, tenant-default fallback, and legacy-flat-field fallback.

### Verification
```text
pnpm -r typecheck   → clean, 0 errors
pnpm -r test        → 76 passed, 0 failed (11 apps/web suites, 75
                      tests + 1 packages/db RLS test)
```

### Not yet done (Phase 4, next session step — NOT started)
```text
IssueRepStockUseCase, the CompleteSaleUseCase custody-balance
extension point (07 §7.6a's registry, new row), RecordCustodyWriteOffUseCase
(Flow 1), CompleteFieldCustomerReturnUseCase (Flow 2),
ReconcileRepAssignmentUseCase, Decision VAN-008 (overdue block +
vansales.override permission) and VAN-009 (one-active-assignment)
enforcement in the use case layer (the DB constraint exists — the
application-layer check + friendly error code do not yet), API
routes, and the full test suite for all of the above.
```


---

## §D — `tenant/branches`, `tenant/warehouses`, `tenant/features` (third pass, same session continuation)

**Governing spec:** `11_API_SPECIFICATION.md` §15, `06_DATABASE_SPECIFICATION.md` §4.7/§5.2/§5.3.

### New files
```text
packages/validation/branch.ts, warehouse.ts, tenant-features.ts
apps/web/lib/use-cases/branch.ts, tenant-features.ts
apps/web/app/api/tenant/branches/route.ts
apps/web/app/api/tenant/features/route.ts
apps/web/test/tenant-config.integration.test.ts   (10 tests, real DB)
```

### 🔴 Three real bugs found in the existing `/api/warehouses` routes and fixed
1. **Fake PATCH** — `PATCH /api/warehouses/:id` merged the request body into the fetched row in memory and returned it, **without ever writing to the database**. Any "edit" appeared to succeed and then silently reverted on next load. Fixed via a real `updateWarehouse()` use case; covered by a dedicated regression test that re-fetches via a separate call to prove persistence.
2. **Wrong permission** — GET/POST required `catalog.manage` (meant for item categories/brands/units) instead of the documented `settings.view`/`settings.manage` (`11` §15). Fixed. An existing test (`inventory.test.ts`) had pinned the buggy permission as an expected assertion — corrected, not silently left passing against wrong behavior.
3. **`control.tenant_features` table didn't exist at all** — documented conceptually in `06` §4.7 since v2.0, no schema/migration ever implemented it. Added (`packages/db/schema/control.ts`, migration `0005_fast_cammi.sql`, composite PK `(tenant_id, feature_key)`), confirmed `erp_app` grants apply automatically via the pre-existing `ALTER DEFAULT PRIVILEGES` rule.

### Documented, flagged specification correction
`11_API_SPECIFICATION.md` §15 documented `/api/tenant/warehouses`, but the already-shipped, UI-consumed path is flat: `/api/warehouses` (`purchase-ui.tsx`, `sale-ui.tsx`, two inventory pages). Per the Existing Code Rule, the working path was kept and the specification corrected to match (Decision API-006), rather than renaming a load-bearing route. `/api/tenant/branches` and `/api/tenant/features` (brand new, no prior UI dependency) follow the spec's nested path literally.

### Also fixed: a pre-existing numbering defect in `06`'s Amendment Ledger
Two unrelated rows were both labeled "24" (a leftover from an earlier reconciliation pass, prior to this session). Renumbered; new rows appended for `control.tenant_features` (Decision DB-012).

### Verification
```text
pnpm -r typecheck   → clean
pnpm -r test        → 71 passed, 0 failed (10 apps/web suites, 70 tests
                      + 1 packages/db RLS test)
```


