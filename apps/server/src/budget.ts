import type { BudgetStatus, Estimate } from "@vmbridge/contracts";
import type { Settings } from "./settings.ts";
import type { Usage } from "./usage.ts";

export interface BudgetSetting {
  monthlyUsd: number | null;
  stopAtLimit: boolean;
}

/** Validates a `PUT /budget` payload and clears `stopAtLimit` whenever no monthly budget is set. */
export function parseBudgetUpdate(
  current: BudgetSetting,
  input: Record<string, unknown>,
): { ok: true; value: BudgetSetting } | { ok: false; error: string } {
  let monthlyUsd = current.monthlyUsd;
  if (input.monthlyUsd !== undefined) {
    monthlyUsd = input.monthlyUsd === null ? null : Number(input.monthlyUsd);
    if (monthlyUsd !== null && !(Number.isFinite(monthlyUsd) && monthlyUsd > 0 && monthlyUsd <= 1_000_000)) {
      return { ok: false, error: "Enter a budget above $0, or leave it empty for none." };
    }
  }
  if (input.stopAtLimit !== undefined && typeof input.stopAtLimit !== "boolean") {
    return { ok: false, error: "Say whether to stop at the budget." };
  }
  const stopAtLimit = monthlyUsd !== null && ((input.stopAtLimit as boolean | undefined) ?? current.stopAtLimit);
  return { ok: true, value: { monthlyUsd, stopAtLimit } };
}

/** The share of the budget that shows a warning. */
export const warnAt = 0.8;

/** How long a spend estimate is reused. Checks run on every wake and early wake, and the spend moves slowly. */
const spendTtlMs = 60_000;

/** The start of `now`'s month in VM Bridge's time zone. */
export function monthStart(now: number) {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

const dollars = (amount: number) => `$${amount.toFixed(2)}`;

/** Thrown when new VMs and wakes are refused because the month's budget is spent. */
export class BudgetReached extends Error {}

/**
 * One monthly budget for all providers, checked against the same estimate the Usage page's Costs tab shows. It never stops or
 * deletes anything: at the limit, early wakes stop, and with `stopAtLimit` on, new VMs and wakes are refused too.
 */
export class Budget {
  private cached: { at: number; from: number; spent: Estimate } | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly usage: Pick<Usage, "report">,
  ) {}

  status(now = Date.now()): BudgetStatus {
    const { monthlyUsd, stopAtLimit } = this.settings.get("budget");
    const from = monthStart(now);
    const spent = this.spent(from, now);
    let level: BudgetStatus["level"] = "ok";
    if (monthlyUsd !== null && spent.amount >= monthlyUsd) level = "over";
    else if (monthlyUsd !== null && spent.amount >= monthlyUsd * warnAt) level = "warning";
    return { monthlyUsd, stopAtLimit, spent, monthStart: from, level };
  }

  private spent(from: number, now: number): Estimate {
    const cached = this.cached;
    if (cached && cached.from === from && now >= cached.at && now - cached.at < spendTtlMs) return cached.spent;
    const spent = this.usage.report(from, now, now).total;
    this.cached = { at: now, from, spent };
    return spent;
  }

  /** Why new VMs and wakes are refused now, or null when they are not. */
  refusal(now = Date.now()): string | null {
    const status = this.status(now);
    if (status.level !== "over" || !status.stopAtLimit || status.monthlyUsd === null) return null;
    return `VM Bridge reached this month's budget of ${dollars(status.monthlyUsd)}, so it is not starting or waking VMs. Raise the budget on the Usage page of the VM Bridge dashboard.`;
  }

  /** Early wakes are only a guess that a message follows, so they stop at the limit even without `stopAtLimit`. */
  allowsEarlyWake(now = Date.now()) {
    return this.status(now).level !== "over";
  }

  /** A short notice for T3 the first time it is asked in a month past 80% of the budget. Null otherwise. */
  notice(now = Date.now()): string | null {
    const status = this.status(now);
    if (status.level === "ok" || status.monthlyUsd === null || this.settings.get("budgetNoticeMonth") === status.monthStart) return null;
    this.settings.set("budgetNoticeMonth", status.monthStart);
    const budget = dollars(status.monthlyUsd);
    if (status.level === "over") return `VM Bridge: this month's ${budget} budget is used up.`;
    return `VM Bridge: ${Math.floor((status.spent.amount / status.monthlyUsd) * 100)}% of this month's ${budget} budget is used.`;
  }
}
