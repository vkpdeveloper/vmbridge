import type { Sql } from "./sql.ts";
import type { ProviderId, VmSize, VmState } from "@vmbridge/contracts";
import { Encryption } from "./encryption.ts";
import type { Plaintext } from "./settings.ts";

export interface VmRow {
  id: string;
  provider: ProviderId;
  sandboxId: string | null;
  name: string;
  size: VmSize;
  state: VmState;
  error: string | null;
  t3Token: string | null;
  /** The password of the VM's OpenCode server, given the first time OpenCode starts there (see vm/opencode.ts). */
  opencodePassword: string | null;
  t3Version: string | null;
  /** Fingerprint of the sign-ins the VM's running T3 server started with (see `credentialsFingerprint`). */
  t3Credentials: string | null;
  /** Fingerprint of the skills the VM last got (see `skillsFingerprint`). */
  skills: string | null;
  checkpoint: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  lastConnectedAt: number | null;
  lastSleptAt: number | null;
}

/** One VM holding a project. */
export interface ProjectVm {
  vmId: string;
  /** Absolute checkout path on the VM, once cloned. */
  checkoutPath: string | null;
}

export interface ProjectRow {
  id: string;
  url: string;
  branch: string | null;
  title: string;
  createdAt: number;
  /** VMs holding this project, primary (the first added) first. */
  vms: ProjectVm[];
}

/** The VM a project's root path and new automations go to. */
export const primaryVm = (project: ProjectRow): ProjectVm | undefined => project.vms[0];

const vmColumns = `id, provider, sandbox_id AS sandboxId, name, size, state, error, t3_token AS t3Token, opencode_password AS opencodePassword,
  t3_version AS t3Version, t3_credentials AS t3Credentials, skills, checkpoint, created_at AS createdAt, last_activity_at AS lastActivityAt,
  last_connected_at AS lastConnectedAt, last_slept_at AS lastSleptAt`;

const projectColumns = `id, url, branch, title, created_at AS createdAt`;

const vmFields = {
  sandboxId: "sandbox_id",
  state: "state",
  error: "error",
  t3Token: "t3_token",
  opencodePassword: "opencode_password",
  t3Version: "t3_version",
  t3Credentials: "t3_credentials",
  skills: "skills",
  checkpoint: "checkpoint",
  lastActivityAt: "last_activity_at",
  lastConnectedAt: "last_connected_at",
  lastSleptAt: "last_slept_at",
} as const satisfies Partial<Record<keyof VmRow, string>>;

type VmUpdate = Partial<Pick<VmRow, keyof typeof vmFields>>;

const projectFields = { branch: "branch", title: "title" } as const;

type ProjectUpdate = Partial<Pick<ProjectRow, keyof typeof projectFields>>;

/** The snapshot new VMs of one provider and size start from. */
export interface BaseSnapshot {
  snapshot: string | null;
  /** `setupStamp` of what the snapshot holds. */
  stamp: string | null;
  createdAt: number | null;
  /** The sandbox building the next snapshot, kept until it is deleted so a build cut short by a restart is cleaned up. */
  builder: string | null;
}

const baseFields = { snapshot: "snapshot", stamp: "stamp", createdAt: "created_at", builder: "builder" } as const;

/** `start` is a new VM's first start, `wake` a start from sleep. */
export type VmEventKind = "create" | "start" | "wake" | "sleep" | "delete";

export interface VmEvent {
  at: number;
  vmId: string;
  provider: ProviderId;
  size: VmSize;
  kind: VmEventKind;
  durationMs: number | null;
}

/** One agent turn (a T3 run) VM Bridge saw. */
export interface Turn {
  threadId: string;
  runId: string;
  at: number;
  vmId: string;
  provider: ProviderId;
  /** The project's URL. */
  repo: string | null;
  /** T3's agent instance, such as `codex`. */
  agent: string | null;
  model: string | null;
}

/** JSON caches of what each VM's T3 server last reported, kept so sleeping VMs still render. */
type SnapshotKind = "shell" | "config" | "scheduled_tasks";

/** Under Durable Object SQL's 2 MB value limit: a UTF-16 unit takes at most 3 bytes of UTF-8. */
const projectionPartChars = 600_000;

