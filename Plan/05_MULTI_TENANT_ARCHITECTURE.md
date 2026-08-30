# 05_MULTI_TENANT_ARCHITECTURE.md

**Project:** Modular Multi-Tenant Business ERP SaaS  
**Document:** Multi-Tenant Architecture Specification  
**Version:** 1.0  
**Status:** Architecture Baseline / Proposed  
**Depends on:** `03_MASTER_PROJECT_SPECIFICATION.md`, `04_PLATFORM_ARCHITECTURE.md`

---

# 1. Purpose

এই document নির্ধারণ করবে platform-এর multi-tenant architecture কীভাবে কাজ করবে।

Platform-এর মূল requirement:

```text
ONE APPLICATION
        │
        ├── Shared Database Tenants
        │
        └── Dedicated Database Tenants
```

একজন ছোট ব্যবসা একই PostgreSQL infrastructure-এর shared environment ব্যবহার করতে পারবে।

একজন বড়/enterprise client প্রয়োজন হলে নিজের isolated PostgreSQL database ব্যবহার করতে পারবে।

দুই mode-এর জন্য:

```text
same product
same domain model
same business rules
same API
same frontend
same release process
```

রাখা হবে।

---

# 2. Core Principle

> Tenant isolation is a security boundary, not merely a filtering feature.

অর্থাৎ শুধু query-তে `WHERE tenant_id = ...` যোগ করলেই architecture complete হবে না।

Isolation-এর জন্য একাধিক layer থাকবে:

```text
Authentication
        ↓
Tenant Resolution
        ↓
Membership Authorization
        ↓
Application Scope
        ↓
Repository Scope
        ↓
Database Isolation
        ↓
Audit
```

---

# 3. Tenant Definition

Tenant হলো একটি independent business workspace।

একটি tenant-এর মধ্যে থাকতে পারে:

```text
Business
Branches
Warehouses
Users
Customers
Suppliers
Products
Sales
Purchases
Inventory
Accounts
Bookings
Services
Projects
Settings
```

একজন ব্যক্তি tenant-এর user হতে পারে, কিন্তু:

> User ≠ Tenant

---

# 4. User vs Tenant

একজন user:

```text
User A
  │
  ├── Tenant 1
  │
  ├── Tenant 2
  │
  └── Tenant 3
```

access করতে পারবে।

তাই user record global identity হিসেবে থাকবে এবং membership tenant access নির্ধারণ করবে।

---

# 5. Membership

Concept:

```text
User
  ↓
Membership
  ↓
Tenant
```

Membership-এর মধ্যে থাকবে:

```text
user_id
tenant_id
role
status
joined_at
```

প্রয়োজনে:

```text
branch_scope
permission_overrides
```

যোগ হতে পারে।

---

# 6. Tenant Lifecycle

Tenant lifecycle:

```text
Prospect
   ↓
Provisioning
   ↓
Active
   ↓
Suspended
   ↓
Grace Period
   ↓
Archived / Deleted
```

প্রতিটি state-এর explicit business meaning থাকবে।

---

# 7. Tenant Types

Initial platform:

```text
SHARED
DEDICATED
```

ভবিষ্যতে:

```text
SHARED
DEDICATED
HYBRID
```

প্রয়োজনে support করা যাবে।

---

# 8. Shared Tenant Model

Shared mode:

```text
PostgreSQL Cluster
        │
        └── Database
              │
              ├── Tenant A
              ├── Tenant B
              ├── Tenant C
              └── Tenant D
```

প্রতিটি tenant-scoped table-এ:

```text
tenant_id
```

থাকবে।

---

# 9. Dedicated Tenant Model

Dedicated mode:

```text
Control Plane
     │
     ├── Tenant A → Shared DB
     ├── Tenant B → Shared DB
     ├── Tenant C → Dedicated DB
     └── Tenant D → Dedicated DB
```

Application runtime tenant অনুযায়ী database route করবে।

---

# 10. Why Same Application

Dedicated tenant-এর জন্য আলাদা codebase তৈরি করা যাবে না।

কারণ:

```text
Bug Fix
Security Patch
Feature
Migration
Documentation
Testing
```

প্রতিটি tenant-এর জন্য আলাদা maintain করতে হলে SaaS economics ভেঙে যাবে।

---

# 11. Control Plane

Control Plane হলো platform-level authority।

এখানে থাকবে:

```text
users
tenants
memberships
plans
subscriptions
tenant database registry
tenant deployment metadata
feature flags
usage
billing metadata
```

Control Plane tenant business transaction data রাখবে না।

---

# 12. Data Plane

Data Plane হলো tenant-এর operational business data।

উদাহরণ:

```text
customers
suppliers
items
sales
purchases
inventory
payments
accounts
bookings
services
projects
```

---

# 13. Control Plane / Data Plane

Architecture:

```text
                    CONTROL PLANE
                         │
              Tenant / User / Plan
                         │
                  Tenant Resolver
                         │
            ┌────────────┴────────────┐
            │                         │
       Shared Data Plane       Dedicated Data Plane
            │                         │
       PostgreSQL A              PostgreSQL B
```

---

# 14. Control Plane Database

Control Plane-এর database-এ minimum entities:

```text
users
tenants
memberships
roles
plans
subscriptions
tenant_databases
tenant_features
tenant_domains
audit_events_platform
```

---

# 15. Business Database

Business database-এ:

```text
customers
suppliers
items
sales
sale_lines
purchases
purchase_lines
stock_movements
payments
accounts
journal_entries
...
```

থাকবে।

---

# 16. Tenant Database Registry

Control Plane-এ registry থাকবে:

```text
tenant_id
storage_mode
database_cluster
database_name/reference
status
schema_version
provisioned_at
last_health_check
```

Secrets সরাসরি সাধারণ tenant record-এ রাখা হবে না।

Credential reference/secret manager ব্যবহার করা হবে।

---

# 17. Tenant Resolver

প্রতিটি authenticated request-এর শুরুতে tenant resolve হবে।

Possible inputs:

```text
session
subdomain
selected tenant
membership
API context
```

কিন্তু client-provided `tenant_id` একা trusted হবে না।

---

# 18. Tenant Resolution Flow

