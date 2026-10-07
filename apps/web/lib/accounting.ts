/**
 * AccountingPostingService — per 07_CORE_DOMAIN_SPECIFICATION.md §13.4,
 * 08_ACCOUNTING_ENGINE_SPECIFICATION.md §4 (posting-rule notation) and
 * §5 (the exhaustive posting-rule table).
 *
 * Code-review reconciliation pass, Finding A: no journal was ever
 * posted anywhere in the codebase prior to this file existing —
 * completeSale/receivePurchase/recordPayment/completeCustomerReturn/
 * completeSupplierReturn mutated Sales/Purchase/Inventory/Payment
 * state but never touched core.journals/core.journal_entries. Every
 * one of those Use Cases now calls the corresponding named wrapper
 * below as part of ITS OWN transaction (Decision DOM-003, 07 §20:
 * accounting posting happens synchronously inside the same DB
 * transaction as the originating business event, never a decoupled
 * async side effect).
 *
 * `postJournal` is the ONLY code path in this codebase permitted to
 * INSERT into core.journals/core.journal_entries — every named
 * wrapper delegates to it rather than inserting directly, mirroring
 * the platform-wide rule that inventory only ever moves through one
 * ledger-posting chokepoint, applied here to the ledger's financial
 * counterpart.
 */
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { accounts, accountingPeriods, journals, journalEntries } from "@erp/db";
import { AppError } from "@erp/shared";
import type { Database } from "@erp/db";
import type { TenantContext } from "./guard";

const moneyScale = 10000n;

/**
 * FIX (Phase 2 code-verification pass — confirmed live bug, not a
 * hypothetical): `postSaleJournal`/`postCustomerReturnJournal` below
 * previously built each sub-journal's idempotency key as a plain
 * string-concatenation, e.g. `${operationId}:revenue`. `journals.
 * operation_id` is a `uuid`-typed column (06 v2.0 §5.14) — inserting
 * a non-UUID string like "f2c412...:revenue" fails at the database
 * with `invalid input syntax for type uuid`, meaning EVERY sale that
 * reaches the accounting-posting step (i.e. every sale, since
 * revenueLines is never empty) would crash in a real deployment. This
 * was undetected because prior verification exercised this code path
 * only against mocks, never a real PostgreSQL uuid column — caught by
 * apps/web/test/sale-discount-policy.integration.test.ts, the first
 * test suite to call completeSale() end-to-end against a live database.
 *
 * Fix: derive a DETERMINISTIC uuid from (operationId, suffix) via
 * RFC 4122 UUIDv5 (namespace + name, SHA-1-based) rather than string
 * concatenation — this is a VALID uuid AND preserves the original
 * design intent quoted in postSaleJournal's own docblock below
 * ("Each half gets its own operationId suffix so either can
 * independently replay-guard"): the same (operationId, suffix) pair
 * always yields the same sub-journal id, so postJournal's own
 * `journals.operation_id` idempotency lookup still correctly detects
 * a replay of the SAME sub-journal, without collapsing the revenue
 * and cogs halves onto one id (which the UNIQUE(tenant_id,
 * operation_id) constraint would reject) or losing replay-guard
 * entirely (which a fresh crypto.randomUUID() per call would do).
 */
const SUB_JOURNAL_NAMESPACE = "6f1b1a2e-6c7a-4e9a-9c2f-2f7b1a2e6c7a"; // fixed, arbitrary — any valid UUID works as an RFC 4122 namespace

export function deterministicSubOperationId(baseOperationId: string, suffix: string): string {
  const namespaceHex = SUB_JOURNAL_NAMESPACE.replace(/-/g, "");
  const namespaceBytes = Buffer.from(namespaceHex, "hex");
  const nameBytes = Buffer.from(`${baseOperationId}:${suffix}`, "utf8");
  const hash = createHash("sha1").update(namespaceBytes).update(nameBytes).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const negative = (whole ?? "").startsWith("-");
  const wholeAbs = (whole ?? "0").replace("-", "");
  const magnitude = BigInt(wholeAbs || "0") * moneyScale + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  return negative ? -magnitude : magnitude;
}

