import { useEffect, useRef } from "react";
import { agents, providers, type Provider } from "@/lib/data";
import { useMedia } from "@/lib/hooks";
import { AgentLogo, Logo, ProviderLogo, T3Logo } from "./brand";

type VmView = "none" | "pick" | "creating" | "online" | "asleep" | "waking";

interface Step {
  title: string;
  body: string;
  /** Which wires carry traffic: devices to bridge, bridge to VM. */
  links: [boolean, boolean];
  paired: boolean;
  vm: VmView;
  log: (p: Provider) => string[];
}

export const steps: Step[] = [
  {
    title: "Run VM Bridge",
    body: "One file on your Mac or a Linux box. It keeps its data in ~/.vmbridge and serves a dashboard at /dashboard.",
    links: [false, false],
    paired: false,
    vm: "none",
    log: () => ["$ vmbridge", "VM Bridge 1.1.13 is running.", "  This machine        http://127.0.0.1:3774/dashboard"],
  },
  {
    title: "Choose a provider",
    body: "Paste a key for boxd, Instabox, Daytona, Boat, Railway, E2B, Freestyle, Superserve or Kubi in the dashboard. Pick a VM size and how long a VM may sit idle.",
    links: [false, false],
    paired: false,
    vm: "pick",
    log: (p) => [`Provider ${p.name} connected`, `Size: ${p.sizes[1]}`, "Sleep after 5 idle minutes"],
  },
  {
    title: "Pair T3 Code",
    body: "Create a link under Settings, Devices and paste it into T3 Code as a remote environment. Pair as many devices as you like.",
    links: [true, false],
    paired: true,
    vm: "none",
    log: () => ['Pairing link "MacBook" created', "MacBook paired", "iPhone paired"],
  },
  {
    title: "Open a project",
    body: "VM Bridge creates a VM for it, installs T3, Codex and Claude, and clones the repository.",
    links: [true, true],
    paired: true,
    vm: "creating",
    log: (p) => ["Creating a VM for Hello-World", "Installing T3, Codex and Claude", `vm-df9bca ready on ${p.name}`, "Cloned Hello-World"],
  },
  {
    title: "Work as usual",
    body: "Each request goes to the project's VM over one socket, and replies stream back. Calls the bridge can answer itself never leave your machine.",
    links: [true, true],
    paired: true,
    vm: "online",
    log: () => ["server.getConfig          bridge     1 ms", "filesystem.browse         vm-df9bca  160 ms", "orchestration.dispatch    vm-df9bca  streaming"],
  },
  {
    title: "Sleep when idle",
    body: "After the idle time you set, the VM sleeps and stops costing compute. Its threads stay readable from a saved copy.",
    links: [true, false],
    paired: true,
    vm: "asleep",
    log: (p) => ["Idle 5 min, sleeping vm-df9bca", `${p.name}: ${p.sleep.toLowerCase()}`, "thread read from saved copy  0.1 ms"],
  },
  {
    title: "Wake on send",
    body: "Send a message and the thread shows that the VM is waking. It is back in seconds, with your files where you left them.",
    links: [true, true],
    paired: true,
    vm: "waking",
    log: (p) => [`Waking vm-df9bca on ${p.name}`, "vm-df9bca online", "orchestration.dispatch    vm-df9bca  streaming"],
  },
];

const stepIndex = (vm: VmView) => steps.findIndex((s) => s.vm === vm);

/** Node centers in SVG units. Wide lays out left to right, narrow top to bottom. */
const layouts = {
  wide: { w: 1000, h: 320, mac: [140, 90], phone: [140, 230], bridge: [500, 150], vm: [840, 160], dot: 4.5 },
  narrow: { w: 1000, h: 1300, mac: [270, 120], phone: [730, 120], bridge: [500, 600], vm: [500, 1060], dot: 11 },
} as const;
type Layout = (typeof layouts)[keyof typeof layouts];
type Point = readonly [number, number];

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

function Wire({ d, active, motion, dot }: { d: string; active: boolean; motion: boolean; dot: number }) {
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={active ? "var(--primary)" : "#2a2a2a"}
        strokeOpacity={active ? 0.55 : 1}
        strokeWidth={1.5}
        strokeDasharray={active ? undefined : "4 6"}
        vectorEffect="non-scaling-stroke"
        className="transition-[stroke] duration-500"
      />
      {active && motion ? (
        <>
          {/* Requests go out in violet, replies come back in green. */}
          <circle r={dot} fill="var(--primary)">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
          </circle>
          <circle r={dot} fill="var(--success)">
            <animateMotion dur="2.1s" begin="-1s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={d} />
          </circle>
        </>
      ) : null}
    </>
  );
}

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

