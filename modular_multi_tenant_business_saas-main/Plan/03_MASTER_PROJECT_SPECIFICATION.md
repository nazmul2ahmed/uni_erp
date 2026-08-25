# 03_MASTER_PROJECT_SPECIFICATION.md

**Project:** Modular Multi-Tenant Business ERP SaaS  
**Document Type:** Master Project Specification / Source of Truth  
**Version:** 1.0 Draft  
**Status:** Foundation Specification  
**Predecessors:**  
- `01_EXISTING_PHARMACY_SYSTEM_AUDIT.md`
- `02_BUSINESS_DOMAIN_ANALYSIS.md`

---

# 1. Document Purpose

এই document পুরো project-এর master specification।

এটি নির্ধারণ করবে:

- platform কী
- platform কী নয়
- কার জন্য
- কোন business model support করবে
- কোন architecture অনুসরণ করবে
- Core ERP কী হবে
- Optional modules কী হবে
- Industry extensions কী হবে
- Multi-tenancy কীভাবে কাজ করবে
- Shared ও Dedicated deployment কীভাবে একই platform-এ থাকবে
- Data ownership কীভাবে নির্ধারিত হবে
- Security, audit, offline, sync, AI এবং accounting-এর মূল নীতি
- MVP-তে কী থাকবে
- পরবর্তী phase-এ কী থাকবে
- Development কোন নিয়মে হবে

এই document-এর পরে লেখা technical/design documents-এর কোনো সিদ্ধান্ত যদি এখানে নির্ধারিত product principle-এর সঙ্গে conflict করে, তাহলে conflict explicitly document করতে হবে।

---

# 2. Product Definition

## 2.1 Product identity

এটি একটি:

> **Modular Multi-Tenant Business ERP SaaS Platform**

এটি কোনো নির্দিষ্ট industry-এর ERP নয়।

একটি codebase-এর মাধ্যমে:

```text
Retail
Pharmacy
Electronics
Decorator/Event
Service
Rental
Project
General Trading
```

ইত্যাদি business operate করতে পারবে।

---

# 3. Product Vision

ছোট ও মাঝারি ব্যবসার জন্য এমন একটি affordable, modular এবং scalable business platform তৈরি করা, যেখানে ব্যবসার প্রয়োজন অনুযায়ী capability চালু করা যাবে এবং একই system-এর মাধ্যমে:

```text
Customer
Sales
Purchase
Inventory
Service
Rental
Project
Accounting
Payment
Reporting
Automation
AI
```

পরিচালনা করা যাবে।

---

# 4. Core Product Philosophy

## 4.1 Capability-first

Business type architecture-এর root নয়।

```text
Business Type
     ↓
Template
     ↓
Capabilities
     ↓
Modules
     ↓
Configuration
```

---

## 4.2 One Platform, Multiple Industries

আমরা:

```text
Electronics ERP
Pharmacy ERP
Decorator ERP
```

তিনটি আলাদা application বানাব না।

বরং:

```text
ERP Core
+
Modules
+
Industry Extensions
+
Configuration
```

ব্যবহার করব।

---

## 4.3 One Codebase, Multiple Tenant Models

Platform একই application codebase থেকে:

```text
Shared Multi-Tenant
```

এবং:

```text
Dedicated Tenant Database
```

দুই model support করবে।

---

## 4.4 Offline-first where valuable

Business-critical operations-এর ক্ষেত্রে network failure application বন্ধ করে দেবে না।

যেখানে নিরাপদ:

```text
Local Transaction
 ↓
Pending Queue
 ↓
Sync
 ↓
Server
```

ব্যবহার করা হবে।

---

## 4.5 Financial Integrity First

Financial transaction-এর ক্ষেত্রে:

```text
Exact Calculation
+
Atomic Mutation
+
Audit Trail
+
Idempotency
```

বাধ্যতামূলক।

---

## 4.6 AI is an Assistant

AI:

```text
Understand
Extract
Summarize
Suggest
Explain
```

করবে।

AI:

```text
Invent
Guess
Directly mutate financial data
```

করবে না।

---

# 5. Target Users

## 5.1 Business Owner

Needs:

- sales
- profit
- cash
- due
- stock
- staff
- reports
- business overview

---

## 5.2 Manager

Needs:

- operational control
- approvals
- inventory
- staff
- sales
- purchase
- reports

---

## 5.3 Sales/Cashier

Needs:

- POS
- customer
- payment
- receipt
- return

---

## 5.4 Inventory Staff

Needs:

- stock
- purchase receipt
- transfer
- adjustment
- stock count

---

## 5.5 Accountant

Needs:

