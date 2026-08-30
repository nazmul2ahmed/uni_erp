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
