import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accounts,
  openingBalances,
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
import { postCustomerPaymentJournal, postSupplierPaymentJournal } from "../accounting";
import { recordAudit } from "../audit";

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
type PaymentTarget = { id: string; amount: string; paidAmount: string; balance: string; status: string; opening: boolean; dueDate: string | null; createdAt: Date };

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
    const openingRows = await tx.query.openingBalances.findMany({
      where: and(
        eq(openingBalances.tenantId, ctx.tenantId),
        partyType === "CUSTOMER" ? eq(openingBalances.customerId, partyId) : eq(openingBalances.supplierId, partyId),
        eq(openingBalances.entryType, partyType === "CUSTOMER" ? "CUSTOMER_RECEIVABLE" : "SUPPLIER_PAYABLE"),
        inArray(openingBalances.status, ["OPEN", "PARTIAL"]),
      ),
    });
    const invoiceRows: PaymentTarget[] = partyType === "CUSTOMER"
      ? (await tx.query.receivables.findMany({ where: and(eq(receivables.tenantId, ctx.tenantId), eq(receivables.customerId, partyId), inArray(receivables.status, ["OPEN", "PARTIAL"])) }))
          .flatMap((row) => row.saleId ? [{ id: row.saleId, amount: row.amount, paidAmount: row.paidAmount, balance: row.balance, status: row.status, opening: false, dueDate: row.dueDate, createdAt: row.createdAt }] : [])
      : (await tx.query.payables.findMany({ where: and(eq(payables.tenantId, ctx.tenantId), eq(payables.supplierId, partyId), inArray(payables.status, ["OPEN", "PARTIAL"])) }))
          .map((row) => ({ id: row.purchaseId, amount: row.amount, paidAmount: row.paidAmount, balance: row.balance, status: row.status, opening: false, dueDate: row.dueDate, createdAt: row.createdAt }));
    const openingTargets: PaymentTarget[] = openingRows.map((row) => ({
      id: row.id, amount: row.amount, paidAmount: row.paidAmount, balance: row.balance, status: row.status, opening: true, dueDate: row.dueDate, createdAt: row.createdAt,
    }));
    const openRows = [...invoiceRows, ...openingTargets].sort((left, right) =>
      (left.dueDate ? Date.parse(`${left.dueDate}T00:00:00Z`) : left.createdAt.getTime())
      - (right.dueDate ? Date.parse(`${right.dueDate}T00:00:00Z`) : right.createdAt.getTime())
      || left.id.localeCompare(right.id),
    );
    const byTarget = new Map(openRows.map((row) => [row.id, row]));
    const allocations: Allocation[] = [];
    let remaining = moneyUnits(input.amount);
    const candidates = requestedAllocations.length > 0
      ? requestedAllocations.map((allocation) => ({
          id: allocation.openingBalanceId ?? ("saleId" in allocation ? allocation.saleId : "purchaseId" in allocation ? allocation.purchaseId : undefined)!,
          amount: allocation.amount,
        }))
      : (() => {
          let available = remaining;
          return openRows.flatMap((row) => {
            if (available <= 0n) return [];
            const balance = moneyUnits(row.balance);
            const allocation = balance < available ? balance : available;
            available -= allocation;
            return [{ id: row.id, amount: decimal(allocation) }];
          });
        })();

    for (const candidate of candidates) {
      const target = byTarget.get(candidate.id);
      if (!target) throw new AppError("RESOURCE_NOT_FOUND", "Payment allocation target not found or already settled");
      const amount = moneyUnits(candidate.amount);
      const balance = moneyUnits(target.balance);
      if (amount <= 0n || amount > balance || amount > remaining) throw new AppError("VALIDATION_FAILED", "Payment allocation exceeds the outstanding balance");
      allocations.push({ id: candidate.id, amount: candidate.amount });
      remaining -= amount;
    }

    const invoiceAllocations = allocations.filter((allocation) => !byTarget.get(allocation.id)?.opening);
    const openingAllocations = allocations.filter((allocation) => byTarget.get(allocation.id)?.opening);
    if (partyType === "CUSTOMER" && invoiceAllocations.length > 0) {
      const targetIds = [...new Set(invoiceAllocations.map((allocation) => allocation.id))].sort();
      const lockedSales = await tx.select({ id: sales.id, status: sales.status })
        .from(sales)
        .where(and(eq(sales.tenantId, ctx.tenantId), inArray(sales.id, targetIds)))
        .orderBy(asc(sales.id))
        .for("update");
      if (lockedSales.length !== targetIds.length) {
        throw new AppError("RESOURCE_NOT_FOUND", "Payment allocation target not found");
      }
      if (lockedSales.some((sale) => sale.status === "CANCELLED")) {
        throw new AppError("VALIDATION_FAILED", "Payments cannot be allocated to a cancelled sale");
      }
      const lockedReceivables = await tx.select().from(receivables)
        .where(and(
          eq(receivables.tenantId, ctx.tenantId),
          eq(receivables.customerId, partyId),
          inArray(receivables.saleId, targetIds),
        ))
        .orderBy(asc(receivables.saleId))
        .for("update");
      const receivableBySale = new Map(lockedReceivables.flatMap((row) => row.saleId ? [[row.saleId, row] as const] : []));
      const requestedBySale = new Map<string, bigint>();
      for (const allocation of invoiceAllocations) {
        const target = receivableBySale.get(allocation.id);
        if (!target || !["OPEN", "PARTIAL"].includes(target.status)) {
          throw new AppError("RESOURCE_NOT_FOUND", "Payment allocation target not found or already settled");
        }
        const requested = (requestedBySale.get(allocation.id) ?? 0n) + moneyUnits(allocation.amount);
        if (requested > moneyUnits(target.balance)) {
          throw new AppError("VALIDATION_FAILED", "Payment allocation exceeds the outstanding balance");
        }
        requestedBySale.set(allocation.id, requested);
        byTarget.set(allocation.id, { id: target.id, amount: target.amount, paidAmount: target.paidAmount, balance: target.balance, status: target.status, opening: false, dueDate: target.dueDate, createdAt: target.createdAt });
      }
    }
    if (partyType === "SUPPLIER" && invoiceAllocations.length > 0) {
      const targetIds = [...new Set(invoiceAllocations.map((allocation) => allocation.id))].sort();
      const lockedPurchases = await tx.select({ id: purchases.id })
        .from(purchases)
        .where(and(eq(purchases.tenantId, ctx.tenantId), inArray(purchases.id, targetIds)))
        .orderBy(asc(purchases.id))
        .for("update");
      if (lockedPurchases.length !== targetIds.length) {
        throw new AppError("RESOURCE_NOT_FOUND", "Payment allocation target not found");
      }
      const lockedPayables = await tx.select().from(payables)
        .where(and(
          eq(payables.tenantId, ctx.tenantId),
          eq(payables.supplierId, partyId),
          inArray(payables.purchaseId, targetIds),
        ))
        .orderBy(asc(payables.purchaseId))
        .for("update");
      const payableByPurchase = new Map(lockedPayables.map((row) => [row.purchaseId, row]));
      const requestedByPurchase = new Map<string, bigint>();
      for (const allocation of invoiceAllocations) {
        const target = payableByPurchase.get(allocation.id);
        if (!target || !["OPEN", "PARTIAL"].includes(target.status)) {
          throw new AppError("RESOURCE_NOT_FOUND", "Payment allocation target not found or already settled");
        }
        const requested = (requestedByPurchase.get(allocation.id) ?? 0n) + moneyUnits(allocation.amount);
        if (requested > moneyUnits(target.balance)) {
          throw new AppError("VALIDATION_FAILED", "Payment allocation exceeds the outstanding balance");
        }
        requestedByPurchase.set(allocation.id, requested);
        byTarget.set(allocation.id, { id: target.id, amount: target.amount, paidAmount: target.paidAmount, balance: target.balance, status: target.status, opening: false, dueDate: target.dueDate, createdAt: target.createdAt });
      }
    }
    if (openingAllocations.length > 0) {
      const targetIds = [...new Set(openingAllocations.map((allocation) => allocation.id))].sort();
      const locked = await tx.select().from(openingBalances)
        .where(and(eq(openingBalances.tenantId, ctx.tenantId), inArray(openingBalances.id, targetIds)))
        .orderBy(asc(openingBalances.id))
        .for("update");
      if (locked.length !== targetIds.length || locked.some((row) =>
        (partyType === "CUSTOMER" ? row.customerId : row.supplierId) !== partyId
        || row.entryType !== (partyType === "CUSTOMER" ? "CUSTOMER_RECEIVABLE" : "SUPPLIER_PAYABLE")
        || !["OPEN", "PARTIAL"].includes(row.status),
      )) throw new AppError("RESOURCE_NOT_FOUND", "Opening balance allocation target not found");
      const allocationTotals = new Map<string, bigint>();
      for (const allocation of openingAllocations) {
        allocationTotals.set(allocation.id, (allocationTotals.get(allocation.id) ?? 0n) + moneyUnits(allocation.amount));
      }
      for (const row of locked) {
        const requested = allocationTotals.get(row.id) ?? 0n;
        if (requested <= 0n || requested > moneyUnits(row.balance)) {
          throw new AppError("VALIDATION_FAILED", "Payment allocation exceeds the opening balance");
        }
        byTarget.set(row.id, { id: row.id, amount: row.amount, paidAmount: row.paidAmount, balance: row.balance, status: row.status, opening: true, dueDate: row.dueDate, createdAt: row.createdAt });
      }
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
      const isOpening = byTarget.get(allocation.id)?.opening === true;
      await tx.insert(paymentAllocations).values({
        tenantId: ctx.tenantId,
        paymentId: payment.id,
        allocatedToType: isOpening ? "OPENING_BALANCE" : partyType === "CUSTOMER" ? "SALE" : "PURCHASE",
        allocatedToId: allocation.id,
        amount: allocation.amount,
      });
      const target = byTarget.get(allocation.id)!;
      const paid = moneyUnits(target.paidAmount) + moneyUnits(allocation.amount);
      const balance = moneyUnits(target.amount) - paid;
      if (isOpening) {
        await tx.update(openingBalances).set({
          paidAmount: decimal(paid),
          balance: decimal(balance),
          status: balance === 0n ? "SETTLED" : "PARTIAL",
        }).where(and(eq(openingBalances.id, allocation.id), eq(openingBalances.tenantId, ctx.tenantId)));
        byTarget.set(allocation.id, { ...target, paidAmount: decimal(paid), balance: decimal(balance), status: balance === 0n ? "SETTLED" : "PARTIAL", opening: true });
      } else if (partyType === "CUSTOMER") {
        await tx.update(receivables).set({ paidAmount: decimal(paid), balance: decimal(balance), status: balance === 0n ? "SETTLED" : "PARTIAL", updatedAt: new Date() }).where(and(eq(receivables.id, target.id), eq(receivables.tenantId, ctx.tenantId)));
        await tx.update(sales).set({ paidTotal: decimal(paid), dueTotal: decimal(balance), status: balance === 0n ? "PAID" : "PARTIALLY_PAID", updatedAt: new Date() }).where(and(eq(sales.id, allocation.id), eq(sales.tenantId, ctx.tenantId)));
        byTarget.set(allocation.id, { ...target, paidAmount: decimal(paid), balance: decimal(balance), status: balance === 0n ? "SETTLED" : "PARTIAL" });
      } else {
        await tx.update(payables).set({ paidAmount: decimal(paid), balance: decimal(balance), status: balance === 0n ? "SETTLED" : "PARTIAL", updatedAt: new Date() }).where(and(eq(payables.id, target.id), eq(payables.tenantId, ctx.tenantId)));
        await tx.update(purchases).set({ paidTotal: decimal(paid), dueTotal: decimal(balance), status: balance === 0n ? "PAID" : "PARTIALLY_PAID", updatedAt: new Date() }).where(and(eq(purchases.id, allocation.id), eq(purchases.tenantId, ctx.tenantId)));
      }
    }

    const allocatedTotal = allocations.reduce((sum, allocation) => sum + moneyUnits(allocation.amount), 0n);
    const unallocated = moneyUnits(input.amount) - allocatedTotal;

    if (partyType === "CUSTOMER") {
      await postCustomerPaymentJournal(tx, ctx, {
        paymentId: payment.id,
        operationId,
        amount: payment.amount,
        allocatedToReceivables: decimal(allocatedTotal),
        unallocated: decimal(unallocated),
        method: input.method,
        postedAt: payment.paidAt,
      });
    } else {
      await postSupplierPaymentJournal(tx, ctx, {
        paymentId: payment.id,
        operationId,
        amount: payment.amount,
        allocatedToPayables: decimal(allocatedTotal),
        unallocated: decimal(unallocated),
        method: input.method,
        postedAt: payment.paidAt,
      });
    }

    await recordAudit(tx, ctx, {
      action: partyType === "CUSTOMER" ? "payment.customer.record" : "payment.supplier.record",
      entityType: "PAYMENT",
      entityId: payment.id,
      after: { amount: payment.amount, method: payment.method, direction: payment.direction },
    });

    return payment;
  });
}

