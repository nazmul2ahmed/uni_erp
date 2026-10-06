/**
 * Preset-role access -- real-PostgreSQL integration test.
 * 12 s3.4 navigation + Decision NAV-001 landing, evaluated against the roles
 * the platform actually seeds (not hand-typed permission lists), so a seed
 * change that silently breaks a role's menu or landing page fails here.
 */
import { describe, expect, it } from "vitest";
import { db } from "@erp/db";
import { resolvePermissions } from "../lib/guard";
import { NAV_ITEMS, landingPath, visibleNavigation } from "../lib/navigation";

async function presetPermissions(key: string): Promise<string[]> {
  const role = await db.query.roles.findFirst({ where: (r, { and, eq, isNull }) => and(isNull(r.tenantId), eq(r.key, key)) });
  if (!role) throw new Error(`Preset role ${key} not seeded -- run pnpm db:seed`);
  return resolvePermissions(role.id);
}
const labels = (perms: string[]) => visibleNavigation(perms).map((i) => i.label);

describe("seeded role -> navigation and landing (Decision NAV-001)", () => {
  it("OWNER sees every item and lands on the dashboard", async () => {
    const perms = await presetPermissions("OWNER");
    expect(labels(perms)).toEqual(NAV_ITEMS.map((i) => i.label));
    expect(landingPath(perms)).toBe("/dashboard");
  });

  it("MANAGER sees every item and lands on the dashboard", async () => {
    const perms = await presetPermissions("MANAGER");
    expect(labels(perms)).toEqual(NAV_ITEMS.map((i) => i.label));
    expect(landingPath(perms)).toBe("/dashboard");
  });

  it("STAFF (cashier) no longer lands on a dashboard it cannot open: it gets the POS, and no Dashboard / Finance / Reports menu", async () => {
    const perms = await presetPermissions("STAFF");
    expect(labels(perms)).toEqual(["Sales", "Purchases", "Customers", "Suppliers", "Expenses", "Settings"]);
    expect(labels(perms)).not.toEqual(expect.arrayContaining(["Dashboard"]));
    expect(landingPath(perms)).toBe("/sales/new");
  });

  it("every nav permission exists in the platform permission catalog (no typo can silently hide a menu item forever)", async () => {
    const catalog = new Set((await db.query.permissions.findMany()).map((p) => p.key));
    for (const item of NAV_ITEMS) expect(catalog.has(item.requires), `${item.label} -> ${item.requires}`).toBe(true);
  });
});
