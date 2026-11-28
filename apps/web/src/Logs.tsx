import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, File01Icon, LaptopIcon, PauseIcon, PlayIcon, Search01Icon } from "@hugeicons/core-free-icons";
import type { Overview, TrafficEvent } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { clock, duration, useTick } from "./api.ts";
import { Logo, ProviderLogo } from "./brand.tsx";
import { foldTraffic } from "./lib/logs.ts";

const kindBar: Record<TrafficEvent["kind"], string> = {
  rpc: "bg-primary",
  http: "bg-sky-500",
  provider: "bg-warning",
  system: "bg-faint",
};

const kindLabel: Record<TrafficEvent["kind"], string> = {
  rpc: "RPC",
  http: "HTTP",
  provider: "Provider",
  system: "System",
};

/** Slow requests stand out; fast ones stay quiet. */
function durationTone(ms: number) {
  if (ms >= 1000) return "text-destructive";
  if (ms >= 300) return "text-warning";
  return "text-muted-foreground";
}

const histogramBuckets = 40;
const histogramSpanMs = 10 * 60_000;

function Histogram({ events, now }: { events: TrafficEvent[]; now: number }) {
  const bucketMs = histogramSpanMs / histogramBuckets;
  const start = now - histogramSpanMs;
  const buckets = Array.from({ length: histogramBuckets }, () => ({ ok: 0, error: 0 }));
  for (const event of events) {
    if (event.at < start) continue;
    const bucket = buckets[Math.min(histogramBuckets - 1, Math.floor((event.at - start) / bucketMs))]!;
    if (event.status === "error") bucket.error += 1;
    else bucket.ok += 1;
  }
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.ok + bucket.error));
  return (
    <div className="flex flex-col gap-1 border-b px-4 pt-3 pb-2">
      <div className="flex h-12 items-end gap-[3px]">
        {buckets.map((bucket, index) => {
          const total = bucket.ok + bucket.error;
          return (
            <Tooltip key={index}>
              <TooltipTrigger asChild>
                <div className="flex h-full flex-1 flex-col justify-end">
                  {total > 0 ? (
                    <div className="flex flex-col overflow-hidden rounded-[2px]" style={{ height: `${Math.max(8, (total / peak) * 100)}%` }}>
                      {bucket.error > 0 && <div className="bg-destructive" style={{ flex: bucket.error }} />}
                      {bucket.ok > 0 && <div className="bg-primary/60" style={{ flex: bucket.ok }} />}
                    </div>
                  ) : (
                    <div className="h-px bg-border" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {clock(start + index * bucketMs).slice(0, 5)}: {bucket.ok} ok{bucket.error > 0 ? `, ${bucket.error} failed` : ""}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-faint">
        <span>10 min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

export function Logs({ overview, traffic }: { overview: Overview; traffic: TrafficEvent[] }) {
  const now = useTick(5_000);
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [paused, setPaused] = useState<TrafficEvent[] | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const clients = useMemo(() => new Map(overview.clients.map((client) => [client.id, client.name])), [overview.clients]);
  const vms = useMemo(() => new Map(overview.vms.map((vm) => [vm.id, vm])), [overview.vms]);
  const events = paused ?? traffic;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = events.filter((event) => {
      if (errorsOnly && event.status !== "error") return false;
      if (!needle) return true;
      const haystack = [event.operation, event.reason, event.provider, event.kind, clients.get(event.clientId ?? ""), vms.get(event.vmId ?? "")?.name].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
    return foldTraffic(shown);
  }, [events, query, errorsOnly, clients, vms]);

  // Follow new lines while the view is at the bottom, like a terminal.
  useLayoutEffect(() => {
    if (atBottom && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [rows, atBottom]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const failures = events.filter((event) => event.status === "error").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <InputGroup className="h-9 min-w-48 flex-1">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={1.75} />
          </InputGroupAddon>
          <InputGroupInput ref={search} placeholder="Filter by request, device or VM" value={query} onChange={(event) => setQuery(event.target.value)} />
          <InputGroupAddon align="inline-end" className="max-sm:hidden">
            <Kbd>/</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <ButtonGroup>
          <Button variant={errorsOnly ? "outline" : "secondary"} size="lg" className="h-9" onClick={() => setErrorsOnly(false)}>
            All
          </Button>
          <Button variant={errorsOnly ? "secondary" : "outline"} size="lg" className="h-9" onClick={() => setErrorsOnly(true)}>
            Errors
            {failures > 0 && <Badge variant="destructive">{failures}</Badge>}
          </Button>
        </ButtonGroup>
        <Button variant="outline" size="lg" className="h-9" onClick={() => setPaused(paused ? null : traffic)}>
          <HugeiconsIcon icon={paused ? PlayIcon : PauseIcon} data-icon="inline-start" strokeWidth={1.75} />
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>

      <Histogram events={events} now={now} />

      <div className="grid grid-cols-[3px_4.75rem_1fr_4.5rem] gap-x-3 border-b px-4 py-2 text-xs text-muted-foreground sm:grid-cols-[3px_6.5rem_11rem_1fr_5rem]">
        <span />
        <span>Time</span>
        <span className="max-sm:hidden">Source</span>
        <span>Request</span>
        <span className="text-right">Duration</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={list}
          className="h-full overflow-y-auto py-1 font-mono text-[12.5px]"
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
          }}
        >
          {rows.length === 0 && (
            <Empty className="h-full font-sans">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={File01Icon} strokeWidth={1.75} />
                </EmptyMedia>
                <EmptyTitle>{traffic.length === 0 ? "No requests yet" : "Nothing matches"}</EmptyTitle>
                <EmptyDescription>{traffic.length === 0 ? "Requests from T3 and VM work show up here as they happen." : "Try a different filter."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {rows.map((row) => {
            const { last } = row;
            const failed = last.status === "error";
            const vm = last.vmId ? vms.get(last.vmId) : undefined;
            const device = last.clientId ? clients.get(last.clientId) : undefined;
            const average = row.count > 0 ? Math.round(row.totalMs / row.count) : 0;
            return (
              <div
                key={row.first.id}
                className={cn(
                  "grid grid-cols-[3px_4.75rem_1fr_4.5rem] items-center gap-x-3 px-4 py-[5px] hover:bg-muted/60 sm:grid-cols-[3px_6.5rem_11rem_1fr_5rem]",
                  failed && "bg-destructive/8 hover:bg-destructive/12",
                )}
              >
                <span className={cn("h-4 rounded-full", failed ? "bg-destructive" : kindBar[last.kind])} title={kindLabel[last.kind]} />
                <span className="text-muted-foreground tabular-nums">
                  {clock(last.at).slice(0, 8)}
                  <span className="max-sm:hidden">{clock(last.at).slice(8)}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 font-sans text-[13px] text-muted-foreground max-sm:hidden">
                  {vm ? (
                    <>
                      <ProviderLogo id={vm.provider} className="size-4 rounded" />
                      <span className="truncate">{vm.name}</span>
                    </>
                  ) : last.provider ? (
                    <>
                      <ProviderLogo id={last.provider} className="size-4 rounded" />
                      <span className="truncate">{last.provider}</span>
                    </>
                  ) : device ? (
                    <>
                      <HugeiconsIcon icon={LaptopIcon} className="size-4 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">{device}</span>
                    </>
                  ) : (
                    <>
                      <Logo className="size-4 rounded" />
                      <span className="truncate">VM Bridge</span>
                    </>
                  )}
                </span>
                <span className={cn("flex min-w-0 items-center gap-2", failed ? "text-destructive" : "text-foreground")}>
                  {/* Phones wrap instead of cutting off, so a failure's reason stays readable. */}
                  <span className="min-w-0 break-words sm:truncate">
                    {last.operation}
                    {last.reason && `: ${last.reason}`}
                  </span>
                  {row.count > 1 && (
                    <Badge variant="secondary" className="shrink-0 font-mono font-normal">
                      ×{row.count}
                    </Badge>
                  )}
                  {vm && device && <span className="truncate font-sans text-[13px] text-faint max-sm:hidden">from {device}</span>}
                </span>
                <span className={cn("text-right tabular-nums", last.durationMs === undefined ? "text-faint" : durationTone(row.maxMs))}>
                  {last.durationMs === undefined ? "" : row.count > 1 ? duration(average) : duration(last.durationMs)}
                </span>
              </div>
            );
          })}
        </div>
        {!atBottom && rows.length > 0 && (
          <Button
            variant="secondary"
            size="lg"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg shadow-black"
            onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" })}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} data-icon="inline-start" strokeWidth={2} />
            Latest
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {events.length} requests{failures > 0 ? `, ${failures} failed` : ""}
        </span>
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", paused ? "bg-faint" : "bg-success")} />
          {paused ? "Paused" : "Streaming"}
        </span>
      </div>
    </div>
  );
}