export const recordCustomerPayment = (ctx: TenantContext, input: RecordCustomerPaymentInput, operationId: string) => recordPayment(ctx, input, operationId, "CUSTOMER");
export const recordSupplierPayment = (ctx: TenantContext, input: RecordSupplierPaymentInput, operationId: string) => recordPayment(ctx, input, operationId, "SUPPLIER");

export async function listReceivables(ctx: TenantContext, customerId?: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [invoices, openingRows] = await Promise.all([
      tx.query.receivables.findMany({ where: and(eq(receivables.tenantId, ctx.tenantId), customerId ? eq(receivables.customerId, customerId) : undefined), with: { customer: true, sale: true }, orderBy: [desc(receivables.createdAt)] }),
      tx.select({
        id: openingBalances.id,
        customerId: openingBalances.customerId,
        amount: openingBalances.amount,
        paidAmount: openingBalances.paidAmount,
        balance: openingBalances.balance,
        status: openingBalances.status,
        dueDate: openingBalances.dueDate,
        createdAt: openingBalances.createdAt,
        customerName: customers.name,
      }).from(openingBalances)
        .innerJoin(customers, eq(customers.id, openingBalances.customerId))
        .where(and(
          eq(openingBalances.tenantId, ctx.tenantId),
          eq(openingBalances.entryType, "CUSTOMER_RECEIVABLE"),
          customerId ? eq(openingBalances.customerId, customerId) : undefined,
        )),
    ]);
    return [
      ...invoices,
      ...openingRows.map(({ customerName, ...row }) => ({
        ...row,
        saleId: row.id,
        sale: null,
        customer: { name: customerName },
        source: "OPENING_BALANCE" as const,
      })),
    ];
  });
}

