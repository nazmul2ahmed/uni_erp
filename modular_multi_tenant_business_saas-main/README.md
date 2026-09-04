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
