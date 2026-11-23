"use client";

import { useEffect, useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { providers, type Provider, type ProviderId } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { Logo, ProviderLogo, T3Logo } from "./brand";
import { useSiteState } from "./SiteState";
import { Panel } from "./Window";

type VmState = "online" | "asleep" | "waking";

interface Vm {
  id: "a" | "b" | "c";
  project: string;
  providerId: ProviderId;
  state: VmState;
}

const initialVms: Vm[] = [
  { id: "a", project: "api-server", providerId: "boxd", state: "online" },
  { id: "b", project: "web-app", providerId: "instabox", state: "asleep" },
  { id: "c", project: "docs", providerId: "daytona", state: "online" },
];

/** The ids cover every provider, so the fallback is never taken. */
const providerOf = (id: ProviderId): Provider => providers.find((p) => p.id === id) ?? providers[0];

type Point = readonly [number, number];

/**
 * Node centers in SVG units. Wide lays out left to right; narrow stacks the nodes and
 * routes a vertical trunk down the left of the VM cards (`trunkX`) with a short
 * horizontal branch into each card's left edge (`cardX`).
 */
const layouts = {
  wide: {
    w: 1000,
    h: 360,
    devices: { mac: [140, 125], phone: [140, 235] },
    bridge: [500, 180],
    vms: { a: [840, 75], b: [840, 180], c: [840, 285] },
  },
  narrow: {
    w: 1000,
    h: 1520,
    devices: { mac: [270, 110], phone: [730, 110] },
    bridge: [500, 500],
    trunkX: 120,
    cardX: 240,
    vmY: { a: 960, b: 1170, c: 1380 },
  },
} as const;
type Layout = (typeof layouts)[keyof typeof layouts];

/** Narrow VM wire: bridge bottom, an arc left onto the trunk, down it, then the branch. */
const trunkWire = (id: Vm["id"], y: number) => {
  const i = { a: 0, b: 1, c: 2 }[id];
  const n = layouts.narrow;
  return `M500 580 C280 580 ${n.trunkX} 610 ${n.trunkX} ${640 + i * 28} L${n.trunkX} ${y} L${n.cardX} ${y}`;
};

function wire(from: Point, to: Point, wide: boolean) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (wide) {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  }
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

type WireKind = "active" | "asleep" | "waking";

const wireStyle: Record<WireKind, { stroke: string; strokeOpacity: number; dash?: string }> = {
  active: { stroke: "rgb(255 255 255 / 0.2)", strokeOpacity: 1 },
  asleep: { stroke: "rgb(255 255 255 / 0.12)", strokeOpacity: 1, dash: "3 6" },
  waking: { stroke: "var(--primary)", strokeOpacity: 0.6, dash: "3 6" },
};

/**
 * One wire between two nodes, with two packets moving along it while it carries traffic.
 * Packets are round-capped stubs so they stay circular when the SVG stretches
 * non-uniformly. Until `drawn`, solid wires hide behind a full-length dash and dashed
 * wires fade — the `.js`-gated CSS draws them in once the diagram enters view.
 */
function Wire({ d, kind, packets, drawn }: { d: string; kind: WireKind; packets: boolean; drawn: boolean }) {
  const style = wireStyle[kind];
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={style.stroke}
        strokeOpacity={style.strokeOpacity}
        strokeWidth={1}
        strokeDasharray={style.dash}
        pathLength={kind === "active" ? 1 : undefined}
        vectorEffect="non-scaling-stroke"
        className={`${kind === "active" ? "wire-draw" : "wire-fade"} ${drawn ? "wire-drawn" : ""}`}
      />
      {kind === "active" && packets ? (
        <>
          <path d="M0 0h0.01" fill="none" stroke="var(--primary)" strokeWidth={7} strokeLinecap="round" vectorEffect="non-scaling-stroke">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
          </path>
          <path d="M0 0h0.01" fill="none" stroke="rgb(255 255 255 / 0.7)" strokeWidth={7} strokeLinecap="round" vectorEffect="non-scaling-stroke">
            <animateMotion dur="2.1s" begin="-1s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={d} />
          </path>
        </>
      ) : null}
    </>
  );
}

/** Positions a node by its center, in percent of the diagram. */
function At({ point, layout, children }: { point: Point; layout: Layout; children: React.ReactNode }) {
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${(point[0] / layout.w) * 100}%`, top: `${(point[1] / layout.h) * 100}%` }}
    >
      {children}
    </div>
  );
}

/** A paired device, a pill with the T3 Code mark. `large` is the hero sizing. */
function Device({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-md bg-muted ${large ? "px-3.5 py-2.5" : "px-2.5 py-2"}`}>
      <T3Logo className={large ? "size-7" : "size-6"} />
      <span className={`font-medium ${large ? "text-sm" : "text-[13px]"}`}>{name}</span>
    </div>
  );
}

const stateLabel = (state: VmState) => copy.diagram[state];