export async function listPayables(ctx: TenantContext, supplierId?: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [invoices, openingRows] = await Promise.all([
      tx.query.payables.findMany({ where: and(eq(payables.tenantId, ctx.tenantId), supplierId ? eq(payables.supplierId, supplierId) : undefined), with: { supplier: true, purchase: true }, orderBy: [desc(payables.createdAt)] }),
      tx.select({
        id: openingBalances.id,
        supplierId: openingBalances.supplierId,
        amount: openingBalances.amount,
        paidAmount: openingBalances.paidAmount,
        balance: openingBalances.balance,
        status: openingBalances.status,
        dueDate: openingBalances.dueDate,
        createdAt: openingBalances.createdAt,
        supplierName: suppliers.name,
      }).from(openingBalances)
        .innerJoin(suppliers, eq(suppliers.id, openingBalances.supplierId))
        .where(and(
          eq(openingBalances.tenantId, ctx.tenantId),
          eq(openingBalances.entryType, "SUPPLIER_PAYABLE"),
          supplierId ? eq(openingBalances.supplierId, supplierId) : undefined,
        )),
    ]);
    return [
      ...invoices,
      ...openingRows.map(({ supplierName, ...row }) => ({
        ...row,
        purchaseId: row.id,
        purchase: null,
        supplier: { name: supplierName },
        source: "OPENING_BALANCE" as const,
      })),
    ];
  });
}

