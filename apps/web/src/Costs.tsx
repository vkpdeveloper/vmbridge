import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { vmSizes, type Estimate, type ExchangeRate, type Overview, type ProviderPricing, type UsageReport } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { api, useTick } from "./api.ts";
import { ProviderLogo } from "./brand.tsx";
import { BudgetSection } from "./Budget.tsx";
import { rangeStart, ranges, usageWindow, type Range } from "./lib/costs.ts";
import { Section } from "./Page.tsx";

export { rangeStart, ranges, type Range };

export function Costs({ overview, range }: { overview: Overview; range: Range }) {
  const { monthStart } = overview.budget;
  const windowKey = range === "month" ? `${range}:${monthStart}` : range;
  return (
    <>
      <BudgetSection budget={overview.budget} />
      <CostsReport key={windowKey} overview={overview} range={range} monthStart={monthStart} />
    </>
  );
}

function CostsReport({ overview, range, monthStart }: { overview: Overview; range: Range; monthStart: number }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Awake VMs add up while the page is open, and a VM waking or sleeping changes what counts.
  const tick = useTick(60_000);
  const fleet = overview.vms.map((vm) => `${vm.id}:${vm.state}`).join();

  useEffect(() => {
    let cancelled = false;
    const { from, to } = usageWindow(range, Date.now(), monthStart);
    api<UsageReport>(`/usage?from=${from}&to=${to}`)
      .then((next) => !cancelled && (setReport(next), setError(null)))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [range, tick, fleet, monthStart]);

  const added = overview.providers.map((provider) => provider.id);

  return (
    <>
      {error && <FieldError>{error}</FieldError>}
      {report ? <Report report={report} added={added} /> : !error && <p role="status" className="text-sm text-muted-foreground">Loading…</p>}
    </>
  );
}

function Report({ report, added }: { report: UsageReport; added: string[] }) {
  const awake = report.providers.reduce((total, provider) => total + provider.awakeMs, 0);
  const asleep = report.providers.reduce((total, provider) => total + provider.asleepMs, 0);
  const asOf = report.prices[0]?.asOf;
  // Providers in use first, then the rest.
  const prices = [...report.prices].sort((a, b) => Number(added.includes(b.provider)) - Number(added.includes(a.provider)));
  const label = (id: string) => report.prices.find((price) => price.provider === id)?.label ?? id;

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
          <Tile label="Estimated spend" className="col-span-2 sm:col-span-1">
            {money(report.total)}
          </Tile>
          <Tile label="Awake">{hours(awake)}</Tile>
          <Tile label="Asleep">{hours(asleep)}</Tile>
        </div>
        <p className="text-xs text-muted-foreground">
          Estimate from each provider's published prices{asOf && ` as of ${day(asOf)}`}, at full use of each VM's size. Storage billed per GiB is not
          included{report.total.partial && ", and + marks sleep time on providers that don't publish its price"}.
          {report.prices.some((price) => price.currency === "EUR") && ` Euro prices convert at €1 = ${usd(report.eurUsd.rate)}, the European Central Bank rate of ${day(report.eurUsd.asOf)}.`}
        </p>
      </div>

      <div className="grid items-start gap-10 xl:grid-cols-2">
        {report.vms.length === 0 ? (
          <Empty className="border border-dashed xl:col-span-2">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Coins01Icon} strokeWidth={1.75} />
              </EmptyMedia>
              <EmptyTitle>No VM time yet</EmptyTitle>
              <EmptyDescription>Awake and sleeping time shows here once a VM starts.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Section title="Providers">
              <Rows
                head={["Provider", "Awake", "Asleep", "Estimate"]}
                rows={report.providers.map((provider) => ({
                  key: provider.provider,
                  cells: [
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderLogo id={provider.provider} className="size-5" />
                      <span className="truncate">{label(provider.provider)}</span>
                    </span>,
                    hours(provider.awakeMs),
                    hours(provider.asleepMs),
                    money(provider.estimate),
                  ],
                }))}
              />
            </Section>

            <Section title="VMs">
              <Bars
                rows={report.vms.map((vm) => ({
                  key: vm.vmId,
                  title: (
                    <>
                      {vm.name}
                      {vm.deleted && <Badge variant="secondary">Deleted</Badge>}
                    </>
                  ),
                  detail: `${label(vm.provider)}, ${vm.size}, asleep ${hours(vm.asleepMs)}`,
                  value: vm.awakeMs,
                  figure: `${hours(vm.awakeMs)} awake`,
                  extra: money(vm.estimate),
                }))}
              />
            </Section>

            {report.repos.length > 0 && (
              <Section title="Repositories">
                <Bars
                  rows={report.repos.map((repo) => ({
                    key: repo.repo,
                    title: <span className="truncate font-mono text-xs">{repo.repo}</span>,
                    detail: repo.vms === 1 ? "1 VM" : `${repo.vms} VMs`,
                    value: repo.awakeMs,
                    figure: `${hours(repo.awakeMs)} awake`,
                  }))}
                />
              </Section>
            )}
          </>
        )}

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

      <Section title="Prices">
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {prices.map((price) => (
            <PriceCard key={price.provider} price={price} eurUsd={report.eurUsd} />
          ))}
        </div>
      </Section>
    </>
  );
}

