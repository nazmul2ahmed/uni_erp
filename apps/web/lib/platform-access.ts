/**
 * Pure network/flag checks for the platform-operator surface (ADR-001,
 * Decisions PLT-001 / PLT-003). No database, no framework -- unit-testable.
 *
 * Interim control until MFA exists (13 s14 Q2): the surface is OFF unless
 * PLATFORM_ADMIN_ENABLED=true, and in production it is reachable only from
 * PLATFORM_ADMIN_ALLOWED_CIDRS. Everything here FAILS CLOSED: an unparseable
 * entry never matches, an unknown client address never matches a configured
 * allowlist, and an empty allowlist in production allows nobody.
 */
import { isIP } from "node:net";
import { clientIp, normalizeIp, type Env } from "./client-ip";

export function platformAdminEnabled(env: Env = process.env): boolean {
  return env.PLATFORM_ADMIN_ENABLED === "true";
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** True when `ip` is inside `cidr` (IPv4 "a.b.c.d/n" or a bare IPv4; bare IPv6 = exact match). Invalid input => false. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const candidate = normalizeIp(ip.trim());
  const entry = cidr.trim();
  if (!isIP(candidate) || entry === "") return false;

  if (!entry.includes("/")) return isIP(entry) !== 0 && normalizeIp(entry).toLowerCase() === candidate.toLowerCase();

  const [base, bitsText] = entry.split("/");
  if (!base || bitsText === undefined || !/^\d{1,2}$/.test(bitsText)) return false;
  const bits = Number(bitsText);
  if (bits > 32 || isIP(base) !== 4 || isIP(candidate) !== 4) return false; // IPv6 ranges are unsupported => never match
  const a = ipv4ToInt(candidate);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function parseCidrs(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** Shared with the login throttle (Decision SEC-009): see client-ip.ts. */
export { clientIp };

export function isIpAllowed(ip: string | null, env: Env = process.env): boolean {
  const cidrs = parseCidrs(env.PLATFORM_ADMIN_ALLOWED_CIDRS);
  if (cidrs.length === 0) return env.NODE_ENV !== "production"; // unset: open for local development only
  return ip !== null && cidrs.some((cidr) => ipInCidr(ip, cidr));
}
