import type { Traffic } from "../traffic.ts";
import { message, NoProvider } from "../fleet.ts";
import { primaryVm } from "../store.ts";
import type { Frame } from "../vm/backend.ts";
import { heldAssetUrl, relayedAssetUrl } from "./attachments.ts";
import type { Clones } from "./clones.ts";
import type { FileTrees } from "./files.ts";
import { isHeldCommand } from "./held.ts";
import type { Hub } from "./hub.ts";
import { iconAssetUrl } from "./icons.ts";
import { KeybindingError, removeKeybinding, upsertKeybinding, type KeybindingRule, type ResolvedKeybinding } from "./keybindings.ts";
import { projectForPath, projectRoot } from "./paths.ts";
import { githubName, githubRepository, type RemoteBranches } from "./repos.ts";
import { str, type Row, type Wire } from "./types.ts";

/** One connected T3 client socket. */
export interface RpcClient {
  readonly clientId: string;
  send(frame: Wire): void;
  /** False once the socket closed or the device lost its access. */
  open(): boolean;
  /** Interrupt handlers for this client's open requests, by request ID. */
  readonly cancels: Map<string, () => void>;
}

/** Echoed back with the type it arrived as: newer T3 clients send numbers and match replies by value. */
type RequestId = string | number;

interface Call {
  id: RequestId;
  tag: string;
  payload: Wire;
  client: RpcClient;
  /** Set once the request reaches a VM, which then records the traffic with the VM's timing. */
  forwarded?: boolean;
}

const success = (requestId: RequestId, value: unknown) => ({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });
const defect = (requestId: RequestId, text: string) => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: text }] },
});
const tagged = (requestId: RequestId, error: Wire) => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
});

type StreamEvent = "shell" | "config" | "scheduledTasks" | "clones";

type SearchMatch = Wire & { threadId: string; source?: string; quality?: number; messageCreatedAt?: string | null };

interface PullRequestList {
  viewers: Record<string, string>;
  providers: (Wire & { host: string; projectCount: number; projectIds?: string[]; configured: boolean; detail: string | null })[];
  entries: (Wire & { updatedAt: string })[];
  errors: Wire[];
  truncated: boolean;
  nextCursors: Record<string, string>;
}

/**
 * Requests T3 clients may forward to a VM. Anything else is refused rather than guessed at. Of the preview methods,
 * the ones on a thread's own tabs: the client opens a tab with `preview.open` when it reopens tabs a restarted T3 lost
 * (every Kubi wake restarts it) and when a link is opened in T3 Code's browser. Neither wakes a sleeping VM.
 */
const forwardable =
  /^(orchestration\.|projects\.|vcs\.|sourceControl\.|git\.|review\.|filesystem\.|pullRequests\.|server\.(getProvider|refreshProvider)|preview\.(list|close|open|resize|adjust)$)/;
/** Stands in for a T3 server's epoch in the empty tab list of a VM that is not awake. */
const asleepEpoch = "vmbridge-asleep";
const mutation = /\.(create|write|mutate|switch|remove|stop|forceStop|pull$|runStackedAction$|preparePullRequestThread$|publishRepository$)/i;
const scheduleMutations = new Set(["scheduledTasks.upsert", "scheduledTasks.setEnabled", "scheduledTasks.delete", "scheduledTasks.runNow"]);

interface Card {
  /** T3's tagged error for the answer. VM Bridge sends it with `not_found`, and with `agent_stopped` when not `wakes`. */
  error: string;
  /** The card stays open after its run ends, so answering it wakes a sleeping VM. */
  wakes: boolean;
}

/** Answers to cards an agent shows in its thread. See `Rpc.answerCard`. */
const cards: Record<string, Card> = {
  // T3 refuses an answer once the run that asked has ended.
  "secrets.answerRequest": { error: "SecretRequestError", wakes: false },
  // T3 keeps a feedback card answerable after its run ends and after a restart, from what the card recorded.
  "agentFeedback.answerRequest": { error: "AgentFeedbackRequestError", wakes: true },
};

/**
 * T3's Effect RPC protocol, answered for a whole fleet. Requests VM Bridge can answer itself (the
 * merged shell, config, clone flow, sleeping transcripts) are handled here; the rest are routed to
 * the owning VM, waking it when the request needs it.
 */
export class Rpc {
  private readonly local: Record<string, (call: Call) => unknown>;
  /**
   * The thread each device session (`clientId`) last sent a `thread.visit` for, which its uploads most likely go to.
   * By session, not socket: the gateway gives every frame its own `RpcClient`.
   */
  private readonly visitedThreads = new Map<string, string>();

