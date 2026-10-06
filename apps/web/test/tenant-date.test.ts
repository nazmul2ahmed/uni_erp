import { describe, expect, it } from "vitest";
import { todayInTimezone } from "../lib/tenant-date";

describe("todayInTimezone", () => {
  it("returns the tenant's local calendar date, which can be ahead of UTC (Asia/Dhaka = UTC+6)", () => {
    const lateUtc = new Date("2026-09-30T20:00:00.000Z"); // 02:00 on 1 Oct in Dhaka
    expect(todayInTimezone("Asia/Dhaka", lateUtc)).toBe("2026-10-01");
    expect(todayInTimezone("UTC", lateUtc)).toBe("2026-09-30");
  });

  it("can be behind UTC (America/New_York)", () => {
    expect(todayInTimezone("America/New_York", new Date("2026-10-01T02:00:00.000Z"))).toBe("2026-09-30");
  });

  it("is zero-padded ISO YYYY-MM-DD", () => {
    expect(todayInTimezone("UTC", new Date("2026-01-05T12:00:00.000Z"))).toBe("2026-01-05");
  });
});
