import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { Admin, type AdminDeps } from "../src/admin.ts";
import { analyticsReport, dayStarts, maxAnalyticsSpanMs } from "../src/analytics.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import type { Wire } from "../src/gateway/types.ts";
import { eurUsd, pricing } from "../src/pricing.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import { Usage } from "../src/usage.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// Monday 2026-11-02 00:00 UTC.
const monday = Date.UTC(2026, 10, 2);

describe("days", () => {
  test("start at each midnight of the time zone, including half-hour zones and DST changes", () => {
    expect(dayStarts(monday + hour, monday + 2 * day, "UTC")).toEqual([monday, monday + day]);
    expect(dayStarts(monday + hour, monday + 2 * day + 1, "UTC")).toEqual([monday, monday + day, monday + 2 * day]);
    // India is 5:30 ahead: its midnight is 18:30 UTC the day before.
    expect(dayStarts(monday, monday + day, "Asia/Kolkata")).toEqual([monday - 5.5 * hour, monday + 18.5 * hour]);
    // New York leaves DST on 2026-11-01, so that day lasts 25 hours.
    const [first, second, third] = dayStarts(Date.UTC(2026, 9, 31, 12), Date.UTC(2026, 10, 2, 12), "America/New_York");
    expect([first, second, third]).toEqual([Date.UTC(2026, 9, 31, 4), Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5)]);
  });

  test("an unknown time zone is refused", () => {
    expect(() => dayStarts(0, day, "Mars/Olympus")).toThrow(RangeError);
    expect(() => dayStarts(monday, monday, "Mars/Olympus")).toThrow(RangeError);
  });

  test("handles midnight DST spring-forward transitions without slipping into the previous day", () => {
    // Havana springs forward 2026-03-08 00:00 -> 01:00 (UTC-5 -> UTC-4), so Mar 8 starts at 05:00Z, not 04:00Z (Mar 7 23:00).
    expect(dayStarts(Date.UTC(2026, 2, 7, 12), Date.UTC(2026, 2, 9, 12), "America/Havana")).toEqual([
      Date.UTC(2026, 2, 7, 5),
      Date.UTC(2026, 2, 8, 5),
      Date.UTC(2026, 2, 9, 4),
    ]);
    // Range wholly inside 2026-03-07 23:30..23:45 Havana stays on Mar 7 alone.
    expect(dayStarts(Date.UTC(2026, 2, 8, 4, 30), Date.UTC(2026, 2, 8, 4, 45), "America/Havana")).toEqual([
      Date.UTC(2026, 2, 7, 5),
    ]);
    // Santiago (2026-09-06 00:00 -> 01:00) and Azores (2026-03-29 00:00 -> 01:00) behave the same way.
    expect(dayStarts(Date.UTC(2026, 8, 5, 12), Date.UTC(2026, 8, 7, 12), "America/Santiago")).toEqual([
      Date.UTC(2026, 8, 5, 4),
      Date.UTC(2026, 8, 6, 4),
      Date.UTC(2026, 8, 7, 3),
    ]);
    expect(dayStarts(Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 30, 12), "Atlantic/Azores")).toEqual([
      Date.UTC(2026, 2, 28, 1),
      Date.UTC(2026, 2, 29, 1),
      Date.UTC(2026, 2, 30, 0),
    ]);
  });

  test("continues past skipped calendar days across a date-line jump", () => {
    // Samoa skipped 2011-12-30 entirely: 2011-12-29 23:59:59 UTC-10 was followed by 2011-12-31 00:00:00 UTC+14.
    expect(dayStarts(Date.UTC(2011, 11, 29, 12), Date.UTC(2012, 0, 1, 12), "Pacific/Apia")).toEqual([
      Date.UTC(2011, 11, 29, 10),
      Date.UTC(2011, 11, 30, 10),
      Date.UTC(2011, 11, 31, 10),
      Date.UTC(2012, 0, 1, 10),
    ]);
  });

  test("returns no days for empty or inverted ranges and rejects oversized or invalid ranges", () => {
    expect(dayStarts(monday, monday, "UTC")).toEqual([]);
    expect(dayStarts(monday + hour, monday, "UTC")).toEqual([]);
    expect(dayStarts(monday, monday + maxAnalyticsSpanMs, "UTC")).toHaveLength(366);
    expect(() => dayStarts(monday, monday + maxAnalyticsSpanMs + 1, "UTC")).toThrow(RangeError);
    expect(() => dayStarts(Number.NaN, monday, "UTC")).toThrow(RangeError);
    expect(() => dayStarts(monday, Number.POSITIVE_INFINITY, "UTC")).toThrow(RangeError);
    expect(() => dayStarts(-1e16, monday, "UTC")).toThrow(RangeError);
  });

  test("handles midnight fall-back rollbacks and year-99 local dates without shifting days", () => {
    // America/St_Johns reached 2009-11-01 00:00 at 02:30Z, then rolled back at 02:31Z to 2009-10-31 23:01.
    // A range wholly inside the repeated Oct 31 hour belongs only to Oct 31, not Nov 1.
    expect(dayStarts(Date.UTC(2009, 10, 1, 2, 45), Date.UTC(2009, 10, 1, 2, 46), "America/St_Johns")).toEqual([
      Date.UTC(2009, 9, 31, 2, 30),
    ]);
    // Accepted lower boundary (0100-01-01T00:00Z) in a zone west of UTC has local year 99, not 1999.
    const minFrom = Date.UTC(100, 0, 1);
    const [bucket] = dayStarts(minFrom, minFrom + minute, "America/New_York");
    expect(bucket).toBeDefined();
    expect(new Date(bucket!).getUTCFullYear()).toBe(99);
    expect(bucket!).toBeLessThan(minFrom);
    expect(minFrom - bucket!).toBeLessThan(day);
  });
});

