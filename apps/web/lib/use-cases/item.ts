/**
 * Item (Catalog) application-layer use cases.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §6.1-6.3 and 11_API_SPECIFICATION.md §7.
 *
 * Same RLS discipline as customer.ts/supplier.ts (all queries go
 * through withTenantTransaction).
 *
 * IMPORTANT — fulfills a promise made in packages/validation/item.ts's
 * docblock: `updateItemSchema` deliberately has NO cross-field
 * `.refine()` (a partial patch can't validate the 07 §6.1 invariant
 * in isolation — it doesn't know the item's CURRENT persisted state).
 * `updateItem` below is where that promised re-validation actually
 * happens: it fetches the current row, computes the MERGED
 * (current + patch) tracking-flag state inside the SAME transaction
 * as the update, and rejects before writing if the merged state would
 * violate either invariant. This is the concrete "server validation
 * authoritative" half of the split documented in 04 §12.
 *
 * NOT implemented in this pass: GET /api/items/:id/stock-summary
 * (11 §7) — depends on core.stock_balances (Inventory domain, 09),
 * which does not exist yet. No route wired for it until Inventory
 * lands. Same deferral class as Customer's GetCustomerLedger.
 *
 * BUGFIX (Phase 2 discovery, tenant-isolation integration test suite —
 * flagged as a finding, fixed on explicit approval): `createItem` and
 * `updateItem` did not verify that `categoryId` / `brandId` / `unitId`
 * belong to the CALLER'S OWN tenant before writing them onto
 * `core.items`. The DB-level FK on each of those columns only proves
 * the referenced row exists SOMEWHERE — not that it is tenant-owned
 * by the same tenant as the Item being written — so a cross-tenant
 * reference (e.g. Tenant A's Item pointing at Tenant B's Unit) was
 * silently accepted. Per 05 §81 ("Cross-tenant foreign key কখনো
 * allowed নয়") and 05 §126's New Table Checklist ("Foreign keys
 * tenant-safe"), this is now enforced by `assertItemForeignKeysBelongToTenant`
 * below, mirroring the pattern `createItemCategory` (catalog.ts)
 * already established for its own `parentId`. Applied identically on
 * CREATE and UPDATE — an update can introduce a cross-tenant
 * reference exactly as easily as a create can, so fixing only the
 * create path would have left the same class of gap open.
 */
import { eq, and, or, ilike, isNull } from "drizzle-orm";
import { items, itemCategories, brands, units, withTenantTransaction } from "@erp/db";
import type { Database } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";
import type { CreateItemInput, UpdateItemInput } from "@erp/validation";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/**
 * Cross-tenant FK guard for Item's references (categoryId, brandId,
 * unitId) — per 05 §81/§126. Only validates fields actually present
 * in `refs` (undefined = not being set/changed, so nothing to check —
 * matches catalog.ts's createItemCategory only checking `parentId`
 * "if input.parentId" is given). Runs INSIDE the same transaction as
 * the write it guards, so the check and the write see a consistent
 * snapshot and remain atomic together.
 */
async function assertItemForeignKeysBelongToTenant(
  tx: Database,
  tenantId: string,
  refs: { categoryId?: string; brandId?: string; unitId?: string },
): Promise<void> {
  if (refs.categoryId) {
    const row = await tx.query.itemCategories.findFirst({
      where: and(eq(itemCategories.id, refs.categoryId), eq(itemCategories.tenantId, tenantId)),
    });
    if (!row) {
      throw new AppError("VALIDATION_FAILED", "categoryId does not belong to this tenant", { field: "categoryId" });
    }
  }
  if (refs.brandId) {
    const row = await tx.query.brands.findFirst({
      where: and(eq(brands.id, refs.brandId), eq(brands.tenantId, tenantId)),
    });
    if (!row) {
      throw new AppError("VALIDATION_FAILED", "brandId does not belong to this tenant", { field: "brandId" });
    }
  }
  if (refs.unitId) {
    const row = await tx.query.units.findFirst({
      where: and(eq(units.id, refs.unitId), eq(units.tenantId, tenantId)),
    });
    if (!row) {
      throw new AppError("VALIDATION_FAILED", "unitId does not belong to this tenant", { field: "unitId" });
    }
  }
}