/**
 * Chart-of-accounts template, per 08 §3. `registerOwnerAndTenant`
 * (lib/tenant-onboarding.ts) already seeds the base eight of these at
 * provisioning. This catalog exists so postJournal can safely resolve
 * -- and, if genuinely missing, lazily and idempotently provision --
 * any of them, including ones this reconciliation pass needed that
 * onboarding did not originally seed (Discount Given, Other Income,
 * Prepaid/Supplier Advance, Customer Advances). Lazy provisioning is
 * safe: `accounts` has UNIQUE(tenant_id, code), so a race between two
 * concurrent postings resolves to the same row, never a duplicate.
 */
const SYSTEM_ACCOUNTS: Record<string, { name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }> = {
  "1000": { name: "Cash", type: "ASSET" },
  "1010": { name: "Bank", type: "ASSET" },
  "1100": { name: "Accounts Receivable", type: "ASSET" },
  "1200": { name: "Inventory", type: "ASSET" },
  "1300": { name: "Prepaid Expenses", type: "ASSET" }, // 08 §3.1 -- used here for supplier-payment unallocated advance
  "2000": { name: "Accounts Payable", type: "LIABILITY" },
  "2100": { name: "Tax Payable", type: "LIABILITY" },
  "2300": { name: "Customer Advances", type: "LIABILITY" }, // 08 §3.2 / §5.3
  "3000": { name: "Owner Equity", type: "EQUITY" },
  "3100": { name: "Retained Earnings", type: "EQUITY" },
  "4000": { name: "Sales Revenue", type: "INCOME" },
  "4900": { name: "Other Income", type: "INCOME" }, // seeded for forward-compat, unused today
  "5000": { name: "Cost of Goods Sold", type: "EXPENSE" },
  "5100": { name: "Discount Given", type: "EXPENSE" },
  // Decision VAN-005 (30_MODULE_VAN_SALES.md §7.1) — added now because
  // Decision VAN-003's Core Return extension (below) is the first
  // consumer, ahead of the full Van Sales module itself.
  "1250": { name: "Stock With Sales Reps", type: "ASSET" },
  // Decision ACC-007: inventory write-offs (unsellable returns, rep-custody write-offs) have their OWN account.
  // They were first posted to 5900, which 08 3.5 defines as the "Other Expense" catch-all for expense categories,
  // so two different things shared one line in the P&L. System-posted only: no expense category may map to it.
  "5500": { name: "Inventory Shrinkage/Expiry Expense", type: "EXPENSE" },
  "5900": { name: "Other Expense", type: "EXPENSE" },
  // Decision EXP-001 -- 08 3.5 expense-category accounts, lazily provisioned
  // like the rest so a category can map to them without an onboarding change.
  "5200": { name: "Rent Expense", type: "EXPENSE" },
  "5300": { name: "Salary Expense", type: "EXPENSE" },
  "5400": { name: "Utility Expense", type: "EXPENSE" },
};

/**
 * Accounts an expense CATEGORY may NOT map to (Decisions EXP-001, ACC-007): 5000 COGS
 * is written only by inventory flows (an expense there would silently shift
 * Gross Profit), 5100 Discount Given only by the sale posting rule, and 5500
 * Inventory Shrinkage only by the write-off posting rules.
 */
const EXPENSE_CATEGORY_RESERVED_CODES: ReadonlySet<string> = new Set(["5000", "5100", "5500"]);

/**
 * Resolve (lazily provisioning a system account if needed) the account a
 * new expense category will post to, and refuse anything that is not a
 * plain, active EXPENSE account of THIS tenant. Tenant-custom sub-accounts
 * resolve too (resolveAccountId finds any existing row by code).
 */
