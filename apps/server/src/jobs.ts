import type { Budget } from "./budget.ts";
import type { BoatSignIn } from "./providers/boat-sign-in.ts";
import type { Fleet } from "./fleet.ts";
import type { Hub } from "./gateway/hub.ts";
import type { Traffic } from "./traffic.ts";
import { heartbeatMs, type Usage } from "./usage.ts";
import type { Stats } from "./vm/stats.ts";
import type { Watch } from "./watch/watch.ts";

/** Work repeated on a schedule. Bun runs each on a timer (bun/jobs.ts); a Durable Object would run them from alarms. */
export interface Job {
  name: string;
  everyMs: number;
  run(): Promise<void>;
}

/** VM Bridge's periodic work. Each run handles its own failures. */
export function bridgeJobs(deps: { hub: Hub; fleet: Fleet; boat: BoatSignIn; stats: Stats; usage: Usage; budget: Budget; traffic: Traffic; watch: Watch }): Job[] {
  const { hub, fleet, boat, stats, usage, budget, traffic, watch } = deps;
  let budgetLevel = budget.status().level;
  return [
    {
      name: "idle sweep",
      everyMs: 15_000,
      run: () =>
        hub.sweep().catch((error) => {
          traffic.record({ kind: "system", operation: "idle sweep", status: "error", reason: error instanceof Error ? error.message : String(error) });
        }),
    },
    { name: "Codex sign-in refresh", everyMs: 60 * 60_000, run: () => fleet.syncCodexAuth().catch(() => {}) },
    // Hourly, so a restart never pushes it far past a day. It refreshes only a connection left unused for a day.
    {
      name: "Boat sign-in refresh",
      everyMs: 60 * 60_000,
      run: () =>
        boat.keepFresh().catch((error) => {
          traffic.record({ kind: "system", operation: "Boat sign-in refresh", status: "error", reason: error instanceof Error ? error.message : String(error) });
        }),
    },
    // Often enough for the dashboard's high memory warning; opening a VM's details reads it right away.
    { name: "VM stats", everyMs: 30_000, run: () => stats.sampleAll().catch(() => {}) },
    {
      name: "usage heartbeat",
      everyMs: heartbeatMs,
      run: async () => {
        usage.sync(Date.now(), true);
        // Spend grows while VMs are awake with nothing else changing, so the dashboard's budget banner needs a nudge.
        const level = budget.status().level;
        if (level === budgetLevel) return;
        budgetLevel = level;
        fleet.emit("changed");
      },
    },
    // Follows VM Bridge's address, such as a quick tunnel's new one, into the watch links VMs have.
    { name: "watch links", everyMs: 30_000, run: () => watch.refresh() },
  ];
}
