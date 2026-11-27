import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { AgentFeedbackMode } from "@vmbridge/contracts";
import { median } from "../analytics.ts";
import type { Budget } from "../budget.ts";
import { providers } from "../providers/index.ts";
import { mayBeAwake, message, type Fleet } from "../fleet.ts";
import { labelVcpus, type VmLoad } from "../placement.ts";
import type { Settings } from "../settings.ts";
import { sleep } from "../runtime.ts";
import { primaryVm, type ProjectRow, type Store, type VmRow } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import { T3Rejected, type Backend, type Frame } from "../vm/backend.ts";
import type { Stats } from "../vm/stats.ts";
import { defaultAgents, pendingAgent, presentAgent, type AgentReport } from "./agents.ts";
import { Attachments, maxUploadBytes } from "./attachments.ts";
import type { FileTrees, Worktree } from "./files.ts";
import { applyHeldCommand, nextTurnCommandTypes } from "./held.ts";
import { ProjectIcons } from "./icons.ts";
import { isPathKey, projectForPath, projectRoot, translate, vmForPath, within, type Environments } from "./paths.ts";
import { repositoryIdentity } from "./repos.ts";
import { threadStamp } from "./saved.ts";
import {
  hasLiveWork,
  isWorking,
  str,
  threadsOf,
  type Projection,
  type ProviderEntry,
  type Row,
  type ScheduledTasks,
  type ServerConfig,
  type Shell,
  type ShellItem,
  type Wire,
} from "./types.ts";

type HubEvents = {
  shell: [];
  config: [];
  scheduledTasks: [];
  clones: [];
  /** Worktree setup progress changed for a thread. */
  setup: [threadId: string];
  /** The "waking the VM" notice changed for a VM's threads. */
  wake: [vmId: string];
  /** A project's placement progressed (VM creation, clone). */
  placement: [projectId: string, detail: string];
  awake: [vmId: string];
  offline: [vmId: string];
};

export const bridgeScopes = [
  "orchestration:read",
  "orchestration:operate",
  "filesystem:read",
  "filesystem:write",
  "source-control:write",
  "access:read",
  "providers:manage",
  // T3 clients show agents' browser tabs only with this scope. VM Bridge forwards what that takes, see `Rpc`.
  "preview:operate",
];

export const bridgeAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "vmbridge_t3_session",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** How long a thread just placed on a VM counts toward its load before T3 lists it. */
const launchGraceMs = 2 * 60_000;

/** How long a request naming a thread no VM has reported yet waits for one to report it. */
const unseenThreadWaitMs = 5_000;

/** A VM with an automation sleeps like any other, and wakes this long before the automation runs. */
const scheduleLeadMs = 2 * 60_000;

/** Saving the threads a VM changed while VM Bridge was not looking, once it connects, runs in the background. */
const connectSaveMs = 5 * 60_000;

/** A stored attachment's ID (T3's `ATTACHMENT_ID_PATTERN`): its thread's segment, a UUID, and maybe an extension. */
const attachmentSegment = /^([a-z0-9_]+(?:-[a-z0-9_]+)*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z0-9]{1,10})?$/i;

const attachmentThreadSegment = (threadId: string) =>
  threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80)
    .replace(/[-_]+$/g, "");

/** The local branch a launch starts its worktree from. One taken from origin is on every VM. */
function launchBranch(strategy: unknown): string | undefined {
  const value = (strategy ?? {}) as Wire;
  if (value.type === "worktree" && !value.startFromOrigin) return str(value.baseRef);
  if (value.type === "root") return str(value.branch);
  return undefined;
}

/**
 * Everything T3 clients see: one merged shell, one config, and routing from each request to the
 * VM that owns it. Caches what every VM last reported so sleeping VMs keep their threads visible.
 */
export class Hub extends EventEmitter<HubEvents> {
  /** Each VM's shell as it last reported it. */
  private readonly reported: Map<string, Shell>;
  /** `reported` with the thread commands each VM has not shown yet laid over it: what clients see. */
  private readonly shells = new Map<string, Shell>();
  /** Held commands a VM accepted, by command ID, with the sequence its shell shows them at. */
  private readonly answered = new Map<string, number>();
  /** VMs being sent their held commands, so each gets them one at a time and in order. */
  private readonly replaying = new Map<string, Promise<void>>();
  private readonly configs: Map<string, ServerConfig>;
  private readonly schedules: Map<string, ScheduledTasks>;
  private readonly setupProgress = new Map<string, Wire>();
  /** The agent feedback mode each connected VM's T3 last reported or was sent. */
  private readonly feedbackModes = new Map<string, unknown>();
  /** Threads placed on a VM without room, with the notice their setup shows. */
  private readonly busyNotices = new Map<string, string>();
  /** Top-level threads placed on a VM, by thread ID, counted toward its load until T3 lists them. */
  private readonly launches = new Map<string, { vmId: string; at: number }>();
  /** The notice a VM's threads show from the start of its wake until it connects, or after the wake failed until the next. */
  private readonly wakeNotices = new Map<string, WakeNotice>();
  /** Next-turn settings a VM refused, by thread and command type, until the thread's next message or a newer one accepted. */
  private readonly refusedSettings = new Map<string, Set<string>>();
  private readonly projectionRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  /** The most saving a VM's changed threads may add to putting it to sleep. What is not saved by then keeps its last copy. */
  sleepSaveMs = 15_000;
  /** Fleet-wide agent updates T3 started, by agent instance. */
  private readonly agentUpdates = new Map<string, Wire>();
  /** VMs an agent update woke, so they go back to sleep after it, even when updates overlap. */
  private readonly wokenForUpdate = new Set<string>();
  /** Threads a VM reported that belong to another VM, logged once each. */
  private readonly refusedClaims = new Set<string>();
  private sequence: number;
  /** Uploads waiting for the message that sends them. */
  readonly attachments: Attachments;
  /** Each project's logo, kept for while its VMs sleep. */
  readonly icons: ProjectIcons;

  constructor(
    readonly store: Store,
    readonly settings: Settings,
    readonly fleet: Fleet,
    readonly traffic: Traffic,
    private readonly stats: Pick<Stats, "get" | "lastDisk">,
    private readonly budget?: Pick<Budget, "allowsEarlyWake" | "notice" | "refusal">,
    /** Where each worktree's files are kept as its VM goes to sleep, for the "@" menu. */
    private readonly files?: Pick<FileTrees, "capture">,
  ) {
    super();
    this.setMaxListeners(0);
    this.attachments = new Attachments(store.db);
    this.icons = new ProjectIcons(store.db);
    this.reported = new Map([...store.snapshots<Shell>("shell")].map(([vmId, shell]) => [vmId, this.owned(vmId, shell)]));
    for (const vmId of this.reported.keys()) this.overlay(vmId);
    this.configs = store.snapshots<ServerConfig>("config");
    const fallback = settings.get("fallbackConfig");
    if (fallback && !this.configs.size) this.configs.set(fallback.vmId, fallback.config);
    this.schedules = store.snapshots<ScheduledTasks>("scheduled_tasks");
    this.sequence = settings.get("shellSequence");
    fleet.onConnect = (vmId, backend) => this.attach(vmId, backend);
    fleet.on("waking", (vmId, fromSleep) => this.showWake(vmId, fromSleep));
    fleet.on("wakeFailed", (vmId, reason) => this.showWakeFailed(vmId, reason));
    fleet.on("awake", (vmId) => {
      if (this.wakeNotices.delete(vmId)) this.emit("wake", vmId);
      this.emit("awake", vmId);
      // A save while the VM connected reached neither it (not yet awake) nor the mode it was sent.
      const backend = fleet.backend(vmId);
      if (backend && this.feedbackModes.get(vmId) !== settings.get("agentFeedback")) void this.applyAgentFeedback(vmId, backend);
      void this.replayHeld(vmId);
    });
    fleet.on("offline", (vmId) => {
      if (!store.vm(vmId)) this.forget(vmId);
      this.emit("offline", vmId);
      this.emit("config");
    });
  }

  projects(): readonly ProjectRow[] {
    return this.store.projects();
  }

  out(value: unknown, vmId: string) {
    return translate(value, vmId, "out", this.projects(), this.environments(vmId));
  }

  into<T>(value: T, vmId: string): T {
    return translate(value, vmId, "in", this.projects(), this.environments(vmId)) as T;
  }

  /** The VM's own environment ID, from its last config, and VM Bridge's, which clients know. */
  private environments(vmId: string): Environments | undefined {
    const vm = str(this.configs.get(vmId)?.environment?.environmentId);
    return vm ? { vm, client: this.settings.get("bridgeId") } : undefined;
  }

