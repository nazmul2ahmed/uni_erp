import { eq } from "drizzle-orm";
import { branches, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreateBranchInput } from "@erp/validation";
import type { TenantContext } from "../guard";

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

export async function listBranches(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, (tx) =>
    tx.query.branches.findMany({ where: eq(branches.tenantId, ctx.tenantId), orderBy: (b, { asc }) => [asc(b.name)] }),
  );
}

export async function createBranch(ctx: TenantContext, input: CreateBranchInput) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    try {
      const [row] = await tx
        .insert(branches)
        .values({ tenantId: ctx.tenantId, name: input.name, code: input.code, address: input.address, phone: input.phone, isActive: input.isActive ?? true })
        .returning();
      return row!;
    } catch (e) {
      if (isUniqueViolation(e)) {
        // branches_tenant_code_unique (schema/commerce.ts).
        throw new AppError("DUPLICATE_RESOURCE", "A branch with this code already exists for this tenant", { field: "code" });
      }
      throw e;
    }
  });
}
