import { createContext, useContext, type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getBezierPath,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useViewportStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Alert02Icon, Cancel01Icon, CenterFocusIcon, Delete02Icon, InformationCircleIcon, LaptopIcon, Message01Icon, Moon02Icon, PowerIcon, ZoomInIcon, ZoomOutIcon } from "@hugeicons/core-free-icons";
import { vmSizes, type BridgeUpdate, type ClientInfo, type Overview, type ProjectInfo, type ProviderId, type SessionAgent, type TrafficEvent, type Usage, type VmInfo, type VmSize, type VmState, type VmStats } from "@vmbridge/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ButtonGroup } from "@/components/ui/button-group";
import { Field, FieldLabel } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useAction } from "@/hooks/use-action";
import { sinceText } from "@/lib/devices";
import { cn } from "@/lib/utils";
import { ago, api, useTick } from "./api.ts";
import { AgentLogo, Logo, ProjectIcon, ProviderLogo } from "./brand.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { ConnectOpenCode, OpenCodeSessionItem } from "./OpenCode.tsx";
import { SessionStatus } from "./SessionStatus.tsx";

/** A connection animates while it carried a request this recently. */
const flowWindowMs = 8_000;

export const vmStates: Record<VmState, { label: string; dot: string; text: string }> = {
  provisioning: { label: "Creating", dot: "bg-primary", text: "text-primary" },
  starting: { label: "Starting", dot: "bg-primary", text: "text-primary" },
  ready: { label: "Online", dot: "bg-success", text: "text-success" },
  busy: { label: "Working", dot: "bg-warning", text: "text-warning" },
  sleeping: { label: "Asleep", dot: "bg-faint", text: "text-muted-foreground" },
  error: { label: "Error", dot: "bg-destructive", text: "text-destructive" },
  gone: { label: "Gone", dot: "bg-faint", text: "text-muted-foreground" },
};

type Flow = {
  /** Data is moving right now. */
  flowing: boolean;
  /** Both ends are up; drawn solid instead of dashed. */
  live: boolean;
};

type DeviceNode = Node<{ client: ClientInfo }, "device">;
type BridgeNode = Node<{ overview: Overview }, "bridge">;
type VmNode = Node<{ vm: VmInfo; projects: ProjectInfo[]; selected: boolean }, "vm">;
type EmptyNode = Node<{ label: string }, "empty">;
type FlowEdge = Edge<Flow, "flow">;

const hidden = "!opacity-0";

/**
 * On narrow screens the graph is one column, drawn like a tree: devices above the bridge, VMs
 * below, and every connection runs down the left edge. Left to right it would not fit a phone.
 */
const Stacked = createContext(false);
const narrowQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 639px)") : null;
const useNarrow = () =>
  useSyncExternalStore(
    (onChange) => {
      narrowQuery?.addEventListener("change", onChange);
      return () => narrowQuery?.removeEventListener("change", onChange);
    },
    () => narrowQuery?.matches ?? false,
  );
/** The stacked column's width: VM cards (300) indented by 48. */
const stackedWidth = 348;
/** Where the bridge's connections leave and arrive when stacked: near its left edge. */
const stackedHandle = { left: 20 };

function Status({ dot, text, label }: { dot: string; text: string; label: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-[13px]", text)}>
      <span className={cn("size-2 rounded-full", dot)} />
      {label}
    </span>
  );
}

function DeviceCard({ data }: NodeProps<DeviceNode>) {
  const { client } = data;
  return (
    <div className="flex w-64 items-center gap-3 rounded-xl border bg-card p-3.5">
      <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <HugeiconsIcon icon={LaptopIcon} className="size-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{client.name}</div>
        {client.connected ? (
          <Status dot="bg-success" text="text-success" label="Connected" />
        ) : (
          <span className="text-[13px] text-muted-foreground">
            {client.lastConnectedAt ? `Not connected since ${sinceText(client.lastConnectedAt, Date.now())}` : "Never connected"}
          </span>
        )}
      </div>
      <Handle type="source" position={useContext(Stacked) ? Position.Left : Position.Right} isConnectable={false} className={hidden} />
    </div>
  );
}

