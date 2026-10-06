/**
 * Dashboard Widget Registry -- unit tests (no DB).
 * 12_UX_SPECIFICATION.md s8, Decision RPT-002.
 */
import { describe, expect, it, vi } from "vitest";
import { DashboardRegistry, type DashboardWidget } from "../lib/dashboard/registry";
import type { TenantContext } from "../lib/guard";

const ctxWith = (permissions: string[] | undefined): TenantContext =>
  ({ requestId: "r", userId: "u", tenantId: "tenant-a", membershipId: "m", roleId: "role", storageMode: "SHARED", permissions, roleKey: "X" }) as unknown as TenantContext;

const widget = (key: string, requiredPermissions: string[], load = vi.fn().mockResolvedValue({ key })): DashboardWidget => ({ key, title: key.toUpperCase(), requiredPermissions, load });

describe("DashboardRegistry.register", () => {
  it("rejects a duplicate key", () => {
    const registry = new DashboardRegistry();
    registry.register(widget("a", ["reports.view"]));
    expect(() => registry.register(widget("a", ["reports.view"]))).toThrow("already registered");
  });

  it("rejects a widget that declares no permission (fail closed -- no public widgets)", () => {
    expect(() => new DashboardRegistry().register(widget("a", []))).toThrow("at least one required permission");
  });
});

describe("DashboardRegistry.build -- permission filtering", () => {
  it("omits widgets the actor lacks permission for and NEVER runs their loader", async () => {
    const registry = new DashboardRegistry();
    const allowed = widget("sales", ["reports.view"]);
    const forbidden = widget("cash", ["accounting.view"]);
    registry.register(allowed);
    registry.register(forbidden);

    const result = await registry.build(ctxWith(["reports.view"]));

    expect(result.map((w) => w.key)).toEqual(["sales"]);
    expect(allowed.load).toHaveBeenCalledOnce();
    expect(forbidden.load).not.toHaveBeenCalled();
  });

  it("requires ALL of a widget's permissions, not any", async () => {
    const registry = new DashboardRegistry();
    const both = widget("profit", ["reports.view", "accounting.view"]);
    registry.register(both);

    expect(await registry.build(ctxWith(["reports.view"]))).toEqual([]);
    expect(await registry.build(ctxWith(["accounting.view"]))).toEqual([]);
    expect((await registry.build(ctxWith(["reports.view", "accounting.view"]))).map((w) => w.key)).toEqual(["profit"]);
    expect(both.load).toHaveBeenCalledOnce();
  });

  it("treats missing or empty permissions as no access", async () => {
    const registry = new DashboardRegistry();
    const w = widget("sales", ["reports.view"]);
    registry.register(w);

    expect(await registry.build(ctxWith(undefined))).toEqual([]);
    expect(await registry.build(ctxWith([]))).toEqual([]);
    expect(w.load).not.toHaveBeenCalled();
  });

  it("returns widgets in registration order with their titles and data", async () => {
    const registry = new DashboardRegistry();
    registry.register(widget("first", ["p"]));
    registry.register(widget("second", ["p"]));
    registry.register(widget("third", ["p"]));

    expect(await registry.build(ctxWith(["p"]))).toEqual([
      { key: "first", title: "FIRST", data: { key: "first" } },
      { key: "second", title: "SECOND", data: { key: "second" } },
      { key: "third", title: "THIRD", data: { key: "third" } },
    ]);
  });

  it("hands each loader the server-resolved tenant context and the date filter", async () => {
    const registry = new DashboardRegistry();
    const load = vi.fn().mockResolvedValue(null);
    registry.register(widget("sales", ["p"], load));
    const ctx = ctxWith(["p"]);

    await registry.build(ctx, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });

    const arg = load.mock.calls[0]![0];
    expect(arg.ctx).toBe(ctx);
    expect(arg.filter).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  });
});

describe("DashboardRegistry.build -- shared source memo", () => {
  type Finance = { cash: string; receivables: string };
  it("runs a shared source once even when several widgets use it", async () => {
    const registry = new DashboardRegistry();
    const source = vi.fn().mockResolvedValue({ cash: "1", receivables: "2" });
    registry.register({ key: "cash", title: "Cash", requiredPermissions: ["p"], load: async ({ once }) => (await once<Finance>("finance", source)).cash });
    registry.register({ key: "recv", title: "Recv", requiredPermissions: ["p"], load: async ({ once }) => (await once<Finance>("finance", source)).receivables });

    const result = await registry.build(ctxWith(["p"]));

    expect(result.map((w) => w.data)).toEqual(["1", "2"]);
    expect(source).toHaveBeenCalledOnce();
  });

  it("does not share the memo across requests", async () => {
    const registry = new DashboardRegistry();
    const source = vi.fn().mockResolvedValue("x");
    registry.register({ key: "a", title: "A", requiredPermissions: ["p"], load: ({ once }) => once("k", source) });

    await registry.build(ctxWith(["p"]));
    await registry.build(ctxWith(["p"]));

    expect(source).toHaveBeenCalledTimes(2);
  });
});
