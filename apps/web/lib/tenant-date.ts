/**
 * Calendar-date helpers in a tenant's own timezone (control.tenants.timezone).
 * Pure -- no DB access -- so it is unit-testable in isolation.
 */

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTimezone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
