# AGENTS.md

This file is the repository-root, low-token-cost companion to
`29_AI_CODING_PROTOCOL.md`, which remains the authoritative process
document (see the project's `/docs` series — not duplicated here).

## Before writing any code

1. Locate the governing spec section in the documentation series
   (`01`–`29`) for the change you're making. If none exists, STOP —
   escalate per `29` §8, do not improvise.
2. State: Goal / Governing Spec / Affected Module / Constraints /
   Acceptance Criteria / Files Allowed to Change (`29` §5.1).

## Repository map

```
apps/web/           Next.js app — UI + API routes (thin: parse →
                     authenticate → authorize → call use case →
                     serialize, per 04 §87)
packages/db/         Drizzle schema + client + tenant-scoped
                     transaction helper (SET LOCAL discipline,
                     Decision TEN-002) + migrations + seed
packages/shared/      Result<T,E>, AppError, error-code catalog
packages/validation/  Zod schemas (client-side UX validation only;
                     server/domain validation is authoritative,
                     per 04 §11-12)
```

## Non-negotiables (see `03` §90 for the full list)

- Tenant context is never trusted from client input — always
  resolved server-side from the session (`lib/guard.ts`).
- Every tenant-scoped DB write goes through `withTenantTransaction`
  (`packages/db/client.ts`) — never a bare `db.insert/update/delete`
  against a tenant-owned table.
- No industry-specific branching in `core`/`apps/web` route logic.
- Financial/stock mutations are idempotent (`operationId`) — not yet
  exercised in Phase 1 (no financial use cases exist yet), but any
  Phase 2 code touching Sales/Purchase/Payment MUST implement this
  from the start, per `07` §17.

## Local development

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
pnpm install
pnpm db:generate   # drizzle-kit generate, from packages/db
pnpm db:migrate    # applies migrations + RLS policy SQL
pnpm db:seed       # seeds permission catalog + preset roles
pnpm dev           # starts apps/web on :3000
```

## Current phase

**Phase 1 — Platform Foundation** (per `28_IMPLEMENTATION_ROADMAP.md` §4).
Scope: Auth, Tenant, Membership, RBAC only. Do NOT add Sales/Purchase/
Inventory/Accounting code yet — that is Phase 2 (`07`–`09`), sequenced
after Phase 1 exit criteria are verified.
