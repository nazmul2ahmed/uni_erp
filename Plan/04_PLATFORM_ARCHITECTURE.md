# 04_PLATFORM_ARCHITECTURE.md

**Project:** Modular Multi-Tenant Business ERP SaaS  
**Document:** Platform Architecture & Technology Specification  
**Version:** 1.0  
**Status:** Architecture Baseline / Proposed Stack Freeze  
**Depends on:**  
- `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md`
- `02_BUSINESS_DOMAIN_ANALYSIS.md`
- `03_MASTER_PROJECT_SPECIFICATION.md`

---

# 1. Purpose

এই document নির্ধারণ করছে platform-টি **কোন technical architecture ও technology stack-এর ওপর নির্মিত হবে**।

এটি business requirement পুনরায় সংজ্ঞায়িত করবে না। বরং Master Project Specification-এর business requirements-কে বাস্তব software architecture-এ রূপান্তর করবে।

Architecture-এর প্রধান লক্ষ্য:

```text
ONE CODEBASE
+
MULTI-TENANT
+
SHARED DATABASE
+
DEDICATED DATABASE
+
PWA
+
OFFLINE/SYNC
+
ACCOUNTING INTEGRITY
+
MODULAR DOMAIN
+
AI
+
AUTOMATION
+
LOW OPERATING COST
+
FUTURE SCALE
```

---

# 2. Architecture Decision Summary

প্রস্তাবিত primary stack:

```text
Frontend
    Next.js
    React
    TypeScript

UI
    Tailwind CSS
    shadcn/ui

Client State
    Zustand

Server State / Data Fetching
    TanStack Query

Validation
    Zod

Backend
    Next.js server runtime
    Application Services
    Domain Services

Database
    PostgreSQL

ORM
    Drizzle ORM

Offline
    IndexedDB
    Dexie

API
    REST/HTTP + typed application contracts

Authentication
    Auth.js-compatible/session architecture
    HTTP-only secure session

File Storage
    S3-compatible object storage

Background Jobs
    Redis-backed queue where required

Automation
    n8n

Search
    PostgreSQL full-text search initially

Deployment
    Docker
    VPS / managed container infrastructure

Reverse Proxy
    Caddy or Nginx

Monitoring
    Sentry-compatible error monitoring
    structured application logs

Testing
    Vitest
    Testing Library
    Playwright

Package Manager
    pnpm

Language
    TypeScript
```

এই stack-এর উদ্দেশ্য হলো প্রথম version-এ unnecessary distributed-system complexity না এনে future scale-এর জন্য clean boundaries রাখা।

---

# 3. Why TypeScript

TypeScript পুরো platform-এর primary language হবে।

কারণ:

```text
Frontend
Backend
Validation
Domain Types
API Contracts
Shared Types
Testing
```

একই language ecosystem-এ রাখা যায়।

বিশেষ সুবিধা:

- type safety
- IDE support
- AI-assisted coding-এর জন্য ভালো context
- frontend/backend type reuse
- mature ecosystem
- React/Next.js integration
- beginner-friendly gradual learning

---

# 4. Why Next.js

Next.js primary web application framework হবে।

ব্যবহার:

```text
Web UI
Routing
Server Components যেখানে উপযুক্ত
API endpoints
Authentication integration
SSR/streaming যেখানে দরকার
PWA shell
```

তবে গুরুত্বপূর্ণ:

> Next.js framework হওয়া মানেই business logic React component-এর ভিতরে থাকবে না।

Architecture হবে:

```text
Next.js UI
     ↓
Application Service
     ↓
Domain Service
     ↓
Repository
     ↓
PostgreSQL
```

---

# 5. Why React

React UI layer হিসেবে ব্যবহার হবে।

React-এর দায়িত্ব:

```text
Rendering
Interaction
Form State
Component Composition
```

React component-এর দায়িত্ব হবে না:

```text
Accounting calculation
Inventory mutation
Tenant authorization
Financial posting
```

---

# 6. Why Tailwind CSS

Tailwind CSS design system implementation-এর জন্য ব্যবহার হবে।

উদ্দেশ্য:

- consistent spacing
- responsive layout
- reusable UI patterns
- fast iteration
- AI-assisted UI implementation
- dark mode
- mobile/tablet/desktop

---

# 7. Why shadcn/ui

shadcn/ui component patterns ব্যবহার করা হবে।

কারণ:

- accessible primitives
- customizable
- source-controlled components
- Tailwind integration
- design system build করা সহজ
- vendor lock-in কম

Core UI components:

```text
Button
Input
Select
Combobox
Dialog
Drawer
Sheet
Table
Tabs
Card
Dropdown
Toast
Form
Command
Calendar
Date Picker
```

---

# 8. Design System

নিজস্ব design system থাকবে:

```text
UI Tokens
 ↓
Primitive Components
 ↓
Business Components
 ↓
Module Components
 ↓
Screens
```

উদাহরণ:

```text
Button
 ↓
MoneyButton
 ↓
PaymentAction
 ↓
PaymentPanel
```

Business-specific visual logic reusable component layer-এ থাকবে।

---

# 9. Client State Architecture

Zustand ব্যবহার হবে client-side ephemeral/application UI state-এর জন্য।

উদাহরণ:

```text
Sidebar state
Current workspace
POS cart draft
Modal state
Filter state
Device state
Sync UI state
```

Zustand authoritative server data store হবে না।

---

# 10. Server Data State

TanStack Query ব্যবহার করা হবে যেখানে server data caching/fetching প্রয়োজন।

উদাহরণ:

```text
Customers
Products
Dashboard summaries
Sales history
Reports
```

Principle:

```text
Server State → TanStack Query
Local UI State → Zustand
Offline Data → IndexedDB/Dexie
Authoritative Data → PostgreSQL
```

---

# 11. Form Architecture

Forms:

```text
React
+
React Hook Form
+
Zod
```

ব্যবহার করবে।

Flow:

```text
User Input
 ↓
Client Validation
 ↓
API Request
 ↓
Server Validation
 ↓
Application Service
```

Client validation UX উন্নত করবে; server validation authoritative থাকবে।

---

# 12. Validation

Zod shared validation/schema layer হিসেবে ব্যবহার হবে।

কিন্তু:

> Zod schema business rule-এর সম্পূর্ণ বিকল্প নয়।

উদাহরণ:

```text
qty must be positive
```

schema validation।

কিন্তু:

```text
return qty cannot exceed eligible sold qty
```

domain/business validation।

---

# 13. Backend Architecture

Backend monolithic modular architecture দিয়ে শুরু হবে।

এটি microservices হবে না।

Structure:

