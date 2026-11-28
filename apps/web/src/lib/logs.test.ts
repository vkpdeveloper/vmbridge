import { describe, expect, test } from "bun:test";
import type { TrafficEvent } from "@vmbridge/contracts";
import { foldTraffic } from "./logs.ts";

const event = (id: number, overrides: Partial<TrafficEvent> = {}): TrafficEvent => ({
  id,
  at: id * 1000,
  kind: "provider",
  operation: "wake VM",
  vmId: "vm1",
  provider: "boxd",
  status: "error",
  durationMs: 100,
  ...overrides,
});

describe("foldTraffic", () => {
  test("folds consecutive identical requests and failures with the same reason", () => {
    const rows = foldTraffic([
      event(1, { reason: "timeout", durationMs: 100 }),
      event(2, { reason: "timeout", durationMs: 300 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, totalMs: 400, maxMs: 300 });
    expect(rows[0]!.first.id).toBe(1);
    expect(rows[0]!.last.id).toBe(2);
  });

  test("keeps consecutive failures with distinct reasons on separate rows", () => {
    const rows = foldTraffic([
      event(1, { reason: "Quota exceeded" }),
      event(2, { reason: "sandbox not found" }),
      event(3, { reason: undefined }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.last.reason)).toEqual(["Quota exceeded", "sandbox not found", undefined]);
  });
});
