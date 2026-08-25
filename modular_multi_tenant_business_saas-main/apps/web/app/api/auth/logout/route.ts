import { apiHandler } from "@/lib/api-response";
import { destroySession } from "@/lib/session";

export async function POST() {
  return apiHandler(async () => {
    await destroySession();
    return { loggedOut: true };
  })();
}