```text
HTTP/API
   ↓
Application Layer
   ↓
Domain Layer
   ↓
Repository Interface
   ↓
Infrastructure
```

---

# 14. Why Modular Monolith

প্রথম version-এ microservices না নেওয়ার কারণ:

- deployment complexity কম
- debugging সহজ
- database transaction সহজ
- local development সহজ
- AI-assisted coding সহজ
- VPS cost কম
- operational overhead কম
- accounting/inventory atomic transaction সহজ

Future scale-এ প্রয়োজন হলে individual workloads আলাদা করা যাবে।

---

# 15. Modular Monolith Boundary

একটি application-এর ভিতরে domain modules আলাদা থাকবে।

```text
Core
├── identity
├── tenant
├── customer
├── supplier
├── catalog
├── sales
├── purchase
├── inventory
├── payment
├── accounting
└── audit

Modules
├── quotation
├── booking
├── service
├── rental
├── project
└── warranty

Industry
├── pharmacy
├── electronics
└── decorator
```

Module-to-module dependency explicit হবে।

---

# 16. Domain Layer

Domain layer-এ থাকবে:

```text
Entities
Value Objects
Domain Services
Policies
Invariants
Domain Events
```

উদাহরণ:

```text
Sale
SaleLine
Money
Quantity
StockPolicy
ReturnEligibilityPolicy
```

---

# 17. Application Layer

Application layer use case orchestration করবে।

উদাহরণ:

```text
CreateSale
CompleteSale
CancelSale
ReceivePurchase
CreateCustomerPayment
CreateStockAdjustment
```

Flow:

```text
Controller
 ↓
Use Case
 ↓
Domain
 ↓
Repository
 ↓
Commit
```

---

# 18. Repository Layer

Domain/application layer database implementation জানবে না।

Interface:

```text
CustomerRepository
SaleRepository
InventoryRepository
PaymentRepository
AccountRepository
```

Infrastructure layer implementation দেবে।

---

# 19. Database

Primary transactional database:

> **PostgreSQL**

কারণ:

```text
ACID transactions
Foreign keys
Constraints
Indexes
JSONB
Full-text search
Row Level Security
Reliable concurrency
Mature ecosystem
```

এই project-এর accounting + inventory + multi-tenant requirements-এর জন্য relational database সবচেয়ে উপযুক্ত।

---

# 20. ORM

Primary ORM:

> **Drizzle ORM**

কারণ:

- TypeScript-first
- SQL-এর কাছাকাছি
- schema explicit
- migrations manageable
- PostgreSQL support
- complex query escape hatch
- AI coding-এ সহজে inspect করা যায়

তবে গুরুত্বপূর্ণ:

> ORM business logic-এর জায়গা নেবে না।

---

# 21. SQL Escape Hatch

যেসব query ORM abstraction-এর চেয়ে explicit SQL-এ নিরাপদ/দক্ষ:

```text
Complex reporting
Aggregation
Financial queries
Inventory reconciliation
PostgreSQL-specific features
```

সেখানে parameterized SQL ব্যবহার করা যাবে।

---

# 22. Database Constraints

Critical business invariants database level-এও enforce করা হবে যেখানে practical।

উদাহরণ:

```text
NOT NULL
UNIQUE
FOREIGN KEY
CHECK
INDEX
```

Application validation একমাত্র protection হবে না।

---

# 23. Multi-Tenant Database Architecture

Platform দুই mode support করবে।

## Mode A — Shared

```text
One PostgreSQL
     │
     ├── Tenant A
     ├── Tenant B
     ├── Tenant C
     └── Tenant D
```

সব tenant-scoped table-এ:

```text
tenant_id
```

থাকবে।

---

# 24. Shared Tenant Isolation

Protection layers:

```text
1. Authentication
2. Membership validation
3. Application authorization
4. tenant_id scoping
5. PostgreSQL RLS where appropriate
```

Defense-in-depth ব্যবহার করা হবে।

---

# 25. RLS Policy

Shared mode-এ PostgreSQL Row Level Security গুরুত্বপূর্ণ tenant boundary হিসেবে ব্যবহার করা হবে।

Concept:

```text
SET app.current_tenant_id = '...';
```

তারপর policy:

```text
tenant_id = current_tenant_id
```

বাস্তব implementation-এ connection pooling এবং transaction context carefully design করতে হবে।

---

# 26. Dedicated Tenant Architecture

Enterprise/large tenant:

```text
Application
    ↓
Tenant Resolver
    ↓
Deployment Registry
    ↓
Dedicated PostgreSQL
```

প্রতিটি dedicated tenant-এর database আলাদা হতে পারে।

---

# 27. Database Router

Application:

```text
getTenantDatabase(tenantId)
```

ধরনের abstraction ব্যবহার করবে।

Router জানবে:

```text
shared
dedicated
```

কিন্তু domain service জানবে না।

---

# 28. Control Plane

Control Plane-এর database/business data আলাদা logical concern।

Control Plane:

```text
Tenant
User
Membership
Plan
Subscription
Usage
Deployment
Database Registry
Billing
```

Business Data Plane:

```text
Customer
Supplier
Sales
Purchase
Inventory
Accounting
```

---

# 29. Deployment Modes

Initial platform:

```text
Single App Deployment
+
Shared DB
```

পরে:

```text
Dedicated DB
```

enable করা হবে।

Application code একই থাকবে।

---

# 30. Authentication Architecture

Authentication এবং authorization আলাদা।

```text
Authentication
= Who are you?

Authorization
= What can you do?

Tenant Access
= Which business can you access?
```

---

# 31. Session Model

Secure session:

```text
HTTP-only cookie
Secure
SameSite appropriate
Short-lived session/token strategy
Refresh/re-authentication
```

Frontend localStorage-এ long-lived authentication secret রাখা হবে না।

---

# 32. Membership Model

```text
User
 ↓
Membership
 ↓
Tenant
 ↓
Role
 ↓
Permissions
```

একজন user multiple tenant-এর member হতে পারবে।

---

# 33. Authorization

প্রতিটি sensitive API/use case:

```text
authenticate
 ↓
resolve tenant
 ↓
verify membership
 ↓
check permission
 ↓
validate business rule
 ↓
execute
```

এই sequence standard হবে।

---

# 34. Permission Model

Format:

```text
resource.action
```

Examples:

```text
sales.view
sales.create
sales.cancel

purchase.create
purchase.approve

inventory.view
inventory.adjust

accounting.view
accounting.post

staff.manage
settings.manage
```

---

# 35. API Architecture

Primary API style:

> RESTful HTTP application API

উদাহরণ:

