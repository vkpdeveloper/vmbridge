import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { SandboxError, type Preview } from "@opencoredev/sandbox-sdk";
import type { ProviderId, ProviderSetup, VmSize, VmState } from "@vmbridge/contracts";
import { hasScreen, providers, type Box, type Driver } from "./providers/index.ts";
import type { CreateVm } from "./providers/types.ts";
import { BudgetReached } from "./budget.ts";
import { envVars, type Settings, type Secrets } from "./settings.ts";
import { busyNotice, choose, maxVmsPerProject, overflowRetryMs, type VmLoad } from "./placement.ts";
import { primaryVm, type ProjectRow, type Store, type VmRow } from "./store.ts";
import { sleep, type OpenSocket } from "./runtime.ts";
import type { Traffic } from "./traffic.ts";
import { Backend, TokenRejected } from "./vm/backend.ts";
import type { AgentAuth } from "./agent-auth/profiles.ts";
import { githubName } from "./gateway/repos.ts";
import { hasLiveWork, type Shell } from "./gateway/types.ts";
import type { Skills } from "./skills.ts";
import { Bases } from "./vm/bases.ts";
import { newToken } from "./auth/tokens.ts";
import { findWorktreeProgram, fixWorktreeLinks, listWorktreesProgram, NoOpenCodeKey, openCodeBusy, OpenCodeServer, opencodePort, devRelayHeaders, devRelayPort, devRelayProgram, readWorktreeState, removeWorktreeProgram, startOpenCode, stopOpenCode, worktreeName, worktreePath, worktreeStateProgram, type WorktreeState } from "./vm/opencode.ts";
import { syncSkills } from "./vm/skills.ts";
import { checkoutRoot, credentialsFingerprint, prepareVm, quote, readCodexAuth, runProgram, resolveT3Version, startT3, t3Port, writeCodexAuth, writeCredentials, type VmCredentials } from "./vm/runtime.ts";

type FleetEvents = {
  /** A VM's T3 server is connected and subscribed. */
  awake: [vmId: string];
  /** A VM went to sleep, disconnected, or was removed. */
  offline: [vmId: string];
  /** VM Bridge started waking a VM (`fromSleep`), or connecting again to one that kept running. `awake` or `wakeFailed` follows. */
  waking: [vmId: string, fromSleep: boolean];
  /** What a wake or reconnect started with `waking` is doing now, in a few plain words. */
  wakeDetail: [vmId: string, detail: string];
  /** A wake or reconnect started with `waking` failed. */
  wakeFailed: [vmId: string, reason: string];
  /** Anything the dashboard shows about the fleet changed. */
  changed: [];
};

export class NoProvider extends Error {
  constructor() {
    super("Choose a VM provider in the VM Bridge dashboard first.");
  }
}

/** A worktree `findWorktree` looked for is on none of the project's VMs, as opposed to one it could not open. */
export class WorktreeGone extends Error {}

export class SettingUp extends Error {
  constructor(provider: ProviderId) {
    super(`${providers[provider].label} is still setting up. Try again when it is ready in the VM Bridge dashboard.`);
  }
}

/**
 * Logs how long each step of a VM operation took, one line per step, so slow wakes and connects show where the time
 * went. Only step names and durations: never commands or their output.
 */
function stopwatch(operation: string, vmId: string) {
  const started = performance.now();
  let last = started;
  return {
    lap(step: string) {
      const now = performance.now();
      console.log(`[${operation} ${vmId}] ${step}: ${Math.round(now - last)} ms`);
      last = now;
    },
    done() {
      console.log(`[${operation} ${vmId}] total: ${Math.round(performance.now() - started)} ms`);
    },
  };
}

/** Whether a VM may be running at its provider: it connected since it last went to sleep. */
export const mayBeAwake = (vm: VmRow) => Boolean(vm.sandboxId) && (vm.lastConnectedAt ?? 0) > (vm.lastSleptAt ?? 0);

const shortId = () =>crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/** How often to look for untracked VMs before a create, after the check on start. */
export const reconcileEveryMs = 10 * 60_000;

/**
 * What VM Bridge reaches on each VM. Railway opens only the ports a VM was made or last woken with, so a Railway VM
 * awake from before a port was added reaches it once it sleeps and wakes. Other providers open any port on demand.
 */
const vmPorts = [t3Port, opencodePort, devRelayPort];
/** How often the sidebar's look at a worktree fetches its base branch, to say how far behind it is. */
const baseFetchMs = 10 * 60_000;
/** Provider keys VM Bridge creates: a VM's ID, with a suffix when it starts from a snapshot or checkpoint. */
const vmKey = /^([0-9a-f]{12})(?:-[0-9a-z]+)?$/;
/** Provider keys of base snapshot build VMs (see vm/bases.ts). */
const buildKey = /^base-[0-9a-f]{12}$/;

/** Provider config: the non-secret options plus every secret field, read from the secrets table. */
export function providerValues(settings: Settings, secrets: Secrets, id: ProviderId) {
  const values = { ...settings.get("providerOptions")[id] };
  for (const field of providers[id].fields) {
    if (field.kind !== "secret") continue;
    const value = secrets.get(`provider.${id}.${field.key}`);
    if (value) values[field.key] = value;
  }
  return values;
}

const repoName = (url: string) =>
  new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "repository";

/** Where a new top-level thread went. `notice` is set when that VM had no room for it. */
export interface ThreadPlacement {
  vmId: string;
  notice: string | null;
}

/**
 * Owns every VM: creating, waking, connecting to its T3 server, cloning its project, and sleeping.
 * A VM holds one project, and a busy project gets more VMs (see `placeThread`). Each VM operation runs
 * under that VM's lock, and each project's placement under the project's.
 */
export class Fleet extends EventEmitter<FleetEvents> {
  private readonly backends = new Map<string, Backend>();
  private readonly boxes = new Map<string, Box>();
  /**
   * VMs running and prepared (sign-ins, tools and skills in place), whether or not T3 answers yet. OpenCode needs only
   * this, so it never waits for T3 (see `machine`).
   */
  private readonly prepared = new Set<string>();
  private readonly connecting = new Map<string, Promise<Backend>>();
  /** Each running wake's point where the VM is prepared, before T3 starts. */
  private readonly preparing = new Map<string, PromiseWithResolvers<Box>>();
  /** T3 knowing each project on each VM, by `vmId:projectId`, checked once while VM Bridge runs (see `registered`). */
  private readonly registrations = new Map<string, Promise<void>>();
  /** OpenCode on awake VMs, from its first use until the VM goes offline. */
  private readonly opencodes = new Map<string, Promise<OpenCodeServer>>();
  /** When each OpenCode worktree's base branch was last fetched, by `<vmId>/<name>`. */
  private readonly baseFetchedAt = new Map<string, number>();
  /** Previews of dev servers' ports, by the machine they were made on and the port. */
  private readonly relayPreviews = new WeakMap<Box, Promise<Preview>>();
  private readonly placing = new Map<string, Promise<string>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, number>();
  private readonly drivers = new Map<ProviderId, { signature: string; driver: Driver }>();
  /** The first VM started to read T3's configuration, shared by everyone asking at once. */
  private bootstrapping?: Promise<string>;
  /** Fingerprint of the sign-ins and variables VM Bridge last gave out on each provider's VMs, once it has. */
  private readonly latest = new Map<ProviderId, string>();
  /** VMs whose T3 server could not be restarted for these sign-ins, so the idle sweep stops trying. */
  private readonly unrestartable = new Map<string, string>();
  /** When adding a VM to each project last failed. */
  private readonly overflowFailedAt = new Map<string, number>();
  /** When each provider was last checked for untracked VMs, and the check running now. */
  private readonly reconciledAt = new Map<ProviderId, number>();
  private readonly reconciling = new Map<ProviderId, Promise<void>>();
  private closed = false;
  readonly bases: Bases;

  /** Pauses before each try to reconnect a VM whose T3 connection dropped. After the last, it is put to sleep. */
  reconnectPausesMs = [1_000, 5_000, 15_000];

  /** Runs once a VM's backend is connected, before anyone else can use it. */
  onConnect: (vmId: string, backend: Backend) => Promise<void> = async () => {};

