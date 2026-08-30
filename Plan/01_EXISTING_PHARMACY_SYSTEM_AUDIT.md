Master Project Documentation

আমি পুরো documentation set-কে এমনভাবে সাজাব:

BUSINESS-ERP-PLATFORM/
│
├── 00_MASTER/
│   ├── MASTER_PROJECT_SPECIFICATION.md
│   ├── PROJECT_VISION.md
│   ├── PRODUCT_SCOPE.md
│   ├── BUSINESS_MODEL.md
│   ├── ROADMAP.md
│   └── DECISION_LOG.md
│
├── 01_BUSINESS/
│   ├── BUSINESS_MODEL.md
│   ├── BUSINESS_TYPES.md
│   ├── BUSINESS_PROCESSES.md
│   ├── UNIVERSAL_BUSINESS_RULES.md
│   └── INDUSTRY_RULES.md
│
├── 02_PLATFORM/
│   ├── PLATFORM_ARCHITECTURE.md
│   ├── MODULE_ARCHITECTURE.md
│   ├── TENANT_ARCHITECTURE.md
│   ├── SHARED_DATABASE.md
│   ├── DEDICATED_DATABASE.md
│   └── FEATURE_FLAGS.md
│
├── 03_TECH/
│   ├── TECH_STACK.md
│   ├── FRONTEND_ARCHITECTURE.md
│   ├── BACKEND_ARCHITECTURE.md
│   ├── DATABASE_ARCHITECTURE.md
│   ├── API_ARCHITECTURE.md
│   ├── SECURITY_ARCHITECTURE.md
│   ├── OFFLINE_ARCHITECTURE.md
│   └── AI_ARCHITECTURE.md
│
├── 04_CORE/
│   ├── AUTH.md
│   ├── TENANT.md
│   ├── RBAC.md
│   ├── CUSTOMER.md
│   ├── SUPPLIER.md
│   ├── ITEM_MASTER.md
│   ├── INVENTORY_ENGINE.md
│   ├── TRANSACTION_ENGINE.md
│   ├── PAYMENT_ENGINE.md
│   ├── ACCOUNTING_ENGINE.md
│   └── AUDIT_LOG.md
│
├── 05_MODULES/
│   ├── RETAIL.md
│   ├── PURCHASE.md
│   ├── SERVICE.md
│   ├── RENTAL.md
│   ├── PROJECT.md
│   ├── WARRANTY.md
│   ├── PHARMACY.md
│   └── ELECTRONICS.md
│
├── 06_DECORATOR/
│   ├── ENQUIRY.md
│   ├── QUOTATION.md
│   ├── BOOKING.md
│   ├── EVENT.md
│   ├── ASSET_RESERVATION.md
│   ├── LABOUR.md
│   └── PROJECT_PROFIT.md
│
├── 07_UX/
│   ├── UX_PRINCIPLES.md
│   ├── DESIGN_SYSTEM.md
│   ├── NAVIGATION.md
│   ├── SCREEN_SPECIFICATIONS.md
│   └── RESPONSIVE_UX.md
│
├── 08_DATABASE/
│   ├── ERD.md
│   ├── TABLE_SPECIFICATION.md
│   ├── RELATIONSHIPS.md
│   ├── INDEXING.md
│   ├── RLS.md
│   └── MIGRATIONS.md
│
├── 09_API/
│   ├── API_CONVENTIONS.md
│   ├── AUTH_API.md
│   ├── SALES_API.md
│   ├── INVENTORY_API.md
│   ├── ACCOUNTING_API.md
│   └── MODULE_APIS.md
│
├── 10_TESTING/
│   ├── TEST_STRATEGY.md
│   ├── BUSINESS_RULE_TESTS.md
│   ├── SECURITY_TESTS.md
│   ├── TENANT_ISOLATION_TESTS.md
│   └── ACCEPTANCE_TESTS.md
│
├── 11_DEPLOYMENT/
│   ├── LOCAL_DEVELOPMENT.md
│   ├── SHARED_SAAS.md
│   ├── DEDICATED_TENANT.md
│   ├── BACKUP.md
│   ├── DISASTER_RECOVERY.md
│   └── MONITORING.md
│
└── 12_IMPLEMENTATION/
    ├── DEVELOPMENT_METHODOLOGY.md
    ├── PHASES.md
    ├── TASK_BREAKDOWN.md
    ├── AI_CODING_PROTOCOL.md
    └── DEFINITION_OF_DONE.md

