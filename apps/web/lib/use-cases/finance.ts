import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accounts,
  customers,
  journalEntries,
  journals,
  paymentAllocations,
  payments,
  payables,
  purchases,
  receivables,
  sales,
  suppliers,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { RecordCustomerPaymentInput, RecordSupplierPaymentInput, SearchPaymentsQuery } from "@erp/validation";
import type { TenantContext } from "../guard";

const moneyUnits = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 10000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
};

const decimal = (value: bigint): string => {
  const whole = value / 10000n;
  const fraction = (value % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

type Allocation = { id: string; amount: string };

async function recordPayment(
  ctx: TenantContext,
  input: RecordCustomerPaymentInput | RecordSupplierPaymentInput,
  operationId: string,
  partyType: "CUSTOMER" | "SUPPLIER",
) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const existing = await tx.query.payments.findFirst({ where: and(eq(payments.tenantId, ctx.tenantId), eq(payments.operationId, operationId)) });
    if (existing) return existing;

    const partyId = partyType === "CUSTOMER" ? ("customerId" in input ? input.customerId : "") : ("supplierId" in input ? input.supplierId : "");
    const party = partyType === "CUSTOMER"
      ? await tx.query.customers.findFirst({ where: and(eq(customers.id, partyId), eq(customers.tenantId, ctx.tenantId), eq(customers.isActive, true)) })
      : await tx.query.suppliers.findFirst({ where: and(eq(suppliers.id, partyId), eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.isActive, true)) });
    if (!party) throw new AppError("RESOURCE_NOT_FOUND", `${partyType === "CUSTOMER" ? "Customer" : "Supplier"} not found or inactive`);

    const requestedAllocations = input.allocations ?? [];
    const openRows = partyType === "CUSTOMER"
      ? (await tx.query.receivables.findMany({ where: and(eq(receivables.tenantId, ctx.tenantId), eq(receivables.customerId, partyId), inArray(receivables.status, ["OPEN", "PARTIAL"])) })).map((row) => ({ targetId: row.saleId, row }))
      : (await tx.query.payables.findMany({ where: and(eq(payables.tenantId, ctx.tenantId), eq(payables.supplierId, partyId), inArray(payables.status, ["OPEN", "PARTIAL"])) })).map((row) => ({ targetId: row.purchaseId, row }));
    const byTarget = new Map(openRows.map(({ targetId, row }) => [targetId, row]));
    const allocations: Allocation[] = [];
    let remaining = moneyUnits(input.amount);
    const candidates = requestedAllocations.length > 0
      ? requestedAllocations.map((allocation) => ({ id: "saleId" in allocation ? allocation.saleId : allocation.purchaseId, amount: allocation.amount }))
      : openRows.map(({ targetId, row }) => ({ id: targetId, amount: row.balance }));

    for (const candidate of candidates) {
      const target = byTarget.get(candidate.id);
      if (!target) throw new AppError("RESOURCE_NOT_FOUND", "Payment allocation target not found or already settled");
      const amount = moneyUnits(candidate.amount);
      const balance = moneyUnits(target.balance);
      if (amount <= 0n || amount > balance || amount > remaining) throw new AppError("VALIDATION_FAILED", "Payment allocation exceeds the outstanding balance");
      allocations.push({ id: target.id, amount: candidate.amount });
      remaining -= amount;
    }

    const [payment] = await tx.insert(payments).values({
      tenantId: ctx.tenantId,
      partyType,
      partyId,
      direction: partyType === "CUSTOMER" ? "IN" : "OUT",
      amount: input.amount,
      method: input.method,
      referenceNo: input.referenceNo,
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      operationId,
      createdBy: ctx.userId,
    }).returning();
    if (!payment) throw new AppError("INTERNAL_ERROR", "Unable to record payment");

    for (const allocation of allocations) {
      await tx.insert(paymentAllocations).values({ tenantId: ctx.tenantId, paymentId: payment.id, allocatedToType: partyType === "CUSTOMER" ? "SALE" : "PURCHASE", allocatedToId: allocation.id, amount: allocation.amount });
      const target = byTarget.get(allocation.id)!;
      const paid = moneyUnits(target.paidAmount) + moneyUnits(allocation.amount);
      const balance = moneyUnits(target.amount) - paid;
      if (partyType === "CUSTOMER") {
        await tx.update(receivables).set({ paidAmount: decimal(paid), balance: decimal(balance), status: balance === 0n ? "SETTLED" : "PARTIAL", updatedAt: new Date() }).where(and(eq(receivables.id, target.id), eq(receivables.tenantId, ctx.tenantId)));
        await tx.update(sales).set({ paidTotal: decimal(paid), dueTotal: decimal(balance), status: balance === 0n ? "PAID" : "PARTIALLY_PAID", updatedAt: new Date() }).where(and(eq(sales.id, allocation.id), eq(sales.tenantId, ctx.tenantId)));
      } else {
        await tx.update(payables).set({ paidAmount: decimal(paid), balance: decimal(balance), status: balance === 0n ? "SETTLED" : "PARTIAL", updatedAt: new Date() }).where(and(eq(payables.id, target.id), eq(payables.tenantId, ctx.tenantId)));
        await tx.update(purchases).set({ paidTotal: decimal(paid), dueTotal: decimal(balance), status: balance === 0n ? "PAID" : "PARTIALLY_PAID", updatedAt: new Date() }).where(and(eq(purchases.id, allocation.id), eq(purchases.tenantId, ctx.tenantId)));
      }
    }
    return payment;
  });
}

