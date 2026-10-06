# 02_BUSINESS_DOMAIN_ANALYSIS.md

**Project:** Modular Multi-Tenant Business ERP SaaS  
**Document:** Universal Business Domain Analysis  
**Status:** Draft v1.0  
**Purpose:** বিভিন্ন ধরনের ব্যবসার common operational model নির্ধারণ করে Core ERP, Optional Module, Industry Extension এবং Tenant Configuration-এর সীমানা নির্ধারণ করা।

---

# 1. Executive Summary

এই platform-এর লক্ষ্য কোনো একটি industry-এর ERP বানানো নয়। লক্ষ্য হলো এমন একটি modular business operating platform তৈরি করা যেখানে একই application-এর ওপর বিভিন্ন ধরনের ব্যবসা তাদের প্রয়োজনীয় capability নির্বাচন ও configure করতে পারে।

মূল abstraction:

```text
Business
   ↓
Business Lifecycle
   ↓
Universal Capability
   ↓
Core ERP
   ↓
Optional Module
   ↓
Industry Extension
   ↓
Tenant Configuration
```

মূল নীতি:

> Business type application-এর architecture নির্ধারণ করবে না; business capability নির্ধারণ করবে কোন module ও configuration সক্রিয় থাকবে।

---

# 2. Target Business Families

প্রাথমিকভাবে platform নিম্নোক্ত business family support করার জন্য design করা হবে।

## 2.1 Retail / Trading

উদাহরণ:

- Electronics
- Grocery
- Pharmacy
- Fashion
- Cosmetics
- Hardware
- Stationery
- Furniture
- General Trading

Common operations:

```text
Purchase
Inventory
Sales
Returns
Customer
Supplier
Payment
Due
Accounting
```

---

## 2.2 Service Business

উদাহরণ:

- Electronics repair
- Mobile/computer service
- AC service
- Electrical service
- Consultancy
- Agency
- Salon
- Cleaning
- Maintenance

Common operations:

```text
Customer
Appointment
Service Order
Technician
Parts
Labour
Quotation
Invoice
Payment
After-sales
```

---

## 2.3 Rental Business

উদাহরণ:

- Decorator
- Event equipment
- Furniture rental
- Camera rental
- Tool rental
- Equipment rental
- Vehicle/equipment rental

Common operations:

```text
Asset
Availability
Reservation
Booking
Dispatch
Return
Damage
Additional Charge
Payment
```

---

## 2.4 Project / Event Business

উদাহরণ:

- Decorator
- Event management
- Interior
- Construction
- Marketing agency
- Software agency
- Production

Common operations:

```text
Lead
Quotation
Project
Budget
Resource
Labour
Material
Milestone
Expense
Invoice
Payment
Profitability
```

---

## 2.5 Hybrid Business

অনেক বাস্তব ব্যবসা একটির বেশি family ব্যবহার করে।

উদাহরণ:

### Electronics shop + repair

```text
Retail
+
Inventory
+
Serial
+
Warranty
+
Service
```

### Decorator

```text
Quotation
+
Project
+
Rental
+
Inventory
+
Event
+
Labour
+
Accounting
```

### Pharmacy

```text
Retail
+
Inventory
+
Batch
+
Expiry
+
FEFO
+
Pharmacy
```

### Furniture business

```text
Retail
+
Inventory
+
Delivery
+
Installation
+
Service
```

অতএব `business_type` একক enum হিসেবে architecture-এর কেন্দ্র হবে না।

---

# 3. Universal Business Lifecycle

বেশিরভাগ ব্যবসাকে একটি generalized lifecycle দিয়ে model করা যায়।

```text
Lead / Enquiry
      ↓
Customer
      ↓
Quotation / Estimate
      ↓
Order / Booking / Project
      ↓
Procurement / Resource Planning
      ↓
Inventory / Asset Allocation
      ↓
Delivery / Service / Event Execution
      ↓
Invoice
      ↓
Payment
      ↓
Receivable / Payable
      ↓
Accounting
      ↓
Return / Warranty / After-Sales
      ↓
Reporting / Analytics
```

