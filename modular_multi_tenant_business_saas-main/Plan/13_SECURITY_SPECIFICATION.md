# 13_SECURITY_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Security Specification
**Version:** 1.0 Draft
**Status:** Security Baseline
**Depends on:**
- `03_MASTER_PROJECT_SPECIFICATION.md` (§59–61, Security/Data Integrity Requirements)
- `04_PLATFORM_ARCHITECTURE.md` (§30–34, §101–103, Auth/API/Input Security)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§2, §91–93, §131, Isolation Threat Model)
- `11_API_SPECIFICATION.md` (§20, Authorization Flow)
- `12_UX_SPECIFICATION.md` (§11, Offline/Sync visibility)

---

# 1. Purpose

এই document platform-এর **security architecture**-কে concrete, testable specification-এ রূপান্তর করে:

```text
Authentication lifecycle (session, password, future MFA)
Authorization middleware — exact implementation shape
Rate limiting — concrete thresholds per endpoint class
Input sanitization standards
File upload security detail
Secret management procedures
Tenant isolation security testing (concrete test matrix)
Incident response outline
```

**Foundational rule carried forward (per `03` §60, non-negotiable #2 of §90):**

> Frontend কখনো trusted client নয়। Server প্রতিটি request-এ authentication, tenant membership, permission, payload, business rule পুনরায় validate করবে — client-side check কখনো একমাত্র protection নয়।

---

# 2. Authentication Architecture — Detailed

## 2.1 Session Model (concrete, extends `04` §31)

```text
Session token: opaque, server-generated, stored in HTTP-only,
               Secure, SameSite=Lax cookie
               (SameSite=Strict rejected — breaks legitimate
               cross-site navigation into the app, e.g. email links)

Session record (server-side, e.g. Redis or DB-backed):
  sessionId, userId, activeTenantId (nullable pre-selection),
  createdAt, lastSeenAt, expiresAt, userAgent, ipAddress (last-known)

Session lifetime:
  sliding expiration — refreshed on activity, absolute cap
  (e.g. 30 days absolute, 7 days idle timeout — exact values
  finalized at implementation, flagged §14 Q1)
```

## 2.2 Password Handling

```text
Hashing: bcrypt or argon2id (argon2id preferred — memory-hard,
         resistant to GPU cracking)
Minimum policy: length >= 10, no composition-rule theater
                (per modern guidance — length over complexity rules)
Storage: control.users.password_hash only — never logged, never
         included in any API response, never cached
```

## 2.3 Login Flow

```text
POST /api/auth/login
  1. Rate limit check (§5.1)
  2. Lookup user by email (constant-time comparison path to avoid
     user-enumeration timing signal where practical)
  3. Verify password hash
  4. On failure: generic "invalid email or password" (never reveal
     which field was wrong — enumeration protection)
  5. On success: create session, set cookie, return user +
     memberships list (per 11 §4)
  6. If exactly one ACTIVE membership: auto-select as activeTenantId
  7. If multiple: activeTenantId remains null until
     POST /api/auth/tenant/select (per 05 §43)
```

## 2.4 Account Lockout / Brute Force

```text
Per (email, IP) pair:
  5 failed attempts within 15 minutes -> temporary lockout (15 min)
  Lockout does NOT reveal whether the account exists (generic
  "too many attempts, try again later" message)
Persistent abuse across many emails from one IP -> handled at
  rate-limiting layer (§5.1), not account-lockout layer
```

## 2.5 Password Reset

```text
POST /api/auth/password/reset-request
  1. Rate limit (strict, §5.1)
  2. Always return generic success response regardless of whether
     the email exists (no enumeration)
  3. If exists: generate single-use, short-lived (e.g. 30 min)
     signed token, email a reset link

POST /api/auth/password/reset-confirm
  1. Validate token: not expired, not already used, matches user
  2. Update password_hash
  3. Invalidate ALL existing sessions for that user (force re-login
     everywhere — a password reset implies possible prior compromise)
  4. Audit log (platform-level, per 06 §4.9)
```

## 2.6 Future MFA Readiness

```text
Not required at MVP (per 03 §85 exclusions are silent on this, but
it is deliberately deferred here). Architecture keeps a hook:

control.users
  mfa_enabled boolean default false
  mfa_secret_ref text nullable  -- pointer into secret manager, not
                                   raw TOTP secret in plaintext column

Login flow inserts an MFA-challenge step between §2.3 steps 5–6 when
mfa_enabled = true. No further detail specified until MFA is
prioritized — flagged §14 Q2.
```

---

# 3. Authorization — Middleware Shape

## 3.1 Composed Guard Chain (concrete form of `11` §20)

```text
withAuth(handler)
  -> withTenantContext(handler)
    -> withPermission(resourceAction)(handler)
      -> withResourceOwnership(loader)(handler)
        -> handler(req, ctx)
```

```text
withAuth:
  - reads session cookie, validates against session store
  - 401 AUTHENTICATION_REQUIRED if missing/expired
  - attaches ctx.userId

withTenantContext:
  - resolves activeTenantId from session (never from request body/
    query — per 05 §17, §20)
  - loads Membership(userId, tenantId); verifies status = ACTIVE
  - loads Tenant; verifies status = ACTIVE (not SUSPENDED/ARCHIVED)
  - 403 TENANT_ACCESS_DENIED / TENANT_SUSPENDED on failure
  - attaches ctx.tenantId, ctx.membershipId, ctx.storageMode

withPermission(resourceAction):
  - loads effective permissions for ctx.membershipId (role +
    role_permissions, per 06 §4.4)
  - 403 PERMISSION_DENIED if resourceAction not present

withResourceOwnership(loader):
  - loader(ctx, params.id) fetches the target row's tenant_id
  - 404 (not 403 — per §3.3 below) if tenant_id != ctx.tenantId
  - attaches ctx.resource for the handler to reuse (avoids a second
    fetch)
```

## 3.2 Why 404, Not 403, for Cross-Tenant Resource Access

```text
GET /api/customers/{tenant-B-customer-id} requested by a Tenant-A
user returns 404 NOT_FOUND, not 403 PERMISSION_DENIED.

Reason: 403 confirms the resource EXISTS (just not accessible),
which is itself an information leak across tenant boundaries. 404
gives no signal whether the ID exists at all — this is the concrete
IDOR mitigation referenced in 05 §92.
```

## 3.3 Fail-Closed Enforcement

```text
Any guard step that cannot positively confirm authorization
(unknown tenant, unresolvable membership, missing permission table
row, database error during the check itself) -> DENY.

No guard has a "default allow" branch. This implements 05 §159
("Fail Closed Principle") at the code-shape level.
```

---

# 4. Input Validation & Sanitization

## 4.1 Validation Layering

```text
1. Zod schema (per request body/query) — type, shape, format,
   range (04 §12) — rejects malformed input before it reaches any
   Use Case
2. Domain validation (07 §18 Result<T, DomainError>) — business
   rules Zod cannot express (e.g. "return qty <= sold qty")
3. Database constraints (06 §9) — last-resort defense-in-depth
```

## 4.2 SQL Injection Prevention

```text
Drizzle ORM parameterized queries used exclusively for all
tenant-facing data access (per 04 §102).

Raw/escape-hatch SQL (04 §21, for complex reporting) MUST use
parameterized placeholders — string concatenation of any
user-supplied value into a raw SQL string is forbidden, enforced
via code review checklist (§9.2) and lint rule where feasible.
```

## 4.3 XSS Prevention

```text
React's default JSX escaping is the primary defense — dangerouslySetInnerHTML
is disallowed platform-wide except for a single, explicitly reviewed
rich-text rendering path (if introduced later), which must run
content through a sanitizer (e.g. DOMPurify) first.

API responses are always Content-Type: application/json — no
endpoint reflects user input as text/html.
```

## 4.4 Field-Type Sanitization Standards

```text
Free text (names, notes, descriptions):
  trim whitespace, cap max length (e.g. 500 chars for names, 5000
  for notes), strip control characters

Phone: normalize to a consistent format before uniqueness check
       (per 06 §5.4 UNIQUE(tenant_id, phone))

Email: lowercase-normalize before storage/lookup

Money/Quantity: parsed via decimal-safe library (04 §64) — never
                parseFloat() on a user-supplied string used in a
                financial calculation

File names (uploads): normalized, stripped of path separators,
                       never used directly as a storage path
                       component (04 §103) — object key is
                       server-generated (06 §5.15 pattern:
                       tenant/{tenantId}/{entityType}/{entityId}/{filename})
```

---

# 5. Rate Limiting — Concrete Thresholds

Completes `11` §22 (deferred from that document).

## 5.1 Thresholds by Class

| Endpoint Class | Limit | Window | Key |
|---|---|---|---|
| `POST /api/auth/login` | 5 | 15 min | (email, IP) |
| `POST /api/auth/password/reset-request` | 3 | 1 hour | IP |
| `POST /api/auth/register` | 5 | 1 hour | IP |
| Reporting/heavy queries (`accounting/trial-balance`, `profit-and-loss`, etc.) | 30 | 1 min | (tenantId, userId) |
| Standard mutation endpoints (Sales/Purchase/Payment/etc.) | 120 | 1 min | (tenantId, userId) |
| `POST /api/documents/upload` | 20 | 1 min | (tenantId, userId) |
| `POST /api/sync/push` | 60 | 1 min | (tenantId, deviceId) |
| AI-related endpoints (OCR trigger, future AI assistant) | 15 | 1 min | (tenantId, userId) |
| All other GET/read endpoints | 300 | 1 min | (tenantId, userId) |

## 5.2 Response on Limit Exceeded

```text
HTTP 429, error code RATE_LIMITED (per 11 §3)
Response includes Retry-After header
Client (10 §4.2) treats this as retryable with backoff, same as a
5xx — never surfaces as a permanent FAILED state to the user
```

## 5.3 Implementation Note

```text
Redis-backed sliding-window or token-bucket counter (per 04 §46-47).
Rate limit state itself is NOT tenant business data — it lives in
the platform's operational Redis instance, not routed through the
tenant database router (04 §27).
```

---

# 6. File Upload Security

Concrete detail for `04` §103 / `06` §5.15 / `11` §16:

```text
1. Type validation: allowlist by MIME + magic-byte sniff (not
   filename extension alone) — images: jpeg/png/webp; documents:
   pdf; invoice scans: jpeg/png/pdf only
2. Size limit: images <= 10MB, PDFs <= 20MB (tenant plan may lower
   this further, per 05 §72)
3. Filename: server-generates the storage object key; original
   filename retained only as display metadata (core.documents.filename,
   06 §5.15), never used in the path
4. Malware scanning: where the plan/deployment tier requires it
   (flagged §14 Q3 — not universally mandatory at MVP given cost)
5. Storage: private bucket, never public-read by default
6. Access: signed, short-lived URL only (per 11 §16,
   GET /api/documents/:id/download-url), generated per-request,
   never a permanent public link
7. Tenant authorization: download-url endpoint re-runs the full
   guard chain (§3.1) — a signed URL is short-lived precisely so a
   leaked link has bounded exposure, not so authorization can be
   skipped up front
```

---

# 7. Secret Management

Concrete procedure for `04` §68 / `05` §139–140:

```text
Categories:
  Platform secrets    (DATABASE_URL, AUTH_SECRET, REDIS_URL,
                        SENTRY_DSN) — environment variables /
                        platform secret manager, never in repo

  Tenant secrets       (Telegram bot token, SMTP creds, payment
                        gateway keys per tenant) — encrypted at
                        rest in a dedicated secret store, referenced
                        by opaque ID from tenant settings tables,
                        decrypted only server-side at point of use

  Dedicated DB          credential_ref in control.tenant_databases
  credentials           (06 §4.6) — pointer only, actual credential
                        lives in the secret manager

Rotation:
  Platform secrets: manual rotation procedure documented in ops
                     runbook (deferred, not blocking architecture)
  Tenant secrets: rotatable via tenant settings UI without code
                   deploy — writing a new secret invalidates the
                   old reference

Access:
  Application server process only. Never exposed to:
    - frontend bundle
    - API response payloads
    - logs (§8.2)
    - error messages / stack traces
```

---

# 8. Logging & Observability Security

## 8.1 What Is Safe to Log

```text
requestId, tenantId, userId, membershipId, endpoint, HTTP status,
latency, error code (not full stack trace in production logs
visible to non-engineering staff), deviceId
```

## 8.2 What Must Never Be Logged

```text
password (plaintext or hash)
session token / cookie value
full request body for financial endpoints (log a redacted summary
  instead — e.g. amounts are fine, but not full card/payment
  gateway secrets if ever handled)
file contents
AI provider raw prompt/response if it could contain another
  tenant's data (should be impossible per 05 §39, but log
  redaction is defense-in-depth)
```

## 8.3 Structured Log Shape

```text
{
  timestamp, level, requestId, tenantId, userId, action,
  durationMs, statusCode, errorCode?
}
```

Per `04` §75 — tenant_id present as a structured field enables
per-tenant operational debugging without exposing business data.

---

# 9. Tenant Isolation Security Testing — Concrete Test Matrix

Operationalizes `05` §91, §131, §162–163.

## 9.1 Mandatory Test Suite (blocks release per `05` §163)

```text
[ ] Tenant A session cannot read Tenant B customer/sale/item/etc.
    via direct ID substitution (IDOR) -> expect 404
[ ] Tenant A cannot select Tenant B as activeTenantId without a
    Membership row -> expect 403 at /auth/tenant/select
[ ] Tenant A operationId reused against Tenant B's endpoint does
    NOT trigger idempotency replay across tenants (UNIQUE constraint
    is (tenant_id, operation_id), per 06 §9)
[ ] Tenant A file download-url request for Tenant B's document
    object key -> expect 403/404, never a valid signed URL
[ ] Tenant A cache key collision test — verify tenant:{id}: prefix
    isolation (05 §34)
[ ] Tenant A background job payload never processes against
    Tenant B's resolved database connection (05 §113-114)
[ ] Tenant A AI request context never includes Tenant B data
    (05 §39, §130)
[ ] Offline: Tenant A pendingOperations queue never appears under
    Tenant B's active queue on tenant switch (05 §45-47, 10 §3)
[ ] Webhook signature from a forged/replayed source is rejected
    (05 §41)
```

## 9.2 Code Review Checklist (applied per PR touching tenant-scoped code)

```text
[ ] Every new repository method accepts tenant context, not a bare ID
[ ] No raw SQL string concatenation of user input (§4.2)
[ ] New table has tenant_id + RLS policy if tenant-owned (05 §126)
[ ] New endpoint follows the guard chain (§3.1), no shortcut
[ ] New financial mutation endpoint requires Idempotency-Key (11 §2.2)
[ ] No secret/credential added to logs, error messages, or client
    responses
```

## 9.3 Regression Cadence

```text
Full isolation suite (§9.1) runs on every PR to main (CI, per 04
§124) — not just before major releases. A failing isolation test
blocks merge unconditionally (05 §163), with no override path.
```

---

# 10. Security Headers (concrete values, extends `04` §101)

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; img-src 'self' data:
  https://<object-storage-domain>; connect-src 'self'
  https://<object-storage-domain>; script-src 'self'
  (no unsafe-inline for scripts; Tailwind-generated styles are
  build-time, not injected inline scripts)
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY (or CSP frame-ancestors 'none')
```

Exact CSP directives are finalized once the object storage domain
and any embedded widget requirements (e.g. future payment gateway
iframe) are known — flagged §14 Q4.

---

# 11. API Key / Service Account Security (Future Public API)

Concrete detail for `05` §136–138, applicable once a public API ships:

```text
API key format: prefix + random secret (e.g. sk_live_<32 random
                chars>), only the hash stored server-side (mirrors
                §2.2 password hashing approach)
Scope: tenantId + explicit scopes[] (resource.action subset,
       never broader than the creating user's own permissions)
Rotation: creating a new key does not require deleting the old one
          immediately — supports overlap during client-side rotation
Revocation: immediate (status flag check on every request, not
            cached beyond a short TTL)
```

Not required for MVP (per `03` §85-adjacent scope) — specified here
so the schema hook (`control.api_keys`, to be added when this ships)
follows the same security posture as everything else, rather than
being designed ad hoc later.

---

# 12. Incident Response — Outline

```text
1. Detection
   - error rate spike (Sentry-compatible alerting, 04 §75)
   - anomalous cross-tenant access attempt (rare — should be
     structurally impossible, but logged/alerted per §9.1 if a
     guard ever returns an unexpected allow)
   - rate-limit abuse pattern

2. Triage
   - scope: single tenant vs platform-wide
   - classify: data exposure vs availability vs integrity

3. Containment
   - suspend affected tenant(s) if isolation breach suspected
     (05 §57-58 suspension mechanics reused for this purpose)
   - rotate affected secrets (§7) immediately
   - revoke affected sessions (mirrors §2.5 step 3)

4. Eradication & Recovery
   - patch root cause
   - restore from backup if integrity compromised (04 §99-100)

5. Post-Incident
   - platform audit log review (06 §4.9)
   - tenant notification per data-breach obligations (jurisdiction-
     dependent — legal scope, flagged §14 Q5)
   - written postmortem, ADR if architecture change results (04 §106)
```

This is an outline, not a full runbook — detailed on-call procedures
are an operational document outside this specification series.

---

# 13. Decisions Established by This Document

### Decision SEC-001
Cross-tenant resource access returns `404`, never `403` — resource existence is never confirmed across a tenant boundary (§3.2).

### Decision SEC-002
Every authorization guard fails closed on any ambiguous or unresolvable state; there is no default-allow branch anywhere in the guard chain (§3.3).

### Decision SEC-003
Rate limit thresholds (§5.1) are fixed as the MVP baseline; classified as retryable per `10` §4.2 semantics so offline/sync clients handle `429` identically to `5xx`.

### Decision SEC-004
File downloads are never served via permanent public links — only short-lived signed URLs generated per authorized request (§6).

### Decision SEC-005
The full tenant-isolation test suite (§9.1) is a mandatory, non-overridable CI gate on every PR to `main`, not a pre-release-only check.

### Decision SEC-006
Password reset invalidates all existing sessions for the affected user (§2.5), treating a reset request as a signal of possible prior compromise.

---

# 14. Open Security Questions

```text
1. Exact session absolute/idle timeout values — finalize with product
   input (currently placeholder: 30-day absolute, 7-day idle)
2. MFA — required for which roles/plans, and on what timeline?
   (Owner-level accounts are the highest-value target — consider
   requiring MFA for `staff.manage`/`accounting.post` holders first)
3. Malware scanning on file upload — mandatory for all tenants, or
   a paid-plan-tier feature given the cost of a scanning service?
4. Final CSP directive set — depends on object storage domain and
   any future embedded third-party widgets (payment gateway, etc.)
5. Data-breach notification legal obligations — jurisdiction-specific
   (Bangladesh + any future international tenants); needs legal review,
   not an engineering-only decision
6. Should `accounting.reopen_period` (08 §9.3) additionally require
   a fresh re-authentication step (step-up auth), given its sensitivity?
```

---

# 15. Next Document

পরবর্তী document:

`14_MODULE_QUOTATION.md`

এখান থেকে Optional Module series শুরু হবে — প্রতিটি module-এর জন্য পূর্ববর্তী pattern অনুসরণ করে (domain entities, use cases, database addenda, API endpoints, UX flow) বিস্তারিত specification লেখা হবে:

```text
14_MODULE_QUOTATION.md
15_MODULE_SERVICE.md
16_MODULE_RENTAL.md
17_MODULE_PROJECT.md
18_MODULE_BOOKING.md
```

তারপর Industry Extension series (`19`–`21`), এবং অবশেষে AI/Automation/Testing/Deployment/Billing/Migration/Roadmap/Coding-Protocol series (`22`–`29`) — per `03` §92 Documentation Hierarchy।
