import { redirect } from "next/navigation";
import { AppError } from "@erp/shared";
import { requireTenantContext } from "@/lib/guard";
import { landingPath } from "@/lib/navigation";
import { operatorLanding } from "@/lib/platform-guard";

// Decision NAV-001: send each user to a page their role can actually use
// (a cashier lands on the POS, not on a dashboard they cannot open).
// ADR-001: a platform operator has no workspace, so they land on /platform instead of the login page.
export default async function HomePage() {
  let target: string;
  try {
    const ctx = await requireTenantContext();
    target = landingPath(ctx.permissions);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    // not signed in / no usable workspace; an account on a one-time password goes to the change page (Decision SEC-008)
    target = (await operatorLanding()) ?? (e.code === "PASSWORD_CHANGE_REQUIRED" ? "/settings/password" : "/login");
  }
  redirect(target);
}
