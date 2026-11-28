import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { agentKinds, providerIds, type AnalyticsDay, type AnalyticsReport, type Overview, type ProviderActivity, type ProviderId } from "@vmbridge/contracts";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { api, useTick } from "./api.ts";
import { AgentLogo, ProviderLogo } from "./brand.tsx";
import { Bars, days, hours, money, Rows, Tile, type Range } from "./Costs.tsx";
import { usageWindow } from "./lib/costs.ts";
import { Section } from "./Page.tsx";

/** One fixed color per provider, so a provider keeps its color in every chart and range. */
const providerColors: Record<ProviderId, string> = {
  boat: "#3987e5",
  boxd: "#d95926",
  daytona: "#199e70",
  e2b: "#c98500",
  freestyle: "#d55181",
  instabox: "#0ca30c",
  kubi: "#4ca464",
  railway: "#9085e9",
  superserve: "#e66767",
};
const otherColor = "#5c5c5c";

export function Analytics({ overview, range }: { overview: Overview; range: Range }) {
  const { monthStart } = overview.budget;
  const windowKey = range === "month" ? `${range}:${monthStart}` : range;
  return <AnalyticsView key={windowKey} overview={overview} range={range} monthStart={monthStart} />;
}

function AnalyticsView({ overview, range, monthStart }: { overview: Overview; range: Range; monthStart: number }) {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Awake time adds up while the page is open, and a VM waking or sleeping changes it.
  const tick = useTick(60_000);
  const fleet = overview.vms.map((vm) => `${vm.id}:${vm.state}`).join();

  useEffect(() => {
    let cancelled = false;
    const { from, to } = usageWindow(range, Date.now(), monthStart);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api<AnalyticsReport>(`/analytics?from=${from}&to=${to}&tz=${encodeURIComponent(timeZone)}`)
      .then((next) => !cancelled && (setReport(next), setError(null)))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [range, tick, fleet, monthStart]);

  const label = (id: ProviderId) => overview.providers.find((provider) => provider.id === id)?.label ?? id[0]!.toUpperCase() + id.slice(1);

  return (
    <>
      {error && <FieldError>{error}</FieldError>}
      {report ? <Report report={report} label={label} /> : !error && <p role="status" className="text-sm text-muted-foreground">Loading…</p>}
    </>
  );
}

function Report({ report, label }: { report: AnalyticsReport; label: (id: ProviderId) => string }) {
  const sum = (value: (day: AnalyticsDay) => number) => report.days.reduce((total, day) => total + value(day), 0);
  const awake = sum((day) => day.providers.reduce((total, provider) => total + provider.awakeMs, 0));
  const turns = sum((day) => day.turns);
  const errors = sum((day) => day.errors.reduce((total, entry) => total + entry.count, 0));
  const used = providerIds.filter((id) => report.days.some((day) => day.providers.some((provider) => provider.provider === id && provider.awakeMs > 0)));
  const spent = providerIds.filter((id) => report.days.some((day) => day.providers.some((provider) => provider.provider === id)));
  const errorProviders = [...new Set(report.days.flatMap((day) => day.errors.map((entry) => entry.provider)))];

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
        <Tile label="Estimated spend">{money(report.total)}</Tile>
        <Tile label="Awake">{hours(awake)}</Tile>
        <Tile label="VMs created">{sum((day) => day.created)}</Tile>
        <Tile label="Wakes">{sum((day) => day.wakes)}</Tile>
        <Tile label="Threads">{report.threads}</Tile>
        <Tile label="Turns">{turns}</Tile>
      </div>

      <Section title="Awake time">
        {used.length ? (
          <DayChart
            days={report.days}
            series={used.map((id) => ({ key: id, label: label(id), color: providerColors[id], value: (day) => day.providers.find((provider) => provider.provider === id)?.awakeMs ?? 0 }))}
            format={hours}
          />
        ) : (
          <Nothing>Awake hours per day, by provider, show here once a VM runs.</Nothing>
        )}
      </Section>

      {spent.length > 0 && (
        <Section title="Estimated spend">
          <DayChart
            days={report.days}
            series={spent.map((id) => ({
              key: id,
              label: label(id),
              color: providerColors[id],
              value: (day) => day.providers.find((provider) => provider.provider === id)?.estimate.amount ?? 0,
            }))}
            format={(amount) => money({ amount, partial: false })}
          />
        </Section>
      )}

      <Section title="Threads and turns">
        {turns ? (
          <DayChart
            days={report.days}
            series={[{ key: "turns", label: "Turns", color: "var(--primary)", value: (day) => day.turns }]}
            format={String}
            detail={(day) => (day.threads === 1 ? "1 thread" : `${day.threads} threads`)}
          />
        ) : (
          <Nothing>Turns per day show here once an agent works in a thread.</Nothing>
        )}
      </Section>

      <Section title="VMs">
        {report.providers.length ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {report.providers.map((provider) => (
              <Lifecycle key={provider.provider} activity={provider} label={label(provider.provider)} />
            ))}
          </div>
        ) : (
          <Nothing>VMs created, woken and put to sleep show here, with how long each took.</Nothing>
        )}
      </Section>

      <div className="grid items-start gap-10 xl:grid-cols-2">
        {report.sizes.length > 0 && (
          <Section title="Sizes">
            <Rows
              head={["Provider", "VMs", "Awake"]}
              rows={report.sizes.map((size) => ({
                key: `${size.provider}:${size.size}`,
                cells: [
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderLogo id={size.provider} className="size-5" />
                    <span className="truncate">
                      {label(size.provider)} <span className="text-muted-foreground capitalize">{size.size}</span>
                    </span>
                  </span>,
                  String(size.vms),
                  hours(size.awakeMs),
                ],
              }))}
            />
          </Section>
        )}

        <Section title="Repositories">
          {report.repos.length ? (
            <Bars
              rows={report.repos.map((repo) => ({
                key: repo.repo,
                title: <span className="truncate font-mono text-xs">{repo.repo}</span>,
                detail: `${count(repo.threads, "thread")}, ${count(repo.turns, "turn")}`,
                value: repo.awakeMs,
                figure: `${hours(repo.awakeMs)} awake`,
              }))}
            />
          ) : (
            <Nothing>Repositories show here once a VM holds one.</Nothing>
          )}
        </Section>

        <Section title="Agents and models">
          {report.agents.length ? (
            <Rows
              head={["Agent", "Threads", "Turns"]}
              rows={report.agents.map((agent) => {
                const kind = agentKinds.find((entry) => entry === agent.agent.toLowerCase());
                return {
                  key: `${agent.agent}:${agent.model}`,
                  cells: [
                    <span className="flex min-w-0 items-center gap-2">
                      {kind ? <AgentLogo agent={kind} className="size-5" /> : <span className="size-5 shrink-0 rounded-md bg-muted" />}
                      <span className="truncate">
                        {agent.agent} {agent.model && <span className="font-mono text-xs text-muted-foreground">{agent.model}</span>}
                      </span>
                    </span>,
                    String(agent.threads),
                    String(agent.turns),
                  ],
                };
              })}
            />
          ) : (
            <Nothing>Agents and models show here once a thread runs a turn.</Nothing>
          )}
        </Section>

        {report.snapshots.length > 0 && (
          <Section title="Snapshots">
            <Rows
              head={["Provider", "Kind", "Count", "Kept"]}
              rows={report.snapshots.map((snapshot) => ({
                key: `${snapshot.provider}:${snapshot.kind}`,
                cells: [
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderLogo id={snapshot.provider} className="size-5" />
                    <span className="truncate">{label(snapshot.provider)}</span>
                  </span>,
                  snapshot.kind === "base" ? "Base" : "Sleep",
                  String(snapshot.count),
                  days(snapshot.heldMs),
                ],
              }))}
            />
          </Section>
        )}
      </div>

      <Section title="Errors">
        {errors ? (
          <DayChart
            days={report.days}
            series={errorProviders.map((id) => ({
              key: id ?? "other",
              label: id ? label(id) : "Other",
              color: id ? providerColors[id] : otherColor,
              value: (day) => day.errors.find((entry) => entry.provider === id)?.count ?? 0,
            }))}
            format={String}
          />
        ) : (
          <Nothing>No errors in this range. Failed provider calls show here by day.</Nothing>
        )}
      </Section>
    </>
  );
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

