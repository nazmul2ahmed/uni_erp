/**
 * Expense API routes -- unit tests (use case + guard mocked).
 * 11_API_SPECIFICATION.md s13: GET [expenses.view]; POST [expenses.create]
 * [Idempotent REQUIRED]; categories GET [expenses.view] / POST [expenses.manage].
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  recordExpense: vi.fn(),
  listExpenses: vi.fn(),
  createExpenseCategory: vi.fn(),
  listExpenseCategories: vi.fn(),
}));
vi.mock("@/lib/guard", () => ({ requireTenantContext: mocks.requireTenantContext, requirePermission: mocks.requirePermission }));
vi.mock("@/lib/use-cases/expense", () => ({
  recordExpense: mocks.recordExpense,
  listExpenses: mocks.listExpenses,
  createExpenseCategory: mocks.createExpenseCategory,
  listExpenseCategories: mocks.listExpenseCategories,
}));
vi.mock("@/lib/api-response", () => ({
  apiHandler: (fn: () => Promise<unknown>) => async () => fn(),
}));

import { GET as listRoute, POST as recordRoute } from "../app/api/expenses/route";
import { GET as listCategoriesRoute, POST as createCategoryRoute } from "../app/api/expense-categories/route";

const ctx = { tenantId: "t1" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const validBody = { branchId: uuid(1), categoryId: uuid(2), amount: "1500.50", paidVia: "CASH", expenseDate: "2026-09-30", description: "Shop rent" };
const post = (body: unknown, key: string | null = uuid(9)) =>
  new Request("http://localhost/api/expenses", { method: "POST", headers: key ? { "Idempotency-Key": key, "content-type": "application/json" } : { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireTenantContext.mockResolvedValue(ctx);
  mocks.requirePermission.mockResolvedValue(undefined);
  mocks.recordExpense.mockResolvedValue({ id: "e1" });
  mocks.listExpenses.mockResolvedValue([]);
  mocks.createExpenseCategory.mockResolvedValue({ id: "c1" });
  mocks.listExpenseCategories.mockResolvedValue([]);
});

describe("POST /api/expenses", () => {
  it("requires expenses.create and passes the Idempotency-Key as operationId", async () => {
    await recordRoute(post(validBody));
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "expenses.create");
    expect(mocks.recordExpense).toHaveBeenCalledWith(ctx, validBody, uuid(9));
  });

  it("does nothing when the permission is denied", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    await expect(recordRoute(post(validBody))).rejects.toThrow("PERMISSION_DENIED");
    expect(mocks.recordExpense).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-UUID Idempotency-Key", async () => {
    await expect(recordRoute(post(validBody, null))).rejects.toThrow("Idempotency-Key");
    await expect(recordRoute(post(validBody, "not-a-uuid"))).rejects.toThrow("Idempotency-Key");
    expect(mocks.recordExpense).not.toHaveBeenCalled();
  });

  it.each([
    ["zero amount", { ...validBody, amount: "0" }],
    ["negative amount", { ...validBody, amount: "-5" }],
    ["too many decimals", { ...validBody, amount: "1.23456" }],
    ["unknown paidVia", { ...validBody, paidVia: "CRYPTO" }],
    ["impossible calendar date", { ...validBody, expenseDate: "2026-02-31" }],
    ["non-ISO date", { ...validBody, expenseDate: "30/09/2026" }],
    ["non-UUID category", { ...validBody, categoryId: "rent" }],
  ])("rejects %s before touching the use case", async (_name, body) => {
    await expect(recordRoute(post(body))).rejects.toThrow("Invalid expense");
    expect(mocks.recordExpense).not.toHaveBeenCalled();
  });

  it("never lets the client choose tenant, creator or journal account (unknown keys are not forwarded)", async () => {
    await recordRoute(post({ ...validBody, tenantId: uuid(77), createdBy: uuid(78), accountCode: "1000" }));
    const forwarded = mocks.recordExpense.mock.calls[0]![1];
    expect(forwarded).not.toHaveProperty("tenantId");
    expect(forwarded).not.toHaveProperty("createdBy");
    expect(forwarded).not.toHaveProperty("accountCode");
  });
});

describe("GET /api/expenses", () => {
  it("requires expenses.view and forwards validated filters", async () => {
    await listRoute(new Request(`http://localhost/api/expenses?categoryId=${uuid(2)}&dateFrom=2026-09-01&dateTo=2026-09-30&limit=10`) as never);
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "expenses.view");
    expect(mocks.listExpenses).toHaveBeenCalledWith(ctx, { categoryId: uuid(2), dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 10 });
  });

  it("rejects malformed filters", async () => {
    await expect(listRoute(new Request("http://localhost/api/expenses?dateFrom=yesterday") as never)).rejects.toThrow("Invalid expense filters");
    expect(mocks.listExpenses).not.toHaveBeenCalled();
  });
});

describe("/api/expense-categories", () => {
  it("GET requires expenses.view", async () => {
    await listCategoriesRoute();
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "expenses.view");
    expect(mocks.listExpenseCategories).toHaveBeenCalledWith(ctx);
  });

  it("POST requires expenses.manage (not expenses.create) and validates the body", async () => {
    const req = (body: unknown) => new Request("http://localhost/api/expense-categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;
    await createCategoryRoute(req({ name: "Rent", accountCode: "5200" }));
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "expenses.manage");
    expect(mocks.requirePermission).not.toHaveBeenCalledWith(ctx, "expenses.create");
    expect(mocks.createExpenseCategory).toHaveBeenCalledWith(ctx, { name: "Rent", accountCode: "5200" });

    await expect(createCategoryRoute(req({ name: "", accountCode: "5200" }))).rejects.toThrow("Invalid expense category");
    await expect(createCategoryRoute(req({ name: "Rent", accountCode: "abc" }))).rejects.toThrow("Invalid expense category");
  });

  it("POST does nothing when expenses.manage is denied", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    const req = new Request("http://localhost/api/expense-categories", { method: "POST", body: JSON.stringify({ name: "Rent", accountCode: "5200" }) }) as never;
    await expect(createCategoryRoute(req)).rejects.toThrow("PERMISSION_DENIED");
    expect(mocks.createExpenseCategory).not.toHaveBeenCalled();
  });
});
