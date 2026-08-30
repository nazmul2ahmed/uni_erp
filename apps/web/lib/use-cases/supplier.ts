/**
 * Supplier application-layer use cases.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §5 (structurally mirrors
 * Customer, per 02 §8) and 11_API_SPECIFICATION.md §6.
 *
 * Same RLS discipline as customer.ts (all queries — reads and
 * writes — go through withTenantTransaction; see that file's
 * docblock for the full explanation and the pre-existing bug this
 * pattern avoids).
 *
 * Same deferrals as customer.ts: no GetSupplierLedger (depends on
 * core.purchases/core.payments, not yet built), no Idempotency-Key
 * handling (optional for this entity per 11 §24), no audit logging
 * (Supplier CRUD is not in 07 §15.2's audited-actions list), simple
 * limit/offset pagination (11 §2.3's small-admin-list carve-out).
 */
import { eq, and, or, ilike, isNull } from "drizzle-orm";
import { suppliers, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";
import type { CreateSupplierInput, UpdateSupplierInput } from "@erp/validation";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

export async function listSuppliers(
  ctx: TenantContext,
  opts: { q?: string; limit?: number; offset?: number },
) {
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const offset = opts.offset ?? 0;

  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const conditions = [eq(suppliers.tenantId, ctx.tenantId), isNull(suppliers.deletedAt)];
    if (opts.q) {
      const term = `%${opts.q}%`;
      conditions.push(or(ilike(suppliers.name, term), ilike(suppliers.phone, term))!);
    }
    return tx.query.suppliers.findMany({
      where: and(...conditions),
      orderBy: (s, { asc }) => [asc(s.name)],
      limit,
      offset,
    });
  });
}

export async function getSupplier(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const row = await tx.query.suppliers.findFirst({
      where: and(eq(suppliers.id, id), eq(suppliers.tenantId, ctx.tenantId), isNull(suppliers.deletedAt)),
    });
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Supplier not found");
    return row;
  });
}

export async function createSupplier(ctx: TenantContext, input: CreateSupplierInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(suppliers)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          phone: input.phone,
          email: input.email,
          address: input.address,
          contactPerson: input.contactPerson,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // suppliers_tenant_phone_unique (0004_rls_policies_phase2.sql)
      throw new AppError("DUPLICATE_RESOURCE", "A supplier with this phone number already exists", {
        field: "phone",
      });
    }
    throw e;
  }
}

export async function updateSupplier(ctx: TenantContext, id: string, input: UpdateSupplierInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(suppliers)
        .set({ ...input, updatedBy: ctx.userId, updatedAt: new Date() })
        .where(and(eq(suppliers.id, id), eq(suppliers.tenantId, ctx.tenantId), isNull(suppliers.deletedAt)))
        .returning();
      if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Supplier not found");
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError("DUPLICATE_RESOURCE", "A supplier with this phone number already exists", {
        field: "phone",
      });
    }
    throw e;
  }
}

/** Archive — isActive=false only, same reasoning as customer.ts's archiveCustomer. */
export async function archiveSupplier(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(suppliers)
      .set({ isActive: false, updatedBy: ctx.userId, updatedAt: new Date() })
      .where(and(eq(suppliers.id, id), eq(suppliers.tenantId, ctx.tenantId), isNull(suppliers.deletedAt)))
      .returning();
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Supplier not found");
    return row;
  });
}