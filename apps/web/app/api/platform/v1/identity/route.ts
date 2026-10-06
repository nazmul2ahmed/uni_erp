import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requirePlatformOperator } from "@/lib/platform-guard";
import { PLATFORM_CAPABILITIES, platformEnvelope } from "@/lib/platform-contract";

export const dynamic = "force-dynamic";

// Platform Integration Contract v1 (Plan/31): who am I, which contract, what can I report.
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    await requirePlatformOperator(req.headers);
    return platformEnvelope({ capabilities: PLATFORM_CAPABILITIES });
  })();
}