- payment
- expense
- receivable
- payable
- journal
- reports

---

## 5.6 Service Technician

Needs:

- service order
- customer
- diagnosis
- parts
- labour
- completion

---

## 5.7 Project/Event Staff

Needs:

- quotation
- booking
- project
- resources
- expenses
- execution

---

# 6. Product Scope

## 6.1 Core scope

```text
Identity
Tenant
RBAC
Customer
Supplier
Item
Sales
Purchase
Payment
Receivable
Payable
Inventory
Expense
Accounting
Documents
Audit
Notifications
Reports
```

---

## 6.2 Optional modules

```text
Quotation
Booking
Service
Rental
Project
Serial
Warranty
Advanced Inventory
Automation
CRM
Delivery
```

---

## 6.3 Industry extensions

```text
Pharmacy
Electronics
Decorator/Event
```

ভবিষ্যতে:

```text
Manufacturing
Education
Restaurant
Construction
Healthcare
```

যেখানে applicable হবে, extension হিসেবে যোগ করা যাবে।

---

# 7. Tenant Model

## 7.1 Tenant definition

Tenant হলো একটি logically isolated business environment।

একটি tenant-এর:

```text
Users
Branches
Customers
Suppliers
Items
Transactions
Inventory
Accounting
Settings
```

অন্য tenant থেকে isolated থাকবে।

---

# 8. Tenant Deployment Modes

## 8.1 Shared Multi-Tenant

একটি database-এ বহু tenant:

```text
PostgreSQL
│
├── tenant_A
├── tenant_B
├── tenant_C
└── tenant_D
```

বাস্তবে logical separation:

```text
tenant_id
+
authorization
+
database policy/RLS
```

ব্যবহার করা হবে।

---

## 8.2 Dedicated Tenant

একটি tenant-এর জন্য আলাদা database:

```text
Tenant A → Database A
Tenant B → Database B
```

Application code একই থাকবে।

---

# 9. Database Abstraction Requirement

Application code কখনো সরাসরি:

```text
Shared Database
```

অথবা:

```text
Dedicated Database
```

এর সঙ্গে tightly coupled হবে না।

Architecture:

```text
Application
 ↓
Repository
 ↓
Database Adapter
 ↓
Tenant-aware Connection
```

---

# 10. Tenant Routing

প্রতিটি authenticated request-এ tenant context resolve হবে।

```text
User
 ↓
Membership
 ↓
Tenant
 ↓
Deployment Mode
 ↓
Database Resolver
 ↓
Repository
```

Tenant context কখনো শুধুমাত্র frontend-provided hidden value হিসেবে trust করা যাবে না।

Server-side authorization authoritative হবে।

---

# 11. Tenant Isolation

প্রতিটি business data record-এর সঙ্গে logically:

```text
tenantId
```

থাকবে যেখানে tenant-scoped entity।

Rules:

```text
No cross-tenant read
No cross-tenant write
No cross-tenant search
No cross-tenant report
No cross-tenant export
```

---

# 12. User Membership

একজন user ভবিষ্যতে:

```text
User
 ├── Tenant A → Owner
 ├── Tenant B → Accountant
 └── Tenant C → Manager
```

হতে পারবে।

একটি membership:

```text
userId
tenantId
roleId
status
```

ধারণ করবে।

---

# 13. Branch Model

Tenant-এর একাধিক branch থাকতে পারবে।

```text
Tenant
 ├── Branch A
 ├── Branch B
 └── Branch C
```

Branch-specific data access permission configurable হবে।

---

# 14. Warehouse Model

Warehouse branch থেকে আলাদা concept।

```text
Branch
 ├── Store
 ├── Warehouse
 └── Service Center
```

একটি warehouse inventory location হিসেবে কাজ করবে।

---

# 15. Core Data Model

প্রধান Core entities:

```text
Tenant
User
Membership
Role
Permission

BusinessProfile
Branch
Warehouse

Customer
Supplier

Item
ItemCategory
Brand
Unit

Sale
SaleItem
Purchase
PurchaseItem

Payment
Receivable
Payable
Expense

StockMovement
StockBalance

Return
ReturnItem

Account
Journal
JournalEntry
LedgerEntry

Document
AuditLog
Notification
```

---

# 16. Item Model

`Item` universal entity।

Item types:

```text
PRODUCT
SERVICE
RAW_MATERIAL
CONSUMABLE
RENTAL_ASSET
NON_STOCK
```

Tracking:

```text
stock
batch
expiry
serial
warranty
rental
```

প্রতিটি tracking capability configuration-driven হবে।

---

# 17. Sales Specification

Sale transaction:

```text
Sale Header
+
Sale Lines
+
Pricing
+
Discount
+
Tax
+
Payment
+
Inventory Effects
+
Receivable
+
Accounting
+
Audit
```

একটি completed sale-এর effects atomic transaction হিসেবে commit হওয়া উচিত।

---

# 18. Purchase Specification

Purchase:

```text
Supplier
+
Purchase Lines
+
Cost
+
Discount
+
Tax
+
Receipt
+
Payable
+
Payment
+
Inventory
+
Accounting
```

Enterprise workflow future-এ:

```text
Purchase Request
 ↓
Purchase Order
 ↓
Goods Receipt
 ↓
Purchase Invoice
 ↓
Payment
```

support করতে পারবে।

---

# 19. Inventory Specification

Inventory authoritative transaction source:

```text
Stock Movement Ledger
```

Movement types:

```text
OPENING
PURCHASE
SALE
CUSTOMER_RETURN
SUPPLIER_RETURN
ADJUSTMENT_IN
ADJUSTMENT_OUT
TRANSFER_IN
TRANSFER_OUT
RESERVATION
RELEASE
CONSUMPTION
DAMAGE
LOSS
```

---

# 20. Inventory Strategy

Allocation strategy:

```text
FIFO
FEFO
SERIAL
MANUAL
RESERVATION
```

Strategy business configuration এবং item capability অনুযায়ী নির্ধারিত হবে।

---

# 21. Customer Receivable

Customer credit transaction:

```text
Invoice
 ↓
Receivable
 ↓
Payment
 ↓
Balance
```

Due balance dashboard-এর manually entered field নয়।

---

# 22. Supplier Payable

```text
Purchase Invoice
 ↓
Payable
 ↓
Payment
 ↓
Balance
```

---

# 23. Payment Model

Payment একটি independent transaction।

Payment:

```text
amount
method
date
reference
party
allocation
```

হিসেবে model হবে।

একটি payment একাধিক invoice-এ allocate করা যেতে পারে—future capability হিসেবে রাখা হবে।

---

# 24. Accounting Architecture

Accounting domain:

```text
Chart of Accounts
 ↓
Journal
 ↓
Journal Entry
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

Financial mutation domain transaction-এর সঙ্গে atomicভাবে integrate করতে হবে।

---

# 25. Accounting Principle

Completed financial transaction সরাসরি destructive edit করা হবে না।

বরং:

```text
Original
 ↓
Reversal
 ↓
Corrected Transaction
```

ব্যবহার করা হবে।

---

# 26. Double Entry

যেখানে accounting enabled:

প্রতিটি relevant financial event-এর balanced journal entry তৈরি হবে।

Invariant:

```text
Total Debit = Total Credit
```

এই invariant bypass করা যাবে না।

---

# 27. Quotation Module

Quotation:

```text
Customer
Items/Services
Pricing
Discount
Tax
Validity
Terms
Status
```

Status:

```text
DRAFT
SENT
ACCEPTED
REJECTED
EXPIRED
CONVERTED
```

---

# 28. Booking Module

Booking:

```text
Customer
Resource
Start
End
Status
Advance
Notes
```

ব্যবহার:

```text
Event
Rental
Appointment
Service
Venue
```

---

# 29. Service Module

Service Order:

```text
Customer
Device/Asset
Problem
Diagnosis
Parts
Labour
Technician
Status
Warranty
Invoice
```

---

# 30. Rental Module

Rental lifecycle:

```text
Available
 ↓
Reserved
 ↓
Dispatched
 ↓
Rented
 ↓
Returned
 ↓
Inspection
 ↓
Available / Maintenance
```

Damage charge এবং lost asset handling future rules হিসেবে configurable হবে।

---

# 31. Project Module

Project:

```text
Customer
Quotation
Budget
Tasks
Resources
Materials
Labour
Expenses
Invoices
Payments
Profitability
```

---

# 32. Industry Extension: Pharmacy

Pharmacy extension:

```text
Medicine
Generic
Strength
Dosage Form
Manufacturer
Batch
Expiry
FEFO
```

Core sales/purchase/inventory ব্যবহার করবে।

---

# 33. Industry Extension: Electronics

Electronics extension:

```text
Brand
Model
Serial
IMEI
Specification
Warranty
Repair
Replacement
```

Core retail + inventory + service ব্যবহার করবে।

---

# 34. Industry Extension: Decorator/Event

Decorator extension:

```text
Event
Venue
Package
Rental Asset
Decoration Item
Labour
Transport
Project
Damage
```

Core quotation + booking + project + rental + inventory ব্যবহার করবে।

---

# 35. Business Templates

Initial onboarding templates:

```text
General Retail
Electronics
Pharmacy
Decorator/Event
Service Center
Rental
Project Business
```

Template শুধু default configuration তৈরি করবে।

Tenant পরে configuration পরিবর্তন করতে পারবে।

---

# 36. Module Activation

Tenant configuration:

```text
enabledModules = [
  sales,
  purchase,
  inventory,
  accounting,
  service
]
```

UI এবং backend capability একই source of truth থেকে module availability বুঝবে।

Security শুধুমাত্র UI hide করে enforce হবে না।

---

# 37. Permission Model

Permission format:

```text
resource.action
```

Examples:

```text
sales.create
sales.view
sales.cancel