  constructor(
    private readonly hub: Hub,
    clones: Clones,
    private readonly branches: RemoteBranches,
    private readonly traffic: Traffic,
    private readonly githubConnected: () => boolean,
    /** Answers the composer's file search while a VM sleeps. Without it, that search fails as any read of a sleeping VM. */
    private readonly files?: FileTrees,
  ) {
    this.local = {
      "server.probe": (call) => this.reply(call, {}),
      // A void answer is `null` in Effect's JSON; `undefined` would drop the `value` key the client requires.
      "server.reportClientActivity": (call) => this.reply(call, null),
      "server.getConfig": (call) => this.reply(call, this.config()),
      "server.getSettings": (call) => this.reply(call, this.config().settings),
      "server.discoverSourceControl": (call) => this.reply(call, this.sourceControl()),
      "server.updateSettings": (call) => {
        try {
          const { providerInstanceMutation, patch } = call.payload;
          this.reply(call, providerInstanceMutation ? hub.updateAgentPreferences(call.payload) : hub.updateFleetSettings((patch ?? {}) as Wire));
        } catch (error) {
          call.client.send(
            tagged(call.id, {
              _tag: "ServerSettingsError",
              settingsPath: "vmbridge",
              operation: "write-managed-setting",
              managedSetting: message(error),
              managedBy: "VM Bridge",
            }),
          );
        }
      },
      "server.upsertKeybinding": (call) => this.keybindings(call, (saved, defaults) => upsertKeybinding(saved, defaults, call.payload)),
      "server.removeKeybinding": (call) => this.keybindings(call, (saved) => removeKeybinding(saved, call.payload)),
      "server.refreshProviders": async (call) => this.reply(call, { providers: await hub.refreshAgents(call.payload) }),
      "server.updateProvider": async (call) => this.reply(call, { providers: await hub.updateAgent(call.payload) }),
      subscribeServerConfig: (call) => this.serverConfig(call),
      "orchestration.subscribeShell": (call) => this.stream(call, "shell", () => ({ kind: "snapshot", snapshot: hub.shell() })),
      "scheduledTasks.subscribe": (call) => this.stream(call, "scheduledTasks", () => hub.scheduledTasks()),
      subscribeProjectClones: (call) => this.stream(call, "clones", () => clones.list()),
      "projectClone.start": (call) => {
        try {
          this.reply(call, clones.start(call.payload));
        } catch (error) {
          call.client.send(
            tagged(call.id, {
              _tag: "SourceControlRepositoryError",
              provider: str(call.payload.provider) ?? "github",
              operation: "clone",
              detail: message(error),
            }),
          );
        }
      },
      "projectClone.retry": (call) => this.reply(call, { applied: clones.retry(String(call.payload.projectId)) }),
      // A clone is one command on the VM with no handle to interrupt.
      "projectClone.cancel": (call) => this.reply(call, { applied: false }),
      "orchestration.getArchivedShellSnapshot": (call) => {
        const shell = hub.shell();
        this.reply(call, { ...shell, threads: shell.archivedThreads });
      },
      "orchestration.searchThreads": (call) => this.searchThreads(call),
      "pullRequests.list": (call) => this.pullRequestList(call),
      "pullRequests.subscribeRefreshes": (call) => this.refreshes(call),
      "pullRequests.subscribeLinkedThreadRefreshes": (call) => this.refreshes(call),
      // A project with no awake checkout has no changes to show, as its VCS status already says.
      "review.getDiffPreview": (call) => {
        const target = this.unreachableProject(call);
        return target ? this.reply(call, { cwd: target.cwd, generatedAt: new Date().toISOString(), sources: [] }) : this.forward(call);
      },
      // Servers listening on this machine, which T3 Code would offer to open. VM Bridge's own ports are no use to it.
      subscribeDiscoveredLocalServers: (call) => {
        call.client.cancels.set(String(call.id), () => {});
        this.chunk(call, { servers: [], scannedAt: new Date().toISOString() });
      },
      "orchestration.getThreadTitles": (call) => {
        const ids = new Set(Array.isArray(call.payload.threadIds) ? call.payload.threadIds : []);
        const shell = hub.shell();
        const rows = [...(shell.threads ?? []), ...(shell.archivedThreads ?? [])].filter((thread) => ids.has(thread.id));
        this.reply(call, Object.fromEntries(rows.map((thread) => [thread.id, thread.title])));
      },
      "sourceControl.appAccess": (call) =>
        call.payload.provider === "github" ? this.reply(call, { status: "signed-out" }) : this.forward(call),
      "sourceControl.lookupRepository": (call) => this.lookupRepository(call),
      subscribeWorktreeSetup: (call) => this.worktreeSetup(call),
      "worktreeSetup.cancel": (call) => {
        const vmId = this.hub.store.threadVm(String(call.payload.threadId));
        return vmId && this.hub.fleet.backend(vmId) ? this.forward(call) : this.reply(call, { cancelled: false });
      },
      "filesystem.browse": (call) => this.browse(call),
      "filesystem.getMetadata": (call) => this.metadata(call),
      "vcs.listRefs": (call) => this.listRefs(call),
      "vcs.refreshStatus": (call) => this.vcsFallback(call),
      "vcs.refreshBranch": (call) => this.vcsFallback(call),
      subscribeVcsBranch: (call) => this.vcsSubscription(call),
      subscribeVcsStatus: (call) => this.vcsSubscription(call),
      "orchestration.subscribeThread": (call) => this.subscribeThread(call),
      subscribePreviewEvents: (call) => this.previewEvents(call),
      "preview.list": (call) => this.previewTabs(call),
      "preview.close": (call) => this.previewTabs(call),
      // The client's own browser profiles, for tabs it hosts. Tabs on a VM use the VM's browser, so this is dropped.
      "preview.reportProfiles": (call) => this.reply(call, null),
      // T3 asks for an upload URL without naming a thread, so VM Bridge takes the upload. See `Attachments`.
      "attachments.createUploadUrl": (call) => {
        this.reply(call, hub.attachments.mint(call.payload, call.client.clientId));
        // A file goes in before the message that sends it, most likely to the thread this device last visited.
        const threadId = this.visitedThreads.get(call.client.clientId);
        if (threadId) hub.prewakeThread(threadId, "file attached");
      },
      "attachments.delete": (call) => {
        hub.attachments.remove(String(call.payload.attachmentId));
        this.reply(call, null);
      },
      "assets.createUrl": (call) => this.assetUrl(call),
    };
    for (const [tag, card] of Object.entries(cards)) this.local[tag] = (call) => this.answerCard(call, card);
  }

