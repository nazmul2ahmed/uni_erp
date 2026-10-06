# ADR-001: Platform Operator Identity (Phase A0)

- **Status:** ACCEPTED 2026-10-04 (D1-D3 approved by the owner; see "Resolution"). Implemented as Phase A0/A1; Decisions PLT-001, PLT-002, PLT-003.
- **Date:** 2026-10-04
- **Change class:** ARCHITECTURAL CHANGE + SECURITY CHANGE + DATABASE CHANGE (when approved)
- **Blocks:** Phase A1 (Platform Admin dashboard, `05` 150)
- **Governing sources:** `05` 87-90 and 150, `06` 4.1 and 4.9, `13` 2.6 and 14 Q2, `29`, `AGENTS.md`

## Resolution (2026-10-04)

| # | Decision | Outcome |
|---|---|---|
| D1 | Option B with the five rules | **Approved and implemented** as Decision PLT-001 |
| D2 | MFA gates exposure of the operator surface | **Approved** as Decision PLT-003 (disabled by default, IP allowlist in the meantime) |
| D3 | Same app now, split later | **Approved, with an owner requirement added:** the owner intends a **separate platform that administers several apps**, and it must work for any kind of app |

### Consequence of the multi-app requirement

An operator table inside one application cannot be the long-term identity store for a console that serves many applications. The approved path is therefore **contract-first**: the operator UI is only a client of a small, versioned, application-agnostic HTTP contract (`Plan/31_PLATFORM_INTEGRATION_CONTRACT.md`, Decision PLT-002), so a separate console can replace it without changing the application.

When the console is extracted, the *guard* in front of the contract changes (human operators and their MFA move to the platform; the console authenticates to each application with a service credential) but the contract does not. **That change is architectural and requires ADR-002 before any application is exposed to a remote console.** Nothing built here is a dead end: the segregation rule, the disabled-by-default gate, the aggregate-only response allowlist and the guard-on-every-route test carry over unchanged.

### Where the implementation differs from the proposal above (all stricter or necessary)

- **`pnpm operator:create` was added.** Registration always creates a tenant and an OWNER membership, so an operator could never be made from a normally registered account (rule 3 forbids it). `create` makes a membership-free account and returns a one-time password.
- **Database triggers enforce rule 3 in both directions** (operator <-> membership), in addition to the application checks and the guard's own check.
- **The invitation refusal is deliberately generic** ("This email cannot be added to a workspace") so a tenant owner cannot learn which emails belong to operators.
- **Resolved 2026-10-04 after acceptance:** `control.audit_events_platform` is now append-only for the runtime role (Decision SEC-007) and a password-change flow exists, with one-time passwords forced to be changed and `pnpm operator:reset-password` for recovery (Decision SEC-008). Still open: MFA (the surface stays off outside local development), and the wider exposure of the other `control.*` tables to the runtime role.

## 1. Context

The tenant dashboard is complete. The next planned surface is the **platform (control-plane) admin dashboard** (`05` 150: tenant counts by status and storage mode, provisioning, suspended, ...).

What the documentation already fixes:

| Source | Rule |
|---|---|
| `05` 88 | Platform admin is a **platform-level** role, distinct from a tenant owner. Access to tenant business data requires **explicit authorization + audit**. |
| `05` 87 | Cross-tenant analytics = control plane + **authorized aggregation**; a tenant business user never sees cross-tenant data. |
| `05` 89-90 | Break-glass / support access is a **future** feature: explicit reason, time-limited, tenant-visible, minimal permissions, support request -> authorization -> temporary access -> audit. |
| `06` 4.1 | `control.users` is the platform-wide identity. It has **no** operator flag or role. |
| `06` 4.9 | `control.audit_events_platform` is the append-only platform audit. |
| `13` 2.6 / 14 Q2 | MFA is deferred; the hook (`mfa_enabled`, `mfa_secret_ref`) exists; "MFA for which roles?" is **open**. |