export async function resolveExpenseCategoryAccount(tx: Database, tenantId: string, code: string): Promise<{ id: string; code: string; name: string }> {
  if (EXPENSE_CATEGORY_RESERVED_CODES.has(code)) {
    throw new AppError("VALIDATION_FAILED", `Account ${code} is system-managed and cannot be used by an expense category`, { field: "accountCode" });
  }
  const known = await tx.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.code, code)) });
  if (!known && !SYSTEM_ACCOUNTS[code]) {
    throw new AppError("VALIDATION_FAILED", `Account ${code} does not exist in this tenant's chart of accounts`, { field: "accountCode" });
  }
  await resolveAccountId(tx, tenantId, code);
  const account = await tx.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.code, code)) });
  if (!account || account.type !== "EXPENSE" || !account.isActive) {
    throw new AppError("VALIDATION_FAILED", `Account ${code} is not an active EXPENSE account`, { field: "accountCode" });
  }
  return { id: account.id, code: account.code, name: account.name };
}

async function resolveAccountId(tx: Database, tenantId: string, code: string): Promise<string> {
  const existing = await tx.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.code, code)),
  });
  if (existing) return existing.id;

  const meta = SYSTEM_ACCOUNTS[code];
  if (!meta) throw new AppError("INTERNAL_ERROR", `Unknown system account code "${code}"`);

  await tx.insert(accounts).values({ tenantId, code, name: meta.name, type: meta.type, isSystemAccount: true }).onConflictDoNothing();

  const resolved = await tx.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.code, code)),
  });
  if (!resolved) throw new AppError("INTERNAL_ERROR", `Unable to resolve account "${code}"`);
  return resolved.id;
}

export async function getClosedAccountingPeriod(tx: Database, tenantId: string, postedAt: Date) {
  const day = postedAt.toISOString().slice(0, 10);
  return tx.query.accountingPeriods.findFirst({
    where: and(
      eq(accountingPeriods.tenantId, tenantId),
      eq(accountingPeriods.status, "CLOSED"),
      sql`${accountingPeriods.periodStart} <= ${day}::date`,
      sql`${accountingPeriods.periodEnd} >= ${day}::date`,
    ),
  });
}

export async function assertAccountingPeriodOpen(tx: Database, tenantId: string, postedAt: Date): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
  const period = await getClosedAccountingPeriod(tx, tenantId, postedAt);
  if (period) {
    throw new AppError("PERIOD_LOCKED", "The accounting date falls in a closed period", {
      periodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });
  }
}