সব business-এ সব ধাপ থাকবে না।

তাই প্রতিটি tenant-এর enabled capabilities এই lifecycle-এর subset তৈরি করবে।

---

# 4. Core Domain Concepts

## 4.1 Tenant

Tenant হলো platform-এর একটি independent business organization/account।

Tenant-এর মধ্যে থাকবে:

```text
Tenant
├── Business Profile
├── Users
├── Roles
├── Branches
├── Customers
├── Suppliers
├── Items
├── Transactions
├── Accounts
└── Configuration
```

Tenant isolation একটি security boundary।

---

# 5. Organization / Branch

একটি tenant-এর এক বা একাধিক branch থাকতে পারে।

```text
Tenant
 ├── Branch A
 ├── Branch B
 └── Warehouse
```

Branch এবং Warehouse একই entity হওয়া উচিত নয়।

### Branch

Business operation location।

### Warehouse

Inventory storage location।

একটি branch-এর একাধিক warehouse থাকতে পারে।

---

# 6. User / Membership / Role

Recommended model:

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

একজন user ভবিষ্যতে একাধিক tenant-এর member হতে পারবে।

---

# 7. Customer Domain

Customer শুধু retail buyer নয়।

Customer হতে পারে:

- ব্যক্তি
- company
- event client
- project client
- service customer
- patient/customer profile
- walk-in customer

Customer-এর common relationships:

```text
Customer
├── Sales
├── Quotations
├── Orders
├── Bookings
├── Projects
├── Service Orders
├── Payments
├── Receivables
├── Returns
└── Warranty
```

---

# 8. Supplier / Vendor Domain

Supplier শুধু product supplier নয়।

Supplier হতে পারে:

- manufacturer
- distributor
- subcontractor
- material supplier
- service vendor
- rental vendor

Common relationships:

```text
Supplier
├── Purchases
├── Purchase Returns
├── Payables
├── Payments
└── Contacts
```

---

# 9. Party Abstraction

ভবিষ্যৎ architecture-এ Customer এবং Supplier-এর মধ্যে common contact/party concept বিবেচনা করা হবে।

Possible model:

```text
Party
├── Person
└── Organization

Party Roles
├── Customer
├── Supplier
├── Vendor
├── Employee
└── Contractor
```

তবে MVP-তে unnecessarily complex party model এড়িয়ে Customer/Supplier আলাদা domain entity রাখা যেতে পারে।

---

# 10. Item Domain

সব business-এর item “Medicine” বা “Product” নয়।

তাই Core entity:

```text
Item
```

Item-এর type:

```text
PRODUCT
SERVICE
RENTAL_ASSET
RAW_MATERIAL
CONSUMABLE
NON_STOCK
```

একটি item-এর:

```text
SKU
Name
Category
Brand
Unit
Purchase Price
Selling Price
Tax Profile
Track Inventory?
Track Batch?
Track Serial?
Track Expiry?
Rentable?
Service?
```

থাকতে পারে।

---

# 11. Product vs Service

Retail:

```text
Item Type = PRODUCT
```

Consultancy:

```text
Item Type = SERVICE
```

Decorator:

```text
Item Type = PRODUCT
Item Type = SERVICE
Item Type = RENTAL_ASSET
```

এতে sales engine একই থাকবে।

---

# 12. Item Tracking Capability

Item type এবং tracking capability আলাদা হবে।

উদাহরণ:

```text
Item
├── stockTracked
├── batchTracked
├── serialTracked
├── expiryTracked
├── rentalTracked
└── warrantyTracked
```

### Pharmacy

```text
stockTracked = true
batchTracked = true
expiryTracked = true
serialTracked = false
```

### Electronics

```text
stockTracked = true
batchTracked = optional
serialTracked = true
warrantyTracked = true
```