  async handle(client: RpcClient, frame: Frame) {
    if (frame._tag === "Ping") return client.send({ _tag: "Pong" });
    if (frame._tag === "Ack") return;
    if (frame._tag === "Interrupt") {
      const requestId = String(frame.requestId);
      client.cancels.get(requestId)?.();
      client.cancels.delete(requestId);
      return;
    }
    if (frame._tag !== "Request" || !["string", "number"].includes(typeof frame.id) || typeof frame.tag !== "string") {
      throw new Error("Invalid RPC frame.");
    }
    const call: Call = { id: frame.id as RequestId, tag: frame.tag, payload: (frame.payload ?? {}) as Wire, client };
    const started = performance.now();
    const local = this.local[call.tag];
    try {
      if (!local) return await this.forward(call);
      await local(call);
      if (!call.forwarded) this.traffic.record({ kind: "rpc", operation: call.tag, clientId: client.clientId, status: "ok", durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      this.traffic.record({ kind: "rpc", operation: call.tag, clientId: client.clientId, status: "error", durationMs: Math.round(performance.now() - started) });
      this.fail(call, error);
    }
  }

  private reply(call: Call, value: unknown) {
    call.client.send(success(call.id, value));
  }

  private fail(call: Call, error: unknown) {
    const text = message(error);
    const { payload, tag, id, client } = call;
    if (tag === "orchestration.launchThread" && typeof payload.threadId === "string") this.hub.reportSetup(payload.threadId, text, "failed");
    if (tag === "orchestration.launchThread" && typeof payload.commandId === "string" && typeof payload.projectId === "string") {
      client.send(tagged(id, { _tag: "OrchestrationV2ThreadLaunchError", commandId: payload.commandId, projectId: payload.projectId, message: text }));
    } else if (tag === "orchestration.dispatchCommand" && typeof payload.commandId === "string" && typeof payload.type === "string") {
      client.send(tagged(id, { _tag: "OrchestrationV2DispatchCommandError", commandId: payload.commandId, commandType: payload.type, message: text }));
    } else if (tag === "server.updateProvider") {
      client.send(tagged(id, { _tag: "ServerProviderUpdateError", provider: str(payload.provider) ?? "unknown", reason: text }));
    } else if (tag.startsWith("scheduledTasks.")) {
      client.send(tagged(id, { _tag: "ScheduledTaskError", message: text, ...(typeof payload.id === "string" ? { taskId: payload.id } : {}) }));
    } else client.send(defect(id, text));
  }

  private chunk(call: Call, value: unknown) {
    call.client.send({ _tag: "Chunk", requestId: call.id, values: [value] });
  }

  /** Sends `value()` now and again on every `event`, until the client interrupts. */
  private stream(call: Call, event: StreamEvent, value: () => unknown) {
    const id = String(call.id);
    const first = value();
    const push = () => {
      try {
        this.chunk(call, value());
      } catch (error) {
        // Thrown into the emitter, this would fail whoever emitted the event. End this stream instead.
        this.hub.off(event, push);
        call.client.cancels.delete(id);
        this.fail(call, error);
      }
    };
    this.hub.on(event, push);
    call.client.cancels.set(id, () => this.hub.off(event, push));
    this.chunk(call, first);
    if (call.payload.requestCompletionMarker) this.chunk(call, { kind: "synchronized" });
  }

  /**
   * T3 shows the environment as connecting until this stream's first snapshot, for over a minute. On a first start,
   * with no VM config yet, the stream waits for the first VM instead of failing: a failure makes T3 close the socket
   * and reconnect, again and again, until that VM is up.
   */
  private serverConfig(call: Call) {
    const snapshot = () => ({ version: 1, type: "snapshot", config: this.config() });
    if (this.hub.hasConfig() || !this.hub.settings.get("defaultProvider")) return this.stream(call, "config", snapshot);
    const id = String(call.id);
    let waiting = true;
    const stop = () => {
      waiting = false;
      this.hub.off("config", ready);
      call.client.cancels.delete(id);
    };
    const ready = () => {
      if (!waiting || !this.hub.hasConfig()) return;
      stop();
      try {
        this.stream(call, "config", snapshot);
      } catch (error) {
        this.fail(call, error);
      }
    };
    this.hub.on("config", ready);
    call.client.cancels.set(id, stop);
    this.hub.fleet.any().then(ready, (error) => {
      if (!waiting) return;
      stop();
      this.fail(call, error);
    });
  }

  private config() {
    if (!this.hub.hasConfig()) {
      // T3 needs one VM's config before it can show anything. Start one now.
      void this.hub.fleet.any().catch(() => {});
      if (!this.hub.settings.get("defaultProvider")) throw new NoProvider();
    }
    return this.hub.config() as Wire & { settings?: Wire };
  }

  /** Saves a shortcut change. T3 reports a shortcut it can't save as a `keybindings.json` parse error. */
  private keybindings(call: Call, change: (saved: KeybindingRule[], defaults: ResolvedKeybinding[]) => KeybindingRule[]) {
    try {
      this.reply(call, this.hub.updateKeybindings(change));
    } catch (error) {
      if (!(error instanceof KeybindingError)) throw error;
      call.client.send(tagged(call.id, { _tag: "KeybindingsConfigParseError", configPath: "VM Bridge", detail: error.message }));
    }
  }

  private sourceControl() {
    const none = { _tag: "None" };
    const some = (value: string) => ({ _tag: "Some", value });
    const connected = this.githubConnected();
    const login = this.hub.settings.get("github")?.login;
    return {
      versionControlSystems: [
        { kind: "git", label: "Git", status: "available", implemented: true, executable: "git", version: none, detail: some("Runs on each VM"), installHint: "Installed on each VM." },
      ],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: connected ? "available" : "missing",
          version: none,
          detail: some("Managed by VM Bridge"),
          installHint: "Connect GitHub in the VM Bridge dashboard.",
          appSignIn: false,
          auth: {
            status: connected ? "authenticated" : "unknown",
            account: login ? some(login) : none,
            host: some("github.com"),
            detail: none,
          },
        },
      ],
    };
  }

