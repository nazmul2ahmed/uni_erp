/**
 * Password change, forced change of one-time passwords, operator reset, and
 * append-only platform audit -- real-PostgreSQL adversarial test.
 * Decisions SEC-007 (audit append-only) and SEC-008 (password change); 13 s2.2 / s2.5.
 * Only the session cookie is mocked; the database, argon2, guards and privileges are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditEventsPlatform, createOwnerDb, db, memberships, platformOperators, rolePermissions, roles, sessions, tenants, users,
} from "@erp/db";
import { AppError } from "@erp/shared";

const session = vi.hoisted(() => ({ current: null as null | { id: string; userId: string; activeTenantId: string | null } }));
// Only the COOKIE is faked. The session is read from a real row by the real loadSessionById, so account state
// (is_active, must_change_password) is genuinely part of what these tests exercise (Decision SEC-010).
vi.mock("../lib/session", async (original) => {
  const real = await original<typeof import("../lib/session")>();
  return { ...real, loadSession: async () => (session.current ? real.loadSessionById(session.current.id) : null) };
});

import { requireTenantContext, resolvePermissions, resolveRoleKey, type TenantContext } from "../lib/guard";
import { hashPassword, verifyPassword } from "../lib/password";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { inviteStaff } from "../lib/use-cases/staff";
import { PASSWORD_CHANGE_MAX_FAILURES, changePassword } from "../lib/use-cases/password";
import { evaluateOperatorAccess, requirePlatformOperator } from "../lib/platform-guard";
import { createOperatorAccount, resetOperatorPassword } from "../lib/platform-operator-admin";
import { GET as meRoute } from "../app/api/auth/me/route";

const owner = createOwnerDb();
afterAll(async () => { await owner.close(); });
const BY = `test:${randomUUID().slice(0, 8)}`;
const OLD = "old password for tests";
const NEW = "a brand new password!";

const createdUsers: string[] = [];
const createdTenants: string[] = [];

async function newUser(over: { mustChange?: boolean } = {}) {
  const email = `pw-${randomUUID()}@example.test`;
  const [u] = await owner.db.insert(users).values({ email, passwordHash: await hashPassword(OLD), fullName: "Pw Test", mustChangePassword: over.mustChange ?? false }).returning();
  createdUsers.push(u!.id);
  return { id: u!.id, email };
}
async function openSession(userId: string, activeTenantId: string | null = null) {
  const id = randomUUID().replace(/-/g, "");
  await owner.db.insert(sessions).values({ id, userId, activeTenantId, expiresAt: new Date(Date.now() + 3_600_000) });
  return id;
}
const sessionIds = async (userId: string) => (await owner.db.select().from(sessions).where(eq(sessions.userId, userId))).map((s) => s.id).sort();
const hashOf = async (userId: string) => (await owner.db.query.users.findFirst({ where: eq(users.id, userId) }))!.passwordHash;
const auditRows = (userId: string, action: string) =>
  owner.db.select().from(auditEventsPlatform).where(and(eq(auditEventsPlatform.actorUserId, userId), eq(auditEventsPlatform.action, action)));
const codeOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as AppError | null)?.code ?? null;

let tenant: { tenantId: string; userId: string; membershipId: string; email: string; roleId: string; ctx: TenantContext };
beforeAll(async () => {
  const email = `pw-owner-${randomUUID()}@example.test`;
  const reg = await registerOwnerAndTenant({ email, password: OLD, fullName: "Pw Owner", businessName: "Pw Test Biz" });
  const m = await db.query.memberships.findFirst({ where: eq(memberships.id, reg.membershipId) });
  createdUsers.push(reg.userId); createdTenants.push(reg.tenantId);
  tenant = { ...reg, email, roleId: m!.roleId, ctx: { requestId: randomUUID(), userId: reg.userId, tenantId: reg.tenantId, membershipId: reg.membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) } };
}, 60_000);
beforeEach(() => { session.current = null; process.env.PLATFORM_ADMIN_ENABLED = "true"; });
afterAll(async () => {
  delete process.env.PLATFORM_ADMIN_ENABLED;
  for (const id of createdUsers) await owner.db.delete(platformOperators).where(eq(platformOperators.userId, id)).catch(() => undefined);
  for (const id of createdUsers) await owner.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.actorUserId, id)).catch(() => undefined);
  await owner.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.reason, BY)).catch(() => undefined);
  for (const t of createdTenants) {
    await owner.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.tenantId, t)).catch(() => undefined);
    await owner.db.delete(memberships).where(eq(memberships.tenantId, t)).catch(() => undefined);
    for (const r of await owner.db.query.roles.findMany({ where: eq(roles.tenantId, t) })) await owner.db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
    await owner.db.delete(roles).where(eq(roles.tenantId, t)).catch(() => undefined);
    await owner.db.delete(tenants).where(eq(tenants.id, t)).catch(() => undefined);
  }
  for (const id of createdUsers) await owner.db.delete(users).where(eq(users.id, id)).catch(() => undefined);
});

describe("changePassword -- proving the current password first", () => {
  it("changes the hash to one that verifies the NEW password only, and audits it without any secret", async () => {
    const u = await newUser();
    const sid = await openSession(u.id);
    const before = await hashOf(u.id);
    const result = await changePassword({ userId: u.id, sessionId: sid }, { currentPassword: OLD, newPassword: NEW }, "req-1");
    const after = await hashOf(u.id);

    expect(result.changed).toBe(true);
    expect(after).not.toBe(before);
    expect(await verifyPassword(after, NEW)).toBe(true);
    expect(await verifyPassword(after, OLD)).toBe(false);
    expect(after.startsWith("$argon2id$")).toBe(true);

    const rows = await auditRows(u.id, "user.password_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe("req-1");
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${OLD}|${NEW}|argon2`, "i"));
  });

  it("a wrong current password is refused, changes nothing and is audited", async () => {
    const u = await newUser();
    const sid = await openSession(u.id);
    const before = await hashOf(u.id);
    expect(await codeOf(changePassword({ userId: u.id, sessionId: sid }, { currentPassword: "not my password", newPassword: NEW }))).toBe("INVALID_CREDENTIALS");
    expect(await hashOf(u.id)).toBe(before);
    expect(await auditRows(u.id, "user.password_change_failed")).toHaveLength(1);
    expect(await auditRows(u.id, "user.password_changed")).toHaveLength(0);
  });

  it("a stolen session cookie cannot be used to brute-force the current password: 5 failures lock the endpoint, even for the right password", async () => {
    const u = await newUser();
    const sid = await openSession(u.id);
    for (let i = 0; i < PASSWORD_CHANGE_MAX_FAILURES; i++) {
      expect(await codeOf(changePassword({ userId: u.id, sessionId: sid }, { currentPassword: `wrong ${i}`, newPassword: NEW }))).toBe("INVALID_CREDENTIALS");
    }
    expect(await codeOf(changePassword({ userId: u.id, sessionId: sid }, { currentPassword: OLD, newPassword: NEW }))).toBe("RATE_LIMITED");
    expect(await verifyPassword(await hashOf(u.id), OLD)).toBe(true); // still the old password
  });

  it("the lockout is per account: another user is unaffected", async () => {
    const locked = await newUser();
    const lockedSid = await openSession(locked.id);
    for (let i = 0; i < PASSWORD_CHANGE_MAX_FAILURES; i++) await changePassword({ userId: locked.id, sessionId: lockedSid }, { currentPassword: `x${i}`, newPassword: NEW }).catch(() => undefined);
    const other = await newUser();
    expect((await changePassword({ userId: other.id, sessionId: await openSession(other.id) }, { currentPassword: OLD, newPassword: NEW })).changed).toBe(true);
  });

  it("the new password must differ from the current one", async () => {
    const u = await newUser();
    expect(await codeOf(changePassword({ userId: u.id, sessionId: await openSession(u.id) }, { currentPassword: OLD, newPassword: OLD }))).toBe("VALIDATION_FAILED");
    expect(await verifyPassword(await hashOf(u.id), OLD)).toBe(true);
  });

  it("a deactivated or unknown account cannot change anything", async () => {
    const u = await newUser();
    await owner.db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    expect(await codeOf(changePassword({ userId: u.id, sessionId: "s" }, { currentPassword: OLD, newPassword: NEW }))).toBe("AUTHENTICATION_REQUIRED");
    expect(await codeOf(changePassword({ userId: randomUUID(), sessionId: "s" }, { currentPassword: OLD, newPassword: NEW }))).toBe("AUTHENTICATION_REQUIRED");
  });
});

describe("changePassword -- sessions", () => {
  it("revokes every OTHER session of the account, keeps the current one, and leaves other accounts alone", async () => {
    const u = await newUser();
    const other = await newUser();
    const current = await openSession(u.id);
    const stolen = await openSession(u.id);
    const forgotten = await openSession(u.id);
    const unrelated = await openSession(other.id);

    const result = await changePassword({ userId: u.id, sessionId: current }, { currentPassword: OLD, newPassword: NEW });

    expect(result.otherSessionsRevoked).toBe(2);
    expect(await sessionIds(u.id)).toEqual([current]);
    expect(await sessionIds(u.id)).not.toContain(stolen);
    expect(await sessionIds(u.id)).not.toContain(forgotten);
    expect(await sessionIds(other.id)).toEqual([unrelated]);
  });

  it("a failed attempt revokes nothing", async () => {
    const u = await newUser();
    const a = await openSession(u.id), b = await openSession(u.id);
    await changePassword({ userId: u.id, sessionId: a }, { currentPassword: "wrong", newPassword: NEW }).catch(() => undefined);
    expect(await sessionIds(u.id)).toEqual([a, b].sort());
  });
});

describe("one-time passwords force a change before anything else (Decision SEC-008)", () => {
  it("a flagged account is refused by every tenant route, even with a valid membership, until it changes the password", async () => {
    const u = await newUser();
    await owner.db.insert(memberships).values({ userId: u.id, tenantId: tenant.tenantId, roleId: tenant.roleId, status: "ACTIVE" });
    await owner.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, u.id));
    const sid = await openSession(u.id, tenant.tenantId);
    session.current = { id: sid, userId: u.id, activeTenantId: tenant.tenantId };

    expect(await codeOf(requireTenantContext())).toBe("PASSWORD_CHANGE_REQUIRED");
    await changePassword({ userId: u.id, sessionId: sid }, { currentPassword: OLD, newPassword: NEW });
    expect((await requireTenantContext()).tenantId).toBe(tenant.tenantId);
  });

  it("an owner-invited staff member starts flagged; a self-registered owner does not; re-inviting an existing account does not flag it", async () => {
    const invitedEmail = `pw-invited-${randomUUID()}@example.test`;
    const invited = await inviteStaff(tenant.ctx, { email: invitedEmail, fullName: "Invited", roleId: tenant.roleId });
    const invitedRow = await owner.db.query.users.findFirst({ where: eq(users.email, invitedEmail) });
    createdUsers.push(invitedRow!.id);
    expect(invitedRow!.mustChangePassword).toBe(true);
    expect(JSON.stringify(invited)).toContain("emporaryPassword"); // the owner is shown it once...
    expect((await owner.db.query.users.findFirst({ where: eq(users.id, tenant.userId) }))!.mustChangePassword).toBe(false);

    // An account that already exists keeps its own password: inviting it must not flag it or touch its hash.
    const existing = await newUser();
    const hashBefore = await hashOf(existing.id);
    await inviteStaff(tenant.ctx, { email: existing.email, fullName: "Existing", roleId: tenant.roleId });
    const after = await owner.db.query.users.findFirst({ where: eq(users.id, existing.id) });
    expect(after!.mustChangePassword).toBe(false);
    expect(after!.passwordHash).toBe(hashBefore);
  });

  it("/api/auth/me still works for a flagged account (so the UI can send it to the change page) and reports no workspace permissions", async () => {
    const u = await newUser({ mustChange: true });
    await owner.db.insert(memberships).values({ userId: u.id, tenantId: tenant.tenantId, roleId: tenant.roleId, status: "ACTIVE" });
    session.current = { id: await openSession(u.id, tenant.tenantId), userId: u.id, activeTenantId: tenant.tenantId };
    const body = await (await meRoute()).json();
    expect(body.success).toBe(true);
    expect(body.data.user.mustChangePassword).toBe(true);
    expect(body.data.activeTenant).toBeNull(); // nothing is usable yet
  });

  it("a flagged operator gets PASSWORD_CHANGE_REQUIRED from the operator guard, then access once the password is changed", async () => {
    const op = await createOperatorAccount(owner.db, `pw-op-${randomUUID()}@example.test`, "Fresh Op", BY);
    createdUsers.push(op.userId);
    const sid = await openSession(op.userId);
    session.current = { id: sid, userId: op.userId, activeTenantId: null };

    expect(await evaluateOperatorAccess(op.userId)).toBe("MUST_CHANGE_PASSWORD");
    expect(await codeOf(requirePlatformOperator(new Headers()))).toBe("PASSWORD_CHANGE_REQUIRED");

    await changePassword({ userId: op.userId, sessionId: sid }, { currentPassword: op.temporaryPassword, newPassword: NEW });
    expect(await evaluateOperatorAccess(op.userId)).toBe("OK");
    expect((await requirePlatformOperator(new Headers())).userId).toBe(op.userId);
  });

  it("changing the password is not available to a signed-out caller at the route level (requireAuth)", async () => {
    session.current = null;
    const { POST } = await import("../app/api/auth/password/change/route");
    const res = await POST(new Request("http://localhost/api/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword: OLD, newPassword: NEW }) }) as never);
    expect(res.status).toBe(401);
  });
});

describe("operator password reset (out-of-band recovery)", () => {
  it("issues a new one-time password, forces a change, revokes ALL sessions and audits it", async () => {
    const op = await createOperatorAccount(owner.db, `pw-reset-${randomUUID()}@example.test`, "Reset Op", BY);
    createdUsers.push(op.userId);
    await owner.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, op.userId));
    const s1 = await openSession(op.userId), s2 = await openSession(op.userId);
    const oldHash = await hashOf(op.userId);

    const reset = await resetOperatorPassword(owner.db, op.email, BY);

    expect(reset.sessionsRevoked).toBe(2);
    expect(await sessionIds(op.userId)).toEqual([]);
    expect(await sessionIds(op.userId)).not.toContain(s1);
    expect(await sessionIds(op.userId)).not.toContain(s2);
    const row = await owner.db.query.users.findFirst({ where: eq(users.id, op.userId) });
    expect(row!.passwordHash).not.toBe(oldHash);
    expect(row!.mustChangePassword).toBe(true);
    expect(await verifyPassword(row!.passwordHash, reset.temporaryPassword)).toBe(true);
    const audit = await owner.db.select().from(auditEventsPlatform).where(and(eq(auditEventsPlatform.reason, BY), eq(auditEventsPlatform.action, "platform.operator_password_reset")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit)).not.toContain(reset.temporaryPassword);
  });

  it("refuses an account that is not an operator (the CLI is not a general password-reset tool)", async () => {
    await expect(resetOperatorPassword(owner.db, tenant.email, BY)).rejects.toThrow(/not a platform operator/);
  });
});

describe("platform audit is append-only for the web app's database role (Decision SEC-007)", () => {
  it("has INSERT and SELECT only: no UPDATE, DELETE or TRUNCATE (privilege level)", async () => {
    const [row] = await db.execute<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(sql`
      select has_table_privilege('erp_app','control.audit_events_platform','SELECT') as s,
             has_table_privilege('erp_app','control.audit_events_platform','INSERT') as i,
             has_table_privilege('erp_app','control.audit_events_platform','UPDATE') as u,
             has_table_privilege('erp_app','control.audit_events_platform','DELETE') as d,
             has_table_privilege('erp_app','control.audit_events_platform','TRUNCATE') as t`);
    expect(row).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });

  it("an attempt to rewrite or erase an audit row as the runtime role fails and the row survives intact", async () => {
    const u = await newUser();
    const [event] = await db.insert(auditEventsPlatform).values({ actorUserId: u.id, action: "test.append_only", reason: BY }).returning();
    await expect(db.update(auditEventsPlatform).set({ action: "tampered" }).where(eq(auditEventsPlatform.id, event!.id))).rejects.toThrow();
    await expect(db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.id, event!.id))).rejects.toThrow();
    await expect(db.execute(sql`truncate control.audit_events_platform`)).rejects.toThrow();
    const survivor = await owner.db.query.auditEventsPlatform.findFirst({ where: eq(auditEventsPlatform.id, event!.id) });
    expect(survivor).toMatchObject({ action: "test.append_only", reason: BY });
  });

  it("the web app can still WRITE and READ audit events (the audit trail keeps working)", async () => {
    const u = await newUser();
    const [event] = await db.insert(auditEventsPlatform).values({ actorUserId: u.id, action: "test.append_only_write", reason: BY }).returning();
    expect((await db.query.auditEventsPlatform.findFirst({ where: eq(auditEventsPlatform.id, event!.id) }))?.action).toBe("test.append_only_write");
  });
});
