/**
 * Sign-in and registration throttling -- 13_SECURITY_SPECIFICATION.md 2.4 and 5.1, Decision SEC-009.
 *
 * Two layers on login, checked BEFORE the user lookup or any password hashing so a blocked caller
 * costs the server almost nothing:
 *   1. per IP        -- request-rate guard for one address cycling through many e-mails (13 2.4, last line).
 *   2. per (e-mail, IP) -- the lockout: 5 attempts / 15 min. Every attempt counts, a SUCCESSFUL sign-in clears the
 *      counter, so the lock means "5 failures in a row"; it is consumed up front (not after the password check) so
 *      parallel requests cannot slip extra guesses past the limit.
 * The lock does not depend on whether the account exists, and the refusal is one generic message, so neither
 * the status nor the text reveals which e-mails are registered (13 2.4).
 *
 * The caller's address comes from the shared trusted-proxy logic. When it is unknown (no trusted proxy) the
 * per-IP layer is skipped -- a single shared "unknown" bucket would let one attacker lock out everybody -- and the
 * lockout keys on e-mail alone.
 */
import { createHash } from "node:crypto";
import { AppError } from "@erp/shared";
import { getRateLimiter, type RateLimiter } from "./rate-limit";

export const LOGIN_ATTEMPT_LIMIT = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const REGISTER_LIMIT = 5;
export const REGISTER_WINDOW_MS = 60 * 60_000;
const DEFAULT_LOGIN_IP_LIMIT = 100;

/** Generous on purpose: many shops share one address (carrier-grade NAT), and 13 5.1 sets no per-IP login figure. Tunable. */
export function loginIpLimit(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.RATE_LIMIT_LOGIN_IP_MAX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOGIN_IP_LIMIT;
}

function tooManyAttempts(retryAfterMs: number): AppError {
  return new AppError("RATE_LIMITED", "Too many attempts. Please try again later.", { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface LoginAttempt {
  /** Call once the password has been verified: clears this (e-mail, IP) failure counter. */
  succeeded(): Promise<void>;
}

export async function beginLoginAttempt(email: string, ip: string | null, limiter: RateLimiter = getRateLimiter()): Promise<LoginAttempt> {
  if (ip) {
    const byIp = await limiter.consume(`login:ip:${ip}`, loginIpLimit(), LOGIN_WINDOW_MS);
    if (!byIp.allowed) throw tooManyAttempts(byIp.retryAfterMs);
  }
  // The e-mail is hashed: no personal data in Redis keys, and a bounded key length.
  const accountKey = `login:acct:${digest(email.trim().toLowerCase())}:${ip ?? "unknown"}`;
  const byAccount = await limiter.consume(accountKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS);
  if (!byAccount.allowed) throw tooManyAttempts(byAccount.retryAfterMs);
  return { succeeded: () => limiter.reset(accountKey) };
}

/** 13 5.1: POST /api/auth/register -- 5 per hour per IP. Skipped when the address is unknown (see the module note). */
export async function enforceRegistrationLimit(ip: string | null, limiter: RateLimiter = getRateLimiter()): Promise<void> {
  if (!ip) return;
  const result = await limiter.consume(`register:ip:${ip}`, REGISTER_LIMIT, REGISTER_WINDOW_MS);
  if (!result.allowed) throw tooManyAttempts(result.retryAfterMs);
}
