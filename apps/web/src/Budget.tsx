import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { BudgetStatus } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { api } from "./api.ts";
import { money } from "./Costs.tsx";
import { Section } from "./Page.tsx";

const share = (budget: BudgetStatus) => (budget.monthlyUsd ? budget.spent.amount / budget.monthlyUsd : 0);

/** Shown on every page from 80% of the monthly budget. */
export function BudgetBanner({ budget, onView }: { budget: BudgetStatus; onView: () => void }) {
  if (budget.level === "ok" || budget.monthlyUsd === null) return null;
  const limit = money({ amount: budget.monthlyUsd, partial: false });
  const over = budget.level === "over";
  return (
    <div
      role="status"
      className={cn(
        "mx-2 mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-sm sm:mr-3 sm:ml-14",
        over ? "border-destructive/40 bg-destructive/10" : "border-warning/40 bg-warning/10",
      )}
    >
      <span>
        {over ? `This month's ${limit} budget is used up` : `${Math.floor(share(budget) * 100)}% of this month's ${limit} budget is used`}
        {over && budget.stopAtLimit && ". New VMs and wakes are paused"}.
      </span>
      <Button variant="link" size="sm" className="h-auto p-0" onClick={onView}>
        View costs
      </Button>
    </div>
  );
}

/** The monthly budget on the Usage page's Costs tab: this month's spend against it, and its settings. */
export function BudgetSection({ budget: live }: { budget: BudgetStatus }) {
  // What a save returned, until the next overview brings the same.
  const [budget, setBudget] = useState(live);
  useEffect(() => setBudget(live), [live]);
  const [amount, setAmount] = useState(live.monthlyUsd === null ? "" : String(live.monthlyUsd));
  useEffect(() => setAmount(live.monthlyUsd === null ? "" : String(live.monthlyUsd)), [live.monthlyUsd]);
  const action = useAction();

  const save = (body: { monthlyUsd?: number | null; stopAtLimit?: boolean }) =>
    action.run(async () => setBudget(await api<BudgetStatus>("/budget", { method: "PUT", body })));
  const percent = Math.min(100, share(budget) * 100);

  return (
    <Section title="Budget">
      <div className="flex flex-col gap-5 rounded-xl border p-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-xs text-muted-foreground">Spent this month (estimate)</span>
            {budget.monthlyUsd !== null && <span className="text-xs text-muted-foreground tabular-nums">{Math.floor(share(budget) * 100)}%</span>}
          </div>
          <span className="text-xl font-semibold tabular-nums">
            {money(budget.spent)}
            {budget.monthlyUsd !== null && <span className="text-base font-normal text-muted-foreground"> of {money({ amount: budget.monthlyUsd, partial: false })}</span>}
          </span>
          {budget.monthlyUsd !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", budget.level === "over" ? "bg-destructive" : budget.level === "warning" ? "bg-warning" : "bg-primary")}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const value = amount.trim();
            void save({ monthlyUsd: value ? Number(value) : null }).then((ok) => ok && toast.success(value ? "Budget saved." : "Budget removed."));
          }}
        >
          <Field className="sm:max-w-56">
            <FieldLabel htmlFor="budget">Monthly budget</FieldLabel>
            <InputGroup className="h-9">
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput id="budget" type="number" min={0} step="any" inputMode="decimal" placeholder="None" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </InputGroup>
          </Field>
          <Button type="submit" variant="outline" size="lg" className="h-9 px-4 sm:w-auto" disabled={action.busy}>
            Save
          </Button>
        </form>

        <div className="flex items-center justify-between gap-4">
          <label htmlFor="budget-stop" className="flex flex-col gap-0.5 text-sm">
            Pause new VMs and wakes at the budget
            <span className="text-xs text-muted-foreground">VMs already running keep running. Nothing is deleted.</span>
          </label>
          <Switch
            id="budget-stop"
            checked={budget.stopAtLimit && budget.monthlyUsd !== null}
            disabled={action.busy || budget.monthlyUsd === null}
            onCheckedChange={(stopAtLimit) => void save({ stopAtLimit })}
          />
        </div>
        {action.error && <FieldError>{action.error}</FieldError>}
      </div>
    </Section>
  );
}