  /** Why new VMs and wakes are refused now, such as a spent budget (see `Budget.refusal`). Null: they are not. */
  refusal: () => string | null = () => null;

  private refuse() {
    const reason = this.refusal();
    if (reason) throw new BudgetReached(reason);
  }

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
    private readonly secrets: Secrets,
    private readonly traffic: Traffic,
    private readonly agents: AgentAuth,
    private readonly skills: Pick<Skills, "state" | "files">,
    readonly openSocket: OpenSocket,
  ) {
    super();
    this.on("offline", (vmId) => this.opencodes.delete(vmId));
    this.bases = new Bases(
      store,
      (provider) => this.driver(provider),
      traffic,
      () => this.labels(),
      (provider) => this.settings.get("providers").includes(provider),
      () => this.emit("changed"),
    );
  }

  driver(provider: ProviderId): Driver {
    const values = providerValues(this.settings, this.secrets, provider);
    const signature = JSON.stringify(values);
    const cached = this.drivers.get(provider);
    if (cached?.signature === signature) return cached.driver;
    const driver = providers[provider].open({ values });
    this.drivers.set(provider, { signature, driver });
    return driver;
  }

  backend(vmId: string): Backend | undefined {
    const backend = this.backends.get(vmId);
    return backend?.open ? backend : undefined;
  }

  /** The provider handle of a connected VM. Undefined while it sleeps, so callers cannot wake it. */
  box(vmId: string): Box | undefined {
    return this.backend(vmId) ? this.boxes.get(vmId) : undefined;
  }

  connected(): string[] {
    return [...this.backends.keys()].filter((id) => this.backend(id));
  }

  leased(vmId: string) {
    return (this.leases.get(vmId) ?? 0) > 0;
  }

  /** Holds a VM awake while a request runs. Call the result once to release. */
  lease(vmId: string): () => void {
    this.leases.set(vmId, (this.leases.get(vmId) ?? 0) + 1);
    this.touch(vmId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(vmId, (this.leases.get(vmId) ?? 1) - 1);
    };
  }

  touch(vmId: string, now = Date.now()) {
    this.store.updateVm(vmId, { lastActivityAt: now });
  }

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }

  private setState(vmId: string, state: VmState, error: string | null = null) {
    this.store.updateVm(vmId, { state, error });
    this.emit("changed");
  }

  private labels() {
    return { vmbridge: this.settings.get("bridgeId").slice(0, 12) };
  }

  /** The size new VMs on a provider get unless a repository rule picks another. */
  private defaultSize(provider: ProviderId): VmSize {
    return this.settings.get("vmSize") ?? providers[provider].defaultSize;
  }

  /** The base snapshot new VMs on a provider start from, at the size they get by default. */
  setup(provider: ProviderId): ProviderSetup {
    return this.bases.status(provider, this.defaultSize(provider));
  }

  /** No VM is created on a provider while its first base snapshot builds, so none starts the slow way meanwhile. */
  private settingUp(provider: ProviderId) {
    return this.setup(provider).state === "building";
  }

  /** The default provider, or while it sets up, another added provider that is ready. */
  private available(): ProviderId {
    const preferred = this.settings.get("defaultProvider");
    if (!preferred) throw new NoProvider();
    if (!this.settingUp(preferred)) return preferred;
    const other = this.settings.get("providers").find((provider) => !this.settingUp(provider));
    if (!other) throw new SettingUp(preferred);
    return other;
  }

  /** Creates a VM, on the default provider and size unless told otherwise. It is not started or connected yet. */
  async create(choice: { provider?: ProviderId; size?: VmSize; discardOnError?: boolean } = {}): Promise<VmRow> {
    this.refuse();
    const provider = choice.provider ?? this.available();
    if (!this.settings.get("providers").includes(provider)) throw new Error(`Add ${providers[provider].label} in Accounts first.`);
    if (this.settingUp(provider)) throw new SettingUp(provider);
    const driver = this.driver(provider);
    const id = shortId();
    const size = choice.size ?? this.defaultSize(provider);
    this.store.insertVm({ id, provider, name: `vm-${id.slice(0, 6)}`, size, state: "provisioning", createdAt: Date.now() });
    this.emit("changed");
    // Under the VM's lock, so deleting a VM that is still being created waits and then deletes it at the provider too.
    return this.exclusive(id, async () => {
      const started = performance.now();
      const watch = stopwatch("create", id);
      let box: Box;
      let based: boolean;
      try {
        ({ box, based } = await this.createBox(provider, driver, { key: id, size, labels: this.labels(), ports: vmPorts }));
        watch.lap(based ? "provider create from base snapshot" : "provider create");
      } catch (error) {
        this.traffic.record({ kind: "provider", operation: "create VM", vmId: id, status: "error" });
        // A refused create leaves nothing at the provider, so a caller with its own error report drops the row.
        if (choice.discardOnError) {
          this.store.deleteVm(id);
          this.emit("changed");
        } else this.setState(id, "error", message(error));
        throw error;
      }
      this.store.updateVm(id, { sandboxId: box.id });
      const vm = this.store.vm(id);
      if (!vm) {
        // The row went away some other way: do not leave a billable VM nobody knows about. `reconcile` retries a failed delete.
        await driver.destroy(box.id).catch((error) => this.failed("delete VM", error, { vmId: id, provider }));
        throw new Error(`VM ${id} was deleted while it was being created.`);
      }
      this.boxes.set(id, box);
      const operation = based ? "create VM from base snapshot" : "create VM";
      const durationMs = Math.round(performance.now() - started);
      this.traffic.record({ kind: "provider", operation, vmId: id, status: "ok", durationMs });
      this.store.recordVmEvent(vm, "create", durationMs);
      return vm;
    });
  }

  /**
   * Creates a VM at the provider from the current base snapshot, or the plain way when there is none yet. Then starts
   * building a new snapshot when one is due.
   */
  private async createBox(provider: ProviderId, driver: Driver, input: CreateVm): Promise<{ box: Box; based: boolean }> {
    // Leftover VMs can hold the last VM the provider allows.
    await this.bases.reap(provider);
    if (Date.now() - (this.reconciledAt.get(provider) ?? -Infinity) >= reconcileEveryMs) await this.reconcile(provider);
    // Without the t3 version there is no telling which snapshot is current. Opening the VM will report the failure.
    const version = await resolveT3Version(this.settings.get("t3Version")).catch(() => null);
    if (!version) return { box: await driver.create(input), based: false };
    const choice = this.bases.choose(provider, input.size, version);
    let rebuild = choice.rebuild;
    let created: { box: Box; based: boolean } | undefined;
    if (choice.from) {
      try {
        created = { box: await driver.create(input, choice.from), based: true };
      } catch (error) {
        this.traffic.record({ kind: "provider", operation: `create VM from base snapshot: ${message(error)}`, vmId: input.key, status: "error" });
        // A full plan would refuse a plain create too. Only a snapshot the provider no longer has is replaced: other
        // errors leave a working one alone and fall back to a plain create.
        if (error instanceof SandboxError && error.code === "quota") throw error;
        if (error instanceof SandboxError && error.code === "not_found") {
          this.bases.failed(provider, input.size, choice.from);
          rebuild = true;
        }
      }
    }
    created ??= { box: await driver.create(input), based: false };
    if (rebuild) this.bases.rebuild(provider, input.size, version);
    return created;
  }

  /**
   * Builds the base snapshot for new VMs on a provider, at the size they get by default, when it has none or an outdated
   * one. Without one the build counts as started right away, so no VM is created there before it is done.
   * `retry` builds again after a failure.
   */
  prepareBase(provider: ProviderId, retry = false) {
    if (!this.bases.supported(provider)) return;
    const size = this.defaultSize(provider);
    const version = resolveT3Version(this.settings.get("t3Version"));
    if (!this.store.base(provider, size)?.snapshot) return this.bases.rebuild(provider, size, version, retry);
    void version
      .then((resolved) => {
        // Removed while the version resolved.
        if (!this.settings.get("providers").includes(provider)) return;
        if (this.bases.choose(provider, size, resolved).rebuild) this.bases.rebuild(provider, size, resolved, retry);
      })
      .catch(() => {});
  }

  /** `prepareBase` for every added provider, as on start or once the default size or T3 version changes. */
  prepareBases(retry = false) {
    for (const provider of this.settings.get("providers")) this.prepareBase(provider, retry);
  }

  /** Wakes and connects a VM. Concurrent callers share one attempt. */
  ensure(vmId: string): Promise<Backend> {
    const ready = this.backend(vmId);
    if (ready) return Promise.resolve(ready);
    let flight = this.connecting.get(vmId);
    if (!flight) {
      const prepared = Promise.withResolvers<Box>();
      prepared.promise.catch(() => {});
      this.preparing.set(vmId, prepared);
      flight = this.exclusive(vmId, () => this.open(vmId, prepared.resolve)).finally(() => {
        this.connecting.delete(vmId);
        if (this.preparing.get(vmId) === prepared) this.preparing.delete(vmId);
      });
      // Once prepared, this settles nothing: a T3 failure after that is the wake's to report.
      flight.catch(prepared.reject);
      this.connecting.set(vmId, flight);
    }
    return flight;
  }

  /**
   * The VM running and prepared, for OpenCode: it does not wait for T3, which the wake goes on starting meanwhile. What
   * the wake does until then goes to `detail`, and nothing after, so T3's steps never show.
   */
  async machine(vmId: string, detail?: (text: string) => void): Promise<Box> {
    const ready = this.prepared.has(vmId) && this.boxes.get(vmId);
    if (ready) return ready;
    // The wake goes straight on to T3 once prepared, before this stops listening, so nothing after that is passed on.
    const forward = (id: string, text: string) => {
      if (id === vmId && !this.prepared.has(vmId)) detail?.(text);
    };
    this.on("wakeDetail", forward);
    try {
      const wake = this.ensure(vmId);
      wake.catch(() => {});
      const preparing = this.preparing.get(vmId);
      if (preparing) return await preparing.promise;
      await wake;
      const box = this.boxes.get(vmId);
      if (!box) throw new Error(`VM ${vmId} is not awake.`);
      return box;
    } finally {
      this.off("wakeDetail", forward);
    }
  }

  /** Whether OpenCode can use the VM now, without waking it. */
  machineReady(vmId: string) {
    return this.prepared.has(vmId) && this.boxes.has(vmId);
  }

  /** `ensure`, passing on what the wake is doing to `detail` while it runs, even when another caller started it. */
  private async ensureTelling(vmId: string, detail?: (text: string) => void) {
    if (!detail) return this.ensure(vmId);
    const forward = (id: string, text: string) => {
      if (id === vmId) detail(text);
    };
    this.on("wakeDetail", forward);
    try {
      return await this.ensure(vmId);
    } finally {
      this.off("wakeDetail", forward);
    }
  }

  private async open(vmId: string, prepared: (box: Box) => void = () => {}): Promise<Backend> {
    if (this.closed) throw new Error("VM Bridge is stopping.");
    const ready = this.backend(vmId);
    if (ready) {
      const box = this.boxes.get(vmId);
      if (box) prepared(box);
      return ready;
    }
    const vm = this.store.vm(vmId);
    if (!vm) throw new Error(`VM ${vmId} does not exist.`);
    if (vm.state === "gone") throw new Error("This VM was removed from the provider. Start a new thread to get a new VM.");
    if (!vm.sandboxId) throw new Error(`VM ${vmId} was never created at the provider.`);
    // Asleep (or never started) until now, so nothing runs there that restarting T3, or putting it back to sleep, could interrupt.
    const wasAsleep = (vm.lastSleptAt ?? 0) >= (vm.lastConnectedAt ?? 0);
    // Only a wake is refused: a VM that may still run, such as one reconnecting mid-turn, always gets its connection back.
    if (wasAsleep) this.refuse();
    this.setState(vmId, "starting");
    this.emit("waking", vmId, wasAsleep);
    const started = performance.now();
    const watch = stopwatch("wake", vmId);
    let box: Box | undefined;
    // Looked up while the VM wakes. Awaited below; until then, a failed lookup must not count as unhandled. A VM that ran
    // T3 before keeps that version when the npm registry cannot be reached, rather than failing to wake.
    const version = resolveT3Version(this.settings.get("t3Version")).catch((error: unknown) => {
      if (vm.t3Version) return vm.t3Version;
      throw error;
    });
    version.catch(() => {});
    try {
      const driver = this.driver(vm.provider);
      this.emit("wakeDetail", vmId, `Waiting for ${providers[vm.provider].label}`);
      box = await driver.wake({
        key: vm.id,
        size: vm.size,
        labels: this.labels(),
        ports: vmPorts,
        sandboxId: vm.sandboxId,
        checkpoint: vm.checkpoint,
      });
      watch.lap("provider wake");
      // Restoring a checkpoint makes a new sandbox. It holds the files now, so the checkpoint can go.
      if (box.id !== vm.sandboxId) {
        this.store.updateVm(vmId, { sandboxId: box.id, checkpoint: null });
        const { checkpoint } = vm;
        if (checkpoint) {
          await driver.deleteCheckpoint(checkpoint).catch((error) => {
            // On record, so the next sweep deletes it instead of it being billed forever.
            this.store.retireSnapshot(vm.provider, checkpoint);
            this.failed("delete snapshot", error, { vmId, provider: vm.provider });
          });
        }
      }
      this.boxes.set(vmId, box);
      const woken = box;
      // A T3 server still running from before VM Bridge restarted may be in the middle of a turn: then the idle sweep restarts it later.
      const backend = await this.connect(vm, box, await version, async (preview) => {
        if (wasAsleep || !vm.t3Token) return true;
        const shell = await new Backend(vmId, preview, vm.t3Token, this.openSocket).json<Shell>("/api/orchestration/shell").catch(() => null);
        return Boolean(shell && !hasLiveWork(shell)) && !(await openCodeBusy(woken).catch(() => true));
      }, watch, prepared);
      watch.done();
      this.touch(vmId);
      const durationMs = Math.round(performance.now() - started);
      this.traffic.record({ kind: "provider", operation: "wake VM", vmId, status: "ok", durationMs });
      // A reconnect to a VM that kept running is not a start.
      if (wasAsleep) this.store.recordVmEvent(vm, vm.lastConnectedAt === null ? "start" : "wake", durationMs);
      return backend;
    } catch (error) {
      this.failed("wake VM", error, { vmId, provider: vm.provider });
      // T3 failed after OpenCode started using the VM: it stays up for OpenCode, and the idle sweep puts it to sleep once
      // it has been idle as long as any failed VM.
      const usedByOpenCode = this.prepared.has(vmId) && (this.leased(vmId) || this.opencodes.has(vmId));
      if (!usedByOpenCode) this.prepared.delete(vmId);
      if (error instanceof SandboxError && error.code === "not_found") this.markGone(vmId);
      else {
        // Woken but unusable: put it back to sleep so it does not run, and bill, outside the idle sweep.
        if (box && wasAsleep && !usedByOpenCode) await this.sleepBox(vmId, this.driver(vm.provider), box).catch((sleepError) => this.failed("sleep VM", sleepError, { vmId, provider: vm.provider }));
        this.setState(vmId, "error", message(error));
      }
      this.emit("wakeFailed", vmId, message(error));
      throw error;
    }
  }

  /**
   * Installs what the VM needs, gives it the current sign-ins, and connects to its T3 server. A server
   * running from before with older sign-ins is restarted first when `idle` says nothing runs on it.
   */
  private async connect(
    vm: VmRow,
    box: Box,
    version: string,
    idle: (preview: Preview) => Promise<boolean>,
    watch = stopwatch("connect", vm.id),
    prepared: (box: Box) => void = () => {},
  ): Promise<Backend> {
    // Codex on this VM may have refreshed its own tokens while VM Bridge could not reach it. Refreshing here with the
    // refresh token that retired would fail, so take the VM's first. Otherwise `prepareVm` keeps the newer file.
    if (this.agents.codexDue()) {
      const codexAuth = await readCodexAuth(box);
      if (codexAuth) await this.agents.adoptCodex(codexAuth, vm.id);
      watch.lap("read Codex sign-in");
    }
    const credentials = await this.credentials(vm.provider);
    const fingerprint = credentialsFingerprint(credentials, this.store.encryption);
    this.emit("wakeDetail", vm.id, "Preparing the VM");
    const [setup, preview] = await Promise.all([prepareVm(box, version, credentials, fingerprint), box.preview(t3Port)]);
    watch.lap("prepare VM, preview URL");
    if (setup.codexAuth) {
      await this.agents.adoptCodex(setup.codexAuth, vm.id);
      // A file VM Bridge did not adopt, such as another account's, is replaced after all.
      const ours = (await this.credentials(vm.provider)).codexAuthJson;
      if (ours && ours !== setup.codexAuth) await writeCodexAuth(box, ours);
      watch.lap("adopt Codex sign-in");
    }
    // Before T3 starts or VM Bridge sends it anything, so no agent on a woken VM runs with old skills.
    if (await this.syncSkills(vm.id, box, setup.skillsManifest)) watch.lap("sync skills");
    let restart = vm.t3Credentials !== fingerprint && (await idle(preview));
    // OpenCode reads the env file only as it starts. The next request for it starts it again. One that cannot be stopped
    // would keep the old sign-ins, so T3 keeps them too: the VM still counts as behind, and a later sweep tries again.
    if (restart && vm.opencodePassword) {
      this.opencodes.delete(vm.id);
      restart = await stopOpenCode(box).then(
        () => true,
        (error: unknown) => {
          this.failed("stop OpenCode", error, { vmId: vm.id, provider: vm.provider });
          return false;
        },
      );
    }
    // Ready for OpenCode, which starts while T3 does. After stopping OpenCode above, so that never stops one started now.
    this.prepared.add(vm.id);
    prepared(box);
    this.emit("wakeDetail", vm.id, "Starting T3");
    let server = await startT3(box, vm.t3Token, restart, setup.t3);
    watch.lap("start T3, session");
    if (server.descriptor.orchestrationProtocolVersion !== 2) {
      throw new Error(`T3 ${version} speaks orchestration protocol ${server.descriptor.orchestrationProtocolVersion}. VM Bridge supports 2.`);
    }
    if (restart && server.credentials !== fingerprint) this.unrestartable.set(vm.id, fingerprint);
    let backend = new Backend(vm.id, preview, server.token, this.openSocket);
    this.emit("wakeDetail", vm.id, "Waiting for T3 to answer");
    try {
      try {
        await backend.connect();
      } catch (error) {
        if (!(error instanceof TokenRejected)) throw error;
        server = await startT3(box, null);
        backend = new Backend(vm.id, preview, server.token, this.openSocket);
        await backend.connect();
      }
      watch.lap("open T3 socket");
      this.emit("wakeDetail", vm.id, "Reading T3's settings");
      this.store.updateVm(vm.id, { t3Token: server.token, t3Version: version, t3Credentials: server.credentials, lastConnectedAt: Date.now() });
      await this.onConnect(vm.id, backend);
      watch.lap("read T3 config");
    } catch (error) {
      await backend.close();
      throw error;
    }
    const connected = backend;
    connected.onClose = () => this.disconnected(vm.id, connected);
    this.backends.set(vm.id, connected);
    this.setState(vm.id, "ready");
    this.emit("awake", vm.id);
    return connected;
  }

  /** True when an awake VM's T3 server runs with older sign-ins or variables than VM Bridge now gives out. */
  stale(vmId: string) {
    const vm = this.store.vm(vmId);
    const latest = vm && this.latest.get(vm.provider);
    return Boolean(vm && latest && vm.t3Credentials !== latest && this.unrestartable.get(vmId) !== latest);
  }

  /** True when a VM, awake or asleep, has yet to start T3 with the current sign-ins and variables. */
  behind(vm: VmRow) {
    const latest = this.latest.get(vm.provider);
    return Boolean(latest && vm.t3Credentials !== null && vm.t3Credentials !== latest);
  }

  /**
   * Restarts T3 on an awake VM whose sign-ins changed since it started, so its agents get the new ones.
   * `idle` runs with the backend still connected and says whether nothing runs there; the restart is also
   * dropped when a request holds the VM. Streams it ends see a VM starting rather than a dropped connection,
   * and requests arriving meanwhile wait for it and use the new connection.
   */
  restart(vmId: string, idle: (backend: Backend) => Promise<boolean>) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      const backend = this.backend(vmId);
      const box = this.boxes.get(vmId);
      if (!vm || !backend || !box || vm.t3Credentials === credentialsFingerprint(await this.credentials(vm.provider), this.store.encryption)) return;
      if (!(await idle(backend))) return;
      // Nothing may wait between this check and taking the backend away, or new work could start on a closing socket.
      if (this.leased(vmId)) return;
      const started = performance.now();
      this.backends.delete(vmId);
      this.setState(vmId, "starting");
      await backend.close();
      try {
        await this.connect(vm, box, vm.t3Version ?? (await resolveT3Version(this.settings.get("t3Version"))), async () => true);
        this.traffic.record({ kind: "system", operation: "restart T3 for new sign-ins or variables", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        this.setState(vmId, "error", message(error));
        this.traffic.record({ kind: "system", operation: "restart T3 for new sign-ins or variables", vmId, status: "error" });
        this.emit("offline", vmId);
        throw error;
      }
    });
  }

  /** Writes the current sign-ins to every awake VM now. Git uses them at once; agents once T3 restarts. */
  async shareCredentials() {
    const awake = this.connected().flatMap((vmId) => {
      const box = this.boxes.get(vmId);
      return box ? [{ vmId, box }] : [];
    });
    // A VM's Codex may have refreshed its tokens since VM Bridge last saw them. Keep the newest before overwriting.
    for (const { vmId, box } of awake) {
      const current = await readCodexAuth(box);
      if (current) await this.agents.adoptCodex(current, vmId);
    }
    // One after another, as reading them can refresh the Codex sign-in.
    const byProvider = new Map<ProviderId, { credentials: VmCredentials; fingerprint: string }>();
    for (const provider of new Set(awake.flatMap(({ vmId }) => this.store.vm(vmId)?.provider ?? []))) {
      const credentials = await this.credentials(provider);
      byProvider.set(provider, { credentials, fingerprint: credentialsFingerprint(credentials, this.store.encryption) });
    }
    await Promise.all(
      awake.map(({ vmId, box }) =>
        this.exclusive(vmId, async () => {
          const vm = this.store.vm(vmId);
          const given = vm && byProvider.get(vm.provider);
          if (given && this.backend(vmId)) await writeCredentials(box, given.credentials, given.fingerprint);
        }).catch(() => this.traffic.record({ kind: "provider", operation: "write sign-ins", vmId, status: "error" })),
      ),
    );
  }

  /**
   * Brings a VM's skills and instructions up to date. A VM that never had any, and still should not, is left alone.
   * `manifest` is the VM's skills manifest when the caller read it already. Returns whether anything changed on the VM.
   */
  private async syncSkills(vmId: string, box: Box, manifest?: string | null) {
    const vm = this.store.vm(vmId);
    const state = this.skills.state(Boolean(vm && hasScreen(vm.provider)));
    if (!state.skills.length && !state.instructions.length && !vm?.skills) return false;
    const started = performance.now();
    let changed: boolean;
    try {
      changed = await syncSkills(box, state, (name) => this.skills.files(name), manifest);
      if (changed) this.traffic.record({ kind: "provider", operation: "sync skills", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      this.traffic.record({ kind: "provider", operation: "sync skills", vmId, status: "error" });
      throw error;
    }
    this.store.updateVm(vmId, { skills: state.fingerprint });
    return changed;
  }

  /**
   * Gives every awake VM the installed skills now, busy or not: they are only files, so nothing restarts and running
   * turns go on. Sleeping VMs get them when they wake, and VMs still waking get them before they connect.
   */
  async shareSkills() {
    await Promise.all(
      [...this.boxes.keys()].map((vmId) =>
        this.exclusive(vmId, async () => {
          const box = this.boxes.get(vmId);
          const vm = this.store.vm(vmId);
          if (!box || !vm || !this.backend(vmId) || vm.skills === this.skills.state(hasScreen(vm.provider)).fingerprint) return;
          await this.syncSkills(vmId, box);
        }).catch(() => {}),
      ),
    );
    this.emit("changed");
  }

  private async sleepBox(vmId: string, driver: Driver, box: Box) {
    this.boxes.delete(vmId);
    this.prepared.delete(vmId);
    const { checkpoint } = await driver.sleep(box);
    this.store.updateVm(vmId, { checkpoint: checkpoint ?? null, lastSleptAt: Date.now() });
  }

  /** The T3 connection to an awake VM dropped on its own: reconnect, as nothing else would. */
  private disconnected(vmId: string, backend: Backend) {
    if (this.backends.get(vmId) !== backend) return;
    this.backends.delete(vmId);
    this.traffic.record({ kind: "system", operation: "VM disconnected", vmId, status: "error" });
    const state = this.store.vm(vmId)?.state;
    // Before the socket's streams end, so they wait for the VM to come back rather than end.
    if (state === "ready" || state === "busy") this.setState(vmId, "starting");
    this.emit("offline", vmId);
    if (state === "ready" || state === "busy") void this.reconnect(vmId);
  }

  /**
   * Reconnects to a VM whose T3 connection dropped, with short pauses between tries. When every try fails the VM is put
   * to sleep, so it does not keep running, and billing, while nothing can see or use it.
   */
  private async reconnect(vmId: string) {
    for (const pause of this.reconnectPausesMs) {
      await sleep(pause);
      const state = this.store.vm(vmId)?.state;
      // Stopping, removed, put to sleep, or reconnected by a request meanwhile.
      if (this.closed || !state || state === "sleeping" || state === "gone" || this.backend(vmId)) return;
      try {
        await this.ensure(vmId);
        return;
      } catch {
        // `open` marked the VM as failed with the reason. Try again.
      }
    }
    if (this.closed || this.backend(vmId)) return;
    this.traffic.record({ kind: "system", operation: "Could not reconnect, sleeping VM", vmId, status: "error" });
    await this.sleep(vmId).catch(() => {});
  }

  private markGone(vmId: string) {
    this.prepared.delete(vmId);
    this.store.updateVm(vmId, { state: "gone", error: "The provider no longer has this VM." });
    this.store.removeVmFromProjects(vmId);
    this.emit("offline", vmId);
    this.emit("changed");
  }

  /**
   * Puts a VM to sleep. With `idle`, this is an idle sleep: `idle` runs with the backend still
   * connected and says whether the VM is still idle, and the sleep is also dropped when a request
   * holds the VM meanwhile. Once a sleep goes ahead, new requests wait for it and wake the VM again.
   */
  sleep(vmId: string, idle?: (backend: Backend) => Promise<boolean>) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      const backend = this.backends.get(vmId);
      // A checkpoint means the sandbox is already gone, such as after a failed wake put the VM back to sleep.
      if (!vm?.sandboxId || vm.checkpoint || vm.state === "sleeping" || vm.state === "gone") return;
      const started = performance.now();
      const driver = this.driver(vm.provider);
      const box = this.boxes.get(vmId) ?? (await driver.connect(vm.sandboxId));
      if (idle && backend?.open && !(await idle(backend))) return;
      // Nothing may wait between this check and taking the backend away, or new work could start on a closing socket.
      if (idle && this.leased(vmId)) return;
      this.backends.delete(vmId);
      // Before the socket closes, so streams it ends see a VM going to sleep rather than a dropped connection.
      this.setState(vmId, "sleeping");
      await backend?.close();
      this.emit("offline", vmId);
      try {
        await this.sleepBox(vmId, driver, box);
        this.emit("changed");
        const durationMs = Math.round(performance.now() - started);
        this.traffic.record({ kind: "provider", operation: "sleep VM", vmId, provider: vm.provider, status: "ok", durationMs });
        this.store.recordVmEvent(vm, "sleep", durationMs);
      } catch (error) {
        this.setState(vmId, "error", message(error));
        this.failed("sleep VM", error, { vmId, provider: vm.provider });
        throw error;
      }
    });
  }

  /**
   * OpenCode on an awake VM, started in its project's checkout on first use. It is never woken for: callers `ensure`
   * the VM first. A failed start is not kept, so the next request tries again.
   */
  async opencode(vmId: string, detail: (text: string) => void = () => {}): Promise<OpenCodeServer> {
    const cached = this.opencodes.get(vmId);
    const server = await cached?.catch(() => null);
    if (server && !server.expiring) return server;
    if (cached && this.opencodes.get(vmId) === cached) this.opencodes.delete(vmId);
    let flight = this.opencodes.get(vmId);
    if (!flight) {
      // Not under the VM's lock, which a wake holds until T3 answers. The lease keeps the VM from sleeping or restarting.
      flight = this.exclusive(`opencode:${vmId}`, () => this.startOpenCode(vmId, detail));
      this.opencodes.set(vmId, flight);
      const started = flight;
      started.catch(() => {
        if (this.opencodes.get(vmId) === started) this.opencodes.delete(vmId);
      });
    }
    return flight;
  }

  /** Drops what VM Bridge knows of a VM's OpenCode, such as after it stopped answering. The next request checks again. */
  forgetOpenCode(vmId: string, server: OpenCodeServer) {
    void this.opencodes.get(vmId)?.then((current) => {
      if (current === server) this.opencodes.delete(vmId);
    }, () => {});
  }

  private async startOpenCode(vmId: string, detail: (text: string) => void): Promise<OpenCodeServer> {
    const vm = this.store.vm(vmId);
    const box = this.machineReady(vmId) ? this.boxes.get(vmId) : undefined;
    if (!vm || !box) throw new Error(`VM ${vmId} is not awake.`);
    const release = this.lease(vmId);
    // It starts in the checkout this VM holds. Clients can work in any folder on the VM, such as a worktree.
    const checkout = this.store.projects().flatMap((project) => project.vms).find((entry) => entry.vmId === vmId)?.checkoutPath ?? checkoutRoot;
    const password = vm.opencodePassword ?? newToken();
    if (!vm.opencodePassword) this.store.updateVm(vmId, { opencodePassword: password });
    const started = performance.now();
    try {
      await startOpenCode(box, password, checkout, detail);
      const driver = this.driver(vm.provider);
      const preview = await (driver.preview ? driver.preview(box, opencodePort) : box.preview(opencodePort));
      this.traffic.record({ kind: "provider", operation: "start OpenCode", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      return new OpenCodeServer(vmId, preview, password, this.openSocket);
    } catch (error) {
      if (!(error instanceof NoOpenCodeKey)) this.traffic.record({ kind: "provider", operation: "start OpenCode", vmId, status: "error", reason: message(error) });
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Whether an agent may be running in OpenCode on an awake VM now. Asks the VM, so callers ask only when the answer
   * matters. A VM that could not be asked counts as busy, as T3 counts when it cannot be asked.
   */
  async openCodeBusy(vmId: string) {
    const box = this.box(vmId);
    return box ? openCodeBusy(box).catch(() => true) : false;
  }

  /** Extends provider-side auto-stop timers while agents work. */
  async keepAlive(vmId: string) {
    const vm = this.store.vm(vmId);
    const box = this.boxes.get(vmId);
    if (vm && box) await this.driver(vm.provider).keepAlive(box);
  }

  /** Deletes the VM at the provider. Its projects keep their other VMs, or get a new one next time. */
  destroy(vmId: string) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      if (!vm) return;
      this.backends.get(vmId)?.close();
      this.backends.delete(vmId);
      this.boxes.delete(vmId);
      this.prepared.delete(vmId);
      if (vm.sandboxId && vm.state !== "gone") await this.driver(vm.provider).destroy(vm.sandboxId);
      // A VM asleep as a checkpoint has no sandbox left, only the checkpoint.
      if (vm.checkpoint) await this.driver(vm.provider).deleteCheckpoint(vm.checkpoint);
      this.store.deleteVm(vmId);
      this.store.recordVmEvent(vm, "delete");
      this.traffic.record({ kind: "provider", operation: "delete VM", vmId, status: "ok" });
      // A replaced base snapshot this VM was made from may only now be deletable.
      void this.bases.sweep(vm.provider).catch(() => {});
      this.emit("offline", vmId);
      this.emit("changed");
    });
  }

  /** Provider and size for a new VM holding this repository: its rule, else the defaults. */
  placement(url: string): { provider: ProviderId; size: VmSize } {
    const name = githubName(url)?.toLowerCase();
    const rule = name ? this.settings.get("repoRules").find((entry) => entry.repo.toLowerCase() === name) : undefined;
    // A rule naming a provider that was removed since falls back to the default.
    // So does one naming a provider still setting up.
    const ruled = rule?.provider && this.settings.get("providers").includes(rule.provider) && !this.settingUp(rule.provider) ? rule.provider : null;
    const provider = ruled ?? this.available();
    return { provider, size: rule?.size ?? this.defaultSize(provider) };
  }

  /** A VM to read T3's configuration from when none is cached: any existing VM, or a new one. Concurrent callers share one. */
  any(): Promise<string> {
    const added = this.settings.get("providers");
    const vms = this.store.vms().filter((vm) => added.includes(vm.provider) && vm.state !== "gone" && vm.sandboxId);
    const awake = vms.find((vm) => this.backend(vm.id));
    if (awake) return Promise.resolve(awake.id);
    this.bootstrapping ??= (async () => {
      const vmId = vms[0]?.id ?? (await this.create()).id;
      await this.ensure(vmId);
      return vmId;
    })().finally(() => (this.bootstrapping = undefined));
    return this.bootstrapping;
  }

  /**
   * The project's primary VM, creating, cloning and registering it as needed.
   * A VM without a project (such as the first one, started to read T3's configuration) is reused.
   */
  place(projectId: string, progress: (detail: string) => void = () => {}, forOpenCode = false): Promise<string> {
    const key = forOpenCode ? `opencode:${projectId}` : projectId;
    let flight = this.placing.get(key);
    if (!flight) {
      flight = this.exclusive(`project:${projectId}`, () => this.placePrimary(projectId, progress, undefined, forOpenCode)).finally(() =>
        this.placing.delete(key),
      );
      this.placing.set(key, flight);
    }
    return flight;
  }

  /**
   * The VM a new top-level thread of this project runs on (see `choose`): one of the project's VMs with
   * room, waking it if it sleeps, else a new VM like the primary, else the least loaded one with a notice.
   * Threads already running never move. `placed` runs before the next placement for this project starts,
   * so it can count the thread toward that VM's load before T3 reports it.
   */
  placeThread(
    projectId: string,
    options: {
      /** Only these VMs, as when the thread starts from a branch only they have, unless none of them can take it. */
      only?: ReadonlySet<string>;
      load: (vm: VmRow) => VmLoad;
      placed: (vmId: string) => void;
      progress: (detail: string) => void;
      /** What the current step is doing now, while a VM wakes. */
      detail?: (text: string) => void;
      /** For OpenCode, which needs the VM prepared but not T3, so placement does not wait for T3 (see `machine`). */
      forOpenCode?: boolean;
    },
  ): Promise<ThreadPlacement> {
    const { only, load, placed, progress, detail, forOpenCode = false } = options;
    return this.exclusive(`project:${projectId}`, async () => {
      const primary = await this.placePrimary(projectId, progress, detail, forOpenCode);
      // VMs that failed to wake or set up during this placement.
      const failed = new Set<string>();
      for (;;) {
        const project = this.project(projectId);
        const vms = project.vms.flatMap(({ vmId }) => {
          const vm = this.store.vm(vmId);
          return vm && vm.state !== "gone" && !failed.has(vmId) ? [vm] : [];
        });
        const holders = only ? vms.filter((vm) => only.has(vm.id)) : [];
        const loads = (holders.length ? holders : vms).map(load);
        const retryAt = (this.overflowFailedAt.get(projectId) ?? -Infinity) + overflowRetryMs;
        // A new VM would not have the branch either.
        const choice = choose(loads, !holders.length && project.vms.length < maxVmsPerProject && Date.now() >= retryAt);
        if (!choice) throw new Error("None of this project's VMs could start, and VM Bridge could not add one.");
        if (choice.kind === "create") {
          const like = this.store.vm(primary);
          const target = like && !this.settingUp(like.provider) ? { provider: like.provider, size: like.size } : this.placement(project.url);
          let vmId: string | undefined;
          try {
            vmId = await this.addVm(project, progress, { ...target, discardOnError: true });
            await this.setUp(vmId, projectId, progress, detail, forOpenCode);
            this.overflowFailedAt.delete(projectId);
            placed(vmId);
            return { vmId, notice: null };
          } catch (error) {
            this.overflowFailedAt.set(projectId, Date.now());
            if (vmId) failed.add(vmId);
            this.traffic.record({ kind: "system", operation: `add a VM for ${project.title}: ${message(error)}`, vmId, status: "error" });
            continue;
          }
        }
        const { vmId } = choice.load;
        const ready = forOpenCode ? this.machineReady(vmId) : choice.load.awake;
        if (!ready || !project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath) {
          try {
            await this.setUp(vmId, projectId, progress, detail, forOpenCode);
          } catch (error) {
            // Nothing to fall back to from the primary: fail the launch as before. A spent budget refuses every wake.
            if (vmId === primary || error instanceof BudgetReached) throw error;
            failed.add(vmId);
            continue;
          }
        }
        placed(vmId);
        return { vmId, notice: choice.room ? null : busyNotice(choice.load) };
      }
    });
  }

  private project(projectId: string): ProjectRow {
    const project = this.store.project(projectId);
    if (!project) throw new Error("Unknown project.");
    return project;
  }

  private async placePrimary(projectId: string, progress: (detail: string) => void, detail?: (text: string) => void, forOpenCode = false): Promise<string> {
    const project = this.project(projectId);
    const primary = primaryVm(project);
    if (primary?.checkoutPath) return primary.vmId;
    const vmId = primary?.vmId ?? (await this.addVm(project, progress, this.placement(project.url)));
    await this.setUp(vmId, projectId, progress, detail, forOpenCode);
    return vmId;
  }

  /** Gives a project another VM: an idle one holding no project if one matches, else a new one. */
  private async addVm(
    project: ProjectRow,
    progress: (detail: string) => void,
    target: { provider: ProviderId; size: VmSize; discardOnError?: boolean },
  ): Promise<string> {
    const taken = new Set(this.store.projects().flatMap((p) => p.vms.map((entry) => entry.vmId)));
    const free = this.store
      .vms()
      .find((vm) => vm.provider === target.provider && vm.size === target.size && !taken.has(vm.id) && vm.state !== "gone" && vm.state !== "error" && vm.sandboxId);
    progress(free ? "Using an idle VM" : `Creating a VM on ${providers[target.provider].label}`);
    const vmId = free?.id ?? (await this.create(target)).id;
    this.store.addProjectVm(project.id, vmId);
    this.emit("changed");
    return vmId;
  }

  /**
   * Wakes one of a project's VMs and makes sure it holds the checkout and T3 knows the project. For OpenCode it waits
   * only until the VM is prepared, and T3 learns of a new checkout once it answers.
   */
  private async setUp(vmId: string, projectId: string, progress: (detail: string) => void, detail?: (text: string) => void, forOpenCode = false) {
    const project = this.project(projectId);
    let backend: Backend | undefined;
    if (forOpenCode) {
      if (!this.machineReady(vmId)) progress(this.wakeStep(vmId));
      await this.machine(vmId, detail);
    } else {
      if (!this.backend(vmId)) progress(this.wakeStep(vmId));
      backend = await this.ensureTelling(vmId, detail);
    }
    const existing = project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (existing) {
      // Cloned for OpenCode before T3 answered, then VM Bridge restarted before telling T3: tell it now.
      if (backend) await this.registered(vmId, project, existing, backend);
      return;
    }
    const release = this.lease(vmId);
    try {
      progress("Cloning the repository");
      const checkoutPath = await this.clone(vmId, project);
      if (backend) {
        progress("Registering the project with T3");
        await this.registered(vmId, project, checkoutPath, backend);
      } else {
        void this.ensure(vmId)
          .then((started) => this.registered(vmId, project, checkoutPath, started))
          .catch((error: unknown) => this.failed("register project", error, { vmId, provider: this.store.vm(vmId)?.provider }));
      }
      this.store.setCheckout(projectId, vmId, checkoutPath);
      this.emit("changed");
    } finally {
      release();
    }
  }

  /** `register`, once per VM and project while VM Bridge runs, shared by everyone asking at once. */
  private registered(vmId: string, project: ProjectRow, checkoutPath: string, backend: Backend): Promise<void> {
    const key = `${vmId}:${project.id}`;
    let done = this.registrations.get(key);
    if (!done) {
      done = this.register(backend, project, checkoutPath);
      done.catch(() => this.registrations.delete(key));
      this.registrations.set(key, done);
    }
    return done;
  }

  /**
   * Makes a worktree on a new `opencode/<name>` branch in the project's checkout on this awake VM, from origin's `base`
   * when it has that branch, else origin's default branch. Returns the branch it started from.
   */
  async worktree(vmId: string, projectId: string, base: string | null): Promise<{ name: string; path: string; branch: string; base: string }> {
    const box = this.boxes.get(vmId);
    const checkout = this.project(projectId).vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (!box || !checkout) throw new Error(`VM ${vmId} is not ready.`);
    const name = randomBytes(4).toString("hex");
    const path = worktreePath(checkout, name);
    const branch = `opencode/${name}`;
    const named = base ? `git rev-parse --verify --quiet ${quote(`refs/remotes/origin/${base}`)} >/dev/null && base=${quote(base)}` : "";
    const release = this.lease(vmId);
    try {
      const used = await runProgram(
        box,
        `. ${checkoutRoot}/.vmbridge/env
cd ${quote(checkout)}
GIT_TERMINAL_PROMPT=0 git fetch --quiet origin
base=""
${named}
[ -n "$base" ] || base="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
[ -n "$base" ] || base="$(git rev-parse --abbrev-ref HEAD)"
mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))}
git worktree add --quiet -b ${quote(branch)} ${quote(path)} "origin/$base" >&2
${fixWorktreeLinks(quote(checkout), quote(path))}
printf '%s' "$base"`,
        "Making a worktree",
      );
      return { name, path, branch, base: used };
    } finally {
      release();
    }
  }

  /** The step a wake shows, such as "Waking vm-3f2a1c on Daytona". */
  private wakeStep(vmId: string) {
    const vm = this.store.vm(vmId);
    return `${vm?.state === "sleeping" ? "Waking" : "Starting"} ${vm ? `${vm.name} on ${providers[vm.provider].label}` : "the VM"}`;
  }

  /**
   * Finds a worktree `worktree` made, to open it again, on `vmId` when VM Bridge noted where it is. Otherwise it looks
   * on the project's awake VMs first, then wakes the others in turn. Answers its VM and branch.
   */
  async findWorktree(
    projectId: string,
    name: string,
    progress: (detail: string) => void,
    detail?: (text: string) => void,
    vmId?: string,
  ): Promise<{ vmId: string; path: string; branch: string }> {
    const project = this.project(projectId);
    const entries = project.vms.filter((entry) => {
      const state = this.store.vm(entry.vmId)?.state;
      return entry.checkoutPath && state !== "gone" && state !== "error" && (!vmId || entry.vmId === vmId);
    });
    const awake = entries.filter((entry) => this.machineReady(entry.vmId));
    const asleep = entries.filter((entry) => !this.machineReady(entry.vmId));
    for (const entry of worktreeName.test(name) ? [...awake, ...asleep] : []) {
      if (!this.machineReady(entry.vmId)) progress(vmId ? this.wakeStep(entry.vmId) : `Waking ${this.store.vm(entry.vmId)?.name ?? entry.vmId} to look for it`);
      const box = await this.machine(entry.vmId, detail);
      const path = worktreePath(entry.checkoutPath!, name);
      const release = this.lease(entry.vmId);
      try {
        const branch = await runProgram(box, findWorktreeProgram(entry.checkoutPath!, name), "Opening the worktree");
        if (branch.trim()) return { vmId: entry.vmId, path, branch: branch.trim() };
      } finally {
        release();
      }
    }
    throw new WorktreeGone(`No worktree ${name} on ${project.title}'s VMs. It may have been removed.`);
  }

  /**
   * The worktrees `worktree` made that are on this VM, read from the VM itself, or null when it is not awake. Links git
   * cannot follow are mended on the way (see `fixWorktreeLinks`).
   */
  async worktreesOn(vmId: string, projectId: string): Promise<{ name: string; branch: string; changedAt: number }[] | null> {
    const box = this.machineReady(vmId) ? this.boxes.get(vmId) : undefined;
    const checkout = this.project(projectId).vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (!box || !checkout) return null;
    const release = this.lease(vmId);
    try {
      const lines = (await runProgram(box, listWorktreesProgram(checkout), "Listing worktrees", 30_000)).split("\n");
      return lines.flatMap((line) => {
        const [name = "", branch = "", changed = ""] = line.split("\t");
        return worktreeName.test(name) && branch ? [{ name, branch, changedAt: Number(changed) * 1000 || Date.now() }] : [];
      });
    } finally {
      release();
    }
  }

  /**
   * What the sidebar shows of a worktree, read on its VM: its branch, how far that is from origin's copy of `base`
   * (fetched at most every few minutes) and the dev servers started in it. Null while the VM is asleep or when the
   * worktree is gone. It holds no lease and notes no activity: the sidebar asks every minute, and that must not keep an
   * idle VM awake.
   */
  async worktreeState(vmId: string, projectId: string, name: string, base: string | null): Promise<WorktreeState | null> {
    const box = this.machineReady(vmId) ? this.boxes.get(vmId) : undefined;
    const checkout = this.project(projectId).vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (!box || !checkout || !worktreeName.test(name)) return null;
    const key = `${vmId}/${name}`;
    const fetch = Date.now() - (this.baseFetchedAt.get(key) ?? 0) > baseFetchMs;
    if (fetch) this.baseFetchedAt.set(key, Date.now());
    return readWorktreeState(await runProgram(box, worktreeStateProgram(checkout, name, base, fetch), "Reading a worktree's state", 30_000));
  }

  /**
   * A provider preview of the dev server on `port` on an awake VM, through the VM's relay (see `devRelayProgram`), or
   * null while the VM sleeps or OpenCode never ran on it, as the relay answers only with its password. A preview is
   * kept for the machine it was made on, which a wake replaces, until a minute before it expires. A page's first load
   * asks for many files at once, and they share one preview.
   */
  async portPreview(vmId: string, port: number): Promise<Preview | null> {
    const vm = this.store.vm(vmId);
    const box = this.machineReady(vmId) ? this.boxes.get(vmId) : undefined;
    if (!vm?.opencodePassword || !box) return null;
    const kept = this.relayPreviews.get(box);
    let preview = kept ? await kept.catch(() => null) : null;
    if (!preview || (preview.expiresAt !== undefined && preview.expiresAt - Date.now() < 60_000)) {
      // Another request may have started a new one while this waited.
      let making = this.relayPreviews.get(box);
      if (!making || making === kept) {
        const driver = this.driver(vm.provider);
        making = runProgram(box, devRelayProgram, "Relaying dev servers", 15_000).then(() =>
          driver.preview ? driver.preview(box, devRelayPort) : box.preview(devRelayPort),
        );
        const made = making;
        this.relayPreviews.set(box, made);
        made.catch(() => {
          if (this.relayPreviews.get(box) === made) this.relayPreviews.delete(box);
        });
      }
      preview = await making;
    }
    return { ...preview, headers: { ...preview.headers, [devRelayHeaders.port]: String(port), [devRelayHeaders.password]: vm.opencodePassword } };
  }

  /**
   * Removes a worktree `worktree` made once nothing in it would be lost (see `removeWorktreeProgram`). It stays while an
   * OpenCode agent runs on the VM, which may be working in it, and when the VM is asleep, which is not worth waking for.
   * Answers whether it is gone, and the branch a kept one is on when the VM said.
   */
  async removeWorktree(vmId: string, projectId: string, name: string): Promise<{ removed: boolean; branch?: string }> {
    const box = this.boxes.get(vmId);
    const checkout = this.project(projectId).vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    if (!box || !checkout || !worktreeName.test(name)) return { removed: false };
    const release = this.lease(vmId);
    try {
      if (await openCodeBusy(box)) return { removed: false };
      const answer = await runProgram(box, removeWorktreeProgram(checkout, name), "Removing a worktree");
      if (answer === "removed") return { removed: true };
      return { removed: false, branch: answer.replace(/^kept ?/, "").trim() || undefined };
    } finally {
      release();
    }
  }

  private async clone(vmId: string, project: ProjectRow): Promise<string> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} is not connected.`);
    const path = `${checkoutRoot}/${repoName(project.url)}`;
    const branch = project.branch ? `--branch ${quote(project.branch)} ` : "";
    const result = await box.run(
      `set -eu