এটি একটি living documentation system হবে। সিদ্ধান্ত পরিবর্তন হলে সংশ্লিষ্ট document এবং DECISION_LOG.md update হবে।# 01_EXISTING_PHARMACY_SYSTEM_AUDIT.md

**Project:** Modular Multi-Tenant Business ERP SaaS  
**Document:** Existing Pharmacy Management PWA — Architecture, Business Logic & UX Audit  
**Status:** Draft / Baseline Audit  
**Purpose:** নতুন ERP platform-এর জন্য বিদ্যমান Pharmacy PWA-র reusable business logic, UX pattern, data model এবং architectural lessons নির্ধারণ করা।

---

## 1. Executive Summary

বর্তমান Pharmacy PWA একটি browser-first, modular JavaScript PWA, যেখানে application state, business modules, API/data-access layer, IndexedDB offline queue, synchronization engine, authentication/staff management এবং Firebase/Firestore-backed persistence রয়েছে।

বিদ্যমান implementation-এর সবচেয়ে মূল্যবান দিক হলো এটি শুধু CRUD interface নয়; POS, purchase, returns, inventory, customer/supplier dues, cash balance, opening entries, drafts, offline synchronization এবং AI-assisted workflows-এর বাস্তব business logic ইতিমধ্যে ধারণ করে।

নতুন Business ERP-তে এই system-কে সরাসরি copy করা হবে না। বরং প্রতিটি অংশকে তিন ভাগে classify করা হবে:

1. **Generic Core** — সব ধরনের ব্যবসায় পুনর্ব্যবহারযোগ্য।
2. **Industry Module** — Pharmacy/Electronics/Decorator ইত্যাদি নির্দিষ্ট business-এর জন্য।
3. **Legacy / Refactor Candidate** — বর্তমান implementation কাজ করলেও নতুন architecture-এ পুনর্গঠন প্রয়োজন।

---

# 2. Current System Overview

## 2.1 বর্তমান architectural layers

বর্তমান system-এর প্রধান layer:

```text
UI / PWA
   ↓
Module Layer
   ↓
APP_STATE
   ↓
API Client / Business Operations
   ↓
Firestore / Backend
```

Offline path:

```text
UI
 ↓
Business Operation
 ↓
IndexedDB Pending Write Queue
 ↓
Sync Engine
 ↓
API
 ↓
Firestore
```

AI path:

```text
UI / Business Module
 ↓
AI Service / AiProxy
 ↓
AI Provider
 ↓
Human / Application Verification
```

---

# 3. Current Application State Model

`js/state.js`-এ একটি centralized `APP_STATE` ব্যবহৃত হচ্ছে।

বর্তমান state-এর গুরুত্বপূর্ণ domain:

- current user
- admin/staff status
- tenant UID
- staff role
- subscription status
- business profile
- medicines
- customers
- suppliers
- inventory
- sales
- purchases
- expenses
- customer payments
- supplier payments
- pending offline sales/purchases/returns
- staff
- drafts
- opening entries
- feature-specific state

### Architectural observation

`tenantUid`-কে owner-এর UID অথবা staff-এর ক্ষেত্রে owner UID হিসেবে ব্যবহার করার ধারণা ইতিমধ্যেই আছে।

এটি নতুন ERP-তে সরাসরি copy না করে formal model হবে:

```text
Tenant
 ├── Users
 ├── Roles
 ├── Business Profile
 └── Business Data
```

এবং application-level `tenant context` আলাদা object হিসেবে থাকবে।

---

# 4. Navigation / UX Structure

বর্তমান navigation functional business groups অনুযায়ী সাজানো:

```text
মূল মেনু
 ├── Dashboard
 ├── POS
 └── Sales Analytics

ব্যবস্থাপনা
 ├── Medicine Master
 ├── Inventory
 ├── Purchase
 ├── Returns
 └── Opening

হিসাব
 ├── Customers
 ├── Suppliers
 └── Accounts

টিম
 └── Staff Management

প্রশাসন
 └── User Management

AI
 └── AI Settings

Settings
```

### Reusable UX principle

Sidebar-কে technical table অনুযায়ী নয়, **user workflow অনুযায়ী group করা হয়েছে**।

নতুন ERP-তে:

```text
Dashboard
Sales
Purchases
Inventory
Customers
Suppliers
Accounting
Operations
Reports
Administration
```

এর ওপর tenant-enabled modules অনুযায়ী dynamic navigation তৈরি হবে।

---

# 5. Module Audit

## 5.1 Dashboard

### Current responsibilities

- Sales summary
- Profit-related metrics
- Due customers
- Low stock
- Out of stock
- Expiry alerts
- Monthly comparison
- Quick suggestions
- Analytics-derived insights

### Reusable

**Core Dashboard/Reporting layer**

### Pharmacy-specific

- Expiry alerts for medicines
- Medicine-specific stock insight

### ERP recommendation

Dashboard engine হবে capability-based:

```text
Dashboard Metrics
 ├── Sales
 ├── Purchases
 ├── Receivables
 ├── Payables
 ├── Cash
 ├── Inventory
 ├── Profit
 └── Alerts
```

Industry module নিজের capability register করবে।

---

# 6. POS / Sales Module

Source module: `js/modules/pos.js`

### Current capabilities

- Invoice number generation
- Customer selection
- Walk-in customer
- Multi-line cart
- Medicine/item search
- Ambiguous item disambiguation
- Quantity
- Unit price
- Line discount
- Gross discount
- Total calculation
- Cash received
- Due calculation
- Sale submission
- Receipt
- Sale history
- Sale deletion
- POS drafts
- Offline sale support
- Stock deduction

### Current business flow

```text
Select Customer
      ↓
Add Items
      ↓
Resolve Item
      ↓
Set Qty / Price / Discount
      ↓
Calculate Total
      ↓
Receive Cash
      ↓
Calculate Due
      ↓
Validate
      ↓
Submit Sale
      ↓
Stock Deduction
      ↓
Customer Due Update
      ↓
Cash Update
      ↓
Receipt
```

### Reusable Core

- Sales transaction
- Sale header
- Sale lines
- Discount engine
- Payment allocation
- Receivable creation
- Receipt
- Draft cart
- Transaction validation

### Industry-specific

Pharmacy:
- Medicine search
- FEFO deduction
- Medicine-specific display

Electronics:
- Serial/IMEI selection
- Warranty attachment

Decorator:
- Service/project line items
- Rental item allocation

### New ERP recommendation

Sales engine হবে generic:

```text
Sale
 ├── Customer
 ├── Items
 ├── Pricing
 ├── Discounts
 ├── Taxes
 ├── Payments
 ├── Receivable
 └── Inventory Effects
```

Inventory allocation strategy configurable হবে:

```text
FIFO
FEFO
SERIAL
MANUAL
NON_STOCK
```

---

# 7. Purchase Module

Source: `js/modules/purchase.js`

### Current capabilities

- Supplier selection
- Multi-item purchase
- Item resolution
- Quantity
- Cost price
- Selling price/MRP-related fields
- Line discount
- Gross discount
- Payment type
- Purchase ID
- Purchase submission
- Stock/batch creation
- Purchase history
- Purchase deletion
- Draft purchase
- Invoice image scanning
- Multi-page invoice upload
- Image compression
- AI invoice extraction
- Human verification before confirmation
- AI reconciliation

### Reusable Core

```text
Purchase
Purchase Items
Supplier
Cost
Discount
Payment
Stock Receipt
Payable
Document Attachment
```

### Industry-specific

Pharmacy:
- Medicine batch
- Expiry
- Pack size/dose-form interpretation

Electronics:
- Serial/IMEI
- Model/SKU
- Warranty metadata

Decorator:
- Material purchase
- Project allocation