What is **not** defined anywhere: how a platform operator is identified, authenticated, authorised, bootstrapped, or revoked. Today there is no way to tell an operator from any other user.

Facts about the current code that constrain the options:

- `erp_app` (the runtime role) has `SELECT, INSERT, UPDATE, DELETE` on **every** `control.*` table (`0003_grant_app_role.sql`, re-applied on each `db:migrate`), and `control` tables have **no RLS** ("application-layer defense only"). Any application bug can currently write any control row.
- Tenant context is derived only from the session's active tenant plus an ACTIVE membership (`requireTenantContext`). A user with no membership can never act as a tenant.
- One session table and one cookie serve every user. There is no MFA implementation.

## 2. Problem

Introduce an operator identity such that:

1. Operator authority can never be obtained through any tenant-facing flow (registration, invitation, role edit, API bug).
2. Operator authority never implies tenant business-data access (`05` 88).
3. It is revocable immediately, auditable, and least-privilege.
4. It does not duplicate the authentication stack (`AGENTS.md`: no parallel implementations of one domain rule).

## 3. Options

| | A. Flag on `control.users` | B. `control.platform_operators` table on the existing identity | C. Separate operator identity store, login, session, cookie | D. External IdP / SSO for operators |
|---|---|---|---|---|
| Mechanism | `users.is_platform_operator` | One row per operator, FK to `control.users`; status, grant metadata | `control.platform_users` + own sessions + own cookie | OIDC provider |
| Reuses auth code | Yes | Yes | No (second auth stack) | No |
| Escalation surface | Highest: one UPDATE on a table the runtime role can write | Low **if** the runtime role cannot write the table (see decision) | Lowest | Lowest, but needs external infra |
| Revocation | UPDATE | UPDATE (status) | Delete account | At IdP |
| Room for roles later (support vs admin, `05` 90) | None | Add a column | Yes | Yes |
| Cost now | Trivial | Small | Large (reset flows, sessions, tests) | Large; `06` 4.1 only hints at SSO |
| Verdict | Rejected: too easy to grant by accident or by bug | **Recommended** | Defer: revisit when MFA/SSO is built | Defer |

## 4. Decision (proposed)

**Option B, hardened with five rules.**

1. **Table `control.platform_operators`:** `user_id` (PK, FK `control.users`), `status` (`ACTIVE` | `REVOKED`), `granted_at`, `granted_by` (free text, e.g. `cli:<os user>` -- there is no grantor user at bootstrap), `revoked_at`, `note`. One authority level for now: **read-only control-plane aggregates**. Any operator *mutation* needs its own ADR.
2. **The runtime role cannot mint operators.** A manual migration, ordered after `0003`, runs `REVOKE INSERT, UPDATE, DELETE ON control.platform_operators FROM erp_app`. Only the owner role (`erp`) can grant or revoke -- through a CLI script (`pnpm operator:grant --email ...`), never over HTTP. A SQL-injection or logic bug in the web app therefore cannot create an operator.
3. **Segregation of duties:** an operator account **must not hold any tenant membership** (checked by the grant script, by the invitation/registration paths, and again by the operator guard -- fail closed). Consequence: an operator session can never pass `requireTenantContext` (it already requires an ACTIVE membership), so **operator status grants nothing in tenant routes** and no tenant owner can invite an operator into a tenant. Seeing a tenant's real data is the future break-glass flow (`05` 89), out of scope here.
4. **A separate guard:** `requirePlatformOperator()` = valid session AND an `ACTIVE` operator row **read on every request** (never cached in the session, so revocation is immediate) AND zero ACTIVE memberships. All operator code lives under `/api/platform/*` and `/platform`, uses `withPlatformTransaction()` and **only** `control.*`. It never reads `core.*`, `modules.*`, `industry.*`.
5. **Off by default and audited:** the whole operator surface answers 404 unless `PLATFORM_ADMIN_ENABLED=true`. Per-tenant drill-downs and every operator mutation write `control.audit_events_platform` (actor, tenant, request id). Operator sign-in is audited.

