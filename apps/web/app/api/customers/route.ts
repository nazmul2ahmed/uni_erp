import { NextRequest } from "next/server";
import { createCustomerSchema, searchCustomersQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listCustomers, createCustomer } from "@/lib/use-cases/customer";

/** GET /api/customers — per 11 §5 [customers.view]. */
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "customers.view");

    const url = new URL(req.url);
    const parsed = searchCustomersQuerySchema.safeParse({ q: url.searchParams.get("q") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid query parameters");

    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    return listCustomers(ctx, {
      q: parsed.data.q,
      limit: limitParam ? Number(limitParam) : undefined,
      offset: offsetParam ? Number(offsetParam) : undefined,
    });
  })();
}

/** POST /api/customers — per 11 §5 [customers.create] [Idempotent, optional]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "customers.create");

    const body = await req.json().catch(() => null);
    const parsed = createCustomerSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid customer payload", {
        issues: parsed.error.issues,
      });
    }

    return createCustomer(ctx, parsed.data);
  })();
}