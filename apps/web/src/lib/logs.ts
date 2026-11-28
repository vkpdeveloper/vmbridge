import type { TrafficEvent } from "@vmbridge/contracts";

/** Identical requests in a row (T3 polls a lot) fold into one line with a count. */
export interface TrafficRow {
  first: TrafficEvent;
  last: TrafficEvent;
  count: number;
  totalMs: number;
  maxMs: number;
}

export const sameRequest = (a: TrafficEvent, b: TrafficEvent) =>
  a.kind === b.kind &&
  a.operation === b.operation &&
  a.clientId === b.clientId &&
  a.vmId === b.vmId &&
  a.provider === b.provider &&
  (a.status ?? "ok") === (b.status ?? "ok") &&
  (a.reason ?? "") === (b.reason ?? "");

export function foldTraffic(events: readonly TrafficEvent[]): TrafficRow[] {
  const rows: TrafficRow[] = [];
  for (const event of events) {
    const ms = event.durationMs ?? 0;
    const previous = rows.at(-1);
    if (previous && sameRequest(previous.last, event)) {
      previous.last = event;
      previous.count += 1;
      previous.totalMs += ms;
      previous.maxMs = Math.max(previous.maxMs, ms);
    } else {
      rows.push({ first: event, last: event, count: 1, totalMs: ms, maxMs: ms });
    }
  }
  return rows;
}