### Important architecture principle

AI invoice scanning must remain:

```text
Document
 ↓
AI Extraction
 ↓
Suggested Data
 ↓
Human Verification
 ↓
Actual Purchase Transaction
```

AI must not directly commit a financial transaction.

---

# 8. Inventory Module

Source: `js/modules/inventory.js`

### Current operations

- Restock
- Destock
- Destock by batch
- Destock from consumed batches
- Inventory row recalculation
- Batch view
- Batch edit
- Stock display
- Search

### Current model

Medicine/item-level inventory contains batch information and stock quantity.

### Reusable Core

Inventory must become a transaction/ledger engine:

```text
Stock Ledger
 ├── Opening
 ├── Purchase
 ├── Sale
 ├── Customer Return
 ├── Supplier Return
 ├── Adjustment
 ├── Transfer
 ├── Reservation
 └── Release
```

### Important architectural change

নতুন ERP-তে `current stock` শুধু mutable number হিসেবে authoritative হবে না।

Authoritative source হবে:

```text
Stock Movements / Inventory Ledger
```

Current balance derived/cached হতে পারে।

---

# 9. Pharmacy FEFO Logic

বর্তমান POS-এ `deductStockFEFO()` এবং API layer-এ FEFO deduction calculation আছে।

### Reusable concept

FEFO নিজে Core inventory logic নয়।

এটি হবে:

```text
Inventory Allocation Strategy
```

যেখানে:

```text
Pharmacy → FEFO
General Retail → FIFO / configured
Electronics → Serial
Rental → Reservation
```

এই separation নতুন platform-এর গুরুত্বপূর্ণ design principle।

---

# 10. Returns Module

### Current capabilities

- Customer return
- Supplier return
- Return mode
- Return document
- Stock reversal/effect
- Customer due adjustment
- Supplier payable adjustment
- Cash adjustment where applicable
- Return deletion
- Offline return support

### Reusable Core

```text
Return
 ├── Customer Return
 ├── Supplier Return
 ├── Return Items
 ├── Financial Adjustment
 └── Inventory Adjustment
```

### Critical rule

Return কখনো শুধু stock quantity কম/বাড়ানোর operation হবে না।

এর সাথে সংশ্লিষ্ট financial effect-ও থাকতে হবে।

---

# 11. Customer Module

### Current capabilities

- Customer master
- Search
- Customer history
- Due balance
- Due collection
- Customer addition/update/delete
- Offline customer creation
- Due payment records

### Reusable Core

Customer হবে central entity:

```text
Customer
 ├── Sales
 ├── Returns
 ├── Receivables
 ├── Payments
 ├── Quotations
 ├── Bookings
 ├── Service Tickets
 └── Projects
```

---

# 12. Supplier Module

### Current capabilities

- Supplier master
- Supplier CRUD
- Supplier payable
- Supplier payment
- Supplier return
- Supplier history
- Representative model preparation

### Future reusable model

```text
Supplier
 ├── Contacts
 ├── Representatives
 ├── Products
 ├── Purchases
 ├── Returns
 └── Payables
```

### Important observation

Pharmacy-specific supplier/representative relationship-এর requirement নতুন ERP-তে generic vendor-contact relationship হিসেবে পুনর্গঠন করা উচিত।

---

# 13. Accounting Module

Source: `js/modules/accounts.js` এবং API financial operations.

### Current capabilities

- Cash balance
- Expenses
- Customer payments
- Supplier payments
- Opening entries
- Income/expense-related calculations
- Balance sheet-related data retrieval
- Ledger-style display

### New ERP requirement

এখানে proper double-entry accounting architecture বিবেচনা করতে হবে:

```text
Chart of Accounts
      ↓
Journal Entries
      ↓
Ledger
      ↓
Trial Balance
      ↓
P&L
      ↓
Balance Sheet
      ↓
Cash Flow
```

### Financial integrity rule

Sales/purchase/payment/expense/return-এর মতো money-affecting operations-এর financial effects atomic transaction-এর মধ্যে তৈরি হতে হবে।

---

# 14. Opening Balance / Opening Entry

