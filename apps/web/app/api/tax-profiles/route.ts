import { NextRequest } from "next/server";
import { AppError } from "@erp/shared";
import { createTaxProfileSchema } from "@erp/validation";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { createTaxProfile, listTaxProfiles } from "@/lib/use-cases/tax-profile";

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");
    return listTaxProfiles(ctx);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.manage");
    const body = await req.json().catch(() => null);
    const parsed = createTaxProfileSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid tax profile payload", { issues: parsed.error.issues });
    }
    return createTaxProfile(ctx, parsed.data);
  })();
}