purchase.create
purchase.approve

inventory.adjust
inventory.transfer

accounting.view
accounting.post

staff.manage
settings.manage
```

---

# 38. Approval Model

High-risk actions approval চাইতে পারে।

Examples:

```text
Large Discount
Stock Adjustment
Purchase Approval
Expense Approval
Sale Cancellation
Return Approval
Accounting Adjustment
```

Approval rules tenant configuration অনুযায়ী পরিবর্তনযোগ্য হবে।

---

# 39. Audit Specification

Audit log minimum:

```text
tenantId
userId
action
entityType
entityId
timestamp
before
after
reason
requestId
```

Sensitive data audit policy আলাদা হবে।

---

# 40. Offline Architecture

Offline-supported operations-এর জন্য:

```text
UI
 ↓
Application Service
 ↓
Local Persistence
 ↓
Pending Operation
 ↓
Sync Engine
 ↓
Server
 ↓
Database
```

Offline operation-এ:

```text
operationId
tenantId
userId
deviceId
createdAt
```

থাকবে।

---

# 41. Idempotency

একই operation retry হলে duplicate transaction তৈরি করা যাবে না।

Example:

```text
operationId = OP-123
```

server একই operation আবার পেলে existing result return করবে।

---

# 42. Sync Conflict

Conflict classes:

```text
No Conflict
Concurrent Update
Duplicate Operation
Stale Version
Permission Revoked
Deleted Entity
Business Rule Failure
```

প্রতিটির আলাদা resolution strategy থাকবে।

---

# 43. Offline Safety Boundary

সব operation offline allowed হবে না।

### Likely allowed

```text
POS sale
Customer creation
Draft
Basic stock operation
```

### Likely restricted

```text
Account closing
Major stock adjustment
User role change
Accounting period close
Critical configuration
```

Final list technical/offline specification-এ freeze হবে।

---

# 44. AI Architecture

AI access pattern:

```text
User
 ↓
AI Interface
 ↓
Intent
 ↓
Approved Tool
 ↓
Application Service
 ↓
Exact Data
 ↓
AI Response
```

Example:

User:

> “এই মাসে কোন পণ্য বেশি বিক্রি হয়েছে?”

AI:

```text
sales.analytics.topItems()
```

থেকে exact data নেবে।

AI নিজে সংখ্যা অনুমান করবে না।

---

# 45. AI Transaction Safety

AI-generated mutation:

```text
AI Suggestion
 ↓
Preview
 ↓
User Confirmation
 ↓
Application Validation
 ↓
Transaction
```

Direct mutation নয়।

---

# 46. Document Intelligence

Invoice/OCR:

```text
Image/PDF
 ↓
OCR/AI
 ↓
Structured Draft
 ↓
Validation
 ↓
Human Review
 ↓
Purchase
```

AI extraction ভুল হলে transaction তৈরি হওয়ার আগে ধরা যাবে।

---

# 47. Notification System

Notification event-driven:

```text
Event
 ↓
Notification Rule
 ↓