  private async lookupRepository(call: Call) {
    if (call.payload.provider !== "github") return this.forward(call);
    try {
      const name = githubName(String(call.payload.repository ?? ""));
      if (!name) throw new Error("Enter the GitHub owner and repository name.");
      await this.branches.check(`https://github.com/${name}.git`);
      this.reply(call, githubRepository(name));
    } catch (error) {
      call.client.send(tagged(call.id, { _tag: "SourceControlRepositoryError", provider: "github", operation: "lookupRepository", detail: message(error) }));
    }
  }

  private browse(call: Call) {
    const partial = str(call.payload.partialPath) ?? "";
    const path = partial.replace(/\/+$/, "") || "/";
    if (path === "/") return this.reply(call, { parentPath: "/", entries: [{ name: "projects", fullPath: "/projects" }] });
    if (path === "/projects") {
      const entries = this.hub.projects().map((project) => ({ name: project.title, fullPath: projectRoot(project) }));
      return this.reply(call, { parentPath: path, entries });
    }
    const vmId = this.hub.routeOrNull(call.payload);
    if (!vmId || !this.hub.fleet.backend(vmId)) {
      return call.client.send(
        tagged(call.id, {
          _tag: "FilesystemBrowseError",
          partialPath: partial || undefined,
          cwd: str(call.payload.cwd),
          failure: "read_directory_failed",
          message: "Start work in this project to browse its files.",
        }),
      );
    }
    return this.forward(call);
  }

  private async metadata(call: Call) {
    const paths = Array.isArray(call.payload.paths) ? call.payload.paths : [];
    if (paths.length > 64) throw new Error("Ask for at most 64 paths at once.");
    const projects = this.hub.projects();
    const entries = await Promise.all(
      paths.map(async (path) => {
        if (typeof path !== "string") return null;
        const project = projectForPath(path, projects);
        if (path === "/" || path === "/projects" || (project && [projectRoot(project), `/projects/${project.id}`].includes(path))) {
          return { kind: "directory" };
        }
        const vmId = this.hub.routeOrNull({ path });
        const backend = vmId ? this.hub.fleet.backend(vmId) : undefined;
        if (!vmId || !backend) return null;
        const response = await backend
          .call<{ entries?: unknown[] }>(call.tag, this.hub.into({ paths: [path] }, vmId))
          .catch(() => null);
        return response?.entries?.[0] ?? null;
      }),
    );
    this.reply(call, { entries });
  }

  /** The project a request's `cwd` points into, when its primary VM cannot answer right now. */
  private unreachableProject(call: Call) {
    const cwd = str(call.payload.cwd);
    const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
    const primary = project && primaryVm(project);
    if (!project || (primary?.checkoutPath && this.hub.fleet.backend(primary.vmId))) return undefined;
    return { project, cwd: cwd! };
  }

  /**
   * A project's branches come from its primary VM, followed by the local branches only its other VMs have, so a
   * branch made on any of them can start a new thread, which placement then puts on a VM that has it.
   */
  private async listRefs(call: Call) {
    const cwd = str(call.payload.cwd);
    const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
    const primary = project && primaryVm(project);
    if (!project || !primary || project.vms.length < 2 || call.payload.refKind === "remote") return this.vcsFallback(call);
    const query = (str(call.payload.query) ?? "").toLowerCase();
    const elsewhere = [...(await this.hub.sparseBranches(project.id))]
      .filter(([name, vms]) => !vms.has(primary.vmId) && name.toLowerCase().includes(query))
      .map(([name]) => name)
      .sort();
    if (!elsewhere.length) return this.vcsFallback(call);
    const backend = primary.checkoutPath ? this.hub.fleet.backend(primary.vmId) : undefined;
    let listed: Wire;
    if (backend) {
      const vmId = primary.vmId;
      const exit = await new Promise<Frame>((resolve, reject) => {
        try {
          backend.request(call.tag, this.hub.into(call.payload, vmId), (frame) => frame._tag === "Exit" && resolve(frame));
        } catch (error) {
          reject(error);
        }
      });
      if ((exit.exit as Wire | undefined)?._tag !== "Success") return call.client.send({ ...(this.hub.out(exit, vmId) as Wire), requestId: call.id });
      listed = this.hub.out((exit.exit as Wire).value, vmId) as Wire;
    } else {
      // The primary is asleep: its part comes from the remote, as for a project on one VM.
      const remote = await this.branches.refs(project, call.payload).catch(() => null);
      if (!remote) return this.vcsFallback(call);
      listed = remote;
    }
    const refs = (listed.refs as Wire[] | undefined) ?? [];
    const shown = new Set(refs.map((ref) => ref.name));
    const extra = elsewhere.filter((name) => !shown.has(name)).map((name) => ({ name, current: false, isDefault: false, worktreePath: null }));
    // They follow the primary's last page, so earlier pages and cursors stay as the primary gave them.
    this.reply(call, {
      ...listed,
      refs: listed.nextCursor == null ? [...refs, ...extra] : refs,
      totalCount: Number(listed.totalCount ?? 0) + extra.length,
    });
  }

  private async vcsFallback(call: Call) {
    const target = this.unreachableProject(call);
    if (!target) return this.forward(call);
    if (call.tag === "vcs.refreshBranch") return this.reply(call, null);
    if (call.tag === "vcs.refreshStatus") {
      const local = await this.branches.status(target.project, target.cwd);
      return this.reply(call, { ...local, hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null });
    }
    try {
      this.reply(call, await this.branches.refs(target.project, call.payload));
    } catch (error) {
      call.client.send(
        tagged(call.id, { _tag: "GitCommandError", operation: "listRefs", command: "git ls-remote", cwd: target.cwd, detail: message(error) }),
      );
    }
  }

