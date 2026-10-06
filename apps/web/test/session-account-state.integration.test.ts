/**
 * The ACCOUNT is part of a session's validity -- Decision SEC-010. Real PostgreSQL; the real loadSessionById.
 * Before this decision `users.is_active` was consulted only at sign-in, so deactivating an account left its
 * live sessions working until they timed out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createOwnerDb, db, memberships, platformOperators, rolePermissions, roles, sessions, tenants, users } from "@erp/db";
import { AppError } from "@erp/shared";

const cookie = vi.hoisted(() => ({ sessionId: null as string | null }));
// Only the cookie is faked: the id it carries is validated by the real loadSessionById.
vi.mock("../lib/session", async (original) => {
  const real = await original<typeof import("../lib/session")>();
  return { ...real, loadSession: async () => (cookie.sessionId ? real.loadSessionById(cookie.sessionId) : null) };
});

import { loadSessionById } from "../lib/session";
import { requireAuth, requireTenantContext } from "../lib/guard";
import { requirePlatformOperator } from "../lib/platform-guard";
import { hashPassword } from "../lib/password";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createOperatorAccount } from "../lib/platform-operator-admin";
import { GET as meRoute } from "../app/api/auth/me/route";
import { POST as changePasswordRoute } from "../app/api/auth/password/change/route";

const owner = createOwnerDb();
const BY = `test:${randomUUID().slice(0, 8)}`;
const createdUsers: string[] = [];
let tenant: { tenantId: string; userId: string };
let tenantRoleId: string;

const addSession = async (userId: string, over: Partial<{ activeTenantId: string | null; expiresAt: Date; lastSeenAt: Date }> = {}) => {
  const id = randomUUID().replace(/-/g, "");
  await owner.db.insert(sessions).values({ id, userId, activeTenantId: over.activeTenantId ?? null, expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000), lastSeenAt: over.lastSeenAt ?? new Date() });
  return id;
};
const sessionExists = async (id: string) => Boolean(await owner.db.query.sessions.findFirst({ where: eq(sessions.id, id) }));
const setActive = (userId: string, isActive: boolean) => owner.db.update(users).set({ isActive }).where(eq(users.id, userId));
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as AppError | null)?.code ?? null;

beforeAll(async () => {
  const reg = await registerOwnerAndTenant({ email: `sas-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: "Sas Owner", businessName: "Sas Biz" });
  tenant = { tenantId: reg.tenantId, userId: reg.userId };
  createdUsers.push(reg.userId);
  tenantRoleId = (await db.query.memberships.findFirst({ where: eq(memberships.id, reg.membershipId) }))!.roleId;
}, 60_000);
beforeEach(() => { cookie.sessionId = null; process.env.PLATFORM_ADMIN_ENABLED = "true"; });
afterAll(async () => {
  delete process.env.PLATFORM_ADMIN_ENABLED;
  for (const id of createdUsers) await owner.db.delete(platformOperators).where(eq(platformOperators.userId, id)).catch(() => undefined);
  await owner.db.delete(memberships).where(eq(memberships.tenantId, tenant.tenantId)).catch(() => undefined);
  for (const r of await owner.db.query.roles.findMany({ where: eq(roles.tenantId, tenant.tenantId) })) await owner.db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
  await owner.db.delete(roles).where(eq(roles.tenantId, tenant.tenantId)).catch(() => undefined);
  await owner.db.delete(tenants).where(eq(tenants.id, tenant.tenantId)).catch(() => undefined);
  for (const id of createdUsers) await owner.db.delete(users).where(eq(users.id, id)).catch(() => undefined);
  await owner.close();
});

async function member() {
  const [u] = await owner.db.insert(users).values({ email: `sas-m-${randomUUID()}@example.test`, passwordHash: await hashPassword("old password for tests"), fullName: "Sas Member" }).returning();
  createdUsers.push(u!.id);
  await owner.db.insert(memberships).values({ userId: u!.id, tenantId: tenant.tenantId, roleId: tenantRoleId, status: "ACTIVE" });
  return u!.id;
}

describe("loadSessionById", () => {
  it("returns the session for an active account, carrying the one-time-password flag", async () => {
    const userId = await member();
    const sid = await addSession(userId, { activeTenantId: tenant.tenantId });
    expect(await loadSessionById(sid)).toMatchObject({ id: sid, userId, activeTenantId: tenant.tenantId, mustChangePassword: false });
    await owner.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, userId));
    expect((await loadSessionById(sid))?.mustChangePassword).toBe(true);
  });

  it("a DEACTIVATED account's live session stops working on the very next request, and the session is deleted", async () => {
    const userId = await member();
    const sid = await addSession(userId, { activeTenantId: tenant.tenantId });
    expect(await loadSessionById(sid)).not.toBeNull();
    await setActive(userId, false);
    expect(await loadSessionById(sid)).toBeNull();
    expect(await sessionExists(sid)).toBe(false);
  });

  it("reactivating the account does not resurrect the revoked session", async () => {
    const userId = await member();
    const sid = await addSession(userId);
    await setActive(userId, false);
    await loadSessionById(sid);
    await setActive(userId, true);
    expect(await loadSessionById(sid)).toBeNull();
  });

  it("deactivating one account never touches another account's session", async () => {
    const a = await member(), b = await member();
    const sa = await addSession(a), sb = await addSession(b);
    await setActive(a, false);
    expect(await loadSessionById(sa)).toBeNull();
    expect(await loadSessionById(sb)).not.toBeNull();
  });

  it("unknown, expired and idle sessions are still refused (no regression)", async () => {
    const userId = await member();
    expect(await loadSessionById("no-such-session")).toBeNull();
    expect(await loadSessionById(await addSession(userId, { expiresAt: new Date(Date.now() - 1000) }))).toBeNull();
    expect(await loadSessionById(await addSession(userId, { lastSeenAt: new Date(Date.now() - 8 * 24 * 3_600_000) }))).toBeNull();
  });
});

describe("every entry point refuses a deactivated account's cookie", () => {
  it("requireAuth, requireTenantContext, /api/auth/me and the password-change route all answer 401", async () => {
    const userId = await member();
    const sid = await addSession(userId, { activeTenantId: tenant.tenantId });
    cookie.sessionId = sid;
    expect((await requireTenantContext()).tenantId).toBe(tenant.tenantId); // works while active
    await setActive(userId, false);

    expect(await code(requireAuth())).toBe("AUTHENTICATION_REQUIRED");
    expect(await code(requireTenantContext())).toBe("AUTHENTICATION_REQUIRED");
    expect((await meRoute()).status).toBe(401);
    const res = await changePasswordRoute(new Request("http://localhost/api/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword: "old password for tests", newPassword: "a brand new password!" }) }) as never);
    expect(res.status).toBe(401);
  });

  it("the platform operator guard refuses a deactivated operator's session at the SESSION layer too", async () => {
    const op = await createOperatorAccount(owner.db, `sas-op-${randomUUID()}@example.test`, "Sas Op", BY);
    createdUsers.push(op.userId);
    await owner.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, op.userId));
    cookie.sessionId = await addSession(op.userId);
    expect((await requirePlatformOperator(new Headers())).userId).toBe(op.userId);
    await setActive(op.userId, false);
    expect(await code(requirePlatformOperator(new Headers()))).toBe("AUTHENTICATION_REQUIRED"); // 401, not merely 403
  });
});
