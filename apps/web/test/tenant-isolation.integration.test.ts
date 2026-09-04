/**
 * Tenant Isolation Testing Matrix — Integration layer.
 * Per 24_TESTING_STRATEGY.md §5 ("Tenant A session cannot read Tenant
 * B's customer/supplier/item/... via direct ID substitution (IDOR)
 * -> 404, never 403") and 13_SECURITY_SPECIFICATION.md §9.1/§9.3
 * (mandatory, non-overridable CI gate — "no override path", 05 §163).
 *
 * WHAT THIS SUITE IS, AND WHY IT IS NEEDED
 * -----------------------------------------------------------------
 * Two isolation-relevant tests already exist in this repository:
 *
 *   - packages/db/test/rls.test.ts proves the RLS POLICY MECHANISM
 *     works, using raw SQL directly against core.business_profiles.
 *   - apps/web/test/phase1.test.ts's "allows only the active tenant
 *     to own a resource" proves requireResourceOwnership()'s LOGIC in
 *     isolation, with a hand-built context and a stubbed loader.
 *
 * Neither exercises the actual application code path a real request
 * takes for Customer/Supplier/Item: guard-resolved TenantContext ->
 * use-case function (customer.ts/supplier.ts/item.ts) ->
 * withTenantTransaction -> RLS-protected core.* table -> real
 * PostgreSQL. This suite fills that gap — it is an INTEGRATION test
 * per 24 §2.1 ("Use Case -> Repository -> real PostgreSQL"), not a
 * mocked Domain/Unit test (unlike phase1.test.ts/routes.test.ts,
 * which mock @erp/db entirely).
 *
 * PREREQUISITE (same as packages/db/test/rls.test.ts)
 * -----------------------------------------------------------------
 * Requires a live PostgreSQL reachable via DATABASE_URL_APP (the
 * erp_app runtime role — see packages/db/client.ts's docblock for
 * why the superuser/owner `erp` connection must never be used for
 * this class of test), with migrations AND seed already applied:
 *
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm db:migrate
 *   pnpm db:seed
 *
 * Per 24 §9.1 ("every integration/API/E2E test suite operates
 * against at least TWO seeded tenants") — this suite provisions its
 * own two tenants (via the REAL registerOwnerAndTenant use case, per
 * 24 §9.2's "seed via the SAME Use Cases as production onboarding" —
 * never hand-crafted SQL) rather than depending on any pre-existing
 * fixture tenant.
 *
 * CROSS-TENANT FK GUARD (formerly a KNOWN GAP — now fixed)
 * -----------------------------------------------------------------
 * Per 05 §81 ("Cross-tenant foreign key কখনো allowed নয়") and 05
 * §126's New Table Checklist ("Foreign keys tenant-safe"), every FK
 * from one tenant-owned row to another must be verified as
 * belonging to the SAME tenant at the application layer (the DB FK
 * constraint alone only proves the referenced row exists SOMEWHERE,
 * not that it is tenant-owned by the referencing row's own tenant).
 * `createItem`/`updateItem` (item.ts) previously did NOT verify this
 * for `categoryId` / `brandId` / `unitId` — flagged as a finding,
 * fixed on explicit approval via `assertItemForeignKeysBelongToTenant`
 * in item.ts (applied identically on create AND update). The tests
 * below assert the FIXED (rejecting) behavior for both paths.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  memberships,
  tenants,
  users,
  customers,
  suppliers,
  items,
  units,
  itemCategories,
  brands,
  businessProfiles,
  withTenantTransaction,
} from "@erp/db";
import {
  createCustomerSchema,
  createSupplierSchema,
  createItemSchema,
  createUnitSchema,
  createItemCategorySchema,
  createBrandSchema,
} from "@erp/validation";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import type { TenantContext } from "../lib/guard";
import { createCustomer, getCustomer, listCustomers, updateCustomer, archiveCustomer } from "../lib/use-cases/customer";
import { createSupplier, getSupplier, listSuppliers, updateSupplier, archiveSupplier } from "../lib/use-cases/supplier";
import { createItem, getItem, listItems, updateItem, archiveItem } from "../lib/use-cases/item";
import { createUnit, createItemCategory, createBrand } from "../lib/use-cases/catalog";

interface Fixture {
  userId: string;
  tenantId: string;
  membershipId: string;
  ctx: TenantContext;
  unitId: string; // core.items.unitId is NOT NULL — every tenant needs one
}

let A: Fixture;
let B: Fixture;

async function buildContext(userId: string, tenantId: string, membershipId: string): Promise<TenantContext> {
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, membershipId) });
  if (!membership) throw new Error("Fixture setup failed: membership not found after registration");
  return {
    requestId: randomUUID(),
    userId,
    tenantId,
    membershipId,
    roleId: membership.roleId,
    storageMode: "SHARED",
  };
}

async function provisionTenant(label: string): Promise<Fixture> {
  // Uses the REAL onboarding use case (apps/web/lib/tenant-onboarding.ts),
  // not hand-rolled SQL — per 24 §9.2, "Seed via the SAME Use Cases as
  // production onboarding." Unique email per run avoids collisions
  // against a persistent dev database across repeated test runs.
  const registration = await registerOwnerAndTenant({
    email: `isolation-test-${label}-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: `${label} Owner`,
    businessName: `${label} Business`,
  });
  const ctx = await buildContext(registration.userId, registration.tenantId, registration.membershipId);
  const unit = await createUnit(ctx, createUnitSchema.parse({ name: "Piece", symbol: "pc" }));
  return { ...registration, ctx, unitId: unit.id };
}

beforeAll(async () => {
  A = await provisionTenant("tenant-a");
  B = await provisionTenant("tenant-b");
}, 30_000);

afterAll(async () => {
  // Explicit, tenant-scoped cleanup (SET LOCAL app.tenant_id first)
  // rather than relying on control.tenants' ON DELETE CASCADE to
  // clean up RLS-protected core.* rows — cascading FK actions'
  // interaction with row security is not a behavior this suite
  // wants to depend on being correct in order to merely tear itself
  // down. Each tenant deletes only its own rows, which RLS permits.
  for (const fixture of [A, B]) {
    if (!fixture) continue;
    await withTenantTransaction(fixture.tenantId, async (tx) => {
      await tx.delete(customers).where(eq(customers.tenantId, fixture.tenantId));
      await tx.delete(suppliers).where(eq(suppliers.tenantId, fixture.tenantId));
      await tx.delete(items).where(eq(items.tenantId, fixture.tenantId));
      await tx.delete(units).where(eq(units.tenantId, fixture.tenantId));
      await tx.delete(itemCategories).where(eq(itemCategories.tenantId, fixture.tenantId));
      await tx.delete(brands).where(eq(brands.tenantId, fixture.tenantId));
      await tx.delete(businessProfiles).where(eq(businessProfiles.tenantId, fixture.tenantId));
    });
  }
  // control.* tables carry no RLS (0001/0004_rls_policies*.sql only
  // touch core.*) — plain deletes are correct here. Deleting the
  // tenant cascades to control.memberships (onDelete: "cascade",
  // schema/control.ts).
  for (const fixture of [A, B]) {
    if (!fixture) continue;
    await db.delete(tenants).where(eq(tenants.id, fixture.tenantId));
    await db.delete(users).where(eq(users.id, fixture.userId));
  }
});

describe("Customer tenant isolation (24 §5)", () => {
  it("Tenant B cannot read Tenant A's customer by ID substitution (IDOR) -> RESOURCE_NOT_FOUND, never a different tenant's data", async () => {
    const created = await createCustomer(A.ctx, createCustomerSchema.parse({ name: "Alpha Customer", phone: "01700000001" }));

    await expect(getCustomer(B.ctx, created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });
    // Sanity: the owning tenant can still read it (proves the 404
    // above is tenant-scoping, not a broken fixture/lookup).
    await expect(getCustomer(A.ctx, created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("Tenant B's customer list never includes Tenant A's customers", async () => {
    const created = await createCustomer(A.ctx, createCustomerSchema.parse({ name: "Alpha Only", phone: "01700000002" }));

    const bList = await listCustomers(B.ctx, {});
    expect(bList.some((row) => row.id === created.id)).toBe(false);

    const aList = await listCustomers(A.ctx, {});
    expect(aList.some((row) => row.id === created.id)).toBe(true);
  });

  it("Tenant B cannot update Tenant A's customer via ID substitution", async () => {
    const created = await createCustomer(A.ctx, createCustomerSchema.parse({ name: "Untouched", phone: "01700000003" }));

    await expect(updateCustomer(B.ctx, created.id, { name: "Hijacked" })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });

    const stillA = await getCustomer(A.ctx, created.id);
    expect(stillA.name).toBe("Untouched");
  });

  it("Tenant B cannot archive Tenant A's customer via ID substitution", async () => {
    const created = await createCustomer(A.ctx, createCustomerSchema.parse({ name: "Still Active", phone: "01700000004" }));

    await expect(archiveCustomer(B.ctx, created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });

    const stillA = await getCustomer(A.ctx, created.id);
    expect(stillA.isActive).toBe(true);
  });

  it("phone uniqueness is tenant-scoped, not global (05 §83)", async () => {
    // Same phone number, two different tenants — must NOT collide,
    // proving customers_tenant_phone_unique (0004_rls_policies_phase2.sql)
    // is a composite (tenant_id, phone) constraint, not a bare UNIQUE(phone).
    await expect(
      createCustomer(A.ctx, createCustomerSchema.parse({ name: "A Shared Phone", phone: "01700000099" })),
    ).resolves.toBeDefined();
    await expect(
      createCustomer(B.ctx, createCustomerSchema.parse({ name: "B Shared Phone", phone: "01700000099" })),
    ).resolves.toBeDefined();
  });
});

describe("Supplier tenant isolation (24 §5)", () => {
  it("Tenant B cannot read Tenant A's supplier by ID substitution (IDOR) -> RESOURCE_NOT_FOUND", async () => {
    const created = await createSupplier(A.ctx, createSupplierSchema.parse({ name: "Alpha Supplier", phone: "01800000001" }));

    await expect(getSupplier(B.ctx, created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });
    await expect(getSupplier(A.ctx, created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("Tenant B's supplier list never includes Tenant A's suppliers", async () => {
    const created = await createSupplier(A.ctx, createSupplierSchema.parse({ name: "Alpha Only Supplier", phone: "01800000002" }));

    const bList = await listSuppliers(B.ctx, {});
    expect(bList.some((row) => row.id === created.id)).toBe(false);
  });

  it("Tenant B cannot update Tenant A's supplier via ID substitution", async () => {
    const created = await createSupplier(A.ctx, createSupplierSchema.parse({ name: "Untouched Supplier", phone: "01800000003" }));

    await expect(updateSupplier(B.ctx, created.id, { name: "Hijacked" })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });

    const stillA = await getSupplier(A.ctx, created.id);
    expect(stillA.name).toBe("Untouched Supplier");
  });

  it("Tenant B cannot archive Tenant A's supplier via ID substitution", async () => {
    const created = await createSupplier(A.ctx, createSupplierSchema.parse({ name: "Still Active Supplier", phone: "01800000004" }));

    await expect(archiveSupplier(B.ctx, created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });

    const stillA = await getSupplier(A.ctx, created.id);
    expect(stillA.isActive).toBe(true);
  });

  it("phone uniqueness is tenant-scoped, not global (05 §83)", async () => {
    await expect(
      createSupplier(A.ctx, createSupplierSchema.parse({ name: "A Shared Phone Supplier", phone: "01800000099" })),
    ).resolves.toBeDefined();
    await expect(
      createSupplier(B.ctx, createSupplierSchema.parse({ name: "B Shared Phone Supplier", phone: "01800000099" })),
    ).resolves.toBeDefined();
  });
});

describe("Item tenant isolation (24 §5)", () => {
  it("Tenant B cannot read Tenant A's item by ID substitution (IDOR) -> RESOURCE_NOT_FOUND", async () => {
    const created = await createItem(
      A.ctx,
      createItemSchema.parse({ name: "Alpha Widget", type: "PRODUCT", unitId: A.unitId, sku: "SKU-A-0001" }),
    );

    await expect(getItem(B.ctx, created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });
    await expect(getItem(A.ctx, created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("Tenant B's item list never includes Tenant A's items", async () => {
    const created = await createItem(
      A.ctx,
      createItemSchema.parse({ name: "Alpha Only Widget", type: "PRODUCT", unitId: A.unitId, sku: "SKU-A-0002" }),
    );

    const bList = await listItems(B.ctx, {});
    expect(bList.some((row) => row.id === created.id)).toBe(false);
  });

  it("Tenant B cannot update Tenant A's item via ID substitution", async () => {
    const created = await createItem(
      A.ctx,
      createItemSchema.parse({ name: "Untouched Widget", type: "PRODUCT", unitId: A.unitId, sku: "SKU-A-0003" }),
    );

    await expect(updateItem(B.ctx, created.id, { name: "Hijacked" })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });

    const stillA = await getItem(A.ctx, created.id);
    expect(stillA.name).toBe("Untouched Widget");
  });

  it("Tenant B cannot archive Tenant A's item via ID substitution", async () => {
    const created = await createItem(
      A.ctx,
      createItemSchema.parse({ name: "Still Active Widget", type: "PRODUCT", unitId: A.unitId, sku: "SKU-A-0004" }),
    );

    await expect(archiveItem(B.ctx, created.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });

    const stillA = await getItem(A.ctx, created.id);
    expect(stillA.isActive).toBe(true);
  });

  it("sku uniqueness is tenant-scoped, not global (05 §83)", async () => {
    await expect(
      createItem(A.ctx, createItemSchema.parse({ name: "A Shared SKU", type: "PRODUCT", unitId: A.unitId, sku: "SKU-SHARED-0001" })),
    ).resolves.toBeDefined();
    await expect(
      createItem(B.ctx, createItemSchema.parse({ name: "B Shared SKU", type: "PRODUCT", unitId: B.unitId, sku: "SKU-SHARED-0001" })),
    ).resolves.toBeDefined();
  });

  it("createItem rejects a cross-tenant unitId (05 §81/§126 — cross-tenant FK forbidden)", async () => {
    await expect(
      createItem(A.ctx, createItemSchema.parse({ name: "Cross-Tenant Unit", type: "PRODUCT", unitId: B.unitId, sku: "SKU-A-XFK-0001" })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });

  it("createItem rejects a cross-tenant categoryId / brandId", async () => {
    const bCategory = await createItemCategory(B.ctx, createItemCategorySchema.parse({ name: "B-Only Category" }));
    const bBrand = await createBrand(B.ctx, createBrandSchema.parse({ name: "B-Only Brand" }));

    await expect(
      createItem(
        A.ctx,
        createItemSchema.parse({ name: "Cross-Tenant Category", type: "PRODUCT", unitId: A.unitId, categoryId: bCategory.id, sku: "SKU-A-XFK-0002" }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });

    await expect(
      createItem(
        A.ctx,
        createItemSchema.parse({ name: "Cross-Tenant Brand", type: "PRODUCT", unitId: A.unitId, brandId: bBrand.id, sku: "SKU-A-XFK-0003" }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });

  it("updateItem rejects re-pointing an existing item at a cross-tenant unitId (fix applies to UPDATE too, not just CREATE)", async () => {
    const created = await createItem(
      A.ctx,
      createItemSchema.parse({ name: "Originally Fine", type: "PRODUCT", unitId: A.unitId, sku: "SKU-A-XFK-0004" }),
    );

    await expect(updateItem(A.ctx, created.id, { unitId: B.unitId })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });

    // Confirm the reject was a no-op — the item's unit was never changed.
    const stillA = await getItem(A.ctx, created.id);
    expect(stillA.unitId).toBe(A.unitId);
  });
});
