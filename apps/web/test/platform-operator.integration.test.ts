/**
 * Platform operator surface -- real-PostgreSQL adversarial test.
 * ADR-001 section 7; Decisions PLT-001 (identity), PLT-002 (contract), PLT-003 (gating).
 *
 * The session is the ONLY thing mocked (cookies need a request); the database,
 * the guard, the triggers and the privileges are real. Tests run as the runtime
 * role `erp_app`; the owner role is used only to do what the runtime role must not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  auditEventsPlatform, createOwnerDb, db, memberships, platformOperators, roles, rolePermissions, tenants, users, withPlatformTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";

const session = vi.hoisted(() => ({ current: null as null | { id: string; userId: string; activeTenantId: string | null } }));
// Only the COOKIE is faked: the session row is created on demand and validated by the real loadSessionById
// (so is_active and must_change_password are genuinely enforced -- Decision SEC-010).
vi.mock("../lib/session", async (original) => {
  const real = await original<typeof import("../lib/session")>();
  return {
    ...real,
    loadSession: async () => {
      const c = session.current;
      if (!c) return null;
      const { db, sessions } = await import("@erp/db");
      await db.insert(sessions).values({ id: c.id, userId: c.userId, activeTenantId: c.activeTenantId, expiresAt: new Date(Date.now() + 3_600_000) }).onConflictDoNothing();
      return real.loadSessionById(c.id);
    },
  };
});

import { resolvePermissions, resolveRoleKey, requireTenantContext, type TenantContext } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { inviteStaff } from "../lib/use-cases/staff";
import { evaluateOperatorAccess, requirePlatformOperator } from "../lib/platform-guard";
import { recordOperatorSignIn } from "../lib/platform-operator";
import { createOperatorAccount, grantOperator, listOperators, revokeOperator } from "../lib/platform-operator-admin";
import { getPlatformOverview } from "../lib/use-cases/platform-overview";
import { GET as overviewRoute } from "../app/api/platform/v1/overview/route";
import { GET as identityRoute } from "../app/api/platform/v1/identity/route";

const owner = createOwnerDb();
const BY = `test:${randomUUID().slice(0, 8)}`;
const reqWith = (xff?: string) => new Request("http://localhost/api/platform/v1/overview", { headers: xff ? { "x-forwarded-for": xff } : {} }) as never;
const signedInAs = (userId: string | null) => { session.current = userId ? { id: randomUUID(), userId, activeTenantId: null } : null; };

let tenantA: { tenantId: string; userId: string; membershipId: string; email: string; roleId: string; ctx: TenantContext };
let operator: { userId: string; email: string };
const createdUsers: string[] = [];
const createdTenants: string[] = [];

async function provisionTenant(label: string) {
  // Production registration lowercases emails (emailSchema); mirror that so the CLI's normalised lookup matches.
  const email = `plt-${label}-${randomUUID()}@example.test`.toLowerCase();
  const reg = await registerOwnerAndTenant({ email, password: "correct horse battery staple", fullName: `Plt ${label}`, businessName: `Plt Test ${label}` });
  const m = await db.query.memberships.findFirst({ where: eq(memberships.id, reg.membershipId) });
  createdUsers.push(reg.userId); createdTenants.push(reg.tenantId);
  const ctx: TenantContext = { requestId: randomUUID(), userId: reg.userId, tenantId: reg.tenantId, membershipId: reg.membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
  return { ...reg, email, roleId: m!.roleId, ctx };
}

const operatorStatus = async (userId: string) => (await owner.db.query.platformOperators.findFirst({ where: eq(platformOperators.userId, userId) }))?.status;

beforeAll(async () => {
  tenantA = await provisionTenant("A");
  const created = await createOperatorAccount(owner.db, `plt-op-${randomUUID()}@example.test`, "Test Operator", BY);
  operator = { userId: created.userId, email: created.email };
  createdUsers.push(operator.userId);
  // The CLI issues a one-time password (Decision SEC-008); these tests exercise an operator who has already
  // changed it. The forced-change behaviour itself is covered in password-change.integration.test.ts.
  await owner.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, operator.userId));
}, 60_000);

beforeEach(() => {
  process.env.PLATFORM_ADMIN_ENABLED = "true";
  delete process.env.PLATFORM_ADMIN_ALLOWED_CIDRS;
  delete process.env.PLATFORM_ADMIN_TRUST_PROXY;
  delete process.env.PLATFORM_ADMIN_PROXY_HOPS;
  signedInAs(null);
});

afterAll(async () => {
  delete process.env.PLATFORM_ADMIN_ENABLED;
  // Owner role removes operator rows (the runtime role cannot), then the usual tenant teardown.
  for (const id of createdUsers) await owner.db.delete(platformOperators).where(eq(platformOperators.userId, id)).catch(() => undefined);
  for (const id of createdUsers) await owner.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.actorUserId, id)).catch(() => undefined);
  await owner.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.reason, BY)).catch(() => undefined);
  for (const t of createdTenants) {
    await owner.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.tenantId, t)).catch(() => undefined);
    await db.delete(memberships).where(eq(memberships.tenantId, t)).catch(() => undefined);
    for (const r of await db.query.roles.findMany({ where: eq(roles.tenantId, t) })) await db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
    await db.delete(roles).where(eq(roles.tenantId, t)).catch(() => undefined);
    await db.delete(tenants).where(eq(tenants.id, t)).catch(() => undefined);
  }
  for (const id of createdUsers) await db.delete(users).where(eq(users.id, id)).catch(() => undefined);
  await owner.close();
});

describe("1. the web app's database role cannot mint, change or remove an operator", () => {
  it("has SELECT but no INSERT / UPDATE / DELETE / TRUNCATE on control.platform_operators (privilege level)", async () => {
    const [row] = await db.execute<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(sql`
      select has_table_privilege('erp_app','control.platform_operators','SELECT') as s,
             has_table_privilege('erp_app','control.platform_operators','INSERT') as i,
             has_table_privilege('erp_app','control.platform_operators','UPDATE') as u,
             has_table_privilege('erp_app','control.platform_operators','DELETE') as d,
             has_table_privilege('erp_app','control.platform_operators','TRUNCATE') as t`);
    expect(row).toEqual({ s: true, i: false, u: false, d: false, t: false });
  });

  it("an INSERT that elevates a real, membership-free account is refused when issued as the runtime role", async () => {
    const victim = await owner.db.insert(users).values({ email: `plt-victim-${randomUUID()}@example.test`, passwordHash: "x", fullName: "Victim" }).returning();
    createdUsers.push(victim[0]!.id);
    await expect(db.insert(platformOperators).values({ userId: victim[0]!.id, grantedBy: "attacker" })).rejects.toThrow();
    expect(await operatorStatus(victim[0]!.id)).toBeUndefined();
  });

  it("an UPDATE that re-activates a revoked operator is refused, and so is a DELETE", async () => {
    await revokeOperator(owner.db, operator.email, BY);
    await expect(db.update(platformOperators).set({ status: "ACTIVE" }).where(eq(platformOperators.userId, operator.userId))).rejects.toThrow();
    await expect(db.delete(platformOperators).where(eq(platformOperators.userId, operator.userId))).rejects.toThrow();
    expect(await operatorStatus(operator.userId)).toBe("REVOKED");
    await grantOperator(owner.db, operator.email, BY); // restore for the following tests
  });
});

describe("2. an operator can never be a tenant member (DB triggers + app checks)", () => {
  it("the grant refuses an account that is an active workspace member", async () => {
    await expect(grantOperator(owner.db, tenantA.email, BY)).rejects.toThrow(/member of a workspace/);
    expect(await operatorStatus(tenantA.userId)).toBeUndefined();
  });

  it("even a raw owner-level INSERT cannot make a workspace member an operator (trigger)", async () => {
    await expect(owner.db.insert(platformOperators).values({ userId: tenantA.userId, grantedBy: "raw" })).rejects.toThrow(/active tenant membership/);
  });

  it("even a raw owner-level INSERT cannot add an ACTIVE membership to an ACTIVE operator (trigger)", async () => {
    await expect(owner.db.insert(memberships).values({ userId: operator.userId, tenantId: tenantA.tenantId, roleId: tenantA.roleId, status: "ACTIVE" })).rejects.toThrow(/platform operators cannot hold/);
    expect(await db.query.memberships.findFirst({ where: eq(memberships.userId, operator.userId) })).toBeUndefined();
  });

  it("a tenant owner cannot invite an operator into a workspace, and the refusal does not reveal that the account is an operator", async () => {
    const error = await inviteStaff(tenantA.ctx, { email: operator.email, fullName: "Op", roleId: tenantA.roleId }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(String(error.message).toLowerCase()).not.toContain("operator");
    expect(await db.query.memberships.findFirst({ where: eq(memberships.userId, operator.userId) })).toBeUndefined();
  });

  it("a REVOKED operator may become a member again, and then cannot be re-granted while a member", async () => {
    const acct = await createOperatorAccount(owner.db, `plt-ex-${randomUUID()}@example.test`, "Ex Operator", BY);
    createdUsers.push(acct.userId);
    await revokeOperator(owner.db, acct.email, BY);
    await owner.db.insert(memberships).values({ userId: acct.userId, tenantId: tenantA.tenantId, roleId: tenantA.roleId, status: "ACTIVE" });
    await expect(grantOperator(owner.db, acct.email, BY)).rejects.toThrow(/member of a workspace/);
    await expect(owner.db.update(platformOperators).set({ status: "ACTIVE", revokedAt: null }).where(eq(platformOperators.userId, acct.userId))).rejects.toThrow(/active tenant membership/);
  });

  it("an operator session grants nothing in tenant routes: requireTenantContext refuses it", async () => {
    session.current = { id: randomUUID(), userId: operator.userId, activeTenantId: tenantA.tenantId };
    const error = await requireTenantContext().catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("TENANT_ACCESS_DENIED");
  });
});

describe("3. evaluateOperatorAccess (read on every request)", () => {
  it("OK for an active, membership-free operator", async () => expect(await evaluateOperatorAccess(operator.userId)).toBe("OK"));
  it("NOT_OPERATOR for a tenant owner and for an unknown user", async () => {
    expect(await evaluateOperatorAccess(tenantA.userId)).toBe("NOT_OPERATOR");
    expect(await evaluateOperatorAccess(randomUUID())).toBe("NOT_OPERATOR");
  });
  it("INACTIVE_ACCOUNT once the account is deactivated", async () => {
    await owner.db.update(users).set({ isActive: false }).where(eq(users.id, operator.userId));
    try { expect(await evaluateOperatorAccess(operator.userId)).toBe("INACTIVE_ACCOUNT"); }
    finally { await owner.db.update(users).set({ isActive: true }).where(eq(users.id, operator.userId)); }
  });
  it("HAS_MEMBERSHIP is also caught by the guard itself if the trigger were ever bypassed (defence in depth)", async () => {
    await owner.db.execute(sql`alter table control.memberships disable trigger memberships_reject_operator`);
    let membershipId: string | undefined;
    try {
      const [m] = await owner.db.insert(memberships).values({ userId: operator.userId, tenantId: tenantA.tenantId, roleId: tenantA.roleId, status: "ACTIVE" }).returning();
      membershipId = m!.id;
      expect(await evaluateOperatorAccess(operator.userId)).toBe("HAS_MEMBERSHIP");
    } finally {
      if (membershipId) await owner.db.delete(memberships).where(eq(memberships.id, membershipId));
      await owner.db.execute(sql`alter table control.memberships enable trigger memberships_reject_operator`);
    }
    expect(await evaluateOperatorAccess(operator.userId)).toBe("OK");
  });
});

describe("4. requirePlatformOperator", () => {
  const call = (xff?: string) => requirePlatformOperator(new Headers(xff ? { "x-forwarded-for": xff } : {}));
  const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as AppError | null)?.code ?? null;

  it("flag off -> 404, even for a valid operator", async () => {
    process.env.PLATFORM_ADMIN_ENABLED = "false";
    signedInAs(operator.userId);
    expect(await code(call())).toBe("RESOURCE_NOT_FOUND");
  });
  it("signed out -> 401", async () => expect(await code(call())).toBe("AUTHENTICATION_REQUIRED"));
  it("a tenant OWNER -> 403", async () => { signedInAs(tenantA.userId); expect(await code(call())).toBe("PERMISSION_DENIED"); });
  it("an active operator -> allowed", async () => { signedInAs(operator.userId); expect((await call()).userId).toBe(operator.userId); });

  it("revocation is effective on the VERY NEXT request of a still-live session", async () => {
    signedInAs(operator.userId);
    expect((await call()).userId).toBe(operator.userId);
    await revokeOperator(owner.db, operator.email, BY);
    try { expect(await code(call())).toBe("PERMISSION_DENIED"); }
    finally { await grantOperator(owner.db, operator.email, BY); }
    expect((await call()).userId).toBe(operator.userId);
  });

  it("IP gating: outside the allowlist -> 404 (surface hidden); inside -> allowed; spoofed leftmost entry is ignored", async () => {
    process.env.PLATFORM_ADMIN_ALLOWED_CIDRS = "10.0.0.0/8";
    process.env.PLATFORM_ADMIN_TRUST_PROXY = "true";
    signedInAs(operator.userId);
    expect((await call("10.1.2.3")).userId).toBe(operator.userId);
    expect(await code(call("8.8.8.8"))).toBe("RESOURCE_NOT_FOUND");
    expect(await code(call())).toBe("RESOURCE_NOT_FOUND"); // no forwarded header => unknown address => denied
    expect(await code(call("10.1.2.3, 8.8.8.8"))).toBe("RESOURCE_NOT_FOUND"); // client forged 10.x, the proxy saw 8.8.8.8
  });
  it("an allowlist is enforced before authentication: an outsider cannot even learn that sign-in is needed", async () => {
    process.env.PLATFORM_ADMIN_ALLOWED_CIDRS = "10.0.0.0/8";
    process.env.PLATFORM_ADMIN_TRUST_PROXY = "true";
    signedInAs(null);
    expect(await code(call("8.8.8.8"))).toBe("RESOURCE_NOT_FOUND");
  });
});

describe("5. the v1 routes (real guard)", () => {
  it("signed out 401 / tenant owner 403 / flag off 404 / operator 200", async () => {
    expect((await overviewRoute(reqWith())).status).toBe(401);
    signedInAs(tenantA.userId);
    expect((await overviewRoute(reqWith())).status).toBe(403);
    expect((await identityRoute(reqWith())).status).toBe(403);
    process.env.PLATFORM_ADMIN_ENABLED = "false";
    signedInAs(operator.userId);
    expect((await overviewRoute(reqWith())).status).toBe(404);
    process.env.PLATFORM_ADMIN_ENABLED = "true";
    expect((await overviewRoute(reqWith())).status).toBe(200);
    expect((await identityRoute(reqWith())).status).toBe(200);
  });

  it("speaks Platform Integration Contract v1: versioned envelope, app identity, capability list", async () => {
    signedInAs(operator.userId);
    const identity = (await (await identityRoute(reqWith())).json()).data;
    expect(identity).toMatchObject({ contractVersion: "platform.v1", app: { id: "uni_erp" } });
    expect(identity.data.capabilities).toEqual(expect.arrayContaining(["tenants.summary", "features.adoption", "users.count"]));
    const overview = (await (await overviewRoute(reqWith())).json()).data;
    expect(Object.keys(overview).sort()).toEqual(["app", "contractVersion", "data", "generatedAt"]);
    expect(Object.keys(overview.data).sort()).toEqual(["featureAdoption", "tenants", "users"]);
  });
});

describe("6. the overview exposes control-plane aggregates only", () => {
  it("counts are consistent: total equals the sum of statuses and of storage modes", async () => {
    const o = await getPlatformOverview();
    expect(o.tenants.total).toBe(Object.values(o.tenants.byStatus).reduce((a, b) => a + b, 0));
    expect(o.tenants.total).toBe(Object.values(o.tenants.byStorageMode).reduce((a, b) => a + b, 0));
    expect(o.tenants.total).toBeGreaterThanOrEqual(1);
    expect(Object.keys(o.tenants.byStatus).sort()).toEqual(["ACTIVE", "ARCHIVED", "GRACE", "PROSPECT", "PROVISIONING", "SUSPENDED"]);
    expect(o.tenants.recent.length).toBeLessThanOrEqual(10);
  });

  it("includes a newly created workspace and the active-user count moves with real accounts", async () => {
    const before = (await getPlatformOverview()).users.active;
    const t = await provisionTenant("Counted");
    const after = await getPlatformOverview();
    expect(after.users.active).toBe(before + 1);
    expect(after.tenants.recent.map((r) => r.id)).toContain(t.tenantId);
  });

  it("response allowlist: no emails, no owner pointer, no password hashes, no tenant business fields", async () => {
    signedInAs(operator.userId);
    const text = JSON.stringify(await (await overviewRoute(reqWith())).json());
    for (const forbidden of [tenantA.email, operator.email, "@example.test", "ownerMembershipId", "passwordHash", "password_hash", "grandTotal", "journal"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(Object.keys((await getPlatformOverview()).tenants.recent[0]!).sort()).toEqual(["createdAt", "id", "name", "status", "storageMode"]);
  });

  it("source guard: the overview module reads only control-plane tables", () => {
    const source = readFileSync(join(__dirname, "..", "lib", "use-cases", "platform-overview.ts"), "utf8");
    const imported = /import \{([^}]+)\} from "@erp\/db"/.exec(source)![1]!.split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(imported).toEqual(["tenantFeatures", "tenants", "users", "withPlatformTransaction"]);
  });

  it("source guard: EVERY route under /api/platform calls requirePlatformOperator (a future route cannot forget the guard)", () => {
    const root = join(__dirname, "..", "app", "api", "platform");
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((name) => { const full = join(dir, name); statSync(full).isDirectory() ? walk(full) : name === "route.ts" && files.push(full); });
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) expect(readFileSync(file, "utf8"), file).toContain("requirePlatformOperator(");
  });
});

describe("7. auditing", () => {
  it("operator sign-in is audited; a tenant user's sign-in writes nothing", async () => {
    const countFor = async (userId: string, action: string) =>
      (await db.select().from(auditEventsPlatform).where(and(eq(auditEventsPlatform.actorUserId, userId), eq(auditEventsPlatform.action, action)))).length;
    await recordOperatorSignIn(operator.userId, "req-1");
    await recordOperatorSignIn(tenantA.userId, "req-2");
    expect(await countFor(operator.userId, "platform.operator_signed_in")).toBe(1);
    expect(await countFor(tenantA.userId, "platform.operator_signed_in")).toBe(0);
  });

  it("a REVOKED operator's sign-in is not recorded as an operator sign-in", async () => {
    const acct = await createOperatorAccount(owner.db, `plt-rev-${randomUUID()}@example.test`, "Rev Op", BY);
    createdUsers.push(acct.userId);
    await revokeOperator(owner.db, acct.email, BY);
    await recordOperatorSignIn(acct.userId);
    expect((await db.select().from(auditEventsPlatform).where(and(eq(auditEventsPlatform.actorUserId, acct.userId), eq(auditEventsPlatform.action, "platform.operator_signed_in")))).length).toBe(0);
  });

  it("grant, create and revoke are audited with who ran them", async () => {
    const rows = await db.select().from(auditEventsPlatform).where(eq(auditEventsPlatform.reason, BY));
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["platform.operator_account_created", "platform.operator_granted", "platform.operator_revoked"]) expect(actions.has(a), a).toBe(true);
    expect(rows.every((r) => r.actorUserId === null)).toBe(true); // out-of-band: the reason names the operator of the CLI
  });

  it("audit rows never contain a password or hash", async () => {
    const rows = await db.select().from(auditEventsPlatform).where(eq(auditEventsPlatform.reason, BY));
    expect(JSON.stringify(rows)).not.toMatch(/argon2|temporaryPassword|passwordHash/i);
  });
});

describe("8. operator administration", () => {
  it("create makes a membership-free account, returns the password once, and the password verifies", async () => {
    const email = `plt-new-${randomUUID()}@example.test`;
    const created = await createOperatorAccount(owner.db, email, "Fresh Op", BY);
    createdUsers.push(created.userId);
    expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(20);
    const { verifyPassword } = await import("../lib/password");
    const row = await owner.db.query.users.findFirst({ where: eq(users.id, created.userId) });
    expect(await verifyPassword(row!.passwordHash, created.temporaryPassword)).toBe(true);
    expect(await owner.db.query.memberships.findFirst({ where: eq(memberships.userId, created.userId) })).toBeUndefined();
    // A brand-new operator holds only a one-time password: usable for nothing but changing it (Decision SEC-008).
    expect(row!.mustChangePassword).toBe(true);
    expect(await evaluateOperatorAccess(created.userId)).toBe("MUST_CHANGE_PASSWORD");
  });

  it("create refuses an email that already exists, and normalises case/whitespace like login does", async () => {
    await expect(createOperatorAccount(owner.db, `  ${operator.email.toUpperCase()}  `, "Dup", BY)).rejects.toThrow(/already exists/);
    await expect(createOperatorAccount(owner.db, "not-an-email", "Bad", BY)).rejects.toThrow(/Invalid email/);
  });

  it("grant is idempotent and revoke is idempotent; revoking a non-operator fails", async () => {
    expect((await grantOperator(owner.db, operator.email, BY)).alreadyActive).toBe(true);
    const acct = await createOperatorAccount(owner.db, `plt-idem-${randomUUID()}@example.test`, "Idem", BY);
    createdUsers.push(acct.userId);
    expect((await revokeOperator(owner.db, acct.email, BY)).alreadyRevoked).toBe(false);
    expect((await revokeOperator(owner.db, acct.email, BY)).alreadyRevoked).toBe(true);
    await expect(revokeOperator(owner.db, tenantA.email, BY)).rejects.toThrow(/not a platform operator/);
  });

  it("list shows operators without secrets", async () => {
    const rows = await listOperators(owner.db);
    expect(rows.find((r) => r.email === operator.email)).toMatchObject({ status: "ACTIVE", fullName: "Test Operator" });
    expect(Object.keys(rows[0]!).sort()).toEqual(["email", "fullName", "grantedAt", "grantedBy", "revokedAt", "status"]);
  });
});