export async function firstOpenAccountingDate(tx: Database, tenantId: string, requestedDate: Date): Promise<Date> {
  let candidate = new Date(requestedDate);
  while (true) {
    const period = await getClosedAccountingPeriod(tx, tenantId, candidate);
    if (!period) return candidate;
    candidate = new Date(`${period.periodEnd}T00:00:00.000Z`);
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
}

export interface JournalLine {
  /** Chart-of-accounts code, e.g. "1000" (Cash). */
  code: string;
  /** Decimal string, e.g. "150.0000". Exactly one of debit/credit per line (08 §11 INV-ACC-001). */
  debit?: string;
  credit?: string;
}

export interface PostJournalInput {
  referenceType: string;
  referenceId: string;
  description: string;
  /** Idempotency key. journals has UNIQUE(tenant_id, operation_id) -- a repeat call with the same key returns the existing journal without re-posting (mirrors 07 §17). */
  operationId: string;
  lines: JournalLine[];
  /**
   * Accounting effective date (reports filter on journals.posted_at, 08 6).
   * Omitted => now (every existing posting rule). Used by RecordExpense so a
   * backdated expense lands in its own period (Decision EXP-003).
   */
  postedAt?: Date;
}

export async function postJournal(tx: Database, ctx: TenantContext, input: PostJournalInput) {
  const existing = await tx.query.journals.findFirst({
    where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.operationId, input.operationId)),
  });
  if (existing) return existing;
  const postedAt = input.postedAt ?? new Date();
  if (input.referenceType !== "ACCOUNTING_PERIOD_CLOSE") {
    await assertAccountingPeriodOpen(tx, ctx.tenantId, postedAt);
  }

  if (input.lines.length < 2) {
    throw new AppError("INTERNAL_ERROR", "A journal requires at least two entries (08 §11 INV-ACC-002)");
  }

  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const line of input.lines) {
    const hasDebit = line.debit !== undefined && toUnits(line.debit) !== 0n;
    const hasCredit = line.credit !== undefined && toUnits(line.credit) !== 0n;
    if (hasDebit === hasCredit) {
      throw new AppError("INTERNAL_ERROR", "Each journal line must have exactly one non-zero side (08 §11 INV-ACC-001)", { line });
    }
    totalDebit += toUnits(line.debit ?? "0");
    totalCredit += toUnits(line.credit ?? "0");
  }

  // Defense-in-depth invariant check (07 §13.3, 08 §11 INV-ACC-001) --
  // every wrapper below is constructed so this is structurally
  // unreachable; it exists so an unbalanced posting is refused rather
  // than silently corrupting the ledger if a future wrapper has a bug.
  if (totalDebit !== totalCredit) {
    throw new AppError("UNBALANCED_JOURNAL", "Journal entries must balance", {
      totalDebit: totalDebit.toString(),
      totalCredit: totalCredit.toString(),
    });
  }

  const [journal] = await tx
    .insert(journals)
    .values({
      tenantId: ctx.tenantId,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      operationId: input.operationId,
      createdBy: ctx.userId,
      postedAt,
    })
    .returning();
  if (!journal) throw new AppError("INTERNAL_ERROR", "Unable to post journal");

  for (const line of input.lines) {
    const accountId = await resolveAccountId(tx, ctx.tenantId, line.code);
    await tx.insert(journalEntries).values({
      tenantId: ctx.tenantId,
      journalId: journal.id,
      accountId,
      debit: line.debit ?? "0",
      credit: line.credit ?? "0",
    });
  }

  return journal;
}

// ---------------------------------------------------------------------
// Named posting rules -- one per 08 §5 subsection. Each is a thin,
// declarative translation of that subsection's Dr/Cr notation into
// JournalLine[]; none of them contain business validation (that stays
// in the calling Use Case) or insert directly (that stays in
// postJournal above).
// ---------------------------------------------------------------------

/**
 * Sale Completed -- 08 §5.1. Posted as TWO journals sharing
 * referenceType='SALE'/referenceId=saleId, distinguished by
 * description, exactly as §5.1's own note specifies ("two separate
 * Journal rows are posted per sale"). Each half gets its own
 * operationId suffix so either can independently replay-guard.
 */