/** `text` in parts of at most `size` units, never cut between the halves of a surrogate pair, which would not survive storing. */
function textParts(text: string, size: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function assignments<T extends object>(fields: Record<string, string>, update: T) {
  const entries = Object.entries(update).filter(([key]) => key in fields);
  return {
    sql: entries.map(([key]) => `${fields[key]} = ?`).join(", "),
    values: entries.map(([, value]) => value as string | number | null),
  };
}

/** Typed access to fleet, project, and routing tables. */
export class Store {
  /** Projects are read on every routed frame for path rewriting, so they are kept in memory. */
  private projectCache: ProjectRow[] | null = null;

  constructor(
    readonly db: Sql,
    readonly encryption: Encryption,
  ) {}

  vms(): VmRow[] {
    return this.db.all<VmRow>(`SELECT ${vmColumns} FROM vms ORDER BY created_at`)
      .map((vm) => this.openVm(vm));
  }

  vm(id: string): VmRow | null {
    const vm = this.db.one<VmRow>(`SELECT ${vmColumns} FROM vms WHERE id = ?`, id);
    return vm ? this.openVm(vm) : null;
  }

  /** The token for a VM's T3 server and its OpenCode password are stored encrypted. */
  private openVm(vm: VmRow): VmRow {
    return {
      ...vm,
      t3Token: vm.t3Token && this.encryption.open(vm.t3Token, `vm:${vm.id}:t3Token`),
      opencodePassword: vm.opencodePassword && this.encryption.open(vm.opencodePassword, `vm:${vm.id}:opencodePassword`),
    };
  }

  /** Encrypts, or drops, T3 tokens and OpenCode passwords stored unencrypted (see `Plaintext`). Returns what it changed. */
  plaintext(action: Plaintext): string[] {
    const rows = this.db.all<{ id: string; t3Token: string | null; opencodePassword: string | null }>(
      "SELECT id, t3_token AS t3Token, opencode_password AS opencodePassword FROM vms",
    );
    const plain = (value: string | null): value is string => value !== null && value !== "" && !Encryption.isSealed(value);
    const tokens = rows.filter((row) => plain(row.t3Token));
    const passwords = rows.filter((row) => plain(row.opencodePassword));
    const projects = this.db.all<{ id: string; password: string | null }>("SELECT id, opencode_password AS password FROM projects")
      .filter((row) => plain(row.password));
    this.db.transaction(() => {
      // Without a token, the VM's T3 server gets a new one when it next connects. Without a password, OpenCode gets a
      // new one when it next starts, and a project's clients need the new one from the dashboard.
      for (const row of tokens) this.updateVm(row.id, { t3Token: action === "seal" ? row.t3Token : null });
      for (const row of passwords) this.updateVm(row.id, { opencodePassword: action === "seal" ? row.opencodePassword : null });
      for (const row of projects) this.setOpenCodePassword(row.id, action === "seal" ? row.password : null);
    });
    return [
      ...tokens.map((row) => `T3 token of VM ${row.id}`),
      ...passwords.map((row) => `OpenCode password of VM ${row.id}`),
      ...projects.map((row) => `OpenCode password of project ${row.id}`),
    ];
  }

  insertVm(vm: Pick<VmRow, "id" | "provider" | "name" | "size" | "state" | "createdAt">) {
    this.db.run(
      "INSERT INTO vms (id, provider, name, size, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      vm.id, vm.provider, vm.name, vm.size, vm.state, vm.createdAt,
    );
  }

  updateVm(id: string, update: VmUpdate) {
    const sealed = { ...update };
    if (update.t3Token) sealed.t3Token = this.encryption.seal(update.t3Token, `vm:${id}:t3Token`);
    if (update.opencodePassword) sealed.opencodePassword = this.encryption.seal(update.opencodePassword, `vm:${id}:opencodePassword`);
    const { sql, values } = assignments(vmFields, sealed);
    if (sql) this.db.run(`UPDATE vms SET ${sql} WHERE id = ?`, ...values, id);
  }

  base(provider: ProviderId, size: VmSize): BaseSnapshot | null {
    return this.db.one<BaseSnapshot>(
      "SELECT snapshot, stamp, created_at AS createdAt, builder FROM base_snapshots WHERE provider = ? AND size = ?",
      provider, size,
    ) ?? null;
  }

  bases(provider: ProviderId): (BaseSnapshot & { size: VmSize })[] {
    return this.db.all<BaseSnapshot & { size: VmSize }>(
      "SELECT size, snapshot, stamp, created_at AS createdAt, builder FROM base_snapshots WHERE provider = ?",
      provider,
    );
  }

  /** Build VMs on record, of one provider or all. */
  builders(provider?: ProviderId): { provider: ProviderId; size: VmSize; builder: string }[] {
    return this.db.all<{ provider: ProviderId; size: VmSize; builder: string }>(
      "SELECT provider, size, builder FROM base_snapshots WHERE builder IS NOT NULL AND (?1 IS NULL OR provider = ?1)",
      provider ?? null,
    );
  }

  saveBase(provider: ProviderId, size: VmSize, update: Partial<BaseSnapshot>) {
    const { sql, values } = assignments(baseFields, update);
    this.db.run("INSERT INTO base_snapshots (provider, size) VALUES (?, ?) ON CONFLICT DO NOTHING", provider, size);
    if (sql) this.db.run(`UPDATE base_snapshots SET ${sql} WHERE provider = ? AND size = ?`, ...values, provider, size);
  }

  deleteBase(provider: ProviderId, size: VmSize) {
    this.db.run("DELETE FROM base_snapshots WHERE provider = ? AND size = ?", provider, size);
  }

  retiredSnapshots(provider: ProviderId): string[] {
    return this.db.all<{ snapshot: string }>("SELECT snapshot FROM retired_snapshots WHERE provider = ?", provider)
      .map((row) => row.snapshot);
  }

  retireSnapshot(provider: ProviderId, snapshot: string) {
    this.db.run("INSERT INTO retired_snapshots (provider, snapshot) VALUES (?, ?) ON CONFLICT DO NOTHING", provider, snapshot);
  }

  forgetRetired(provider: ProviderId, snapshot: string) {
    this.db.run("DELETE FROM retired_snapshots WHERE provider = ? AND snapshot = ?", provider, snapshot);
  }

  /** Forgets a VM. Its projects stay, on their other VMs or a fresh one next time they are used. */
  deleteVm(id: string) {
    // Its project_vms rows go with it (ON DELETE CASCADE).
    this.db.run("DELETE FROM vms WHERE id = ?", id);
    this.projectCache = null;
  }

  projects(): readonly ProjectRow[] {
    if (!this.projectCache) {
      const links = this.db.all<ProjectVm & { projectId: string }>(
        "SELECT project_id AS projectId, vm_id AS vmId, checkout_path AS checkoutPath FROM project_vms ORDER BY added_at, rowid",
      );
      this.projectCache = this.db.all<Omit<ProjectRow, "vms">>(`SELECT ${projectColumns} FROM projects ORDER BY created_at`)
        .map((project) => ({
          ...project,
          vms: links.filter((link) => link.projectId === project.id).map(({ vmId, checkoutPath }) => ({ vmId, checkoutPath })),
        }));
    }
    return this.projectCache;
  }

  project(id: string): ProjectRow | null {
    return this.projects().find((project) => project.id === id) ?? null;
  }

  insertProject(project: Omit<ProjectRow, "vms">) {
    this.db.run(
      "INSERT INTO projects (id, url, branch, title, created_at) VALUES (?, ?, ?, ?, ?)",
      project.id, project.url, project.branch, project.title, project.createdAt,
    );
    this.projectCache = null;
  }

  updateProject(id: string, update: ProjectUpdate) {
    const { sql, values } = assignments(projectFields, update);
    if (sql) this.db.run(`UPDATE projects SET ${sql} WHERE id = ?`, ...values, id);
    this.projectCache = null;
  }

  /** The password OpenCode clients give for this project (see gateway/opencode.ts), stored encrypted. Null until the dashboard makes one. */
  openCodePassword(projectId: string): string | null {
    const sealed = this.db.one<{ password: string | null }>("SELECT opencode_password AS password FROM projects WHERE id = ?", projectId)?.password;
    return sealed ? this.encryption.open(sealed, `project:${projectId}:opencodePassword`) : null;
  }

  setOpenCodePassword(projectId: string, password: string | null) {
    const sealed = password && this.encryption.seal(password, `project:${projectId}:opencodePassword`);
    this.db.run("UPDATE projects SET opencode_password = ? WHERE id = ?", sealed, projectId);
  }

  /** Adds a VM to a project, after its existing ones. */
  addProjectVm(projectId: string, vmId: string) {
    this.db.run("INSERT OR IGNORE INTO project_vms (project_id, vm_id, added_at) VALUES (?, ?, ?)", projectId, vmId, Date.now());
    this.projectCache = null;
  }

  setCheckout(projectId: string, vmId: string, checkoutPath: string) {
    this.db.run("UPDATE project_vms SET checkout_path = ? WHERE project_id = ? AND vm_id = ?", checkoutPath, projectId, vmId);
    this.projectCache = null;
  }

  /** The local branches a project's checkout on a VM had when VM Bridge last read them. */
  branches(projectId: string, vmId: string): string[] {
    const row = this.db.one<{ branches: string | null }>("SELECT branches FROM project_vms WHERE project_id = ? AND vm_id = ?", projectId, vmId);
    return row?.branches ? (JSON.parse(row.branches) as string[]) : [];
  }

  setBranches(projectId: string, vmId: string, branches: readonly string[]) {
    this.db.run("UPDATE project_vms SET branches = ? WHERE project_id = ? AND vm_id = ?", JSON.stringify(branches), projectId, vmId);
  }

  /** Takes a VM away from every project it held, such as when the provider lost it. */
  removeVmFromProjects(vmId: string) {
    this.db.run("DELETE FROM project_vms WHERE vm_id = ?", vmId);
    this.projectCache = null;
  }

  deleteProject(id: string) {
    this.db.run("DELETE FROM projects WHERE id = ?", id);
    this.projectCache = null;
  }

  snapshot<T>(vmId: string, kind: SnapshotKind): T | null {
    const row = this.db.one<{ value: string | null }>(`SELECT ${kind} AS value FROM vm_snapshots WHERE vm_id = ?`, vmId);
    return row?.value ? (JSON.parse(row.value) as T) : null;
  }

  snapshots<T>(kind: SnapshotKind): Map<string, T> {
    const rows = this.db.all<{ vmId: string; value: string }>(`SELECT vm_id AS vmId, ${kind} AS value FROM vm_snapshots WHERE ${kind} IS NOT NULL`);
    return new Map(rows.map((row) => [row.vmId, JSON.parse(row.value) as T]));
  }

  saveSnapshot(vmId: string, kind: SnapshotKind, value: unknown) {
    this.db.run(
      `INSERT INTO vm_snapshots (vm_id, ${kind}) VALUES (?, ?) ON CONFLICT (vm_id) DO UPDATE SET ${kind} = excluded.${kind}`,
      vmId, JSON.stringify(value),
    );
  }

  threadVm(threadId: string): string | null {
    return (
      this.db.one<{ vmId: string }>("SELECT vm_id AS vmId FROM threads WHERE id = ?", threadId)?.vmId ??
      null
    );
  }

  /** Every thread VM Bridge has placed, with its VM. */
  threads() {
    return this.db.all<{ id: string; vmId: string }>("SELECT id, vm_id AS vmId FROM threads");
  }

  /** Places a thread on a VM. Only VM Bridge's own placement calls this: a VM's report goes through `claimThread`. */
  setThreadVm(threadId: string, vmId: string) {
    this.db.run("INSERT INTO threads (id, vm_id) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET vm_id = excluded.vm_id", threadId, vmId);
  }

  /** A VM reporting a thread: it gets the thread when no VM has it yet. Returns whether the thread is that VM's. */
  claimThread(threadId: string, vmId: string): boolean {
    this.db.run("INSERT OR IGNORE INTO threads (id, vm_id) VALUES (?, ?)", threadId, vmId);
    return this.threadVm(threadId) === vmId;
  }

  command(id: string) {
    return this.db.one<{ vmId: string; fingerprint: string; threadId: string | null }>(
      "SELECT vm_id AS vmId, fingerprint, thread_id AS threadId FROM commands WHERE id = ?",
      id,
    );
  }

  saveCommand(id: string, vmId: string, fingerprint: string, threadId: string | null) {
    this.db.run("INSERT OR IGNORE INTO commands (id, vm_id, fingerprint, thread_id) VALUES (?, ?, ?, ?)", id, vmId, fingerprint, threadId);
  }

  /** The cached projection of a thread, as the VM holding it reported it. */
  projection<T>(threadId: string, vmId: string): T | null {
    const row = this.db.one<{ data: string }>("SELECT data FROM projections WHERE thread_id = ? AND vm_id = ?", threadId, vmId);
    if (!row) return null;
    const rest = this.db.all<{ data: string }>("SELECT data FROM projection_parts WHERE thread_id = ? ORDER BY seq", threadId);
    return JSON.parse(row.data + rest.map((part) => part.data).join("")) as T;
  }

  /** The stamp each of a VM's saved threads was saved with, by thread. Null for a copy saved without one. */
  projectionStamps(vmId: string): Map<string, string | null> {
    const rows = this.db.all<{ threadId: string; stamp: string | null }>("SELECT thread_id AS threadId, stamp FROM projections WHERE vm_id = ?", vmId);
    return new Map(rows.map((row) => [row.threadId, row.stamp]));
  }

  /** Keeps the newest projection: a late, older response never replaces a newer one from the same VM. */
  saveProjection(threadId: string, vmId: string, updatedAt: string | null, stamp: string | null, data: unknown) {
    const [first = "", ...rest] = textParts(JSON.stringify(data), projectionPartChars);
    this.db.transaction(() => {
      const saved = this.db.run(
        `INSERT INTO projections (thread_id, vm_id, updated_at, stamp, data) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (thread_id) DO UPDATE SET vm_id = excluded.vm_id, updated_at = excluded.updated_at, stamp = excluded.stamp, data = excluded.data
           WHERE projections.vm_id != excluded.vm_id OR projections.updated_at IS NULL OR excluded.updated_at IS NULL
             OR excluded.updated_at >= projections.updated_at`,
        threadId, vmId, updatedAt, stamp, first,
      );
      if (!saved) return;
      this.db.run("DELETE FROM projection_parts WHERE thread_id = ?", threadId);
      rest.forEach((part, index) => this.db.run("INSERT INTO projection_parts (thread_id, seq, data) VALUES (?, ?, ?)", threadId, index + 1, part));
    });
  }

  clones<T>(): T[] {
    return this.db.all<{ snapshot: string }>("SELECT snapshot FROM clones")
      .map((row) => JSON.parse(row.snapshot) as T);
  }

  saveClone(projectId: string, snapshot: unknown) {
    this.db.run(
      "INSERT INTO clones (project_id, snapshot) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET snapshot = excluded.snapshot",
      projectId, JSON.stringify(snapshot),
    );
  }

  recordVmEvent(vm: Pick<VmRow, "id" | "provider" | "size">, kind: VmEventKind, durationMs: number | null = null, at = Date.now()) {
    this.db.run(
      "INSERT INTO vm_events (at, vm_id, provider, size, kind, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
      at, vm.id, vm.provider, vm.size, kind, durationMs,
    );
  }

  /** How long the provider's latest wakes from sleep took, newest first. */
  recentWakeMs(provider: ProviderId, limit = 5): number[] {
    return this.db
      .all<{ ms: number }>("SELECT duration_ms AS ms FROM vm_events WHERE provider = ? AND kind = 'wake' AND duration_ms IS NOT NULL ORDER BY at DESC, id DESC LIMIT ?", provider, limit)
      .map((row) => row.ms);
  }

  vmEvents(from: number, to: number): VmEvent[] {
    return this.db.all<VmEvent>(
      "SELECT at, vm_id AS vmId, provider, size, kind, duration_ms AS durationMs FROM vm_events WHERE at >= ? AND at < ? ORDER BY at, id",
      from, to,
    );
  }

  /** Keeps the first sighting: the same run seen again changes nothing. */
  recordTurn(turn: Turn) {
    this.db.run(
      "INSERT OR IGNORE INTO turns (thread_id, run_id, at, vm_id, provider, repo, agent, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      turn.threadId, turn.runId, turn.at, turn.vmId, turn.provider, turn.repo, turn.agent, turn.model,
    );
  }

  turns(from: number, to: number): Turn[] {
    return this.db.all<Turn>(
      `SELECT thread_id AS threadId, run_id AS runId, at, vm_id AS vmId, provider, repo, agent, model
         FROM turns WHERE at >= ? AND at < ? ORDER BY at`,
      from, to,
    );
  }

  /** Background failures in a range, with the provider of their VM when they name only the VM. */
  errorsIn(from: number, to: number): { at: number; provider: ProviderId | null }[] {
    return this.db.all<{ at: number; provider: ProviderId | null }>(
      `SELECT e.at, COALESCE(e.provider, v.provider, (SELECT provider FROM vm_events WHERE vm_id = e.vm_id LIMIT 1)) AS provider
         FROM errors e LEFT JOIN vms v ON v.id = e.vm_id WHERE e.at >= ? AND e.at < ? ORDER BY e.at`,
      from, to,
    );
  }

  /** Thread commands applied while their VM was away, waiting to be replayed on it. Oldest first. */
  heldCommands(vmId: string) {
    return this.db.all<{ id: string; payload: string; createdAt: number }>(
      "SELECT id, payload, created_at AS createdAt FROM held_commands WHERE vm_id = ? ORDER BY created_at, rowid",
      vmId,
    )
      .map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.createdAt }));
  }

  holdCommand(id: string, vmId: string, payload: unknown, createdAt: number) {
    this.db.run(
      "INSERT OR IGNORE INTO held_commands (id, vm_id, payload, created_at) VALUES (?, ?, ?, ?)",
      id, vmId, JSON.stringify(payload), createdAt,
    );
  }

  dropHeldCommand(id: string) {
    this.db.run("DELETE FROM held_commands WHERE id = ?", id);
  }
}