```text
Request
   ↓
Authenticate User
   ↓
Read User Identity
   ↓
Resolve Requested Tenant
   ↓
Check Membership
   ↓
Check Tenant Status
   ↓
Load Tenant Configuration
   ↓
Resolve Storage Mode
   ↓
Create Tenant Context
```

---

# 19. Tenant Context

Application context:

```text
TenantContext
├── tenantId
├── userId
├── membershipId
├── roles
├── permissions
├── storageMode
├── timezone
├── currency
├── featureFlags
└── deviceId
```

এই context request lifecycle-এর মধ্যে immutable হিসেবে treat করা হবে।

---

# 20. Tenant Context Rule

কোনো downstream service নিজে থেকে:

```text
tenantId = request.body.tenantId
```

নেবে না।

বরং:

```text
TenantContext
```

থেকে tenant identity নেবে।

---

# 21. Shared Database Isolation

Shared database-এ:

```text
tenant_id
```

mandatory হবে tenant-owned business tables-এ।

উদাহরণ:

```text
customers
-------------
id
tenant_id
name
phone
```

---

# 22. Shared Repository Rule

Repository method:

```text
findCustomer(id)
```

এর বদলে contextual design:

```text
customerRepository.findById(context, id)
```

বা repository tenant-scoped instance হতে পারে:

```text
tenant.customerRepository.findById(id)
```

উদ্দেশ্য:

> Tenant scope যেন accidental omission-এর মাধ্যমে হারিয়ে না যায়।

---

# 23. Automatic Tenant Scoping

যেখানে safe এবং predictable, repository/data-access layer tenant scope automatically apply করবে।

কিন্তু automatic magic-এর ওপর একমাত্র security boundary নির্ভর করা যাবে না।

---

# 24. PostgreSQL RLS

Shared mode-এ PostgreSQL Row Level Security ব্যবহার করা হবে যেখানে architecture অনুযায়ী safely implement করা যায়।

Concept:

```text
current_tenant_id()
```

এবং policy:

```text
tenant_id = current_tenant_id()
```

---

# 25. RLS Transaction Context

Connection pooling-এর কারণে tenant context carefully set করতে হবে।

Preferred conceptual flow:

```text
BEGIN
  SET LOCAL app.tenant_id = '...'
  queries
COMMIT
```

`SET LOCAL` transaction boundary-এর মধ্যে ব্যবহার করা নিরাপদ pattern।

**Connection Pooling Mode (NEW — Phase 0.5 Reconciliation, Decision TEN-002):**

Phase 1 deployment uses **session-mode connection pooling** (reflected
in `25_DEPLOYMENT_ARCHITECTURE.md`).

Rationale: the `SET LOCAL app.tenant_id` discipline (this section,
above) is already mandatory platform-wide for every tenant-scoped
transaction. Because `SET LOCAL`'s effect is automatically cleared at
transaction commit/rollback — before the connection returns to the
pool — this exact pattern is safe under BOTH session-mode and
transaction-mode (e.g. PgBouncer) pooling. Session-mode is chosen as
the Phase 1 default for operational simplicity at MVP scale; migrating
to transaction-mode pooling later requires only an infrastructure/pooler
configuration change, with zero application-code change required, since
the correct discipline is already in place.

---

# 26. RLS Defense in Depth

RLS-এর পাশাপাশি:

```text
Application Authorization
+
Repository Scope
+
Foreign Key Constraints
+
Tests
```

থাকবে।

RLS application bug-এর বিকল্প নয়; additional safety layer।

---

# 27. Dedicated Database Isolation

Dedicated tenant-এর business data:

```text
Tenant C → Database C
```

থাকবে।

Tenant C-এর query কখনো shared database-এ যাবে না যদি registry dedicated mode নির্দেশ করে।

---

# 28. Database Router

Concept:

```text
DatabaseRouter.resolve(tenantId)
```

return করবে:

```text
SharedDatabaseConnection
```

অথবা:

```text
DedicatedDatabaseConnection
```

Domain module এই distinction জানবে না।

---

# 29. Connection Pooling

Shared:

```text
Application
   ↓
Shared Pool
   ↓
PostgreSQL
```

Dedicated:

```text
Application
   ↓
Tenant-specific pool/managed connection strategy
   ↓
Tenant PostgreSQL
```

অনেক dedicated tenant হলে unlimited persistent pool রাখা যাবে না।

Connection management demand-driven হতে হবে।

---

# 30. Dedicated Tenant Connection Lifecycle

Recommended concept:

```text
Tenant Request
 ↓
Resolve Registry
 ↓
Obtain Connection
 ↓
Execute Transaction
 ↓
Release/Return
```

Connection cache থাকলেও eviction strategy থাকবে।

---

# 31. Database Credential Security

Credentials:

```text
Never in source code
Never in frontend
Never in logs
Never in tenant-visible settings
```

Secret manager/environment infrastructure ব্যবহার করতে হবে।

---

# 32. Tenant Database Encryption

At-rest encryption:

```text
Database provider/infrastructure level
```

ব্যবহার করা হবে।

Application-level field encryption কেবল sensitive fields-এর জন্য প্রয়োজন হলে আলাদাভাবে design হবে।

---

# 33. Tenant Data in Logs

Logs-এ:

```text
tenant_id
request_id
user_id
```

রাখা যেতে পারে।

কিন্তু:

```text
password
access token
payment secret
full sensitive document
```

রাখা যাবে না।

---

# 34. Tenant-Aware Cache

যে cache tenant-specific:

```text
tenant:{tenantId}:...
```

namespace ব্যবহার করবে।

Cross-tenant cache collision prevent করতে tenant ID key-এর অংশ হবে।

---

# 35. Tenant-Aware Queue

Background job payload-এ:

```text
tenantId
```

থাকবে যেখানে job tenant-specific।

Worker job execute করার আগে tenant context resolve করবে।

---

# 36. Tenant-Aware Object Storage

Object key:

```text
tenant/{tenantId}/...
```

ব্যবহার করা হবে।

Authorization ছাড়া arbitrary tenant object access সম্ভব হবে না।

---

# 37. Tenant-Aware Search

Initial PostgreSQL search:

```text
WHERE tenant_id = ...
```

Dedicated tenant হলে database boundary নিজেই isolation দেবে।

Future search engine ব্যবহার করলে index/namespace tenant-aware হতে হবে।