বর্তমান system-এ opening entries আছে।

### Reusable concept

প্রতিটি নতুন tenant-এর onboarding-এ:

```text
Opening Cash
Opening Bank
Opening Stock
Opening Customer Receivable
Opening Supplier Payable
Opening Capital
```

support করা উচিত।

এটি Core ERP-এর onboarding/accounting feature হবে।

---

# 15. Staff / RBAC

বর্তমান system-এ:

```text
Owner
Manager
Cashier
```

জাতীয় staff role আছে এবং invitation/status/role management রয়েছে।

### New ERP recommendation

Hard-coded roles নয়।

RBAC:

```text
Role
 ├── Permissions
 │    ├── sales.create
 │    ├── sales.delete
 │    ├── purchase.create
 │    ├── inventory.adjust
 │    ├── accounting.view
 │    └── settings.manage
```

তারপর preset roles:

```text
Owner
Manager
Cashier
Inventory Manager
Accountant
Salesperson
Technician
```

Tenant চাইলে custom role তৈরি করতে পারবে।

---

# 16. Authentication / Tenant Context

বর্তমান architecture-এ owner UID/staff UID-এর মাধ্যমে tenant context resolve করার pattern আছে।

### New model

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

একজন user ভবিষ্যতে একাধিক tenant-এর member হতে পারবে—এমন architecture রাখাই উত্তম।

---

# 17. IndexedDB Offline Storage

Source: `js/db-indexeddb.js`

### Current design

Dedicated IndexedDB database:

```text
sohojtech-sync-db
```

Pending write store:

```text
pendingWrites
```

Entry-তে গুরুত্বপূর্ণ fields:

```text
tempId
uid
type
payload
status
queuedAt
attempts
lastError
lastAttemptAt
```

### Strong existing decision

Offline queue entry-এর সঙ্গে user UID bind করা হয়েছে যাতে অন্য account-এর queue data sync না হয়।

### New ERP requirement

এটি আরও শক্তিশালী হবে:

```text
tenantId
userId
deviceId
transactionId
operationId
entityType
entityId
payload
status
createdAt
attemptCount
```

এবং idempotency key থাকবে।

---

# 18. Sync Engine

Source: `js/sync-engine.js`

### Current capabilities

- Queue processing
- Online detection
- Retry
- Failed state
- Permanently failed state
- Stuck syncing recovery
- Sync badge
- Sync panel
- Manual retry
- Discard failed write
- Apply synced state
- Type-based API mapping

### Reusable Core

নতুন ERP-তে এটি হবে:

> Offline Transaction & Synchronization Engine

### Required future improvements

- Idempotency
- Conflict resolution
- Version checking
- Server acknowledgement
- Operation dependencies
- Transaction ordering
- Device identity
- Tenant identity
- Dead-letter queue
- Sync audit

---

# 19. API Client

`js/api-client.js` বর্তমানে data-access এবং transaction operations-এর বড় অংশ ধারণ করে।

### Current responsibilities

- CRUD
- Sales
- Purchases
- Returns
- Customer payments
- Supplier payments
- Expenses
- Cash balance
- Opening entries
- Complete data loading
- Historical data loading
- Staff operations
- Offline queue helpers

### Architectural problem

বর্তমানে API client এবং domain transaction concerns আংশিকভাবে পাশাপাশি আছে।

### New architecture

```text
UI
 ↓
Application Service
 ↓
Domain Service
 ↓
Repository
 ↓
Database Adapter
```

Repository-এর নিচে database বদলালেও domain logic বদলাবে না।

---

# 20. Draft System

বর্তমানে POS এবং Purchase-এর draft state browser storage-এ রাখা হয়।

### Reusable concept

Drafts should be generic:

```text
Draft
 ├── type
 ├── tenantId
 ├── userId
 ├── title
 ├── payload
 ├── createdAt
 └── updatedAt
```

Possible types:

```text
sale
purchase
quotation
booking
service_order
project
```

---

# 21. AI Architecture

বর্তমান documentation থেকে একটি গুরুত্বপূর্ণ principle পাওয়া যায়:

> AI language/interpretation layer; application remains source of truth for business numbers.

### Existing pattern

```text
User Question
 ↓
AI Intent
 ↓
Application Capability
 ↓
Exact Data
 ↓
AI Narration
```

এটি নতুন ERP-তে preserve করতে হবে।

### AI must not own

```text
Price
Quantity
Stock
Due
Profit
Ledger
Tax
Balance
```

### AI may own

```text
Intent classification
Natural-language explanation
Draft text
Document extraction
Suggestions
Summaries
```

---

# 22. Settings / Feature Flags

বর্তমান system-এ feature flag ধারণা আছে।

নতুন ERP-তে:

```text
Tenant Settings
+
Module Settings
+
Feature Flags
+
Plan Restrictions
```

উদাহরণ:

```text
inventory.batchTracking = true
inventory.serialTracking = false
sales.barcode = true
sales.creditSale = true
rental.damageCharge = false
```

---

# 23. Current UX Patterns Worth Preserving

## 23.1 Search-first workflow

POS/Purchase-এ দ্রুত item search করা যায়।

## 23.2 Inline calculation

User input-এর সঙ্গে সঙ্গে:

```text
subtotal
discount
total
cash
due
```

update হয়।

## 23.3 Ambiguous match handling

একাধিক medicine match হলে disambiguation UI দেখানো হয়।

## 23.4 Modal-based secondary workflow

Batch edit, drafts, sync panel, invoice scanning ইত্যাদি primary navigation ভেঙে না দিয়ে modal/panel-এ করা হয়েছে।

## 23.5 Human confirmation

AI invoice scan-এর পরে:

> user verifies → transaction confirms

এই UX principle preserve করা উচিত।

## 23.6 Offline visibility

Sync badge এবং sync panel user-কে system state সম্পর্কে জানায়।

---

# 24. Current Architecture — Strengths

1. Modular JS structure.
2. Business operations আলাদা module-এ বিভক্ত।
3. Offline-first ধারণা বাস্তবে implemented.
4. Sync retry/recovery আছে।
5. Tenant-aware queue security consideration আছে।
6. POS/Purchase draft workflow আছে।
7. AI-কে money calculation থেকে দূরে রাখার principle আছে।
8. Staff management এবং role concept আছে।
9. API client abstraction আংশিকভাবে তৈরি।
10. Business workflow-oriented navigation আছে।

---

# 25. Current Architecture — Risks

## 25.1 Centralized APP_STATE

বড় SaaS-এ global mutable state scaling problem তৈরি করতে পারে।

**Recommendation:** domain state, UI state এবং server cache আলাদা করা।

## 25.2 Firebase/Firestore coupling

Domain logic-এর সঙ্গে Firestore-specific assumptions বেশি হলে database migration কঠিন হবে।

**Recommendation:** Repository abstraction।

## 25.3 Financial logic distribution

Cash/due/stock/ledger effects বিভিন্ন functions-এ ছড়িয়ে থাকলে consistency risk বাড়ে।

**Recommendation:** Domain transaction services।

## 25.4 Inventory as mutable aggregate

Current inventory row দ্রুত access-এর জন্য ভালো হলেও ledger-first model বেশি robust।

## 25.5 Hard-coded industry vocabulary

Medicine-centric naming নতুন ERP-তে সমস্যা তৈরি করবে।

**Recommendation:** `Item` Core entity; `Medicine` Pharmacy extension।

## 25.6 Hard-coded roles

RBAC permission matrix করা দরকার।

## 25.7 Offline conflict handling

Current retry mechanism ভালো foundation, কিন্তু multi-device concurrent mutation-এর জন্য formal conflict/idempotency design দরকার।

## 25.8 UI/business coupling

Global functions এবং DOM manipulation বেশি হলে testability কমে।

**Recommendation:** domain/application/UI separation।

---

# 26. Generic Core Entity Candidate List

