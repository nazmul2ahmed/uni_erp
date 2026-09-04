# 25_DEPLOYMENT_ARCHITECTURE.md

**Project:** Modular Multi-Tenant Business ERP SaaS
**Document:** Deployment Architecture Specification
**Version:** 1.0 Draft
**Status:** Cross-Cutting System Deep-Dive
**Depends on:**
- `04_PLATFORM_ARCHITECTURE.md` (§67–78, Environment/Docker/Reverse Proxy/Deployment/Scale Strategy; §99–100, Backup/DR; §117–118, Cost Philosophy)
- `05_MULTI_TENANT_ARCHITECTURE.md` (§48–56, Tenant Provisioning; §63–64, Backup/Restore; §101, Tenant Tier Strategy; §109–110, Environment Isolation)
- `06_DATABASE_SPECIFICATION.md` (§4.6, `control.tenant_databases`)
- `13_SECURITY_SPECIFICATION.md` (§7, Secret Management; §10, Security Headers)
- `24_TESTING_STRATEGY.md` (§11, CI Gate Policy — this document extends CI into CD)

---

# 1. Purpose

এই document `04_PLATFORM_ARCHITECTURE.md`-তে baseline হিসেবে নির্ধারিত deployment principles (Docker, VPS, single-region, no Kubernetes at MVP) এবং `05_MULTI_TENANT_ARCHITECTURE.md`-তে বর্ণিত tenant provisioning workflow-কে একটি concrete, বাস্তবায়নযোগ্য deployment architecture-এ রূপান্তর করে:

```text
Environment topology (dev/staging/production)
Docker image build/publish pipeline
Database provisioning — shared cluster + dedicated-tenant automation
Secrets injection at deploy time
Deployment strategy (rolling, near-zero-downtime)
Rollback procedure
Health check / readiness wiring
Backup/restore automation
Observability stack wiring
```

