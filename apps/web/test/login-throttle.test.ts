/** Sign-in / registration throttle policy -- unit test with a recording limiter. Decision SEC-009, 13 2.4 / 5.1. */
import { describe, expect, it } from "vitest";
import { AppError } from "@erp/shared";
import { MemoryRateLimiter, type RateLimiter, type RateLimitResult } from "../lib/rate-limit";
import { LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS, REGISTER_LIMIT, REGISTER_WINDOW_MS, beginLoginAttempt, enforceRegistrationLimit, loginIpLimit } from "../lib/login-throttle";

function recording(inner: RateLimiter) {
  const calls: Array<{ key: string; limit: number; windowMs: number }> = [];
  const resets: string[] = [];
  const limiter: RateLimiter = {
    consume: (key: string, limit: number, windowMs: number): Promise<RateLimitResult> => { calls.push({ key, limit, windowMs }); return inner.consume(key, limit, windowMs); },
    reset: (key: string) => { resets.push(key); return inner.reset(key); },
  };
  return { limiter, calls, resets };
}
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as AppError | null);

describe("beginLoginAttempt", () => {
  it("allows 5 attempts per (e-mail, IP) and refuses the 6th with a generic RATE_LIMITED + retry hint", async () => {
    const { limiter } = recording(new MemoryRateLimiter());
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await beginLoginAttempt("a@x.test", "1.1.1.1", limiter);
    const error = await code(beginLoginAttempt("a@x.test", "1.1.1.1", limiter));
    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.message).toBe("Too many attempts. Please try again later.");
    expect(error?.details?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error?.details?.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
  });

  it("the message does not mention e-mail, account, password or existence (no enumeration)", async () => {
    const { limiter } = recording(new MemoryRateLimiter());
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await beginLoginAttempt("a@x.test", null, limiter);
    const error = await code(beginLoginAttempt("a@x.test", null, limiter));
    expect(error?.message.toLowerCase()).not.toMatch(/account|password|e-?mail|exist|registered|locked/);
  });

  it("a success clears the failure counter for that (e-mail, IP) only", async () => {
    const { limiter } = recording(new MemoryRateLimiter());
    for (let i = 0; i < 4; i++) await beginLoginAttempt("a@x.test", "1.1.1.1", limiter);
    const fifth = await beginLoginAttempt("a@x.test", "1.1.1.1", limiter);
    await fifth.succeeded();
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await beginLoginAttempt("a@x.test", "1.1.1.1", limiter); // fresh budget
    expect((await code(beginLoginAttempt("a@x.test", "1.1.1.1", limiter)))?.code).toBe("RATE_LIMITED");
  });

  it("is keyed on BOTH e-mail and IP: another IP or another e-mail has its own budget", async () => {
    const { limiter } = recording(new MemoryRateLimiter());
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await beginLoginAttempt("a@x.test", "1.1.1.1", limiter);
    await expect(beginLoginAttempt("a@x.test", "2.2.2.2", limiter)).resolves.toBeDefined();
    await expect(beginLoginAttempt("b@x.test", "1.1.1.1", limiter)).resolves.toBeDefined();
  });

  it("treats the e-mail case-insensitively (cannot dodge the lock with 'A@X.test')", async () => {
    const { limiter } = recording(new MemoryRateLimiter());
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await beginLoginAttempt("a@x.test", "1.1.1.1", limiter);
    expect((await code(beginLoginAttempt("  A@X.TEST ", "1.1.1.1", limiter)))?.code).toBe("RATE_LIMITED");
  });

  it("never puts the e-mail or a password-like value into a limiter key (hashed, fixed length)", async () => {
    const { limiter, calls } = recording(new MemoryRateLimiter());
    await beginLoginAttempt("someone.private@example.test", "9.9.9.9", limiter);
    for (const call of calls) expect(call.key).not.toContain("someone");
    const acct = calls.find((c) => c.key.startsWith("login:acct:"))!;
    expect(acct.key).toMatch(/^login:acct:[0-9a-f]{64}:9\.9\.9\.9$/);
  });

  it("applies the per-IP layer when the address is known, with a generous limit", async () => {
    const { limiter, calls } = recording(new MemoryRateLimiter());
    await beginLoginAttempt("a@x.test", "9.9.9.9", limiter);
    const ip = calls.find((c) => c.key === "login:ip:9.9.9.9")!;
    expect(ip.limit).toBe(100);
    expect(ip.windowMs).toBe(LOGIN_WINDOW_MS);
  });

  it("per-IP layer: one address cycling through many e-mails is refused once it passes the limit", async () => {
    const { limiter } = recording(new MemoryRateLimiter());
    const limit = loginIpLimit();
    for (let i = 0; i < limit; i++) await beginLoginAttempt(`user${i}@x.test`, "7.7.7.7", limiter);
    expect((await code(beginLoginAttempt("one-more@x.test", "7.7.7.7", limiter)))?.code).toBe("RATE_LIMITED");
    await expect(beginLoginAttempt("one-more@x.test", "8.8.8.8", limiter)).resolves.toBeDefined(); // another address is fine
  });

  it("an unknown address SKIPS the per-IP layer (one shared 'unknown' bucket would let one attacker lock out everybody) but the lockout still works", async () => {
    const { limiter, calls } = recording(new MemoryRateLimiter());
    for (let i = 0; i < 150; i++) await beginLoginAttempt(`user${i}@x.test`, null, limiter); // never blocked by an IP layer
    expect(calls.some((c) => c.key.startsWith("login:ip:"))).toBe(false);
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) await beginLoginAttempt("victim@x.test", null, limiter);
    expect((await code(beginLoginAttempt("victim@x.test", null, limiter)))?.code).toBe("RATE_LIMITED");
  });

  it("a request refused by the IP layer does not use up the (e-mail, IP) budget", async () => {
    const { limiter, calls } = recording(new MemoryRateLimiter());
    for (let i = 0; i < loginIpLimit(); i++) await beginLoginAttempt(`u${i}@x.test`, "7.7.7.7", limiter);
    const before = calls.filter((c) => c.key.startsWith("login:acct:")).length;
    await code(beginLoginAttempt("blocked@x.test", "7.7.7.7", limiter));
    expect(calls.filter((c) => c.key.startsWith("login:acct:")).length).toBe(before);
  });
});

