/**
 * Dashboard Engine entry point -- GET /api/reports/dashboard (11 s19).
 *
 * Module / industry widgets register here (one import + one `register` call
 * per widget) -- never by adding a branch to the route or the page
 * (12 s8 rule, Decision RPT-002).
 */
import { eq } from "drizzle-orm";
import { tenants, withTenantTransaction } from "@erp/db";
import type { TenantContext } from "../guard";
import { coreWidgets } from "./core-widgets";
import { DashboardRegistry, type DashboardFilter } from "./registry";

export const dashboardRegistry = new DashboardRegistry();
for (const widget of coreWidgets) dashboardRegistry.register(widget);

export async function getDashboard(ctx: TenantContext, filter: DashboardFilter = {}) {
  const [widgets, tenant] = await Promise.all([
    dashboardRegistry.build(ctx, filter),
    withTenantTransaction(ctx.tenantId, async (tx) => tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) })),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    currency: tenant?.baseCurrency ?? "BDT",
    widgets,
  };
}