  /**
   * VCS streams follow their VM: native while it is awake, VM Bridge's own answer while it sleeps. A project
   * root path follows the primary VM.
   */
  private async vcsSubscription(call: Call) {
    const cwd = str(call.payload.cwd);
    const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
    const routed = project ? undefined : this.hub.route(call.payload);
    let upstream: (() => void) | undefined;
    let closed = false;
    let generation = 0;
    const update = async () => {
      const serial = ++generation;
      upstream?.();
      upstream = undefined;
      const current = project ? this.hub.store.project(project.id) : null;
      const primary = current ? primaryVm(current) : undefined;
      const vmId = current ? primary?.vmId : routed;
      const backend = vmId && (!current || primary?.checkoutPath) ? this.hub.fleet.backend(vmId) : undefined;
      if (backend && vmId) {
        upstream = backend.request(call.tag, this.hub.into(call.payload, vmId), (frame) => {
          if (closed || serial !== generation || frame._tag === "Exit") return;
          call.client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
        });
      } else if (current && cwd) {
        const local = await this.branches.status(current, cwd);
        if (closed || serial !== generation) return;
        this.chunk(call, call.tag === "subscribeVcsBranch" ? { isRepo: local.isRepo, refName: local.refName } : { _tag: "snapshot", local, remote: null });
      }
    };
    const onLifecycle = (vmId: string) => {
      const current = project ? this.hub.store.project(project.id) : null;
      if ((current ? primaryVm(current)?.vmId : routed) === vmId) void update().catch(() => {});
    };
    this.hub.on("awake", onLifecycle);
    this.hub.on("offline", onLifecycle);
    const cancel = () => {
      closed = true;
      upstream?.();
      this.hub.off("awake", onLifecycle);
      this.hub.off("offline", onLifecycle);
    };
    call.client.cancels.set(String(call.id), cancel);
    try {
      await update();
    } catch (error) {
      cancel();
      call.client.cancels.delete(String(call.id));
      throw error;
    }
  }

  /** Worktree setup: VM Bridge's placement progress first, then the VM's own once it is connected. */
  private worktreeSetup(call: Call) {
    const threadId = str(call.payload.threadId);
    if (!threadId) return this.forward(call);
    let upstream: (() => void) | undefined;
    let attached: unknown;
    let nativeBase: number | undefined;
    const update = () => {
      if (nativeBase === undefined) this.chunk(call, this.hub.setupSnapshot(threadId));
      const vmId = this.hub.store.threadVm(threadId);
      const backend = vmId ? this.hub.fleet.backend(vmId) : undefined;
      if (!vmId || !backend || attached === backend) return;
      upstream?.();
      try {
        upstream = backend.request(call.tag, call.payload, (frame) => {
          if (frame._tag !== "Chunk") return;
          for (const snapshot of (frame.values ?? []) as (Wire | null)[]) {
            if (!snapshot) continue;
            // Continue the sequence from VM Bridge's own snapshots.
            nativeBase ??= Number(this.hub.setupSnapshot(threadId)?.sequence ?? -1) + 1;
            this.chunk(call, { ...this.hub.withBusyNotice(threadId, this.hub.out(snapshot, vmId) as Wire), sequence: nativeBase + Number(snapshot.sequence) });
          }
        });
        attached = backend;
      } catch {
        attached = undefined;
      }
    };
    const onSetup = (id: string) => id === threadId && update();
    const onAwake = (vmId: string) => this.hub.store.threadVm(threadId) === vmId && update();
    this.hub.on("setup", onSetup);
    this.hub.on("awake", onAwake);
    call.client.cancels.set(String(call.id), () => {
      this.hub.off("setup", onSetup);
      this.hub.off("awake", onAwake);
      upstream?.();
    });
    update();
  }

  /** A thread stream: live from the VM when awake, the cached transcript while it sleeps. */
  private async subscribeThread(call: Call) {
    const threadId = String(call.payload.threadId);
    const requestId = String(call.id);
    let end: (() => void) | undefined;
    let closed = false;
    // Routing can wait for a shell update, and a cancel or disconnect in that time must still stop the stream.
    call.client.cancels.set(requestId, () => {
      closed = true;
    });
    let vmId: string;
    try {
      vmId = await this.hub.routeSoon(call.payload);
    } catch (error) {
      call.client.cancels.delete(requestId);
      throw error;
    }
    if (closed || !call.client.open()) return;
    const attach = () => {
      const backend = this.hub.fleet.backend(vmId);
      if (!backend || closed) return;
      end?.();
      // Plain snapshots only: VM Bridge caches them, and a fresh one replaces the sleeping copy.
      const input: Wire = {
        ...call.payload,
        acceptBoundedSnapshot: false,
        acceptDeferredWork: false,
        acceptCompactIds: false,
        acceptCompactTurnItems: false,
        acceptDedupedBodies: false,
      };
      delete input.afterSequence;
      end = backend.request(call.tag, input, (frame) => {
        // The VM going to sleep ends the native stream; keep the client's stream open on the cache.
        if (frame._tag === "Exit" && this.hub.store.vm(vmId)?.state !== "ready") return;
        for (const item of (frame.values ?? []) as Wire[]) {
          if (item.kind === "snapshot") this.hub.cacheProjection(threadId, vmId, item.projection);
          else if (item.kind === "event") this.hub.refreshProjectionSoon(vmId, threadId);
        }
        call.client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
      });
    };
    const sleepingSnapshot = () => {
      const projection = this.hub.sleepingProjection(threadId, vmId);
      if (!projection) return false;
      this.chunk(call, { kind: "snapshot", snapshotSequence: this.hub.shellSequence(vmId), projection: this.hub.out(projection, vmId) });
      return true;
    };
    const onAwake = (id: string) => id === vmId && attach();
    const onWake = (id: string) => id === vmId && !this.hub.fleet.backend(vmId) && sleepingSnapshot();
    this.hub.on("awake", onAwake);
    this.hub.on("wake", onWake);
    const cancel = () => {
      closed = true;
      end?.();
      this.hub.off("awake", onAwake);
      this.hub.off("wake", onWake);
    };
    call.client.cancels.set(String(call.id), cancel);
    if (this.hub.fleet.backend(vmId)) return attach();
    if (!sleepingSnapshot()) {
      cancel();
      call.client.cancels.delete(String(call.id));
      throw new Error("This thread's VM is asleep and has no saved transcript. Send a message to wake it.");
    }
    if (call.payload.requestCompletionMarker) this.chunk(call, { kind: "synchronized" });
  }

