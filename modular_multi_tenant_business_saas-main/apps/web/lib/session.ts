/**
 * Session lifecycle per 13_SECURITY_SPECIFICATION.md §2.1.
 *
 * - Opaque, server-generated token in an HTTP-only, Secure,
 *   SameSite=Lax cookie (never a JWT the client could inspect/tamper).
 * - Sliding expiration: refreshed on activity, absolute cap.
 * - Values are placeholders per 13 §14 Q1, tunable via env.
 */
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db, sessions } from "@erp/db";
import { eq } from "drizzle-orm";

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "erp_session";
const IDLE_TIMEOUT_MS =
  Number(process.env.SESSION_IDLE_TIMEOUT_DAYS ?? 7) * 24 * 60 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS =
  Number(process.env.SESSION_ABSOLUTE_TIMEOUT_DAYS ?? 30) * 24 * 60 * 60 * 1000;

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId: string): Promise<string> {
  const id = generateSessionId();
  const now = new Date();
  await db.insert(sessions).values({
    id,
    userId,
    activeTenantId: null, // per 05 §43 — null until /auth/tenant/select
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS),
  });

  cookies().set(COOKIE_NAME, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ABSOLUTE_TIMEOUT_MS / 1000,
  });

  return id;
}

export interface LoadedSession {
  id: string;
  userId: string;
  activeTenantId: string | null;
}

/**
 * Loads and validates the current session, sliding the idle-timeout
 * window forward on each call. Returns null if missing/expired —
 * callers (guard.ts) treat null as AUTHENTICATION_REQUIRED (fail closed).
 */
export async function loadSession(): Promise<LoadedSession | null> {
  const cookieStore = cookies();
  const sessionId = cookieStore.get(COOKIE_NAME)?.value;
  if (!sessionId) return null;

  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!row) return null;

  const now = new Date();
  if (row.expiresAt < now) return null; // absolute timeout exceeded

  const idleExpired = now.getTime() - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS;
  if (idleExpired) return null;

  // Slide the idle window forward (fire-and-forget is acceptable here;
  // a missed update only shortens, never extends, effective session life).
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));

  return { id: row.id, userId: row.userId, activeTenantId: row.activeTenantId };
}

export async function setActiveTenant(sessionId: string, tenantId: string): Promise<void> {
  await db.update(sessions).set({ activeTenantId: tenantId }).where(eq(sessions.id, sessionId));
}

export async function destroySession(): Promise<void> {
  const cookieStore = cookies();
  const sessionId = cookieStore.get(COOKIE_NAME)?.value;
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  cookieStore.delete(COOKIE_NAME);
}

/**
 * Invalidates ALL sessions for a user — per 13 §2.5 step 3, used on
 * password reset. Not wired to an endpoint yet in Phase 1 (password
 * reset flow is deferred), but the primitive is provided now so it
 * is not silently forgotten later.
 */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
