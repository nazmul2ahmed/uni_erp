/**
 * Platform-surface network checks -- unit tests (no DB). ADR-001, PLT-003.
 * Every case that could be mistaken for "allowed" must be a DENY (fail closed).
 */
import { describe, expect, it } from "vitest";
import { clientIp, ipInCidr, isIpAllowed, parseCidrs, platformAdminEnabled } from "../lib/platform-access";

const headers = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

describe("platformAdminEnabled", () => {
  it("is on only for the exact string 'true'", () => {
    expect(platformAdminEnabled({ PLATFORM_ADMIN_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) expect(platformAdminEnabled({ PLATFORM_ADMIN_ENABLED: v })).toBe(false);
  });
});

describe("ipInCidr", () => {
  it.each([
    ["10.1.2.3", "10.0.0.0/8", true],
    ["10.255.255.255", "10.0.0.0/8", true],
    ["11.0.0.1", "10.0.0.0/8", false],
    ["192.168.1.77", "192.168.1.0/24", true],
    ["192.168.2.77", "192.168.1.0/24", false],
    ["203.0.113.9", "203.0.113.9", true],
    ["203.0.113.10", "203.0.113.9", false],
    ["203.0.113.9", "203.0.113.9/32", true],
    ["8.8.8.8", "0.0.0.0/0", true],
    ["::ffff:10.1.2.3", "10.0.0.0/8", true], // IPv4-mapped IPv6
    ["2001:db8::1", "2001:db8::1", true], // bare IPv6 = exact match only
    ["2001:db8::2", "2001:db8::1", false],
  ])("%s in %s -> %s", (ip, cidr, expected) => expect(ipInCidr(ip, cidr)).toBe(expected));

  it.each([
    ["not-an-ip", "10.0.0.0/8"],
    ["10.1.2.3", "garbage"],
    ["10.1.2.3", "10.0.0.0/33"],
    ["10.1.2.3", "10.0.0.0/-1"],
    ["10.1.2.3", "10.0.0.0/"],
    ["10.1.2.3", "300.0.0.0/8"],
    ["10.1.2.3", ""],
    ["2001:db8::1", "2001:db8::/32"], // IPv6 ranges are unsupported => never match (fail closed)
    ["", "10.0.0.0/8"],
  ])("never matches invalid input (%j vs %j)", (ip, cidr) => expect(ipInCidr(ip, cidr)).toBe(false));
});

describe("clientIp -- only trusts the proxy's own hop", () => {
  it("is unknown (null) unless a trusted proxy is declared, whatever the header says", () => {
    expect(clientIp(headers("10.1.2.3"), {})).toBeNull();
    expect(clientIp(headers("10.1.2.3"), { PLATFORM_ADMIN_TRUST_PROXY: "false" })).toBeNull();
  });
  const trusted = { PLATFORM_ADMIN_TRUST_PROXY: "true" };
  it("takes the entry appended by our proxy (rightmost), not the client-forgeable first entry", () => {
    expect(clientIp(headers("10.1.2.3, 8.8.8.8"), trusted)).toBe("8.8.8.8");
  });
  it("honours PROXY_HOPS for a longer trusted chain", () => {
    expect(clientIp(headers("1.1.1.1, 10.1.2.3, 172.16.0.1"), { ...trusted, PLATFORM_ADMIN_PROXY_HOPS: "2" })).toBe("10.1.2.3");
  });
  it("is null when the header is missing, empty, too short for the hops, or not an IP", () => {
    expect(clientIp(headers(), trusted)).toBeNull();
    expect(clientIp(headers(" , "), trusted)).toBeNull();
    expect(clientIp(headers("10.1.2.3"), { ...trusted, PLATFORM_ADMIN_PROXY_HOPS: "3" })).toBeNull();
    expect(clientIp(headers("not-an-ip"), trusted)).toBeNull();
  });
  it("treats a nonsense hop count as 1", () => {
    expect(clientIp(headers("1.1.1.1, 2.2.2.2"), { ...trusted, PLATFORM_ADMIN_PROXY_HOPS: "abc" })).toBe("2.2.2.2");
    expect(clientIp(headers("1.1.1.1, 2.2.2.2"), { ...trusted, PLATFORM_ADMIN_PROXY_HOPS: "0" })).toBe("2.2.2.2");
  });
});

describe("isIpAllowed", () => {
  it("with no allowlist: open in development, DENIED in production", () => {
    expect(isIpAllowed(null, { NODE_ENV: "development" })).toBe(true);
    expect(isIpAllowed("8.8.8.8", { NODE_ENV: "test" })).toBe(true);
    expect(isIpAllowed("8.8.8.8", { NODE_ENV: "production" })).toBe(false);
    expect(isIpAllowed(null, { NODE_ENV: "production", PLATFORM_ADMIN_ALLOWED_CIDRS: " , " })).toBe(false);
  });
  it("with an allowlist: only matching addresses pass, and an unknown address never does", () => {
    const env = { NODE_ENV: "development", PLATFORM_ADMIN_ALLOWED_CIDRS: "10.0.0.0/8, 203.0.113.9" };
    expect(isIpAllowed("10.9.9.9", env)).toBe(true);
    expect(isIpAllowed("203.0.113.9", env)).toBe(true);
    expect(isIpAllowed("8.8.8.8", env)).toBe(false);
    expect(isIpAllowed(null, env)).toBe(false);
  });
  it("an allowlist made only of garbage allows nobody (it is configured, so it is enforced)", () => {
    expect(isIpAllowed("10.0.0.1", { NODE_ENV: "development", PLATFORM_ADMIN_ALLOWED_CIDRS: "oops, 10.0.0.0/99" })).toBe(false);
  });
});

describe("parseCidrs", () => {
  it("trims and drops empties", () => expect(parseCidrs(" 10.0.0.0/8 , ,203.0.113.9 ")).toEqual(["10.0.0.0/8", "203.0.113.9"]));
  it("handles undefined", () => expect(parseCidrs(undefined)).toEqual([]));
});
