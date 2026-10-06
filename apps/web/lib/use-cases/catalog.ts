/**
 * Catalog primitive application-layer use cases: ItemCategory / Brand
 * / Unit. Per 06_DATABASE_SPECIFICATION.md v2.0 §5.7 and
 * 11_API_SPECIFICATION.md §7.
 *
 * Deliberately grouped in one file (unlike Customer/Supplier/Item
 * each getting their own) — these three are small, structurally
 * near-identical (tenant-scoped name lookup + create), and per 06
 * v2.0 §5.7 are already documented as one cohesive "catalog
 * primitives" concern. Splitting them into three near-empty files
 * would work against the "no god utility" principle in the opposite
 * direction — unnecessary file proliferation for what is one concern.
 *
 * Per 11 §7, only GET (list) and POST (create) are specified for
 * these three — no PATCH/archive endpoints exist in the API contract
 * for ItemCategory/Brand/Unit at this phase.
 *
 * Same RLS discipline as customer.ts/supplier.ts/item.ts.
 */
import { eq, and, isNull } from "drizzle-orm";
import { itemCategories, brands, units, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";
import type { CreateItemCategoryInput, CreateBrandInput, CreateUnitInput } from "@erp/validation";

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/* -------------------------------------------------------------- */
/* ItemCategory                                                     */
/* -------------------------------------------------------------- */

export async function listItemCategories(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    return tx.query.itemCategories.findMany({
      where: eq(itemCategories.tenantId, ctx.tenantId),
      orderBy: (c, { asc }) => [asc(c.name)],
    });
  });
}

export async function createItemCategory(ctx: TenantContext, input: CreateItemCategoryInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      // If a parentId is given, verify it belongs to this tenant —
      // core.item_categories has no cross-tenant FK guard at the DB
      // level (the FK only ensures the row exists SOMEWHERE, not that
      // it's tenant-owned), so this is an explicit application-layer
      // check per 05 §81's "cross-tenant foreign key is forbidden."
      if (input.parentId) {
        const parent = await tx.query.itemCategories.findFirst({
          where: and(eq(itemCategories.id, input.parentId), eq(itemCategories.tenantId, ctx.tenantId)),
        });
        if (!parent) throw new AppError("VALIDATION_FAILED", "parentId does not belong to this tenant");
      }
      const [row] = await tx
        .insert(itemCategories)
        .values({ tenantId: ctx.tenantId, name: input.name, parentId: input.parentId })
        .returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError("DUPLICATE_RESOURCE", "A category with this name already exists", { field: "name" });
    }
    throw e;
  }
}

/* -------------------------------------------------------------- */
/* Brand                                                             */
/* -------------------------------------------------------------- */

export async function listBrands(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    return tx.query.brands.findMany({
      where: eq(brands.tenantId, ctx.tenantId),
      orderBy: (b, { asc }) => [asc(b.name)],
    });
  });
}

export async function createBrand(ctx: TenantContext, input: CreateBrandInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx.insert(brands).values({ tenantId: ctx.tenantId, name: input.name }).returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError("DUPLICATE_RESOURCE", "A brand with this name already exists", { field: "name" });
    }
    throw e;
  }
}

/* -------------------------------------------------------------- */
/* Unit                                                               */
/* -------------------------------------------------------------- */

export async function listUnits(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    return tx.query.units.findMany({
      where: eq(units.tenantId, ctx.tenantId),
      orderBy: (u, { asc }) => [asc(u.name)],
    });
  });
}

export async function createUnit(ctx: TenantContext, input: CreateUnitInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(units)
        .values({ tenantId: ctx.tenantId, name: input.name, symbol: input.symbol, isDecimal: input.isDecimal })
        .returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError("DUPLICATE_RESOURCE", "A unit with this name already exists", { field: "name" });
    }
    throw e;
  }
}