export const recordCustomerPayment = (ctx: TenantContext, input: RecordCustomerPaymentInput, operationId: string) => recordPayment(ctx, input, operationId, "CUSTOMER");
export const recordSupplierPayment = (ctx: TenantContext, input: RecordSupplierPaymentInput, operationId: string) => recordPayment(ctx, input, operationId, "SUPPLIER");

export async function listReceivables(ctx: TenantContext, customerId?: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.receivables.findMany({ where: and(eq(receivables.tenantId, ctx.tenantId), customerId ? eq(receivables.customerId, customerId) : undefined), with: { customer: true, sale: true }, orderBy: [desc(receivables.createdAt)] }));
}

export async function listPayables(ctx: TenantContext, supplierId?: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.payables.findMany({ where: and(eq(payables.tenantId, ctx.tenantId), supplierId ? eq(payables.supplierId, supplierId) : undefined), with: { supplier: true, purchase: true }, orderBy: [desc(payables.createdAt)] }));
}

export async function listFinancePayments(ctx: TenantContext, filters: SearchPaymentsQuery) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.payments.findMany({ where: and(eq(payments.tenantId, ctx.tenantId), filters.partyType ? eq(payments.partyType, filters.partyType) : undefined, filters.partyId ? eq(payments.partyId, filters.partyId) : undefined, filters.dateFrom ? gte(payments.paidAt, new Date(filters.dateFrom)) : undefined, filters.dateTo ? lte(payments.paidAt, new Date(filters.dateTo)) : undefined), orderBy: [desc(payments.paidAt)] }));
}

export async function getFinanceSummary(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [receivableRows, payableRows, paymentRows, journalRows] = await Promise.all([
      tx.query.receivables.findMany({ where: eq(receivables.tenantId, ctx.tenantId) }),
      tx.query.payables.findMany({ where: eq(payables.tenantId, ctx.tenantId) }),
      tx.query.payments.findMany({ where: eq(payments.tenantId, ctx.tenantId) }),
      tx.select({ code: accounts.code, debit: journalEntries.debit, credit: journalEntries.credit }).from(journalEntries).innerJoin(journals, eq(journalEntries.journalId, journals.id)).innerJoin(accounts, eq(journalEntries.accountId, accounts.id)).where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journals.tenantId, ctx.tenantId), eq(accounts.tenantId, ctx.tenantId))),
    ]);
    const balanceFor = (code: string) => journalRows.filter((row) => row.code === code).reduce((sum, row) => sum + moneyUnits(row.debit) - moneyUnits(row.credit), 0n);
    return { receivables: decimal(receivableRows.reduce((sum, row) => sum + moneyUnits(row.balance), 0n)), payables: decimal(payableRows.reduce((sum, row) => sum + moneyUnits(row.balance), 0n)), cash: decimal(balanceFor("1000")), bank: decimal(balanceFor("1010")), paymentCount: paymentRows.length, journalCount: journalRows.length };
  });
}

export async function listAccounts(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.accounts.findMany({ where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.isActive, true)), orderBy: [accounts.code] }));
}
