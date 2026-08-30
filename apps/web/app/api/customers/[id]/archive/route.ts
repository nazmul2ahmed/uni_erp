import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { archiveCustomer } from "@/lib/use-cases/customer";

/** POST /api/customers/:id/archive — per 11 §5 [customers.update]. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "customers.update");
    return archiveCustomer(ctx, params.id);
  })();
}