---

# 38. Tenant-Aware Notifications

Notification payload:

```text
tenantId
recipient
event
data
```

থাকবে।

Worker অন্য tenant-এর recipient/data ব্যবহার করতে পারবে না।

---

# 39. Tenant-Aware AI

AI context generation:

```text
User
 ↓
TenantContext
 ↓
Authorized Data Query
 ↓
Sanitized Context
 ↓
AI Provider
```

AI layer tenant resolver bypass করতে পারবে না।

---

# 40. Tenant-Aware n8n

ERP থেকে n8n webhook:

```text
tenantId
eventId
eventType
payload
signature
```

সহ যাবে।

n8n workflow tenant context preserve করবে।

---

# 41. Tenant Webhook Signature

Webhook:

```text
HMAC signature
```

বা equivalent secure signing mechanism ব্যবহার করবে।

Receiver signature verify না করলে event গ্রহণ করবে না।

---

# 42. Tenant Domain / Subdomain

Future SaaS routing:

```text
tenant-a.example.com
tenant-b.example.com
```

সম্ভব।

Custom domain:

```text
erp.client.com
```

future enterprise feature হতে পারে।

---

# 43. Tenant Selection UX

User multiple tenant-এর member হলে:

```text
Login
 ↓
Tenant Selector
 ↓
Selected Workspace
```

দেখানো হবে।

বর্তমান active tenant UI-তে clearly visible থাকবে।

---

# 44. Tenant Switching

Tenant switch করলে:

```text
Clear tenant-specific client cache
Reset local state
Load new tenant context
Refresh permissions
Refresh feature flags
Refresh data
```

হতে হবে।

Cross-tenant stale UI রাখা যাবে না।

---

# 45. Offline and Tenant Switching

Offline অবস্থায় tenant switching-এর ক্ষেত্রে বিশেষ সতর্কতা:

```text
Tenant A pending operations
```

কখনো:

```text
Tenant B
```

এর queue-তে যাবে না।

Local database tenant partitioning বাধ্যতামূলক।

---

# 46. IndexedDB Tenant Isolation

Local stores:

```text
tenantId
```

key/index হিসেবে রাখবে।

উদাহরণ:

```text
pendingOperations
-----------------
operationId
tenantId
...
```

---

# 47. Device and Tenant

এক device বহু tenant ব্যবহার করতে পারে।

তাই:

```text
deviceId
```

global হতে পারে, কিন্তু local data:

```text
deviceId + tenantId
```

scope-এ থাকবে।

---

# 48. Tenant Provisioning

New tenant:

```text
Create Tenant
 ↓
Select Plan
 ↓
Select Storage Mode
 ↓
Provision
 ↓
Run Migrations
 ↓
Seed Defaults
 ↓
Create Owner Membership
 ↓
Activate
```

---

# 49. Shared Tenant Provisioning

Shared:

```text
Create tenant record
 ↓
No new database
 ↓
Seed tenant-scoped defaults
 ↓
Activate
```

---

# 50. Dedicated Tenant Provisioning

Dedicated:

```text
Create tenant record
 ↓
Provision database
 ↓
Create credentials
 ↓
Run migrations
 ↓
Run tenant seed
 ↓
Health check
 ↓
Register database
 ↓
Activate tenant
```

Provisioning সফল না হলে tenant Active হবে না।

---

# 51. Provisioning State

Useful states:

```text
PENDING
PROVISIONING
MIGRATING
SEEDING
VERIFYING
ACTIVE
FAILED
```

---

# 52. Provisioning Idempotency

Provisioning retry-safe হতে হবে।

যদি process মাঝপথে fail করে:

```text
retry
```

করলে duplicate database বা duplicate seed data তৈরি করা যাবে না।

---

# 53. Tenant Migration

Shared database migration:

```text
One schema migration
```

সব tenants একই schema version follow করবে।

Dedicated:

```text
Each tenant database
```

migration নিতে হবে।

---

# 54. Dedicated Migration Registry

Control Plane track করবে:

```text
tenant_id
current_schema_version
target_schema_version
migration_status
last_attempt
```

---

# 55. Rolling Migration

Large number of dedicated tenants হলে:

```text
Migration Queue
 ↓
Batch
 ↓
Health Check
 ↓
Next Batch
```

ব্যবহার করা হবে।

একসাথে সব tenant migrate করার চেষ্টা করা যাবে না।

---

# 56. Schema Compatibility

Application version migration-এর সঙ্গে compatible হতে হবে।

Deployment:

```text
New App
 ↓
Backward-compatible schema
 ↓
Migrate
 ↓
Enable new behavior
```

pattern prefer করা হবে।

---

# 57. Tenant Suspension

Suspended tenant:

```text
Login may be blocked
Business writes blocked
Read/export may be allowed according to policy
Automation stopped
```

Exact commercial policy পরে নির্ধারিত হবে।

---

# 58. Tenant Suspension Safety

Suspended tenant-এর pending offline operations:

```text
server rejects writes
```

করবে।

Client misleadingly “synced” দেখাতে পারবে না।

---

# 59. Tenant Deletion

Deletion destructive হওয়ায় multi-step process:

```text
Request
 ↓
Owner Verification
 ↓
Export
 ↓
Grace Period
 ↓
Final Confirmation
 ↓
Backup/Archive
 ↓
Delete
```

---

# 60. Shared Tenant Deletion

Shared mode-এ:

```text
Tenant-scoped rows
```

delete/archive হবে।

RLS/foreign keys data leakage prevent করবে।

---

# 61. Dedicated Tenant Deletion

Dedicated mode-এ:

```text
Archive/export
 ↓
Database backup
 ↓
Database destroy
 ↓
Registry update
```

হবে।

---

# 62. Tenant Data Export

Export should include:

```text
Customers
Suppliers
Items
Sales
Purchases
Inventory
Payments
Accounting
Bookings
Services
Projects
Attachments
```

যা plan/policy অনুযায়ী applicable।

---

# 63. Tenant Backup

Shared:

```text
Database-level backup
+
tenant-level logical export
```

দুটোর উদ্দেশ্য আলাদা।

Dedicated:

```text
database backup
```

সহজভাবে tenant-specific restore করা যায়।

---

# 64. Restore Strategy

