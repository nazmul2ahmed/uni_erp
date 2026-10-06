# Modular Multi-Tenant Business ERP SaaS

Phase 1 (Platform Foundation) scaffold. Governed by the specification
series `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md` through
`29_AI_CODING_PROTOCOL.md` (see `AGENTS.md` for the AI-assistance index).

## Stack (frozen, per `04_PLATFORM_ARCHITECTURE.md`)

TypeScript · Next.js · PostgreSQL · Drizzle ORM · Zod · pnpm workspaces

## Phase 1 Scope

- User registration (becomes Tenant Owner atomically)
- Login / logout / session management
- Multi-tenant membership resolution + tenant selection
- RBAC (permission catalog + preset roles: Owner/Manager/Staff)
- Full authorization guard chain (`withAuth → withTenantContext →
  withPermission → withResourceOwnership`)
- Shared-mode database routing + Row Level Security

## Explicitly OUT of Phase 1 scope

Sales, Purchase, Inventory, Accounting, Offline/Sync, Optional Modules,
Industry Extensions, AI, Automation, Billing, Dedicated-tenant routing —
all sequenced in later phases per `28_IMPLEMENTATION_ROADMAP.md` §4.

## Phase 0.5 Reconciliation — Code Correction Pass (2026-08)

Six previously-open architecture/business decisions were formally
ratified by the specification authority and merged into the spec
series (`03`, `04`, `05` ×2, `06` v2.0, `07`, `09`, `26`). This
scaffold's initial generation cited several of these **before** they
were ratified, using placeholder/incorrect Decision IDs (e.g.
`Decision DOM-007` where the ratified ID is `DOM-006`) and, in one
case, a DB-level invariant that was described as application-layer-only
but is now correctly implemented as a hybrid (DB CHECK + app logic)
per `05` §75a. This pass corrected:

- `DOM-007` → `DOM-006` citations (`packages/db/schema/core.ts`,
  `packages/db/seed/seed-control-plane.ts`)
- Added `sales.discount.override` to the `MANAGER` preset role, per
  `DOM-006`'s "Owner and Manager default" seed mapping (was
  previously OWNER-only, an unintentional gap)
- Added the actual `owner_required_when_active` DB CHECK constraint
  (`packages/db/migrations-manual/0002_owner_invariant.sql`), per
  `TEN-001`/`INV-OWN-001` — previously described in a comment but not
  implemented
- Introduced `RESOURCE_NOT_FOUND` and corrected two call sites
  (`apps/web/lib/guard.ts`, `apps/web/app/api/tenant/profile/route.ts`)
  that were misusing `USER_NOT_FOUND` for non-user resources

No business logic, schema shape (beyond the one new constraint), or
API contract changed as a result of this pass — it is a citation and
completeness correction only.

## Phase 2 — Tenant Isolation Integration Test Pass (2026-08)

Added `apps/web/test/tenant-isolation.integration.test.ts` — the
project's first Integration-layer test (per `24_TESTING_STRATEGY.md`
§2.1/§5) exercising the actual Customer/Supplier/Item use-case
functions (not mocks, not raw SQL) against a live PostgreSQL
instance with two real provisioned tenants. Running it against a live
database (previously only `packages/db/test/rls.test.ts` did this, at
the RLS-policy level only) surfaced and led to fixing two defects:

1. **Critical — `withTenantTransaction` / `registerOwnerAndTenant`
   never actually worked against a real database.**
   `SET LOCAL app.tenant_id = ${tenantId}` is invalid PostgreSQL
   syntax once Drizzle's `sql` tag binds the interpolated value as a
   `$1` parameter (correct, injection-safe behavior per `13` §4.2) —
   `SET`/`SET LOCAL` do not accept bind parameters, only a literal or
   a function call does. Every tenant-scoped write/read in the
   codebase used this broken pattern and would throw
   `PostgresError: syntax error at or near "$1"` on first real
   execution; this was invisible to `typecheck`/`lint`/`build` (which
   only prove compilation) and to `rls.test.ts` (which happened to
   already use the correct `set_config()` function form). Fixed in
   `packages/db/client.ts` and `apps/web/lib/tenant-onboarding.ts` by
   switching both call sites to `SELECT set_config('app.tenant_id',
   $1, true)` — the transaction-scoping discipline itself (`05` §25,
   Decision TEN-002) is unchanged.

2. **`createItem`/`updateItem` accepted a cross-tenant `categoryId` /
   `brandId` / `unitId` without rejecting it** — a violation of `05`
   §81 ("cross-tenant foreign key কখনো allowed নয়") and `05` §126's
   New Table Checklist. `createItemCategory` (catalog.ts) already
   validated its own `parentId` this way; `item.ts` did not. Fixed by
   adding `assertItemForeignKeysBelongToTenant` in `item.ts`, applied
   identically on both `createItem` and `updateItem` (the same gap
   existed on the update path and was fixed in the same pass, not
   left half-closed).

Both fixes were verified against a live PostgreSQL 16 instance
(migrations + seed applied), with the full test suite (28 tests
across `packages/db` and `apps/web`) passing, `pnpm -r typecheck`,
`pnpm -r lint`, and `pnpm build` all clean, and zero residual fixture
rows left behind by the test suite's own cleanup.

## Getting Started

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Phase 1 Exit Criteria (per `28` §4 — verify before starting Phase 2)

- [ ] A user can register, log in, create a tenant, become its Owner
- [ ] Membership/Role/Permission resolve correctly end-to-end
- [ ] Tenant Isolation Testing Matrix (`24` §5) passes for this
      minimal slice
- [ ] Shared-mode database routing works
