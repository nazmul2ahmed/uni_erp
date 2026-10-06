import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { createOwnerDb, memberships, sessions, tenants, users } from "@erp/db";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";

const email = `phase1-e2e-${crypto.randomUUID()}@example.test`;
const otherEmail = `phase1-e2e-other-${crypto.randomUUID()}@example.test`;
const password = "Phase1-E2E-Password-2026!";

test.afterAll(async () => {
  const owner = createOwnerDb();
  try {
    for (const testEmail of [email, otherEmail]) {
      const user = await owner.db.query.users.findFirst({
        where: eq(users.email, testEmail),
      });
      if (!user) continue;

      await owner.db.delete(sessions).where(eq(sessions.userId, user.id));
      const userMemberships = await owner.db.query.memberships.findMany({
        where: and(eq(memberships.userId, user.id), eq(memberships.status, "ACTIVE")),
      });
      for (const membership of userMemberships) {
        await owner.db.delete(tenants).where(eq(tenants.id, membership.tenantId));
      }
      await owner.db.delete(users).where(eq(users.id, user.id));
    }
  } finally {
    await owner.close();
  }
});

test("owners can sign in, but cannot select a workspace without membership", async ({ page }) => {
  const otherRegistration = await registerOwnerAndTenant({
    email: otherEmail,
    password,
    fullName: "Other Phase 1 E2E Owner",
    businessName: "Other Phase 1 E2E Workspace",
  });

  await page.goto("/register");
  await page.getByLabel("Full name").fill("Phase 1 E2E Owner");
  await page.getByLabel("Business name").fill("Phase 1 E2E Workspace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Executive dashboard" })).toBeVisible();

  const meResponse = await page.request.get("/api/auth/me");
  expect(meResponse.ok()).toBeTruthy();
  const me = (await meResponse.json()).data;
  expect(me.user.email).toBe(email);
  expect(me.activeTenantId).toBeTruthy();
  expect(me.activeTenant).toMatchObject({
    tenantId: me.activeTenantId,
    roleKey: "OWNER",
  });
  expect(me.activeTenant.permissions).toContain("reports.view");
  expect(me.memberships).toContainEqual(
    expect.objectContaining({
      tenantName: "Phase 1 E2E Workspace",
      roleKey: "OWNER",
      status: "ACTIVE",
    }),
  );

  const selectionResponse = await page.request.post("/api/auth/tenant/select", {
    data: { tenantId: otherRegistration.tenantId },
  });
  expect(selectionResponse.status()).toBe(403);
  expect((await selectionResponse.json()).error.code).toBe("TENANT_ACCESS_DENIED");
  const afterDeniedSelection = (await (await page.request.get("/api/auth/me")).json()).data;
  expect(afterDeniedSelection.activeTenantId).toBe(me.activeTenantId);

  const logoutResponse = await page.request.post("/api/auth/logout");
  expect(logoutResponse.ok()).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Executive dashboard" })).toBeVisible();
});