Shared tenant restore কঠিন কারণ database shared।

তাই:

```text
Logical tenant export
+
Point-in-time infrastructure backup
```

দুই ধরনের recovery strategy দরকার।

Dedicated tenant-এর granular restore সুবিধা বেশি।

---

# 65. Tenant Cloning

Future feature:

```text
Clone Tenant
```

ব্যবহারে:

```text
structure
settings
templates
```

copy করা যেতে পারে।

Production transactional data default-এ clone করা যাবে না।

---

# 66. Demo Tenant

Platform-এর জন্য isolated demo tenants থাকতে পারে:

```text
demo-pharmacy
demo-electronics
demo-decorator
```

Demo data production tenant থেকে সম্পূর্ণ আলাদা।

---

# 67. Tenant Template

Onboarding দ্রুত করতে:

```text
Generic Business
Retail
Pharmacy
Electronics
Decorator
Service
```

template ব্যবহার করা যাবে।

Template business data নয়; configuration starter।

---

# 68. Module Enablement

Tenant-specific module configuration:

```text
tenant_features
```

এর মাধ্যমে।

উদাহরণ:

```text
inventory = true
accounting = true
rental = true
pharmacy = false
```

---

# 69. Module Isolation

Disabled module:

```text
UI hidden
API authorization denied
Background jobs disabled
```

সব layer-এ enforce হবে।

শুধু menu hide করা feature disable নয়।

---

# 70. Plan-Based Feature

Plan:

```text
Starter
Professional
Business
Enterprise
```

এর সঙ্গে module/limits mapping হতে পারে।

কিন্তু business logic plan check-এর সঙ্গে hard-code করা যাবে না।

---

# 71. Feature Resolution

Final feature availability:

```text
Platform Flag
      +
Plan Entitlement
      +
Tenant Override
      +
Module State
      +
User Permission
```

ফলাফল:

```text
Allowed / Denied
```

---

# 72. Tenant Limits

Potential limits:

```text
users
branches
warehouses
products
monthly invoices
storage
AI usage
automation executions
```

Limits application service-এ enforce হবে।

---

# 73. Usage Metering

Usage event:

```text
tenantId
metric
quantity
period
```

track করা হবে।

Examples:

```text
invoice_created
ai_request
storage_uploaded
automation_triggered
```

---

# 74. Billing Separation

Billing subsystem:

```text
subscription
invoice
payment
usage
```

কে ERP-এর operational accounting-এর সঙ্গে গুলিয়ে ফেলা যাবে না।

Platform billing এবং tenant business accounting আলাদা domain।

---

# 75. Tenant Owner

প্রথম provisioning user:

```text
Owner
```

হবে।

Owner membership ছাড়া tenant orphaned অবস্থায় থাকবে না।

---

# 75a. Owner-Membership Invariant — Hybrid Enforcement (NEW — Phase 0.5 Reconciliation)

Per Decision TEN-001. Three invariants, split between DB-level
null-safety and application-layer business logic:

**INV-OWN-001 (DB-level, null-safety only):**

```sql
ALTER TABLE control.tenants
  ADD CONSTRAINT owner_required_when_active
  CHECK (status != 'ACTIVE' OR owner_membership_id IS NOT NULL);
```

This guarantees only that an ACTIVE tenant's `owner_membership_id` is
never NULL — it does not verify correctness of WHO the owner is.

**INV-OWN-002 (Application-layer, primary protection):**

```text
RemoveMembershipUseCase / SuspendMembershipUseCase / UpdateMembershipRoleUseCase:
  1. Load target membership
  2. IF membership.id == tenant.owner_membership_id:
       -> reject with OWNER_TRANSFER_REQUIRED (409)
       -> caller must invoke TransferOwnershipUseCase (§76) first
  3. ELSE proceed normally
```

**INV-OWN-003 (Transfer atomicity):**

```text
TransferOwnershipUseCase (§76), within a single transaction:
  a. Verify new owner's membership.status = ACTIVE
  b. Set tenants.owner_membership_id = new membership.id
  c. Optionally adjust the previous owner's role (tenant policy)
  owner_membership_id is never observably NULL outside this transaction.
```

**Rationale:** DB-only enforcement (trigger-based) would be correctness-
complete but implementation-complex and would not itself validate
*which* membership is a legitimate transfer target. Application-only
enforcement is conceptually correct but not bug-safe. The hybrid
approach — a simple DB CHECK (never ownerless while ACTIVE) plus
application-layer business logic (who can become owner, how transfer
happens) — balances safety and simplicity.

---

# 76. Ownership Transfer

Future feature:

```text
Owner A
 ↓
Transfer
 ↓
Owner B
```

critical action হওয়ায়:

```text
confirmation
audit
reauthentication
```

প্রয়োজন হতে পারে।

---

# 77. Staff Access

Tenant staff:

```text
User
 ↓
Membership
 ↓
Role
 ↓
Permissions
```

অনুযায়ী access পাবে।

---

# 78. Branch Scope

Tenant-এর মধ্যে multiple branches থাকলে membership:

```text
tenant-wide
```

বা:

```text
branch-specific
```

হতে পারে।

---

# 79. Warehouse Scope

Warehouse access-ও permission/scope দিয়ে control করা যাবে।

কিন্তু tenant isolation-এর সঙ্গে branch/warehouse isolation এক নয়।

Hierarchy:

```text
Tenant
 ├── Branch
 │    └── Warehouse
```

---

# 80. Data Scope

Authorization scope:

```text
Tenant
  ↓
Branch
  ↓
Warehouse
```

প্রয়োজনে:

```text
Department
```

যোগ হতে পারে।

---

# 81. Shared Database Key Design

সব tenant-owned foreign key relationship tenant-safe হতে হবে।

উদাহরণ:

```text
sale.tenant_id
sale.customer_id
```

এবং application/database validation নিশ্চিত করবে:

```text
customer.tenant_id = sale.tenant_id
```

Cross-tenant foreign key কখনো allowed নয়।

---

# 82. Composite Constraints

যেখানে প্রয়োজন:

```text
UNIQUE(tenant_id, code)
UNIQUE(tenant_id, invoice_number)
UNIQUE(tenant_id, sku)
```

ব্যবহার করা হবে।

---

# 83. Tenant ID in Unique Rules

