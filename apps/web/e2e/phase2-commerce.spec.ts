import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { createOwnerDb, db, memberships, sessions, stockBalances, stockMovements, tenants, users, withTenantTransaction } from "@erp/db";
import { createCustomerSchema, createItemSchema, createSupplierSchema } from "@erp/validation";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createCustomer } from "../lib/use-cases/customer";
import { createItem } from "../lib/use-cases/item";
import { createSupplier } from "../lib/use-cases/supplier";
import type { TenantContext } from "../lib/guard";

const email = `phase2-e2e-${crypto.randomUUID()}@example.test`;
const password = "Phase2-E2E-Password-2026!";
const supplierName = `Phase 2 Supplier ${crypto.randomUUID()}`;
const customerName = `Phase 2 Customer ${crypto.randomUUID()}`;
const itemName = `Phase 2 Item ${crypto.randomUUID()}`;

let tenantId: string;
let userId: string;
let supplierId: string;
let customerId: string;
let itemId: string;
let warehouseId: string;

test.beforeAll(async () => {
  const registration = await registerOwnerAndTenant({
    email,
    password,
    fullName: "Phase 2 E2E Owner",
    businessName: `Phase 2 E2E Workspace ${crypto.randomUUID()}`,
  });
  tenantId = registration.tenantId;
  userId = registration.userId;

  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.id, registration.membershipId),
  });
  if (!membership) throw new Error("Unable to load Phase 2 E2E owner membership");
  const ctx: TenantContext = {
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
    const branch = await tx.query.branches.findFirst({ where: (row, { eq: equals }) => equals(row.tenantId, tenantId) });
    const warehouse = await tx.query.warehouses.findFirst({ where: (row, { eq: equals }) => equals(row.tenantId, tenantId) });
    const unit = await tx.query.units.findFirst({ where: (row, { eq: equals }) => equals(row.tenantId, tenantId) });
    if (!branch || !warehouse || !unit) throw new Error("Phase 2 E2E workspace defaults are incomplete");
    return { branch, warehouse, unit };
  });
  warehouseId = references.warehouse.id;

  const [supplier, customer, item] = await Promise.all([
    createSupplier(ctx, createSupplierSchema.parse({ name: supplierName })),
    createCustomer(ctx, createCustomerSchema.parse({ name: customerName })),
    createItem(ctx, createItemSchema.parse({
      name: itemName,
      type: "PRODUCT",
      unitId: references.unit.id,
      purchasePrice: "200",
      sellingPrice: "500",
      stockTracked: true,
    })),
  ]);
  supplierId = supplier.id;
  customerId = customer.id;
  itemId = item.id;
});

test.afterAll(async () => {
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

test("purchase, POS sale, later customer payment, due settlement, and P&L work through the UI", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/purchases/new");
  await page.getByLabel("Supplier *").selectOption(supplierId);
  await page.locator("label").filter({ hasText: "Item *" }).locator("select").selectOption(itemId);
  await page.getByLabel("Warehouse *").selectOption(warehouseId);
  await page.getByLabel("Quantity *").fill("10");
  await page.getByLabel("Cost *").fill("200");
  await page.getByLabel("Paid at receipt").fill("0");
  await page.getByRole("button", { name: "Receive purchase" }).click();
  await expect(page).toHaveURL(/\/purchases$/);
  await expect(page.getByText(supplierName)).toBeVisible();

  await page.goto("/sales/new");
  await page.getByPlaceholder("Search customer").fill(customerName);
  await page.locator("label").filter({ hasText: "Customer" }).locator("select").selectOption(customerId);
  await page.getByPlaceholder("Search item").fill(itemName);
  await page.locator("label").filter({ hasText: "Item *" }).locator("select").selectOption(itemId);
  await page.getByLabel("Warehouse *").selectOption(warehouseId);
  await page.getByLabel("Qty *").fill("4");
  await page.getByLabel("Paid").fill("500");
  const saleResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/sales") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Complete sale" }).click();
  const salePayload = await (await saleResponse).json();
  expect(salePayload.success).toBeTruthy();
  const saleId = salePayload.data.id as string;
  await expect(page.getByText("BDT 1500.00", { exact: false })).toBeVisible();

  await page.goto("/finance");
  await page.getByRole("button", { name: "Payments" }).click();
  await page.locator(".payment-form label").filter({ hasText: "Select party" }).locator("select").selectOption(customerId);
  await page.getByLabel("Amount").fill("1500");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("৳1,500.00")).toBeVisible();
  await page.getByRole("button", { name: "Receivables" }).click();
  await expect(page.getByText("SETTLED")).toBeVisible();

  const workflowState = await withTenantTransaction(tenantId, async (tx) => {
    const purchase = await tx.query.purchases.findFirst({
      where: (row, { eq: equals }) => equals(row.supplierId, supplierId),
    });
    const sale = await tx.query.sales.findFirst({
      where: (row, { eq: equals, and: both }) => both(equals(row.id, saleId), equals(row.tenantId, tenantId)),
    });
    const receivable = sale
      ? await tx.query.receivables.findFirst({ where: (row, { eq: equals }) => equals(row.saleId, sale.id) })
      : undefined;
    const [balance] = await tx.select().from(stockBalances).where(and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.itemId, itemId), eq(stockBalances.warehouseId, warehouseId)));
    const movements = await tx.select().from(stockMovements).where(and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.itemId, itemId), eq(stockMovements.warehouseId, warehouseId)));
    return { purchase, sale, receivable, balance, movements };
  });

  expect(Number(workflowState.purchase?.grandTotal)).toBe(2000);
  expect(Number(workflowState.purchase?.paidTotal)).toBe(0);
  expect(Number(workflowState.purchase?.dueTotal)).toBe(2000);
  expect(Number(workflowState.sale?.grandTotal)).toBe(2000);
  expect(Number(workflowState.sale?.paidTotal)).toBe(2000);
  expect(Number(workflowState.sale?.dueTotal)).toBe(0);
  expect(workflowState.sale?.status).toBe("PAID");
  expect(Number(workflowState.receivable?.amount)).toBe(2000);
  expect(Number(workflowState.receivable?.paidAmount)).toBe(2000);
  expect(Number(workflowState.receivable?.balance)).toBe(0);
  expect(workflowState.receivable?.status).toBe("SETTLED");
  expect(workflowState.balance?.quantityOnHand).toBe("6.0000");
  expect(workflowState.movements).toHaveLength(2);
  expect(workflowState.movements).toEqual(expect.arrayContaining([
    expect.objectContaining({ movementType: "PURCHASE", quantity: "10.0000" }),
    expect.objectContaining({ movementType: "SALE", quantity: "-4.0000" }),
  ]));

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Executive dashboard" })).toBeVisible();
  const profitSnapshot = page.locator(".activity-card").filter({ has: page.getByRole("heading", { name: "Profit snapshot" }) });
  await expect(profitSnapshot).toContainText("Revenue");
  await expect(profitSnapshot).toContainText("BDT 2,000.00");
  await expect(profitSnapshot).toContainText("BDT 800.00");
  await expect(profitSnapshot).toContainText("BDT 1,200.00");

  await page.goto(`/sales/${saleId}`);
  await page.getByRole("button", { name: "Cancel sale" }).click();
  await page.getByLabel("Reason").fill("Phase 2 cancellation acceptance");
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByText("CANCELLED", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancellation reason: Phase 2 cancellation acceptance")).toBeVisible();
});