```text
GET    /api/customers
POST   /api/customers

GET    /api/sales/:id
POST   /api/sales

POST   /api/sales/:id/complete
POST   /api/sales/:id/cancel
```

Business commands-এর জন্য explicit action endpoints ব্যবহার করা যাবে।

---

# 36. Query vs Command

### Query

Data read:

```text
GET /api/sales
GET /api/dashboard
```

### Command

Business mutation:

```text
POST /api/sales
POST /api/sales/:id/complete
POST /api/sales/:id/cancel
```

Mutation endpoint-এ idempotency support থাকবে।

---

# 37. API Response Contract

Consistent response model:

```text
{
  success: true,
  data: ...,
  meta: ...
}
```

Error:

```text
{
  success: false,
  error: {
    code,
    message,
    details
  },
  requestId
}
```

Production error response-এ internal stack trace expose করা যাবে না।

---

# 38. Error Codes

Human-readable message-এর পাশাপাশি stable machine code:

```text
SALE_NOT_FOUND
SALE_ALREADY_COMPLETED
INSUFFICIENT_STOCK
RETURN_QTY_EXCEEDED
TENANT_ACCESS_DENIED
PERMISSION_DENIED
IDEMPOTENCY_REPLAY
VALIDATION_FAILED
```

---

# 39. Idempotency

Financial mutations:

```text
POST /sales
POST /payments
POST /purchases
POST /returns
```

এর জন্য idempotency key support থাকবে।

Header concept:

```text
Idempotency-Key: ...
```

Server একই key-এর completed result পুনরায় return করতে পারবে।

---

# 40. Transaction Boundary

একটি sale complete:

```text
BEGIN
  create sale
  create sale lines
  create stock movements
  update stock balances
  create payment
  create receivable
  post accounting
  create audit
COMMIT
```

কোনো critical operation ব্যর্থ হলে atomic rollback।

---

# 41. Accounting Transaction Boundary

Financial operation-এ:

```text
Business Event
+
Ledger Effect
```

একই transaction-এর মধ্যে তৈরি হবে।

---

# 42. Inventory Transaction Boundary

Stock-affecting operation:

```text
Business Transaction
+
Stock Movement
+
Stock Balance Update
```

atomic হবে।

---

# 43. Event Architecture

Internal domain events ব্যবহার করা হবে যেখানে useful।

Examples:

```text
SaleCompleted
PaymentReceived
PurchaseReceived
StockLow
BookingConfirmed
ServiceCompleted
```

Event-এর দুই ধরনের consumer থাকতে পারে:

```text
Synchronous
Asynchronous
```

---

# 44. Domain Event Rule

Domain event financial truth-এর বিকল্প নয়।

উদাহরণ:

```text
SaleCompleted
```

event notification/automation trigger করতে পারে।

কিন্তু sale-এর stock/accounting mutation event handler-এর ওপর নির্ভর করবে না যদি তা মূল transaction-এর অংশ হয়।

---

# 45. Background Jobs

সব কাজ HTTP request-এর ভিতরে করা হবে না।

Background jobs:

```text
Email
Notification
Report generation
Large export
OCR
AI processing
Sync cleanup
Scheduled reminders
```

---

# 46. Queue

প্রয়োজন হলে Redis-backed queue ব্যবহার করা হবে।

Candidate:

> BullMQ-compatible queue

Initial MVP-তে queue infrastructure minimal রাখা হবে।

যে কাজ synchronous না হলেও চলে, সেগুলো queue-তে যাবে।

---

# 47. Redis

Redis optional infrastructure service:

```text
Queue
Rate limiting
Short-lived cache
Distributed locks where justified
```

Redis authoritative business database নয়।

---

# 48. Caching

Caching strategy:

```text
Browser Cache
+
TanStack Query Cache
+
Server Cache where justified
+
Redis where required
```

Financial truth cache-এ authoritative source হিসেবে থাকবে না।

---

# 49. Offline Storage

Browser-side:

> IndexedDB + Dexie

Stores:

```text
entities/cache
drafts
pendingOperations
syncState
deviceState
```

---

# 50. Offline Queue Model

প্রতিটি operation:

```text
operationId
tenantId
userId
deviceId
entityType
entityId
operationType
payload
createdAt
status
attemptCount
lastError
```

ধারণ করবে।

---

# 51. Sync Flow

```text
User Action
 ↓
Local Validation
 ↓
IndexedDB
 ↓
UI Update
 ↓
Pending Queue
 ↓
Network Available
 ↓
Sync Request
 ↓
Server Authentication
 ↓
Tenant/Permission Check
 ↓
Idempotency Check
 ↓
Business Validation
 ↓
DB Transaction
 ↓
Acknowledgement
 ↓
Local Mark Synced
```

---

# 52. Sync Status

UI-তে:

```text
Saved
Pending Sync
Syncing
Synced
Failed
Needs Attention
```

দেখানো হবে।

---

# 53. Conflict Resolution

Conflict strategy entity-specific হবে।

Possible:

```text
Server Wins
Client Wins
Merge
Reject
User Review
```

Financial transaction-এর ক্ষেত্রে silent merge করা যাবে না।

---

# 54. Offline Financial Rule

Offline POS sale সম্ভব হলে server reconciliation-এর জন্য robust transaction identity থাকতে হবে।

Offline client কখনো:

```text
final accounting authority
```

হবে না।

Server reconciliation authoritative।

---

# 55. PWA Architecture

Requirements:

```text
Installable
Responsive
Offline shell
Cached static assets
Service worker
IndexedDB
Sync UI
```

PWA business logic service worker-এর মধ্যে duplicate করা হবে না।

---

# 56. File Storage

Business files:

```text
Invoices
Attachments
Product Images
Warranty Documents
Project Files
Customer Documents
```

S3-compatible object storage-এ রাখা হবে।

Database-এ:

```text
object key
metadata
tenantId
entity reference
```

থাকবে।

---

# 57. Object Storage Isolation

Path strategy:

```text
tenant/{tenantId}/...
```

ব্যবহার করা হবে।

Dedicated tenant হলে চাইলে separate bucket/storage namespace দেওয়া যাবে।

---

# 58. Image Handling

Product/customer/project images:

```text
Upload
 ↓
Validation
 ↓
Resize/Optimize
 ↓
Object Storage
 ↓
Metadata
```

Large binary database-এ রাখা হবে না।

---

# 59. Search Architecture

MVP:

> PostgreSQL search

Search targets:

```text
Customer
Supplier
Item
Invoice
Sale
Purchase
Serial
Booking
Service
Project
```

Large scale হলে dedicated search engine future option।

---

# 60. Internationalization

Architecture future-ready:

```text
i18n
locale
timezone
currency
number format
date format
```