Channel
```

Channels:

```text
In-App
Email
Telegram
SMS
WhatsApp
Webhook
```

n8n external automation-এর জন্য ব্যবহার করা যাবে।

---

# 48. Reporting Principle

Report সরাসরি arbitrary UI state থেকে তৈরি হবে না।

Source:

```text
Authoritative Transaction Data
```

Reports:

```text
Sales
Purchase
Inventory
Receivable
Payable
Cash
Profit
Project
Service
Rental
```

---

# 49. UX Principles

## 49.1 Workflow-first

Menu database table অনুযায়ী নয়, কাজের flow অনুযায়ী।

## 49.2 Search-first

High-frequency operations-এ দ্রুত search।

## 49.3 Minimal clicks

POS-এর মতো repetitive operations দ্রুত করতে হবে।

## 49.4 Progressive disclosure

Advanced option প্রয়োজন না হলে UI-তে লুকানো থাকবে।

## 49.5 Clear financial feedback

প্রতিটি transaction-এ:

```text
Subtotal
Discount
Tax
Total
Paid
Due
```

স্পষ্ট।

## 49.6 Offline visibility

User বুঝবে:

```text
Saved locally
Syncing
Synced
Failed
```

---

# 50. Responsive/PWA Requirement

Platform:

```text
Desktop
Tablet
Mobile
```

support করবে।

PWA:

```text
Installable
Offline capable
Fast startup
Background sync where supported
```

---

# 51. Accessibility

Minimum:

```text
Keyboard navigation
Visible focus
Readable contrast
Semantic controls
Screen-reader-friendly labels
```

---

# 52. Search

Global search ভবিষ্যৎ platform capability।

Search entities:

```text
Customer
Supplier
Item
Invoice
Sale
Purchase
Service Order
Booking
Project
```

Tenant scope mandatory।

---

# 53. Numbering

Tenant configurable numbering:

```text
INV-2026-00001
PUR-2026-00001
RET-2026-00001
PAY-2026-00001
QTN-2026-00001
```

Branch-specific numbering future option।

---

# 54. Currency

MVP-তে single tenant base currency।

Architecture future multi-currency-ready হবে।

---

# 55. Tax

Tax engine configurable architecture-এ থাকবে।

MVP:

```text
No Tax
Single Tax
```

Future:

```text
Multiple Tax
Tax-inclusive
Tax-exclusive
Tax exemptions
Tax reporting
```

---

# 56. Data Import

Core import framework future-ready:

```text
CSV
Excel
JSON
```

Initial targets:

```text
Customers
Suppliers
Items
Opening Stock
Opening Receivable
Opening Payable
```

---

# 57. Data Export

Tenant data export:

```text
CSV
Excel
JSON
PDF reports
```

Export tenant isolation enforce করবে।

---

# 58. Backup

Shared tenants:

```text
Database backup
+
Tenant-aware logical backup
```

Dedicated:

```text
Tenant database backup
```

Point-in-time recovery architecture deployment layer-এ নির্ধারিত হবে।

---

# 59. Security Requirements

Mandatory:

```text
HTTPS
Secure Authentication
Password Hashing
Session Security
RBAC
Tenant Isolation
Input Validation
Server Authorization
Audit Log
Rate Limiting
Secret Management
Backup
```

---

# 60. API Security

Frontend কখনো trusted client হিসেবে বিবেচিত হবে না।

Server validate করবে:

```text
Authentication
Tenant Membership
Permission
Payload
Business Rule
Transaction State
```

---

# 61. Data Integrity

Critical invariants:

```text
Debit = Credit
Stock cannot become negative unless explicitly allowed
Return cannot exceed eligible quantity
Payment cannot exceed defined allocation constraints
Cross-tenant access prohibited
Duplicate transaction prevented
```

---

# 62. Architecture Boundary

Final target layering:

```text
Presentation
      ↓
Application
      ↓
Domain
      ↓
Repository
      ↓
Infrastructure
```

### Presentation

UI, forms, navigation.

### Application

Use cases/orchestration.

### Domain

Business rules/invariants.

### Repository

Data access contracts.

### Infrastructure

PostgreSQL, storage, queue, external services.

---

# 63. Frontend Principle

Frontend business truth নয়।

Frontend:

```text
Display
Input
Optimistic UI
Local Cache
Offline Queue
```

করবে।

Server/domain authoritative।

---

# 64. Backend Principle

Backend:

```text
Authorization
Validation
Business Rules
Transactions
Accounting
Inventory
Audit
```

enforce করবে।

---

# 65. Database Principle

PostgreSQL primary transactional database হিসেবে target করা হবে।

Relational model প্রয়োজন কারণ:

```text
Transactions
Accounting
Inventory
Relations
Constraints
Concurrency
```

গুরুত্বপূর্ণ।

---

# 66. Shared Database Strategy

Shared mode-এ:

```text
Every tenant-scoped table
→ tenant_id
```

এবং database-level protection বিবেচনা করা হবে।

Application-level filtering কখনো একমাত্র tenant isolation mechanism হবে না।

---

# 67. Dedicated Database Strategy

Dedicated mode-এ tenant database connection registry:

```text
Tenant
 ↓
Deployment Config
 ↓
Database Connection
```

রাখা হবে।

Application domain একই থাকবে।

---

# 68. Shared → Dedicated Migration

Target capability:

```text
Shared Tenant
 ↓
Export
 ↓
Validation
 ↓
Dedicated Database Provision
 ↓
Import
 ↓
Reconciliation
 ↓
Switch Routing
```

---

# 69. Dedicated → Shared Migration

Architecture future-ready হবে:

```text
Dedicated
 ↓
