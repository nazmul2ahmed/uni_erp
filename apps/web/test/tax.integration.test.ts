import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  accounts,
  branches,
  createOwnerDb,
  db,
  journalEntries,
  journals,
  memberships,
  purchaseItems,
  purchases,
  returnLines,
  returns,
  saleItems,
  sales,
  sessions,
  stockBalances,
  stockBatches,
  tenants,
  units,
  users,
  warehouses,
  withTenantTransaction,
} from "@erp/db";
import { createCustomerSchema, createItemSchema, createPurchaseSchema, createSaleSchema, createSupplierSchema } from "@erp/validation";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createItem } from "../lib/use-cases/item";
import { receivePurchase } from "../lib/use-cases/purchase";
import { completeSale } from "../lib/use-cases/sale";
import { createSupplier } from "../lib/use-cases/supplier";
import { createCustomer } from "../lib/use-cases/customer";
import { createTaxProfile } from "../lib/use-cases/tax-profile";
import { completeCustomerReturn, completeSupplierReturn } from "../lib/use-cases/returns";
import { decimalToUnits } from "../lib/money";
import type { TenantContext } from "../lib/guard";

function sumMoney(values: Array<string | null>) {
  return values.reduce((total, value) => total + decimalToUnits(value ?? "0"), 0n);
}

