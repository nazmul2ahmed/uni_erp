/**
 * Navigation + landing -- 12 s3.4, Decision NAV-001. Pure functions (no DB, no React).
 * Includes a drift guard: each nav item's `requires` must be the permission its
 * page's primary API route actually enforces, so the menu never advertises a
 * page that the server will refuse (or hides one it would allow).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_LANDING, NAV_ITEMS, can, landingPath, visibleNavigation } from "../lib/navigation";

const labels = (perms: string[] | null | undefined) => visibleNavigation(perms).map((i) => i.label);

describe("visibleNavigation", () => {
  it("fails closed: unknown permissions (null / undefined / empty) show nothing", () => {
    expect(visibleNavigation(null)).toEqual([]);
    expect(visibleNavigation(undefined)).toEqual([]);
    expect(visibleNavigation([])).toEqual([]);
  });

  it("shows exactly the items whose permission is held, in declared order", () => {
    expect(labels(["expenses.view", "sales.view"])).toEqual(["Sales", "Expenses"]);
  });

  it("a permission that gates no page grants no menu item (e.g. a create/manage right alone)", () => {
    expect(labels(["sales.create", "expenses.manage", "accounting.post"])).toEqual([]);
  });

  it("ignores unknown permission strings", () => {
    expect(labels(["totally.made.up"])).toEqual([]);
  });

  it("OWNER-like (every permission) sees every item", () => {
    expect(visibleNavigation(NAV_ITEMS.map((i) => i.requires))).toHaveLength(NAV_ITEMS.length);
  });
});

describe("can", () => {
  it("is false for non-arrays and missing permissions", () => {
    expect(can(null, "a")).toBe(false);
    expect(can(undefined, "a")).toBe(false);
    expect(can(["b"], "a")).toBe(false);
    expect(can(["a"], "a")).toBe(true);
  });
});

describe("landingPath (Decision NAV-001)", () => {
  it("dashboard-capable roles land on the dashboard", () => expect(landingPath(["reports.view", "sales.create"])).toBe("/dashboard"));
  it("a cashier (sales.create, no reports.view) lands on the POS", () => expect(landingPath(["sales.view", "sales.create", "customers.view"])).toBe("/sales/new"));
  it("otherwise the first menu item they can see", () => expect(landingPath(["customers.view", "expenses.view"])).toBe("/customers"));
  it("falls back to the dashboard (which explains the lack of access) when nothing is visible or permissions are unknown", () => {
    expect(landingPath([])).toBe(FALLBACK_LANDING);
    expect(landingPath(null)).toBe(FALLBACK_LANDING);
    expect(landingPath(["inventory.adjust"])).toBe(FALLBACK_LANDING);
  });
  it("the POS is the landing page for sales.create even without sales.view (the POS page itself needs sales.create, which they hold)", () => {
    expect(landingPath(["sales.create"])).toBe("/sales/new");
    expect(visibleNavigation(["sales.create"])).toEqual([]); // not a menu item -- the POS is reached via Sales, which needs sales.view
  });
  it("every other landing is a page whose menu item the user can see", () => {
    for (const perms of [["sales.view"], ["customers.view"], ["suppliers.view"], ["expenses.view"], ["settings.view"], ["reports.view"]]) {
      const target = landingPath(perms);
      const visible = visibleNavigation(perms).map((i) => i.href);
      expect(visible.some((href) => target === href || target.startsWith(`${href}/`))).toBe(true);
    }
  });
});

describe("drift guard: nav permission == the permission the page's primary API enforces", () => {
  // nav key -> the API route file that backs the page's main data (see each page's first fetch).
  const PRIMARY_ROUTE: Record<string, string> = {
    dashboard: "reports/dashboard",
    sales: "sales",
    purchases: "purchases",
    customers: "customers",
    suppliers: "suppliers",
    finance: "finance",
    expenses: "expenses",
    reports: "reports/sales",
    settings: "tenant/profile",
  };
  const apiRoot = join(__dirname, "..", "app", "api");

  it("covers every nav item", () => {
    expect(Object.keys(PRIMARY_ROUTE).sort()).toEqual(NAV_ITEMS.map((i) => i.key).sort());
  });

  it.each(NAV_ITEMS.map((i) => [i.key, i.requires] as const))("%s requires %s on its API route", (key, requires) => {
    const source = readFileSync(join(apiRoot, PRIMARY_ROUTE[key]!, "route.ts"), "utf8");
    expect(source).toContain(`requirePermission(ctx, "${requires}")`);
  });
});
