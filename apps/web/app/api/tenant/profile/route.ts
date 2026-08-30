import { NextRequest } from "next/server";
import { businessProfiles, withTenantTransaction } from "@erp/db";
import { eq } from "drizzle-orm";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { z } from "zod";

/**
 * Reference implementation of the full guard chain (13 §3.1) +
 * RLS-protected tenant-scoped write (05 §25, Decision TEN-002),
 * exercised end-to-end. This is the concrete proof for Phase 1
 * exit criteria: "Membership/Role/Permission resolve correctly
 * end-to-end" (28 §4).
 */

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.view");

    // Bug fix (Phase 2 discovery): this read MUST run through
    // withTenantTransaction, same as PATCH below — core.business_profiles
    // has Row Level Security enabled (0001_rls_policies.sql), and the
    // policy's current_setting('app.tenant_id', true) is only populated
    // inside a transaction opened via withTenantTransaction's
    // `SET LOCAL app.tenant_id = ...`. A plain db.query call here (the
    // prior implementation) runs with app.tenant_id unset, so the
    // fail-closed RLS policy (05 §159) silently returns zero rows for
    // EVERY tenant, regardless of the WHERE clause — this endpoint was
    // returning RESOURCE_NOT_FOUND unconditionally before this fix.
    const profile = await withTenantTransaction(ctx.tenantId, async (tx) => {
      return tx.query.businessProfiles.findFirst({
        where: eq(businessProfiles.tenantId, ctx.tenantId),
      });
    });
    if (!profile) throw new AppError("RESOURCE_NOT_FOUND", "Business profile not found");

    return profile;
  })();
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
});

export async function PATCH(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.manage");

    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid profile payload");

    const updated = await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(businessProfiles)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(businessProfiles.tenantId, ctx.tenantId))
        .returning();
      return row;
    });

    if (!updated) throw new AppError("RESOURCE_NOT_FOUND", "Business profile not found");
    return updated;
  })();
}