  /**
   * Preview tab events from every awake VM, as one stream. A VM's events count only for its own threads: one naming
   * another VM's thread is dropped, so no VM can open or change a tab in another project's thread.
   */
  private previewEvents(call: Call) {
    this.fanIn(call, (events, vmId) => {
      for (const event of events) {
        if (this.hub.store.threadVm(String(event.threadId)) === vmId) this.chunk(call, this.hub.out(event, vmId));
      }
    });
  }

  /**
   * Pull request refreshes from every awake VM. Each VM counts its own, so the client gets one fleet count that
   * moves whenever any of them does.
   */
  private refreshes(call: Call) {
    let revision = 0;
    this.fanIn(call, () => this.chunk(call, ++revision));
  }

  /** The same stream from every awake VM, and from each VM that wakes later, until the client interrupts. */
  private fanIn(call: Call, receive: (values: Wire[], vmId: string) => void) {
    const upstreams = new Map<string, () => void>();
    const detach = (vmId: string) => {
      upstreams.get(vmId)?.();
      upstreams.delete(vmId);
    };
    const attach = (vmId: string) => {
      detach(vmId);
      const backend = this.hub.fleet.backend(vmId);
      if (!backend) return;
      try {
        const stop = backend.request(call.tag, {}, (frame) => {
          // An Exit is the VM disconnecting; its next connection attaches again.
          if (frame._tag === "Chunk") receive((frame.values ?? []) as Wire[], vmId);
        });
        upstreams.set(vmId, stop);
      } catch {
        // It disconnected meanwhile.
      }
    };
    this.hub.on("awake", attach);
    this.hub.on("offline", detach);
    call.client.cancels.set(String(call.id), () => {
      this.hub.off("awake", attach);
      this.hub.off("offline", detach);
      for (const stop of upstreams.values()) stop();
    });
    for (const vmId of this.hub.fleet.connected()) attach(vmId);
  }

  /**
   * An asset URL from the VM that has the asset, made to point at VM Bridge, which relays it. Like other reads, it does
   * not wake a sleeping VM. An upload VM Bridge still holds is its own to answer for, and so is a sleeping VM's project
   * logo it kept.
   */
  private async assetUrl(call: Call) {
    const resource = (call.payload.resource ?? {}) as Wire;
    const attachmentId = resource._tag === "attachment" ? str(resource.attachmentId) : undefined;
    const held = attachmentId ? this.hub.attachments.held(attachmentId) : undefined;
    if (held) return this.reply(call, { relativeUrl: heldAssetUrl(held), expiresAt: Date.now() + 60 * 60_000 });
    const vmId = attachmentId ? this.hub.attachmentVm(attachmentId) : this.hub.route(call.payload);
    // The client tells this error apart: a pending upload it cannot find is one to upload again.
    if (!vmId) return call.client.send(tagged(call.id, { _tag: "AssetAttachmentNotFoundError", resource }));
    const backend = this.hub.fleet.backend(vmId);
    if (!backend) {
      const cwd = resource._tag === "project-favicon" ? str(resource.cwd) : undefined;
      const project = cwd ? projectForPath(cwd, this.hub.projects()) : undefined;
      const icon = project ? this.hub.icons.get(project.id) : undefined;
      if (icon) return this.reply(call, { relativeUrl: iconAssetUrl(icon), expiresAt: Date.now() + 60 * 60_000 });
      throw new Error("This VM is asleep. Sending a message wakes it.");
    }
    const exit = await new Promise<Frame>((resolve, reject) => {
      try {
        backend.request(call.tag, this.hub.into(call.payload, vmId), (frame) => frame._tag === "Exit" && resolve(frame));
      } catch (error) {
        reject(error);
      }
    });
    const result = exit.exit as Wire | undefined;
    if (result?._tag !== "Success") return call.client.send({ ...(this.hub.out(exit, vmId) as Wire), requestId: call.id });
    const value = this.hub.out(result.value, vmId) as Wire;
    this.reply(call, { ...value, relativeUrl: relayedAssetUrl(vmId, value.relativeUrl) });
  }

  /**
   * The user's answer to a card an agent showed in its thread, which goes only to the VM that holds the thread: only
   * that VM's agent can have asked. The payload is sent as it came, without `forward`'s routing and path translation,
   * which look at every key: a secret's field names are the agent's own, and one named like a path or an ID must not
   * steer the answer to another VM or have its value rewritten. Nothing here records or repeats the answer.
   *
   * A sleeping VM is woken only for a card that outlives its run (see `cards`). Otherwise VM Bridge refuses the answer
   * as T3 refuses one for an ended run: a VM only sleeps once its runs have ended.
   */
  private async answerCard(call: Call, card: Card) {
    const { client } = call;
    const vmId = this.hub.store.threadVm(String(call.payload.threadId));
    const state = vmId ? this.hub.store.vm(vmId)?.state : undefined;
    if (!vmId || !state || state === "gone") return client.send(tagged(call.id, { _tag: card.error, reason: "not_found" }));
    let backend = this.hub.fleet.backend(vmId);
    if (!backend && !card.wakes) {
      if (state === "ready" || state === "busy") throw new Error("This thread's VM is reconnecting. Try again in a moment.");
      return client.send(tagged(call.id, { _tag: card.error, reason: "agent_stopped" }));
    }
    // Held until T3 answers, so the VM does not go back to sleep in between.
    const release = this.hub.fleet.lease(vmId);
    try {
      backend ??= await this.hub.fleet.ensure(vmId);
    } catch (error) {
      release();
      throw error;
    }
    // Waking can take a minute. A device that left or was removed meanwhile gets nothing sent for it.
    if (!client.open()) return release();
    const started = performance.now();
    let done = false;
    let stop: () => void;
    try {
      stop = backend.request(call.tag, call.payload, (frame) => {
        client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
        if (frame._tag !== "Exit") return;
        done = true;
        release();
        client.cancels.delete(String(call.id));
        const ok = (frame.exit as Wire | undefined)?._tag === "Success";
        this.traffic.record({ kind: "rpc", operation: call.tag, clientId: client.clientId, vmId, status: ok ? "ok" : "error", durationMs: Math.round(performance.now() - started) });
      });
    } catch (error) {
      release();
      throw error;
    }
    call.forwarded = true;
    if (!done) {
      client.cancels.set(String(call.id), () => {
        release();
        stop();
      });
    }
  }

