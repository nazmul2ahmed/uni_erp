/**
 * Sign-in / registration throttling through the REAL routes -- Decision SEC-009, 13 2.3 / 2.4 / 5.
 * Real PostgreSQL, real argon2, real route handlers, real limiter (clock-controlled in-process one, and the
 * real Redis one when available). Only cookie/session creation and tenant onboarding are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { createOwnerDb, users } from "@erp/db";

vi.mock("@/lib/session", () => ({ createSession: async () => "stub-session", setActiveTenant: async () => undefined }));
vi.mock("@/lib/tenant-onboarding", () => ({ registerOwnerAndTenant: async () => ({ userId: randomUUID(), tenantId: randomUUID(), membershipId: randomUUID() }) }));

import { POST as loginRoute } from "../app/api/auth/login/route";
import { POST as registerRoute } from "../app/api/auth/register/route";
import { hashPassword } from "../lib/password";
import { MemoryRateLimiter, RedisRateLimiter, ResilientRateLimiter, setRateLimiterForTests, type RateLimiter } from "../lib/rate-limit";

const owner = createOwnerDb();
const PASSWORD = "correct horse battery staple";
const createdUsers: string[] = [];
let clock = 5_000_000;
const advance = (ms: number) => { clock += ms; };

async function newUser() {
  const email = `rl-${randomUUID()}@example.test`;
  const [u] = await owner.db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), fullName: "Rl Test" }).returning();
  createdUsers.push(u!.id);
  return email;
}
const login = (email: string, password: string, ip?: string) =>
  loginRoute(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) }, body: JSON.stringify({ email, password }) }) as never);
const register = (ip?: string) =>
  registerRoute(new Request("http://localhost/api/auth/register", { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) }, body: JSON.stringify({ email: `reg-${randomUUID()}@example.test`, password: PASSWORD, fullName: "Reg Test", businessName: "Reg Biz" }) }) as never);
const failN = async (email: string, n: number, ip?: string) => { for (let i = 0; i < n; i++) expect((await login(email, "wrong password!!", ip)).status).toBe(401); };

beforeAll(() => { process.env.TRUST_PROXY = "true"; });
beforeEach(() => {
  clock = 5_000_000;
  process.env.TRUST_PROXY = "true";
  delete process.env.RATE_LIMIT_LOGIN_IP_MAX;
  setRateLimiterForTests(new MemoryRateLimiter(() => clock));
});
afterAll(async () => {
  setRateLimiterForTests(null);
  delete process.env.TRUST_PROXY;
  for (const id of createdUsers) await owner.db.delete(users).where(eq(users.id, id)).catch(() => undefined);
  await owner.close();
}, 30_000);

describe("account lockout (13 2.4): 5 attempts per (e-mail, IP) per 15 minutes", () => {
  it("5 wrong passwords are answered 401; the 6th is refused 429 with Retry-After EVEN WITH THE CORRECT PASSWORD", async () => {
    const email = await newUser();
    await failN(email, 5, "10.0.0.1");
    const blocked = await login(email, PASSWORD, "10.0.0.1");
    expect(blocked.status).toBe(429);
    const retry = Number(blocked.headers.get("Retry-After"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(900);
    expect((await blocked.json()).error.code).toBe("RATE_LIMITED");
  });

  it("the lock ends on schedule and a correct sign-in then works", async () => {
    const email = await newUser();
    await failN(email, 5, "10.0.0.2");
    expect((await login(email, PASSWORD, "10.0.0.2")).status).toBe(429);
    advance(15 * 60_000 + 1000);
    const ok = await login(email, PASSWORD, "10.0.0.2");
    expect(ok.status).toBe(200);
    expect((await ok.json()).success).toBe(true);
  });

  it("a successful sign-in resets the count: 4 failures, 1 success, 4 more failures are all still plain 401s", async () => {
    const email = await newUser();
    await failN(email, 4, "10.0.0.3");
    expect((await login(email, PASSWORD, "10.0.0.3")).status).toBe(200);
    await failN(email, 4, "10.0.0.3");
    expect((await login(email, PASSWORD, "10.0.0.3")).status).toBe(200);
  });

  it("is per (e-mail, IP): another address, and another e-mail from the same address, are unaffected", async () => {
    const victim = await newUser();
    const other = await newUser();
    await failN(victim, 5, "10.0.0.4");
    expect((await login(victim, PASSWORD, "10.0.0.4")).status).toBe(429);
    expect((await login(victim, PASSWORD, "10.0.0.5")).status).toBe(200); // the real owner, elsewhere
    expect((await login(other, PASSWORD, "10.0.0.4")).status).toBe(200);
  });

  it("a forged leftmost X-Forwarded-For entry does not dodge the lock (only the proxy-appended one counts)", async () => {
    const email = await newUser();
    await failN(email, 5, "6.6.6.6");
    // attacker prepends fresh fake addresses; our proxy still appends the real one (6.6.6.6) last
    expect((await login(email, PASSWORD, "1.2.3.4, 6.6.6.6")).status).toBe(429);
    expect((await login(email, PASSWORD, "9.9.9.9, 6.6.6.6")).status).toBe(429);
  });
});

describe("no account enumeration (13 2.3 step 4, 2.4)", () => {
  it("an unknown e-mail goes through the IDENTICAL sequence and body as a real one: 401 x5, then 429", async () => {
    const real = await newUser();
    const ghost = `ghost-${randomUUID()}@example.test`;
    const trace = async (email: string, ip: string) => {
      const out: Array<[number, string, string]> = [];
      for (let i = 0; i < 6; i++) {
        const res = await login(email, "wrong password!!", ip);
        const body = await res.json();
        out.push([res.status, body.error.code, body.error.message]);
      }
      return out;
    };
    const a = await trace(real, "10.1.0.1");
    const b = await trace(ghost, "10.1.0.2");
    expect(a).toEqual(b);
    expect(a.slice(0, 5).every((r) => r[0] === 401)).toBe(true);
    expect(a[5]![0]).toBe(429);
    expect(a[5]![2]).not.toMatch(/exist|registered|account|e-?mail/i);
  });
});

describe("per-IP guard: one address cycling through many e-mails", () => {
  it("is refused once it exceeds the limit, while other addresses keep working", async () => {
    process.env.RATE_LIMIT_LOGIN_IP_MAX = "4";
    const emails = [await newUser(), await newUser(), await newUser(), await newUser(), await newUser()];
    for (let i = 0; i < 4; i++) expect((await login(emails[i]!, "wrong password!!", "10.2.0.1")).status).toBe(401);
    expect((await login(emails[4]!, "wrong password!!", "10.2.0.1")).status).toBe(429);
    expect((await login(emails[4]!, PASSWORD, "10.2.0.2")).status).toBe(200);
  });

  it("is skipped when the address is unknown: many e-mails are never blocked by an IP layer, but each e-mail still locks", async () => {
    delete process.env.TRUST_PROXY; // no trusted proxy => caller address unknown
    process.env.RATE_LIMIT_LOGIN_IP_MAX = "2";
    for (let i = 0; i < 6; i++) expect((await login(await newUser(), "wrong password!!")).status).toBe(401);
    const email = await newUser();
    await failN(email, 5);
    expect((await login(email, PASSWORD)).status).toBe(429);
  });

  it("an X-Forwarded-For header is IGNORED when no proxy is trusted (cannot be used to dodge or to frame an address)", async () => {
    delete process.env.TRUST_PROXY;
    const email = await newUser();
    await failN(email, 5, "11.11.11.11");
    expect((await login(email, PASSWORD, "22.22.22.22")).status).toBe(429); // same bucket regardless of the header
  });
});

describe("registration (13 5.1): 5 per hour per IP", () => {
  it("allows 5, refuses the 6th with 429 + Retry-After, is per IP, and recovers after the window", async () => {
    for (let i = 0; i < 5; i++) expect((await register("10.3.0.1")).status).toBe(200);
    const blocked = await register("10.3.0.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await register("10.3.0.2")).status).toBe(200);
    advance(60 * 60_000 + 1000);
    expect((await register("10.3.0.1")).status).toBe(200);
  });
  it("is not applied when the address is unknown", async () => {
    delete process.env.TRUST_PROXY;
    for (let i = 0; i < 8; i++) expect((await register()).status).toBe(200);
  });
});

describe("limiter backend failure must not disable protection or block everybody", () => {
  it("with Redis down the in-process fallback still locks after 5 failures and still lets a correct sign-in through", async () => {
    const dead: RateLimiter = { consume: async () => { throw new Error("ECONNREFUSED"); }, reset: async () => { throw new Error("ECONNREFUSED"); } };
    setRateLimiterForTests(new ResilientRateLimiter(dead, new MemoryRateLimiter(() => clock), () => undefined));
    const good = await newUser();
    expect((await login(good, PASSWORD, "10.4.0.1")).status).toBe(200);
    const victim = await newUser();
    await failN(victim, 5, "10.4.0.2");
    expect((await login(victim, PASSWORD, "10.4.0.2")).status).toBe(429);
  });
});

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redisUp = await (async () => {
  const probe = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 500, retryStrategy: () => null });
  probe.on("error", () => undefined);
  try { await probe.connect(); await probe.ping(); return true; } catch { return false; } finally { probe.disconnect(); }
})();

describe.skipIf(!redisUp)("end to end on the real Redis limiter", () => {
  it("5 failures lock a real sign-in through Redis, and the state is shared by a second limiter instance (another app instance)", async () => {
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    client.on("error", () => undefined);
    const prefix = `rltest:e2e:${randomUUID()}:`;
    setRateLimiterForTests(new RedisRateLimiter(client, prefix));
    const email = await newUser();
    await failN(email, 5, "10.5.0.1");
    // a different "instance": a brand-new limiter object over a new connection, same Redis
    const client2 = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    client2.on("error", () => undefined);
    setRateLimiterForTests(new RedisRateLimiter(client2, prefix));
    expect((await login(email, PASSWORD, "10.5.0.1")).status).toBe(429);
    const keys = await client.keys(`${prefix}*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(" ")).not.toContain(email); // no e-mail stored in Redis
    await client.del(...keys);
    client.disconnect(); client2.disconnect();
  });
});
