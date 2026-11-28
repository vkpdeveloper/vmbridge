import { describe, expect, test } from "bun:test";
import { rangeStart, usageWindow } from "./costs.ts";

describe("rangeStart", () => {
  test("uses the server monthStart for month range when provided so Costs matches Budget across time zones", () => {
    const serverMonthStart = Date.UTC(2026, 10, 1, 0, 0, 0);
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(rangeStart("month", now, serverMonthStart)).toBe(serverMonthStart);
  });

  test("falls back to local month start when no server monthStart is supplied and computes 30d from now", () => {
    const now = new Date(2026, 10, 15, 12, 0, 0).getTime();
    expect(rangeStart("month", now)).toBe(new Date(2026, 10, 1).getTime());
    expect(rangeStart("30d", now, Date.UTC(2026, 10, 1))).toBe(now - 30 * 86_400_000);
  });
});

describe("usageWindow", () => {
  test("returns { from, to: now } normally and keeps from strictly before to when the browser clock trails", () => {
    const serverMonthStart = Date.UTC(2026, 10, 1, 0, 0, 0);
    const normalNow = serverMonthStart + 3_600_000;
    expect(usageWindow("month", normalNow, serverMonthStart)).toEqual({ from: serverMonthStart, to: normalNow });

    const laggingBrowserNow = serverMonthStart - 5_000;
    const window = usageWindow("month", laggingBrowserNow, serverMonthStart);
    expect(window.from).toBe(serverMonthStart);
    expect(window.to).toBeGreaterThan(window.from);
  });
});