Global uniqueness assume করা যাবে না।

ভুল:

```text
UNIQUE(sku)
```

সঠিক:

```text
UNIQUE(tenant_id, sku)
```

যদি SKU tenant-local হয়।

---

# 84. Global Entities

কিছু entity platform-global হতে পারে:

```text
countries
currencies
system_permissions
system_plans
```

এগুলোর tenant scope প্রয়োজন নেই।

---

# 85. Mixed Entities

কিছু data:

```text
Global definition
+
Tenant customization
```

হতে পারে।

উদাহরণ:

```text
System Permission
Tenant Role
```

---

# 86. Global vs Tenant Data Rule

প্রতিটি table design করার সময় প্রশ্ন:

```text
Is this platform-global?
Is this tenant-owned?
Is this user-global?
Is this branch-scoped?
```

Schema finalization-এর আগে লিখিতভাবে নির্ধারণ করতে হবে।

---

# 87. Cross-Tenant Reporting

Platform admin-এর cross-tenant analytics:

```text
Control Plane
+
authorized aggregation
```

দিয়ে হবে।

Tenant business user cross-tenant data দেখতে পারবে না।

---

# 88. Platform Admin

Platform admin role:

```text
Platform-level
```

হবে।

এটি tenant owner নয়।

Platform admin tenant business data access করলে তা:

```text
explicit authorization
+
audit
```

এর অধীনে হবে।

---

# 89. Break-Glass Access

Emergency support access future feature হতে পারে।

Rules:

```text
Explicit reason
Time limited
Tenant visible/auditable
Minimal permissions
```

ব্যবহার করতে হবে।

---

# 90. Tenant Support Access

Support user default-এ tenant data browse করবে না।

যদি support access প্রয়োজন হয়:

```text
support request
 ↓
authorization
 ↓
temporary access
 ↓
audit
```

---

# 91. Security Testing

Multi-tenant security test suite-এ:

```text
Tenant A → Tenant A data ✓
Tenant A → Tenant B data ✗
Tenant A API → Tenant B ID ✗
Tenant A cache → Tenant B cache ✗
Tenant A file → Tenant B file ✗
Tenant A AI context → Tenant B data ✗
Tenant A webhook → Tenant B event ✗
```

সব critical path test করতে হবে।

---

# 92. IDOR Protection

উদাহরণ:

```text
GET /api/customers/customer-B-id
```

শুধু ID জানলেই access হবে না।

Server:

```text
current tenant
+
membership
+
resource tenant
```

verify করবে।

---

# 93. Tenant Boundary Test

Automated test helper:

```text
assertTenantIsolation()
```

ধরনের reusable testing utility থাকতে পারে।

---

# 94. Migration Isolation Test

Shared migration-এর পরে:

```text
Tenant A rows
Tenant B rows
```

verify করতে হবে।

Dedicated migration-এর পরে:

```text
schema version
seed integrity
```

verify করতে হবে।

---

# 95. Database Health

Tenant request-এর আগে:

```text
database status
```

check সবসময় করা প্রয়োজন নয়।

কিন্তু router/connection layer failure handle করবে।

---

# 96. Dedicated Database Failure

একটি dedicated tenant database down হলে:

```text
Tenant C unavailable
```

হবে।

অন্য tenants ideally unaffected থাকবে।

এটাই dedicated isolation-এর operational advantage।

---

# 97. Shared Database Failure

Shared database down হলে:

```text
multiple tenants affected
```

হবে।

তাই shared tier-এর backup/HA strategy গুরুত্বপূর্ণ।

---

# 98. Noisy Neighbor

Shared tenant resource abuse prevent করতে:

```text
rate limit
query limits
job limits
storage limits
usage quotas
```

প্রয়োজনে ব্যবহার করা হবে।

---

# 99. Heavy Report Isolation

Large reports shared database performance impact করলে:

```text
background job
read replica
materialized view
```

future optimization হতে পারে।

---

# 100. Tenant Tier Strategy

Commercial architecture:

```text
Starter
   ↓
Shared

Professional
   ↓
Shared

Business
   ↓
Shared / Dedicated option

Enterprise
   ↓
Dedicated
```

এটি pricing document-এ final হবে।

---

# 101. Tenant Migration: Shared → Dedicated

Future capability:

```text
Shared Tenant
     ↓
Freeze writes
     ↓
Export consistent snapshot
     ↓
Provision dedicated DB
     ↓
Import
     ↓
Validate
     ↓
Switch registry
     ↓
Resume writes
```

---

# 102. Tenant Migration: Dedicated → Shared

Possible but harder:

```text
Validate compatibility
 ↓
Create shared tenant namespace
 ↓
Import tenant data
 ↓
Verify
 ↓
Switch registry
 ↓
Decommission dedicated DB
```

---

# 103. Migration Verification

Migration success requires:

```text
Row counts
Financial totals
Stock totals
Open receivables
Open payables
Attachments
Users
Permissions
Settings
```

reconciliation।

---

# 104. Migration Rollback

Switch করার আগে old storage retain করতে হবে।

যদি validation fail:

```text
new route disabled
old route restored
```

---

# 105. Tenant Database Version

Application:

```text
compatible schema range
```

জানবে।

Tenant database:

```text
schema_version
```

track করবে।

---

# 106. Database Router Safety

Router ভুল database return করলে catastrophic cross-tenant risk হতে পারে।

তাই:

```text
tenant registry validation
+
connection metadata verification
+
automated tests
```

থাকবে।

---

# 107. Connection Metadata Verification

Dedicated connection initialize হওয়ার সময় সম্ভব হলে:

```text
SELECT configured_tenant_marker
```

বা equivalent mechanism দিয়ে verify করা যেতে পারে।

উদ্দেশ্য:

> Database connection আসলেই expected tenant-এর কিনা নিশ্চিত করা।

---

# 108. Tenant Marker

Dedicated database-এ একটি system-level marker রাখা যেতে পারে:

```text
tenant_id
environment
schema_version
```

যাতে accidental misrouting detect করা যায়।

---

# 109. Environment Isolation

Production:

```text
Production tenant databases
```

কখনো staging/test application-এর সঙ্গে accidentally connect করতে পারবে না।

Environment-specific credentials বাধ্যতামূলক।

---

