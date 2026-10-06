import { and, eq } from "drizzle-orm";
import { taxProfiles, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreateTaxProfileInput } from "@erp/validation";
import type { TenantContext } from "../guard";

export async function listTaxProfiles(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, (tx) =>
    tx.query.taxProfiles.findMany({
      where: eq(taxProfiles.tenantId, ctx.tenantId),
      orderBy: (profile, { asc }) => [asc(profile.name)],
    }),
  );
}

export async function createTaxProfile(ctx: TenantContext, input: CreateTaxProfileInput) {
  try {
    return await withTenantTransaction(ctx.tenantId, async (tx) => {
      const [profile] = await tx
        .insert(taxProfiles)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          rate: input.rate,
          isInclusive: false,
        })
        .returning();
      if (!profile) throw new AppError("INTERNAL_ERROR", "Unable to create tax profile");
      return profile;
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new AppError("DUPLICATE_RESOURCE", "A tax profile with this name already exists", { field: "name" });
    }
    throw error;
  }
}