export async function listItems(ctx: TenantContext, opts: { q?: string; limit?: number; offset?: number }) {
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const offset = opts.offset ?? 0;

  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const conditions = [eq(items.tenantId, ctx.tenantId), isNull(items.deletedAt)];
    if (opts.q) {
      const term = `%${opts.q}%`;
      conditions.push(or(ilike(items.name, term), ilike(items.sku, term))!);
    }
    return tx.query.items.findMany({
      where: and(...conditions),
      orderBy: (i, { asc }) => [asc(i.name)],
      limit,
      offset,
    });
  });
}

export async function getItem(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const row = await tx.query.items.findFirst({
      where: and(eq(items.id, id), eq(items.tenantId, ctx.tenantId), isNull(items.deletedAt)),
    });
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
    return row;
  });
}

export async function createItem(ctx: TenantContext, input: CreateItemInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      await assertItemForeignKeysBelongToTenant(tx, ctx.tenantId, {
        categoryId: input.categoryId,
        brandId: input.brandId,
        unitId: input.unitId,
      });

      const [row] = await tx
        .insert(items)
        .values({
          tenantId: ctx.tenantId,
          sku: input.sku,
          name: input.name,
          type: input.type,
          categoryId: input.categoryId,
          brandId: input.brandId,
          unitId: input.unitId,
          purchasePrice: input.purchasePrice,
          sellingPrice: input.sellingPrice,
          lowStockThreshold: input.lowStockThreshold,
          stockTracked: input.stockTracked,
          batchTracked: input.batchTracked,
          expiryTracked: input.expiryTracked,
          serialTracked: input.serialTracked,
          rentalTracked: input.rentalTracked,
          warrantyTracked: input.warrantyTracked,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // items_tenant_sku_unique (0004_rls_policies_phase2.sql)
      throw new AppError("DUPLICATE_RESOURCE", "An item with this SKU already exists", { field: "sku" });
    }
    throw e;
  }
}

export async function updateItem(ctx: TenantContext, id: string, input: UpdateItemInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const current = await tx.query.items.findFirst({
        where: and(eq(items.id, id), eq(items.tenantId, ctx.tenantId), isNull(items.deletedAt)),
      });
      if (!current) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");

      await assertItemForeignKeysBelongToTenant(tx, ctx.tenantId, {
        categoryId: input.categoryId,
        brandId: input.brandId,
        unitId: input.unitId,
      });

      // Merged-state cross-field invariant re-check (07 §6.1) — see
      // this file's docblock for why this can't live in the Zod
      // schema for a partial PATCH.
      const mergedExpiryTracked = input.expiryTracked ?? current.expiryTracked;
      const mergedBatchTracked = input.batchTracked ?? current.batchTracked;
      const mergedSerialTracked = input.serialTracked ?? current.serialTracked;
      const mergedStockTracked = input.stockTracked ?? current.stockTracked;

      if (mergedExpiryTracked && !mergedBatchTracked) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Resulting state would have expiryTracked without batchTracked (07 §6.1 invariant)",
          { field: "expiryTracked" },
        );
      }
      if (mergedSerialTracked && !mergedStockTracked) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Resulting state would have serialTracked without stockTracked (07 §6.1 invariant)",
          { field: "serialTracked" },
        );
      }

      const [row] = await tx
        .update(items)
        .set({ ...input, updatedBy: ctx.userId, updatedAt: new Date() })
        .where(and(eq(items.id, id), eq(items.tenantId, ctx.tenantId), isNull(items.deletedAt)))
        .returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError("DUPLICATE_RESOURCE", "An item with this SKU already exists", { field: "sku" });
    }
    throw e;
  }
}

/** Archive — isActive=false only, same reasoning as customer.ts's archiveCustomer. */
export async function archiveItem(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(items)
      .set({ isActive: false, updatedBy: ctx.userId, updatedAt: new Date() })
      .where(and(eq(items.id, id), eq(items.tenantId, ctx.tenantId), isNull(items.deletedAt)))
      .returning();
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
    return row;
  });
}