# 110. Development Tenant

Development-এ:

```text
dev-tenant
```

ব্যবহার করা হবে।

Production data local development-এ ব্যবহার করা যাবে না unless sanitized and explicitly approved.

---

# 111. Test Tenant

Automated tests:

```text
tenant-a-test
tenant-b-test
```

ব্যবহার করতে পারে।

Isolation tests অন্তত দুই tenant নিয়ে চালানো হবে।

---

# 112. Seed Isolation

Seed script:

```text
tenant context ছাড়া tenant-owned data create করবে না।
```

---

# 113. Background Worker Tenant Context

Worker job:

```text
job.tenantId
```

থেকে context তৈরি করবে।

Worker process-wide global tenant variable ব্যবহার করবে না।

---

# 114. Concurrent Jobs

এক worker process-এ:

```text
Tenant A job
Tenant B job
```

parallel চলতে পারে।

তাই mutable global tenant context forbidden।

---

# 115. Tenant-Aware Cron

Scheduled job:

```text
for each eligible tenant
    create tenant-scoped job
```

হবে।

একটি global job সরাসরি সব tenant data query করে business operation করা avoid করতে হবে।

---

# 116. Tenant Timezone

Scheduled business operation tenant timezone অনুযায়ী calculate হবে।

উদাহরণ:

```text
Daily closing
Payment reminder
Expiry alert
Booking reminder
```

---

# 117. Tenant Currency

Tenant configuration:

```text
base_currency
```

রাখবে।

Multi-currency support future module হলেও architecture এখন থেকেই currency context-ready থাকবে।

---

# 118. Tenant Locale

Tenant/user:

```text
language
timezone
date_format
number_format
```

configure করতে পারবে।

---

# 119. Tenant Settings

Tenant settings database-scoped হবে:

```text
business_name
logo
phone
address
currency
timezone
invoice_prefix
tax_settings
```

Sensitive credentials এখানে রাখা যাবে না।

---

# 120. Tenant Branding

Branding data:

```text
logo
colors
receipt settings
invoice settings
```

tenant-scoped।

---

# 121. Tenant Audit

Tenant audit:

```text
who
what
when
where
before
after
```

track করবে যেখানে appropriate।

---

# 122. Platform Audit

Platform-level actions:

```text
tenant created
plan changed
tenant suspended
database provisioned
database migrated
support access granted
```

Control Plane audit-এ থাকবে।

---

# 123. Audit Separation

```text
Platform Audit
       ≠
Tenant Business Audit
```

দুইটির retention/access policy আলাদা হতে পারে।

---

# 124. Tenant Event IDs

Business event:

```text
event_id
tenant_id
event_type
occurred_at
```

সহ হবে।

এটি automation idempotency এবং tracing-এ সাহায্য করবে।

---

# 125. Tenant Data Boundary Contract

প্রতিটি module documentation-এ লিখতে হবে:

```text
Tenant Scoped? yes/no
Branch Scoped? yes/no
Warehouse Scoped? yes/no
Global? yes/no
```

Database specification-এর সময় এটি mandatory metadata হবে।

---

# 126. Tenant Boundary Checklist

নতুন table তৈরি হলে:

```text
[ ] Tenant scope determined
[ ] tenant_id added if required
[ ] Foreign keys tenant-safe
[ ] Unique constraints tenant-safe
[ ] Repository scoped
[ ] API authorization
[ ] RLS considered
[ ] Audit considered
[ ] Offline scope considered
[ ] Tests added
```

---

# 127. New API Checklist

নতুন API:

```text
[ ] Authentication
[ ] Tenant resolution
[ ] Permission
[ ] Resource ownership
[ ] Validation
[ ] Idempotency if mutation
[ ] Audit if sensitive
[ ] Error code
[ ] Rate limit if needed
```

---

# 128. New Background Job Checklist

```text
[ ] tenantId
[ ] authorization assumptions
[ ] idempotency
[ ] retry safety
[ ] failure handling
[ ] logging
[ ] dead-letter strategy if needed
```

---

# 129. New File Feature Checklist

```text
[ ] tenant path
[ ] access control
[ ] MIME validation
[ ] size limit
[ ] signed access
[ ] deletion policy
[ ] audit
```

---

# 130. New AI Feature Checklist

```text
[ ] tenant context
[ ] permission-aware retrieval
[ ] no cross-tenant context
[ ] sensitive data handling
[ ] tool authorization
[ ] mutation confirmation
[ ] audit
```

---

# 131. Tenant Isolation Threat Model

Threats:

```text
IDOR
Wrong tenant query
Wrong database routing
Cache collision
Queue contamination
File path collision
AI context leak
Webhook replay
Offline queue mix-up
Migration mix-up
Admin overreach
```

প্রতিটির automated/manual mitigation থাকবে।

---

# 132. Cross-Tenant Query Prevention

Code review rule:

> কোনো tenant-owned repository query tenant context ছাড়া গ্রহণ করা যাবে না।

Exception:

```text
controlled platform-level operation
```

এবং সেটি explicit privileged service হবে।

---

# 133. Platform Query Boundary

Cross-tenant analytics-এর জন্য:

```text
PlatformAnalyticsService
```

থাকতে পারে।

Tenant domain services এই service ব্যবহার করবে না।

---

# 134. Admin API Boundary

```text
/api/platform/*
```

এবং:

```text
/api/*
```

conceptually আলাদা permission domain হতে পারে।

Platform API accidentally tenant API-এর authorization bypass করবে না।

---

# 135. Tenant API Boundary

Tenant API:

```text
tenant context mandatory
```

হবে।

No tenant = no business data access।

---

# 136. Public API

যদি future public API থাকে:

```text
API key
OAuth
Webhook
```

tenant-bound credentials ব্যবহার করবে।

Public API key কখনো global unrestricted database access দেবে না।

---

# 137. API Key Scope

API key:

```text
tenantId
scopes
createdBy
expiresAt
status
```

সহ থাকবে।

---

# 138. Service Account

Automation-এর জন্য:

```text
Service Account
```

ব্যবহার করা যেতে পারে।

Service account-এরও:

```text
tenant
permissions
scope
```

থাকবে।

---

# 139. Tenant Secrets

Tenant-specific external credentials:

```text
encrypted secret store
```