```text
Tenant
User
Membership
Role
Permission

Branch
BusinessProfile

Customer
Supplier
SupplierContact

Item
ItemCategory
Brand
Unit

InventoryLocation
Stock
StockMovement
StockReservation

Sale
SaleItem
Payment
SalesReturn
SalesReturnItem

Purchase
PurchaseItem
PurchaseReturn
PurchaseReturnItem

Receivable
Payable

Expense
Income

Account
Journal
JournalEntry
LedgerEntry

Quotation
Booking
Project
ServiceOrder

Asset
AssetReservation
AssetMovement

Warranty
ServiceTicket

Document
Attachment
AuditLog

Notification
Automation
Webhook
```

---

# 27. Industry Extension Candidates

## Pharmacy

```text
Medicine
Generic
Strength
DosageForm
Batch
Expiry
FEFO
Prescription
```

## Electronics

```text
SerialNumber
IMEI
Model
Warranty
DeviceSpecification
Repair
```

## Decorator / Event

```text
Event
Venue
DecorationPackage
RentalAsset
Reservation
Labour
Setup
Damage
ProjectCost
```

## General Retail

```text
Barcode
SKU
Variant
PriceList
Discount
Promotion
```

## Service

```text
Service
Technician
Appointment
WorkOrder
ServicePart
ServiceCharge
```

---

# 28. Target Architecture for New ERP

```text
                     BUSINESS ERP PLATFORM
                              │
                 ┌────────────┴────────────┐
                 │                         │
              CONTROL PLANE            DATA PLANE
                 │                         │
          Tenant / Plan / RBAC        Tenant Business Data
          Feature Flags               Shared / Dedicated
                 │
                 ▼
          Tenant Resolver
                 │
                 ▼
        Application Services
                 │
                 ▼
           Domain Modules
                 │
        ┌────────┼────────┐
        │        │        │
      Core     Retail   Industry
        │        │        │
        └────────┼────────┘
                 │
             Repository
                 │
          Database Adapter
```

---

# 29. Shared vs Dedicated Database

## Shared

```text
PostgreSQL
 ├── Tenant A
 ├── Tenant B
 └── Tenant C
```

Security:

```text
tenant_id
+
RLS
+
application authorization
```

## Dedicated

```text
Tenant A → PostgreSQL A
Tenant B → PostgreSQL B
```

Application code একই থাকবে।

Database router deployment mode অনুযায়ী connection নির্বাচন করবে।

---

# 30. Target Technology Direction

বর্তমান Pharmacy PWA-এর architecture নতুন ERP-এর final stack হবে না।

প্রস্তাবিত target:

```text
Frontend
Next.js
React
TypeScript
Tailwind
shadcn/ui

Backend
Next.js server/API
Domain services

Database
PostgreSQL

ORM
Drizzle ORM

Validation
Zod

Client State
Zustand

Offline
IndexedDB + Dexie

Automation
n8n

Storage
S3-compatible object storage

Deployment
Docker + VPS

PWA
Browser-first + installable PWA
```

Final stack freeze হবে আলাদা Technical Architecture document-এ।

---

# 31. Migration Philosophy

পুরনো Pharmacy system থেকে সরাসরি database migration করা হবে না।

বরং:

```text
Old Pharmacy Data
 ↓
Export / Transform
 ↓
Canonical ERP Data Model
 ↓
Validation
 ↓
Import
 ↓
Reconciliation
```

Business logic migration:

```text
Old Logic
 ↓
Audit
 ↓
Generic Rule
 ↓
New Domain Service
```

---

# 32. Final Classification

| Current Feature | New ERP |
|---|---|
| Customer | Core |
| Supplier | Core |
| Sales | Core/Retail |
| Purchase | Core/Retail |
| Payment | Core |
| Due | Core |
| Expense | Core |
| Returns | Core |
| Inventory | Core |
| Stock Movement | Core |
| Draft | Core |
| Staff | Core |
| RBAC | Core |
| Offline Queue | Core Platform |
| Sync Engine | Core Platform |
| Cash | Accounting |
| Ledger | Accounting |
| Medicine Master | Pharmacy |
| FEFO | Pharmacy/Inventory Strategy |
| Expiry | Pharmacy |
| Generic/Strength | Pharmacy |
| Serial/IMEI | Electronics |
| Warranty | Electronics/Core Service |
| Rental Asset | Rental |
| Event | Decorator/Event |
| Project | Project |
| Labour | Project/Service |
| AI Assistant | Platform |
| Invoice OCR | Platform/Module capability |