Canonical Export
 ↓
Validation
 ↓
Shared Tenant Import
 ↓
Switch Routing
```

---

# 70. SaaS Commercial Model

Platform revenue model:

```text
Tenant Subscription
```

Possible tiers:

```text
Starter
Professional
Business
Enterprise
```

---

# 71. Tenant Billing

Billing/control plane data business database থেকে logically separate থাকবে।

Control plane:

```text
Tenant
Subscription
Plan
Usage
Billing
Deployment
```

Business plane:

```text
Sales
Inventory
Accounting
Customers
```

---

# 72. Plan Limits

Example:

```text
Users
Branches
Warehouses
Transactions/month
Storage
Modules
Automation
AI usage
```

Limits server-side enforce হবে।

---

# 73. Enterprise Dedicated Plan

Enterprise tenant-এর জন্য:

```text
Dedicated Database
Dedicated Storage
Custom Domain
Advanced Backup
Higher Limits
Priority Support
```

optional।

---

# 74. Platform Control Plane vs Business Data Plane

```text
CONTROL PLANE
├── Tenant
├── User
├── Membership
├── Subscription
├── Plan
├── Usage
├── Deployment
└── Billing

BUSINESS PLANE
├── Customers
├── Suppliers
├── Sales
├── Purchases
├── Inventory
├── Accounting
└── Operations
```

এই separation গুরুত্বপূর্ণ।

---

# 75. Observability

Platform monitor করবে:

```text
Errors
Latency
API failures
Sync failures
Database health
Queue depth
Storage
Tenant usage
```

Tenant-level business analytics এবং platform-level operational telemetry আলাদা থাকবে।

---

# 76. Development Philosophy

Development হবে:

```text
Documentation
 ↓
Architecture
 ↓
Specification
 ↓
Implementation
 ↓
Testing
 ↓
Review
 ↓
Release
```

AI-assisted/vibe coding ব্যবহার করা যাবে, কিন্তু AI specification override করতে পারবে না।

---

# 77. AI Coding Protocol

AI-কে implementation prompt দেওয়ার আগে:

```text
Relevant Specification
+
Current Architecture
+
Affected Module
+
Acceptance Criteria
```

দেওয়া হবে।

AI:

```text
Do not invent requirements
Do not change unrelated modules
Do not silently change schema
Do not bypass domain rules
Do not duplicate business logic
```

---

# 78. Code Change Rule

প্রতিটি significant change:

```text
Requirement
 ↓
Design Decision
 ↓
Implementation
 ↓