প্রাথমিক product language:

```text
Bangla
English
```

দুই language-এর content strategy design করা হবে।

---

# 61. Date/Time

Database timestamps UTC-তে রাখা হবে।

Tenant/user timezone presentation layer-এ apply হবে।

Business date এবং timestamp আলাদা concept যেখানে প্রয়োজন।

---

# 62. Money Representation

Money floating-point দিয়ে authoritative financial calculation করা যাবে না।

Recommended:

```text
integer minor units
```

অথবা PostgreSQL `numeric` strategy।

Final implementation একটি single convention follow করবে।

---

# 63. Quantity Representation

Quantity-তে decimal support থাকতে পারে।

উদাহরণ:

```text
1
2
0.5
1.25
```

Unit configuration অনুযায়ী precision নির্ধারিত হবে।

---

# 64. Decimal Safety

JavaScript floating-point result সরাসরি accounting calculation-এ ব্যবহার করা যাবে না।

Money/quantity calculation-এর জন্য:

```text
Decimal-safe arithmetic
```

ব্যবহার করা হবে।

---

# 65. Database Migration

Schema migration:

```text
Versioned migrations
```

হবে।

Rules:

```text
No manual production schema edit
No destructive migration without plan
Backward compatibility where required
Data migration separately reviewed
```

---

# 66. Seed Data

Seed:

```text
Permissions
Preset Roles
System Categories where applicable
Default Units
Default Accounts
Business Templates
```

Tenant-specific seed onboarding-এর সময় হবে।

---

# 67. Environment Strategy

```text
Development
Test
Staging
Production
```

Environment secrets codebase-এ commit করা যাবে না।

---

# 68. Environment Variables

Examples:

```text
DATABASE_URL
AUTH_SECRET
OBJECT_STORAGE_ENDPOINT
OBJECT_STORAGE_KEY
OBJECT_STORAGE_SECRET
REDIS_URL
N8N_WEBHOOK_BASE
SENTRY_DSN
```

Secret manager/environment configuration ব্যবহার করতে হবে।

---

# 69. Local Development

Recommended:

```text
Node.js
pnpm
Docker
PostgreSQL
Redis optional
```

Developer machine-এ production-like database service Docker দিয়ে চালানো যাবে।

---

# 70. Containerization

Application Docker image:

```text
Next.js App
```

আলাদা infrastructure containers:

```text
PostgreSQL
Redis
```

প্রয়োজনে development environment-এ।

---

# 71. Reverse Proxy

Production:

```text
Internet
 ↓
Caddy/Nginx
 ↓
Application
```

Responsibilities:

```text
TLS
Domain routing
Compression
Basic security headers
Proxy
```

---

# 72. Deployment Strategy

প্রথম commercial deployment:

```text
VPS
+
Docker
+
Managed/regular PostgreSQL
+
Object Storage
```

Target হলো low-cost deployment।

Kubernetes প্রথম version-এ প্রয়োজন নেই।

---

# 73. Scale Strategy

Phase 1:

```text
1 App
1 PostgreSQL
1 Object Storage
```

Phase 2:

```text
App replicas
Managed PostgreSQL
Redis
Worker
```

Phase 3:

```text
Dedicated tenants
Read replicas where justified
Separate workers
Service extraction where justified
```

---

# 74. Microservices Policy

Microservice তখনই হবে যখন:

```text
Clear scaling boundary
+
Operational reason
+
Independent deployment need
+
Measured bottleneck
```

শুধু “বড় project” বলে microservice নেওয়া হবে না।

---

# 75. Observability

Minimum:

```text
Structured logs
Request ID
Error tracking
Health endpoint
Database health
Queue health
Sync failure metrics
```

Tenant ID logs-এ structured field হিসেবে থাকতে পারে, তবে sensitive data log করা যাবে না।

---

# 76. Health Checks

Endpoints:

```text
/health
/ready
```

Concept:

```text
health = process alive
ready = dependencies usable
```

---

# 77. Rate Limiting

Rate limiting apply হবে:

```text
Login
Password reset
Public endpoints
AI endpoints
File upload
Webhook endpoints
High-cost reports
```

Tenant-aware rate limit future capability।

---

# 78. Webhooks

Outbound webhooks:

```text
Sale Completed
Payment Received
Booking Confirmed
Service Completed
```

Webhook delivery:

```text
Event
 ↓
Queue
 ↓
HTTP POST
 ↓
Retry
 ↓
Dead Letter
```

Signature verification থাকবে।

---

# 79. n8n Integration

n8n application-এর domain logic হবে না।

n8n থাকবে:

```text
Automation / Integration Layer
```

উদাহরণ:

```text
ERP Event
 ↓
Webhook
 ↓
n8n
 ↓
Telegram / Email / Google Sheets / CRM
```

ERP-এর authoritative transaction n8n-এর ওপর নির্ভর করবে না।

---

# 80. AI Integration

AI provider abstraction থাকবে।

```text
AI Service
   ↓
Provider Adapter
   ├── Provider A
   ├── Provider B
   └── Local/Future
```

Business logic সরাসরি কোনো single AI vendor-এর SDK-এর সঙ্গে tightly coupled হবে না।

---

# 81. AI Tool Architecture

AI tools:

```text
getSalesSummary
getStockStatus
getCustomerDue
getSupplierDue
getUpcomingBookings
searchCustomers
searchItems
```

Mutation:

```text
draft...
preview...
confirm...
```

pattern follow করবে।

---

# 82. AI Data Security

AI request-এ tenant boundary বাধ্যতামূলক।

AI model-কে:

```text
Tenant A data
```

থেকে:

```text
Tenant B data
```

কোনো পরিস্থিতিতে context হিসেবে দেওয়া যাবে না।

---

# 83. Frontend Folder Architecture

Recommended:

```text
src/
├── app/
├── components/
│   ├── ui/
│   ├── layout/
│   └── business/
├── modules/
│   ├── sales/
│   ├── purchase/
│   ├── inventory/
│   ├── accounting/
│   ├── service/
│   ├── rental/
│   └── project/
├── features/
├── hooks/
├── lib/
├── stores/
├── offline/
└── types/
```

---

# 84. Backend Folder Architecture

Recommended conceptual structure:

```text
src/
├── modules/
│   ├── tenant/
│   ├── identity/
│   ├── customer/
│   ├── supplier/
│   ├── catalog/
│   ├── sales/
│   ├── purchase/
│   ├── inventory/
│   ├── payments/
│   ├── accounting/
│   ├── audit/
│   ├── quotation/
│   ├── booking/
│   ├── service/
│   ├── rental/
│   └── project/
├── application/
├── domain/
├── infrastructure/
├── db/
├── api/
└── shared/
```

