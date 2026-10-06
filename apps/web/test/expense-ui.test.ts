/** Pure helpers behind the Expenses page (apps/web/lib/expense-ui.ts). */
import { describe, expect, it } from "vitest";
import { formatAmount, formatDateOnly, formatUnits, isValidPositiveAmount, localToday, sumActiveAmounts, sumAmounts, toUnits, trimAmount, validateExpenseForm, validateReversalReason } from "../lib/expense-ui";

describe("money is exact, never floating point", () => {
  it("sums amounts that floats get wrong (0.1 + 0.2)", () => {
    expect(formatUnits(sumAmounts(["0.1", "0.2"]))).toBe("0.30");
    expect(sumAmounts(["0.1", "0.2"])).toBe(3000n);
  });
  it("keeps 4-decimal precision internally and rounds half-up to 2dp for display", () => {
    expect(toUnits("1.2345")).toBe(12345n);
    expect(formatAmount("1.2345")).toBe("1.23");
    expect(formatAmount("1.2350")).toBe("1.24");
    expect(formatAmount("1500.5")).toBe("1,500.50");
  });
  it("handles zero, large and negative totals", () => {
    expect(formatUnits(0n)).toBe("0.00");
    expect(formatAmount("99999999999999.9999")).toMatch(/^100,000,000,000,000\.00$/);
    expect(formatUnits(-12345n)).toBe("-1.23");
  });
});

describe("isValidPositiveAmount mirrors the server rule", () => {
  it.each(["1", "0.01", "1500.50", "99999999999999.9999", " 12 "])("accepts %j", (v) => expect(isValidPositiveAmount(v)).toBe(true));
  it.each(["", "0", "0.0000", "-1", "1.23456", "1,000", "abc", "1e3", ".5", "999999999999999"])("rejects %j", (v) => expect(isValidPositiveAmount(v)).toBe(false));
});

describe("dates", () => {
  it("formats a date-only string without a timezone shift", () => {
    // ICU versions differ on "Sep" vs "Sept" for en-GB; the day/month/year and the absence of a day shift are what matter.
    expect(formatDateOnly("2026-09-30")).toMatch(/^30 Sep(t)? 2026$/);
    expect(formatDateOnly("2026-01-01")).toMatch(/^01 Jan 2026$/); // a UTC-midnight date must not slip to 31 Dec in a negative-offset zone
    expect(formatDateOnly("not-a-date")).toBe("not-a-date");
  });
  it("localToday is zero-padded YYYY-MM-DD in the browser's local calendar", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localToday(new Date(2026, 8, 30, 0, 1))).toBe("2026-09-30");
  });
});

describe("validateExpenseForm (fast feedback; server stays authoritative)", () => {
  const ok = { branchId: "b", categoryId: "c", amount: "10", paidVia: "CASH", expenseDate: "2026-09-30" };
  it("passes a valid form, including today", () => expect(validateExpenseForm(ok, "2026-09-30")).toBeNull());
  it.each([
    ["no branch", { ...ok, branchId: "" }, "branch"],
    ["no category", { ...ok, categoryId: "" }, "category"],
    ["zero amount", { ...ok, amount: "0" }, "amount"],
    ["bad amount", { ...ok, amount: "1.23456" }, "amount"],
    ["unknown payment method", { ...ok, paidVia: "CRYPTO" }, "paid"],
    ["malformed date", { ...ok, expenseDate: "30/09/2026" }, "date"],
    ["future date", { ...ok, expenseDate: "2026-10-01" }, "future"],
  ])("rejects %s", (_n, values, hint) => expect(validateExpenseForm(values, "2026-09-30")?.toLowerCase()).toContain(hint));
});

describe("reversal helpers", () => {
  it("sumActiveAmounts leaves reversed expenses out (they net to zero in the ledger)", () => {
    const rows = [
      { amount: "100", reversedAt: null },
      { amount: "250.5", reversedAt: "2026-09-30T10:00:00Z" },
      { amount: "0.25", reversedAt: null },
    ];
    expect(formatUnits(sumActiveAmounts(rows))).toBe("100.25");
    expect(sumActiveAmounts([])).toBe(0n);
  });
  it("trimAmount turns a stored 4dp amount back into a clean input value", () => {
    expect(trimAmount("1500.5000")).toBe("1500.5");
    expect(trimAmount("20.0000")).toBe("20");
    expect(trimAmount("20")).toBe("20");
    expect(trimAmount("0.0100")).toBe("0.01");
  });
  it("validateReversalReason mirrors the server rule (3-500 characters after trimming)", () => {
    expect(validateReversalReason("")).not.toBeNull();
    expect(validateReversalReason("  ab ")).not.toBeNull();
    expect(validateReversalReason("abc")).toBeNull();
    expect(validateReversalReason("x".repeat(500))).toBeNull();
    expect(validateReversalReason("x".repeat(501))).not.toBeNull();
  });
});