Test
```

এর সঙ্গে traceable হবে।

---

# 79. Testing Strategy

Levels:

```text
Unit
Integration
Domain
API
Database
E2E
Offline/Sync
Security
Regression
```

Critical domains:

```text
Accounting
Inventory
Payment
Tenant Isolation
Sync
```

সবচেয়ে বেশি test coverage পাবে।

---

# 80. Financial Testing

Must test:

```text
Sale cash
Sale due
Partial payment
Full payment
Return
Purchase cash
Purchase due
Supplier payment
Expense
Discount
Tax
Reversal
Opening balance
```

---

# 81. Inventory Testing

Must test:

```text
Purchase
Sale
Return
FEFO
FIFO
Serial
Transfer
Adjustment
Reservation
Concurrent sale
Offline sale
Sync retry
Duplicate sync
```

---

# 82. Tenant Security Testing

Must test:

```text
Tenant A cannot read Tenant B
Tenant A cannot update Tenant B
Tenant A cannot search Tenant B
Tenant A cannot export Tenant B
Tenant A cannot use Tenant B operationId
```

---

# 83. Offline Testing

Test:

```text
Offline create
Offline sale
Reconnect
Retry
Duplicate request
Server rejection
Permission change while offline
Stale data
Conflict
Device restart
Browser restart
```

---

# 84. MVP Definition

MVP must allow a small business to perform:

```text
Login
Business Setup
Customer Setup
Supplier Setup
Item Setup
Purchase
Stock
POS Sale
Payment
Customer Due
Supplier Due
Expense
Basic Accounting
Basic Reports
Staff
Audit
```

এবং offline/online critical workflow-এর minimum support থাকতে হবে।

---

# 85. MVP Exclusions

প্রথম MVP-তে intentionally exclude:

```text
Full Manufacturing
Advanced HR
Payroll
Complex CRM
Advanced Project Management
Advanced Workflow Builder
Advanced BI
Multi-currency accounting
Complex tax compliance
Marketplace integrations
```

এগুলো architecture-এর future extension হিসেবে বিবেচিত হবে।

---

# 86. Phase Roadmap

## Phase 0 — Documentation

```text
Existing Audit
Business Domain
Master Specification
Architecture
Database
UX
Security
```

---

## Phase 1 — Platform Foundation

```text
Auth
Tenant
Membership
RBAC
Business Setup
Database
Audit
Settings
```

---

## Phase 2 — Core Commerce

```text
Customer
Supplier
Item
Purchase
Inventory
POS
Payment
Returns
```

---

## Phase 3 — Accounting

```text
Chart of Accounts
Journal
Ledger
Receivable
Payable
P&L
Balance Sheet
Cash Flow
```

---

## Phase 4 — Offline/PWA

```text
IndexedDB
Offline Queue
Sync Engine
Conflict Handling
Installable PWA
```

---

## Phase 5 — Modules

```text
Quotation
Booking
Service
Rental
Serial
Warranty
Project
```

---

## Phase 6 — Industry Extensions

```text
Pharmacy
Electronics
Decorator/Event
```

---

## Phase 7 — SaaS Platform

```text
Plans
Subscription
Usage
Shared/Dedicated Provisioning
Billing
Tenant Migration
```

---

## Phase 8 — AI/Automation

```text
AI Assistant
OCR
Natural Language Analytics
n8n
Notifications
Automation
```

---

# 87. First Commercial Target

Architecture general হলেও initial commercial validation-এর জন্য একটি narrow vertical বেছে নেওয়া উচিত।

Candidate:

```text
Electronics + Service
```

কারণ এতে:

```text
Retail
Inventory
Serial
Warranty
Service
Customer
Accounting
```

একসঙ্গে validate করা যায়।

Pharmacy PWA existing reference হিসেবে থাকবে।

Decorator দ্বিতীয় strong vertical হতে পারে কারণ:

```text
Quotation
Booking
Project
Rental
Inventory
Labour
Accounting
```

একসঙ্গে validate হবে।

---

# 88. Success Criteria

Platform successful ধরা হবে যখন:

### Technical

```text
Same codebase
+
Shared DB
+
Dedicated DB
```

চালানো যাবে।

### Business

একটি নতুন business:

```text
Template নির্বাচন
 ↓
Modules নির্বাচন
 ↓
Configuration
 ↓
Business Ready
```

করতে পারবে।

### Developer

নতুন industry support করতে Core rewrite করতে হবে না।

---

# 89. New Industry Acceptance Test

একটি নতুন industry add করতে পারার জন্য:

1. Existing Core অপরিবর্তিত বা minimally changed থাকবে।
2. New module/extension isolated থাকবে।
3. Existing sales/purchase/payment/accounting পুনর্ব্যবহার করবে।
4. Existing tenant security বজায় থাকবে।
5. Existing offline/sync framework ব্যবহার করবে।
6. Existing audit framework ব্যবহার করবে।
7. New industry-specific rules আলাদা domain package-এ থাকবে।

---

# 90. Architectural Non-Negotiables

এইগুলো future implementation-এ override করা যাবে না without explicit architecture decision:

```text
1. Tenant isolation
2. Server-side authorization
3. Financial integrity
4. Double-entry accounting where applicable
5. Inventory transaction integrity
6. Idempotent mutation
7. Auditability
8. AI cannot invent authoritative numbers
9. Domain logic cannot depend on UI
10. Shared/Dedicated deployment compatibility
11. No industry-specific leakage into generic Core
12. No silent schema/business-rule changes
```

---

# 91. Definition of Done

কোনো module complete বলতে:

```text
Business Rule documented
Data model documented
API/use case documented
UX documented
Validation implemented
Authorization implemented
Audit implemented
Offline behavior defined
Error handling implemented
Unit tests
Integration tests
E2E tests where applicable
Documentation updated
```

বোঝাবে।

---

# 92. Documentation Hierarchy

Project documentation:

```text
01_EXISTING_PHARMACY_SYSTEM_AUDIT.md
02_BUSINESS_DOMAIN_ANALYSIS.md
03_MASTER_PROJECT_SPECIFICATION.md

04_PLATFORM_ARCHITECTURE.md
05_MULTI_TENANT_ARCHITECTURE.md
06_DATABASE_SPECIFICATION.md
07_CORE_DOMAIN_SPECIFICATION.md
08_ACCOUNTING_ENGINE_SPECIFICATION.md
09_INVENTORY_ENGINE_SPECIFICATION.md
10_OFFLINE_SYNC_SPECIFICATION.md
11_API_SPECIFICATION.md
12_UX_SPECIFICATION.md
13_SECURITY_SPECIFICATION.md