### Decorator rental chair

```text
stockTracked = true
rentalTracked = true
serialTracked = optional
```

---

# 13. Inventory Domain

Inventory শুধু “কতটি item আছে” নয়।

Inventory হলো:

```text
Stock
+
Movement
+
Location
+
Reservation
+
Valuation
```

Core movements:

```text
Opening
Purchase Receipt
Sale
Customer Return
Supplier Return
Adjustment In
Adjustment Out
Transfer
Reservation
Reservation Release
Consumption
Damage
Loss
```

---

# 14. Inventory Allocation Strategies

Inventory engine generic হবে।

Strategy:

```text
FIFO
FEFO
SERIAL
MANUAL
LOCATION_PRIORITY
```

### Pharmacy

FEFO

### Electronics

Serial

### Grocery

FIFO/FEFO

### Decorator

Reservation-based allocation

---

# 15. Warehouse / Location

Inventory location hierarchy:

```text
Tenant
 └── Branch
      ├── Warehouse
      │    ├── Rack
      │    └── Bin
      └── Store
```

MVP-তে warehouse support থাকবে, rack/bin পরে optional module হতে পারে।

---

# 16. Procurement Domain

Universal procurement lifecycle:

```text
Supplier
 ↓
Purchase Request
 ↓
Purchase Order
 ↓
Goods Receipt
 ↓
Purchase Invoice
 ↓
Payment
 ↓
Payable
```

সব business-এ পুরো chain দরকার নেই।

Small retail:

```text
Purchase
 ↓
Stock Receipt
 ↓
Payment
```

Enterprise:

```text
PO
 ↓
GRN
 ↓
Invoice
 ↓
3-way matching
 ↓
Payment
```

---

# 17. Sales Domain

Universal sales lifecycle:

```text
Customer
 ↓
Quotation
 ↓
Order
 ↓
Delivery / Execution
 ↓
Invoice
 ↓
Payment
```

POS-এর জন্য:

```text
Customer
 ↓
Cart
 ↓
Sale
 ↓
Payment
```

Decorator:

```text
Enquiry
 ↓
Quotation
 ↓
Booking
 ↓
Project
 ↓
Invoice
 ↓
Payment
```

---

# 18. Pricing Domain

Pricing engine আলাদা Core service হবে।

Possible pricing sources:

```text
Base Price
Customer Price
Price List
Promotion
Discount
Package Price
Project Price
Rental Rate
Service Rate
```

Pricing calculation authoritative application/domain engine করবে।

---

# 19. Discount Domain

Discount levels:

```text
Line Discount
Order Discount
Customer Discount
Promotion
Package Discount
```

Rules:

- maximum discount permission-based হতে পারে
- discount approval workflow configurable
- discount audit করা হবে

---

# 20. Payment Domain

Payment একটি universal Core entity।

Methods:

```text
Cash
Bank
Mobile Financial Service
Card
Cheque
Online
Other
```

Payment allocation:

```text
Invoice
Advance
Due
Refund
Supplier Payment
Expense
```

---

# 21. Receivable / Payable

### Customer

```text
Invoice
 ↓
Receivable
 ↓
Payment
 ↓
Balance
```

### Supplier

```text
Purchase Invoice
 ↓
Payable
 ↓
Payment
 ↓
Balance
```

এগুলো accounting-এর সঙ্গে linked থাকবে।

---

# 22. Return Domain

Return দুই ধরনের:

```text
Customer Return
Supplier Return
```

Return-এর effects:

```text
Inventory
Financial
Receivable/Payable
Tax
Accounting
```

---

# 23. Quotation Domain

Quotation Core-এর optional module।

Common:

```text
Customer
Items
Services
Discount
Tax
Validity
Terms
Estimated Total
```

Status:

```text
Draft
Sent
Viewed
Accepted
Rejected
Expired
Converted
```

---

# 24. Order Domain

