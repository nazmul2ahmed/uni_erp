/**
 * Rate limiting -- 13_SECURITY_SPECIFICATION.md 5, Decision SEC-009.
 *
 * Sliding-window LOG counter (exact, no boundary bursts): each allowed hit is recorded with its time,
 * hits older than the window are dropped, and a hit is refused once `limit` remain. Refused hits are NOT
 * recorded, so an attacker hammering a locked key cannot extend the lock beyond the window.
 *
 * State lives in the platform's operational Redis (13 5.3) -- never in the tenant database. Redis is an
 * OPTIONAL infrastructure service (04 47): when REDIS_URL is unset, or Redis is unreachable, the limiter
 * falls back to an in-process counter. That keeps brute-force protection (per instance) instead of either
 * failing open with none or failing closed and locking every user out of sign-in during a Redis outage.
 */
import { randomBytes } from "node:crypto";
import Redis from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  /** Hits still available in the current window after this call. */
  remaining: number;
  /** When refused: milliseconds until a slot frees (the oldest hit leaves the window). */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Atomically: drop expired hits; if fewer than `limit` remain record this one and allow, else refuse. */
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  /** Forget every hit for the key (e.g. after a successful sign-in). */
  reset(key: string): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private calls = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = this.now();
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (++this.calls % 1000 === 0) this.sweep(now - windowMs);
    if (live.length >= limit) {
      this.hits.set(key, live);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, live[0]! + windowMs - now) };
    }
    live.push(now);
    this.hits.set(key, live);
    return { allowed: true, remaining: limit - live.length, retryAfterMs: 0 };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }

  private sweep(cutoff: number) {
    for (const [key, times] of this.hits) if (times.length === 0 || times[times.length - 1]! <= cutoff) this.hits.delete(key);
  }
}

// KEYS[1]=key  ARGV[1]=window ms  ARGV[2]=limit  ARGV[3]=unique member. Uses the REDIS clock so several app
// instances agree on time. Returns {allowed(1/0), remaining, retryAfterMs}.
const CONSUME_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, 0, math.max(1, window - (now - tonumber(oldest[2])))}
end
redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1, limit - count - 1, 0}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis, private readonly prefix = "rl:") {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(CONSUME_SCRIPT, 1, this.prefix + key, String(windowMs), String(limit), randomBytes(6).toString("hex"))) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

/** Primary (Redis) with an in-process fallback when the primary errors. Never throws because the primary is down. */
export class ResilientRateLimiter implements RateLimiter {
  private lastWarn = 0;
  constructor(private readonly primary: RateLimiter, private readonly fallback: RateLimiter, private readonly warn: (message: string) => void = (m) => console.warn(m)) {}

  private degrade(error: unknown) {
    const now = Date.now();
    if (now - this.lastWarn > 60_000) {
      this.lastWarn = now;
      this.warn(`[rate-limit] Redis unavailable (${error instanceof Error ? error.message : String(error)}); using the in-process limiter, which protects this instance only`);
    }
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try { return await this.primary.consume(key, limit, windowMs); }
    catch (error) { this.degrade(error); return this.fallback.consume(key, limit, windowMs); }
  }

  async reset(key: string): Promise<void> {
    // Clear BOTH: hits recorded while Redis was down live in the fallback and must not outlive a successful sign-in.
    await this.fallback.reset(key);
    try { await this.primary.reset(key); }
    catch (error) { this.degrade(error); }
  }
}

let current: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (current) return current;
  const url = process.env.REDIS_URL;
  if (!url) {
    current = new MemoryRateLimiter();
    return current;
  }
  const redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1_000, commandTimeout: 750, retryStrategy: (times) => Math.min(times * 200, 2_000) });
  redis.on("error", () => { /* surfaced per call by ResilientRateLimiter; never crash the process on a socket error */ });
  void redis.connect().catch(() => undefined);
  current = new ResilientRateLimiter(new RedisRateLimiter(redis), new MemoryRateLimiter());
  return current;
}

/** Tests only: install a limiter (or null to rebuild from the environment). */
export function setRateLimiterForTests(limiter: RateLimiter | null): void {
  current = limiter;
}
