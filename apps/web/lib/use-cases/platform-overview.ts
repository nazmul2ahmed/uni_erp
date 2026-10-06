/**
 * Platform overview -- ADR-001 section 5, Decision PLT-002.
 * CONTROL-PLANE AGGREGATES ONLY: reads control.tenants / tenant_features / users
 * and nothing else. It never touches core.*, modules.* or industry.* (05 88: tenant
 * business data needs explicit authorization + audit, which is a separate future
 * flow), and it exposes no owner emails or other user PII.
 *
 * Deliberately absent -- no data source exists yet, so nothing is invented:
 * Healthy / Degraded / Migration Pending (05 150), plans/subscriptions, cost (05 151).
 */
import { desc, eq, sql } from "drizzle-orm";
import { tenantFeatures, tenants, users, withPlatformTransaction } from "@erp/db";

export const TENANT_STATUSES = ["PROSPECT", "PROVISIONING", "ACTIVE", "SUSPENDED", "GRACE", "ARCHIVED"] as const;
export const STORAGE_MODES = ["SHARED", "DEDICATED"] as const;
const RECENT_TENANTS = 10;

export async function getPlatformOverview() {
  return withPlatformTransaction(async (tx) => {
    const grouped = await tx
      .select({ status: tenants.status, storageMode: tenants.storageMode, count: sql<number>`count(*)::int` })
      .from(tenants)
      .groupBy(tenants.status, tenants.storageMode);

    const byStatus = Object.fromEntries(TENANT_STATUSES.map((s) => [s, 0])) as Record<(typeof TENANT_STATUSES)[number], number>;
    const byStorageMode = Object.fromEntries(STORAGE_MODES.map((m) => [m, 0])) as Record<(typeof STORAGE_MODES)[number], number>;
    for (const row of grouped) {
      byStatus[row.status] += row.count;
      byStorageMode[row.storageMode] += row.count;
    }

    const recent = await tx
      .select({ id: tenants.id, name: tenants.name, status: tenants.status, storageMode: tenants.storageMode, createdAt: tenants.createdAt })
      .from(tenants)
      .orderBy(desc(tenants.createdAt))
      .limit(RECENT_TENANTS);

    const adoption = await tx
      .select({
        featureKey: tenantFeatures.featureKey,
        enabled: sql<number>`count(*) filter (where ${tenantFeatures.enabled})::int`,
        configured: sql<number>`count(*)::int`,
      })
      .from(tenantFeatures)
      .groupBy(tenantFeatures.featureKey)
      .orderBy(tenantFeatures.featureKey);

    const [activeUsers] = await tx.select({ count: sql<number>`count(*)::int` }).from(users).where(eq(users.isActive, true));

    return {
      tenants: {
        total: byStatus.PROSPECT + byStatus.PROVISIONING + byStatus.ACTIVE + byStatus.SUSPENDED + byStatus.GRACE + byStatus.ARCHIVED,
        byStatus,
        byStorageMode,
        recent: recent.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
      },
      featureAdoption: adoption,
      users: { active: activeUsers?.count ?? 0 },
    };
  });
}