function Nothing({ children }: { children: ReactNode }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={Analytics01Icon} strokeWidth={1.75} />
        </EmptyMedia>
        <EmptyTitle>Nothing yet</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Lifecycle({ activity, label }: { activity: ProviderActivity; label: string }) {
  const time = (ms: number | null) => (ms === null ? "-" : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${(ms / 60_000).toFixed(1)} min`);
  const stats = [
    ["Created", String(activity.created)],
    ["Deleted", String(activity.deleted)],
    ["Wakes", String(activity.wakes)],
    ["Sleeps", String(activity.sleeps)],
    ["Typical create", time(activity.createMs)],
    ["Typical first start", time(activity.startMs)],
    ["Typical wake", time(activity.wakeMs)],
  ] as const;
  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4">
      <span className="flex items-center gap-2.5 font-medium">
        <ProviderLogo id={activity.provider} />
        {label}
      </span>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
        {stats.map(([name, value]) => (
          <div key={name} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface Series {
  key: string;
  label: string;
  color: string;
  value: (day: AnalyticsDay) => number;
}

const dayLabel = (start: number) => new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Stacked bars, one per day. Hovering or tapping a day shows its numbers. */
function DayChart({ days, series, format, detail }: { days: AnalyticsDay[]; series: Series[]; format: (value: number) => string; detail?: (day: AnalyticsDay) => string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const totals = days.map((day) => series.reduce((total, entry) => total + entry.value(day), 0));
  const max = Math.max(...totals);
  const shown = hovered === null ? null : days[hovered];
  // Labels at the ends, and the middle when there is room.
  const ticks = days.length > 6 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, index) => index);

  return (
    <div className="flex flex-col gap-3">
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {series.map((entry) => (
            <span key={entry.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <div className="flex items-baseline justify-between text-xs text-muted-foreground tabular-nums">
          <span>{format(max)}</span>
        </div>
        <div className="mt-1 flex h-36 items-end gap-0.5 border-b border-border sm:gap-1 xl:h-48" onPointerLeave={() => setHovered(null)}>
          {days.map((day, index) => (
            <button
              key={day.start}
              type="button"
              aria-label={`${dayLabel(day.start)}: ${format(totals[index]!)}`}
              className={cn("flex h-full min-w-0 flex-1 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] outline-none", hovered === index && "bg-muted/60")}
              onPointerEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
              onClick={() => setHovered(index)}
            >
              {series.map((entry) => {
                const value = entry.value(day);
                if (!value || !max) return null;
                return <span key={entry.key} className="w-full shrink-0 last:rounded-t-[4px]" style={{ height: `${(value / max) * 100}%`, background: entry.color, minHeight: 2 }} />;
              })}
            </button>
          ))}
        </div>
        <div className="relative mt-1.5 h-4 text-xs text-muted-foreground">
          {ticks.map((index) => (
            <span
              key={index}
              className="absolute whitespace-nowrap tabular-nums"
              style={
                index === 0
                  ? { left: 0 }
                  : index === days.length - 1
                    ? { right: 0 }
                    : { left: `${((index + 0.5) / days.length) * 100}%`, transform: "translateX(-50%)" }
              }
            >
              {dayLabel(days[index]!.start)}
            </span>
          ))}
        </div>
        {shown && hovered !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 flex min-w-36 flex-col gap-1 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
            style={
              hovered < days.length / 2
                ? { left: `${((hovered + 1) / days.length) * 100}%`, marginLeft: 4 }
                : { right: `${((days.length - hovered) / days.length) * 100}%`, marginRight: 4 }
            }
          >
            <span className="font-medium">{dayLabel(shown.start)}</span>
            {series.map((entry) => (
              <span key={entry.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {series.length > 1 && <span className="size-2 rounded-sm" style={{ background: entry.color }} />}
                  {entry.label}
                </span>
                <span className="tabular-nums">{format(entry.value(shown))}</span>
              </span>
            ))}
            {detail && <span className="text-muted-foreground">{detail(shown)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
