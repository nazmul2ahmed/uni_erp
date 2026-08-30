import { NextRequest } from "next/server";
import { updateCustomerSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { getCustomer, updateCustomer } from "@/lib/use-cases/customer";

/** GET /api/customers/:id — per 11 §5 [customers.view]. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "customers.view");
    return getCustomer(ctx, params.id);
  })();
}

/** PATCH /api/customers/:id — per 11 §5 [customers.update]. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "customers.update");

    const body = await req.json().catch(() => null);
    const parsed = updateCustomerSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid customer payload", {
        issues: parsed.error.issues,
      });
    }

    return updateCustomer(ctx, params.id, parsed.data);
  })();
}