/** Shared caller-address logic (login throttle + platform allowlist). Decision SEC-009 / ADR-001. */
import { describe, expect, it } from "vitest";
import { clientIp, normalizeIp } from "../lib/client-ip";
import { clientIp as platformClientIp } from "../lib/platform-access";

const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

describe("clientIp", () => {
  it("is unknown unless a proxy is declared trusted -- whatever the header says", () => {
    expect(clientIp(h("5.5.5.5"), {})).toBeNull();
    expect(clientIp(h("5.5.5.5"), { TRUST_PROXY: "false" })).toBeNull();
  });
  it("honours the new names and the older PLATFORM_ADMIN_* names", () => {
    expect(clientIp(h("1.1.1.1, 5.5.5.5"), { TRUST_PROXY: "true" })).toBe("5.5.5.5");
    expect(clientIp(h("1.1.1.1, 5.5.5.5"), { PLATFORM_ADMIN_TRUST_PROXY: "true" })).toBe("5.5.5.5");
    expect(clientIp(h("1.1.1.1, 5.5.5.5, 9.9.9.9"), { TRUST_PROXY: "true", PROXY_HOPS: "2" })).toBe("5.5.5.5");
    expect(clientIp(h("1.1.1.1, 5.5.5.5, 9.9.9.9"), { PLATFORM_ADMIN_TRUST_PROXY: "true", PLATFORM_ADMIN_PROXY_HOPS: "2" })).toBe("5.5.5.5");
  });
  it("takes the proxy-appended (rightmost) entry, never the forgeable leftmost one", () => {
    expect(clientIp(h("10.0.0.1, 5.5.5.5"), { TRUST_PROXY: "true" })).toBe("5.5.5.5");
  });
  it("is null for a missing header, a non-IP value, or too few entries", () => {
    expect(clientIp(h(), { TRUST_PROXY: "true" })).toBeNull();
    expect(clientIp(h("not-an-ip"), { TRUST_PROXY: "true" })).toBeNull();
    expect(clientIp(h("5.5.5.5"), { TRUST_PROXY: "true", PROXY_HOPS: "3" })).toBeNull();
  });
  it("normalises IPv4-mapped IPv6 so one client cannot appear as two addresses", () => {
    expect(normalizeIp("::ffff:5.5.5.5")).toBe("5.5.5.5");
    expect(clientIp(h("::ffff:5.5.5.5"), { TRUST_PROXY: "true" })).toBe("5.5.5.5");
  });
  it("the platform allowlist uses the SAME function (no parallel implementation)", () => {
    expect(platformClientIp).toBe(clientIp);
  });
});