বা secret manager-এ থাকবে।

Examples:

```text
Telegram bot token
SMTP credentials
Payment gateway secret
Google credentials
```

---

# 140. Secret Access

Tenant secret access:

```text
application server only
```

হবে।

Frontend-এ secret plaintext পাঠানো হবে না।

---

# 141. Tenant Data Encryption

Default:

```text
TLS in transit
Database encryption at rest
Object storage encryption
```

Sensitive field-level encryption পরে প্রয়োজন অনুযায়ী।

---

# 142. Dedicated Encryption

Enterprise tier-এ future:

```text
customer-managed key
```

বা separate encryption key support করা যেতে পারে।

এটি initial MVP requirement নয়।

---

# 143. Tenant Data Residency

Future enterprise requirement:

```text
region
```

অনুযায়ী database/object storage deploy করার architecture রাখা যেতে পারে।

Registry-তে future:

```text
region
```

field রাখা সম্ভব।

---

# 144. Region Routing

Future:

```text
Tenant → Region → Database
```

routing হতে পারে।

Initial deployment single region হতে পারে।

---

# 145. Multi-Region

MVP-তে multi-region নয়।

Future architecture:

```text
Global Control Plane
       ↓
Region Router
       ↓
Regional Data Plane
```

---

# 146. Disaster Recovery by Tenant Tier

Shared:

```text
cluster-level backup
```

Dedicated:

```text
tenant-specific backup
```

Enterprise:

```text
higher RPO/RTO
```

---

# 147. Tenant Health

Tenant health state:

```text
HEALTHY
DEGRADED
PROVISIONING
MIGRATING
SUSPENDED
FAILED
```

Control Plane monitor করবে।

---

# 148. Tenant Health Check

Dedicated tenant-এর জন্য:

```text
database connectivity
schema version
basic query
```

periodically check করা যেতে পারে।

---

# 149. Tenant Database Auto-Recovery

Infrastructure provider support করলে:

```text
restart
failover
backup restore
```

strategy ব্যবহার করা যাবে।

Application নিজে blindly database recreate করবে না।

---

# 150. Operational Dashboard

Platform admin dashboard-এ:

```text
Tenant Count
Shared Tenants
Dedicated Tenants
Healthy
Degraded
Provisioning
Migration Pending
Suspended
```

দেখানো যাবে।

---

# 151. Tenant Cost Visibility

Control Plane ভবিষ্যতে track করতে পারে:

```text
storage
database tier
AI usage
automation usage
API usage
```

এতে dedicated tenant-এর actual infrastructure cost বোঝা যাবে।

---

# 152. Commercial Architecture Benefit

এই architecture-এর ফলে:

```text
Small Client
→ Shared
→ Low Cost

Growing Client
→ Shared
→ Higher Plan

Enterprise Client
→ Dedicated
→ Premium Fee
```

একই product থেকে সম্ভব।

---

# 153. No Code Fork Policy

Tenant-specific customization:

```text
Configuration
Feature Flags
Modules
Templates
Permissions
Themes
```

দিয়ে করতে হবে।

Tenant-specific source-code fork করা যাবে না।

---

# 154. Custom Feature Policy

যদি enterprise client-এর unique feature দরকার হয়:

```text
Generalize feature
→ module
→ feature flag
→ tenant entitlement
```

হিসেবে platform-এ আনতে হবে যেখানে practical।

---

# 155. Tenant-Specific Workflow

Workflow configuration database-এ রাখা যেতে পারে:

```text
trigger
conditions
actions
```

কিন্তু critical financial business rule workflow engine-এ migrate করা যাবে না।

---

# 156. Tenant Automation Boundary

Automation:

```text
after business truth
```

চলবে।

উদাহরণ:

```text
Sale completed
 ↓
n8n notification
```

কিন্তু:

```text
n8n
 ↓
complete sale
```

authoritative business transaction হিসেবে ব্যবহার করা হবে না।

---

# 157. Tenant AI Boundary

AI:

```text
Assistant
Analyst
Draft Generator
Search Interface
Automation Helper
```

হতে পারে।

কিন্তু AI নিজে tenant boundary override করতে পারবে না।

---

# 158. Tenant Database Router Failure Policy

যদি tenant registry missing:

```text
fail closed
```

হবে।

অর্থাৎ কোনো fallback:

```text
default shared database
```

ব্যবহার করা যাবে না।

---

# 159. Fail Closed Principle

Critical uncertainty:

```text
Unknown tenant
Unknown permission
Unknown database
Unknown feature entitlement
```

হলে:

```text
DENY
```

হবে।

---

# 160. Tenant Context Leakage Prevention

Request শেষ হলে tenant context memory/state-এ রাখা যাবে না।

বিশেষ করে:

```text
global variables
singleton mutable context
worker globals
```

forbidden।

---

# 161. Async Context

Node.js async execution-এ tenant context ব্যবহারের জন্য:

```text
request-local context
```

বা explicit context passing prefer করা হবে।

Implicit context অত্যন্ত carefully ব্যবহার করতে হবে।

---

# 162. Testing Model

Every critical tenant test:

```text
Tenant A
Tenant B
```

দুই dataset দিয়ে চালানো হবে।

Expected:

```text
A cannot see B
B cannot see A
```

---

# 163. Security Regression

প্রতিটি release-এ critical isolation tests চালানো হবে।

Tenant isolation test fail করলে release block হবে।

---

# 164. Dedicated vs Shared Comparison

| বিষয় | Shared | Dedicated |
|---|---|---|
| Cost | কম | বেশি |
| Isolation | Logical + RLS | Physical/DB boundary |
| Scale | সহজ | বেশি isolated |
| Backup | Shared | Tenant-specific |
| Failure blast radius | বেশি | কম |
| Provisioning | সহজ | বেশি |
| Migration | সহজ | complex |
| Enterprise suitability | Medium | High |
| Custom DB tuning | সীমিত | বেশি |

---

# 165. Default Strategy

Default new tenant:

```text
SHARED
```

হবে।

Dedicated:

```text
Enterprise requirement
+
plan entitlement
+
explicit provisioning
```

এর ভিত্তিতে।

---

# 166. When to Recommend Dedicated

Dedicated consider করা হবে যদি:

