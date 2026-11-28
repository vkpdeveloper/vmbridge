import {
  providerIds,
  type AgentActivity,
  type AnalyticsDay,
  type AnalyticsReport,
  type Estimate,
  type ProviderActivity,
  type ProviderDay,
  type ProviderId,
  type RepoActivity,
  type SizeActivity,
  type VmSize,
} from "@vmbridge/contracts";
import { agentName } from "./gateway/agents.ts";
import { githubName } from "./gateway/repos.ts";
import { estimate } from "./pricing.ts";
import type { Store, VmEvent } from "./store.ts";
import type { Usage } from "./usage.ts";

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
/** Maximum span for daily buckets, keeping dayStarts bounded on wide ranges. */
export const maxAnalyticsSpanMs = 366 * dayMs;

function utcTimestamp(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

const minTimestampMs = utcTimestamp(100, 1, 1);
const maxTimestampMs = utcTimestamp(9999, 12, 31);

interface DaySegment {
  start: number;
  end: number;
  dayIndex: number;
}

function daySchedule(from: number, to: number, timeZone: string): { starts: number[]; segments: DaySegment[] } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError("Unknown time zone.");
    throw error;
  }
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < minTimestampMs ||
    from > maxTimestampMs ||
    to < minTimestampMs ||
    to > maxTimestampMs
  ) {
    throw new RangeError("Time range must use valid timestamps.");
  }
  if (from >= to) return { starts: [], segments: [] };
  if (to - from > maxAnalyticsSpanMs) {
    throw new RangeError("Time range exceeds the maximum analytics span.");
  }
  // Local calendar date (UTC midnight) and UTC offset at `ms` (floored to whole seconds).
  const inspect = (ms: number) => {
    const sec = Math.floor(ms / 1000) * 1000;
    const values = Object.fromEntries(format.formatToParts(sec).map((part) => [part.type, Number(part.value)]));
    const day = utcTimestamp(values.year!, values.month!, values.day!);
    const local = utcTimestamp(values.year!, values.month!, values.day!, values.hour!, values.minute!, values.second!);
    return { day, offset: local - sec };
  };
  // Earliest instant strictly after `start` whose local calendar date differs from `startInfo.day`.
  // Fast path covers ordinary days and midnight spring-forwards; binary search locates offset transitions
  // inside the day, including midnight fall-backs that roll back into the previous calendar date.
  const segmentEnd = (start: number, startInfo = inspect(start)) => {
    let cur = Math.floor(start / 1000) * 1000;
    let info = startInfo;
    const { day } = info;
    for (;;) {
      const expected = day + dayMs - info.offset;
      if (inspect(expected - 1000).offset === info.offset) {
        const atExpected = inspect(expected);
        if (atExpected.day !== day) return { at: expected, next: atExpected };
        cur = expected;
        info = atExpected;
        continue;
      }
      let lo = cur / 1000;
      let hi = (expected - 1000) / 1000;
      while (lo + 1 < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (inspect(mid * 1000).offset === info.offset) lo = mid;
        else hi = mid;
      }
      const transition = hi * 1000;
      const atTransition = inspect(transition);
      if (atTransition.day !== day) return { at: transition, next: atTransition };
      cur = transition;
      info = atTransition;
    }
  };

  // Start well before `from` so we always see the earliest start of any local day that overlaps `[from, to)`,
  // even when a midnight fall-back splits a calendar date into two non-contiguous UTC segments.
  const firstStart = new Map<number, number>();
  const rawSegments: { start: number; end: number; day: number }[] = [];
  const overlappingDays = new Set<number>();

  let { at: cur, next: info } = segmentEnd(from - 3 * dayMs);
  while (cur < to) {
    const { day } = info;
    const { at: end, next } = segmentEnd(cur, info);
    if (!firstStart.has(day)) firstStart.set(day, cur);
    if (end > from) {
      overlappingDays.add(day);
      rawSegments.push({ start: cur, end, day });
    }
    cur = end;
    info = next;
  }

  const orderedDays = [...overlappingDays].sort((a, b) => a - b);
  const dayIndexByUtc = new Map(orderedDays.map((day, index) => [day, index]));
  return {
    starts: orderedDays.map((day) => firstStart.get(day)!),
    segments: rawSegments.map(({ start, end, day }) => ({ start, end, dayIndex: dayIndexByUtc.get(day)! })),
  };
}

/**
 * The start of each calendar day in `timeZone` that overlaps `[from, to)`.
 * Throws a RangeError for an unknown time zone, invalid timestamps, or a span over `maxAnalyticsSpanMs`.
 */
