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
import { db, sessions, users } from "@erp/db";
import { and, eq, ne } from "drizzle-orm";

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
  /** Decision SEC-008: the account still uses a one-time password and may only change it. */
  mustChangePassword: boolean;
}

/**
 * Loads and validates the current session, sliding the idle-timeout
 * window forward on each call. Returns null if missing/expired —
 * callers (guard.ts) treat null as AUTHENTICATION_REQUIRED (fail closed).
 */
export async function loadSession(): Promise<LoadedSession | null> {
  const sessionId = cookies().get(COOKIE_NAME)?.value;
  if (!sessionId) return null;
  return loadSessionById(sessionId);
}

/**
 * The session check proper, separate from cookie reading so it can be exercised directly.
 * Decision SEC-010: the ACCOUNT is part of the session's validity. A session whose user is
 * deactivated stops working on the very next request (and is deleted), instead of staying
 * valid until it times out -- previously `users.is_active` was only looked at at sign-in.
 * The user's one-time-password flag rides along (same query), so no guard needs a second read.
 */
export async function loadSessionById(sessionId: string): Promise<LoadedSession | null> {
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      activeTenantId: sessions.activeTenantId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId));
  if (!row) return null;

  const now = new Date();
  if (row.expiresAt < now) return null; // absolute timeout exceeded

  const idleExpired = now.getTime() - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS;
  if (idleExpired) return null;

  if (!row.isActive) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  // Slide the idle window forward (fire-and-forget is acceptable here;
  // a missed update only shortens, never extends, effective session life).
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));

  return { id: row.id, userId: row.userId, activeTenantId: row.activeTenantId, mustChangePassword: row.mustChangePassword };
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

/**
 * Decision SEC-008: after a password CHANGE the caller stays signed in on this device,
 * but every other session for the account (a stolen cookie, a forgotten browser) is revoked.
 * A password RESET still revokes all sessions (13 2.5). Returns how many were revoked.
 */
export async function destroyOtherSessionsForUser(userId: string, keepSessionId: string): Promise<number> {
  const removed = await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))).returning({ id: sessions.id });
  return removed.length;
}