/** State dot styles, shared with the lifecycle thread's VM chip and notices. */
export const stateDot: Record<VmState, string> = {
  online: "size-1.5 rounded-full bg-primary",
  asleep: "size-1.5 rounded-full ring-1 ring-white/40",
  waking: "size-1.5 animate-pulse rounded-full bg-primary",
};

/** One project VM. Clicking sleeps an online VM and wakes an asleep one. */
function VmNode({ vm, provider, narrow, onToggle }: { vm: Vm; provider: Provider; narrow: boolean; onToggle: () => void }) {
  const asleep = vm.state === "asleep";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${vm.project}: ${stateLabel(vm.state)}`}
      className={`${narrow ? "w-full max-w-60" : "w-52"} rounded-md bg-muted p-3 text-left transition-colors duration-150 hover:bg-white/10`}
    >
      <div className="flex items-center gap-2.5">
        <ProviderLogo provider={provider} className={`size-7 rounded-md ring-white/10 transition-opacity duration-200 ${asleep ? "opacity-50" : ""}`} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className={`truncate text-sm font-medium ${asleep ? "text-muted-foreground" : ""}`}>{vm.project}</div>
          <div className="truncate font-mono text-[13px] text-faint">{provider.name}</div>
        </div>
        <div className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-muted-foreground">
          <span className={stateDot[vm.state]} />
          {stateLabel(vm.state)}
        </div>
      </div>
    </button>
  );
}

interface LogRow {
  id: number;
  project: string;
  state: string;
  detail: string;
  animate: boolean;
}

const seedRows: LogRow[] = [
  { id: 0, project: "api-server", state: "online", detail: "boxd", animate: false },
  { id: 1, project: "web-app", state: "asleep", detail: "Instabox: pause, memory kept", animate: false },
  { id: 2, project: "docs", state: "online", detail: "Daytona", animate: false },
];

/**
 * The wiring diagram row: devices to VM Bridge to the project VMs, with the event log beside it.
 * `stacked` renders the single-column variant used inside the docs page's bordered box.
 * `log={false}` drops the events panel so the diagram takes the whole row.
 * `hero` fills its parent instead of using the fixed row heights, centres the diagram
 * at 72rem, and enlarges the device and bridge nodes for the landing hero stage.
 */
export function Topology({ stacked = false, log = true, hero = false }: { stacked?: boolean; log?: boolean; hero?: boolean }) {
  const [vms, setVms] = useState(initialVms);
  const [rows, setRows] = useState(seedRows);
  const nextRow = useRef(seedRows.length);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const inView = useInView(panel);
  const [wires, setWires] = useState(false);
  useEffect(() => {
    if (inView) setWires(true);
  }, [inView]);
  // Packets only start once the wires have drawn in, so traffic never runs on
  // a wire that is not there yet.
  const [flow, setFlow] = useState(false);
  useEffect(() => {
    if (!wires) return;
    if (reduced) {
      setFlow(true);
      return;
    }
    const timer = setTimeout(() => setFlow(true), 650);
    return () => clearTimeout(timer);
  }, [wires, reduced]);
  const packets = flow && !reduced && phase !== "asleep";
  const ring = !reduced && phase !== "asleep";
  const shown = stacked ? rows.slice(-3) : rows.slice(-8);

  const pushRow = (project: string, state: string, detail: string) =>
    setRows((list) => [...list, { id: nextRow.current++, project, state, detail, animate: true }].slice(-8));

  const toggle = (id: Vm["id"]) => {
    const vm = vms.find((v) => v.id === id);
    if (!vm || vm.state === "waking") return;
    const provider = providerOf(vm.providerId);
    const setState = (state: VmState) => setVms((list) => list.map((v) => (v.id === id ? { ...v, state } : v)));
    if (vm.state === "online") {
      setState("asleep");
      pushRow(vm.project, "asleep", `${provider.name}: ${provider.sleep.toLowerCase()}`);
      return;
    }
    setState("waking");
    pushRow(vm.project, "waking", `${provider.name}: ${provider.wake.toLowerCase()}`);
    timers.current.push(
      setTimeout(() => {
        setState("online");
        pushRow(vm.project, "online", provider.name);
      }, 1600),
    );
  };

  return (
    <div
      ref={panel}
      id="topology"
      className={
        hero ? "md:flex md:flex-1" : `grid grid-cols-[minmax(0,1fr)] ${stacked || !log ? "" : "lg:grid-cols-[minmax(0,1fr)_26rem]"}`
      }
    >
      <div className={hero ? "mx-auto w-full max-w-[72rem] md:flex md:min-h-0 md:flex-1 md:flex-col" : undefined}>
        {/* Both layouts render in the initial HTML; CSS picks one per viewport so
            phones never receive the desktop coordinates, even with JS disabled.
            `hidden` also keeps the other copy's buttons out of the a11y tree. */}
        <div className={`relative md:hidden ${hero ? "mx-auto max-w-[26rem]" : ""}`} style={{ aspectRatio: `${layouts.narrow.w} / ${layouts.narrow.h}` }}>
          <svg viewBox={`0 0 ${layouts.narrow.w} ${layouts.narrow.h}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
            <Wire d={wire(layouts.narrow.devices.mac, layouts.narrow.bridge, false)} kind="active" packets={packets} drawn={wires} />
            <Wire d={wire(layouts.narrow.devices.phone, layouts.narrow.bridge, false)} kind="active" packets={packets} drawn={wires} />
            {[...vms].reverse().map((vm) => (
              <Wire
                key={vm.id}
                d={trunkWire(vm.id, layouts.narrow.vmY[vm.id])}
                kind={vm.state === "online" ? "active" : vm.state}
                packets={packets}
                drawn={wires}
              />
            ))}
          </svg>

          <At point={layouts.narrow.devices.mac} layout={layouts.narrow}>
            <Device name="MacBook" />
          </At>
          <At point={layouts.narrow.devices.phone} layout={layouts.narrow}>
            <Device name="iPhone" />
          </At>
          <At point={layouts.narrow.bridge} layout={layouts.narrow}>
            <div className="flex flex-col items-center gap-1.5">
              <Logo className="size-12" />
              <span className="rounded bg-background px-1 font-mono text-[13px] text-faint">:3774</span>
            </div>
          </At>
          {vms.map((vm) => (
            <div
              key={vm.id}
              // Spans to the diagram's right edge so the card shrinks on very narrow screens.
              className="absolute right-0 -translate-y-1/2"
              style={{ left: `${(layouts.narrow.cardX / layouts.narrow.w) * 100}%`, top: `${(layouts.narrow.vmY[vm.id] / layouts.narrow.h) * 100}%` }}
            >
              <VmNode vm={vm} provider={providerOf(vm.providerId)} narrow onToggle={() => toggle(vm.id)} />
            </div>
          ))}
        </div>

        <div
          className={`relative hidden md:block ${
            hero ? "md:flex-1" : "h-[24rem] lg:h-[20rem] xl:h-[24rem] xl:short:h-[21rem]"
          }`}
        >
          <span className={`absolute ${hero ? "top-0" : "top-3"} left-[14%] -translate-x-1/2 font-mono text-[13px] text-faint`}>
            {copy.diagram.devices}
          </span>
          <span className={`absolute ${hero ? "top-0" : "top-3"} left-[50%] -translate-x-1/2 font-mono text-[13px] text-faint`}>
            {copy.diagram.bridge}
          </span>
          <span className={`absolute ${hero ? "top-0" : "top-3"} left-[84%] -translate-x-1/2 font-mono text-[13px] text-faint`}>
            {copy.diagram.vms}
          </span>
          <svg viewBox={`0 0 ${layouts.wide.w} ${layouts.wide.h}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
            <Wire d={wire(layouts.wide.devices.mac, layouts.wide.bridge, true)} kind="active" packets={packets} drawn={wires} />
            <Wire d={wire(layouts.wide.devices.phone, layouts.wide.bridge, true)} kind="active" packets={packets} drawn={wires} />
            {vms.map((vm) => (
              <Wire
                key={vm.id}
                d={wire(layouts.wide.bridge, layouts.wide.vms[vm.id], true)}
                kind={vm.state === "online" ? "active" : vm.state}
                packets={packets}
                drawn={wires}
              />
            ))}
          </svg>

          <At point={layouts.wide.devices.mac} layout={layouts.wide}>
            <Device name="MacBook" large={hero} />
          </At>
          <At point={layouts.wide.devices.phone} layout={layouts.wide}>
            <Device name="iPhone" large={hero} />
          </At>
          <At point={layouts.wide.bridge} layout={layouts.wide}>
            <div className="flex flex-col items-center gap-1.5">
              <div className="relative">
                {hero && ring ? (
                  <span
                    aria-hidden
                    className="absolute -inset-2 animate-[pulse-ring_3.4s_ease-out_infinite] rounded-full ring-2 ring-primary/30"
                  />
                ) : null}
                <Logo className={hero ? "size-16" : "size-12"} />
              </div>
              <span className="rounded bg-background px-1 font-mono text-[13px] text-faint">:3774</span>
            </div>
          </At>
          {vms.map((vm) => (
            <At key={vm.id} point={layouts.wide.vms[vm.id]} layout={layouts.wide}>
              <VmNode vm={vm} provider={providerOf(vm.providerId)} narrow={false} onToggle={() => toggle(vm.id)} />
            </At>
          ))}
        </div>
      </div>

      {log ? (
        <div className={stacked ? "border-t" : "border-t lg:border-t-0 lg:border-l"}>
          <Panel label="events" aside={copy.hero.hint}>
            <div aria-live="polite" className="p-6 font-mono text-[13px] leading-7 sm:px-8">
              {shown.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-4"
                  style={row.animate ? { animation: "rise 200ms both" } : undefined}
                >
                  <span className="whitespace-nowrap">{row.project}</span>
                  <span className="whitespace-nowrap text-muted-foreground">{row.state}</span>
                  <span className="min-w-0 text-faint">{row.detail}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