Final repository structure implementation phase-এ আরও precise হবে।

---

# 85. Module Internal Structure

প্রতিটি mature module:

```text
sales/
├── domain/
├── application/
├── infrastructure/
├── api/
├── schemas/
├── tests/
└── index.ts
```

ব্যবহার করতে পারে।

---

# 86. Shared Code Rule

Shared utility-তে business logic ঢুকিয়ে “god utility” বানানো যাবে না।

ভুল:

```text
utils/business.ts
```

সঠিক:

```text
sales/domain/...
inventory/domain/...
accounting/domain/...
```

Cross-domain shared primitives:

```text
Money
Quantity
DateRange
Result
Error
ID
```

হতে পারে।

---

# 87. API-to-Domain Rule

API route:

```text
Parse
Authenticate
Authorize
Call Use Case
Serialize
```

করবে।

API route নিজে:

```text
stock calculation
accounting posting
```

করবে না।

---

# 88. UI-to-Domain Rule

UI:

```text
Form
 ↓
Action
 ↓
API
```

ব্যবহার করবে।

UI component-এ critical business calculation রাখা যাবে না।

---

# 89. Accounting Isolation

Accounting module অন্য module-এর internal database table directly manipulate করবে না।

উদাহরণ:

```text
Sales
 ↓
Accounting Service
```

ব্যবহার করবে।

---

# 90. Inventory Isolation

Sales inventory table directly update করবে না।

বরং:

```text
Sales
 ↓
Inventory Application Service
```

ব্যবহার করবে।

---

# 91. Cross-Module Transactions

Cross-module transaction application service orchestration করবে।

উদাহরণ:

```text
CompleteSaleUseCase
 ├── Sales Domain
 ├── Inventory Service
 ├── Payment Service
 ├── Accounting Service
 └── Audit Service
```

একটি transaction boundary-এর ভিতরে।

---

# 92. Concurrency

Critical operations optimistic concurrency বা row-level locking ব্যবহার করবে যেখানে প্রয়োজন।

Examples:

```text
Stock decrement
Invoice sequence
Payment allocation
Booking availability
```

---

# 93. Booking Concurrency

একই resource double-booking ঠেকাতে:

```text
availability check
+
transaction
+
database constraint/locking strategy
```

ব্যবহার করতে হবে।

শুধু frontend availability check যথেষ্ট নয়।

---

# 94. Inventory Concurrency

দুই cashier একই stock বিক্রি করলে:

```text
Client A
Client B
   ↓
Server
   ↓
Atomic stock validation
   ↓
One succeeds
One receives insufficient/stale result
```

হতে হবে।

---

# 95. Sequence Generation

Invoice/Sale number:

```text
database-controlled
```

হবে।

Client-side generated human-readable number authoritative হবে না।

Offline mode-এ temporary local number থাকতে পারে:

```text
LOCAL-...
```

Server sync-এর পরে canonical number assign করবে।

---

# 96. Draft Architecture

Draft business data:

```text
Local Draft
+
Server Draft
```

দুই স্তরে থাকতে পারে।

Completed transaction-এর সঙ্গে draft-এর semantics আলাদা।

---

# 97. Soft Delete

Reference-sensitive entities-এ hard delete সীমিত।

Examples:

```text
Customer
Supplier
Item
Account
```

Inactive/archive state ব্যবহার করা হবে।

Transaction records সাধারণত delete নয়; reversal/cancellation।

---

# 98. Data Retention

Tenant deletion:

```text
Request
 ↓
Verification
 ↓
Export
 ↓
Grace Period
 ↓
Deletion
```

হবে।

Immediate destructive deletion default হবে না।

---

# 99. Backup Architecture

Minimum:

```text
Daily backup
+
Retention policy
+
Offsite copy
+
Restore testing
```

Backup সফল হয়েছে মানেই recovery নিশ্চিত নয়।

Restore drill periodically করতে হবে।

---

# 100. Disaster Recovery

Targets:

```text
RPO
RTO
```

প্রতিটি deployment tier অনুযায়ী নির্ধারিত হবে।

Enterprise dedicated tier-এর RPO/RTO stronger হতে পারে।

---

# 101. Security Headers

Production application-এ:

```text
HSTS
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
Frame protection
```

যেখানে applicable, enforce করা হবে।

---

# 102. Input Security

সব external input:

```text
Validate
Normalize
Authorize
```

হবে।

SQL injection প্রতিরোধে parameterized queries/ORM।

XSS প্রতিরোধে output escaping এবং controlled HTML rendering।

---

# 103. File Upload Security

File upload:

```text
Type validation
Size limit
Filename normalization
Malware scanning where required
Tenant authorization
Private storage
Signed URL
```

support করবে।

---

# 104. API Versioning

প্রথম version:

```text
/api/...
```

ব্যবহার করা যেতে পারে।

Breaking API change হলে:

```text
/api/v2/...
```

strategy নেওয়া হবে।

---

# 105. Documentation as Code

Technical contracts repository-তে থাকবে:

```text
docs/
architecture/
adr/
api/
domain/
modules/
```

Implementation change হলে documentation update হবে।

---

# 106. Architecture Decision Records