describe("tenant tax profile posting", () => {
  let tenantId: string;
  let userId: string;
  let email: string;
  let ctx: TenantContext;
  let branchId: string;
  let warehouseId: string;
  let itemId: string;
  let sellingPrice: string;
  let profileId: string;
  let supplierId: string;
  let customerId: string;
  let purchaseId: string;
  let saleId: string;
  let fifoItemId: string;
  let fifoSaleId: string;

  beforeAll(async () => {
    email = `tax-owner-${crypto.randomUUID()}@example.test`;
    const registration = await registerOwnerAndTenant({
      email,
      password: "Tax-Integration-Password-2026!",
      fullName: "Tax Integration Owner",
      businessName: "Tax Integration Workspace",
    });
    tenantId = registration.tenantId;
    userId = registration.userId;
    const membership = await db.query.memberships.findFirst({
      where: eq(memberships.id, registration.membershipId),
    });
    if (!membership) throw new Error("Unable to load tax integration membership");
    ctx = {
      requestId: crypto.randomUUID(),
      userId,
      tenantId,
      membershipId: membership.id,
      roleId: membership.roleId,
      storageMode: "SHARED",
      permissions: await resolvePermissions(membership.roleId),
      roleKey: await resolveRoleKey(membership.roleId),
    };

    const references = await withTenantTransaction(tenantId, async (tx) => {
      const branch = await tx.query.branches.findFirst({ where: eq(branches.tenantId, tenantId) });
      const warehouse = await tx.query.warehouses.findFirst({ where: eq(warehouses.tenantId, tenantId) });
      const unit = await tx.query.units.findFirst({ where: eq(units.tenantId, tenantId) });
      if (!branch || !warehouse || !unit) throw new Error("Tax integration workspace defaults are incomplete");
      return { branch, warehouse, unit };
    });
    branchId = references.branch.id;
    warehouseId = references.warehouse.id;

    const taxProfile = await createTaxProfile(ctx, { name: `Standard-${crypto.randomUUID()}`, rate: "10" });
    profileId = taxProfile.id;
    const [supplier, customer, item] = await Promise.all([
      createSupplier(ctx, createSupplierSchema.parse({ name: `Tax Supplier ${crypto.randomUUID()}` })),
      createCustomer(ctx, createCustomerSchema.parse({ type: "INDIVIDUAL", name: `Tax Customer ${crypto.randomUUID()}` })),
      createItem(ctx, createItemSchema.parse({
        name: `Tax Item ${crypto.randomUUID()}`,
        type: "PRODUCT",
        unitId: references.unit.id,
        purchasePrice: "100",
        sellingPrice: "200",
        stockTracked: true,
        taxProfileId: profileId,
      })),
    ]);
    itemId = item.id;
    sellingPrice = item.sellingPrice;
    supplierId = supplier.id;
    customerId = customer.id;

    const purchase = await receivePurchase(ctx, createPurchaseSchema.parse({
      supplierId: supplier.id,
      branchId,
      lines: [{
        itemId,
        quantity: "2",
        costPrice: "100",
        lineDiscount: "0",
        warehouseId,
      }],
      orderDiscount: "10",
      cashPaid: "0",
    }), crypto.randomUUID());
    purchaseId = purchase.id;

    const sale = await completeSale(ctx, createSaleSchema.parse({
      customerId: null,
      branchId,
      lines: [{
        itemId,
        quantity: "1",
        unitPrice: sellingPrice,
        lineDiscount: "10",
        warehouseId,
      }],
      orderDiscount: "10",
      cashReceived: "198",
    }), crypto.randomUUID());
    saleId = sale.id;

    const fifoItem = await createItem(ctx, createItemSchema.parse({
      name: `Tax FIFO Item ${crypto.randomUUID()}`,
      type: "PRODUCT",
      unitId: references.unit.id,
      purchasePrice: "100",
      sellingPrice: "200",
      stockTracked: true,
      batchTracked: true,
      taxProfileId: profileId,
    }));
    fifoItemId = fifoItem.id;
    await receivePurchase(ctx, createPurchaseSchema.parse({
      supplierId,
      branchId,
      lines: ["FIFO-A", "FIFO-B"].map((batchNumber) => ({
        itemId: fifoItemId,
        quantity: "1",
        costPrice: "100",
        lineDiscount: "0",
        batchNumber: `${batchNumber}-${crypto.randomUUID()}`,
        warehouseId,
      })),
      orderDiscount: "10",
      cashPaid: "0",
    }), crypto.randomUUID());
    const fifoSale = await completeSale(ctx, createSaleSchema.parse({
      customerId,
      branchId,
      lines: [{
        itemId: fifoItemId,
        quantity: "1.5",
        unitPrice: fifoItem.sellingPrice,
        lineDiscount: "10",
        warehouseId,
      }],
      orderDiscount: "10",
      cashReceived: "308",
    }), crypto.randomUUID());
    fifoSaleId = fifoSale.id;
  }, 30_000);

  afterAll(async () => {
    if (!tenantId) return;
    const owner = createOwnerDb();
    try {
      await owner.db.delete(sessions).where(eq(sessions.userId, userId));
      await owner.db.delete(tenants).where(eq(tenants.id, tenantId));
      await owner.db.delete(users).where(and(eq(users.id, userId), eq(users.email, email)));
    } finally {
      await owner.close();
    }
  });

  it("capitalizes purchase tax, snapshots rates, and posts sale tax payable", async () => {
    const state = await withTenantTransaction(tenantId, async (tx) => {
      const purchase = await tx.query.purchases.findFirst({ where: eq(purchases.id, purchaseId) });
      const purchaseLine = await tx.query.purchaseItems.findFirst({ where: eq(purchaseItems.purchaseId, purchaseId) });
      const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId) });
      const saleLine = await tx.query.saleItems.findFirst({ where: eq(saleItems.saleId, saleId) });
      const balance = await tx.query.stockBalances.findFirst({
        where: and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.itemId, itemId), eq(stockBalances.warehouseId, warehouseId)),
      });
      const postedLines = await tx.select({
        code: accounts.code,
        debit: journalEntries.debit,
        credit: journalEntries.credit,
      }).from(journalEntries)
        .innerJoin(journals, eq(journals.id, journalEntries.journalId))
        .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
        .where(and(eq(journals.tenantId, tenantId), eq(journals.referenceId, saleId)));
      const fifoSale = await tx.query.sales.findFirst({ where: eq(sales.id, fifoSaleId) });
      const fifoSaleLines = await tx.query.saleItems.findMany({ where: eq(saleItems.saleId, fifoSaleId) });
      const fifoBatches = await tx.query.stockBatches.findMany({
        where: and(eq(stockBatches.tenantId, tenantId), eq(stockBatches.itemId, fifoItemId)),
      });
      const fifoCogs = await tx.select({
        code: accounts.code,
        debit: journalEntries.debit,
        credit: journalEntries.credit,
      }).from(journalEntries)
        .innerJoin(journals, eq(journals.id, journalEntries.journalId))
        .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
        .where(and(eq(journals.tenantId, tenantId), eq(journals.referenceId, fifoSaleId), eq(accounts.code, "5000")));
      return { purchase, purchaseLine, sale, saleLine, balance, postedLines, fifoSale, fifoSaleLines, fifoBatches, fifoCogs };
    });

    expect(state.purchase?.subtotal).toBe("200.0000");
    expect(state.purchase?.discountTotal).toBe("10.0000");
    expect(state.purchase?.taxTotal).toBe("19.0000");
    expect(state.purchase?.grandTotal).toBe("209.0000");
    expect(state.purchaseLine).toMatchObject({ taxProfileId: profileId, taxRate: "10.0000", taxAmount: "19.0000" });
    expect(state.balance?.quantityOnHand).toBe("1.0000");
    expect(state.balance?.weightedAvgCost).toBe("104.5000");

    expect(state.sale?.subtotal).toBe("200.0000");
    expect(state.sale?.discountTotal).toBe("20.0000");
    expect(state.sale?.taxTotal).toBe("18.0000");
    expect(state.sale?.grandTotal).toBe("198.0000");
    expect(state.saleLine).toMatchObject({ taxProfileId: profileId, taxRate: "10.0000", taxAmount: "18.0000" });
    expect(state.postedLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "1000", debit: "198.0000", credit: "0.0000" }),
      expect.objectContaining({ code: "5100", debit: "20.0000", credit: "0.0000" }),
      expect.objectContaining({ code: "4000", debit: "0.0000", credit: "200.0000" }),
      expect.objectContaining({ code: "2100", debit: "0.0000", credit: "18.0000" }),
      expect.objectContaining({ code: "5000", debit: "104.5000", credit: "0.0000" }),
      expect.objectContaining({ code: "1200", debit: "0.0000", credit: "104.5000" }),
    ]));
    expect(state.postedLines.reduce((sum, row) => sum + Number(row.debit), 0))
      .toBe(state.postedLines.reduce((sum, row) => sum + Number(row.credit), 0));
    expect(state.fifoSale?.taxTotal).toBe("28.0000");
    expect(state.fifoSale?.grandTotal).toBe("308.0000");
    expect(state.fifoSaleLines).toHaveLength(2);
    expect(state.fifoSaleLines.reduce((sum, row) => sum + Number(row.taxAmount), 0)).toBe(28);
    expect(state.fifoBatches.map((batch) => batch.costPrice)).toEqual(["104.5000", "104.5000"]);
    expect(state.fifoCogs.reduce((sum, row) => sum + Number(row.debit), 0)).toBe(156.75);
  });

  it("reverses customer return tax and discounts across partial returns", async () => {
    const source = await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findFirst({
      where: and(eq(saleItems.saleId, fifoSaleId), eq(saleItems.quantity, "0.5000")),
    }));
    if (!source) throw new Error("Expected the FIFO sale to have a half-quantity source line");
    expect(source.orderDiscountAllocation).toBeTruthy();

    const first = await completeCustomerReturn(ctx, {
      saleId: fifoSaleId,
      warehouseId,
      lines: [{ sourceLineId: source.id, quantity: "0.25" }],
    }, crypto.randomUUID());
    const second = await completeCustomerReturn(ctx, {
      saleId: fifoSaleId,
      warehouseId,
      lines: [{ sourceLineId: source.id, quantity: "0.25" }],
    }, crypto.randomUUID());

    const result = await withTenantTransaction(tenantId, async (tx) => {
      const sourceNetUnits = decimalToUnits(source.lineTotal)
        - decimalToUnits(source.taxAmount)
        - decimalToUnits(source.orderDiscountAllocation);
      const sourceTaxUnits = decimalToUnits(source.taxAmount);
      const returned = await tx.query.returns.findMany({
        where: and(eq(returns.tenantId, tenantId), eq(returns.saleId, fifoSaleId)),
      });
      const lines = await tx.query.returnLines.findMany({
        where: and(eq(returnLines.tenantId, tenantId), eq(returnLines.saleItemId, source.id)),
      });
      const postedLines = await tx.select({
        code: accounts.code,
        debit: journalEntries.debit,
        credit: journalEntries.credit,
        referenceId: journals.referenceId,
      }).from(journalEntries)
        .innerJoin(journals, eq(journals.id, journalEntries.journalId))
        .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
        .where(and(
          eq(journals.tenantId, tenantId),
          eq(journals.referenceType, "RETURN"),
          inArray(journals.referenceId, [first.id, second.id]),
        ));
      return { sourceNetUnits, sourceTaxUnits, returned, lines, postedLines };
    });
    const pair = result.returned.filter((row) => row.id === first.id || row.id === second.id);
    const pairLines = result.lines.filter((row) => row.returnId === first.id || row.returnId === second.id);
    expect(sumMoney(pair.map((row) => row.subtotal))).toBe(result.sourceNetUnits);
    expect(sumMoney(pair.map((row) => row.taxTotal))).toBe(result.sourceTaxUnits);
    expect(sumMoney(pair.map((row) => row.grandTotal))).toBe(result.sourceNetUnits + result.sourceTaxUnits);
    expect(sumMoney(pairLines.map((row) => row.taxAmount))).toBe(result.sourceTaxUnits);
    expect(sumMoney(result.postedLines.filter((row) => row.code === "2100").map((row) => row.debit)))
      .toBe(sumMoney(pair.map((row) => row.taxTotal)));
    expect(sumMoney(result.postedLines.filter((row) => row.code === "4000").map((row) => row.debit)))
      .toBe(sumMoney(pair.map((row) => row.subtotal)));
    expect(sumMoney(result.postedLines.filter((row) => row.code === "1000").map((row) => row.credit)))
      .toBe(sumMoney(pair.map((row) => row.grandTotal)));
    for (const returnId of [first.id, second.id]) {
      const returnJournalLines = result.postedLines.filter((row) => row.referenceId === returnId);
      expect(sumMoney(returnJournalLines.map((row) => row.debit)))
        .toBe(sumMoney(returnJournalLines.map((row) => row.credit)));
    }
  });

  it("returns supplier inventory cost with its allocated discount and capitalized tax", async () => {
    const source = await withTenantTransaction(tenantId, (tx) => tx.query.purchaseItems.findFirst({
      where: eq(purchaseItems.purchaseId, purchaseId),
    }));
    if (!source) throw new Error("Expected a purchase source line");

    const result = await completeSupplierReturn(ctx, {
      purchaseId,
      warehouseId,
      lines: [{ sourceLineId: source.id, quantity: "1" }],
    }, crypto.randomUUID());

    expect(result).toMatchObject({ subtotal: "95.0000", taxTotal: "9.5000", grandTotal: "104.5000" });
    const line = await withTenantTransaction(tenantId, (tx) => tx.query.returnLines.findFirst({
      where: eq(returnLines.returnId, result.id),
    }));
    expect(line).toMatchObject({ lineTotal: "104.5000", taxAmount: "9.5000" });
  });
});