  private bump() {
    this.sequence++;
    this.settings.set("shellSequence", this.sequence);
  }

  /** Called by the fleet when a VM's T3 server connects: read its config and follow its streams. */
  private async attach(vmId: string, backend: Backend) {
    const config = await backend.call<ServerConfig>("server.getConfig", {});
    if (config.environment?.orchestrationProtocolVersion !== 2) throw new Error("The VM's T3 server changed protocol.");
    const fallback = this.settings.get("fallbackConfig");
    if (fallback) {
      this.configs.delete(fallback.vmId);
      this.settings.set("fallbackConfig", null);
    }
    this.configs.set(vmId, config);
    this.store.saveSnapshot(vmId, "config", config);
    this.feedbackModes.set(vmId, (config.settings?.agentFeedback as Wire | undefined)?.mode);
    // Before the VM counts as awake, so the turns that woke it already use the mode.
    if (this.feedbackModes.get(vmId) !== this.settings.get("agentFeedback")) await this.applyAgentFeedback(vmId, backend);

    backend.request(
      "subscribeServerConfig",
      { providerCatalogsOnDemand: false, providerCatalogDigests: false, providerStatusDeltas: false },
      (frame) => {
        for (const event of chunks(frame)) {
          const current = this.configs.get(vmId);
          if (event.type === "snapshot") this.configs.set(vmId, event.config as ServerConfig);
          else if (event.type === "providerStatuses" && current) {
            current.providers = (event.payload as { providers: ProviderEntry[] }).providers;
          }
          const latest = this.configs.get(vmId);
          if (latest) this.store.saveSnapshot(vmId, "config", latest);
        }
        this.emit("config");
      },
    );
    backend.request("orchestration.subscribeShell", { requestCompletionMarker: true }, (frame) => {
      for (const item of chunks(frame)) this.applyShell(vmId, item as ShellItem);
    });
    backend.request("scheduledTasks.subscribe", {}, (frame) => {
      for (const snapshot of chunks(frame)) {
        if (!Array.isArray(snapshot.tasks)) continue;
        this.schedules.set(vmId, snapshot as ScheduledTasks);
        this.store.saveSnapshot(vmId, "scheduled_tasks", snapshot);
      }
      this.emit("scheduledTasks");
    });
    // A VM may have slept through agent releases. T3 checks for them when its agents refresh
    // and reports the result on the config stream above.
    void backend.call("server.refreshProviders", { omitProviders: true }, 5 * 60_000).catch(() => {});
    this.emit("config");
  }

  private applyShell(vmId: string, item: ShellItem) {
    // T3 follows its snapshot with one that only fills in repositories: its threads are always empty.
    const enrichment = item.kind === "snapshot" && Array.isArray(item.resolvedRepositoryIdentityRoots);
    if (item.kind === "snapshot" && item.snapshot && !enrichment) this.reported.set(vmId, item.snapshot);
    else {
      const shell = this.reported.get(vmId);
      if (!shell) return;
      const without = (rows: Row[] | undefined, id: string | undefined) => (rows ?? []).filter((row) => row.id !== id);
      if (enrichment) {
        const enriched = new Map((item.snapshot?.projects ?? []).map((project) => [project.id, project]));
        shell.projects = (shell.projects ?? []).map((project) => {
          const candidate = enriched.get(project.id);
          return candidate && candidate.workspaceRoot === project.workspaceRoot ? { ...project, repositoryIdentity: candidate.repositoryIdentity } : project;
        });
      } else if (item.kind === "project.updated" && item.project) shell.projects = [...without(shell.projects, item.project.id), item.project];
      else if (item.kind === "project.removed") shell.projects = without(shell.projects, item.projectId);
      else if (item.kind === "thread.updated" && item.thread) {
        shell.threads = without(shell.threads, item.thread.id);
        shell.archivedThreads = without(shell.archivedThreads, item.thread.id);
        const field = item.location === "archive" ? "archivedThreads" : "threads";
        shell[field] = [...(shell[field] ?? []), item.thread];
      } else if (item.kind === "thread.removed") {
        const field = item.location === "archive" ? "archivedThreads" : "threads";
        shell[field] = without(shell[field], item.threadId);
      } else return;
      if (typeof item.sequence === "number") shell.snapshotSequence = item.sequence;
    }
    const reported = this.owned(vmId, this.reported.get(vmId)!);
    this.reported.set(vmId, reported);
    this.store.saveSnapshot(vmId, "shell", reported);
    this.dropShown(vmId);
    const shell = this.overlay(vmId)!;
    const updated = item.kind === "thread.updated" && item.thread && this.store.threadVm(item.thread.id) === vmId ? item.thread : undefined;
    if (updated) this.recordTurn(vmId, updated);
    else if (item.kind === "snapshot" && !enrichment) for (const thread of threadsOf(shell)) this.recordTurn(vmId, thread);
    if (updated) this.refreshProjectionSoon(vmId, updated.id);
    const backend = this.fleet.backend(vmId);
    if (item.kind === "snapshot" && !enrichment && backend) void this.saveThreads(vmId, backend, reported, connectSaveMs);
    if (backend && ((item.kind === "snapshot" && !enrichment) || item.kind === "project.updated")) {
      const only = item.kind === "project.updated" ? item.project?.id : undefined;
      this.refreshIcons(vmId, backend, only);
    }
    const working = hasLiveWork(shell);
    if (working) this.fleet.touch(vmId);
    // Shown as soon as the VM reports it, rather than on the next idle sweep.
    this.setBusy(vmId, working);
    this.bump();
    this.emit("shell");
  }

  /**
   * Asks a VM's T3 for the logos of the projects it is the primary VM of, or of one, to keep for while it sleeps.
   * Only the primary asks, so a second VM still cloning a project does not report it without one.
   */
  private refreshIcons(vmId: string, backend: Backend, only?: string) {
    for (const project of this.reported.get(vmId)?.projects ?? []) {
      const cwd = str(project.workspaceRoot);
      if (!cwd || (only && project.id !== only)) continue;
      const registered = this.store.project(project.id);
      if (!registered || primaryVm(registered)?.vmId !== vmId) continue;
      void this.icons.refresh(project.id, cwd, backend);
    }
  }

  /** The icon picked for a project in T3, from the shell a VM holding it last reported. */
  pickedIcon(projectId: string): unknown {
    for (const shell of this.shells.values()) {
      const project = shell.projects?.find((row) => row.id === projectId);
      if (project?.projectIcon) return project.projectIcon;
    }
    return null;
  }

  /** Records a thread's latest run as a turn for analytics, once per run. Only IDs and names: never messages. */
  private recordTurn(vmId: string, thread: Row) {
    const runId = str(thread.activeRunId) ?? str(thread.latestRunId);
    const vm = this.store.vm(vmId);
    if (!runId || !vm) return;
    const projectId = str(thread.projectId);
    const model = thread.modelSelection as Wire | undefined;
    // A run first seen in a snapshot, as after VM Bridge restarts, may have started long before.
    const updated = Date.parse(str(thread.updatedAt) ?? "");
    this.store.recordTurn({
      threadId: thread.id,
      runId,
      at: Number.isNaN(updated) ? Date.now() : Math.min(updated, Date.now()),
      vmId,
      provider: vm.provider,
      repo: (projectId && this.store.project(projectId)?.url) || null,
      agent: str(thread.providerInstanceId) ?? str(model?.provider) ?? null,
      model: str(model?.model) ?? null,
    });
  }

  /**
   * A VM's shell without the threads another VM holds. A VM gets the threads no VM has yet, such as children it
   * started itself, but only VM Bridge's placement gives it one another VM has: a VM cannot take over others' threads.
   */
  private owned(vmId: string, shell: Shell): Shell {
    const mine = (row: Row) => {
      if (this.store.claimThread(row.id, vmId)) return true;
      const key = `${vmId}:${row.id}`;
      if (!this.refusedClaims.has(key)) {
        this.refusedClaims.add(key);
        console.warn(`[hub] ignored thread ${row.id} from VM ${vmId}: it is on VM ${this.store.threadVm(row.id)}`);
      }
      return false;
    };
    const threads = shell.threads?.filter(mine);
    const archivedThreads = shell.archivedThreads?.filter(mine);
    return { ...shell, ...(threads && { threads }), ...(archivedThreads && { archivedThreads }) };
  }

