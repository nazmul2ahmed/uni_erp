import { describe, expect, it } from "vitest";
import {
  emailSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  tenantSelectSchema,
} from "@erp/validation";
import { hashPassword, verifyPassword } from "../lib/password";
import { requireResourceOwnership } from "../lib/guard";

describe("Phase 1 auth validation", () => {
  it("accepts normalized registration and login input", () => {
    const registration = registerSchema.parse({
      email: "OWNER@EXAMPLE.COM",
      password: "correct horse battery",
      fullName: "Owner",
      businessName: "Example Business",
    });

    expect(registration.email).toBe("owner@example.com");
    expect(loginSchema.parse({ email: registration.email, password: registration.password })).toEqual({
      email: "owner@example.com",
      password: "correct horse battery",
    });
  });

  it("rejects short passwords and invalid tenant selections", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(tenantSelectSchema.safeParse({ tenantId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("Phase 1 password and authorization behavior", () => {
  it("hashes passwords and rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(hash).not.toContain("correct horse battery");
    await expect(verifyPassword(hash, "correct horse battery")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
  });

  it("allows only the active tenant to own a resource", async () => {
    const context = {
      requestId: "request-1",
      userId: "user-1",
      tenantId: "tenant-a",
      membershipId: "membership-1",
      roleId: "role-1",
      storageMode: "SHARED" as const,
    };

    await expect(
      requireResourceOwnership(context, async () => ({ tenantId: "tenant-a" })),
    ).resolves.toBeUndefined();
    await expect(
      requireResourceOwnership(context, async () => ({ tenantId: "tenant-b" })),
  ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", status: 404 });
  });
});