test("tenant tax profile setup, item assignment, and tax-exclusive totals work through the UI", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/settings/tax");
  const profileResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/tax-profiles") && response.request().method() === "POST",
  );
  await page.getByLabel("Profile name").fill(`E2E VAT ${crypto.randomUUID()}`);
  await page.getByLabel("Rate (%)").fill("5");
  await page.getByRole("button", { name: "Create profile" }).click();
  const profileResponse = await profileResponsePromise;
  const profilePayload = await profileResponse.json();
  expect(profilePayload.success).toBe(true);
  const taxProfileId = profilePayload.data.id as string;
  await expect(page.getByText("5.0000%", { exact: false })).toBeVisible();

  await page.goto(`/inventory/items/${itemId}`);
  await expect(page.getByRole("heading", { name: itemName })).toBeVisible();
  await page.getByLabel("Tax profile").selectOption(taxProfileId);
  await page.getByRole("button", { name: "Save tax profile" }).click();
  await expect(page.getByText("Tax profile saved")).toBeVisible();

  await page.goto("/purchases/new");
  await page.getByLabel("Supplier *").selectOption(supplierId);
  await page.locator("label").filter({ hasText: "Item *" }).locator("select").selectOption(itemId);
  await page.getByLabel("Warehouse *").selectOption(warehouseId);
  await page.getByLabel("Quantity *").fill("1");
  await page.getByLabel("Cost *").fill("200");
  await expect(page.getByText("BDT 10.00", { exact: false })).toBeVisible();
  const purchaseResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/purchases") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Receive purchase" }).click();
  const purchaseResponse = await purchaseResponsePromise;
  const purchasePayload = await purchaseResponse.json();
  expect(purchasePayload.data.taxTotal).toBe("10.0000");

  await page.goto("/sales/new");
  await page.getByPlaceholder("Search customer").fill(customerName);
  await page.locator("label").filter({ hasText: "Customer" }).locator("select").selectOption(customerId);
  await page.getByPlaceholder("Search item").fill(itemName);
  await page.locator("label").filter({ hasText: "Item *" }).locator("select").selectOption(itemId);
  await page.getByLabel("Warehouse *").selectOption(warehouseId);
  await page.getByLabel("Qty *").fill("1");
  await expect(page.getByText("BDT 25.00", { exact: false })).toBeVisible();
  await expect(page.getByText("BDT 525.00", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Paid").fill("525");
  const saleResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/sales") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Complete sale" }).click();
  const salePayload = await (await saleResponsePromise).json();
  expect(salePayload.success).toBe(true);
  expect(salePayload.data.taxTotal).toBe("25.0000");
  expect(salePayload.data.grandTotal).toBe("525.0000");
});