Order quotation-এর পরের operational commitment।

Status:

```text
Draft
Confirmed
Processing
Partially Fulfilled
Completed
Cancelled
```

Retail order এবং project order একই base model ব্যবহার করতে পারে, কিন্তু execution strategy আলাদা হতে পারে।

---

# 25. Booking Domain

Booking হলো time/resource-based commitment।

Common examples:

- Event
- Rental
- Appointment
- Service
- Venue

Core fields:

```text
Customer
Start
End
Status
Resources
Advance
Notes
```

---

# 26. Rental Domain

Rental-specific entities:

```text
Rental Asset
Reservation
Rental Order
Dispatch
Return
Damage Assessment
Damage Charge
```

Lifecycle:

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

---

# 27. Service Domain

Service workflow:

```text
Customer
 ↓
Service Request
 ↓
Diagnosis
 ↓
Quotation
 ↓
Work Order
 ↓
Parts + Labour
 ↓
Completion
 ↓
Invoice
 ↓
Payment
 ↓
Warranty/After-sales
```

Electronics repair এবং AC service এই একই framework ব্যবহার করতে পারবে।

---

# 28. Project Domain

Project workflow:

```text
Customer
 ↓
Quotation
 ↓
Project
 ↓
Budget
 ↓
Resources
 ↓
Procurement
 ↓
Execution
 ↓
Expenses
 ↓
Billing
 ↓
Profitability
```

Project cost categories:

```text
Material
Labour
Rental
Transport
Subcontract
Other Expense
```

---

# 29. Decorator Domain

Decorator-এর জন্য আমরা আলাদা application নয়, combination model ব্যবহার করব:

```text
CRM
+
Quotation
+
Booking
+
Project
+
Rental
+
Inventory
+
Labour
+
Accounting
```

Specific entities:

```text
Event
Venue
Decoration Package
Theme
Rental Asset
Setup Team
Labour
Transport
Damage
```

---

# 30. Electronics Domain

Electronics হলো:

```text
Retail
+
Inventory
+
Serial
+
Warranty
+
Service
```

Specific capabilities:

```text
Serial Number
IMEI
Model
Brand
Specification
Warranty
Repair
Replacement
```

---

# 31. Pharmacy Domain

Pharmacy হলো:

```text
Retail
+
Inventory
+
Batch
+
Expiry
+
FEFO
+
Pharmacy Rules
```

Specific:

```text
Generic
Strength
Dosage Form
Manufacturer
Batch
Expiry
Prescription
```

---

# 32. Accounting Domain

Accounting universal এবং Core-এর অত্যন্ত গুরুত্বপূর্ণ অংশ।

Minimum model:

```text
Chart of Accounts
Journal
Journal Entry
Ledger
Receivable
Payable
Cash
Bank
Expense
Income
```

Reports:

```text
Trial Balance
Profit & Loss
Balance Sheet
Cash Flow
Receivable Aging
Payable Aging
```

---

# 33. Audit Domain

Auditable operations:

```text
Login
User Changes
Role Changes
Sale
Purchase
Return
Payment
Stock Adjustment
Accounting Entry
Settings
Data Export
Data Deletion
```

Audit event:

```text
Who
What
When
Tenant
Entity
Before
After
Reason
IP/Device where appropriate
```

---

# 34. Notification Domain

Universal notification channels:

```text
In-App
Email
Telegram
SMS
WhatsApp
```

Events:

```text
Invoice Created
Payment Received
Due Reminder
Low Stock
Expiry
Booking Confirmed
Service Completed
Warranty Expiring
```

n8n integration এখানে automation layer হিসেবে কাজ করতে পারে।

---

# 35. Document Domain

Common documents:

```text
Quotation
Purchase Order
Goods Receipt
Invoice
Receipt
Payment Voucher
Delivery Note
Return Note
Work Order
Rental Agreement
Project Document
```

Document storage আলাদা object storage layer-এ থাকবে।

---