**Foundational rule carried forward (per `04` §72, §118, restated as this document's cost/complexity discipline):**

> প্রথম commercial deployment low-cost VPS + Docker + regular PostgreSQL দিয়ে হবে। Kubernetes/microservices/multi-region প্রথম version-এ প্রয়োজন নেই — measured bottleneck ছাড়া complexity যোগ করা হবে না (`04` §74, Microservices Policy)।

---

# 2. Environment Topology

## 2.1 Environments

```text
Development   — developer machines, Docker Compose (local PostgreSQL
                + Redis), dev-tenant seed data only (05 §110)
Test           — ephemeral, spun up per CI run (24 §14 Q1), never
                persists across runs
Staging        — production-like single-VPS deployment, pilot-tenant
                data only, deployed automatically on every merge to
                main (04 §167)
Production      — live tenant data, deployed via explicit promotion
                from staging (§7)
```

## 2.2 Environment Isolation (per `05` §109–110)

```text
Each environment has:
  - its own database cluster/instance (never shared across
    environments)
  - its own object storage bucket/namespace
  - its own secret set (§5) — production secrets are NEVER copied
    into staging/dev, even for debugging
  - its own domain (e.g. app.example.com production, staging.
    example.com staging)

Production application code can NEVER, under any configuration
error, connect to a staging/dev database — enforced by environment-
scoped credentials (§5.1) plus the connection metadata verification
already specified for dedicated tenants (05 §107).
```

## 2.3 Development Tenant / Test Tenant

```text
Development environment ships with `dev-tenant` pre-seeded (05 §110)
via the same seed Use Cases as production onboarding (05 §112,
restated from 24 §9.2) — never hand-crafted SQL.

Production data is never used in Development, even sanitized, unless
explicitly approved per an anonymization procedure (flagged §13 Q1 —
not yet specified, since no production data exists pre-launch).
```

---

# 3. Deployment Topology — Phase 1 (MVP)

Per `04` §72–73's Phase 1 target, made concrete:

```text
                        Internet
                           │
                    DNS (A/AAAA record)
                           │
                  ┌────────┴────────┐
                  │  Reverse Proxy   │   Caddy (automatic TLS via
                  │  (Caddy)         │   Let's Encrypt, per 04 §71)
                  └────────┬────────┘
                           │
                  ┌────────┴────────┐
                  │  Next.js App     │   Docker container,
                  │  (single VPS)    │   1-2 replicas for basic
                  └────────┬────────┘   availability (§4.3)
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   PostgreSQL          Redis              Object Storage
   (shared cluster,   (queue, rate       (S3-compatible,
   primary + daily    limit, cache)      managed or
   backup, §9)        — same VPS or      self-hosted MinIO,
                       small managed      §10)
                       instance
```

**Single VPS is the Phase 1 target** — application, reverse proxy, and (optionally) Redis co-located; PostgreSQL may be on the same VPS initially or a separate small managed instance, decided at implementation based on measured load, not speculated in advance (per `04` §151, "Premature optimization করা হবে না").

---

# 4. Docker Image Build & Publish

## 4.1 Image Contents (per `04` §70)

```text
Single application image: the Next.js app (web + API + background
worker entrypoint, per 04 §129's monorepo structure — apps/web,
apps/worker share the same base image with a different container
CMD/entrypoint at MVP, rather than two separately-built images,
keeping the build pipeline simple until worker load justifies
separation, per 04 §74's Microservices Policy)

Infrastructure containers (PostgreSQL, Redis) use standard upstream
images — never custom-built, never patched in ways that diverge
from upstream security updates.
```

## 4.2 Build Pipeline

```text
1. CI (per 24 §11.1's blocking gates already passed) builds the
   production Docker image on merge to main
2. Image tagged with the Git commit SHA (immutable, traceable — never
   deploy a `latest` tag to production)
3. Image pushed to a container registry (GitHub Container Registry
   or equivalent — provider choice is an implementation-time decision
   per 04 §173, "Exact vendor" list, not an architecture freeze item)
4. Staging deployment pulls the newly-tagged image automatically
   (§2.1)
5. Production deployment pulls a SPECIFIC, staging-validated tag via
   explicit promotion (§7) — never auto-deployed straight from CI
```

## 4.3 Replica Strategy

```text
MVP: 1-2 application container replicas behind the reverse proxy,
     for basic availability during rolling deploys (§7) and to
     tolerate a single container crash without full downtime.

Session state is NEVER held in-process (04 §31 — sessions are
DB/Redis-backed) and tenant context is NEVER a mutable process-
global (05 §160-161) — this is precisely what makes horizontal
replica scaling safe without additional application changes; it was
already an architecture requirement for correctness, and this
document simply relies on it for deployment flexibility.
```

---

# 5. Secrets Injection

Concretizes `13` §7's categories into a deploy-time mechanism.

## 5.1 Platform Secrets

```text
Injected as environment variables at container start, sourced from
the deployment host's secret store (e.g. Docker secrets, a hosted
secret manager, or an encrypted .env file restricted to the deploy
user — exact mechanism is an implementation choice per 04 §173, not
an architecture freeze item, PROVIDED it satisfies: never in the
Git repository, never logged, never in the built image layer itself
— injected at container START, not baked in at BUILD time).

DATABASE_URL, AUTH_SECRET, REDIS_URL, OBJECT_STORAGE_* , SENTRY_DSN,
N8N_WEBHOOK_BASE (per 04 §68) — one value set per environment (§2.2),
never shared across environments.
```

## 5.2 Tenant Secrets

```text
Tenant secrets (Telegram bot tokens, SMTP credentials, webhook
signing secrets per 23 §9.2, dedicated-DB credential_ref per 06
§4.6) are NOT deployment-time environment variables — they are
runtime, tenant-scoped values stored in the application's own
encrypted secret store (13 §7), managed via the application itself
(tenant settings UI), entirely orthogonal to this document's
platform-secret injection mechanism.
```

## 5.3 Secret Rotation at Deploy Time

```text
Rotating a PLATFORM secret (e.g. AUTH_SECRET) requires a coordinated
restart of all application replicas (since it's process-env-scoped)
— documented as a manual/scripted ops procedure, not an automatic
hot-reload capability at MVP (hot-reloading a signing secret without
invalidating all active sessions is a non-trivial correctness
problem, deliberately deferred rather than built speculatively).
```

---

# 6. Database Provisioning

## 6.1 Shared Cluster (Phase 1 default, per `05` §100, §165)

```text
One PostgreSQL instance/cluster hosts the Control Plane schema plus
every Shared-mode tenant's Core/Modules/Industry schemas (per 06 §3).
Provisioning a NEW shared tenant (05 §49) requires NO new database
infrastructure — only application-level rows (control.tenants,
seed data via 05 §112's Use-Case-driven seeding).
```

## 6.2 Dedicated Tenant Provisioning — Automation

Concretizes `05` §50's conceptual flow into a deployment-pipeline artifact:

```text
DedicatedTenantProvisioningJob (triggered by an Owner/Platform-Admin
action, per 05 §50, NOT part of the application's request/response
cycle — a background job, per 04 §45):

1. Create tenant record (status=PENDING)
2. Provision a new PostgreSQL database (automation script, e.g.
   Terraform/a provider API call against the hosting platform — the
   exact IaC tool is an implementation choice not frozen here,
   PROVIDED it is scripted/repeatable, never a manual "click around
   the hosting dashboard" procedure, per 05 §52's idempotency
   requirement)
3. Generate credentials, store credential_ref in
   control.tenant_databases (06 §4.6) — raw credentials touch the
   secret manager only, never a plaintext log/commit
4. Run schema migrations (§8) against the new database
5. Run tenant seed (05 §112)
6. Health check (05 §148 — connectivity + schema_version + basic query)
7. Register database (control.tenant_databases.status=ACTIVE)
8. Activate tenant

Any step failure -> tenant remains non-ACTIVE, retry is idempotent
(05 §52 — no duplicate database/seed on retry, enforced by checking
existing control.tenant_databases row before re-provisioning).
```

## 6.3 Database Backup Automation

```text
Shared cluster: automated daily full backup + continuous WAL
  archiving (point-in-time recovery, per 04 §99-100) via the hosting
  provider's managed backup feature where available, or a scripted
  pg_basebackup + WAL-archive process on self-managed PostgreSQL.

Dedicated tenant databases: same mechanism, per-database, so a
  dedicated tenant's backup/restore is independently schedulable
  (05 §63, "Dedicated tenant-এর granular restore সুবিধা বেশি") —
  concretely, each dedicated tenant's backup job is a distinct
  scheduled task referencing that tenant's connection from the
  registry (06 §4.6), not a single blanket "backup everything" script
  that couldn't restore one tenant independently.

Retention: minimum 30 days of daily backups + 7 days of WAL for
  point-in-time recovery (exact retention is a cost/compliance
  tradeoff, flagged §13 Q2 as needing product/legal input, per 04
  §174's "Data retention period" — explicit product approval category).
```

---

# 7. Deployment Strategy

## 7.1 Promotion Flow

```text
main branch merge
        ↓
CI (24 §11.1 blocking gates)
        ↓
Docker image built + tagged (§4.2)
        ↓
Auto-deploy to Staging
        ↓
Manual smoke test / pilot-tenant validation on Staging (04 §167 —
  "New financial features প্রথমে controlled pilot")
        ↓
Explicit promotion action (a human clicks "Promote to Production" —
  or a scripted command referencing the validated image tag) — never
  automatic staging-to-production promotion at MVP, since financial-
  system releases warrant a deliberate gate (04 §167)
        ↓
Production rolling deploy (§7.2)
```

## 7.2 Rolling Deployment (near-zero-downtime)

```text
With 2 replicas (§4.3):
  1. Start new container with the new image tag
  2. Wait for /ready (§9) to return healthy
  3. Route traffic to the new container (reverse proxy config
     reload, or a load-balancer health-check-driven cutover)
  4. Stop the old container
  5. Repeat for the second replica

Database migrations (§8) run BEFORE the new application version
receives traffic, and are written to be backward-compatible with
the OUTGOING version still serving requests during the brief overlap
window (per 04 §56's "New App → Backward-compatible schema →
Migrate → Enable new behavior" pattern) — this is why 04 §168's
"Additive first" schema-change rule is a deployment-safety
requirement, not merely a style preference.
```

## 7.3 Single-Replica Fallback

```text
If Phase 1 cost constraints mean only ONE application replica is
running (a legitimate MVP-cost tradeoff, per 04 §117), rolling
deployment degrades to brief-downtime deployment (stop old, start
new, wait for /ready) — this is an ACCEPTED, documented tradeoff at
launch scale, not a gap to silently work around; §4.3 flags 2
replicas as the target specifically to avoid this, but the
architecture does not REQUIRE 2 replicas to function correctly at
smaller scale.
```

---

# 8. Database Migrations in the Deploy Pipeline

Concretizes `04` §65's "Versioned migrations, no manual production schema edit" into a pipeline step.

```text
Migration files live in db/migrations (04 §132), generated by
Drizzle's migration tooling from schema changes.

Deploy pipeline step (runs once per deploy, before traffic cutover,
per §7.2):
  1. Connect to target database (Control Plane's own migration
     tracking table, distinct from each tenant database's own
     schema_version tracking, per 05 §53-55)
  2. Apply any pending migrations in order
  3. For Shared mode: ONE schema migration serves all shared tenants
     simultaneously (05 §53)
  4. For Dedicated mode: migrations apply per-tenant-database,
     batched via the Rolling Migration strategy (05 §55) if the
     dedicated-tenant count is large enough to warrant batching —
     at MVP scale (few dedicated tenants), this may simply be a
     sequential loop over control.tenant_databases WHERE
     storage_mode=DEDICATED, deferred to true batching only once
     tenant count makes sequential migration too slow (measured,
     not speculated — per 04 §151)

Migration failure -> deploy pipeline halts BEFORE traffic cutover
  (§7.2 step 2's health check would also catch a broken migration
  indirectly, but the migration step itself fails fast rather than
  relying solely on the health check as a backstop).
```

---

# 9. Health Checks

Concretizes `04` §76.

```text
GET /health  — process alive, no dependency checks (used by the
               container runtime's own restart-on-crash policy)
GET /ready   — dependencies usable:
                 - database connection pool can execute a trivial
                   query
                 - Redis connection is live (if Redis is in use, per
                   04 §46's "conditional" queue infrastructure)
                 - (does NOT check every dedicated tenant database —
                   that would make /ready's latency proportional to
                   tenant count; dedicated-tenant health is tracked
                   separately, per 05 §148's periodic health check job)

Reverse proxy (Caddy) and/or the container orchestration layer poll
/ready before routing traffic to a container (§7.2 step 2).
```

---

# 10. Object Storage Deployment

```text
Phase 1: a single S3-compatible bucket/namespace per environment
  (§2.2) — either a managed provider (lower ops burden) or
  self-hosted MinIO on the same VPS (lower cost, per 04 §117's cost
  philosophy) — the choice is an implementation-time decision (04
  §173), not an architecture freeze item, PROVIDED the application
  code only ever talks to the S3-compatible API (04 §56), never a
  provider-specific SDK feature that would lock the choice in.

Tenant path isolation (04 §57, tenant/{tenantId}/...) is enforced by
  application code regardless of underlying provider — the deployment
  choice of WHICH S3-compatible service does not change this
  application-layer isolation guarantee.
```

---

# 11. Observability Stack Wiring

Concretizes `04` §75 and `13` §8 into deployed infrastructure.

```text
Application → structured JSON logs → stdout/stderr (container-native
  logging, per standard Docker/12-factor practice) → collected by
  the hosting platform's log aggregation (or a lightweight self-
  hosted collector at MVP cost scale) → retained per §6.3-adjacent
  retention policy (exact log retention is an implementation
  decision, not specified here)

Application → error events → Sentry-compatible error tracking
  service (SENTRY_DSN env var, §5.1) — captures unhandled exceptions
  and explicitly-flagged anomalies (e.g. 05 §131's "guard ever
  returns an unexpected allow" alert case, wired as a manual
  Sentry.captureMessage call at that specific code path)

Database health, Queue health, Sync failure metrics (04 §75) →
  either the hosting provider's native database/Redis monitoring
  (Phase 1, lowest setup cost) or a self-hosted metrics stack
  (Prometheus-compatible, deferred to Phase 2 per 04 §73's scale
  strategy, not required for MVP launch)
```

---

# 12. Disaster Recovery — Concrete RPO/RTO Targets (Phase 1)

Concretizes `04` §100 and `05` §146 with actual numbers, subject to revision once real infrastructure/cost tradeoffs are validated:

```text
Shared tier (default):
  RPO ≈ 24 hours (daily backup) + WAL-archive-narrowed window where
    point-in-time recovery is configured (§6.3)
  RTO ≈ few hours (manual restore procedure at MVP scale — no
    automated failover cluster at Phase 1, per 04 §72's cost
    discipline)

Dedicated tier (enterprise, per 05 §100, §146):
  Same mechanism, but per-tenant-scoped, meaning a single dedicated
  tenant's restore does not require restoring/affecting any other
  tenant's data — this IS the concrete Phase-1 RTO improvement
  dedicated tenants receive, even without a fundamentally different
  backup TECHNOLOGY at MVP.

Restore drills (04 §99, "Backup সফল হয়েছে মানেই recovery নিশ্চিত
  নয়") — scheduled quarterly at minimum, exercising the actual
  restore procedure against a non-production target, not merely
  verifying the backup FILE exists.
```

---

# 13. Open Deployment Questions

```text
1. Production-data anonymization procedure for development/staging
   use (§2.3) — needed once real tenant data exists post-launch;
   unspecified until then.
2. Exact backup retention period (§6.3) — cost/compliance tradeoff
   requiring product/legal input, per 04 §174's explicit-approval
   category (mirrors the identical open question already flagged in
   03 §34 Q15 / 06 §5.15).
3. Container registry / IaC tool / managed-vs-self-hosted database
   and object storage choices (§4.2, §6.2, §10) — all flagged as
   implementation-time decisions per 04 §173's "does NOT require
   user decision yet" category; should any of these be escalated to
   an explicit product decision before implementation begins, given
   their cost implications?
4. When does Phase 1's single-VPS topology (§3) get revisited toward
   04 §73's Phase 2 (app replicas, managed PostgreSQL, dedicated
   worker)? Tied to a measured load threshold, not a calendar date —
   what specific metric (request latency p95? database CPU?
   concurrent tenant count?) should trigger that migration decision?
5. Multi-region readiness (05 §143-145 flagged this as future/
   deferred) — does this document need a placeholder Region field in
   the deployment pipeline now, or is it genuinely zero-scope until
   an enterprise tenant requires data residency?
```

---

# 14. Decisions Established by This Document

### Decision DEP-001
The application Docker image is a single build artifact serving both the web/API process and the background worker process via different container entrypoints — separate images are deferred until measured worker load justifies independent scaling, consistent with the Microservices Policy (`04` §74).

### Decision DEP-002
Production deployment is always an explicit, human-gated promotion from a validated Staging deployment — there is no automatic staging-to-production pipeline at MVP, given the financial-system stakes of this platform (`04` §167).

### Decision DEP-003
Database migrations execute as a pipeline step immediately before traffic cutover in every deploy, and every migration must be backward-compatible with the outgoing application version for the duration of a rolling deploy's overlap window — concretely operationalizing the "Additive first" schema rule (`04` §168).

### Decision DEP-004
Dedicated-tenant database provisioning (`05` §50) is implemented as an idempotent, retry-safe background job (`DedicatedTenantProvisioningJob`) — never a manual, undocumented infrastructure-console procedure — ensuring the tenant record accurately reflects provisioning state at every step and a failed attempt can be safely retried without creating duplicate infrastructure.

### Decision DEP-005
Backup/restore is implemented per-database (one job per dedicated tenant, one job for the shared cluster), never as a single undifferentiated "backup everything" script — this is what gives dedicated tenants their concrete Recovery Time Objective advantage at Phase 1, independent of any future backup-technology upgrade.

---

# 15. Next Document

পরবর্তী document:

`26_SAAS_BILLING_SPECIFICATION.md`

এখানে SaaS commercial layer বিস্তারিত হবে — `03` §70–75 (SaaS Commercial Model, Tenant Billing, Plan Limits, Enterprise Dedicated Plan, Control Plane vs Business Plane) এবং `05` §100–101, §151–152 (Tenant Tier Strategy, Cost Visibility, Commercial Architecture Benefit)-এ যা baseline হিসেবে established হয়েছিল তার concrete billing/subscription/usage-metering implementation:

```text
Plan definition schema detail (extends control.plans, 06 §4.5)
Subscription lifecycle (trial → active → past_due → cancelled)
Usage metering aggregation and plan-limit enforcement (ties together
  05 §72-73, 22 §8.2's AI-specific metering, and this document's
  general mechanism)
Payment gateway integration boundary (deferred concept from 04 §160,
  now specified)
Invoice generation for platform subscription billing (distinct from
  tenant business invoicing, per 05 §74's Billing Separation)
Plan upgrade/downgrade transition rules
Dunning / past-due handling
```
