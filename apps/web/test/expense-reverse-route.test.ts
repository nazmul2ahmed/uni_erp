/**
 * POST /api/expenses/:id/reverse -- route unit test (use case + guard mocked).
 * Decision EXP-005: [expenses.reverse] [Idempotent REQUIRED], reason mandatory.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireTenantContext: vi.fn(), requirePermission: vi.fn(), reverseExpense: vi.fn() }));
vi.mock("@/lib/guard", () => ({ requireTenantContext: mocks.requireTenantContext, requirePermission: mocks.requirePermission }));
vi.mock("@/lib/use-cases/expense", () => ({ reverseExpense: mocks.reverseExpense }));
vi.mock("@/lib/api-response", () => ({ apiHandler: (fn: () => Promise<unknown>) => async () => fn() }));

import { POST } from "../app/api/expenses/[id]/reverse/route";

const ctx = { tenantId: "t1" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const call = (opts: { id?: string; key?: string | null; body?: unknown } = {}) => {
  const key = opts.key === undefined ? uuid(9) : opts.key;
  const req = new Request("http://localhost/api/expenses/x/reverse", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(opts.body === undefined ? { reason: "Wrong category" } : opts.body),
  }) as never;
  return POST(req, { params: Promise.resolve({ id: opts.id ?? uuid(1) }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireTenantContext.mockResolvedValue(ctx);
  mocks.requirePermission.mockResolvedValue(undefined);
  mocks.reverseExpense.mockResolvedValue({ id: "r1" });
});

describe("POST /api/expenses/:id/reverse", () => {
  it("requires expenses.reverse (not create/manage) and forwards id, reason and the Idempotency-Key", async () => {
    await call();
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "expenses.reverse");
    expect(mocks.requirePermission).not.toHaveBeenCalledWith(ctx, "expenses.create");
    expect(mocks.reverseExpense).toHaveBeenCalledWith(ctx, uuid(1), { reason: "Wrong category" }, uuid(9));
  });

  it("does nothing when the permission is denied", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    await expect(call()).rejects.toThrow("PERMISSION_DENIED");
    expect(mocks.reverseExpense).not.toHaveBeenCalled();
  });

  it("rejects a missing / non-UUID Idempotency-Key and a non-UUID expense id", async () => {
    await expect(call({ key: null })).rejects.toThrow("Idempotency-Key");
    await expect(call({ key: "nope" })).rejects.toThrow("Idempotency-Key");
    await expect(call({ id: "not-a-uuid" })).rejects.toThrow("Invalid expense id");
    expect(mocks.reverseExpense).not.toHaveBeenCalled();
  });

  it.each([
    ["missing reason", {}],
    ["blank reason", { reason: "   " }],
    ["too short", { reason: "ab" }],
    ["too long", { reason: "x".repeat(501) }],
    ["no body at all", null],
  ])("rejects %s before touching the use case", async (_n, body) => {
    await expect(call({ body })).rejects.toThrow("Invalid reversal");
    expect(mocks.reverseExpense).not.toHaveBeenCalled();
  });

  it("trims the reason and ignores unexpected fields (no client-chosen tenant, journal or amount)", async () => {
    await call({ body: { reason: "  Spaced  ", tenantId: uuid(77), amount: "1" } });
    expect(mocks.reverseExpense).toHaveBeenCalledWith(ctx, uuid(1), { reason: "Spaced" }, uuid(9));
  });
});