export async function postSaleJournal(
  tx: Database,
  ctx: TenantContext,
  params: {
    saleId: string;
    operationId: string;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    paidTotal: string;
    dueTotal: string;
    /** Sum of (quantity * unit cost) across stock-tracked lines only -- 09 §6.3. "0" for an all-service sale (no COGS journal posted in that case). */
    costOfLinesAtCost: string;
    postedAt?: Date;
    /**
     * Asset account relieved by COGS. Default "1200" (Inventory). A Van
     * Sales field sale passes "1250" (Stock With Sales Reps): the goods
     * already left 1200 at issue (postRepIssueJournal), so relieving 1200
     * again would double-count -- Decision VAN-012 (30 §4.3/§7.5).
     */
    inventoryAccountCode?: "1200" | "1250";
  },
) {
  const revenueLines: JournalLine[] = [];
  if (toUnits(params.paidTotal) > 0n) revenueLines.push({ code: "1000", debit: params.paidTotal });
  if (toUnits(params.dueTotal) > 0n) revenueLines.push({ code: "1100", debit: params.dueTotal });
  if (toUnits(params.discountTotal) > 0n) revenueLines.push({ code: "5100", debit: params.discountTotal });
  revenueLines.push({ code: "4000", credit: params.subtotal });
  if (toUnits(params.taxTotal) > 0n) revenueLines.push({ code: "2100", credit: params.taxTotal });

  const revenueJournal = await postJournal(tx, ctx, {
    referenceType: "SALE",
    referenceId: params.saleId,
    operationId: deterministicSubOperationId(params.operationId, "revenue"),
    description: "Sale revenue recognition",
    postedAt: params.postedAt,
    lines: revenueLines,
  });

  if (toUnits(params.costOfLinesAtCost) > 0n) {
    await postJournal(tx, ctx, {
      referenceType: "SALE",
      referenceId: params.saleId,
      operationId: deterministicSubOperationId(params.operationId, "cogs"),
      description: "Sale cost of goods sold",
      postedAt: params.postedAt,
      lines: [
        { code: "5000", debit: params.costOfLinesAtCost },
        { code: params.inventoryAccountCode ?? "1200", credit: params.costOfLinesAtCost },
      ],
    });
  }

  return revenueJournal;
}

/** Purchase Received -- 08 §5.2. */
export async function postPurchaseJournal(
  tx: Database,
  ctx: TenantContext,
  params: { purchaseId: string; operationId: string; costTotal: string; paidTotal: string; dueTotal: string; postedAt?: Date },
) {
  const lines: JournalLine[] = [{ code: "1200", debit: params.costTotal }];
  if (toUnits(params.paidTotal) > 0n) lines.push({ code: "1010", credit: params.paidTotal });
  if (toUnits(params.dueTotal) > 0n) lines.push({ code: "2000", credit: params.dueTotal });

  return postJournal(tx, ctx, {
    referenceType: "PURCHASE",
    referenceId: params.purchaseId,
    operationId: params.operationId,
    description: "Purchase received",
    postedAt: params.postedAt,
    lines,
  });
}

/** Customer Payment Received -- 08 §5.3. */
export async function postCustomerPaymentJournal(
  tx: Database,
  ctx: TenantContext,
  params: { paymentId: string; operationId: string; amount: string; allocatedToReceivables: string; unallocated: string; method: string; postedAt?: Date },
) {
  const cashOrBank = params.method === "CASH" ? "1000" : "1010";
  const lines: JournalLine[] = [{ code: cashOrBank, debit: params.amount }];
  if (toUnits(params.allocatedToReceivables) > 0n) lines.push({ code: "1100", credit: params.allocatedToReceivables });
  if (toUnits(params.unallocated) > 0n) lines.push({ code: "2300", credit: params.unallocated });

  return postJournal(tx, ctx, {
    referenceType: "PAYMENT",
    referenceId: params.paymentId,
    operationId: params.operationId,
    description: "Customer payment received",
    postedAt: params.postedAt,
    lines,
  });
}

/** Refund an allocated customer payment as part of sale cancellation. */
export async function postCustomerSaleRefundJournal(
  tx: Database,
  ctx: TenantContext,
  params: { paymentId: string; operationId: string; amount: string; method: string },
) {
  const cashOrBank = params.method === "CASH" ? "1000" : "1010";
  return postJournal(tx, ctx, {
    referenceType: "PAYMENT",
    referenceId: params.paymentId,
    operationId: params.operationId,
    description: "Customer sale cancellation refund",
    lines: [
      { code: "1100", debit: params.amount },
      { code: cashOrBank, credit: params.amount },
    ],
  });
}