# 36. Reporting Domain

Reports দুটি category:

### Operational

```text
Sales
Purchases
Stock
Customers
Suppliers
Bookings
Services
Projects
```

### Financial

```text
P&L
Balance Sheet
Cash Flow
Receivable
Payable
Gross Margin
Net Profit
```

---

# 37. Analytics Domain

Analytics raw transaction-এর ওপর কাজ করবে।

Examples:

```text
Sales Trend
Top Products
Slow Moving Items
Stock Turnover
Customer Value
Supplier Performance
Project Profitability
Rental Utilization
Service Revenue
```

Analytics authoritative transaction source নয়।

---

# 38. Automation Domain

Event-driven architecture:

```text
Business Event
 ↓
Automation Rule
 ↓
Action
```

Example:

```text
Invoice Due
 ↓
Due > 7 days
 ↓
Send Reminder
```

Actions:

```text
Notification
Email
Telegram
n8n Webhook
Task Creation
```

---

# 39. AI Domain

AI capabilities:

```text
Search Assistant
Business Summary
Document Extraction
Invoice OCR
Natural Language Query
Draft Generation
Forecast Suggestion
Anomaly Suggestion
```

AI must use controlled application tools:

```text
getSalesSummary()
getStockStatus()
getCustomerDue()
getUpcomingBookings()
```

AI direct database mutation করবে না।

---

# 40. Universal vs Module vs Industry Matrix

| Capability | Core | Optional Module | Industry |
|---|---:|---:|---:|
| Tenant | ✓ | | |
| User/RBAC | ✓ | | |
| Customer | ✓ | | |
| Supplier | ✓ | | |
| Item | ✓ | | |
| Sales | ✓ | | |
| Purchase | ✓ | | |
| Payment | ✓ | | |
| Receivable | ✓ | | |
| Payable | ✓ | | |
| Basic Inventory | ✓ | | |
| Accounting | ✓ | | |
| Audit | ✓ | | |
| Reporting | ✓ | | |
| Quotation | | ✓ | |
| Service | | ✓ | |
| Rental | | ✓ | |
| Project | | ✓ | |
| Booking | | ✓ | |
| Serial | | ✓ | |
| Warranty | | ✓ | |
| Advanced Inventory | | ✓ | |
| Pharmacy | | | ✓ |
| Electronics | | | ✓ |
| Decorator | | | ✓ |

---

# 41. Business Template Model

Business template হলো module preset।

## Electronics Retail

```text
Retail
Inventory
Serial
Warranty
Service
Accounting
```

## Pharmacy

```text
Retail
Inventory
Batch
Expiry
FEFO
Pharmacy
Accounting
```

## Decorator

```text
CRM
Quotation
Booking
Project
Rental
Inventory
Labour
Accounting
```

## Service Center

```text
CRM
Service
Inventory
Serial
Warranty
Accounting
```

## Grocery

```text
Retail
Inventory
Batch/Expiry optional
Barcode
Accounting
```

---

# 42. Tenant Configuration

Template শুধু initial setup।

Tenant পরে configure করতে পারবে:

```text
Enabled Modules
Business Rules
Numbering
Tax
Currency
Branches
Warehouses
Payment Methods
Price Lists
Discount Rules
Approval Rules
Notifications
```

---

# 43. Feature Flags

Module-এর ভিতরের feature configurable হবে।

Example:

```text
inventory.batchTracking
inventory.serialTracking
inventory.expiryTracking
inventory.multiWarehouse
sales.barcode
sales.creditSale
sales.approval
purchase.approval
rental.damageCharge
service.technician
project.costing
```

---

# 44. Business Rules vs Configuration

এই distinction বাধ্যতামূলক।

### Business Rule

> একটি completed sale-এর quantity তার sold quantity-এর চেয়ে বেশি return করা যাবে না।

### Configuration

> Tenant customer return 30 দিনের মধ্যে গ্রহণ করবে।