  /**
   * A thread's preview tabs live on its VM. One that is not awake has none, nor does a thread no VM has reported,
   * such as a draft: its list is empty, and closing is done.
   */
  private previewTabs(call: Call) {
    const vmId = this.hub.store.threadVm(String(call.payload.threadId));
    if (vmId && this.hub.fleet.backend(vmId)) return this.forward(call);
    this.reply(call, call.tag === "preview.list" ? { sessions: [], serverEpoch: asleepEpoch, revision: 0 } : null);
  }

  /** Each awake VM's answer to the same read, `null` for a VM that failed it. Sleeping VMs are not woken for it. */
  private awakeAnswers<T>(tag: string, payloadFor: (vmId: string) => Wire | null) {
    return Promise.all(
      this.hub.fleet.connected().flatMap((vmId) => {
        const backend = this.hub.fleet.backend(vmId);
        const payload = payloadFor(vmId);
        if (!backend || !payload) return [];
        return [
          backend
            .call<unknown>(tag, this.hub.into(payload, vmId))
            .then((value) => ({ vmId, value: this.hub.out(value, vmId) as T }))
            .catch(() => ({ vmId, value: null })),
        ];
      }),
    );
  }

  /**
   * Message search on every awake VM, ranked as T3 ranks one server's hits. Titles need no server: the client
   * matches them itself from the shell, which covers sleeping VMs.
   */
  private async searchThreads(call: Call) {
    const answers = await this.awakeAnswers<{ matches?: SearchMatch[] }>(call.tag, () => call.payload);
    const found = answers.filter((answer) => answer.value !== null);
    if (answers.length && !found.length) {
      return call.client.send(tagged(call.id, { _tag: "OrchestrationSearchThreadsError", message: "Failed to search threads" }));
    }
    const matches = found
      // A VM's hits count only for its own threads.
      .flatMap(({ vmId, value }) => (value?.matches ?? []).filter((match) => this.hub.store.threadVm(match.threadId) === vmId))
      .sort(
        (left, right) =>
          (right.quality ?? 0) - (left.quality ?? 0) ||
          Number(left.source !== "user") - Number(right.source !== "user") ||
          (right.messageCreatedAt ?? "").localeCompare(left.messageCreatedAt ?? ""),
      )
      .slice(0, Number(call.payload.limit ?? 50));
    this.reply(call, { matches });
  }

  /**
   * Pull requests are read by each project's primary VM, for the projects the client asked about (or all of them),
   * and merged. A project whose VM is asleep is listed as an error rather than waking it.
   */
  private async pullRequestList(call: Call) {
    const { projectId, projectIds, ...rest } = call.payload;
    const projects = this.hub.shell().projects ?? [];
    const named = Array.isArray(projectIds) ? projects.filter((project) => projectIds.includes(project.id)) : projects;
    const asked = typeof projectId === "string" ? named.filter((project) => project.id === projectId) : named;
    const byVm = new Map<string, Row[]>();
    const merged: PullRequestList = { viewers: {}, providers: [], entries: [], errors: [], truncated: false, nextCursors: {} };
    const unlisted = (project: Row, message: string) =>
      merged.errors.push({ projectId: project.id, projectTitle: str(project.title) || "Project", message });
    for (const project of asked) {
      const vmId = this.hub.routeOrNull({ projectId: project.id });
      if (vmId && this.hub.fleet.backend(vmId)) byVm.set(vmId, [...(byVm.get(vmId) ?? []), project]);
      else unlisted(project, vmId ? "Its VM is asleep. Sending a message in one of its threads wakes it." : "This project is not on a VM yet.");
    }
    const answers = await this.awakeAnswers<PullRequestList>(call.tag, (vmId) => {
      const rows = byVm.get(vmId);
      return rows ? { ...rest, projectIds: rows.map((project) => project.id) } : null;
    });
    for (const { vmId, value } of answers) {
      if (!value) {
        for (const project of byVm.get(vmId) ?? []) unlisted(project, "Its pull requests could not be read.");
        continue;
      }
      merged.viewers = { ...merged.viewers, ...value.viewers };
      merged.entries.push(...value.entries);
      merged.errors.push(...value.errors);
      merged.truncated ||= value.truncated;
      merged.nextCursors = { ...merged.nextCursors, ...value.nextCursors };
      for (const provider of value.providers) {
        const index = merged.providers.findIndex((seen) => seen.host === provider.host);
        const seen = merged.providers[index];
        if (!seen) {
          merged.providers.push(provider);
          continue;
        }
        const { projectIds: _, ...shared } = seen;
        merged.providers[index] = {
          ...shared,
          projectCount: seen.projectCount + provider.projectCount,
          // Absent means every counted project, so the merge keeps the list only when both have one.
          ...(seen.projectIds && provider.projectIds ? { projectIds: [...seen.projectIds, ...provider.projectIds] } : {}),
          configured: seen.configured && provider.configured,
          detail: seen.detail ?? provider.detail,
        };
      }
    }
    merged.entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    this.reply(call, merged);
  }