### MFA

Operators are the highest-value accounts on the platform and MFA does not exist. Proposed answer to `13` 14 Q2 *for operators only*: **MFA is mandatory before the operator surface is exposed outside local development.** Until TOTP is built, the surface stays disabled by default and the interim control is an IP allowlist (`PLATFORM_ADMIN_ALLOWED_CIDRS`). TOTP itself is a separate, later phase.

### Where it runs

Phase A1 lives in the same Next.js app (`/platform`, `/api/platform/*`), because splitting into a separately deployed app is an operations decision (`25`) and nothing here prevents it later: operator code imports no tenant UI and no tenant use case. `AppShell` (tenant sidebar) must not wrap `/platform`; it will render the platform area with its own minimal shell.

## 5. Phase A1 scope (after approval)

Data that actually exists in the code today, aggregates only:

- Tenants by `status` and by `storage_mode`; total; recently created (name, status, created date).
- Feature adoption (`control.tenant_features` counts per feature key).
- User count.

Deliberately **not** shown, because no source exists and inventing one would be fabrication: Healthy / Degraded / Migration Pending (`05` 150 -- no `control.tenant_databases`, no health checks), plan and subscription metrics (`control.plans/subscriptions` not implemented), cost visibility (`05` 151), any business figure (sales, stock, profit -- that is "authorized aggregation", undefined). Owner email addresses are tenant-user PII and are excluded.

## 6. Consequences

**Good:** operator authority is explicit data, revocable immediately, unreachable from the web app's own database role, and structurally unable to read tenant business data. No second auth stack.

**Costs and risks:**

- An operator needs a **dedicated account** (cannot be a tenant member). Intended, but it means an operator cannot casually "see what a customer sees" until break-glass exists.
- Control tables still have no RLS; the `REVOKE` protects only the operators table. The wider "runtime role can write all of `control`" exposure is pre-existing and is flagged, not fixed, here.
- The `REVOKE` must stay ordered **after** `0003` (which re-grants on every migrate).
- Operator surface is a new attack target: must ship disabled, with the IP allowlist, until MFA exists.
- `06` 4.9 lists `ip_address` / `target_type` / `target_id` on `audit_events_platform`; the code table has `request_id` instead. Small drift to reconcile when A1 writes drill-down audit rows.

## 7. Adversarial test plan (must pass before Phase A1 is accepted)

1. A tenant OWNER/MANAGER/STAFF calling any `/api/platform/*` -> 403. A signed-out caller -> 401.
2. Operator calling any tenant business route -> denied (no membership); operator invited into a tenant -> refused; account with a membership cannot be granted operator.
3. A revoked operator is denied on the very next request, with an existing live session.
4. The runtime role cannot INSERT / UPDATE / DELETE `control.platform_operators` (asserted at SQL level, not just in code).
5. Flag off -> 404 for the whole surface. IP outside the allowlist -> denied.
6. Response allowlist test: no response from `/api/platform/*` contains `core.*` data or owner emails.
7. Drill-down and sign-in write platform audit rows; aggregate reads do not leak tenant names to non-operators.

## 8. Decisions requested from the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Approve Option B with the five rules (operators cannot be tenant members; runtime role cannot write the table)? | Yes |
| D2 | MFA: block exposing the operator surface until TOTP exists (disabled by default + IP allowlist meanwhile)? | Yes |
| D3 | Same Next.js app for A1 (`/platform`), or a separate app from day one? | Same app now, split later |

## 9. After approval (implementation order)

1. Update `05` 88, `06` (new table + ledger row), `13` 2.6 / 14 Q2, `11` (`/api/platform/*`), `12` (platform shell), and assign Decision IDs (dual-declaration).
2. Drizzle migration for the table + manual migration (REVOKE, ordered after `0003`).
3. `operator:grant` / `operator:revoke` CLI; membership/invite guards; `requirePlatformOperator`.
4. Tests in section 7 first, then A1 aggregates API, then the `/platform` UI.