---

# 33. Decisions Established by This Audit

### Decision 001
New ERP will **not** be a Pharmacy-specific fork.

### Decision 002
`Item` will be a generic Core entity; `Medicine` will be a Pharmacy extension.

### Decision 003
Inventory allocation strategy must be configurable.

### Decision 004
AI will not be authoritative for financial arithmetic or business balances.

### Decision 005
Offline synchronization will become a reusable platform service.

### Decision 006
Accounting will be redesigned as a proper domain engine rather than a collection of dashboard calculations.

### Decision 007
RBAC will become permission-based rather than role-name-based.

### Decision 008
Tenant identity will become a first-class domain concept.

### Decision 009
Shared and Dedicated database modes must use the same application/domain code.

### Decision 010
Current Pharmacy PWA will be treated as a reference implementation, not the new ERP's architecture.

---

# 34. Open Questions — Must Be Resolved Before Architecture Freeze

1. Branch/multi-branch support কি MVP থেকেই থাকবে?
2. Tax/VAT engine কতটা configurable হবে?
3. Bangladesh-specific accounting requirements কতটা গভীর হবে?
4. Multi-currency কি Core-এ থাকবে?
5. Multiple warehouses/locations কি Core feature হবে?
6. Barcode/label printing কতটা গভীর হবে?
7. Serial/IMEI কি separate module নাকি Inventory capability?
8. Rental asset এবং stock item-এর relationship কী হবে?
9. Project costing কীভাবে accounting-এর সঙ্গে যুক্ত হবে?
10. Subscription/billing engine platform-এর ভিতরে থাকবে নাকি external?
11. Tenant data export/import standard কী হবে?
12. Tenant migration Shared → Dedicated এবং Dedicated → Shared support করা হবে কি?
13. Offline mode-এ কোন operations allowed থাকবে?
14. Multi-device conflict policy কী হবে?
15. Audit log retention কতদিন?
16. Backup/restore granularity কী হবে?
17. AI provider abstraction কীভাবে হবে?
18. File/document storage policy কী হবে?
19. Notification channels কোনগুলো MVP-তে থাকবে?
20. First commercial vertical কোনটি হবে?

---

# 35. Audit Conclusion

বর্তমান Pharmacy PWA নতুন ERP তৈরির জন্য একটি মূল্যবান reference implementation।

সবচেয়ে বেশি reuse করার মতো অংশ:

```text
POS workflow
Purchase workflow
Inventory movement concepts
Customer/Supplier due
Returns
Drafts
Offline queue
Sync/retry UX
Staff/RBAC concepts
AI safety principles
Dashboard alert patterns
```

সবচেয়ে বেশি refactor করার প্রয়োজন:

```text
Global APP_STATE
Firestore coupling
Financial transaction boundaries
Inventory data model
Hard-coded Pharmacy terminology
Role model
Offline conflict/idempotency
API/domain separation
Accounting engine
Tenant architecture
```

নতুন platform-এর মূল architectural principle:

> **Existing business logic থেকে proven behavior নেওয়া হবে; existing code structure বাধ্যতামূলকভাবে নেওয়া হবে না।**

---

## Next Document

`02_BUSINESS_DOMAIN_ANALYSIS.md`

এতে আমরা Pharmacy নয়, **সমস্ত target business-এর common business process** বের করব:

```text
Lead / Customer
      ↓
Quotation
      ↓
Order / Booking
      ↓
Purchase / Resource Planning
      ↓
Inventory / Asset
      ↓
Delivery / Service / Event
      ↓
Invoice
      ↓
Payment
      ↓
Due / Accounting
      ↓
Return / Warranty / After-Sales
      ↓
Reporting
```

এরপর এই universal process-এর কোথায় **Retail, Pharmacy, Electronics, Decorator, Rental, Service, Project** আলাদা হয়—তা নির্ধারণ করা হবে।