  /**
   * A removed VM's rows are gone from the store; drop what is still cached in memory too. The last VM's config
   * stays until another VM connects: T3 clients need one, and without it VM Bridge would start a VM to read one.
   */
  private forget(vmId: string) {
    this.reported.delete(vmId);
    this.shells.delete(vmId);
    const config = this.configs.get(vmId);
    if (config && this.configs.size === 1) this.settings.set("fallbackConfig", { vmId, config });
    else this.configs.delete(vmId);
    this.schedules.delete(vmId);
    this.feedbackModes.delete(vmId);
    this.wakeNotices.delete(vmId);
    this.bump();
    this.emit("shell");
    this.emit("scheduledTasks");
  }

  /**
   * Applies a thread command VM Bridge holds (see `isHeldCommand` and `Rpc.detachesAway`) to the merged shell at once
   * and saves it for the thread's VM, which gets it in the background: now when it is connected, when it next connects
   * otherwise. Returns the shell sequence to answer with.
   */
  holdCommand(payload: Wire): number {
    const threadId = str(payload.threadId);
    const vmId = threadId ? this.store.threadVm(threadId) : null;
    const vm = vmId ? this.store.vm(vmId) : null;
    // No VM holds this thread any more (removed, or lost by the provider), so there is nothing left to change.
    if (!vm || vm.state === "gone") return this.sequence;
    const commandId = str(payload.commandId) ?? crypto.randomUUID();
    this.store.holdCommand(commandId, vm.id, this.into({ ...payload }, vm.id), Date.now());
    this.overlay(vm.id);
    this.bump();
    this.emit("shell");
    void this.replayHeld(vm.id);
    return this.sequence;
  }

  /**
   * Sends held commands to a connected VM, one at a time and in the order they were given. A command the VM rejects
   * is dropped, so the thread shows the VM's own state again. One the VM accepted stays laid over its shell until
   * the shell shows it, so the thread does not flicker back in between. One that did not get an answer (the socket
   * dropped, a timeout) stays, with those after it, for the next try. Resolves once none is left to send.
   */
  private replayHeld(vmId: string) {
    const running = this.replaying.get(vmId);
    if (running) return running;
    const replay = this.sendHeld(vmId).finally(() => this.replaying.delete(vmId));
    this.replaying.set(vmId, replay);
    return replay;
  }

  private async sendHeld(vmId: string) {
    while (true) {
      const backend = this.fleet.backend(vmId);
      const held = this.store.heldCommands(vmId).find((row) => !this.answered.has(row.id));
      if (!backend || !held) return;
      let reason = "";
      const outcome = await backend.call<{ sequence?: number }>("orchestration.dispatchCommand", held.payload).then(
        (result) => result?.sequence ?? 0,
        (error) => {
          reason = message(error);
          return error instanceof T3Rejected ? ("rejected" as const) : ("unanswered" as const);
        },
      );
      const replayed = `replay ${String(held.payload.type)}`;
      if (typeof outcome === "number") this.traffic.record({ kind: "system", operation: replayed, vmId, status: "ok" });
      else {
        const what = outcome === "rejected" ? "the VM refused it, so it was dropped" : "no answer from the VM, tried again later";
        this.traffic.record({ kind: "system", operation: replayed, vmId, status: "error", reason: `${what}: ${reason}` });
      }
      if (outcome === "unanswered") return;
      this.noteSetting(held.payload, outcome === "rejected");
      if (outcome === "rejected") this.store.dropHeldCommand(held.id);
      else this.answered.set(held.id, outcome);
      if (outcome === "rejected" || this.dropShown(vmId)) {
        this.overlay(vmId);
        this.bump();
        this.emit("shell");
      }
    }
  }

  /**
   * Waits until a connected VM has been sent the commands VM Bridge holds for it, so a command sent after them reaches
   * it after them, as it would reach T3 after them. Fails when a setting held for the thread a message goes to was
   * refused, in this replay or an earlier one: T3 clients send those settings just before a message and stop when one
   * fails, so the message would otherwise run with the setting the user moved away from. Only that message fails.
   */
  async afterHeld(vmId: string, payload: Wire) {
    await this.replayHeld(vmId);
    const threadId = str(payload.threadId);
    if (payload.type !== "message.dispatch" || !threadId || !this.refusedSettings.delete(threadId)) return;
    throw new Error("This thread's VM refused the change to its settings, so the message was not sent. Check them and send it again.");
  }

  /** Remembers a next-turn setting the VM refused for its thread, or forgets an older refusal one it accepted replaces. */
  private noteSetting(command: Wire, refused: boolean) {
    const threadId = str(command.threadId);
    const type = String(command.type);
    if (!threadId || !nextTurnCommandTypes.has(type)) return;
    const types = this.refusedSettings.get(threadId) ?? new Set<string>();
    if (refused) types.add(type);
    else types.delete(type);
    if (types.size) this.refusedSettings.set(threadId, types);
    else this.refusedSettings.delete(threadId);
  }

  /** Drops the held commands a VM accepted once its shell has reached them. Returns whether it dropped any. */
  private dropShown(vmId: string) {
    const reached = this.reported.get(vmId)?.snapshotSequence ?? 0;
    let dropped = false;
    for (const held of this.store.heldCommands(vmId)) {
      const sequence = this.answered.get(held.id);
      if (sequence === undefined || sequence > reached) continue;
      this.store.dropHeldCommand(held.id);
      this.answered.delete(held.id);
      dropped = true;
    }
    return dropped;
  }

  /** Lays a VM's held commands over what it last reported, into the shell clients see. */
  private overlay(vmId: string) {
    const reported = this.reported.get(vmId);
    if (!reported) return undefined;
    // A copy: applying a command replaces the thread lists and rows, and leaves the reported ones as they are.
    const shell = { ...reported };
    for (const held of this.store.heldCommands(vmId)) applyHeldCommand(shell, held.payload, new Date(held.createdAt).toISOString());
    this.shells.set(vmId, shell);
    return shell;
  }

  /** The merged shell: every registered project, then each VM's threads. */
  shell(): Shell {
    const registered = this.projects();
    const projects: Row[] = registered.map((project) => this.catalogProject(project));
    const threads: Row[] = [];
    const archivedThreads: Row[] = [];
    for (const [vmId, shell] of this.shells) {
      if (this.store.vm(vmId)?.state === "gone") continue;
      for (const project of (this.out(shell.projects ?? [], vmId) as Row[])) {
        // Only a VM holding a registered project may add to its row.
        const known = registered.find((entry) => entry.id === project.id);
        if (known && !known.vms.some((entry) => entry.vmId === vmId)) continue;
        const index = projects.findIndex((existing) => existing.id === project.id);
        if (index < 0) projects.push(project);
        else {
          const registered = projects[index]!;
          projects[index] = {
            ...registered,
            ...project,
            workspaceRoot: registered.workspaceRoot,
            repositoryIdentity: { ...(registered.repositoryIdentity as Wire), ...(project.repositoryIdentity as Wire) },
          };
        }
      }
      threads.push(...(this.out(shell.threads ?? [], vmId) as Row[]));
      archivedThreads.push(...(this.out(shell.archivedThreads ?? [], vmId) as Row[]));
    }
    return { schemaVersion: 1, snapshotSequence: this.sequence, projects, threads, archivedThreads };
  }

  private catalogProject(project: ProjectRow): Row {
    const root = projectRoot(project);
    const at = new Date(project.createdAt).toISOString();
    return {
      id: project.id,
      title: project.title,
      workspaceRoot: root,
      defaultModelSelection: null,
      defaultThreadEnvMode: "worktree",
      scripts: [],
      repositoryIdentity: repositoryIdentity(project, root),
      createdAt: at,
      updatedAt: at,
    };
  }

  descriptor(): Wire {
    const native = [...this.configs.values()][0]?.environment;
    const nativeCapabilities = (native?.capabilities ?? {}) as Wire;
    const fileAttachments = nativeCapabilities.fileAttachments as { maxUploadBytes?: number } | undefined;
    return {
      environmentId: this.settings.get("bridgeId"),
      label: this.settings.get("machineName"),
      serverVersion: native?.serverVersion ?? "0.1.0",
      platform: { os: "linux", arch: "x64", machine: "cloud" },
      orchestrationProtocolVersion: 2,
      capabilities: {
        repositoryIdentity: true,
        connectionProbe: true,
        inlineMessageContext: true,
        vcsBranchStatus: true,
        // Agents' browser tabs run on the VMs' T3 servers, which VM Bridge relays.
        serverBrowser: nativeCapabilities.serverBrowser === true,
        // Uploads go to VM Bridge, which hands them to the thread's VM. See `Attachments`.
        attachmentUploads: nativeCapabilities.attachmentUploads === true,
        ...(nativeCapabilities.questionAttachments === true ? { questionAttachments: true } : {}),
        ...(typeof fileAttachments?.maxUploadBytes === "number"
          ? { fileAttachments: { maxUploadBytes: Math.min(fileAttachments.maxUploadBytes, maxUploadBytes) } }
          : {}),
      },
    };
  }

