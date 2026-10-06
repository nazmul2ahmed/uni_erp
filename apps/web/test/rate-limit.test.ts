/**
 * Rate limiter contract -- Decision SEC-009, 13 s5.
 * ONE behavioural contract, run against the in-process limiter (fake clock) and, when a Redis is reachable
 * (REDIS_URL or localhost:6379), against the real Redis implementation. Both must behave identically.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { MemoryRateLimiter, RedisRateLimiter, ResilientRateLimiter, type RateLimiter } from "../lib/rate-limit";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const probe = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 500, retryStrategy: () => null });
probe.on("error", () => undefined);
const redisUp = await probe.connect().then(() => probe.ping()).then(() => true, () => false);
afterAll(async () => { probe.disconnect(); });

interface Harness { limiter: RateLimiter; advance(ms: number): Promise<void>; W: number; key(name: string): string }

function memory(): Harness {
  let now = 1_000_000;
  return { limiter: new MemoryRateLimiter(() => now), advance: async (ms) => { now += ms; }, W: 15 * 60_000, key: (n) => `t:${n}` };
}
function redis(): Harness {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  client.on("error", () => undefined);
  const prefix = `rltest:${Math.random().toString(36).slice(2)}:`;
  afterAll(async () => { const keys = await client.keys(`${prefix}*`); if (keys.length) await client.del(...keys); client.disconnect(); });
  return { limiter: new RedisRateLimiter(client, prefix), advance: (ms) => new Promise((r) => setTimeout(r, ms)), W: 600, key: (n) => `t:${n}` };
}

describe.each([
  ["memory", () => memory(), false],
  ["redis", () => redis(), true],
] as const)("%s limiter", (_name, make, needsRedis) => {
  const suite = needsRedis && !redisUp ? describe.skip : describe;
  suite("contract", () => {
    const h = make();

    it("allows exactly `limit` hits, counting down, then refuses", async () => {
      const k = h.key("basic");
      expect((await h.limiter.consume(k, 3, h.W)).remaining).toBe(2);
      expect((await h.limiter.consume(k, 3, h.W)).remaining).toBe(1);
      expect((await h.limiter.consume(k, 3, h.W)).remaining).toBe(0);
      const refused = await h.limiter.consume(k, 3, h.W);
      expect(refused.allowed).toBe(false);
      expect(refused.remaining).toBe(0);
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(h.W);
    });

    it("keys are independent", async () => {
      for (let i = 0; i < 2; i++) await h.limiter.consume(h.key("a"), 2, h.W);
      expect((await h.limiter.consume(h.key("a"), 2, h.W)).allowed).toBe(false);
      expect((await h.limiter.consume(h.key("b"), 2, h.W)).allowed).toBe(true);
    });

    it("reset forgets the key", async () => {
      const k = h.key("reset");
      await h.limiter.consume(k, 1, h.W);
      expect((await h.limiter.consume(k, 1, h.W)).allowed).toBe(false);
      await h.limiter.reset(k);
      expect((await h.limiter.consume(k, 1, h.W)).allowed).toBe(true);
    });

    it("the window SLIDES: a slot frees when the oldest hit ages out, and everything frees after a full window", async () => {
      const k = h.key("slide");
      await h.limiter.consume(k, 2, h.W);
      await h.advance(h.W / 2);
      await h.limiter.consume(k, 2, h.W);
      expect((await h.limiter.consume(k, 2, h.W)).allowed).toBe(false);
      await h.advance(h.W / 2 + 60); // the FIRST hit is now out of the window, the second is not
      expect((await h.limiter.consume(k, 2, h.W)).allowed).toBe(true);
      expect((await h.limiter.consume(k, 2, h.W)).allowed).toBe(false);
      await h.advance(h.W + 60);
      expect((await h.limiter.consume(k, 2, h.W)).allowed).toBe(true);
    });

    it("refused attempts are NOT recorded: hammering a locked key never extends the lock", async () => {
      const k = h.key("noextend");
      await h.limiter.consume(k, 1, h.W);
      for (let i = 0; i < 25; i++) expect((await h.limiter.consume(k, 1, h.W)).allowed).toBe(false);
      await h.advance(h.W + 60);
      expect((await h.limiter.consume(k, 1, h.W)).allowed).toBe(true); // lock ended on schedule
    });

    it("retryAfterMs shrinks as time passes (it is the oldest hit's remaining life)", async () => {
      const k = h.key("retry");
      await h.limiter.consume(k, 1, h.W);
      const first = (await h.limiter.consume(k, 1, h.W)).retryAfterMs;
      await h.advance(h.W / 3);
      const later = (await h.limiter.consume(k, 1, h.W)).retryAfterMs;
      expect(later).toBeLessThan(first);
    });

    it("is atomic: 30 simultaneous attempts on a limit of 5 let exactly 5 through", async () => {
      const k = h.key("atomic");
      const results = await Promise.all(Array.from({ length: 30 }, () => h.limiter.consume(k, 5, h.W)));
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });
  });
});

describe.skipIf(!redisUp)("redis housekeeping", () => {
  it("a key expires on its own once the window has passed (no unbounded growth)", async () => {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    client.on("error", () => undefined);
    const prefix = `rltest:ttl:${Math.random().toString(36).slice(2)}:`;
    const limiter = new RedisRateLimiter(client, prefix);
    await limiter.consume("k", 3, 300);
    expect(await client.exists(`${prefix}k`)).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(await client.exists(`${prefix}k`)).toBe(0);
    client.disconnect();
  });
});

describe("ResilientRateLimiter -- Redis down must not mean 'no protection' or 'nobody can sign in'", () => {
  const broken: RateLimiter = { consume: async () => { throw new Error("ECONNREFUSED"); }, reset: async () => { throw new Error("ECONNREFUSED"); } };

  it("falls back to the in-process limiter and STILL enforces the limit", async () => {
    const warn = vi.fn();
    const limiter = new ResilientRateLimiter(broken, new MemoryRateLimiter(), warn);
    for (let i = 0; i < 3; i++) expect((await limiter.consume("k", 3, 60_000)).allowed).toBe(true);
    expect((await limiter.consume("k", 3, 60_000)).allowed).toBe(false);
  });

  it("warns once, not on every request", async () => {
    const warn = vi.fn();
    const limiter = new ResilientRateLimiter(broken, new MemoryRateLimiter(), warn);
    for (let i = 0; i < 10; i++) await limiter.consume("k", 100, 60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("Redis unavailable");
  });

  it("reset clears the fallback too and never throws when Redis is down", async () => {
    const limiter = new ResilientRateLimiter(broken, new MemoryRateLimiter(), vi.fn());
    await limiter.consume("k", 1, 60_000);
    expect((await limiter.consume("k", 1, 60_000)).allowed).toBe(false);
    await expect(limiter.reset("k")).resolves.toBeUndefined();
    expect((await limiter.consume("k", 1, 60_000)).allowed).toBe(true);
  });

  it("uses Redis while it is healthy", async () => {
    const primary = { consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, retryAfterMs: 0 }), reset: vi.fn() };
    const fallback = { consume: vi.fn(), reset: vi.fn() };
    const result = await new ResilientRateLimiter(primary, fallback, vi.fn()).consume("k", 5, 1000);
    expect(result.remaining).toBe(4);
    expect(fallback.consume).not.toHaveBeenCalled();
  });
});