export function Tile({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-xl border p-4", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{children}</span>
    </div>
  );
}

/** A small table: the first column takes the room, the rest are right-aligned figures. */
export function Rows({ head, rows }: { head: string[]; rows: { key: string; cells: React.ReactNode[] }[] }) {
  const grid = "grid items-center gap-x-4 sm:gap-x-8";
  const columns = { gridTemplateColumns: `minmax(0,1fr) repeat(${head.length - 1}, minmax(0,auto))` };
  return (
    <div className="flex flex-col rounded-xl border text-sm">
      <div className={cn(grid, "border-b px-4 py-2 text-xs text-muted-foreground")} style={columns}>
        {head.map((cell, index) => (
          <span key={cell} className={cn(index > 0 && "text-right")}>
            {cell}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.key} className={cn(grid, "border-b px-4 py-2.5 last:border-b-0")} style={columns}>
          {row.cells.map((cell, index) => (
            <span key={index} className={cn(index > 0 && "text-right tabular-nums", index === 0 && "min-w-0")}>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Rows with a bar for each one's share of the largest. */
export function Bars({ rows }: { rows: { key: string; title: React.ReactNode; detail: string; value: number; figure: string; extra?: React.ReactNode }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 font-medium">{row.title}</span>
            <span className="shrink-0 tabular-nums">{row.extra ?? row.figure}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(row.value / max) * 100}%` }} />
          </div>
          <div className="flex justify-between gap-3 text-xs text-muted-foreground">
            <span className="truncate">{row.detail}</span>
            {row.extra !== undefined && <span className="shrink-0 tabular-nums">{row.figure}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function PriceCard({ price, eurUsd }: { price: ProviderPricing; eurUsd: ExchangeRate }) {
  const toUsd = price.currency === "EUR" ? eurUsd.rate : 1;
  // Prices in another currency keep the published figure, with the US dollar one beside it.
  const inUsd = (amount: number) => (toUsd === 1 ? null : `about ${perHour(amount * toUsd, "USD")}`);
  const rate = (amount: number | null) => {
    if (amount === null) return "Unknown";
    if (amount === 0) return "Free";
    const converted = inUsd(amount);
    return (
      <>
        {perHour(amount, price.currency)}/h
        {converted && <span className="block text-xs text-muted-foreground">{converted}</span>}
      </>
    );
  };
  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5 font-medium">
          <ProviderLogo id={price.provider} />
          {price.label}
        </span>
        <a href={price.source} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Prices as of {day(price.asOf)}
        </a>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-2 text-sm sm:gap-x-8">
        <span className="text-xs text-muted-foreground">Size</span>
        <span className="text-right text-xs text-muted-foreground">Running</span>
        <span className="text-right text-xs text-muted-foreground">Asleep</span>
        {vmSizes.map((size) => (
          <div key={size} className="contents">
            <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-1.5">
              <span className="capitalize">{size}</span>
              <span className="text-xs whitespace-nowrap text-muted-foreground">{price.machines[size]}</span>
            </span>
            <span className="text-right tabular-nums">{rate(price.runningHourly[size])}</span>
            <span className={cn("text-right tabular-nums", price.asleepHourly[size] === null && "text-muted-foreground")}>{rate(price.asleepHourly[size])}</span>
          </div>
        ))}
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Storage</dt>
        <dd>
          {price.storageGibMonth === null
            ? "Included or not published"
            : [`${perHour(price.storageGibMonth, price.currency)} per GiB-month`, inUsd(price.storageGibMonth)].filter(Boolean).join(", ")}
        </dd>
        <dt className="text-muted-foreground">Asleep</dt>
        <dd>{price.sleeping}</dd>
        <dt className="text-muted-foreground">Snapshots</dt>
        <dd>{price.snapshots}</dd>
        <dt className="text-muted-foreground">Plans</dt>
        <dd>{price.plans}</dd>
        {price.caveat && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd>{price.caveat}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function hours(ms: number) {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const value = minutes / 60;
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} h`;
}

export function days(ms: number) {
  const value = ms / 86_400_000;
  return value < 1 ? hours(ms) : `${value.toFixed(1)} d`;
}

const usd = (amount: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(amount);

export function money({ amount, partial }: Estimate) {
  const format = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const text = amount > 0 && amount < 0.01 ? `<${format.format(0.01)}` : format.format(amount);
  return partial ? `${text} +` : text;
}

/** Small unit prices keep enough digits to tell providers apart. */
function perHour(amount: number, currency: ProviderPricing["currency"]) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumSignificantDigits: 3 }).format(amount);
}

const day = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
