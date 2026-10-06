import { and, eq } from "drizzle-orm";
import { tenantFeatures, withPlatformTransaction } from "@erp/db";
import type { Database } from "@erp/db";
import { KNOWN_FEATURE_KEYS } from "@erp/validation";
import type { UpdateTenantFeaturesInput } from "@erp/validation";
import type { TenantContext } from "../guard";
import { recordPlatformAudit } from "../platform-audit";

async function readAllFeatures(tx: Database, tenantId: string) {
  const rows = await tx.query.tenantFeatures.findMany({ where: eq(tenantFeatures.tenantId, tenantId) });
  const byKey = new Map(rows.map((r) => [r.featureKey, r]));
  // Every KNOWN key is always present in the response, defaulting to
  // disabled if the tenant has never toggled it — per 05 §71's
  // "absent -> default" note, simplified here (see
  // packages/validation/tenant-features.ts's docblock for what's
  // NOT yet wired: plan-entitlement resolution).
  return KNOWN_FEATURE_KEYS.map((key) => {
    const row = byKey.get(key);
    return { featureKey: key, enabled: row?.enabled ?? false, source: row?.source ?? "OVERRIDE", updatedAt: row?.updatedAt ?? null };
  });
}

/**
 * control.tenant_features carries no RLS (control schema, per 06
 * §3.1) — withPlatformTransaction + explicit tenantId filtering, same
 * discipline as lib/use-cases/staff.ts and role.ts.
 */
export async function listTenantFeatures(ctx: TenantContext) {
  return withPlatformTransaction((tx) => readAllFeatures(tx, ctx.tenantId));
}

export async function updateTenantFeatures(ctx: TenantContext, input: UpdateTenantFeaturesInput) {
  return withPlatformTransaction(async (tx) => {
    const before: Record<string, boolean> = {};
    const after: Record<string, boolean> = {};

    for (const change of input.features) {
      const existing = await tx.query.tenantFeatures.findFirst({
        where: and(eq(tenantFeatures.tenantId, ctx.tenantId), eq(tenantFeatures.featureKey, change.featureKey)),
      });
      before[change.featureKey] = existing?.enabled ?? false;
      after[change.featureKey] = change.enabled;

      if (existing) {
        await tx
          .update(tenantFeatures)
          .set({ enabled: change.enabled, source: "OVERRIDE", updatedAt: new Date(), updatedBy: ctx.userId })
          .where(and(eq(tenantFeatures.tenantId, ctx.tenantId), eq(tenantFeatures.featureKey, change.featureKey)));
      } else {
        await tx.insert(tenantFeatures).values({ tenantId: ctx.tenantId, featureKey: change.featureKey, enabled: change.enabled, source: "OVERRIDE", updatedBy: ctx.userId });
      }
    }

    await recordPlatformAudit(tx, ctx, { action: "tenant_features.updated", before, after });

    // Same tx, same helper as listTenantFeatures() — NOT a nested
    // withPlatformTransaction() call (postgres.js does not support
    // nested transactions without explicit SAVEPOINT handling this
    // codebase doesn't use elsewhere).
    return readAllFeatures(tx, ctx.tenantId);
  });
}