14_MODULE_QUOTATION.md
15_MODULE_SERVICE.md
16_MODULE_RENTAL.md
17_MODULE_PROJECT.md
18_MODULE_BOOKING.md

19_INDUSTRY_PHARMACY.md
20_INDUSTRY_ELECTRONICS.md
21_INDUSTRY_DECORATOR.md

22_AI_ARCHITECTURE.md
23_AUTOMATION_ARCHITECTURE.md
24_TESTING_STRATEGY.md
25_DEPLOYMENT_ARCHITECTURE.md
26_SAAS_BILLING_SPECIFICATION.md
27_MIGRATION_SPECIFICATION.md
28_IMPLEMENTATION_ROADMAP.md
29_AI_CODING_PROTOCOL.md
```

---

# 93. Traceability Model

প্রতিটি গুরুত্বপূর্ণ requirement-এর ID থাকবে।

Format:

```text
REQ-CORE-001
REQ-SALES-001
REQ-INV-001
REQ-ACC-001
REQ-TENANT-001
REQ-OFFLINE-001
REQ-AI-001
```

Architecture decision:

```text
ADR-001
ADR-002
...
```

Business decision:

```text
BD-001
BD-002
...
```

এই traceability development-এর সময় অত্যন্ত গুরুত্বপূর্ণ হবে।

---

# 94. Change Management

Master specification change করতে:

```text
Change Request
 ↓
Impact Analysis
 ↓
Affected Documents
 ↓
Decision
 ↓
Version Update
 ↓
Implementation
```

করতে হবে।

AI-generated change নিজে থেকে specification change করবে না।

---

# 95. Versioning

Document:

```text
Major.Minor
```

ব্যবহার করবে।

উদাহরণ:

```text
1.0
1.1
1.2
2.0
```

Breaking architectural/business changes → major version।

---

# 96. Final Product Blueprint

সম্পূর্ণ platform conceptual model:

```text
                         SaaS CONTROL PLANE
                               │
              ┌────────────────┼────────────────┐
              │                │                │
           Tenant           Billing          Plans
           Users            Usage            Limits
              │
              ▼
                    TENANT BUSINESS PLANE
                              │
                     Business Profile
                              │
                    Enabled Capabilities
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
        CORE              OPTIONAL             INDUSTRY
          │                MODULES             EXTENSIONS
          │                   │                   │
    Customer             Quotation            Pharmacy
    Supplier             Booking              Electronics
    Item                 Service              Decorator
    Sales                Rental
    Purchase             Project
    Inventory            Serial
    Payment              Warranty
    Accounting
    Audit
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                       Domain Services
                              │
                         Repositories
                              │
                     Database Abstraction
                         /           \
                    Shared          Dedicated
                  PostgreSQL       PostgreSQL
```

---

# 97. Final Master Principle

এই project-এর সবচেয়ে গুরুত্বপূর্ণ principle:

> **Build the platform around business capabilities and transactions, not around industries or screens.**

অর্থাৎ:

```text
Pharmacy ≠ Separate ERP
Electronics ≠ Separate ERP
Decorator ≠ Separate ERP

                    ↓

          ONE BUSINESS PLATFORM

        Core + Modules + Extensions
```

এবং:

```text
ONE CODEBASE
      +
SHARED TENANT MODE
      +
DEDICATED TENANT MODE
      +
OFFLINE
      +
ACCOUNTING
      +
AI
      +
AUTOMATION
```

একটি coherent platform হিসেবে কাজ করবে।

---

# 98. Master Specification Status

এই document-এর বর্তমান status:

```text
Product Vision        ✓
Business Scope        ✓
Core Scope            ✓
Module Scope          ✓
Industry Scope        ✓
Tenant Model          ✓
Shared/Dedicated      ✓
Accounting Principles ✓
Inventory Principles  ✓
Offline Principles    ✓
AI Principles         ✓
Security Principles   ✓
UX Principles         ✓
MVP                    ✓
Roadmap               ✓
Traceability          ✓
```

পরবর্তী documents-এ implementation-level সিদ্ধান্ত নেওয়া হবে।

---

# 99. Next Document

পরবর্তী authoritative technical document:

`04_PLATFORM_ARCHITECTURE.md`

এতে নির্ধারণ করা হবে:

```text
Frontend Framework
Backend Framework
Language
Database
ORM
Authentication
State Management
Offline Storage
API Architecture
Repository Architecture
Domain Architecture
File Storage
Queue
Background Jobs
Caching
Search
Notifications
AI Integration
n8n Integration
Testing Stack
Docker
Deployment
CI/CD
Environment Strategy
```

**Important:** Technology নির্বাচন business specification পরিবর্তন করবে না; technology business specification implement করবে।
