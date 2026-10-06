# 31. Platform Integration Contract (v1)

- **Status:** ACTIVE (Decision PLT-002), first implemented by `uni_erp`
- **Date:** 2026-10-04
- **Governs:** how a platform console talks to ANY managed application
- **Related:** `Plan/adr/ADR-001-platform-operator-identity.md`, `05` 87-90 and 150, `11`

## 1. Why this exists

The owner intends to run a **separate platform** that administers several applications (this ERP and others) and must work for any kind of application. The console therefore must not depend on any application's database, tables or internal vocabulary. This document is the only coupling: a small, versioned, read-only HTTP contract that each application implements for itself.

## 2. Principles

1. **Applications own their data; the console only asks.** No console-to-application database access, ever.
2. **Aggregates only.** The contract carries control-plane facts (counts, states, adoption). It never carries an application's business records, and never end-user PII (emails, names of people, credentials).
3. **Capability discovery, not assumptions.** An application advertises what it can report. A console adapts to the list and never assumes a metric exists.
4. **Honest absence.** If an application has no source for a metric it does not offer the capability. It does not return zeros or placeholders.
5. **Versioned.** Every response carries `contractVersion`. A breaking change is a new version served alongside the old one.
6. **Read-only.** Version 1 has no mutating operation. Anything that changes state, or exposes business data, needs its own ADR (break-glass, `05` 89-90).
7. **Fail closed, hidden by default.** The surface answers 404 unless explicitly enabled and the caller is permitted.

## 3. Envelope

Every `/api/platform/v1/*` response (inside the application's normal `{ success, data }` wrapper) has this `data`:

```json
{
  "contractVersion": "platform.v1",
  "app": { "id": "uni_erp", "name": "Ledgerly ERP", "version": "0.1.0" },
  "generatedAt": "2026-10-04T10:00:00.000Z",
  "data": { }
}
```

`app.id` is a stable machine identifier chosen by the application. The words used inside `data` use the neutral terms below; an application whose own word differs (workspace, shop, pharmacy, site) maps to them.

| Neutral term | Meaning |
|---|---|
| `tenant` | One customer-owned isolated unit within the application |
| `status` | Lifecycle state of a tenant, as the application defines it |
| `storageMode` | Whether the tenant shares the application's database or has its own |

## 4. Endpoints (v1)

| Endpoint | Purpose | Required |
|---|---|---|
| `GET /api/platform/v1/identity` | App identity, contract version, `data.capabilities: string[]` | **Yes** |
| `GET /api/platform/v1/overview` | Aggregates for the capabilities the app advertises | Per capability |

### 4.1 Capabilities defined in v1

| Capability | `overview.data` field | Meaning |
|---|---|---|
| `tenants.summary` | `tenants: { total, byStatus, byStorageMode, recent[] }` | Counts by state and storage model; the latest N tenants as `{ id, name, status, storageMode, createdAt }` |
| `features.adoption` | `featureAdoption: [{ featureKey, enabled, configured }]` | How many tenants have each optional module/feature on |
| `users.count` | `users: { active }` | Number of active end-user accounts (a count only) |

New capabilities are added by extending this table (a minor, additive change). A console must ignore capabilities it does not recognise.

### 4.2 Reserved for later versions (not offered by anyone yet)

`tenants.health` (health / degraded / migration pending), `billing.summary` (plans, subscriptions), `cost.summary` (infrastructure cost). They stay reserved until a real data source exists in at least one application.

## 5. Errors and access

| Condition | Status |
|---|---|
| Surface disabled, or caller outside the permitted network | 404 |
| No valid credential | 401 |
| Valid credential, not permitted | 403 |

## 6. Authentication of the caller

**Today (in-app console):** the caller is a signed-in human platform operator on the application's own session (ADR-001, Decision PLT-001): an active row in `control.platform_operators`, no tenant membership, surface enabled, network allowlisted.

**When the console is a separate platform (ADR-002, required before extraction):** the console authenticates to each application with a service credential instead of a human session, and human operators and their MFA live in the platform. The contract in this document does not change; only the guard in front of it does. Candidate shape (not decided): a revocable per-application client credential stored hashed, scoped to the v1 read capabilities, bound to an IP allowlist, with rotation. ADR-002 must be written and approved before any application is exposed to a remote console.

## 7. Conformance checklist for a new application

1. Serve `identity` and `overview` under `/api/platform/v1/`.
2. Advertise only capabilities backed by real data.
3. Return aggregates only: no business records, no emails or personal names, no credentials.
4. Disabled by default; 404 when off; gate every route with a single guard (and test that no route skips it).
5. Add a test that scans the response for forbidden fields.
6. Never let the console credential double as a tenant user: operator authority must not grant access to any tenant's business data.

## 8. Known gaps

- No machine credential yet (section 6); only the in-app human operator path exists.
- No MFA for operators (`13` 14 Q2): the surface must stay off outside local development.
- No pagination, filtering or per-tenant drill-down in v1.
