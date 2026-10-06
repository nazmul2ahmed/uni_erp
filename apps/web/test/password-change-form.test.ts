/** Client-side mirror of the password rules (fast feedback only; the server is authoritative). */
import { describe, expect, it } from "vitest";
import { validatePasswordChange } from "../components/account/password-change-form";

describe("validatePasswordChange", () => {
  const ok = ["current-secret", "a brand new password", "a brand new password"] as const;
  it("passes a valid change", () => expect(validatePasswordChange(...ok)).toBeNull());
  it.each([
    ["no current password", ["", "a brand new password", "a brand new password"], "current"],
    ["too short", ["current-secret", "short", "short"], "at least 10"],
    ["too long", ["current-secret", "x".repeat(129), "x".repeat(129)], "at most 128"],
    ["same as current", ["same-password-1", "same-password-1", "same-password-1"], "different"],
    ["confirmation mismatch", ["current-secret", "a brand new password", "a brand new passwore"], "do not match"],
  ])("rejects %s", (_n, args, hint) => expect(validatePasswordChange(...(args as [string, string, string]))?.toLowerCase()).toContain(hint));
  it("accepts exactly 10 and exactly 128 characters", () => {
    expect(validatePasswordChange("c", "1234567890", "1234567890")).toBeNull();
    expect(validatePasswordChange("c", "y".repeat(128), "y".repeat(128))).toBeNull();
  });
});
