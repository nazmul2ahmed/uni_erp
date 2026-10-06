/**
 * Pure helpers for the Expenses page -- no React, no DB, unit-testable.
 * Money is handled as exact 1e-4 bigint units: never parseFloat on an amount.
 */

const UNITS = 10000n;

/** Mirrors positiveMoneyStringSchema (packages/validation/shared.ts). */
export const MONEY_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;

export function isValidPositiveAmount(value: string): boolean {
  const v = value.trim();
  return MONEY_PATTERN.test(v) && toUnits(v) > 0n;
}

export function toUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return BigInt(whole || "0") * UNITS + BigInt(fraction.padEnd(4, "0").slice(0, 4));
}

export function sumAmounts(values: string[]): bigint {
  return values.reduce((total, v) => total + toUnits(v), 0n);
}

/** Exact, locale-grouped display of 1e-4 units with 2 decimals (rounds half up). */
export function formatUnits(units: bigint, locale = "en-BD"): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = (abs + 50n) / 100n; // round to 2dp
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  const grouped = new Intl.NumberFormat(locale).format(whole);
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

export function formatAmount(value: string, locale = "en-BD"): string {
  return formatUnits(toUnits(value), locale);
}

/** 'YYYY-MM-DD' -> '30 Sep 2026' without any timezone shift (a date, not an instant). */
export function formatDateOnly(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Browser-local calendar date as YYYY-MM-DD (default for the date field). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export type ExpenseFormValues = { branchId: string; categoryId: string; amount: string; paidVia: string; expenseDate: string };

/** Client-side mirror of the server rules, for fast feedback only -- the server remains authoritative. */
export function validateExpenseForm(v: ExpenseFormValues, today: string): string | null {
  if (!v.branchId) return "Select a branch";
  if (!v.categoryId) return "Select a category";
  if (!isValidPositiveAmount(v.amount)) return "Enter an amount greater than zero with at most 4 decimal places";
  if (v.paidVia !== "CASH" && v.paidVia !== "BANK") return "Select how it was paid";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.expenseDate)) return "Enter a valid date";
  if (v.expenseDate > today) return "The expense date cannot be in the future";
  return null;
}

/** Total of the expenses that still count: a reversed expense nets to zero in the ledger, so it is left out. */
export function sumActiveAmounts(rows: Array<{ amount: string; reversedAt: string | null }>): bigint {
  return sumAmounts(rows.filter((row) => !row.reversedAt).map((row) => row.amount));
}

/** "1500.5000" -> "1500.5", "20.0000" -> "20": for putting a stored amount back into an input. */
export function trimAmount(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export const MIN_REVERSAL_REASON = 3;

/** Fast feedback only -- the server enforces the same rule. Returns null when acceptable. */
export function validateReversalReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REVERSAL_REASON) return `Give a reason of at least ${MIN_REVERSAL_REASON} characters`;
  if (trimmed.length > 500) return "The reason is limited to 500 characters";
  return null;
}
