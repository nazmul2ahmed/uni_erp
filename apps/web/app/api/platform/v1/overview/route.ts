import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requirePlatformOperator } from "@/lib/platform-guard";
import { platformEnvelope } from "@/lib/platform-contract";
import { getPlatformOverview } from "@/lib/use-cases/platform-overview";

export const dynamic = "force-dynamic";

// Platform Integration Contract v1 (Plan/31): control-plane aggregates only. Read-only.
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    await requirePlatformOperator(req.headers);
    return platformEnvelope(await getPlatformOverview());
  })();
}
