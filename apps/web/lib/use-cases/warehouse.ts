import { and, eq, isNull } from "drizzle-orm";
import { branches, warehouses, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";

export async function listWarehouses(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    return tx.query.warehouses.findMany({
      where: eq(warehouses.tenantId, ctx.tenantId),
      orderBy: (warehouse, { asc }) => [asc(warehouse.name)],
    });
  });
}

export async function getWarehouse(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const row = await tx.query.warehouses.findFirst({
      where: and(eq(warehouses.id, id), eq(warehouses.tenantId, ctx.tenantId)),
    });
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Warehouse not found");
    return row;
  });
}

export async function createWarehouse(
  ctx: TenantContext,
  input: { name: string; code: string; branchId: string; isActive?: boolean },
) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const branch = await tx.query.branches.findFirst({
      where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId)),
    });
    if (!branch) {
      throw new AppError("VALIDATION_FAILED", "branchId does not belong to this tenant", { field: "branchId" });
    }

    const [row] = await tx
      .insert(warehouses)
      .values({
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        name: input.name,
        code: input.code,
        isActive: input.isActive ?? true,
      })
      .returning();

    return row!;
  });
}