  hasConfig() {
    return this.configs.size > 0;
  }

  /** T3's server config, built from one VM's and adjusted for a fleet behind one endpoint. */
  config(): Wire {
    const [entry] = this.configs;
    if (!entry) throw new Error("VM Bridge is starting its first VM. Try again in a minute.");
    const [vmId, native] = entry;
    const base = this.out(native, vmId) as ServerConfig;
    base.environment = this.descriptor();
    base.auth = bridgeAuth;
    const agents = this.agents();
    base.providers = agents;
    if (base.settings) {
      base.settings.addProjectBaseDirectory = "/projects";
      base.settings.providerInstances = Object.fromEntries(
        agents.map((agent) => [agent.instanceId, { driver: agent.driver, displayName: agent.displayName, enabled: agent.enabled }]),
      );
      // These belong to each VM's server and can describe its credentials.
      base.settings.secretProviders = {};
      base.settings.usageLimitSources = {};
      base.settings.textGenerators = {};
    }
    delete base.directEndpoints;
    base.shellResumeCompletionMarker = true;
    base.shellThreadFamilies = false;
    base.shellOlderSettled = false;
    base.threadSnapshotPagination = true;
    base.serverTime = new Date().toISOString();
    return base;
  }

  /** Agents across the fleet, preferring what a connected VM (or the given one) reports. */
  agents(preferredVm?: string): AgentReport[] {
    const byId = new Map<string, { vmId: string | null; entry: ProviderEntry }>();
    const rank = (vmId: string) => (vmId === preferredVm ? 2 : this.fleet.backend(vmId) ? 1 : 0);
    const entries = [...this.configs].sort(([a], [b]) => rank(a) - rank(b));
    for (const [vmId, config] of entries) {
      for (const entry of config.providers ?? []) byId.set(entry.instanceId, { vmId, entry });
    }
    for (const driver of defaultAgents) if (!byId.has(driver)) byId.set(driver, { vmId: null, entry: pendingAgent(driver) });
    const preferences = this.settings.get("agentPreferences");
    const added = this.settings.get("providers");
    const badge = added.length === 1 ? providers[added[0]!].label : "VM Bridge";
    return [...byId.values()].map(({ vmId, entry }) => {
      const shown = vmId ? (this.out(entry, vmId) as ProviderEntry) : entry;
      const report = presentAgent(shown, preferences[entry.instanceId], badge);
      // An update is offered while any VM last reported this agent behind its latest release.
      const advised = this.outdated(entry.instanceId)[0]?.entry ?? entry;
      if (report.enabled && advised.versionAdvisory) {
        report.versionAdvisory = advised.versionAdvisory;
        if (advised.compatibilityAdvisory) report.compatibilityAdvisory = advised.compatibilityAdvisory;
      }
      const update = this.agentUpdates.get(entry.instanceId);
      if (update) report.updateState = update;
      return report;
    });
  }

  /** VMs whose last report, from when they were awake, says this agent can update. */
  private outdated(instanceId: string) {
    return [...this.configs].flatMap(([vmId, config]) => {
      const vm = this.store.vm(vmId);
      if (!vm || vm.state === "gone") return [];
      const entry = config.providers?.find((provider) => provider.instanceId === instanceId);
      const advisory = entry?.versionAdvisory as Wire | undefined;
      return entry && advisory?.status === "behind_latest" && advisory.canUpdate === true && advisory.updateCommand ? [{ vmId, entry }] : [];
    });
  }

  /**
   * Runs T3's own agent update on every VM that reported the agent out of date. A sleeping VM is
   * woken for it and put back to sleep once its update is done.
   */
  async updateAgent(input: Wire) {
    const instanceId = str(input.instanceId) ?? str(input.provider);
    if (!instanceId) throw new Error("Name the agent to update.");
    if (this.agentUpdates.get(instanceId)?.status === "running") throw new Error("An update is already running for this agent.");
    const targets = this.outdated(instanceId).map(({ vmId }) => vmId);
    const startedAt = new Date().toISOString();
    const state = (status: string, message: string) => {
      this.agentUpdates.set(instanceId, { status, startedAt, finishedAt: status === "running" ? null : new Date().toISOString(), message, output: null });
      this.emit("config");
    };
    state("running", `Updating on ${targets.length === 1 ? "1 VM" : `${targets.length} VMs`}`);
    const failures: string[] = [];
    await Promise.all(
      targets.map(async (vmId) => {
        const name = this.store.vm(vmId)?.name ?? vmId;
        if (!this.fleet.backend(vmId)) this.wokenForUpdate.add(vmId);
        const release = this.fleet.lease(vmId);
        try {
          const backend = await this.fleet.ensure(vmId);
          const result = await backend.call<{ providers?: ProviderEntry[] }>("server.updateProvider", this.into({ ...input }, vmId), 10 * 60_000);
          const config = this.configs.get(vmId);
          if (result.providers?.length && config) {
            const merged = new Map((config.providers ?? []).map((entry) => [entry.instanceId, entry]));
            for (const entry of result.providers) merged.set(entry.instanceId, entry);
            config.providers = [...merged.values()];
            this.store.saveSnapshot(vmId, "config", config);
          }
          const outcome = result.providers?.find((entry) => entry.instanceId === instanceId)?.updateState as Wire | undefined;
          if (outcome?.status === "failed") failures.push(`${name}: ${str(outcome.message) ?? "the update failed"}`);
        } catch (error) {
          failures.push(`${name}: ${message(error)}`);
        } finally {
          release();
          if (this.wokenForUpdate.has(vmId) && !this.fleet.leased(vmId)) {
            this.wokenForUpdate.delete(vmId);
            await this.sleepVm(vmId);
          }
        }
      }),
    );
    this.traffic.record({ kind: "system", operation: `update ${instanceId} on ${targets.length} VMs`, status: failures.length ? "error" : "ok" });
    if (failures.length) {
      state("failed", failures.join("; "));
      throw new Error(failures.join("; "));
    }
    state(targets.length ? "succeeded" : "unchanged", targets.length ? "Updated on every VM" : "Every VM is up to date");
    return this.agents();
  }

  /** Refreshes agent status on one VM (the request's, or any connected one) and returns the catalog. */
  async refreshAgents(input: Wire) {
    const cwd = str(input.cwd);
    const routed = cwd ? this.routeOrNull({ cwd }) : null;
    // T3 asks with a `cwd` when a key is typed in a thread's composer and its 5-minute snapshot is stale, so that VM
    // is about to get a message.
    if (routed) this.prewake(routed, "typing in a thread");
    const vmId = routed ?? this.fleet.connected()[0];
    const backend = vmId ? this.fleet.backend(vmId) : undefined;
    if (vmId && backend) {
      const request = this.into({ ...input }, vmId);
      if (!routed) delete request.cwd;
      const result = await backend
        .call<{ providers?: ProviderEntry[] }>("server.refreshProviders", { ...request, omitProviders: false, providerCatalogsOnDemand: false })
        .catch(() => null);
      const config = this.configs.get(vmId);
      if (result?.providers?.length && config) {
        // Instance-scoped refreshes return only that instance, so merge by ID.
        const merged = new Map((config.providers ?? []).map((entry) => [entry.instanceId, entry]));
        for (const entry of result.providers) merged.set(entry.instanceId, entry);
        config.providers = [...merged.values()];
        this.store.saveSnapshot(vmId, "config", config);
      }
    }
    this.emit("config");
    const agents = this.agents(vmId);
    const instanceId = str(input.instanceId);
    return instanceId ? agents.filter((agent) => agent.instanceId === instanceId) : agents;
  }

