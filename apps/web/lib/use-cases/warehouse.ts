import { and, eq } from "drizzle-orm";
import { branches, warehouses, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreateWarehouseInput, UpdateWarehouseInput } from "@erp/validation";
import type { TenantContext } from "../guard";

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

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

export async function createWarehouse(ctx: TenantContext, input: CreateWarehouseInput) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const branch = await tx.query.branches.findFirst({
      where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId)),
    });
    if (!branch) {
      throw new AppError("VALIDATION_FAILED", "branchId does not belong to this tenant", { field: "branchId" });
    }

    try {
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
    } catch (e) {
      if (isUniqueViolation(e)) {
        // warehouses_tenant_code_unique (schema/commerce.ts) — same
        // duplicate-code protection pattern as branch.ts.
        throw new AppError("DUPLICATE_RESOURCE", "A warehouse with this code already exists for this tenant", { field: "code" });
      }
      throw e;
    }
  });
}

/**
 * FIX (Phase 2 code-verification pass — confirmed live bug): the
 * PATCH /api/warehouses/:id route previously did NOT call any update
 * function at all — it merged the request body into the fetched row
 * in memory and returned it, without writing to the database. Any
 * client "updating" a warehouse (e.g. renaming it, deactivating it)
 * silently lost that change on the next page load. This is the real
 * persistence path.
 */
export async function updateWarehouse(ctx: TenantContext, id: string, input: UpdateWarehouseInput) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const existing = await tx.query.warehouses.findFirst({ where: and(eq(warehouses.id, id), eq(warehouses.tenantId, ctx.tenantId)) });
    if (!existing) throw new AppError("RESOURCE_NOT_FOUND", "Warehouse not found");

    if (input.branchId) {
      const branch = await tx.query.branches.findFirst({ where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId)) });
      if (!branch) throw new AppError("VALIDATION_FAILED", "branchId does not belong to this tenant", { field: "branchId" });
    }

    const [updated] = await tx
      .update(warehouses)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(warehouses.id, id))
      .returning();

    return updated!;
  });
}