/** Supplier Payment Made -- 08 §5.4. */
export async function postSupplierPaymentJournal(
  tx: Database,
  ctx: TenantContext,
  params: { paymentId: string; operationId: string; amount: string; allocatedToPayables: string; unallocated: string; method: string; postedAt?: Date },
) {
  const cashOrBank = params.method === "CASH" ? "1000" : "1010";
  const lines: JournalLine[] = [];
  if (toUnits(params.allocatedToPayables) > 0n) lines.push({ code: "2000", debit: params.allocatedToPayables });
  if (toUnits(params.unallocated) > 0n) lines.push({ code: "1300", debit: params.unallocated });
  lines.push({ code: cashOrBank, credit: params.amount });

  return postJournal(tx, ctx, {
    referenceType: "PAYMENT",
    referenceId: params.paymentId,
    operationId: params.operationId,
    description: "Supplier payment made",
    postedAt: params.postedAt,
    lines,
  });
}

/** Customer Return -- 08 §5.5. */
export async function postCustomerReturnJournal(
  tx: Database,
  ctx: TenantContext,
  params: {
    returnId: string;
    operationId: string;
    returnedSubtotal: string;
    returnedTax: string;
    returnedGrandTotal: string;
    returnedCostTotal: string;
    cashRefundAmount: string;
    receivableReductionAmount: string;
    postedAt?: Date;
    /**
     * Decision VAN-003 (30_MODULE_VAN_SALES.md §5.2) — the portion of
     * returnedCostTotal that is physically UNSELLABLE (damaged/expired
     * on return). Defaults to "0" — every EXISTING caller (Pharmacy,
     * Electronics, plain retail returns) is unaffected. When > 0, an
     * ADDITIONAL write-off journal posts immediately after the normal
     * "inventory reinstated" journal, netting that portion back OUT of
     * Inventory — the revenue-reversal journal above is UNCHANGED
     * either way, since the customer's money/credit effect doesn't
     * depend on physical condition.
     */
    unsellableCostTotal?: string;
  },
) {
  const settlementLines: JournalLine[] = [];
  if (toUnits(params.cashRefundAmount) > 0n) settlementLines.push({ code: "1000", credit: params.cashRefundAmount });
  if (toUnits(params.receivableReductionAmount) > 0n) settlementLines.push({ code: "1100", credit: params.receivableReductionAmount });
  const revenueJournal = await postJournal(tx, ctx, {
    referenceType: "RETURN",
    referenceId: params.returnId,
    operationId: deterministicSubOperationId(params.operationId, "revenue"),
    description: "Customer return -- revenue reversal",
    postedAt: params.postedAt,
    lines: [
      { code: "4000", debit: params.returnedSubtotal },
      ...(toUnits(params.returnedTax) > 0n ? [{ code: "2100", debit: params.returnedTax }] : []),
      ...settlementLines,
    ],
  });

  if (toUnits(params.returnedCostTotal) > 0n) {
    await postJournal(tx, ctx, {
      referenceType: "RETURN",
      referenceId: params.returnId,
      operationId: deterministicSubOperationId(params.operationId, "cogs"),
      description: "Customer return -- inventory reinstated",
      postedAt: params.postedAt,
      lines: [
        { code: "1200", debit: params.returnedCostTotal },
        { code: "5000", credit: params.returnedCostTotal },
      ],
    });
  }

  const unsellableCostTotal = params.unsellableCostTotal ?? "0";
  if (toUnits(unsellableCostTotal) > 0n) {
    await postJournal(tx, ctx, {
      referenceType: "RETURN",
      referenceId: params.returnId,
      operationId: deterministicSubOperationId(params.operationId, "writeoff"),
      description: "Customer return -- unsellable write-off",
      postedAt: params.postedAt,
      lines: [
        { code: "5500", debit: unsellableCostTotal },
        { code: "1200", credit: unsellableCostTotal },
      ],
    });
  }

  return revenueJournal;
}