Rule engine configuration পড়বে, কিন্তু fundamental invariants code/domain layer enforce করবে।

---

# 45. Business Process Engine

ভবিষ্যতে workflow configurable করা যাবে।

Example:

```text
Quotation
 ↓
Approval Required?
 ├── No → Send
 └── Yes
       ↓
   Manager Approval
       ↓
      Send
```

আরেক tenant:

```text
Quotation
 ↓
Auto Send
```

---

# 46. Status Machine

প্রতিটি important domain entity-এর explicit state machine থাকবে।

Sale:

```text
DRAFT
CONFIRMED
PAID/PARTIAL/DUE
COMPLETED
CANCELLED
```

Quotation:

```text
DRAFT
SENT
ACCEPTED
REJECTED
EXPIRED
CONVERTED
```

Booking:

```text
DRAFT
HOLD
CONFIRMED
IN_PROGRESS
COMPLETED
CANCELLED
```

---

# 47. Core Design Principle: Capability over Industry

Architecture should ask:

> “এই tenant-এর কী capability দরকার?”

না যে:

> “এই tenant electronics না pharmacy?”

Example:

```text
if serialTracking = true
    enable serial workflow
```

rather than:

```text
if businessType = electronics
```

এতে ভবিষ্যৎ business support করা সহজ হবে।

---

# 48. Core Design Principle: Transaction over Screen

একটি business operation UI screen-এর সমান নয়।

উদাহরণ:

“Sale Complete” একটি domain transaction।

এর effects:

```text
Sale
+
Stock Movement
+
Payment
+
Receivable
+
Accounting
+
Audit
```

UI শুধু এই transaction trigger করবে।

---

# 49. Core Design Principle: One Source of Truth

একই balance আলাদা জায়গায় manually maintain করা যাবে না।

উদাহরণ:

```text
Customer Due
```

এর authoritative source হবে financial transaction/receivable ledger।

Dashboard শুধু তা read করবে।

একইভাবে:

```text
Stock
```

Inventory ledger থেকে derive হবে।

---

# 50. Core Design Principle: Idempotency

Offline/retry/distributed environment-এর জন্য transaction operation পুনরায় request হলেও duplicate effect করা যাবে না।

প্রতিটি mutation-এ:

```text
operationId
```

বা equivalent idempotency key থাকবে।

---

# 51. Core Design Principle: Auditability

Financial/business mutation-এর ক্ষেত্রে:

```text
Create
Update
Delete
Reverse
Approve
Cancel
```

সব significant operation traceable হবে।

Hard delete সীমিত করা হবে।

---

# 52. Core Design Principle: Reversal over Destructive Edit

Completed financial transaction সরাসরি edit না করে:

```text
Original Transaction
       ↓
Reversal / Adjustment
       ↓
Corrected Transaction
```

ব্যবহার করা হবে।

এটি accounting এবং audit integrity-এর জন্য গুরুত্বপূর্ণ।

---

# 53. Core Module Map

```text
CORE
├── Tenant
├── Identity
├── RBAC
├── Customer
├── Supplier
├── Item
├── Sales
├── Purchase
├── Payment
├── Receivable
├── Payable
├── Inventory
├── Accounting
├── Documents
├── Audit
├── Notifications
└── Reports

OPTIONAL
├── Quotation
├── Booking
├── Service
├── Rental
├── Project
├── Serial
├── Warranty
├── Advanced Inventory
└── Automation

INDUSTRY
├── Pharmacy
├── Electronics
└── Decorator/Event
```

---

# 54. MVP Boundary

প্রথম MVP-তে:

```text
Tenant
User/RBAC
Customer
Supplier
Item
Sales/POS
Purchase
Inventory
Payment
Receivable
Payable
Expense
Basic Accounting
Basic Reports
Audit
```

দ্বিতীয় ধাপে:

```text
Quotation
Serial
Warranty
Service
Rental
Booking
```

তৃতীয় ধাপে:

```text
Project
Decorator/Event
Pharmacy
Advanced Electronics
```

---

# 55. What We Will NOT Do in Core

Core-এ industry-specific vocabulary ঢোকানো যাবে না।

ভুল:

```text
medicineBatch
patientPrescription
decoratorEvent
electronicsIMEI
```

Core-এ:

```text
Item
Batch
Serial
Booking
ServiceOrder
Project
```

Industry module extension এগুলোকে specialize করবে।

---

# 56. Final Domain Architecture

```text
                         TENANT
                           │
                    BUSINESS PROFILE
                           │
                  ENABLED CAPABILITIES
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
       CORE             OPTIONAL          INDUSTRY
        │               MODULES           EXTENSIONS
        │                  │                  │
 Customer              Service            Pharmacy
 Supplier              Rental             Electronics
 Item                  Project             Decorator
 Sales                 Booking
 Purchase              Quotation
 Inventory             Serial
 Payment               Warranty
 Accounting
```

---

# 57. Key Decisions

### BD-001
Business type is configuration/template, not the architectural root.

### BD-002
Capability/module is the primary unit of extensibility.

### BD-003
`Item` is the generic product/service representation.

### BD-004
Inventory tracking dimensions are configurable.

### BD-005
Sales/Purchase/Payment are universal transaction domains.

### BD-006
Quotation, Booking, Service, Rental and Project are optional modules.

### BD-007
Pharmacy, Electronics and Decorator are industry extension packages composed from Core + Modules.

### BD-008
Accounting remains a universal Core domain.

### BD-009
AI remains an assisting layer, never the financial source of truth.

### BD-010
Business transactions are modeled independently of UI screens.

---

# 58. Open Domain Questions

Before final architecture freeze, these need explicit decisions:

1. Customer and Supplier কি শেষ পর্যন্ত Party abstraction ব্যবহার করবে?
2. Multi-branch কি MVP Core-এ থাকবে?
3. Warehouse কি MVP Core-এ থাকবে?
4. Tax/VAT engine কি প্রথম version-এ configurable হবে?
5. Multi-currency কি Core-এ থাকবে?
6. Manufacturing কি ভবিষ্যৎ module হিসেবে architecture-এ placeholder পাবে?
7. HR/Payroll কি platform-এর future module হবে?
8. CRM/Lead management কতটা Core হবে?
9. Delivery/Logistics কি Core নাকি optional?
10. Subscription billing কি Control Plane-এর অংশ হবে?
11. Workflow approval engine কতটা generic করা হবে?
12. Custom fields কি সব major entity-তে থাকবে?
13. Custom business status কি tenant configure করতে পারবে?
14. Report builder কি future module হবে?
15. Import/export framework কি Core capability হবে?

---

# 59. Conclusion

এই analysis-এর ভিত্তিতে platform-এর conceptual identity এখন পরিষ্কার:

> **এটি কোনো Electronics ERP বা Decorator ERP নয়। এটি একটি Modular Multi-Tenant Business ERP Platform, যেখানে Core business primitives-এর ওপর capability modules এবং industry extensions বসে।**

সবচেয়ে গুরুত্বপূর্ণ architectural chain:

```text
Tenant
  ↓
Business Profile
  ↓
Enabled Capabilities
  ↓
Core + Modules + Industry Extensions
  ↓
Business Workflows
  ↓
Transactions
  ↓
Accounting / Inventory / Audit
```

এই model অনুসরণ করলে একটি নতুন industry support করতে Core rewrite করতে হবে না; প্রয়োজন হবে নতুন extension/configuration এবং যেখানে প্রয়োজন domain-specific module।

পরবর্তী document:
**`03_MASTER_PROJECT_SPECIFICATION.md`**

এতে এই Business Domain Analysis + Existing Pharmacy Audit-এর সিদ্ধান্ত একত্র করে পুরো project-এর authoritative specification তৈরি হবে।