function Device({ name, paired, onClick }: { name: string; paired: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-2 rounded-xl border bg-card py-1.5 pr-3 pl-1.5 transition duration-500 enabled:hover:border-primary/50 ${paired ? "border-primary/40 shadow-[0_0_24px_-8px_var(--primary)]" : "opacity-50"}`}
    >
      <T3Logo className="size-7" />
      <span className="text-left leading-tight">
        <span className="block text-xs font-medium">{name}</span>
        <span className="block text-[10px] text-muted-foreground">{paired ? "Paired" : "Not paired"}</span>
      </span>
    </button>
  );
}

const vmStatus = {
  creating: { label: "Creating", dot: "bg-warning" },
  online: { label: "Online", dot: "bg-success" },
  asleep: { label: "Asleep", dot: "bg-faint" },
  waking: { label: "Waking", dot: "bg-warning" },
} as const;

function VmCard({ view, provider, onPick, onToggle, onProvider }: {
  view: VmView;
  provider: Provider;
  onPick?: (p: Provider) => void;
  onToggle?: () => void;
  onProvider?: () => void;
}) {
  if (view === "none") {
    return (
      <div className="grid h-20 w-44 place-items-center rounded-xl border border-dashed border-[#2a2a2a] text-xs text-faint sm:w-48">Project VM</div>
    );
  }

  if (view === "pick") {
    return (
      <div className="w-44 rounded-xl border border-primary/40 bg-card p-2 shadow-[0_0_30px_-10px_var(--primary)] sm:w-48" role="radiogroup" aria-label="Provider">
        <div className="mb-2 px-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">Provider</div>
        <div className="grid grid-cols-4 gap-1.5">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === provider.id}
              aria-label={p.name}
              title={p.name}
              onClick={() => onPick?.(p)}
              className={`rounded-lg p-0.5 transition ${p.id === provider.id ? "ring-2 ring-primary" : "opacity-50 hover:opacity-100"}`}
            >
              <ProviderLogo provider={p} className="size-full" />
            </button>
          ))}
        </div>
        <div className="mt-2 truncate px-0.5 text-xs">{provider.name}</div>
      </div>
    );
  }

  const status = vmStatus[view];
  const asleep = view === "asleep";
  return (
    <div
      className={`relative w-44 rounded-xl border bg-card p-2.5 text-left transition duration-500 sm:w-48 ${
        view === "online" ? "border-success/40 shadow-[0_0_30px_-10px_var(--success)]" : view === "asleep" ? "" : "border-warning/40 shadow-[0_0_30px_-10px_var(--warning)]"
      }`}
    >
      {asleep ? <span className="absolute -top-3 right-2 font-mono text-sm text-muted-foreground" aria-hidden>z<sup>z</sup></span> : null}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onProvider} title="Change provider" className="rounded-lg transition hover:ring-2 hover:ring-primary/60">
          <ProviderLogo provider={provider} className={`size-8 transition duration-500 ${asleep ? "opacity-40 grayscale" : ""}`} />
        </button>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-xs font-medium">Hello-World</div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className={`size-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        className="mt-2.5 flex w-full items-center gap-1.5 rounded-lg border bg-black/40 p-1.5 transition enabled:hover:border-primary/50"
        aria-label={asleep ? "Wake the VM" : "Put the VM to sleep"}
      >
        {[<T3Logo key="t3" className="size-6" />, ...agents.map((a) => <AgentLogo key={a.id} agent={a} className="size-6" />)].map((logo, i) => (
          <span
            key={`${view === "creating"}-${i}`}
            className={`transition duration-500 ${asleep ? "opacity-30 grayscale" : ""}`}
            style={view === "creating" ? { animation: `rise 400ms ${300 + i * 500}ms both` } : undefined}
          >
            {logo}
          </span>
        ))}
        <span className="ml-auto truncate pr-1 font-mono text-[10px] whitespace-nowrap text-faint">vm-df9bca</span>
      </button>
    </div>
  );
}

/** Your devices, VM Bridge and one project VM for a step. Everything on it is clickable. */
export function Stage({ index, onStep, provider, onPick, motion }: {
  index: number;
  onStep: (index: number) => void;
  provider: Provider;
  onPick: (p: Provider) => void;
  motion: boolean;
}) {
  const step = steps[index];
  const narrow = useMedia("(max-width: 767px)");
  const layout = narrow ? layouts.narrow : layouts.wide;
  const svg = useRef<SVGSVGElement>(null);
  const live = ["online", "asleep", "waking"].includes(step.vm);

  useEffect(() => {
    if (!svg.current) return;
    if (motion) svg.current.unpauseAnimations();
    else svg.current.pauseAnimations();
  }, [motion]);

  return (
    <div className="relative w-full" style={{ aspectRatio: `${layout.w} / ${layout.h}` }}>
      <svg ref={svg} viewBox={`0 0 ${layout.w} ${layout.h}`} className="absolute inset-0 size-full" aria-hidden>
        <Wire d={wire(layout.mac, layout.bridge, !narrow)} active={step.links[0]} motion={motion} dot={layout.dot} />
        <Wire d={wire(layout.phone, layout.bridge, !narrow)} active={step.links[0]} motion={motion} dot={layout.dot} />
        <Wire d={wire(layout.bridge, layout.vm, !narrow)} active={step.links[1]} motion={motion} dot={layout.dot} />
      </svg>

      <At point={layout.mac} layout={layout}>
        <Device name="MacBook" paired={step.paired} onClick={step.paired ? undefined : () => onStep(2)} />
      </At>
      <At point={layout.phone} layout={layout}>
        <Device name="iPhone" paired={step.paired} onClick={step.paired ? undefined : () => onStep(2)} />
      </At>

      <At point={layout.bridge} layout={layout}>
        <button
          type="button"
          onClick={() => onStep(0)}
          aria-label="VM Bridge"
          className="grid size-16 place-items-center rounded-2xl border border-primary/50 bg-card shadow-[0_0_40px_-6px_var(--primary)] transition hover:scale-105 sm:size-20"
        >
          <Logo className="size-10 sm:size-12" />
        </button>
        <div className="absolute top-full left-1/2 mt-2 -translate-x-1/2 text-center whitespace-nowrap">
          <div className="text-xs font-medium sm:text-sm">VM Bridge</div>
          <div className="font-mono text-[10px] text-muted-foreground">:3774</div>
        </div>
      </At>

      <At point={layout.vm} layout={layout}>
        <VmCard
          view={step.vm}
          provider={provider}
          onPick={onPick}
          onProvider={() => onStep(1)}
          onToggle={live ? () => onStep(step.vm === "asleep" ? stepIndex("waking") : stepIndex("asleep")) : undefined}
        />
      </At>
    </div>
  );
}
