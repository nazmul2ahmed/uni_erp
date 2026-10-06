/**
 * DiscountThresholdPolicy — Integration Test.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §7.5a (Decision DOM-006) and
 * §7.6a (Extension Points Registry, Decision DOM-007).
 *
 * WHY THIS FILE EXISTS
 * -----------------------------------------------------------------
 * Phase 2 code-verification pass (Second Reconciliation, per the
 * project's ongoing Phase 0.5/2 audit) found that `sales.discount.override`
 * was seeded as a permission and referenced in code comments, but had
 * NO actual enforcement inside `completeSale()` — any actor holding
 * `sales.create` could apply an unlimited discount. This suite proves
 * the fix (lib/use-cases/sale.ts's `DiscountThresholdPolicy` /
 * `checkDiscountCeiling`) against a REAL PostgreSQL instance and REAL
 * seeded roles (OWNER has the override permission; STAFF does not,
 * per packages/db/seed/seed-control-plane.ts's PRESET_ROLES) — not a
 * mocked unit test, since the policy's correctness depends on the
 * real role -> permission join (resolvePermissions, lib/guard.ts).
 *
 * Per 24_TESTING_STRATEGY.md §12 point 4 ("every quantity-limit test
 * MUST include the `=` boundary, not just `<` and `>`") — boundary
 * cases at exactly the tenant ceiling are included below, not just
 * clearly-under/clearly-over cases.
 *
 * PREREQUISITE (same as tenant-isolation.integration.test.ts):
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm db:migrate
 *   pnpm db:seed
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLogs,
  businessProfiles,
  customers,
  db,
  items,
  journalEntries,
  journals,
  memberships,
  paymentAllocations,
  payments,
  receivables,
  roles,
  saleItems,
  sales,
  tenants,
  units,
  users,
  withTenantTransaction,
} from "@erp/db";
import { createUnitSchema, createCustomerSchema, createItemSchema } from "@erp/validation";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { createUnit } from "../lib/use-cases/catalog";
import { createCustomer } from "../lib/use-cases/customer";
import { createItem } from "../lib/use-cases/item";
import { completeSale } from "../lib/use-cases/sale";
import { hashPassword } from "../lib/password";

let tenantId: string;
let ownerUserId: string;
let staffUserId: string;
let ownerCtx: TenantContext; // OWNER — has sales.discount.override (seed)
let staffCtx: TenantContext; // STAFF — does NOT have it (seed)
let branchId: string;
let warehouseId: string;
let customerId: string;
let itemId: string;
let persistedSellingPrice: string;
const SELLING_PRICE = "1000.00"; // round number simplifies percent math

async function buildContext(userId: string, membershipId: string): Promise<TenantContext> {
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, membershipId) });
  if (!membership) throw new Error("Fixture setup failed: membership not found");
  return {
    requestId: randomUUID(),
    userId,
    tenantId,
    membershipId,
    roleId: membership.roleId,
    storageMode: "SHARED",
    permissions: await resolvePermissions(membership.roleId),
    roleKey: await resolveRoleKey(membership.roleId),
  };
}

beforeAll(async () => {
  const registration = await registerOwnerAndTenant({
    email: `discount-policy-test-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Discount Test Owner",
    businessName: "Discount Test Business",
  });
  tenantId = registration.tenantId;
  ownerUserId = registration.userId;
  ownerCtx = await buildContext(registration.userId, registration.membershipId);

  // Default branch/warehouse are created by registerOwnerAndTenant
  // itself (lib/tenant-onboarding.ts) but not returned — fetch them
  // the same way any real request would (tenant-scoped query).
  const branchRow = await withTenantTransaction(tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq }) => eq(b.tenantId, tenantId) }));
  const warehouseRow = await withTenantTransaction(tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq }) => eq(w.tenantId, tenantId) }));
  if (!branchRow || !warehouseRow) throw new Error("Fixture setup failed: default branch/warehouse missing");
  branchId = branchRow.id;
  warehouseId = warehouseRow.id;

  const unit = await createUnit(ownerCtx, createUnitSchema.parse({ name: "Piece", symbol: "pc" }));
  const customer = await createCustomer(ownerCtx, createCustomerSchema.parse({ type: "INDIVIDUAL", name: "Discount Test Customer" }));
  customerId = customer.id;

  // stockTracked: false — this suite tests DISCOUNT policy only;
  // stock-availability is already covered by 09's own test matrix
  // (24 §4) and is orthogonal to this fix.
  const item = await createItem(
    ownerCtx,
    createItemSchema.parse({ name: "Discount Test Item", type: "SERVICE", unitId: unit.id, sellingPrice: SELLING_PRICE, stockTracked: false }),
  );
  itemId = item.id;
  // completeSale() requires line.unitPrice === item.sellingPrice EXACTLY
  // (07 §7.5's "price is no longer current" staleness guard) — use the
  // persisted, normalized value (money schemas may not echo back the
  // exact input string, e.g. trailing-zero formatting), not the raw
  // SELLING_PRICE literal.
  persistedSellingPrice = item.sellingPrice;

  // STAFF membership — created via a direct insert (not an invite
  // Use Case) because Staff/Membership management (05 §77) has not
  // landed yet (confirmed absent from app/api during this
  // reconciliation pass) — this is a narrowly-scoped, commented
  // exception to 24 §9.2's "seed via the same Use Cases" preference,
  // justified by the Use Case genuinely not existing yet, not by
  // convenience.
  const staffRole = await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "STAFF")) });
  if (!staffRole) throw new Error("Fixture setup failed: STAFF preset role missing — run pnpm db:seed");
  const [staffUser] = await db.insert(users).values({ email: `discount-staff-${randomUUID()}@example.test`, passwordHash: await hashPassword("correct horse battery staple"), fullName: "Discount Test Staff" }).returning();
  const [staffMembership] = await db.insert(memberships).values({ userId: staffUser!.id, tenantId, roleId: staffRole.id, status: "ACTIVE" }).returning();
  staffUserId = staffUser!.id;
  staffCtx = await buildContext(staffUser!.id, staffMembership!.id);
}, 30_000);

afterAll(async () => {
  if (!tenantId) return;
  // FK-safe deletion order (mirrors tenant-isolation.integration.test.ts's
  // established pattern, §143-168 of that file) — journal entries
  // reference journals; journals/receivables/paymentAllocations/
  // saleItems all reference sales; payments are referenced by
  // paymentAllocations. Deleting in dependency order avoids relying
  // on any ON DELETE CASCADE being correct for this class of
  // RLS-protected core.* row, consistent with the existing suite's
  // documented rationale for doing this explicitly rather than
  // depending on control.tenants' cascade alone.
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.delete(journalEntries).where(eq(journalEntries.tenantId, tenantId));
    await tx.delete(journals).where(eq(journals.tenantId, tenantId));
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.tenantId, tenantId));
    await tx.delete(payments).where(eq(payments.tenantId, tenantId));
    await tx.delete(receivables).where(eq(receivables.tenantId, tenantId));
    // NOTE: core.audit_logs is deliberately NOT deleted here.
    // migrations-manual/0006_rls_audit_logs.sql REVOKEs UPDATE/DELETE
    // on this table from erp_app entirely (append-only by DB-level
    // design, per 07 §15.1) — attempting it would itself fail with a
    // permission-denied error, which is CORRECT behavior, not a bug
    // to work around. Test-run audit rows are harmless debris in a
    // disposable dev/test database.
    await tx.delete(saleItems).where(eq(saleItems.tenantId, tenantId));
    await tx.delete(sales).where(eq(sales.tenantId, tenantId));
    await tx.delete(items).where(eq(items.tenantId, tenantId));
    await tx.delete(units).where(eq(units.tenantId, tenantId));
    await tx.delete(customers).where(eq(customers.tenantId, tenantId));
    await tx.delete(businessProfiles).where(eq(businessProfiles.tenantId, tenantId));
  });
  // control.* carries no RLS (0001/0004_rls_policies*.sql only touch
  // core.*) — plain deletes are correct here, mirroring the existing
  // suite. Deleting the tenant cascades to control.memberships
  // (onDelete: "cascade", schema/control.ts).
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.delete(users).where(eq(users.id, ownerUserId));
  if (staffUserId) await db.delete(users).where(eq(users.id, staffUserId));
});

function saleInput(lineDiscount: string, orderDiscount = "0") {
  return {
    customerId,
    branchId,
    lines: [{ itemId, quantity: "1", unitPrice: persistedSellingPrice, warehouseId, lineDiscount }],
    orderDiscount,
    cashReceived: "0",
  };
}

describe("DiscountThresholdPolicy (07 §7.5a, Decision DOM-006)", () => {
  it("allows a discount exactly AT the tenant's default 20% ceiling without override permission", async () => {
    // 20% of 1000.00 = 200.00 — the `=` boundary, per 24 §12 point 4.
    const sale = await completeSale(staffCtx, saleInput("200.00"), randomUUID());
    expect(sale.discountTotal).toBe("200.0000");
  });

  it("rejects a discount just OVER the ceiling for an actor without sales.discount.override", async () => {
    // 20.1% — one hundredth of a percent over the boundary.
    await expect(completeSale(staffCtx, saleInput("201.00"), randomUUID())).rejects.toMatchObject({ code: "DISCOUNT_EXCEEDED" });
  });

  it("allows the same over-ceiling discount for an actor WITH sales.discount.override (OWNER)", async () => {
    const sale = await completeSale(ownerCtx, saleInput("201.00"), randomUUID());
    expect(sale.discountTotal).toBe("201.0000");
  });

  it("applies the identical ceiling to the order-level discount (not just line discount)", async () => {
    // Line discount 0, order-level discount 25% (250.00 of 1000.00) —
    // proves the policy cannot be bypassed by moving the discount from
    // the line into the order-level field (see the SCOPE NOTE comment
    // in lib/use-cases/sale.ts's DiscountThresholdPolicy docblock).
    await expect(completeSale(staffCtx, saleInput("0", "250.00"), randomUUID())).rejects.toMatchObject({ code: "DISCOUNT_EXCEEDED" });
  });

  it("records discountOverrideApplied on the audit entry when override was used", async () => {
    const operationId = randomUUID();
    await completeSale(ownerCtx, saleInput("500.00"), operationId); // 50% — requires override
    const auditRow = await withTenantTransaction(tenantId, (tx) =>
      tx.query.auditLogs.findFirst({ where: (a, { eq, and }) => and(eq(a.action, "sale.complete"), eq(a.entityType, "SALE")), orderBy: (a, { desc }) => [desc(a.occurredAt)] }),
    );
    // `after` is stored JSON.stringify()'d (text column, per
    // lib/audit.ts's docblock / packages/db/schema/core.ts:301-302) —
    // parse before asserting, not a jsonb column.
    const after = auditRow?.after ? (JSON.parse(auditRow.after) as { discountOverrideApplied?: boolean }) : null;
    expect(after?.discountOverrideApplied).toBe(true);
  });

  it("replaying the same operationId never re-evaluates the policy (idempotency, 07 §17)", async () => {
    const operationId = randomUUID();
    const first = await completeSale(staffCtx, saleInput("200.00"), operationId);
    // Second call with the SAME operationId but a payload that would
    // otherwise FAIL the ceiling — proves the idempotency short-circuit
    // (existing operationId lookup, sale.ts line ~141) returns the
    // prior result rather than re-running DiscountThresholdPolicy.
    const second = await completeSale(staffCtx, saleInput("999.00"), operationId);
    expect(second.id).toBe(first.id);
    expect(second.discountTotal).toBe("200.0000");
  });
});

describe("Per-role discount ceiling (Decision VAN-007, 30_MODULE_VAN_SALES.md §8)", () => {
  it("a role-specific ceiling overrides the tenant-wide default for that role only", async () => {
    await withTenantTransaction(tenantId, (tx) =>
      tx
        .update(businessProfiles)
        .set({ settingsJson: JSON.stringify({ sales: { discountCeilings: { default: 20, byRoleKey: { STAFF: 5 } } } }) })
        .where(eq(businessProfiles.tenantId, tenantId)),
    );

    // STAFF's ceiling is now 5%, not the tenant default of 20% —
    // 6% (60.00 of 1000.00) exceeds STAFF's role-specific ceiling.
    await expect(completeSale(staffCtx, saleInput("60.00"), randomUUID())).rejects.toMatchObject({ code: "DISCOUNT_EXCEEDED" });
    // 5% exactly still passes (the `=` boundary, per 24 §12 point 4).
    const sale = await completeSale(staffCtx, saleInput("50.00"), randomUUID());
    expect(sale.discountTotal).toBe("50.0000");

    // OWNER holds sales.discount.override regardless of any ceiling —
    // unaffected by STAFF's tightened role-specific value.
    const ownerSale = await completeSale(ownerCtx, saleInput("300.00"), randomUUID());
    expect(ownerSale.discountTotal).toBe("300.0000");

    // Reset for any subsequent test in this file relying on the
    // original tenant-wide-only default.
    await withTenantTransaction(tenantId, (tx) => tx.update(businessProfiles).set({ settingsJson: "{}" }).where(eq(businessProfiles.tenantId, tenantId)));
  });

  it("falls back to the tenant-wide `default` for a role with no explicit byRoleKey entry", async () => {
    await withTenantTransaction(tenantId, (tx) =>
      tx
        .update(businessProfiles)
        .set({ settingsJson: JSON.stringify({ sales: { discountCeilings: { default: 8 } } }) }) // no byRoleKey.STAFF entry
        .where(eq(businessProfiles.tenantId, tenantId)),
    );

    await expect(completeSale(staffCtx, saleInput("90.00"), randomUUID())).rejects.toMatchObject({ code: "DISCOUNT_EXCEEDED" }); // 9% > 8%
    const sale = await completeSale(staffCtx, saleInput("80.00"), randomUUID()); // 8% == ceiling
    expect(sale.discountTotal).toBe("80.0000");

    await withTenantTransaction(tenantId, (tx) => tx.update(businessProfiles).set({ settingsJson: "{}" }).where(eq(businessProfiles.tenantId, tenantId)));
  });

  it("legacy flat maxDiscountPercent (pre-VAN-007 tenants) still applies as a fallback", async () => {
    await withTenantTransaction(tenantId, (tx) =>
      tx.update(businessProfiles).set({ settingsJson: JSON.stringify({ sales: { maxDiscountPercent: 3 } }) }).where(eq(businessProfiles.tenantId, tenantId)),
    );

    await expect(completeSale(staffCtx, saleInput("40.00"), randomUUID())).rejects.toMatchObject({ code: "DISCOUNT_EXCEEDED" }); // 4% > 3%

    await withTenantTransaction(tenantId, (tx) => tx.update(businessProfiles).set({ settingsJson: "{}" }).where(eq(businessProfiles.tenantId, tenantId)));
  });
});