/**
 * Field-Rep Stock Issue -- 30_MODULE_VAN_SALES.md §4.2 step 8 /
 * Decision VAN-005. A CUSTODY TRANSFER, not a sale and not an expense:
 *
 *   Dr  Stock With Sales Reps (1250)   costTotal
 *       Cr  Inventory (1200)            costTotal
 *
 * Inventory is credited (leaves warehouse on-hand) but the value is
 * NOT expensed -- it moves to a sibling ASSET account, because the
 * tenant still owns the goods; the rep merely holds physical custody
 * until sold (SALE) or returned (RETURN_GOOD/DAMAGED/EXPIRED) against
 * modules.rep_stock_assignments. This is the accounting-layer mirror
 * of Decision VAN-001's "a rep's custody is never conflated with
 * warehouse on-hand stock" -- here applied to the LEDGER side of that
 * same distinction, not just the movement-ledger side.
 */
export async function postRepIssueJournal(
  tx: Database,
  ctx: TenantContext,
  params: { assignmentId: string; operationId: string; costTotal: string; postedAt?: Date },
) {
  // Guard mirrors postSaleJournal's COGS-block guard above: a
  // zero-cost issue (free-sample item, or an item whose cost basis is
  // genuinely 0) has no ledger effect to record -- posting it would
  // violate postJournal's "exactly one non-zero side" invariant
  // (08 §11 INV-ACC-001), not because the stock movement itself is
  // skipped (it isn't -- see IssueRepStockUseCase, which posts the
  // stock movements regardless of cost).
  if (toUnits(params.costTotal) <= 0n) return undefined;
  return postJournal(tx, ctx, {
    referenceType: "REP_STOCK_ASSIGNMENT",
    referenceId: params.assignmentId,
    operationId: params.operationId,
    description: "Field-rep stock issue -- custody transfer",
    postedAt: params.postedAt,
    lines: [
      { code: "1250", debit: params.costTotal },
      { code: "1200", credit: params.costTotal },
    ],
  });
}

/**
 * Custody Write-Off (Flow 1) -- 30_MODULE_VAN_SALES.md §5.1 step 3 / §7.3.
 *
 *   Dr  Inventory Shrinkage/Expiry Expense (5500)   costTotal
 *       Cr  Stock With Sales Reps (1250)             costTotal
 *
 * 1250 is credited, NOT 1200: the value already left Inventory at issue time. costTotal must be
 * computed from the assignment-line unit-cost snapshot (Decision VAN-014). NO revenue journal is
 * posted -- the goods were never sold (30 §10 "Flow 1 vs Flow 2").
 */
export async function postCustodyWriteOffJournal(
  tx: Database,
  ctx: TenantContext,
  params: { assignmentId: string; operationId: string; costTotal: string; postedAt?: Date },
) {
  if (toUnits(params.costTotal) <= 0n) return undefined; // zero-cost write-off: no ledger effect (INV-ACC-001)
  return postJournal(tx, ctx, {
    referenceType: "REP_STOCK_ASSIGNMENT",
    referenceId: params.assignmentId,
    operationId: params.operationId,
    description: "Field-rep custody write-off -- damaged/expired",
    postedAt: params.postedAt,
    lines: [
      { code: "5500", debit: params.costTotal },
      { code: "1250", credit: params.costTotal },
    ],
  });
}

/** Supplier Return -- 08 §5.6. */
export async function postSupplierReturnJournal(
  tx: Database,
  ctx: TenantContext,
  params: {
    returnId: string;
    operationId: string;
    returnedCostTotal: string;
    supplierRefundAmount: string;
    payableReductionAmount: string;
    postedAt?: Date;
  },
) {
  const settlementLines: JournalLine[] = [];
  if (toUnits(params.supplierRefundAmount) > 0n) settlementLines.push({ code: "1010", debit: params.supplierRefundAmount });
  if (toUnits(params.payableReductionAmount) > 0n) settlementLines.push({ code: "2000", debit: params.payableReductionAmount });
  return postJournal(tx, ctx, {
    referenceType: "RETURN",
    referenceId: params.returnId,
    operationId: params.operationId,
    description: "Supplier return",
    postedAt: params.postedAt,
    lines: [
      ...settlementLines,
      { code: "1200", credit: params.returnedCostTotal },
    ],
  });
}