```text
Large transaction volume
Strict data isolation requirement
Custom backup/RTO
Custom database sizing
Compliance requirement
Enterprise SLA
```

থাকে।

---

# 167. When NOT to Recommend Dedicated

শুধু:

```text
“আমার আলাদা database চাই”
```

বললেই technical need প্রমাণিত হয় না।

Cost/maintenance tradeoff বুঝিয়ে decision নিতে হবে।

---

# 168. Tenant Architecture Final Rule

> Shared এবং Dedicated হলো storage deployment modes; business domain-এর দুইটি আলাদা implementation নয়।

এটি অত্যন্ত গুরুত্বপূর্ণ architectural invariant।

---

# 169. Final Flow — Shared

```text
User
 ↓
Auth
 ↓
Tenant Resolver
 ↓
Membership
 ↓
Tenant Context
 ↓
Application Service
 ↓
Tenant-scoped Repository
 ↓
RLS + PostgreSQL
 ↓
Shared Database
```

---

# 170. Final Flow — Dedicated

```text
User
 ↓
Auth
 ↓
Tenant Resolver
 ↓
Membership
 ↓
Tenant Context
 ↓
Database Router
 ↓
Application Service
 ↓
Tenant Repository
 ↓
Dedicated PostgreSQL
```

---

# 171. Final Architecture Diagram

```text
                         PLATFORM
                            │
                    ┌───────┴────────┐
                    │                │
              CONTROL PLANE      APPLICATION
                    │                │
          ┌─────────┼─────────┐      │
          │         │         │      │
       Users     Tenants    Plans    │
                    │                │
                    ▼                │
             Tenant Resolver        │
                    │                │
                    ▼                │
             Tenant Context         │
                    │                │
             ┌──────┴──────┐         │
             │             │         │
          SHARED       DEDICATED     │
             │             │         │
             ▼             ▼         │
        PostgreSQL      PostgreSQL   │
             │             │         │
             └──────┬──────┘         │
                    │                │
                    └──── Application┘
                         Domain
```

---

# 171a. Decisions Established by Phase 0.5 Reconciliation (NEW)

### Decision TEN-001
Owner-membership integrity uses hybrid enforcement: `INV-OWN-001` (DB
CHECK constraint, null-safety only) + `INV-OWN-002` (application-layer
reject-before-remove) + `INV-OWN-003` (atomic transfer transaction),
per §75a. Resolves the owner-enforcement gap identified in Phase 0.5
Finding 9 (human-approved).

### Decision TEN-002
Phase 1 uses session-mode PostgreSQL connection pooling; the existing
`SET LOCAL`-per-transaction discipline (§25) makes a future transition
to transaction-mode pooling a pure infrastructure change requiring no
application code modification. Resolves Phase 0.5 Finding 10
(human-approved).

---

# 172. Architecture Invariants

এই project-এ নিচের rules ভাঙা যাবে না:

```text
1. User is not Tenant.
2. Tenant context is mandatory for tenant business data.
3. Client-supplied tenant_id is never trusted by itself.
4. Shared tables are tenant-scoped.
5. Cross-tenant foreign keys are forbidden.
6. Dedicated routing must fail closed.
7. Business domain never knows storage mode.
8. No tenant-specific code fork.
9. Financial mutation is server-authoritative.
10. Offline queue is tenant-partitioned.
11. AI context is tenant-scoped.
12. Background jobs carry tenant context.
13. Tenant switching clears tenant-specific client state.
14. Platform admin access is audited.
15. Critical tenant isolation is automated-tested.
```

---

# 173. Implementation Sequence

Multi-tenant implementation হবে:

```text
Phase 1
Identity
 ↓
Tenant
 ↓
Membership
 ↓
Role/Permission

Phase 2
Shared DB
 ↓
tenant_id
 ↓
Repository scope
 ↓
RLS

Phase 3
Tenant Resolver
 ↓
Tenant Context

Phase 4
Database Router
 ↓
Dedicated DB

Phase 5
Provisioning
 ↓
Migration
 ↓
Backup
 ↓
Shared ↔ Dedicated migration

Phase 6
Security hardening
 ↓
Isolation testing
 ↓
Operational tooling
```

---

# 174. Acceptance Criteria

Multi-tenant architecture complete বলা যাবে যখন:

```text
[ ] User can belong to multiple tenants
[ ] Tenant switching works
[ ] Shared tenants are isolated
[ ] Dedicated tenant routes correctly
[ ] Unknown tenant fails closed
[ ] Cross-tenant IDOR blocked
[ ] RLS tested
[ ] Cache tenant-scoped
[ ] Queue tenant-scoped
[ ] Offline queue tenant-scoped
[ ] Object storage tenant-scoped
[ ] AI retrieval tenant-scoped
[ ] n8n events tenant-scoped
[ ] Tenant provisioning idempotent
[ ] Dedicated migration works
[ ] Tenant suspension works
[ ] Tenant export works
[ ] Tenant deletion workflow exists
[ ] Isolation regression tests pass
```

---

# 175. Next Document

পরবর্তী:

`06_DATABASE_SPECIFICATION.md`

এখানে platform-এর canonical database model নির্ধারণ করা হবে।

প্রথমে:

```text
Control Plane Schema
```

তারপর:

```text
Core Business Schema
```

তারপর:

```text
Module Schema
```

তারপর:

```text
Industry Extension Schema
```

প্রতিটি entity-এর জন্য:

```text
Purpose
Scope
Fields
Types
Primary Key
Foreign Keys
Indexes
Unique Constraints
Lifecycle
Audit
Soft Delete
Tenant Scope
Branch Scope
Warehouse Scope
```

নির্ধারণ করা হবে।

---

# 176. Final Statement

এই architecture-এর লক্ষ্য শুধু “multi-tenant application” বানানো নয়।

লক্ষ্য:

> **একটি business-agnostic SaaS platform তৈরি করা, যেখানে একই domain/application architecture ছোট shared tenants থেকে শুরু করে enterprise dedicated tenants পর্যন্ত একইভাবে পরিচালিত হতে পারে—এবং tenant isolation, accounting integrity, inventory integrity ও offline capability architecture-এর মৌলিক অংশ হিসেবে নির্মিত হয়।**

**Status: APPROVED ARCHITECTURAL BASELINE — subject to later ADR changes.**
