import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      memberships: { findFirst: vi.fn(), findMany: vi.fn() },
      businessProfiles: { findFirst: vi.fn() },
    },
    select: vi.fn(),
    update: vi.fn(),
  },
  createSession: vi.fn(),
  setActiveTenant: vi.fn(),
  destroySession: vi.fn(),
  requireAuth: vi.fn(),
  requireTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  registerOwnerAndTenant: vi.fn(),
  verifyPassword: vi.fn(),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@erp/db", () => ({
  db: mocks.db,
  users: {},
  memberships: {},
  tenants: {},
  roles: {},
  businessProfiles: {},
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock("@/lib/api-response", () => ({ apiHandler: (fn: () => unknown) => fn }));
vi.mock("@/lib/session", () => ({
  createSession: mocks.createSession,
  setActiveTenant: mocks.setActiveTenant,
  destroySession: mocks.destroySession,
}));
vi.mock("@/lib/guard", () => ({
  requireAuth: mocks.requireAuth,
  requireTenantContext: mocks.requireTenantContext,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/lib/tenant-onboarding", () => ({
  registerOwnerAndTenant: mocks.registerOwnerAndTenant,
}));
vi.mock("@/lib/password", () => ({ verifyPassword: mocks.verifyPassword }));

import { POST as register } from "../app/api/auth/register/route";
import { POST as login } from "../app/api/auth/login/route";
import { POST as logout } from "../app/api/auth/logout/route";
import { GET as me } from "../app/api/auth/me/route";
import { POST as selectTenant } from "../app/api/auth/tenant/select/route";
import { GET as getProfile, PATCH as patchProfile } from "../app/api/tenant/profile/route";

import type { NextRequest } from "next/server";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const context = {
  requestId: "request-1",
  userId: "user-1",
  tenantId: "tenant-a",
  membershipId: "membership-1",
  roleId: "owner-role",
  storageMode: "SHARED" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSession.mockResolvedValue("session-1");
  mocks.setActiveTenant.mockResolvedValue(undefined);
  mocks.requireAuth.mockResolvedValue({ userId: "user-1", sessionId: "session-1", activeTenantId: null });
  mocks.requireTenantContext.mockResolvedValue(context);
  mocks.requirePermission.mockResolvedValue(undefined);
  mocks.withTenantTransaction.mockImplementation(
    (_tenantId: string, callback: (db: typeof mocks.db) => unknown) => callback(mocks.db)
  );
});

describe("Phase 1 authentication routes", () => {
  it("registers an owner tenant and activates its session", async () => {
    mocks.registerOwnerAndTenant.mockResolvedValue({
      userId: "user-1",
      tenantId: "tenant-a",
      membershipId: "membership-1",
    });

    await register(request({
      email: "owner@example.com",
      password: "correct horse battery",
      fullName: "Owner",
      businessName: "Example",
    }));

    expect(mocks.registerOwnerAndTenant).toHaveBeenCalledOnce();
    expect(mocks.createSession).toHaveBeenCalledWith("user-1");
    expect(mocks.setActiveTenant).toHaveBeenCalledWith("session-1", "tenant-a");
  });

  it("logs in with a valid password and auto-selects one membership", async () => {
    mocks.db.query.users.findFirst.mockResolvedValue({
      id: "user-1",
      email: "owner@example.com",
      fullName: "Owner",
      passwordHash: "argon-hash",
      isActive: true,
    });
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.db.query.memberships.findMany.mockResolvedValue([{ tenantId: "tenant-a" }]);

    await login(request({ email: "owner@example.com", password: "correct horse battery" }));

    expect(mocks.verifyPassword).toHaveBeenCalledWith("argon-hash", "correct horse battery");
    expect(mocks.setActiveTenant).toHaveBeenCalledWith("session-1", "tenant-a");
  });

  it("logs out by destroying the current session", async () => {
    await logout();

    expect(mocks.destroySession).toHaveBeenCalledOnce();
  });
});

describe("Phase 1 tenant and RBAC routes", () => {
  it("returns the authenticated user and memberships from /me", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "user-1", sessionId: "session-1", activeTenantId: "tenant-a" });
    mocks.db.query.users.findFirst.mockResolvedValue({ id: "user-1", email: "owner@example.com", fullName: "Owner" });
    const chain = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn() };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockResolvedValue([{ tenantId: "tenant-a", tenantName: "Example", roleKey: "OWNER", status: "ACTIVE" }]);
    mocks.db.select.mockReturnValue(chain);

    const result = await me();

    expect(result).toMatchObject({ user: { id: "user-1" }, activeTenantId: "tenant-a" });
  });

  it("selects a tenant only after active membership verification", async () => {
    mocks.db.query.memberships.findFirst.mockResolvedValue({ id: "membership-1" });

    await selectTenant(request({ tenantId: "11111111-1111-4111-8111-111111111111" }));

    expect(mocks.db.query.memberships.findFirst).toHaveBeenCalledOnce();
    expect(mocks.setActiveTenant).toHaveBeenCalledWith("session-1", "11111111-1111-4111-8111-111111111111");
  });

  it("enforces RBAC before profile access and mutation", async () => {
    mocks.db.query.businessProfiles.findFirst.mockResolvedValue({ tenantId: "tenant-a", name: "Example" });
    await getProfile();
    expect(mocks.requirePermission).toHaveBeenCalledWith(context, "settings.view");

    const updateChain = { set: vi.fn(), where: vi.fn(), returning: vi.fn() };
    updateChain.set.mockReturnValue(updateChain);
    updateChain.where.mockReturnValue(updateChain);
    updateChain.returning.mockResolvedValue([{ tenantId: "tenant-a", name: "Updated" }]);
    mocks.db.update.mockReturnValue(updateChain);
    await patchProfile(request({ name: "Updated" }));
    expect(mocks.requirePermission).toHaveBeenCalledWith(context, "settings.manage");
  });
});