. /workspace/.vmbridge/env
if [ -d ${quote(`${path}/.git`)} ]; then
  [ "$(git -C ${quote(path)} remote get-url origin)" = ${quote(project.url)} ] || { echo "${path} holds another repository" >&2; exit 3; }
else
  rm -rf ${quote(`${path}.cloning`)}
  GIT_TERMINAL_PROMPT=0 git clone ${branch}-- ${quote(project.url)} ${quote(`${path}.cloning`)}
  mv ${quote(`${path}.cloning`)} ${quote(path)}
fi`,
      { timeoutMs: 10 * 60_000 },
    );
    if (!result.ok) {
      const output = result.stderr.slice(-400);
      if (/not found|could not read|authentication|403|404/i.test(output)) {
        throw new Error("The VM could not read this repository. Check GitHub access in the VM Bridge dashboard.");
      }
      throw new Error(`Cloning failed: ${output}`);
    }
    return path;
  }

  private async register(backend: Backend, project: ProjectRow, checkoutPath: string) {
    const { projects } = await backend.json<{ projects: { id: string; workspaceRoot: string }[] }>("/api/projects");
    if (projects.some((p) => p.id === project.id)) return;
    const response = await backend.http("/api/projects/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId: project.id,
        title: project.title,
        workspaceRoot: checkoutPath,
      }),
    });
    if (!response.ok) throw new Error(`T3 refused to register the project (${response.status}).`);
  }

  /**
   * Deletes VMs at the provider that carry this bridge's label but that VM Bridge has no record of, such as one whose
   * create returned after VM Bridge stopped, and drops VMs whose create never finished. Only a sandbox whose key is one
   * VM Bridge gives its VMs or build VMs is touched, and none that an operation running now may still record.
   * Concurrent callers share one check. It is also a cheap test of the provider's key, so a success clears an earlier
   * failure from Setup.
   */
  reconcile(provider: ProviderId): Promise<void> {
    let flight = this.reconciling.get(provider);
    if (!flight) {
      const operation = "look for untracked VMs";
      flight = this.findUntracked(provider)
        .then(
          () => {
            this.reconciledAt.set(provider, Date.now());
            this.traffic.record({ kind: "provider", operation, provider, status: "ok" });
          },
          (error) => this.failed(operation, error, { provider }),
        )
        .finally(() => {
          this.reconciling.delete(provider);
          // The provider's flag in Accounts comes with the overview.
          this.emit("changed");
        });
      this.reconciling.set(provider, flight);
    }
    return flight;
  }

  private async findUntracked(provider: ProviderId) {
    const driver = this.driver(provider);
    const labels = this.labels();
    const listed = await driver.list(labels);
    for (const sandbox of listed) {
      // Checked here too, so a provider that ignored the filter cannot hand over another bridge's or anyone's machines.
      if (sandbox.labels.vmbridge !== labels.vmbridge || !sandbox.key) continue;
      const owner = vmKey.exec(sandbox.key)?.[1];
      if (!owner && !buildKey.test(sandbox.key)) continue;
      // Read now, not before listing, so a create or wake that finished meanwhile counts.
      if (this.store.vms().some((vm) => vm.sandboxId === sandbox.id)) continue;
      if (owner && this.locks.has(owner)) continue;
      if (!owner && (this.bases.running(provider) || this.store.builders(provider).some((base) => base.builder === sandbox.id))) continue;
      try {
        await driver.destroy(sandbox.id);
        console.log(`[reconcile ${provider}] deleted untracked VM ${sandbox.id}`);
        this.traffic.record({ kind: "provider", operation: "delete untracked VM", provider, status: "ok" });
      } catch (error) {
        this.failed("delete untracked VM", error, { provider });
      }
    }
    // A create cut short by a restart. Any VM it made at the provider was deleted above, or is retried next time.
    for (const vm of this.store.vms()) {
      if (vm.provider !== provider || vm.state !== "provisioning" || vm.sandboxId || this.locks.has(vm.id)) continue;
      this.store.deleteVm(vm.id);
      console.log(`[reconcile ${provider}] dropped VM ${vm.id}, whose create never finished`);
      this.emit("changed");
    }
  }

  /** Records a failure in the dashboard log, which keeps it across restarts and flags its VM or provider. */
  private failed(operation: string, error: unknown, subject: { vmId?: string; provider?: ProviderId }) {
    this.traffic.record({ kind: "provider", operation, ...subject, status: "error", reason: message(error) });
  }

  /** Reconnects VMs that were awake when VM Bridge stopped, and cleans up after anything a stop cut short. */
  async resume() {
    // Providers removed since still hold their VMs.
    const used = new Set([...this.settings.get("providers"), ...this.store.vms().map((vm) => vm.provider)]);
    // So the dashboard can tell sleeping VMs behind on sign-ins or variables before any VM wakes.
    for (const provider of used) void this.credentials(provider).catch(() => {});
    // Builds first, so `reap` leaves their VMs alone.
    this.prepareBases();
    void this.bases.reap().catch(() => {});
    for (const provider of used) {
      void this.reconcile(provider);
      void this.bases.sweep(provider).catch(() => {});
    }
    for (const vm of this.store.vms()) {
      // A VM that failed while awake may still run. Connected, the idle sweep can put it to sleep.
      const awake = ["ready", "busy", "starting"].includes(vm.state) || (vm.state === "error" && mayBeAwake(vm));
      if (awake) void this.ensure(vm.id).catch(() => {});
    }
  }

  /** What VM Bridge gives a VM on `provider`. Kubi VMs also get the agents' screen tools, and Kubi's key for agents when set. */
  private async credentials(provider: ProviderId): Promise<VmCredentials> {
    const token = this.secrets.get("github.token");
    const account = this.settings.get("github");
    const github = token && account ? { token, login: account.login, name: account.name ?? account.login, email: account.email } : undefined;
    const env = envVars(this.secrets);
    const kubiKey = provider === "kubi" ? providerValues(this.settings, this.secrets, provider).agentKey : undefined;
    const credentials: VmCredentials = {
      ...(await this.agents.vmSecrets()),
      github,
      ...(Object.keys(env).length ? { env } : {}),
      ...(provider === "kubi" ? { screen: kubiKey ? { kubiKey } : {} } : {}),
    };
    const fingerprint = credentialsFingerprint(credentials, this.store.encryption);
    if (fingerprint !== this.latest.get(provider)) {
      this.latest.set(provider, fingerprint);
      this.emit("changed");
    }
    return credentials;
  }

  /**
   * Refreshes the Codex sign-in when it is due and gives the new tokens to every awake VM, before
   * Codex there refreshes on its own and retires the refresh token the other VMs hold.
   */
  async syncCodexAuth() {
    if (!this.agents.codexDue()) return;
    const boxes = [...this.boxes];
    let adopted = false;
    for (const [vmId, box] of boxes) {
      const current = await readCodexAuth(box);
      if (current && (await this.agents.adoptCodex(current, vmId))) adopted = true;
    }
    // The VM's own refresh retired the refresh token the other VMs hold, so they all need the adopted file.
    const authJson = await this.agents.refreshCodex(!adopted);
    if (!authJson) return;
    await Promise.all(boxes.map(([, box]) => writeCodexAuth(box, authJson).catch(() => {})));
  }

  close() {
    this.closed = true;
    for (const backend of this.backends.values()) backend.close();
    this.backends.clear();
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
