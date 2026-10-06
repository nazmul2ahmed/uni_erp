/**
 * Customer application-layer use cases.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §4.2 and 11_API_SPECIFICATION.md §5.
 *
 * CRITICAL: every query below (reads AND writes) runs through
 * withTenantTransaction() — never a plain unwrapped db.query / db.select
 * call. This is not stylistic: core.customers has Row Level Security
 * enabled (packages/db/migrations-manual/0004_rls_policies_phase2.sql),
 * and the RLS policy's `current_setting('app.tenant_id', true)` is
 * only populated inside a transaction that begins with
 * `SET LOCAL app.tenant_id = ...` (client.ts's withTenantTransaction).
 * A plain db.query.customers.findFirst(...) call OUTSIDE that
 * transaction runs with app.tenant_id = NULL, and per the fail-closed
 * RLS design (05 §159; NULL = anything is NULL, never TRUE in
 * Postgres), such a call returns ZERO rows regardless of any
 * application-layer WHERE clause — it would silently behave as if
 * the table were always empty, not merely "unfiltered."
 *
 * (This exact class of bug was found in the pre-existing
 * GET /api/tenant/profile handler during this implementation pass —
 * flagged separately, not fixed here without explicit approval, per
 * the Existing Code Rule.)
 *
 * NOT implemented in this pass (explicitly deferred, not silently
 * skipped):
 *   - GetCustomerLedger (07 §4.2) — depends on core.sales/
 *     core.payments/core.receivables, which do not exist yet
 *     (Sales/Payment domain is a later Phase 2 sub-phase). No route
 *     is wired for this until those tables + the Payment domain land.
 *   - Idempotency-Key handling (11 §2.2) — OPTIONAL for
 *     Customer/Supplier/Item per Decision API-001 (11 §24), unlike
 *     Sales/Purchase/Payment where it's REQUIRED. Deferred until a
 *     general idempotency mechanism is built for the optional case.
 *   - core.audit_logs — NOT required for Customer per 07 §15.2's
 *     "What Gets Audited" table (which lists Sales/Purchase/
 *     Inventory/Payment/Returns/Accounting specifically; Customer/
 *     Supplier/Item CRUD is not in that list).
 *   - Cursor-based pagination (11 §2.3 preference) — this pass uses
 *     simple limit/offset (capped), acceptable per 11 §2.3's carve-out
 *     for "small admin lists"; revisit if Customer lists grow large
 *     in practice.
 */
import { eq, and, or, ilike, isNull } from "drizzle-orm";
import { customers, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";
import type { CreateCustomerInput, UpdateCustomerInput } from "@erp/validation";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/** Postgres unique_violation SQLSTATE, per the `postgres` driver's PostgresError.code. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

export async function listCustomers(
  ctx: TenantContext,
  opts: { q?: string; limit?: number; offset?: number },
) {
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const offset = opts.offset ?? 0;

  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const conditions = [eq(customers.tenantId, ctx.tenantId), isNull(customers.deletedAt)];
    if (opts.q) {
      const term = `%${opts.q}%`;
      conditions.push(or(ilike(customers.name, term), ilike(customers.phone, term))!);
    }
    return tx.query.customers.findMany({
      where: and(...conditions),
      orderBy: (c, { asc }) => [asc(c.name)],
      limit,
      offset,
    });
  });
}

export async function getCustomer(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const row = await tx.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.tenantId, ctx.tenantId), isNull(customers.deletedAt)),
    });
    // Tenant-scoped WHERE + RLS together mean a cross-tenant id simply
    // isn't found here — the natural 404 (not 403) already satisfies
    // Decision SEC-001 (13 §3.2) without a separate ownership-loader
    // indirection.
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Customer not found");
    return row;
  });
}

export async function createCustomer(ctx: TenantContext, input: CreateCustomerInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(customers)
        .values({
          tenantId: ctx.tenantId,
          type: input.type,
          name: input.name,
          phone: input.phone,
          email: input.email,
          address: input.address,
          isWalkIn: input.isWalkIn,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // customers_tenant_phone_unique (0004_rls_policies_phase2.sql) —
      // per 07 §4.1 invariant: "phone unique per tenant unless isWalkIn".
      throw new AppError("DUPLICATE_RESOURCE", "A customer with this phone number already exists", {
        field: "phone",
      });
    }
    throw e;
  }
}

export async function updateCustomer(ctx: TenantContext, id: string, input: UpdateCustomerInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(customers)
        .set({ ...input, updatedBy: ctx.userId, updatedAt: new Date() })
        .where(and(eq(customers.id, id), eq(customers.tenantId, ctx.tenantId), isNull(customers.deletedAt)))
        .returning();
      if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Customer not found");
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError("DUPLICATE_RESOURCE", "A customer with this phone number already exists", {
        field: "phone",
      });
    }
    throw e;
  }
}

/**
 * Archive — sets isActive=false only (07 §4.1: "Cannot hard-delete...
 * archive only (isActive = false)"). Does NOT set deletedAt — that
 * column is reserved for a separate, not-yet-triggered hard-removal
 * marker (04 §97's soft-delete convention distinguishes the two: a
 * business-toggle "no longer usable in new transactions" state vs. a
 * removal marker). An archived customer remains visible in history
 * and in past-transaction lookups; it is simply excluded from
 * default active-customer pickers going forward at the UI layer.
 */
export async function archiveCustomer(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(customers)
      .set({ isActive: false, updatedBy: ctx.userId, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.tenantId, ctx.tenantId), isNull(customers.deletedAt)))
      .returning();
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "Customer not found");
    return row;
  });
}