  /**
   * T3 clients detach a thread's agent sessions, and wait for it, before they delete the thread. A VM that is not
   * connected has no session to detach until it connects, so the detach is held like the delete, to reach it just
   * before the delete, instead of waking it. A connected VM gets it at once, as any stop.
   */
  private detachesAway(payload: Wire) {
    const threadId = str(payload.threadId);
    const vmId = threadId ? this.hub.store.threadVm(threadId) : null;
    return payload.type === "provider-session.detach" && vmId !== null && !this.hub.fleet.backend(vmId);
  }

  /** The composer's file search on a sleeping VM, from the files the VM listed as it went to sleep, or GitHub's. */
  private async searchAsleep(payload: Wire, vmId: string) {
    const cwd = str(payload.cwd);
    const checkout = cwd ? this.hub.checkoutAt(cwd, vmId) : undefined;
    const worktree = checkout?.path ? { vmId, path: checkout.path } : undefined;
    return checkout && this.files?.search(checkout.project, checkout.branch, checkout.folder, payload, worktree);
  }

  /** Routes a request to its VM, waking the VM only for requests that change something. */
  private async forward(call: Call) {
    const { tag, payload, client } = call;
    const scheduled = scheduleMutations.has(tag);
    if (!scheduled && !forwardable.test(tag) && tag !== "worktreeSetup.cancel" && tag !== "sourceControl.appAccess" && tag !== "sourceControl.lookupRepository") {
      throw new Error(`VM Bridge does not support '${tag}'.`);
    }
    if (["projects.createNew", "projects.ensureScratch"].includes(tag)) {
      throw new Error("Add a repository with Clone, so VM Bridge can put it on a VM.");
    }
    if (scheduled && (payload.schedule as Wire | undefined)?.type === "webhook") {
      throw new Error("Webhook automations need a directly reachable T3 server.");
    }
    if (tag === "orchestration.dispatchCommand" && (isHeldCommand(payload) || this.detachesAway(payload))) {
      this.reply(call, { sequence: this.hub.holdCommand(payload) });
      // T3 only sends visits while the user is looking at the thread. Only the open (`opened`, sent once per thread
      // every 10 minutes) wakes its VM, not the visits it repeats while they read it.
      const visited = payload.type === "thread.visit" ? str(payload.threadId) : undefined;
      if (visited) this.visitedThreads.set(client.clientId, visited);
      if (visited && payload.opened === true) this.hub.prewakeThread(visited, "thread opened");
      return;
    }
    const mutating = scheduled || tag === "orchestration.launchThread" || tag === "orchestration.dispatchCommand" || mutation.test(tag);
    const launching = tag === "orchestration.launchThread" ? str(payload.threadId) : undefined;
    const progress = (detail: string) => launching && this.hub.reportSetup(launching, detail);
    progress("Finding a VM for this project");

    const routed = scheduled
      ? await this.hub.scheduleTarget(tag, payload).then((vmId) => ({ vmId, payload: this.hub.into(payload, vmId) }))
      : await this.hub.prepare(tag, payload, mutating, progress);
    const { vmId } = routed;

    const awake = Boolean(this.hub.fleet.backend(vmId));
    if (!mutating && !awake) {
      // The composer's @ file search: a message to this VM is likely next.
      if (tag === "projects.searchEntries") this.hub.prewake(vmId, "@ file search");
      const cached = tag === "orchestration.getThreadProjection" ? this.hub.store.projection(String(payload.threadId), vmId) : null;
      if (cached) return this.reply(call, this.hub.out(cached, vmId));
      const found = tag === "projects.searchEntries" ? await this.searchAsleep(payload, vmId) : undefined;
      if (found) return this.reply(call, found);
      throw new Error("This VM is asleep. Sending a message wakes it.");
    }

    const release = mutating ? this.hub.fleet.lease(vmId) : () => {};
    progress(awake ? "Preparing the workspace" : "Starting the VM");
    let backend;
    try {
      backend = await this.hub.fleet.ensure(vmId);
    } catch (error) {
      release();
      throw error;
    }
    // Placement and waking can take minutes. A device that left or was removed meanwhile gets nothing run for it.
    if (!client.open()) {
      release();
      if (launching) this.hub.reportSetup(launching, "The launch was interrupted.", "failed");
      return;
    }
    progress("Preparing the workspace");
    let outgoing = routed.payload;
    if (mutating) {
      try {
        outgoing = await this.hub.attachments.handOver(routed.payload, vmId, backend);
        await this.hub.afterHeld(vmId, payload);
      } catch (error) {
        release();
        throw error;
      }
      // Handing files over can take minutes too.
      if (!client.open()) {
        release();
        if (launching) this.hub.reportSetup(launching, "The launch was interrupted.", "failed");
        return;
      }
    }

    const started = performance.now();
    let done = false;
    let stop: () => void;
    try {
      stop = backend.request(tag, outgoing, (frame) => {
        client.send({ ...(this.hub.out(frame, vmId) as Wire), requestId: call.id });
        if (frame._tag !== "Exit") return;
        done = true;
        release();
        client.cancels.delete(String(call.id));
        const ok = (frame.exit as Wire | undefined)?._tag === "Success";
        this.traffic.record({ kind: "rpc", operation: tag, clientId: client.clientId, vmId, status: ok ? "ok" : "error", durationMs: Math.round(performance.now() - started) });
        if (launching) this.hub.reportSetup(launching, ok ? "Workspace handed to T3" : "T3 could not start the thread.", ok ? "done" : "failed");
      });
    } catch (error) {
      release();
      throw error;
    }
    call.forwarded = true;
    if (!done) {
      client.cancels.set(String(call.id), () => {
        release();
        stop();
        if (launching) this.hub.reportSetup(launching, "The launch was interrupted.", "failed");
      });
    }
  }
}
