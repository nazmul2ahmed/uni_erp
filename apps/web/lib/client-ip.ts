/**
 * Caller address behind a reverse proxy -- shared by the platform-operator allowlist (ADR-001)
 * and the login / registration rate limits (Decision SEC-009). ONE implementation, so the two can
 * never disagree about who the caller is.
 *
 * X-Forwarded-For is client-forgeable, so it is read ONLY when the deployment declares a trusted
 * proxy (TRUST_PROXY=true), and then the entry appended by OUR proxy is used (PROXY_HOPS from the
 * right, default 1), never the leftmost one. Without a trusted proxy the address is unknown (null).
 * The older PLATFORM_ADMIN_TRUST_PROXY / PLATFORM_ADMIN_PROXY_HOPS names are still honoured.
 */
import { isIP } from "node:net";

export type Env = Record<string, string | undefined>;

/** "::ffff:1.2.3.4" -> "1.2.3.4"; anything else unchanged. */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

export function clientIp(headers: Headers, env: Env = process.env): string | null {
  const trust = env.TRUST_PROXY ?? env.PLATFORM_ADMIN_TRUST_PROXY;
  if (trust !== "true") return null;
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const hops = Math.max(1, Number.parseInt(env.PROXY_HOPS ?? env.PLATFORM_ADMIN_PROXY_HOPS ?? "1", 10) || 1);
  const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
  const candidate = parts[parts.length - hops];
  return candidate && isIP(normalizeIp(candidate)) ? normalizeIp(candidate) : null;
}