  /** Only the on/off switch and display name are settable from T3. Returns T3's settings. */
  updateAgentPreferences(input: Wire): Wire {
    const mutation = input.providerInstanceMutation as Wire | undefined;
    const patch = (input.patch ?? {}) as Wire;
    const instanceId = str(mutation?.instanceId);
    if (!mutation || !instanceId || Object.keys(patch).length > 0) {
      throw new Error("VM Bridge manages agent settings. Only the on/off switch and name can change here.");
    }
    const agent = this.agents().find((entry) => entry.instanceId === instanceId);
    if (!agent) throw new Error("Unknown agent.");
    const preferences = { ...this.settings.get("agentPreferences") };
    if (mutation.operation === "remove") delete preferences[instanceId];
    else {
      const instance = (mutation.instance ?? {}) as Wire;
      const name = instance.displayName;
      const valid =
        mutation.operation === "upsert" &&
        instance.driver === agent.driver &&
        Object.keys(instance).every((key) => ["driver", "enabled", "displayName"].includes(key)) &&
        (instance.enabled === undefined || typeof instance.enabled === "boolean") &&
        (name === undefined || (typeof name === "string" && name.trim().length > 0 && name.length <= 100));
      if (!valid) throw new Error("Only the on/off switch and name can change for an agent.");
      preferences[instanceId] = {
        enabled: instance.enabled as boolean | undefined,
        displayName: typeof name === "string" ? name.trim() : undefined,
      };
    }
    this.settings.set("agentPreferences", preferences);
    this.emit("config");
    return this.config().settings as Wire;
  }

  /**
   * Keeps T3's agent feedback mode and sets it on every awake VM, where T3 uses it from the next turn without
   * restarting. Sleeping and new VMs get it as they connect.
   */
  setAgentFeedback(mode: AgentFeedbackMode) {
    this.settings.set("agentFeedback", mode);
    for (const vmId of this.fleet.connected()) {
      const backend = this.fleet.backend(vmId);
      if (backend) void this.applyAgentFeedback(vmId, backend);
    }
  }

  /** Sets VM Bridge's agent feedback mode in a VM's T3, unless that T3 has no such setting. Never throws. */
  private async applyAgentFeedback(vmId: string, backend: Backend) {
    const capabilities = this.configs.get(vmId)?.environment?.capabilities as Wire | undefined;
    if (capabilities?.agentFeedback !== true) return;
    const mode = this.settings.get("agentFeedback");
    try {
      await backend.call("server.updateSettings", { patch: { agentFeedback: { mode } } }, 15_000);
      this.feedbackModes.set(vmId, mode);
    } catch (error) {
      console.warn(`[hub] could not set agent feedback to ${mode} on VM ${vmId}: ${message(error)}`);
    }
  }

  scheduledTasks(): Wire {
    const live = [...this.schedules].filter(([vmId]) => this.store.vm(vmId)?.state !== "gone");
    const timeZone = live.find(([, value]) => typeof value.timeZone === "string")?.[1].timeZone;
    return { tasks: live.flatMap(([vmId, value]) => this.out(value.tasks, vmId) as Wire[]), ...(timeZone ? { timeZone } : {}) };
  }

  /** When the next enabled automation on a VM runs, from what T3 there last reported. Null when none is scheduled. */
  nextRun(vmId: string): number | null {
    const times = (this.schedules.get(vmId)?.tasks ?? []).flatMap((task) => {
      const at = task.enabled && !task.blockedByPolicy && typeof task.nextRunAt === "string" ? Date.parse(task.nextRunAt) : NaN;
      return Number.isNaN(at) ? [] : [at];
    });
    return times.length ? Math.min(...times) : null;
  }

  /** An automation on this awake VM runs soon, or was due moments ago and T3 is about to start it. */
  private runDue(vmId: string, now: number) {
    const next = this.nextRun(vmId);
    return next !== null && now >= next - scheduleLeadMs && now < next + scheduleLeadMs;
  }

  /** The VM owning a scheduled task request. A new task goes with its thread or project. */
  async scheduleTarget(tag: string, payload: Wire): Promise<string> {
    const taskId = str(payload.id);
    if (taskId) {
      const owners = [...this.schedules].filter(([, value]) => value.tasks.some((task) => task.id === taskId));
      if (owners.length !== 1) throw new Error("Could not find the VM that owns this automation.");
      return owners[0]![0];
    }
    if (tag !== "scheduledTasks.upsert") throw new Error("An automation ID is required.");
    const projectId = str(payload.projectId);
    if (!payload.threadId && projectId && this.store.project(projectId)) return this.fleet.place(projectId);
    return this.route(payload);
  }

  // Routing