**Scope clarification (NEW — Phase 0.5 Reconciliation):** the ADR
mechanism below (ADR-001–ADR-010) is scoped exclusively to **technology
stack decisions** (language, framework, database, ORM, deployment
topology). Architecture-level and business-level decisions made in
later documents (`07`–`29`) use the document-local `Decision
<PREFIX>-###` pattern instead (e.g. `DOM-006`, `TEN-001`, `SYNC-002`) —
this is the platform's actual, working traceability mechanism (see `29`
§2 point 3) and is not a deviation requiring correction. No further ADRs
beyond ADR-010 are anticipated unless a *technology stack* decision
itself changes (per §170's Architecture Freeze Rule).

Important decisions:

```text
ADR-001 TypeScript
ADR-002 Next.js
ADR-003 PostgreSQL
ADR-004 Drizzle
ADR-005 Modular Monolith
ADR-006 Shared + Dedicated
ADR-007 IndexedDB/Dexie
ADR-008 REST
ADR-009 n8n as integration layer
ADR-010 AI provider abstraction
```

প্রতিটি ADR-এ:

```text
Context
Decision
Alternatives
Consequences
Status
```

থাকবে।

---

# 107. ADR-001 — TypeScript

**Decision:** TypeScript everywhere practical.

**Reason:**

```text
Type safety
Full-stack consistency
Developer productivity
AI coding support
```

**Alternative:** Separate JavaScript/Python backend.

**Rejected for MVP:** অতিরিক্ত language/runtime complexity।

---

# 108. ADR-002 — Next.js

**Decision:** Next.js primary web application framework।

**Reason:**

```text
React ecosystem
Full-stack capability
PWA compatibility
Good deployment options
```

---

# 109. ADR-003 — PostgreSQL

**Decision:** PostgreSQL primary database।

**Reason:**

```text
ACID
Relational integrity
Accounting
Inventory
RLS
Mature ecosystem
```

---

# 110. ADR-004 — Drizzle

**Decision:** Drizzle ORM।

**Reason:**

```text
Explicit schema
TypeScript
SQL control
Light abstraction
```

---

# 111. ADR-005 — Modular Monolith

**Decision:** Start modular monolith.

**Reason:**

```text
Low complexity
Low cost
Atomic transactions
Easy development
Future extraction possible
```

---

# 112. ADR-006 — Shared + Dedicated

**Decision:** Same application/domain code support both.

**Reason:**

```text
SaaS scalability
Enterprise isolation
Commercial flexibility
```

---

# 113. ADR-007 — IndexedDB + Dexie

**Decision:** Browser offline persistence.

**Reason:**

```text
PWA
Offline transactions
Structured local data
```

---

# 114. ADR-008 — REST

**Decision:** REST/HTTP application API initially।

**Reason:**

```text
Simple
Debuggable
Tool-friendly
AI-friendly
Browser-friendly
```

GraphQL প্রথম version-এ প্রয়োজন নেই।

---

# 115. ADR-009 — n8n

**Decision:** n8n external automation layer।

**Reason:**

```text
Telegram
Email
Google ecosystem
Webhooks
Third-party integrations
```

ERP domain logic n8n-এর ভিতরে যাবে না।

---

# 116. ADR-010 — AI Provider Abstraction

**Decision:** AI provider adapter.

**Reason:**

```text
Vendor flexibility
Cost optimization
Model evolution
Testing
```

---

# 117. Cost Philosophy

Platform-এর initial operating cost low রাখতে:

```text
Open-source first
Managed services only where value is clear
Single VPS where practical
PostgreSQL
Docker
n8n
Object storage
```

ব্যবহার করা হবে।

---

# 118. What We Will Not Use Initially

MVP-তে avoid:

```text
Kubernetes
Microservices
Kafka
Elasticsearch
GraphQL
Multiple databases per small tenant
Complex event sourcing
CQRS infrastructure
Service mesh
```

এসব future scale-এর জন্য architecture-এ compatible থাকতে পারে, কিন্তু initial complexity বাড়াবে না।

---

# 119. Event Sourcing Decision

Full event sourcing MVP-তে নেওয়া হবে না।

কারণ:

```text
Accounting ledger
+
Inventory movement
+
Audit log
```

প্রয়োজনীয় traceability দিতে পারবে।

যেখানে event history প্রয়োজন, domain events/audit ব্যবহার করা হবে।

---

# 120. CQRS Decision

Strict CQRS নয়।

Pragmatic separation:

```text
Command Use Cases
+
Query Services
```

থাকবে।

Read model optimization future-এ করা যাবে।

---

# 121. Reporting Strategy

Operational reports PostgreSQL query দিয়ে শুরু হবে।

Heavy analytics future-এ:

```text
Read Model
Materialized View
Analytics DB
```

হতে পারে।

---

# 122. Testing Stack

Recommended:

```text
Vitest
Testing Library
Playwright
```

Database integration test:

```text
Real PostgreSQL test environment
```

ব্যবহার করা উচিত; শুধু mocks-এর ওপর নির্ভর করা যাবে না।

---

# 123. Test Pyramid

```text
        E2E
       /   \
   Integration
     /       \
    Domain/Unit
```

Financial/inventory logic-এর domain test বেশি হবে।

---

# 124. CI Pipeline

Pull request:

```text
Install
 ↓
Lint
 ↓
Typecheck
 ↓
Unit Tests
 ↓
Integration Tests
 ↓
Build
 ↓
E2E critical path
```

pass না করলে merge নয়।

---

# 125. Linting / Formatting

Recommended:

```text
ESLint
Prettier
TypeScript strict mode
```

Strict typing gradually নয়, project শুরু থেকেই strong করা হবে।

---

# 126. Git Strategy

Recommended:

```text
main
feature/*
fix/*
chore/*
```

Small focused commits।

Commit:

```text
feat:
fix:
refactor:
docs:
test:
chore:
```

---

# 127. AI-Assisted Development

User vibe coding ব্যবহার করবেন—তাই repository-তে AI-readable documentation রাখা হবে।

AI context package:

```text
AGENTS.md / AI_RULES.md
docs/
architecture/
domain/
```

প্রতিটি module-এর:

```text
README
Business Rules
API
Data Model
Tests
```

থাকবে।

---

# 128. AI Coding Guardrails

AIকে code লিখতে দেওয়ার আগে prompt-এ:

```text
Goal
Affected Module
Relevant Requirements
Constraints
Files allowed to change
Acceptance Criteria
```

দেওয়া হবে।

AI:

```text
Unrelated refactor করবে না
Schema silently change করবে না
Business rule invent করবে না
Security bypass করবে না
```

---

# 129. Recommended Repository

Final monorepo:

```text
erp-platform/
├── apps/
│   ├── web/
│   ├── worker/
│   └── admin/
│
├── packages/
│   ├── ui/
│   ├── config/
│   ├── validation/
│   ├── domain/
│   └── shared/
│
├── db/
├── docs/
├── scripts/
├── tests/
├── docker/
└── package.json
```

MVP-তে `admin` এবং `worker` প্রয়োজন অনুযায়ী একই app থেকে শুরু করতে পারে।

---

# 130. Monorepo Tooling

প্রথম version:

```text
pnpm workspaces
```

ব্যবহার করা হবে।

Turborepo future build optimization-এর জন্য যোগ করা যেতে পারে, কিন্তু প্রথম দিন থেকেই প্রয়োজনীয় নয়।

---

# 131. Web App Structure

```text
apps/web/
├── app/
├── components/
├── modules/
├── lib/
├── stores/
├── offline/
├── public/
└── tests/
```

---

# 132. Database Package

```text
db/
├── schema/
├── migrations/
├── seeds/
├── client/
└── scripts/
```

Tenant routing database infrastructure layer-এ থাকবে।

---

# 133. Module Dependency Rule

Allowed:

```text
Sales → Inventory
Sales → Payment
Sales → Accounting
```

Not allowed:

```text
UI → Database
UI → Accounting Tables
Pharmacy → Core Internal Implementation
```

Industry extension Core public application/domain interfaces ব্যবহার করবে।

---

# 134. Dependency Direction

```text
Presentation
     ↓
Application
     ↓
Domain
     ↑
Infrastructure implements interfaces
```

Domain infrastructure-এর ওপর depend করবে না।

---

# 135. Circular Dependency Rule

Domain modules-এর circular dependency এড়াতে হবে।

প্রয়োজনে:

```text
Application orchestration
+
Domain event
```

ব্যবহার করা হবে।

---

# 136. API Documentation

OpenAPI-compatible contract future-ready থাকবে।

প্রতিটি public API:

```text
Request
Response
Auth
Permission
Errors
Examples
```

document করবে।

---

# 137. Database Naming

Convention:

```text
snake_case
```

উদাহরণ:

```text
tenant_id
created_at
updated_at
deleted_at
```

TypeScript side:

```text
tenantId
createdAt
```

mapping ORM handle করবে।

---

# 138. ID Strategy

Distributed/offline-friendly ID:

```text
UUID/UUIDv7-compatible
```

ব্যবহার করা হবে।

Human-readable business number আলাদা:

```text
INV-2026-00001
```

---

# 139. Timestamp Strategy

Common fields:

```text
created_at
updated_at
```

Transaction-specific:

```text
occurred_at
completed_at
cancelled_at
```

প্রয়োজন অনুযায়ী।

---

# 140. Tenant Scoped Base Fields

Common:

```text
id
tenant_id
created_at
updated_at
created_by
updated_by
```

সব entity-তে একই fields blindly যোগ করা হবে না; domain অনুযায়ী প্রয়োজনীয় fields থাকবে।

---

# 141. Soft Delete Convention

যেখানে applicable:

```text
deleted_at
```

কিন্তু financial transactions-এ delete নয়।

---

# 142. Audit vs History

Audit log এবং domain history এক জিনিস নয়।

```text
Audit
= কে কী পরিবর্তন করেছে

History
= business entity-এর lifecycle
```

দুটো প্রয়োজন হলে আলাদাভাবে থাকবে।

---

# 143. Database Transaction API

Application layer transaction context ব্যবহার করবে:

```text
withTransaction(async tx => {
   ...
})
```

ধরনের abstraction।

Repository সবসময় একই connection/transaction context ব্যবহার করবে।

---

# 144. Tenant Context API

Request context:

```text
RequestContext
├── requestId
├── userId
├── tenantId
├── membershipId
├── permissions
└── deviceId
```

থাকতে পারে।

Context server-generated/validated হবে।

---

# 145. Device Identity

Offline support-এর জন্য browser/device registration:

```text
deviceId
tenantId
userId
lastSeen
```

ব্যবহার করা হবে।

Device ID authentication replacement নয়।

---

# 146. Sync API

Concept:

```text
POST /api/sync/push
GET  /api/sync/pull
```

অথবা equivalent endpoint structure।

Push:

```text
operations[]
```

Pull:

```text
changes[]
cursor
```

return করবে।

---

# 147. Sync Cursor

Large dataset sync-এর জন্য:

```text
cursor
sequence
timestamp
```

এর মধ্যে একটি robust strategy ব্যবহার করা হবে।

Timestamp-only cursor ব্যবহার করলে same-timestamp collision বিবেচনা করতে হবে।

---

# 148. Change Feed

Future sync architecture-এর জন্য server-side change sequence রাখা যেতে পারে:

```text
change_sequence
```

এতে client:

```text
lastSequence
```

থেকে incremental changes নিতে পারবে।

---

# 149. Data Conflict Policy

Financial transactions:

```text
No automatic overwrite
```

Master data:

```text
Version check
```

Drafts:

```text
Merge/user review
```

Strategy entity অনুযায়ী।

---

# 150. Security Boundary Summary

```text
Browser
  ↓
TLS
  ↓
Authentication
  ↓
Tenant Resolver
  ↓
Authorization
  ↓
Application Service
  ↓
Domain Validation
  ↓
Database Transaction
  ↓
Audit
```

এই chain critical operations-এর standard।

---

# 151. Performance Baseline

MVP target:

```text
Common API response: fast interactive response
POS interaction: near-instant local feedback
Dashboard: acceptable load time with optimized queries
```

Exact SLA later workload measurement-এর ভিত্তিতে নির্ধারিত হবে।

Premature optimization করা হবে না।

---

# 152. Database Indexing

High-frequency indexes:

```text
tenant_id
tenant_id + created_at
tenant_id + status
tenant_id + customer_id
tenant_id + item_id
tenant_id + invoice_number
tenant_id + serial_number
```

Query-driven indexing হবে।

---

# 153. N+1 Prevention

ORM query design:

```text
select
join
batch loading
```

সঠিকভাবে ব্যবহার করতে হবে।

Loop-এর ভিতরে database query করা যাবে না যেখানে batch query সম্ভব।

---

# 154. Pagination

Large collections:

```text
cursor pagination
```

prefer করা হবে।

Simple admin lists-এ offset pagination acceptable।

---

# 155. API Filtering

Common filters:

```text
date
status
customer
supplier
branch
warehouse
category
search
```

Query validation বাধ্যতামূলক।

---

# 156. Import Processing

Large import synchronous request-এ করা হবে না।

```text
Upload
 ↓
Create Import Job
 ↓
Background Worker
 ↓
Validate
 ↓
Preview Errors
 ↓
Commit
```

---

# 157. Export Processing

Large export:

```text
Request
 ↓
Job
 ↓
Generate
 ↓
Object Storage
 ↓
Signed Download
```

---

# 158. Notification Architecture

Core event:

```text
PaymentReceived
```

notification layer:

```text
In-App
Email
Telegram
```

channel-specific adapter ব্যবহার করবে।

---

# 159. External Integration Boundary

Third-party integrations:

```text
Google
Telegram
WhatsApp
Email
Payment Gateway
n8n
AI
```

adapter layer-এর মাধ্যমে যুক্ত হবে।

Core domain third-party API details জানবে না।

---

# 160. Payment Gateway Future

Payment gateway integration future module।

Architecture:

```text
Payment Service
 ↓
Gateway Adapter
 ├── Gateway A
 ├── Gateway B
 └── Gateway C
```

---

# 161. Email

Transactional email:

```text
Invoice
Payment Receipt
Password Reset
Notification
```

provider abstraction-এর মাধ্যমে।

---

# 162. Telegram

Telegram external notification/integration।

ERP business transaction Telegram-এর success response-এর ওপর নির্ভর করবে না।

---

# 163. Google Integration

Future:

```text
Google Sheets
Google Drive
Google Calendar
Gmail
```

n8n বা dedicated adapter দিয়ে।

---

# 164. Tenant Customization

Tenant can configure:

```text
Logo
Business Name
Invoice Header
Receipt Footer
Currency
Timezone
Numbering
Modules
Roles
Payment Methods
```

Code fork করা যাবে না।

---

# 165. Theme

Tenant branding:

```text
Logo
Primary color
Invoice style
```

design system-এর সীমার মধ্যে।

Arbitrary CSS injection allow করা হবে না।

---

# 166. Feature Flags

Feature flag scopes:

```text
Platform
Plan
Tenant
User
```

Financial/business feature flag change audit হবে।

---

# 167. Release Strategy

```text
Development
 ↓
Staging
 ↓
Pilot Tenants
 ↓
Production
```

New financial features প্রথমে controlled pilot।

---

# 168. Backward Compatibility

API/schema changes:

```text
Additive first
```

হওয়া উচিত।

Breaking change হলে:

```text
Migration
Compatibility window
Version
```

দরকার।

---

# 169. Rollback

Application deployment rollback সম্ভব হতে হবে।

Database migration rollback সবসময় automatic হবে না।

Data migration-এর আগে:

```text
Backup
Validation
Recovery plan
```

থাকতে হবে।

---

# 170. Architecture Freeze Rule

এই document-এর stack freeze-এর পরে technology change করতে হলে ADR লাগবে।

উদাহরণ:

```text
Next.js → অন্য framework
PostgreSQL → অন্য DB
Drizzle → অন্য ORM
```

সরাসরি করা যাবে না।

---

# 171. Technology Decision Table

| Area | Decision | Status |
|---|---|---|
| Language | TypeScript | Selected |
| Web | Next.js | Selected |
| UI | React | Selected |
| CSS | Tailwind | Selected |
| Components | shadcn/ui | Selected |
| Client State | Zustand | Selected |
| Server State | TanStack Query | Selected |
| Forms | React Hook Form | Selected |
| Validation | Zod | Selected |
| DB | PostgreSQL | Selected |
| ORM | Drizzle | Selected |
| Offline | IndexedDB + Dexie | Selected |
| API | REST/HTTP | Selected |
| Queue | Redis/BullMQ-compatible | Future/Conditional |
| Storage | S3-compatible | Selected |
| Automation | n8n | Selected |
| Testing | Vitest + Playwright | Selected |
| Containers | Docker | Selected |
| Proxy | Caddy/Nginx | Selected |
| Orchestration | Kubernetes | Not initially |
| Microservices | No | Not initially |
| GraphQL | No | Not initially |
| Search | PostgreSQL | Initial |
| AI | Provider abstraction | Selected |

---

# 172. Standard Development Procedure

প্রতিটি feature:

```text
1. Requirement
2. Domain analysis
3. Architecture impact
4. Data model
5. API/use case
6. UX flow
7. Permission
8. Audit
9. Offline behavior
10. Implementation
11. Unit tests
12. Integration tests
13. E2E
14. Review
15. Documentation
16. Release
```

এই sequence project-wide standard হবে।

---

# 173. Questions That Do NOT Need User Decision Yet

নিম্নোক্ত বিষয়গুলো implementation phase-এ standard engineering decision হিসেবে নেওয়া যাবে:

```text
Exact PostgreSQL hosting
Exact VPS provider
Exact object storage vendor
Exact monitoring vendor
Exact email provider
Exact AI model
Exact Redis provider
```

এগুলো architecture বদলায় না।

---

# 174. Decisions That WILL Require Explicit Product Approval Later

এই বিষয়গুলো business/product decision হিসেবে user approval চাইবে:

```text
Subscription pricing
Free plan limits
Paid module strategy
Tenant suspension policy
Data retention period
Enterprise SLA
Exact accounting rules for target jurisdiction
Tax/VAT compliance scope
Payment gateway choices
User invitation policy
```

---

# 175. Architecture Questions Deferred

এই document ইচ্ছাকৃতভাবে নিচের বিষয়গুলো পরবর্তী documents-এ বিস্তারিত করবে:

```text
05_MULTI_TENANT_ARCHITECTURE.md
06_DATABASE_SPECIFICATION.md
07_CORE_DOMAIN_SPECIFICATION.md
08_ACCOUNTING_ENGINE_SPECIFICATION.md
09_INVENTORY_ENGINE_SPECIFICATION.md
10_OFFLINE_SYNC_SPECIFICATION.md
11_API_SPECIFICATION.md
12_UX_SPECIFICATION.md
13_SECURITY_SPECIFICATION.md
```

---

# 176. Final Architecture

```text
                           INTERNET
                              │
                           TLS/Proxy
                              │
                       Next.js Application
                              │
              ┌───────────────┼────────────────┐
              │               │                │
          Presentation    Application       API
              │               │                │
              └───────────────┼────────────────┘
                              │
                         Domain Layer
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
       Core                Modules              Industry
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                       Repository Layer
                              │
                     Database Abstraction
                         /             \
                        /               \
                 Shared PostgreSQL   Dedicated PostgreSQL
                        │
                   Object Storage
                        │
                    Redis/Queue
                        │
                       n8n
                        │
                  External Services
```

---

# 177. Final Architecture Principle

> **Keep the system monolithic at deployment level, modular at domain level, relational at data level, offline-capable at client level, and tenant-aware at every business boundary.**

এটাই MVP থেকে commercial SaaS পর্যন্ত সবচেয়ে balanced architecture।

---

# 178. Architecture Status

```text
Language                 ✓
Frontend                 ✓
Backend                  ✓
UI                       ✓
Database                 ✓
ORM                      ✓
API                      ✓
Authentication           ✓
Authorization            ✓
Shared Tenant            ✓
Dedicated Tenant         ✓
Offline                  ✓
Sync                     ✓
Accounting Boundary      ✓
Inventory Boundary       ✓
AI Boundary              ✓
Automation Boundary      ✓
Storage                  ✓
Deployment               ✓
Testing                  ✓
CI/CD Direction          ✓
AI Coding Protocol       ✓
```

---

# 179. Next Document

পরবর্তী document:

`05_MULTI_TENANT_ARCHITECTURE.md`

এখানে shared এবং dedicated tenant-এর technical implementation আরও গভীরে নির্ধারণ করা হবে:

```text
Tenant Resolver
Membership
RLS
Database Router
Connection Pool
Shared Schema
Dedicated Schema
Tenant Provisioning
Tenant Migration
Backup
Isolation Testing
Tenant Suspension
Tenant Deletion
Control Plane
Business Plane
```

এর পরে `06_DATABASE_SPECIFICATION.md`-তে canonical schema design শুরু হবে।