export function dayStarts(from: number, to: number, timeZone: string): number[] {
  return daySchedule(from, to, timeZone).starts;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const add = (a: Estimate, b: Estimate): Estimate => ({ amount: a.amount + b.amount, partial: a.partial || b.partial });

/**
 * VM time, spend, lifecycle, turns and errors from `from` to `until` (which ends at `now` at the latest), by day in
 * `timeZone` where it helps. Time and spend come from `usage`, so they match the Costs tab.
 */
export function analyticsReport(store: Store, usage: Usage, from: number, until: number, timeZone: string, now = Date.now()): AnalyticsReport {
  const to = Math.min(until, now);
  const { starts, segments } = daySchedule(from, to, timeZone);
  const days = starts.map(
    (start): AnalyticsDay & { threadIds: Set<string>; byProvider: Map<ProviderId, ProviderDay>; errorCounts: Map<ProviderId | null, number> } => ({
      start,
      providers: [],
      created: 0,
      deleted: 0,
      wakes: 0,
      sleeps: 0,
      threads: 0,
      turns: 0,
      errors: [],
      threadIds: new Set(),
      byProvider: new Map(),
      errorCounts: new Map(),
    }),
  );
  const segmentIndex = (ms: number) => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (segments[mid]!.start <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const dayIndex = (ms: number) => (segments.length ? segments[segmentIndex(ms)]!.dayIndex : -1);

  // VM time, split at local-date segment boundaries.
  const sizes = new Map<string, { provider: ProviderId; size: VmSize; vms: Set<string>; awakeMs: number }>();
  for (const interval of usage.intervals(from, to, now)) {
    const sizeKey = `${interval.provider}:${interval.size}`;
    const size = sizes.get(sizeKey) ?? { provider: interval.provider, size: interval.size, vms: new Set(), awakeMs: 0 };
    sizes.set(sizeKey, size);
    size.vms.add(interval.vmId);
    if (interval.state === "awake") size.awakeMs += interval.endedAt - interval.startedAt;

    if (!segments.length) continue;
    for (let index = segmentIndex(interval.startedAt); index < segments.length; index++) {
      const segment = segments[index]!;
      const start = Math.max(interval.startedAt, segment.start);
      const end = Math.min(interval.endedAt, segment.end);
      if (end <= start) break;
      const day = days[segment.dayIndex]!;
      const awakeMs = interval.state === "awake" ? end - start : 0;
      const asleepMs = interval.state === "asleep" ? end - start : 0;
      const part = estimate(interval.provider, interval.size, awakeMs, asleepMs);
      const previous = day.byProvider.get(interval.provider);
      day.byProvider.set(
        interval.provider,
        previous
          ? { provider: interval.provider, awakeMs: previous.awakeMs + awakeMs, asleepMs: previous.asleepMs + asleepMs, estimate: add(previous.estimate, part) }
          : { provider: interval.provider, awakeMs, asleepMs, estimate: part },
      );
    }
  }

  const events = store.vmEvents(from, to);
  for (const event of events) {
    const day = days[dayIndex(event.at)];
    if (!day) continue;
    if (event.kind === "create") day.created++;
    else if (event.kind === "delete") day.deleted++;
    else if (event.kind === "wake") day.wakes++;
    else if (event.kind === "sleep") day.sleeps++;
  }

  const turns = store.turns(from, to);
  const repoTurns = new Map<string, { threads: Set<string>; turns: number }>();
  const agentTurns = new Map<string, AgentActivity & { threadIds: Set<string> }>();
  for (const turn of turns) {
    const day = days[dayIndex(turn.at)];
    if (day) {
      day.turns++;
      day.threadIds.add(turn.threadId);
    }
    if (turn.repo) {
      const repo = githubName(turn.repo) ?? turn.repo;
      const entry = repoTurns.get(repo) ?? { threads: new Set(), turns: 0 };
      entry.threads.add(turn.threadId);
      entry.turns++;
      repoTurns.set(repo, entry);
    }
    const agent = turn.agent ? agentName(turn.agent) : "Unknown";
    const agentKey = `${agent}\n${turn.model ?? ""}`;
    const entry = agentTurns.get(agentKey) ?? { agent, model: turn.model, threads: 0, turns: 0, threadIds: new Set() };
    entry.threadIds.add(turn.threadId);
    entry.turns++;
    agentTurns.set(agentKey, entry);
  }

  for (const error of store.errorsIn(from, to)) {
    const counts = days[dayIndex(error.at)]?.errorCounts;
    if (!counts) continue;
    counts.set(error.provider, (counts.get(error.provider) ?? 0) + 1);
  }

  const costs = usage.report(from, to, now);
  const repos = new Map<string, RepoActivity>(costs.repos.map((repo) => [repo.repo, { repo: repo.repo, awakeMs: repo.awakeMs, threads: 0, turns: 0 }]));
  for (const [repo, entry] of repoTurns) {
    repos.set(repo, { repo, awakeMs: repos.get(repo)?.awakeMs ?? 0, threads: entry.threads.size, turns: entry.turns });
  }

  const providers = providerIds.flatMap((provider): ProviderActivity[] => {
    const own = events.filter((event) => event.provider === provider);
    const used = costs.providers.some((entry) => entry.provider === provider);
    if (!own.length && !used) return [];
    const of = (kind: VmEvent["kind"]) => own.filter((event) => event.kind === kind);
    const timed = (kind: VmEvent["kind"]) => median(of(kind).flatMap((event) => (event.durationMs === null ? [] : [event.durationMs])));
    return [{
      provider,
      created: of("create").length,
      deleted: of("delete").length,
      wakes: of("wake").length,
      sleeps: of("sleep").length,
      createMs: timed("create"),
      startMs: timed("start"),
      wakeMs: timed("wake"),
    }];
  });

  return {
    from,
    to,
    days: days.map(({ threadIds, byProvider, errorCounts, ...day }) => ({
      ...day,
      providers: providerIds.flatMap((provider) => byProvider.get(provider) ?? []),
      threads: threadIds.size,
      errors: [...errorCounts].map(([provider, count]) => ({ provider, count })),
    })),
    providers,
    sizes: [...sizes.values()]
      .map(({ vms, ...size }): SizeActivity => ({ ...size, vms: vms.size }))
      .sort((a, b) => b.awakeMs - a.awakeMs),
    repos: [...repos.values()].sort((a, b) => b.awakeMs - a.awakeMs || b.turns - a.turns),
    agents: [...agentTurns.values()].map(({ threadIds, ...entry }) => ({ ...entry, threads: threadIds.size })).sort((a, b) => b.turns - a.turns),
    snapshots: costs.snapshots,
    threads: new Set(turns.map((turn) => turn.threadId)).size,
    total: costs.total,
  };
}