function setup() {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const awake = new Set<string>();
  const usage = new Usage(store, () => awake);
  const addVm = (id: string, provider: "boat" | "boxd" = "boat") => {
    store.insertVm({ id, provider, name: `vm-${id}`, size: "medium", state: "provisioning", createdAt: 0 });
    return store.vm(id)!;
  };
  const wake = (id: string, at: number) => {
    store.updateVm(id, { state: "ready" });
    awake.add(id);
    usage.sync(at);
  };
  const sleep = (id: string, at: number) => {
    awake.delete(id);
    store.updateVm(id, { state: "sleeping" });
    usage.sync(at);
  };
  const report = (from: number, to: number) => analyticsReport(store, usage, from, to, "UTC", to);
  return { db, store, usage, addVm, wake, sleep, report };
}

describe("report", () => {
  test("splits awake time and spend at midnight, by provider", () => {
    const { addVm, wake, sleep, report } = setup();
    addVm("a", "boat");
    addVm("b", "boxd");
    // 22:00 Monday to 02:00 Tuesday.
    wake("a", monday + 22 * hour);
    sleep("a", monday + day + 2 * hour);
    wake("b", monday + day);
    sleep("b", monday + day + hour);
    const { days, total } = report(monday, monday + 2 * day);
    expect(days.map((entry) => entry.providers.map((provider) => [provider.provider, provider.awakeMs]))).toEqual([
      [["boat", 2 * hour]],
      [["boat", 2 * hour], ["boxd", hour]],
    ]);
    // The second day's boat VM sleeps for the rest of it, which Boat does not charge.
    expect(days[1]!.providers[0]!.asleepMs).toBe(22 * hour);
    expect(days[0]!.providers[0]!.estimate).toEqual({ amount: 2 * 0.036, partial: false });
    // boxd bills memory while paused: one hour awake, then 23 asleep.
    const boxd = pricing("boxd");
    const boxdDay = (boxd.runningHourly.medium + 23 * boxd.asleepHourly.medium!) * eurUsd.rate;
    expect(days[1]!.providers[1]!.estimate.amount).toBeCloseTo(boxdDay, 6);
    // Matches what the Costs tab totals, in US dollars.
    expect(total.amount).toBeCloseTo(4 * 0.036 + boxdDay, 6);
  });

  test("counts lifecycle events by day and provider, with median times", () => {
    const { store, addVm, report } = setup();
    const a = addVm("a", "boat");
    const b = addVm("b", "boxd");
    store.recordVmEvent(a, "create", 4000, monday + hour);
    store.recordVmEvent(a, "start", 20_000, monday + hour);
    store.recordVmEvent(a, "sleep", 500, monday + 2 * hour);
    store.recordVmEvent(a, "wake", 3000, monday + day);
    store.recordVmEvent(a, "wake", 5000, monday + day + hour);
    store.recordVmEvent(a, "wake", 10_000, monday + day + 2 * hour);
    store.recordVmEvent(b, "create", 1000, monday + day);
    store.recordVmEvent(b, "delete", null, monday + day + hour);
    const { days, providers } = report(monday, monday + 2 * day);
    expect(days.map(({ created, deleted, wakes, sleeps }) => [created, deleted, wakes, sleeps])).toEqual([
      [1, 0, 0, 1],
      [1, 1, 3, 0],
    ]);
    expect(providers).toEqual([
      { provider: "boat", created: 1, deleted: 0, wakes: 3, sleeps: 1, createMs: 4000, startMs: 20_000, wakeMs: 5000 },
      { provider: "boxd", created: 1, deleted: 1, wakes: 0, sleeps: 0, createMs: 1000, startMs: null, wakeMs: null },
    ]);
  });

  test("turns count by day, repository and agent, and threads count once", () => {
    const { store, addVm, wake, sleep, report } = setup();
    addVm("a");
    store.insertProject({ id: "p", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p", "a");
    wake("a", monday);
    sleep("a", monday + hour);
    const turn = (threadId: string, runId: string, at: number, agent: string | null, model: string | null, repo: string | null = "https://github.com/acme/app.git") =>
      store.recordTurn({ threadId, runId, at, vmId: "a", provider: "boat", repo, agent, model });
    turn("t1", "r1", monday + minute, "codex", "gpt-5.5");
    turn("t1", "r2", monday + 2 * minute, "codex", "gpt-5.5");
    turn("t2", "r1", monday + day, "claudeAgent", "opus");
    turn("t1", "r3", monday + day + minute, "codex", "gpt-5.5");
    turn("t3", "r1", monday + day + 2 * minute, null, null, null);
    // The same run seen again, as on every shell update.
    turn("t1", "r1", monday + day, "codex", "gpt-5.5");

    const result = report(monday, monday + 2 * day);
    expect(result.days.map(({ threads, turns }) => [threads, turns])).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(result.threads).toBe(3);
    expect(result.repos).toEqual([{ repo: "acme/app", awakeMs: hour, threads: 2, turns: 4 }]);
    expect(result.agents).toEqual([
      { agent: "Codex", model: "gpt-5.5", threads: 1, turns: 3 },
      { agent: "Claude", model: "opus", threads: 1, turns: 1 },
      { agent: "Unknown", model: null, threads: 1, turns: 1 },
    ]);
  });

  test("sizes count VMs and their awake time", () => {
    const { addVm, wake, sleep, report } = setup();
    addVm("a");
    addVm("b");
    wake("a", monday);
    wake("b", monday);
    sleep("a", monday + hour);
    sleep("b", monday + 3 * hour);
    expect(report(monday, monday + day).sizes).toEqual([{ provider: "boat", size: "medium", vms: 2, awakeMs: 4 * hour }]);
  });

  test("errors count by day and by the provider of their VM, even once the VM is deleted", () => {
    const { db, store, addVm, report } = setup();
    const a = addVm("b", "boxd");
    store.recordVmEvent(a, "create", 1, monday);
    store.deleteVm("b");
    const traffic = new Traffic(db);
    const at = (ms: number) => db.run("UPDATE errors SET at = ? WHERE id = (SELECT MAX(id) FROM errors)", ms);
    traffic.record({ kind: "provider", operation: "sleep VM", vmId: "b", status: "error" });
    at(monday + hour);
    traffic.record({ kind: "provider", operation: "create VM", provider: "boat", status: "error" });
    at(monday + day);
    traffic.record({ kind: "system", operation: "VM disconnected", status: "error" });
    at(monday + day + hour);
    expect(report(monday, monday + 2 * day).days.map((entry) => entry.errors)).toEqual([
      [{ provider: "boxd", count: 1 }],
      [{ provider: "boat", count: 1 }, { provider: null, count: 1 }],
    ]);
  });

  test("splits awake time accurately across a midnight DST spring-forward and handles future ranges", () => {
    const { store, usage, addVm, wake, sleep } = setup();
    addVm("a", "boat");
    // 2026-03-07 23:30 to 2026-03-08 01:30 in America/Havana (1 hour total across the skipped midnight).
    const from = Date.UTC(2026, 2, 8, 4, 30);
    const to = Date.UTC(2026, 2, 8, 5, 30);
    wake("a", from);
    sleep("a", to);
    const dst = analyticsReport(store, usage, from, to, "America/Havana", to);
    expect(dst.days.map((entry) => [entry.start, entry.providers[0]?.awakeMs ?? 0])).toEqual([
      [Date.UTC(2026, 2, 7, 5), 30 * minute],
      [Date.UTC(2026, 2, 8, 5), 30 * minute],
    ]);
    // Client clock ahead of server clock (from > now) yields an empty day list rather than a future bucket.
    const empty = analyticsReport(store, usage, to + hour, to + 2 * hour, "UTC", to);
    expect(empty.days).toEqual([]);
  });

  test("assigns events and awake time to the right local day across a midnight fall-back rollback", () => {
    const { store, usage, addVm, wake, sleep } = setup();
    const vm = addVm("a", "boat");
    // America/St_Johns on 2009-11-01:
    //   02:20Z..02:30Z -> Oct 31 (10m)
    //   02:30Z..02:31Z -> Nov 1  (1m)
    //   02:31Z..03:30Z -> Oct 31 (59m, after 00:01 -> 23:01 rollback)
    //   03:30Z..03:40Z -> Nov 1  (10m)
    const from = Date.UTC(2009, 10, 1, 2, 20);
    const to = Date.UTC(2009, 10, 1, 3, 40);
    wake("a", from);
    sleep("a", to);
    store.recordVmEvent(vm, "wake", 1000, Date.UTC(2009, 10, 1, 2, 25)); // Oct 31 (first pass)
    store.recordVmEvent(vm, "wake", 1000, Date.UTC(2009, 10, 1, 2, 30, 30)); // Nov 1 (first pass)
    store.recordVmEvent(vm, "wake", 1000, Date.UTC(2009, 10, 1, 2, 45)); // Oct 31 (rolled back)
    store.recordVmEvent(vm, "wake", 1000, Date.UTC(2009, 10, 1, 3, 35)); // Nov 1 (second pass)

    const across = analyticsReport(store, usage, from, to, "America/St_Johns", to);
    expect(across.days.map((entry) => [entry.start, entry.wakes, entry.providers[0]?.awakeMs ?? 0])).toEqual([
      [Date.UTC(2009, 9, 31, 2, 30), 2, 69 * minute],
      [Date.UTC(2009, 10, 1, 2, 30), 2, 11 * minute],
    ]);

    const rolledBackOnly = analyticsReport(
      store,
      usage,
      Date.UTC(2009, 10, 1, 2, 45),
      Date.UTC(2009, 10, 1, 2, 46),
      "America/St_Johns",
      to,
    );
    expect(rolledBackOnly.days.map((entry) => [entry.start, entry.wakes, entry.providers[0]?.awakeMs ?? 0])).toEqual([
      [Date.UTC(2009, 9, 31, 2, 30), 1, minute],
    ]);
  });
});

describe("admin /analytics endpoint", () => {
  test("returns distinct 400 messages for invalid time zone, oversized span, and invalid timestamps", async () => {
    const { store, usage } = setup();
    const admin = new Admin({
      network: { allows: async () => true },
      auth: { authenticated: () => true },
      store,
      usage,
    } as unknown as AdminDeps);
    const get = (query: string) =>
      admin.fetch(new Request(`http://127.0.0.1/admin/api/analytics?${query}`), { address: "127.0.0.1", secure: false });

    const badTz = await get(`from=${monday}&to=${monday + day}&tz=Mars/Olympus`);
    expect(badTz.status).toBe(400);
    expect(await badTz.json()).toEqual({ error: "Unknown time zone." });

    const pastFrom = Date.UTC(2024, 0, 1);
    const overSpan = await get(`from=${pastFrom}&to=${pastFrom + 367 * day}&tz=UTC`);
    expect(overSpan.status).toBe(400);
    expect(await overSpan.json()).toEqual({ error: "Time range exceeds the maximum analytics span." });

    const outOfBounds = await get(`from=-1e16&to=0&tz=UTC`);
    expect(outOfBounds.status).toBe(400);
    expect(await outOfBounds.json()).toEqual({ error: "Time range must use valid timestamps." });
  });
});

describe("turns from the shell", () => {
  test("each run is recorded once with its repository, agent and model", async () => {
    const store = new Store(openDatabase(":memory:"), testEncryption);
    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    let shell: (values: unknown[]) => void = () => {};
    const backend = {
      call: async () => ({ environment: { orchestrationProtocolVersion: 2 } }),
      request: (tag: string, _payload: unknown, handler: (frame: unknown) => void) => {
        if (tag === "orchestration.subscribeShell") shell = (values) => handler({ _tag: "Chunk", values });
        return () => {};
      },
    } as unknown as Backend;
    const fleet = Object.assign(new EventEmitter(), { backend: () => backend, touch: () => {} }) as unknown as Fleet;
    new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, { get: () => null, lastDisk: () => null });
    await fleet.onConnect("vm1", backend);

    const thread = (runId: string | undefined, updatedAt: string): Wire => ({
      id: "t1",
      projectId: "p1",
      providerInstanceId: "codex",
      modelSelection: { model: "gpt-5.5" },
      latestRunId: runId,
      updatedAt,
      // Message text is never read.
      title: "Fix the login page",
    });
    shell([{ kind: "snapshot", snapshot: { projects: [], threads: [thread(undefined, "2026-11-02T00:00:00Z")], archivedThreads: [] } }]);
    shell([{ kind: "thread.updated", thread: thread("r1", "2026-11-02T01:00:00Z"), location: "active", sequence: 2 }]);
    shell([{ kind: "thread.updated", thread: thread("r1", "2026-11-02T01:05:00Z"), location: "active", sequence: 3 }]);
    shell([{ kind: "thread.updated", thread: thread("r2", "2026-11-02T02:00:00Z"), location: "active", sequence: 4 }]);
    expect(store.turns(0, Date.now())).toEqual([
      { threadId: "t1", runId: "r1", at: Date.UTC(2026, 10, 2, 1), vmId: "vm1", provider: "boxd", repo: "https://github.com/acme/app.git", agent: "codex", model: "gpt-5.5" },
      { threadId: "t1", runId: "r2", at: Date.UTC(2026, 10, 2, 2), vmId: "vm1", provider: "boxd", repo: "https://github.com/acme/app.git", agent: "codex", model: "gpt-5.5" },
    ]);
  });
});