  /** VMs and projects a payload refers to, through thread IDs, project IDs, paths and run IDs. */
  private targets(payload: unknown) {
    const vms = new Set<string>();
    const projects = new Map<string, ProjectRow>();
    const all = this.projects();
    const visit = (value: unknown, key: string) => {
      if (typeof value === "string") {
        if (["threadId", "parentThreadId", "sourceThreadId"].includes(key)) {
          const vmId = this.store.threadVm(value);
          if (vmId) vms.add(vmId);
        }
        if (key === "projectId") {
          const project = all.find((p) => p.id === value);
          if (project) projects.set(project.id, project);
          else for (const [vmId, shell] of this.shells) if (shell.projects?.some((p) => p.id === value)) vms.add(vmId);
        }
        if (isPathKey(key)) {
          const project = projectForPath(value, all);
          if (project) projects.set(project.id, project);
          const vmId = vmForPath(value);
          if (vmId && this.store.vm(vmId)) vms.add(vmId);
        }
        if (key === "runId") {
          for (const [vmId, shell] of this.shells) {
            if (threadsOf(shell).some((thread) => thread.latestRunId === value || thread.activeRunId === value)) vms.add(vmId);
          }
        }
      } else if (Array.isArray(value)) for (const item of value) visit(item, key);
      else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, name);
    };
    visit(payload, "");
    return { vms, projects: [...projects.values()] };
  }

  /** The one VM a request belongs to. Throws when it names none, or several. */
  route(payload: unknown, chosen?: string): string {
    const { vms, projects } = this.targets(payload);
    if (chosen) vms.add(chosen);
    for (const project of projects) {
      // A request naming a thread or VM path goes there. One naming only the project goes to its primary VM.
      if (vms.size) {
        if ([...vms].some((vmId) => !project.vms.some((entry) => entry.vmId === vmId))) throw new Error("This project has no checkout on that VM.");
      } else {
        const primary = primaryVm(project);
        if (primary) vms.add(primary.vmId);
      }
    }
    if (vms.size === 1) return [...vms][0]!;
    throw new Error(
      vms.size
        ? "This request mixes projects or threads from different VMs."
        : "VM Bridge cannot tell which VM this request is for. Use a project or an existing thread.",
    );
  }

  /**
   * Routes a request, waiting briefly when it names a thread no VM has reported yet. A child thread a VM starts
   * itself (T3's delegate_task) reaches its parent's stream a moment before that VM's shell lists it, so a
   * client can open the child before VM Bridge knows which VM it is on.
   */
  async routeSoon(payload: Wire): Promise<string> {
    const threadId = str(payload.threadId);
    const deadline = Date.now() + unseenThreadWaitMs;
    // Until then a project path alone would pick the project's primary VM, which need not be the one running the child.
    while (threadId && !this.store.threadVm(threadId) && !this.targets(payload).vms.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await once(this, "shell", { signal: AbortSignal.timeout(remaining) }).catch(() => {});
    }
    return this.route(payload);
  }

  /**
   * The VM that has an attachment T3 stored for a thread. T3 names it after the thread
   * (`toSafeThreadAttachmentSegment`): the thread ID, lowercased, with other characters than letters, digits, `_`
   * and `-` made `-`, at most 80 characters.
   */
  attachmentVm(attachmentId: string): string | null {
    const segment = attachmentSegment.exec(attachmentId)?.[1]?.toLowerCase();
    if (!segment) return null;
    const direct = this.store.threadVm(segment);
    if (direct) return direct;
    const vms = new Set(this.store.threads().filter((thread) => attachmentThreadSegment(thread.id) === segment).map((thread) => thread.vmId));
    return vms.size === 1 ? [...vms][0]! : null;
  }

  /**
   * The project, branch and folder in it (relative, "" for the top) that a client path points into on a VM, from what
   * the VM last reported: the project's checkout, at the project's branch, or a thread's worktree, at the thread's.
   * `path` is that checkout's or worktree's path on the VM, when known.
   */
  checkoutAt(cwd: string, vmId: string): { project: ProjectRow; branch: string | null; folder: string; path: string | null } | undefined {
    const projects = this.projects();
    const project = projectForPath(cwd, projects);
    if (project) {
      const root = projectRoot(project);
      const path = project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath ?? null;
      return within(cwd, root) ? { project, branch: project.branch, folder: cwd.slice(root.length + 1), path } : undefined;
    }
    const path = this.into({ cwd }, vmId).cwd;
    for (const thread of threadsOf(this.shells.get(vmId))) {
      const worktree = str(thread.worktreePath);
      const owner = projects.find((entry) => entry.id === thread.projectId);
      if (worktree && owner && within(path, worktree)) return { project: owner, branch: str(thread.branch) ?? null, folder: path.slice(worktree.length + 1), path: worktree };
    }
    return undefined;
  }

  routeOrNull(payload: unknown) {
    try {
      return this.route(payload);
    } catch {
      return null;
    }
  }

  /**
   * Routes a request, placing its project on a VM first when `allocate` is set. Command routing is
   * saved before the request is forwarded, so a retried command reaches the same VM.
   */
  async prepare(tag: string, payload: Wire, allocate: boolean, progress?: (detail: string) => void) {
    const fingerprint = sha256(JSON.stringify({ tag, payload }));
    const commandId = str(payload.commandId);
    const previous = commandId ? this.store.command(commandId) : null;
    if (previous && previous.fingerprint !== fingerprint) throw new Error("This commandId was already used for another request.");
    const { vms, projects } = this.targets(payload);
    if (projects.length > 1 || vms.size > 1) throw new Error("This request mixes projects from different VMs.");
    const [project] = projects;
    const launching = tag === "orchestration.launchThread";
    // Known before placement, so placement can count it toward its VM's load.
    let threadId = launching ? (previous?.threadId ?? str(payload.threadId) ?? crypto.randomUUID()) : undefined;
    let vmId: string;
    if (previous || vms.size) vmId = this.route(payload, previous?.vmId);
    else if (project && allocate) {
      const listener = (projectId: string, detail: string) => projectId === project.id && progress?.(detail);
      const report = (detail: string) => this.emit("placement", project.id, detail);
      this.on("placement", listener);
      try {
        if (threadId) {
          const placed = await this.fleet.placeThread(project.id, {
            only: await this.branchHolders(project.id, launchBranch(payload.workspaceStrategy)),
            load: (vm) => this.load(vm),
            placed: (id) => this.launches.set(threadId!, { vmId: id, at: Date.now() }),
            progress: report,
          });
          vmId = placed.vmId;
          const notice = placed.notice ?? this.budget?.notice();
          if (notice) this.busyNotices.set(threadId, notice);
        } else vmId = await this.fleet.place(project.id, report);
      } finally {
        this.off("placement", listener);
      }
    } else vmId = await this.routeSoon(payload);

    if (commandId && !previous) {
      // Claimed in one insert: a retry racing this one through placement adopts whatever VM and thread won,
      // and gives back the reservation it made for its own.
      this.store.saveCommand(commandId, vmId, fingerprint, threadId ?? null);
      const claimed = this.store.command(commandId)!;
      if (claimed.fingerprint !== fingerprint) throw new Error("This commandId was already used for another request.");
      const winner = claimed.threadId ?? undefined;
      if (winner !== threadId) {
        if (threadId) {
          this.launches.delete(threadId);
          this.busyNotices.delete(threadId);
        }
        threadId = winner;
      } else if (threadId && claimed.vmId !== vmId) {
        this.launches.set(threadId, { vmId: claimed.vmId, at: Date.now() });
        this.busyNotices.delete(threadId);
      }
      vmId = claimed.vmId;
    }
    const outgoing = this.into({ ...payload }, vmId);
    if (threadId) outgoing.threadId = threadId;
    if (launching) {
      this.store.setThreadVm(outgoing.threadId as string, vmId);
      const strategy = outgoing.workspaceStrategy as Wire | undefined;
      const placed = project && this.store.project(project.id);
      // A project is a fresh clone, so threads start in their own worktree by default.
      if (placed && (!strategy || strategy.type === "root")) {
        outgoing.workspaceStrategy = { type: "worktree", baseRef: str(strategy?.branch) ?? placed.branch ?? "HEAD" };
      }
    }
    const created = str(payload.threadId);
    if (payload.type === "thread.create" && created) this.store.setThreadVm(created, vmId);
    return { vmId, payload: outgoing };
  }

  /**
   * The local branches one of a project's VMs has: from its checkout while it is awake, else what VM Bridge last
   * read there plus the branches of the threads it last reported.
   */
  async localBranches(projectId: string, vmId: string): Promise<Set<string>> {
    const backend = this.fleet.backend(vmId);
    const live = backend && (await this.readBranches(backend, projectId, vmId));
    if (live) return live;
    const threads = threadsOf(this.shells.get(vmId)).filter((thread) => thread.projectId === projectId);
    const named = threads.flatMap((thread) => (typeof thread.branch === "string" ? [thread.branch] : []));
    return new Set([...this.store.branches(projectId, vmId), ...named]);
  }

  /** Reads a project's local branches from an awake VM and keeps them for while it sleeps. Null when it cannot. */
  private async readBranches(backend: Backend, projectId: string, vmId: string) {
    const cwd = this.store.project(projectId)?.vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (!cwd) return null;
    const listed = await backend.call<{ refs?: Wire[] }>("vcs.listRefs", { cwd, refKind: "local", limit: 200 }, 10_000).catch(() => null);
    if (!listed) return null;
    const names = (listed.refs ?? []).flatMap((ref) => (!ref.isRemote && typeof ref.name === "string" ? [ref.name] : []));
    this.store.setBranches(projectId, vmId, names);
    return new Set(names);
  }

  /** Local branches only some of a project's VMs have: each name with the VMs that have it. */
  async sparseBranches(projectId: string): Promise<Map<string, Set<string>>> {
    const vms = this.store.project(projectId)?.vms.filter((entry) => this.store.vm(entry.vmId)?.state !== "gone") ?? [];
    const holders = new Map<string, Set<string>>();
    if (vms.length < 2) return holders;
    const lists = await Promise.all(vms.map(({ vmId }) => this.localBranches(projectId, vmId)));
    lists.forEach((names, index) => {
      for (const name of names) holders.set(name, (holders.get(name) ?? new Set()).add(vms[index]!.vmId));
    });
    for (const [name, on] of holders) if (on.size === vms.length) holders.delete(name);
    return holders;
  }

  /** The VMs a new thread starting from `branch` must go to, when only some of the project's VMs have it. */
  private async branchHolders(projectId: string, branch: string | undefined) {
    return branch ? (await this.sparseBranches(projectId)).get(branch) : undefined;
  }

  /** One of a project's VMs as placement sees it, from the cached shell and the latest resource reading. */
  private load(vm: VmRow): VmLoad {
    const shell = this.shells.get(vm.id);
    const listed = new Set(threadsOf(shell).map((thread) => thread.id));
    const now = Date.now();
    let launched = 0;
    for (const [threadId, launch] of this.launches) {
      if (now - launch.at > launchGraceMs) this.launches.delete(threadId);
      else if (launch.vmId === vm.id && !listed.has(threadId)) launched++;
    }
    const awake = Boolean(this.fleet.backend(vm.id));
    const stats = awake ? this.stats.get(vm.id) : null;
    // A sleeping VM runs nothing. One that is not connected yet, as after VM Bridge restarts, counts the turns
    // its last saved shell had, so it does not look empty until it reconnects.
    const running = vm.state === "sleeping" ? 0 : threadsOf(shell).filter(isWorking).length;
    return {
      vmId: vm.id,
      awake,
      turns: running + launched,
      vcpus: stats?.cpu?.cores ?? labelVcpus(providers[vm.provider].sizes[vm.size]),
      memory: stats?.memory ?? null,
      disk: stats?.disk ?? this.stats.lastDisk(vm.id),
    };
  }

  // Worktree setup progress shown while VM Bridge places a new thread

  setupSnapshot(threadId: string) {
    return this.setupProgress.get(threadId) ?? null;
  }

  /**
   * The VM's own setup snapshot for a thread, carrying its busy notice when it has one. T3 has no other place
   * for a notice on a starting thread, and its setup card hides once the agent runs, so the notice goes on
   * the agent stage while T3 leaves it without detail. T3's own detail, such as a failure, wins.
   */
  withBusyNotice(threadId: string, snapshot: Wire): Wire {
    const notice = this.busyNotices.get(threadId);
    if (!notice || !Array.isArray(snapshot.stages)) return snapshot;
    const stages = (snapshot.stages as Wire[]).map((stage) => (stage.id === "agent" && stage.detail == null ? { ...stage, detail: notice } : stage));
    return { ...snapshot, stages };
  }

  reportSetup(threadId: string, detail: string, phase: "running" | "done" | "failed" = "running") {
    const previous = this.setupProgress.get(threadId);
    const now = new Date().toISOString();
    // A busy VM's notice stays on the stage through the rest of the setup. Failures show their own text.
    const notice = phase === "failed" ? undefined : this.busyNotices.get(threadId);
    const startedAt = previous?.phase === "running" ? previous.startedAt : now;
    const stage = (previous?.stages as Wire[] | undefined)?.[0];
    this.setupProgress.delete(threadId);
    this.setupProgress.set(threadId, {
      threadId,
      phase,
      startedAt,
      endedAt: phase === "running" ? null : now,
      branch: null,
      baseRef: null,
      worktreePath: null,
      setupScript: null,
      stages: [
        {
          id: "checkout",
          status: notice ? "warning" : phase,
          startedAt: stage?.startedAt ?? now,
          endedAt: phase === "running" ? null : now,
          percent: null,
          detail: (notice ?? detail).slice(0, 200),
          tail: [],
        },
      ],
      error: phase === "failed" ? detail.slice(0, 1000) : null,
      sequence: ((previous?.sequence as number | undefined) ?? -1) + 1,
    });
    // Keep the newest 200, dropping settled ones first.
    if (this.setupProgress.size > 200) {
      const settled = [...this.setupProgress].find(([, snapshot]) => snapshot.phase !== "running");
      if (settled) {
        this.setupProgress.delete(settled[0]);
        this.busyNotices.delete(settled[0]);
      }
    }
    this.emit("setup", threadId);
  }

  // Sleeping threads

  /**
   * Starts waking a sleeping VM in the background because a client looks about to use it: a thread opened, a key
   * typed in a composer, a file attached. The message that follows then finds it awake or shares the wake already
   * running (`Fleet.ensure`). It holds no lease: the wake marks the VM active, so the idle sweep puts it back to sleep
   * after the usual idle minutes when no message comes. Never throws; a failed wake is logged by the fleet.
   */
  prewake(vmId: string, reason: string) {
    // Only asleep: an awake VM needs nothing, a waking one is already on its way, and a failed one waits for a message.
    if (this.store.vm(vmId)?.state !== "sleeping") return;
    if (this.budget && !this.budget.allowsEarlyWake()) return;
    this.traffic.record({ kind: "system", operation: `Waking VM early: ${reason}`, vmId });
    void this.fleet.ensure(vmId).catch(() => {});
  }

  /** `prewake` for the VM a thread is on. Not for a thread no VM holds yet, nor an archived one. */
  prewakeThread(threadId: string, reason: string) {
    const vmId = this.store.threadVm(threadId);
    if (!vmId || this.shells.get(vmId)?.archivedThreads?.some((row) => row.id === threadId)) return;
    this.prewake(vmId, reason);
  }

  /** Starts a VM's waking notice, with how long its provider's latest wakes took when there are any. */
  private showWake(vmId: string, fromSleep: boolean) {
    const vm = this.store.vm(vmId);
    if (!vm) return;
    const label = providers[vm.provider].label;
    let message = `Reconnecting to the ${label} VM...`;
    if (fromSleep) {
      const typical = median(this.store.recentWakeMs(vm.provider));
      message = typical === null ? `Waking the ${label} VM...` : `Waking the ${label} VM, about ${roughly(typical)}`;
      // Once a month past 80% of the budget, the wake also says how much of it is used.
      const budgetNotice = this.budget?.notice();
      if (budgetNotice) message = `${message} ${budgetNotice}`;
    }
    this.wakeNotices.set(vmId, { id: crypto.randomUUID(), startedAt: new Date().toISOString(), message, fromSleep, failedAt: null });
    this.emit("wake", vmId);
  }

  private showWakeFailed(vmId: string, reason: string) {
    const notice = this.wakeNotices.get(vmId);
    const vm = this.store.vm(vmId);
    if (!notice || !vm) return;
    const label = providers[vm.provider].label;
    const message = `${notice.fromSleep ? `Could not wake the ${label} VM` : `Could not reconnect to the ${label} VM`}: ${reason}`.slice(0, 300);
    this.wakeNotices.set(vmId, { ...notice, message, failedAt: new Date().toISOString() });
    this.emit("wake", vmId);
  }

  /** The cached projection of a thread on a sleeping VM, with its VM's waking notice when one is showing. */
  sleepingProjection(threadId: string, vmId: string): Projection | null {
    const projection = this.store.projection<Projection>(threadId, vmId);
    const wake = this.wakeNotices.get(vmId);
    if (!projection || !wake) return projection;
    const turnItems = projection.turnItems ?? [];
    const visible = projection.visibleTurnItems ?? [];
    const item = {
      id: wake.id,
      threadId,
      type: "system_notice",
      level: wake.failedAt ? "error" : "info",
      status: wake.failedAt ? "failed" : "running",
      message: wake.message,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: Math.max(0, ...turnItems.map((entry) => entry.ordinal ?? 0)) + 1,
      title: null,
      startedAt: wake.startedAt,
      completedAt: wake.failedAt,
      updatedAt: wake.failedAt ?? wake.startedAt,
    };
    return {
      ...projection,
      turnItems: [...turnItems, item],
      visibleTurnItems: [
        ...visible,
        { position: (visible.at(-1)?.position ?? -1) + 1, visibility: "synthetic", sourceThreadId: threadId, sourceItemId: item.id, item },
      ],
    };
  }

  shellSequence(vmId: string) {
    return this.shells.get(vmId)?.snapshotSequence ?? 0;
  }

  /**
   * Saves a thread's projection, only from the VM holding the thread. `stamp` is its shell row when the projection was
   * read: by default the row VM Bridge has now, which a later change to the thread moves on and saves again.
   */
  cacheProjection(threadId: string, vmId: string, projection: unknown, stamp = this.stampOf(vmId, threadId)) {
    const value = projection as Projection | null;
    if (value?.thread?.id !== threadId || this.store.threadVm(threadId) !== vmId) return;
    this.store.saveProjection(threadId, vmId, value.updatedAt ?? null, stamp, value);
  }

  private rowOf(vmId: string, threadId: string): Row | undefined {
    return threadsOf(this.reported.get(vmId)).find((row) => row.id === threadId);
  }

  private stampOf(vmId: string, threadId: string) {
    const row = this.rowOf(vmId, threadId);
    return row ? threadStamp(row) : null;
  }

  /**
   * Saves a thread's whole history. T3's `getThreadProjection` answers with only its newest turns, which would leave a
   * long thread without the rest while its VM sleeps.
   */
  private async saveThread(backend: Backend, vmId: string, row: Row, signal?: AbortSignal) {
    const stamp = threadStamp(row);
    const { projection } = await backend.json<{ projection?: unknown }>(`/api/orchestration/threads/${encodeURIComponent(row.id)}`, { signal });
    this.cacheProjection(row.id, vmId, projection, stamp);
  }

  /**
   * Saves a thread again shortly after it changed, once no turn runs in it: a running turn changes it many times a
   * second, and its VM only sleeps after the turn ends. A change during the save saves it again.
   */
  refreshProjectionSoon(vmId: string, threadId: string) {
    if (this.projectionRefreshes.has(threadId)) return;
    const timer = setTimeout(() => {
      const backend = this.fleet.backend(vmId);
      const row = this.rowOf(vmId, threadId);
      if (!backend || !row || isWorking(row)) return void this.projectionRefreshes.delete(threadId);
      void this.saveThread(backend, vmId, row)
        .catch(() => {})
        .finally(() => {
          this.projectionRefreshes.delete(threadId);
          if (this.stampOf(vmId, threadId) !== threadStamp(row)) this.refreshProjectionSoon(vmId, threadId);
        });
    }, 350);
    this.projectionRefreshes.set(threadId, timer);
  }

  /**
   * Saves each of a VM's threads with no copy yet, then each whose row changed since its copy, a few at a time. Returns
   * within `budgetMs`, starting no save after it: a thread not saved by then, or whose save fails, keeps its last copy.
   */
  private async saveThreads(vmId: string, backend: Backend, shell: Shell, budgetMs: number) {
    const stamps = this.store.projectionStamps(vmId);
    const queue = threadsOf(shell)
      .filter((row) => this.store.threadVm(row.id) === vmId && stamps.get(row.id) !== threadStamp(row))
      .sort((a, b) => Number(stamps.has(a.id)) - Number(stamps.has(b.id)));
    const deadline = Date.now() + budgetMs;
    const next = async (): Promise<void> => {
      const row = queue.shift();
      if (!row || Date.now() >= deadline || this.fleet.backend(vmId) !== backend) return;
      await this.saveThread(backend, vmId, row, AbortSignal.timeout(Math.max(deadline - Date.now(), 1))).catch(() => {});
      return next();
    };
    await Promise.race([Promise.all([next(), next(), next()]), sleep(budgetMs)]);
  }

  /** Before a sleep the idle sweep did not decide on, such as one asked for on the dashboard: saves what changed. */
  async saveBeforeSleep(vmId: string) {
    const backend = this.fleet.backend(vmId);
    const shell = this.reported.get(vmId);
    if (backend && shell) await this.saveThreads(vmId, backend, shell, this.sleepSaveMs);
  }

  // Idle sleep

  /**
   * Sleeps VMs idle longer than the configured minutes. The VM's own shell decides: a running
   * turn, queued work, a pending approval, or an automation about to run keeps it awake, and so does an agent running
   * in OpenCode. First, an idle VM still running with older sign-ins restarts T3 to take the new ones.
   */
  async sweep(now = Date.now()) {
    const idleMs = this.settings.get("idleMinutes") * 60_000;
    for (const vm of this.store.vms()) {
      // Automations need their VM awake to run. One that came due since the VM slept, as while VM Bridge was stopped,
      // also wakes it: T3 then runs it or moves it on.
      const next = this.nextRun(vm.id);
      if (vm.state === "sleeping" && next !== null && now >= next - scheduleLeadMs && (vm.lastSleptAt ?? 0) < next && !this.budget?.refusal()) {
        this.traffic.record({ kind: "system", operation: "Waking VM for an automation", vmId: vm.id });
        void this.fleet.ensure(vm.id).catch(() => {});
      }
      // Failed while it may still run, with no connection to tell whether anything does: it sleeps once idle as long.
      if (vm.state === "error" && mayBeAwake(vm) && !this.fleet.leased(vm.id) && now - (vm.lastActivityAt ?? vm.createdAt) >= idleMs) {
        this.traffic.record({ kind: "system", operation: `Failed and idle ${this.settings.get("idleMinutes")} min, sleeping VM`, vmId: vm.id });
        await this.fleet.sleep(vm.id).catch(() => {});
      }
    }
    for (const vmId of this.fleet.connected()) {
      const backend = this.fleet.backend(vmId);
      const vm = this.store.vm(vmId);
      if (!backend || !vm || this.fleet.leased(vmId)) continue;
      const shell = await backend.json<Shell>("/api/orchestration/shell").catch(() => null);
      if (!shell) continue;
      // Only asked when the VM would otherwise restart or sleep, as asking runs a command on it. A busy OpenCode counts as
      // activity, so the next sweeps leave it for another idle period.
      const due = this.fleet.stale(vmId) || now - (vm.lastActivityAt ?? vm.createdAt) >= idleMs;
      const openCode = due && !hasLiveWork(shell) && (await this.fleet.openCodeBusy(vmId));
      if (!openCode && (await this.updateCredentials(vmId, shell))) continue;
      if (hasLiveWork(shell) || openCode || this.runDue(vmId, now)) {
        this.fleet.touch(vmId, now);
        this.setBusy(vmId, hasLiveWork(shell));
        await this.fleet.keepAlive(vmId).catch(() => {});
        continue;
      }
      this.setBusy(vmId, false);
      if (now - (vm.lastActivityAt ?? vm.createdAt) < idleMs) continue;
      this.traffic.record({ kind: "system", operation: `Idle ${this.settings.get("idleMinutes")} min, sleeping VM`, vmId });
      await this.sleepVm(vmId, shell);
    }
  }

  /**
   * As VM Bridge stops: puts every awake VM the idle sweep would not keep awake to sleep, however recently it was used,
   * as nothing would put it to sleep later. Gives up after `timeoutMs`, so stopping cannot hang on a slow provider.
   */
  async sleepIdle(timeoutMs: number, now = Date.now()) {
    const sleeping = Promise.all(
      this.fleet.connected().map(async (vmId) => {
        if (this.fleet.leased(vmId) || this.runDue(vmId, now)) return;
        const shell = await this.fleet.backend(vmId)?.json<Shell>("/api/orchestration/shell").catch(() => null);
        if (!shell || hasLiveWork(shell)) return;
        this.traffic.record({ kind: "system", operation: "VM Bridge stopping, sleeping VM", vmId });
        await this.sleepVm(vmId, shell);
      }),
    ).catch(() => {});
    await Promise.race([sleeping, sleep(timeoutMs)]);
  }

  /**
   * Sign-ins changed: every awake VM gets the new ones written now, and those with nothing running restart
   * T3 so their agents get them too. Busy VMs restart in a later sweep, once idle; sleeping ones when they wake.
   */
  async credentialsChanged() {
    await this.fleet.shareCredentials();
    await Promise.all(
      this.fleet.connected().map(async (vmId) => {
        const shell = await this.fleet.backend(vmId)?.json<Shell>("/api/orchestration/shell").catch(() => null);
        if (shell) await this.updateCredentials(vmId, shell);
      }),
    );
  }

  /** Restarts T3 on an idle VM running with older sign-ins. Returns whether it tried. */
  private async updateCredentials(vmId: string, shell: Shell) {
    if (!this.fleet.stale(vmId) || hasLiveWork(shell) || this.fleet.leased(vmId)) return false;
    await this.fleet
      .restart(vmId, async (live) => !hasLiveWork(await live.json<Shell>("/api/orchestration/shell")) && !(await this.fleet.openCodeBusy(vmId)))
      .catch(() => {});
    return true;
  }

  /** Puts an idle VM to sleep, saving its changed threads first so they stay readable. */
  private async sleepVm(vmId: string, known?: Shell) {
    const shell = known ?? (await this.fleet.backend(vmId)?.json<Shell>("/api/orchestration/shell").catch(() => null));
    if (!shell || hasLiveWork(shell) || this.fleet.leased(vmId)) return;
    await this.fleet
      .sleep(vmId, async (live) => {
        // Alongside the transcripts.
        const listing = this.keepFiles(vmId, shell);
        await this.saveThreads(vmId, live, this.owned(vmId, shell), this.sleepSaveMs);
        // Its branches too, so the project's branch list and placement still know them while it sleeps.
        for (const project of this.store.projects()) {
          if (project.vms.some((entry) => entry.vmId === vmId)) await this.readBranches(live, project.id, vmId);
        }
        await listing;
        // Caching took a while: work may have started on the VM meanwhile.
        const latest = await live.json<Shell>("/api/orchestration/shell");
        if (hasLiveWork(latest) || (await this.fleet.openCodeBusy(vmId))) return false;
        const own = this.owned(vmId, latest);
        this.reported.set(vmId, own);
        this.store.saveSnapshot(vmId, "shell", own);
        this.dropShown(vmId);
        this.overlay(vmId);
        return true;
      })
      .catch(() => {});
    this.bump();
    this.emit("shell");
  }

  /** Keeps the files of each worktree on an awake VM for the "@" menu while it sleeps. Bounded, so it never holds a sleep up. */
  async keepFiles(vmId: string, shell = this.shells.get(vmId)) {
    const box = this.fleet.box(vmId);
    if (box && shell) await this.files?.capture(vmId, box, this.worktrees(vmId, shell));
  }

  /** Each project's checkout on a VM, and the worktree of each of its open threads there. */
  private worktrees(vmId: string, shell: Shell): Worktree[] {
    const found = new Map<string, Worktree>();
    for (const project of this.store.projects()) {
      const path = project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
      if (path) found.set(path, { projectId: project.id, path });
    }
    for (const thread of this.owned(vmId, shell).threads ?? []) {
      const path = str(thread.worktreePath);
      const projectId = str(thread.projectId);
      if (path && projectId && this.store.project(projectId)?.vms.some((entry) => entry.vmId === vmId)) found.set(path, { projectId, path });
    }
    return [...found.values()];
  }

  private setBusy(vmId: string, busy: boolean) {
    const vm = this.store.vm(vmId);
    if (!vm || !["ready", "busy"].includes(vm.state)) return;
    const state = busy ? "busy" : "ready";
    if (vm.state !== state) {
      this.store.updateVm(vmId, { state });
      this.fleet.emit("changed");
    }
  }

  /** Threads on a VM, for the dashboard. */
  vmThreads(vmId: string) {
    return threadsOf(this.shells.get(vmId));
  }

  close() {
    for (const timer of this.projectionRefreshes.values()) clearTimeout(timer);
  }
}

interface WakeNotice {
  /** Its turn item's ID. A failure keeps it, so the notice changes in place. */
  id: string;
  startedAt: string;
  message: string;
  fromSleep: boolean;
  failedAt: string | null;
}

/** A duration as the waking notice gives it: whole seconds, or minutes from 90 seconds. */
function roughly(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** The values of a stream chunk; nothing for other frames. */
function chunks(frame: Frame): Wire[] {
  return frame._tag === "Chunk" && Array.isArray(frame.values) ? (frame.values as Wire[]) : [];
}
