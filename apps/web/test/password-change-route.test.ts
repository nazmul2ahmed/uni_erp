/** POST /api/auth/password/change -- route unit test (guard and use case mocked). Decision SEC-008. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), changePassword: vi.fn() }));
vi.mock("@/lib/guard", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/use-cases/password", () => ({ changePassword: mocks.changePassword }));
vi.mock("@/lib/api-response", () => ({ apiHandler: (fn: () => Promise<unknown>) => async () => fn() }));

import { POST } from "../app/api/auth/password/change/route";

const call = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/auth/password/change", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "u1", sessionId: "s1", activeTenantId: null });
  mocks.changePassword.mockResolvedValue({ changed: true, otherSessionsRevoked: 0 });
});

describe("POST /api/auth/password/change", () => {
  it("authenticates, then forwards ONLY the caller's own user and session ids with the parsed passwords", async () => {
    await call({ currentPassword: "current-pass", newPassword: "a long enough new password", userId: "someone-else", sessionId: "other" }, { "x-request-id": "req-9" });
    expect(mocks.changePassword).toHaveBeenCalledWith({ userId: "u1", sessionId: "s1" }, { currentPassword: "current-pass", newPassword: "a long enough new password" }, "req-9");
  });

  it("does nothing for a signed-out caller", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error("AUTHENTICATION_REQUIRED"));
    await expect(call({ currentPassword: "x", newPassword: "a long enough new password" })).rejects.toThrow("AUTHENTICATION_REQUIRED");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", null],
    ["missing current", { newPassword: "a long enough new password" }],
    ["empty current", { currentPassword: "", newPassword: "a long enough new password" }],
    ["new password shorter than 10", { currentPassword: "x", newPassword: "short" }],
    ["new password exactly 9", { currentPassword: "x", newPassword: "123456789" }],
    ["new password longer than 128", { currentPassword: "x", newPassword: "x".repeat(129) }],
    ["wrong types", { currentPassword: 123, newPassword: ["a long enough new password"] }],
  ])("rejects %s before touching the use case", async (_name, body) => {
    await expect(call(body)).rejects.toThrow("Invalid password change");
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it("accepts the boundaries: exactly 10 and exactly 128 characters", async () => {
    await call({ currentPassword: "x", newPassword: "1234567890" });
    await call({ currentPassword: "x", newPassword: "y".repeat(128) });
    expect(mocks.changePassword).toHaveBeenCalledTimes(2);
  });
});