/**
 * Expense Recorded -- 08 5.7, Decision EXP-001/EXP-003.
 *   Dr <Expense Category Account>   amount
 *       Cr Cash (1000) / Bank (1010) amount
 * `categoryAccountCode` is the code of the account the expense category maps
 * to; `postedAt` is the expense's accounting date.
 */
export async function postExpenseJournal(
  tx: Database,
  ctx: TenantContext,
  params: { expenseId: string; operationId: string; amount: string; categoryAccountCode: string; paidVia: "CASH" | "BANK"; postedAt: Date; description: string },
) {
  const settlement = params.paidVia === "CASH" ? "1000" : "1010";
  return postJournal(tx, ctx, {
    referenceType: "EXPENSE",
    referenceId: params.expenseId,
    operationId: params.operationId,
    description: params.description,
    postedAt: params.postedAt,
    lines: [
      { code: params.categoryAccountCode, debit: params.amount },
      { code: settlement, credit: params.amount },
    ],
  });
}

/**
 * Reversal -- 08 5.9 / 07 13.4, Decision EXP-005. THE only code path allowed to
 * generate a reversal: it reads the original journal's entries and swaps
 * debit/credit mechanically on the SAME accounts (account ids, not codes) --
 * never recalculated from current business state, so the reversal is exact even
 * if posting rules have changed since (INV-ACC-006: original + reversal net to
 * zero per account).
 *
 *   referenceType = 'REVERSAL', referenceId = original journal id.
 *   postedAt defaults to the ORIGINAL's date (an exact mirror, so the original
 *   period nets to zero); a caller may pass another date. When period closing
 *   (INV-ACC-005) is built, a reversal into a closed period must use the first
 *   open date instead.
 *
 * Refused: a journal that is itself a reversal (re-post the business event
 * instead). A second reversal of the same journal is rejected by the unique
 * index journals_one_reversal_per_original (surfaces as a 23505 to the caller).
 * Idempotent on operationId (replay returns the existing reversal journal).
 */
export async function postReversalJournal(
  tx: Database,
  ctx: TenantContext,
  params: { originalJournalId: string; operationId: string; reason: string; postedAt?: Date },
) {
  const replay = await tx.query.journals.findFirst({ where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.operationId, params.operationId)) });
  if (replay) return replay;

  const original = await tx.query.journals.findFirst({ where: and(eq(journals.id, params.originalJournalId), eq(journals.tenantId, ctx.tenantId)) });
  if (!original) throw new AppError("RESOURCE_NOT_FOUND", "Journal to reverse not found");
  if (original.referenceType === "REVERSAL") {
    throw new AppError("VALIDATION_FAILED", "A reversal journal cannot itself be reversed; re-post the original business event instead");
  }

  const originalEntries = await tx.select().from(journalEntries).where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.journalId, original.id)));
  if (originalEntries.length < 2) throw new AppError("INTERNAL_ERROR", "Original journal has fewer than two entries (INV-ACC-002)");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`);
  const postedAt = await firstOpenAccountingDate(tx, ctx.tenantId, params.postedAt ?? original.postedAt);

  const [journal] = await tx
    .insert(journals)
    .values({
      tenantId: ctx.tenantId,
      referenceType: "REVERSAL",
      referenceId: original.id,
      description: `Reversal: ${params.reason}`,
      postedAt,
      operationId: params.operationId,
      createdBy: ctx.userId,
    })
    .returning();
  if (!journal) throw new AppError("INTERNAL_ERROR", "Unable to post reversal journal");

  await tx.insert(journalEntries).values(
    originalEntries.map((entry) => ({
      tenantId: ctx.tenantId,
      journalId: journal.id,
      accountId: entry.accountId,
      debit: entry.credit, // exact mirror: swap sides, same amounts
      credit: entry.debit,
    })),
  );
  return journal;
}