describe("loginIpLimit", () => {
  it("defaults to 100 and accepts a positive integer override; garbage falls back to the default", () => {
    expect(loginIpLimit({})).toBe(100);
    expect(loginIpLimit({ RATE_LIMIT_LOGIN_IP_MAX: "250" })).toBe(250);
    for (const bad of ["0", "-5", "abc", ""]) expect(loginIpLimit({ RATE_LIMIT_LOGIN_IP_MAX: bad })).toBe(100);
  });
});

describe("enforceRegistrationLimit (13 5.1: 5 / hour / IP)", () => {
  it("allows 5, refuses the 6th, and is per IP", async () => {
    const { limiter, calls } = recording(new MemoryRateLimiter());
    for (let i = 0; i < REGISTER_LIMIT; i++) await enforceRegistrationLimit("3.3.3.3", limiter);
    expect((await code(enforceRegistrationLimit("3.3.3.3", limiter)))?.code).toBe("RATE_LIMITED");
    await expect(enforceRegistrationLimit("4.4.4.4", limiter)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ key: "register:ip:3.3.3.3", limit: 5, windowMs: REGISTER_WINDOW_MS });
  });
  it("is skipped when the address is unknown (cannot key a per-IP limit)", async () => {
    const { limiter, calls } = recording(new MemoryRateLimiter());
    await enforceRegistrationLimit(null, limiter);
    expect(calls).toHaveLength(0);
  });
});