function BridgeCard({ data }: NodeProps<BridgeNode>) {
  const { overview } = data;
  const stacked = useContext(Stacked);
  return (
    <div className="w-72 rounded-xl border border-primary/40 bg-card shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_10%,transparent)]">
      <Handle type="target" position={stacked ? Position.Top : Position.Left} style={stacked ? stackedHandle : undefined} isConnectable={false} className={hidden} />
      <div className="flex items-center gap-3 p-3.5">
        <Logo className="size-9" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">VM Bridge</div>
          <div className="font-mono text-xs text-muted-foreground">v{overview.bridge.version}</div>
        </div>
      </div>
      {overview.bridge.update && <UpdateRow update={overview.bridge.update} />}
      {overview.providers.length === 0 && <div className="border-t px-3.5 py-2.5 text-[13px] text-muted-foreground">No provider yet</div>}
      <Handle type="source" position={stacked ? Position.Bottom : Position.Right} style={stacked ? stackedHandle : undefined} isConnectable={false} className={hidden} />
    </div>
  );
}

/** The new release's notice, and the way to it this runtime has. The page reloads once the new version runs (useLive). */
function UpdateRow({ update }: { update: BridgeUpdate }) {
  const action = useAction();
  const error = action.error ?? update.error;
  if (update.how === "command") {
    return (
      <div className="flex items-center gap-2 border-t py-1.5 pr-1.5 pl-3.5 text-[13px]">
        <div className="min-w-0 flex-1">
          <div>VM Bridge {update.version} is available</div>
          <code className="font-mono text-xs text-muted-foreground">vmbridge update</code>
        </div>
        <CopyButton value="vmbridge update" label="Copy command" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 border-t px-3.5 py-2.5 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{update.installing ? `Updating to ${update.version}...` : `VM Bridge ${update.version} is available`}</div>
        {update.how === "cloudflare" && <CloudflareUpdate version={update.version} />}
        {update.how === "dashboard" && !update.installing && (
          <Button size="sm" disabled={action.busy} onClick={() => void action.run(() => api("/update", { method: "POST", body: {} }))}>
            {error ? "Try again" : "Update"}
          </Button>
        )}
      </div>
      {error && !update.installing && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}

/** A Worker deploys from the user's own copy of the repository, so the update is a commit there. */
function CloudflareUpdate({ version }: { version: string }) {
  const commands = [
    "git clone https://github.com/YOUR-NAME/YOUR-REPOSITORY.git vmbridge-worker",
    "cd vmbridge-worker",
    `git fetch --no-tags https://github.com/vkpdeveloper/vmbridge.git refs/tags/v${version}`,
    "git read-tree -u --reset FETCH_HEAD",
    "git checkout HEAD -- wrangler.jsonc",
    `git commit -m "VM Bridge ${version}"`,
    "git push",
  ].join("\n");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          How to update
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Update to {version}</DialogTitle>
          <DialogDescription>
            This Worker deploys from your copy of VM Bridge on GitHub. Run these with your repository's address, keeping your wrangler.jsonc. Cloudflare
            deploys the push, and this page reloads within a few minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-start rounded-lg border bg-muted/40">
          <pre className="min-w-0 flex-1 overflow-x-auto p-3 font-mono text-xs leading-relaxed">{commands}</pre>
          <div className="p-1">
            <CopyButton value={commands} label="Copy commands" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** An agent's logo, or its first letter when VM Bridge has no logo for it. */
function AgentAvatar({ agent, className }: { agent: SessionAgent; className?: string }) {
  if (agent.kind) return <AgentLogo agent={agent.kind} bare className={className} />;
  return <span className={cn("grid shrink-0 place-items-center text-[11px] font-semibold text-muted-foreground", className)}>{agent.name.slice(0, 1).toUpperCase()}</span>;
}

/** Every agent with a session on a VM, once each, side by side: without tiles, overlapping logos would run together. */
function AgentStack({ agents }: { agents: SessionAgent[] }) {
  const unique = [...new Map(agents.map((agent) => [agent.kind ?? agent.name, agent])).values()];
  if (!unique.length) return null;
  return (
    <span className="flex items-center gap-1" title={unique.map((agent) => agent.name).join(", ")}>
      {unique.map((agent) => (
        <AgentAvatar key={agent.kind ?? agent.name} agent={agent} className="size-4" />
      ))}
    </span>
  );
}

function VmCard({ data }: NodeProps<VmNode>) {
  const { vm, projects, selected } = data;
  const state = vmStates[vm.state];
  const settling = vm.state === "provisioning" || vm.state === "starting";
  // Three rows at most, so every card keeps the height the layout spaces them by.
  const shown = projects.length > 3 ? projects.slice(0, 2) : projects;
  return (
    <div
      className={cn(
        "w-[300px] cursor-pointer rounded-xl border bg-card transition-[border-color,opacity]",
        selected ? "border-primary ring-1 ring-primary" : settling ? "border-dashed border-primary/60" : "hover:border-input",
        vm.state === "sleeping" && !selected && "opacity-60",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <div className="flex items-center gap-3 p-3.5">
        <ProviderLogo id={vm.provider} className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{vm.name}</div>
          <div className="truncate text-xs text-muted-foreground">{vm.sizeLabel}</div>
        </div>
        {vm.sessions.length > 0 && (
          <span className="flex shrink-0 items-center gap-2.5 self-start text-xs text-muted-foreground">
            <AgentStack agents={vm.sessions.flatMap((session) => (session.agent ? [session.agent] : []))} />
            <span className="flex items-center gap-1.5" title={`${vm.sessions.length} ${vm.sessions.length === 1 ? "session" : "sessions"}`}>
              <HugeiconsIcon icon={Message01Icon} className="size-3.5 text-faint" strokeWidth={1.75} />
              {vm.sessions.length}
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 pb-3 text-[13px] text-muted-foreground">
        {shown.map((project) => (
          <span key={project.id} className="flex min-w-0 items-center gap-2">
            <ProjectIcon icon={project.icon} />
            <span className="truncate">{project.title}</span>
            {project.vmIds.length > 1 && (
              <span className="ml-auto shrink-0 text-xs text-faint">
                VM {project.vmIds.indexOf(vm.id) + 1} of {project.vmIds.length}
              </span>
            )}
          </span>
        ))}
        {projects.length > shown.length && <span className="pl-6 text-faint">+{projects.length - shown.length} more</span>}
        {projects.length === 0 && <span className="text-faint">No repository yet</span>}
        {vm.state === "error" && vm.error && <p className="line-clamp-2 text-xs text-destructive">{vm.error}</p>}
        {vm.state !== "error" && vm.problem && <p className="line-clamp-2 text-xs text-destructive">{vm.problem}</p>}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-b-xl border-t px-3.5 py-2.5">
        <Status {...state} />
        {vm.stats?.highMemory ? (
          <span className="flex items-center gap-1.5 text-[13px] text-destructive" title={vm.stats.memory ? `${usage(vm.stats.memory)} used` : undefined}>
            <HugeiconsIcon icon={Alert02Icon} className="size-3.5" strokeWidth={2} />
            High memory
          </span>
        ) : vm.updatePending ? (
          <span className="text-[13px] text-muted-foreground" title={vm.state === "sleeping" ? "It gets the latest sign-ins and variables when it wakes." : "It gets the latest sign-ins and variables once nothing runs on it."}>
            Update pending
          </span>
        ) : (
          vm.skillsPending && (
            <span className="text-[13px] text-muted-foreground" title={vm.state === "sleeping" ? "It gets the latest skills and AGENTS.md when it wakes." : undefined}>
              Sync pending
            </span>
          )
        )}
      </div>
    </div>
  );
}

function EmptyCard({ data }: NodeProps<EmptyNode>) {
  return (
    <div className="flex w-64 items-center justify-center rounded-xl border border-dashed px-3 py-5 text-[13px] text-muted-foreground">
      {data.label}
      <Handle type="source" position={useContext(Stacked) ? Position.Left : Position.Right} isConnectable={false} className={hidden} />
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
    </div>
  );
}

const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A connection. While requests pass, dots travel along it in the direction the requests go. */
function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { flowing = false, live = false } = data ?? {};
  const dots = flowing && !reducedMotion ? 2 : 0;
  const seconds = 1.6;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: flowing ? "color-mix(in oklab, var(--primary) 55%, transparent)" : live ? "#3a3a3a" : "#262626",
          strokeWidth: flowing ? 1.75 : 1.25,
          strokeDasharray: live || flowing ? undefined : "5 5",
        }}
      />
      {Array.from({ length: dots }, (_, index) => (
        <circle key={index} r="3" fill="var(--primary)">
          <animateMotion dur={`${seconds}s`} begin={`${(index * seconds) / dots}s`} repeatCount="indefinite" path={path} />
        </circle>
      ))}
    </>
  );
}

const nodeTypes = { device: DeviceCard, bridge: BridgeCard, vm: VmCard, empty: EmptyCard };
const edgeTypes = { flow: FlowEdgeView };

function column(count: number, height: number, gap: number) {
  const total = count * height + (count - 1) * gap;
  return (index: number) => index * (height + gap) - total / 2;
}

const controlIcon = "size-[18px]";

/** Zoom controls, and a re-fit whenever cards come or go. */
function Controls({ fitKey }: { fitKey: string }) {
  const flow = useReactFlow();
  const stacked = useContext(Stacked);
  const width = useViewportStore((state) => state.width);
  // Stacked, the column is fitted to the width and shown from the top, below the New VM button.
  // Fitting its whole height would shrink the cards past reading.
  const fit = () =>
    void (stacked
      ? flow.setViewport({ x: 16, y: 72, zoom: Math.min(1, (width - 32) / stackedWidth) }, { duration: 300 })
      : flow.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }));
  useEffect(() => {
    const timer = setTimeout(fit, 50);
    return () => clearTimeout(timer);
  }, [fitKey, width]);
  const controls = [
    { label: "Zoom in", icon: ZoomInIcon, run: () => void flow.zoomIn({ duration: 200 }) },
    { label: "Zoom out", icon: ZoomOutIcon, run: () => void flow.zoomOut({ duration: 200 }) },
    { label: "Fit to screen", icon: CenterFocusIcon, run: fit },
  ];
  return (
    <Panel position="bottom-left" className="!m-4">
      <ButtonGroup orientation="vertical">
        {controls.map((control) => (
          <Tooltip key={control.label}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon-lg" className="size-9 bg-card" aria-label={control.label} onClick={control.run}>
                <HugeiconsIcon icon={control.icon} className={controlIcon} strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{control.label}</TooltipContent>
          </Tooltip>
        ))}
      </ButtonGroup>
    </Panel>
  );
}

export function Canvas({ overview, traffic, onPair }: { overview: Overview; traffic: TrafficEvent[]; onPair: () => void }) {
  const now = useTick(1_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<VmInfo | null>(null);
  const vm = overview.vms.find((entry) => entry.id === selected) ?? null;
  const narrow = useNarrow();
  // The nodes are rebuilt every tick. Without their measured sizes React Flow hides each card until it
  // measures it again, which waits for a paint; a window on another desktop gets none and stays blank.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});

  const { nodes, edges } = useMemo(() => {
    const recent = traffic.filter((event) => now - event.at < flowWindowMs && event.kind !== "system");
    const flow = (match: (event: TrafficEvent) => boolean) => ({ flowing: recent.some(match) });
    const nodes: Node[] = [];
    const edges: FlowEdge[] = [];
    const clients = overview.clients;
    // Stacked: devices from the top, the bridge under them, then VMs, indented so connections fit on the left.
    const deviceCount = Math.max(clients.length, 1);
    const bridgeTop = deviceCount * 84 + 24;
    // The bridge is taller while it says "No provider yet", so it is placed by its measured height.
    const bridgeHeight = sizes.bridge?.height ?? 66;
    const devicePosition = (index: number) => (narrow ? { x: 48, y: index * 84 } : { x: 0, y: column(deviceCount, 68, 20)(index) });
    const vmPosition = (index: number) => (narrow ? { x: 48, y: bridgeTop + bridgeHeight + 40 + index * 236 } : { x: 780, y: column(Math.max(overview.vms.length, 1), 190, 28)(index) });
    if (clients.length === 0) nodes.push({ id: "empty-devices", type: "empty", position: devicePosition(0), data: { label: "Pair a device to start" } });
    clients.forEach((client, index) => {
      nodes.push({ id: `device-${client.id}`, type: "device", position: devicePosition(index), data: { client } });
      edges.push({
        id: `edge-${client.id}`,
        source: `device-${client.id}`,
        target: "bridge",
        type: "flow",
        data: { ...flow((event) => event.clientId === client.id), live: client.connected },
      });
    });
    nodes.push({ id: "bridge", type: "bridge", position: narrow ? { x: 0, y: bridgeTop } : { x: 380, y: -bridgeHeight / 2 }, data: { overview } });
    if (overview.vms.length === 0) {
      const position = vmPosition(0);
      nodes.push({ id: "empty-vms", type: "empty", position: narrow ? position : { ...position, y: position.y + 60 }, data: { label: "VMs appear when work starts" } });
    }
    // A repository's VMs sit together, in the order it got them.
    const rank = (vm: VmInfo) => {
      const index = overview.projects.findIndex((project) => project.vmIds.includes(vm.id));
      return index < 0 ? [Infinity, 0] : [index, overview.projects[index]!.vmIds.indexOf(vm.id)];
    };
    const vms = overview.vms.map((vm) => ({ vm, rank: rank(vm) })).sort((a, b) => a.rank[0]! - b.rank[0]! || a.rank[1]! - b.rank[1]!);
    vms.forEach(({ vm: entry }, index) => {
      const projects = overview.projects.filter((project) => entry.projects.includes(project.id));
      const live = entry.state === "ready" || entry.state === "busy";
      const traffic = flow((event) => event.vmId === entry.id);
      nodes.push({ id: entry.id, type: "vm", position: vmPosition(index), data: { vm: entry, projects, selected: entry.id === selected } });
      edges.push({
        id: `edge-vm-${entry.id}`,
        source: "bridge",
        target: entry.id,
        type: "flow",
        data: { ...traffic, flowing: traffic.flowing || entry.state === "busy", live },
      });
    });
    return { nodes: nodes.map((node) => ({ ...node, measured: sizes[node.id] })), edges };
  }, [overview, traffic, now, selected, narrow, sizes]);

  return (
    <div className="relative h-full">
      <CanvasMenu overview={overview} target={overview.vms.find((entry) => entry.id === menuTarget) ?? null} onDetails={setSelected} onPair={onPair} onDelete={setDeleting}>
        <Stacked.Provider value={narrow}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              const measured = changes.getByType("dimensions").flatMap((change) => (change.dimensions ? [[change.id, change.dimensions] as const] : []));
              if (measured.length) setSizes((current) => ({ ...current, ...Object.fromEntries(measured) }));
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.5}
            onNodeClick={(_, node) => {
              if (node.type === "vm") setSelected(node.id === selected ? null : node.id);
              if (node.id === "empty-devices") onPair();
            }}
            onPaneClick={() => setSelected(null)}
            // Picks which menu opens; the right-click then reaches CanvasMenu's trigger.
            onNodeContextMenu={(_, node) => setMenuTarget(node.type === "vm" ? node.id : null)}
            onPaneContextMenu={() => setMenuTarget(null)}
            onEdgeContextMenu={() => setMenuTarget(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
            <Controls fitKey={`${nodes.length}-${narrow}`} />
            <Panel position="top-right" className="!m-4 flex flex-col items-end gap-2">
              <NewVm overview={overview} />
            </Panel>
          </ReactFlow>
        </Stacked.Provider>
      </CanvasMenu>
      {vm && <VmDetails key={vm.id} vm={vm} overview={overview} now={now} onClose={() => setSelected(null)} />}
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its disk and any work that is not pushed are lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                if (deleting.id === selected) setSelected(null);
                attempt(api(`/vms/${deleting.id}`, { method: "DELETE" }));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Shows a failed menu action as a toast, since a menu has nowhere to show it once closed. */
const attempt = (work: Promise<unknown>) => void work.catch((error: Error) => toast.error(error.message));

/** Right-click menu: VM actions on a VM card, canvas actions anywhere else. */
function CanvasMenu({
  overview,
  target,
  onDetails,
  onPair,
  onDelete,
  children,
}: {
  overview: Overview;
  target: VmInfo | null;
  onDetails: (id: string) => void;
  onPair: () => void;
  onDelete: (vm: VmInfo) => void;
  children: ReactNode;
}) {
  const awake = target?.state === "ready" || target?.state === "busy";
  const settling = target?.state === "provisioning" || target?.state === "starting";
  const create = (body: object) => attempt(api("/vms", { body }));
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="h-full">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {target ? (
          <>
            <ContextMenuLabel className="truncate">{target.name}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => onDetails(target.id)}>
              <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.75} />
              Details
            </ContextMenuItem>
            {(awake || target.state === "error") && (
              <ContextMenuItem onSelect={() => attempt(api(`/vms/${target.id}/sleep`, { body: {} }))}>
                <HugeiconsIcon icon={Moon02Icon} strokeWidth={1.75} />
                Sleep
              </ContextMenuItem>
            )}
            {!awake && (
              <ContextMenuItem disabled={settling} onSelect={() => attempt(api(`/vms/${target.id}/wake`, { body: {} }))}>
                <HugeiconsIcon icon={PowerIcon} strokeWidth={1.75} />
                Wake
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(target)}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
              Delete
            </ContextMenuItem>
          </>
        ) : (
          <>
            {overview.providers.length > 1 ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={1.75} />
                  New VM
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-44">
                  {overview.providers.map((provider) => (
                    <ContextMenuItem key={provider.id} disabled={provider.setup.state === "building"} onSelect={() => create({ provider: provider.id })}>
                      <ProviderLogo id={provider.id} className="size-4 rounded" />
                      {provider.label}
                      {provider.setup.state === "building" && <span className="ml-auto text-xs text-muted-foreground">Setting up</span>}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : (
              <ContextMenuItem disabled={!overview.providers.some((provider) => provider.setup.state !== "building")} onSelect={() => create({})}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={1.75} />
                New VM
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={onPair}>
              <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} />
              Pair a device
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Asks for the size first, and the provider too when there are several. */
function NewVm({ overview }: { overview: Overview }) {
  const create = useAction();
  const [picking, setPicking] = useState(false);
  const [provider, setProvider] = useState(overview.defaultProvider);
  const [picked, setSize] = useState(overview.settings.vmSize);
  // No VM can be created on a provider while it sets up.
  const ready = overview.providers.filter((entry) => entry.setup.state !== "building");
  const chosen = ready.find((entry) => entry.id === provider) ?? ready[0];
  const size = picked ?? chosen?.defaultSize;
  const make = (body: object) => void create.run(() => api("/vms", { body })).then((ok) => ok && setPicking(false));
  const blocked = !overview.setup.provider ? "Add a provider first" : ready.length ? undefined : "Setting up the provider";
  return (
    <>
      <Button
        variant="outline"
        size="lg"
        className="bg-card"
        disabled={create.busy || Boolean(blocked)}
        title={blocked}
        onClick={() => setPicking(!picking)}
      >
        <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
        New VM
      </Button>
      {picking && chosen && (
        <div className="flex w-64 flex-col gap-4 rounded-xl border bg-card p-3.5 shadow-sm">
          {overview.providers.length > 1 && (
            <Field>
              <FieldLabel htmlFor="new-vm-provider">Provider</FieldLabel>
              <Select value={chosen.id} onValueChange={(value) => setProvider(value as ProviderId)}>
                <SelectTrigger id="new-vm-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {overview.providers.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id} disabled={entry.setup.state === "building"}>
                      <ProviderLogo id={entry.id} className="size-4 rounded" />
                      {entry.label}
                      {entry.setup.state === "building" && <span className="text-muted-foreground">Setting up</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="new-vm-size">Size</FieldLabel>
            <Select value={size} onValueChange={(value) => setSize(value as VmSize)}>
              <SelectTrigger id="new-vm-size" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vmSizes.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    <span className="capitalize">{entry}</span>
                    <span className="text-muted-foreground">{chosen.sizes[entry]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button size="sm" disabled={create.busy} onClick={() => make({ provider: chosen.id, size })}>
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {create.error && <p className="max-w-64 text-right text-xs text-destructive">{create.error}</p>}
    </>
  );
}

/** Binary gigabytes, as providers size VMs. One decimal below 10 GB. */
function usage({ used, total }: Usage) {
  const digits = total < 10 * 2 ** 30 ? 1 : 0;
  return `${(used / 2 ** 30).toFixed(digits)} / ${(total / 2 ** 30).toFixed(digits)} GB`;
}

function Meter({ label, value, share, high }: { label: string; value: string; share: number; high?: boolean }) {
  const color = high || share >= 0.9 ? "bg-destructive" : share >= 0.75 ? "bg-warning" : "bg-success";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-6 text-[13px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate font-mono text-xs leading-5">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-accent">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }} />
      </div>
    </div>
  );
}

function Resources({ stats, now }: { stats: VmStats | null; now: number }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex justify-between gap-3 text-xs font-medium text-muted-foreground">
        Resources
        {stats && <span className="font-normal text-faint">Updated {ago(stats.at, now)}</span>}
      </h3>
      {stats ? (
        <div className="flex flex-col gap-3">
          {stats.memory && <Meter label="Memory" value={usage(stats.memory)} share={stats.memory.used / stats.memory.total} high={stats.highMemory} />}
          {stats.memoryPressure !== null && (
            <div className="flex items-baseline justify-between gap-6 text-[13px]">
              <span className="text-muted-foreground">Memory pressure</span>
              <span className={cn("font-mono text-xs leading-5", stats.memoryPressure >= 10 && "text-destructive")}>{stats.memoryPressure.toFixed(1)}%</span>
            </div>
          )}
          {stats.cpu && (
            <Meter
              label="CPU"
              value={`${Math.round(stats.cpu.usage * 100)}% of ${stats.cpu.cores} ${stats.cpu.cores === 1 ? "core" : "cores"}`}
              share={stats.cpu.usage}
            />
          )}
          {stats.disk && <Meter label="Disk" value={usage(stats.disk)} share={stats.disk.used / stats.disk.total} />}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">Measuring.</p>
      )}
    </section>
  );
}

/** A link that shows the VM's screen live. A new link stops pages open on the old one. */
function WatchLink({ vmId, url }: { vmId: string; url: string | null }) {
  const action = useAction();
  const change = (method: "POST" | "DELETE") => void action.run(() => api(`/vms/${vmId}/watch`, { method, body: method === "POST" ? {} : undefined }));
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Live screen</h3>
      {url ? (
        <Item variant="outline" size="sm">
          <ItemContent className="min-w-0">
            <a href={url} target="_blank" rel="noreferrer" className="truncate font-mono text-xs hover:underline">
              {url}
            </a>
          </ItemContent>
          <ItemActions>
            <CopyButton value={url} label="Copy link" />
          </ItemActions>
        </Item>
      ) : (
        <p className="text-[13px] text-muted-foreground">Off.</p>
      )}
      <div className="flex gap-2">
        {url ? (
          <>
            <Button variant="outline" size="sm" disabled={action.busy} onClick={() => change("POST")}>
              New link
            </Button>
            <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => change("DELETE")}>
              Turn off
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" disabled={action.busy} onClick={() => change("POST")}>
            Turn on
          </Button>
        )}
      </div>
      {action.error && <p className="text-xs text-destructive">{action.error}</p>}
    </section>
  );
}

function VmDetails({ vm, overview, now, onClose }: { vm: VmInfo; overview: Overview; now: number; onClose: () => void }) {
  const action = useAction();
  const projects = overview.projects.filter((project) => vm.projects.includes(project.id));
  const awake = vm.state === "ready" || vm.state === "busy";
  const settling = vm.state === "provisioning" || vm.state === "starting";
  const rows: [string, string][] = [
    ["Provider", vm.providerLabel],
    ["Size", vm.sizeLabel],
    ["Sandbox", vm.sandboxId ?? "Not created"],
    ["T3", vm.t3Version ?? "Not installed"],
    ["Created", ago(vm.createdAt, now)],
    ["Last activity", ago(vm.lastActivityAt, now)],
  ];
  if (vm.sleepsAt) rows.push(["Sleeps", vm.sleepsAt <= now ? "Soon" : `In ${Math.ceil((vm.sleepsAt - now) / 60_000)} min`]);
  // A fresh reading on open. It arrives through the overview, and the server never wakes a VM for it.
  useEffect(() => {
    if (awake) void api(`/vms/${vm.id}/stats`).catch(() => {});
  }, [vm.id, awake]);

  return (
    <aside className="absolute inset-x-2 bottom-2 z-10 flex max-h-[65%] flex-col rounded-xl border bg-card shadow-2xl shadow-black sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-3 sm:max-h-none sm:w-[400px]">
      <header className="flex items-center gap-3 p-4">
        <ProviderLogo id={vm.provider} className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{vm.name}</div>
          <Status {...vmStates[vm.state]} />
        </div>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate text-right font-mono text-xs leading-5">{value}</dd>
            </div>
          ))}
        </dl>
        {vm.error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[13px] text-destructive">{vm.error}</p>}
        {vm.state !== "error" && vm.problem && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[13px] text-destructive">{vm.problem}</p>
        )}
        {awake && <Resources stats={vm.stats} now={now} />}
        {vm.watchLink && <WatchLink vmId={vm.id} url={vm.watchLink.url} />}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Repositories</h3>
          {projects.length === 0 && <p className="text-[13px] text-muted-foreground">None yet. Clone one from T3.</p>}
          <ItemGroup className="gap-1.5">
            {projects.map((project) => (
              <Item key={project.id} variant="outline" size="sm">
                <ItemMedia>
                  <ProjectIcon icon={project.icon} className="size-5" />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>{project.title}</ItemTitle>
                  {project.branch && <ItemDescription className="font-mono text-xs">{project.branch}</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <ConnectOpenCode project={project} />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Sessions</h3>
          {vm.sessions.length + vm.openCodeSessions.length === 0 && <p className="text-[13px] text-muted-foreground">No sessions.</p>}
          <ItemGroup className="gap-1.5">
            {vm.sessions.map((session) => {
              const project = overview.projects.find((entry) => entry.id === session.projectId);
              return (
                <Item key={session.threadId} variant="outline" size="sm">
                  {project && (
                    <ItemMedia className="self-start pt-0.5" title={project.title}>
                      <ProjectIcon icon={project.icon} className="size-5" />
                    </ItemMedia>
                  )}
                  <ItemContent>
                    <ItemTitle className="w-full justify-between">
                      <span className="truncate">{session.title}</span>
                      <SessionStatus activity={session.activity} />
                    </ItemTitle>
                    <ItemDescription className="flex min-w-0 items-center gap-1.5 text-xs">
                      {session.agent && <AgentAvatar agent={session.agent} className="size-4" />}
                      <span className="truncate">{[session.agent?.name, session.model].filter(Boolean).join(" · ") || "No model"}</span>
                    </ItemDescription>
                  </ItemContent>
                </Item>
              );
            })}
            {vm.openCodeSessions.map((session) => (
              <OpenCodeSessionItem key={session.id} session={session} />
            ))}
          </ItemGroup>
        </section>
      </div>
      <Separator />
      <footer className="flex flex-col gap-2 p-4">
        <div className="flex gap-2">
          {(awake || vm.state === "error") && (
            <Button variant="outline" size="lg" className="flex-1" disabled={action.busy} onClick={() => void action.run(() => api(`/vms/${vm.id}/sleep`, { body: {} }))}>
              <HugeiconsIcon icon={Moon02Icon} data-icon="inline-start" strokeWidth={1.75} />
              Sleep
            </Button>
          )}
          {!awake && (
            <Button variant="outline" size="lg" className="flex-1" disabled={action.busy || settling} onClick={() => void action.run(() => api(`/vms/${vm.id}/wake`, { body: {} }))}>
              <HugeiconsIcon icon={PowerIcon} data-icon="inline-start" strokeWidth={1.75} />
              Wake
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="lg" className="flex-1" disabled={action.busy}>
                <HugeiconsIcon icon={Delete02Icon} data-icon="inline-start" strokeWidth={1.75} />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {vm.name}?</AlertDialogTitle>
                <AlertDialogDescription>Its disk and any work that is not pushed are lost.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void action.run(() => api(`/vms/${vm.id}`, { method: "DELETE" })).then((ok) => ok && onClose())}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </footer>
    </aside>
  );
}