export async function listFinancePayments(ctx: TenantContext, filters: SearchPaymentsQuery) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.payments.findMany({ where: and(eq(payments.tenantId, ctx.tenantId), filters.partyType ? eq(payments.partyType, filters.partyType) : undefined, filters.partyId ? eq(payments.partyId, filters.partyId) : undefined, filters.dateFrom ? gte(payments.paidAt, new Date(filters.dateFrom)) : undefined, filters.dateTo ? lte(payments.paidAt, new Date(filters.dateTo)) : undefined), orderBy: [desc(payments.paidAt)] }));
}

export async function getFinanceSummary(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [receivableRows, payableRows, openingRows, paymentRows, journalRows] = await Promise.all([
      tx.query.receivables.findMany({ where: eq(receivables.tenantId, ctx.tenantId) }),
      tx.query.payables.findMany({ where: eq(payables.tenantId, ctx.tenantId) }),
      tx.query.openingBalances.findMany({ where: and(eq(openingBalances.tenantId, ctx.tenantId), inArray(openingBalances.entryType, ["CUSTOMER_RECEIVABLE", "SUPPLIER_PAYABLE"])) }),
      tx.query.payments.findMany({ where: eq(payments.tenantId, ctx.tenantId) }),
      tx.select({ code: accounts.code, debit: journalEntries.debit, credit: journalEntries.credit }).from(journalEntries).innerJoin(journals, eq(journalEntries.journalId, journals.id)).innerJoin(accounts, eq(journalEntries.accountId, accounts.id)).where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journals.tenantId, ctx.tenantId), eq(accounts.tenantId, ctx.tenantId))),
    ]);
    const balanceFor = (code: string) => journalRows.filter((row) => row.code === code).reduce((sum, row) => sum + moneyUnits(row.debit) - moneyUnits(row.credit), 0n);
    return {
      receivables: decimal(receivableRows.reduce((sum, row) => sum + moneyUnits(row.balance), 0n) + openingRows.filter((row) => row.entryType === "CUSTOMER_RECEIVABLE").reduce((sum, row) => sum + moneyUnits(row.balance), 0n)),
      payables: decimal(payableRows.reduce((sum, row) => sum + moneyUnits(row.balance), 0n) + openingRows.filter((row) => row.entryType === "SUPPLIER_PAYABLE").reduce((sum, row) => sum + moneyUnits(row.balance), 0n)),
      cash: decimal(balanceFor("1000")),
      bank: decimal(balanceFor("1010")),
      paymentCount: paymentRows.length,
      journalCount: journalRows.length,
    };
  });
}

export async function listAccounts(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.accounts.findMany({ where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.isActive, true)), orderBy: [accounts.code] }));
}
