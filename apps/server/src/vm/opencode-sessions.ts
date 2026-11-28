import type { VmOpenCodeSession } from "@vmbridge/contracts";
import type { Fleet } from "../fleet.ts";
import type { Store } from "../store.ts";
import { worktreeName, worktreePath, type OpenCodeServer } from "./opencode.ts";

/** What the dashboard keeps of one OpenCode session. Provider and model are named as OpenCode's catalog names them. */
export interface OpenCodeSession {
  id: string;
  title: string | null;
  directory: string;
  provider: { id: string; name: string } | null;
  model: string | null;
  updatedAt: number;
  /** Ms since the epoch: when VM Bridge first saw its agent running, or null while it is not. */
  workingSince: number | null;
}

/** A session as OpenCode lists it: the ids of its provider and model, not their names. */
type ListedSession = Omit<OpenCodeSession, "provider" | "model"> & { providerId: string | null; modelId: string | null };

/** OpenCode 2's `GET /api/session`: the 50 newest sessions of every folder, without archived ones. */
interface SessionList {
  data?: {
    id?: unknown;
    title?: unknown;
    parentID?: unknown;
    model?: { id?: unknown; providerID?: unknown };
    time?: { updated?: unknown };
    location?: { directory?: unknown };
  }[];
}

/** `GET /api/model`: the models of the providers the server has a key for. */
interface ModelList {
  data?: { providerID?: unknown; modelID?: unknown; name?: unknown }[];
}

/** `GET /api/integration`: every provider OpenCode knows (its models.dev catalog), with or without a key. */
interface ProviderList {
  data?: { id?: unknown; name?: unknown }[];
}

/** Names from a VM's OpenCode, which changes only when its providers or version do. */
interface Catalog {
  at: number;
  providers: Map<string, string>;
  /** By `<providerID>/<modelID>`. */
  models: Map<string, string>;
}

const catalogMaxAgeMs = 6 * 60 * 60_000;
/**
 * An id the catalog lacks is looked up again no sooner than this. Right after OpenCode starts, before it has loaded its
 * models, it lists none, so this is short. A provider with no key, or a model since removed, stays missing.
 */
const catalogRetryMs = 60_000;

/** `GET /api/session/active`: an entry for each session whose agent is running, keyed by session ID. */
interface ActiveSessions {
  data?: Record<string, unknown>;
}

const get = async <T>(server: OpenCodeServer, path: string): Promise<T> => {
  const response = await server.fetch(path, { headers: new Headers(), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenCode answered ${response.status}.`);
  return (await response.json()) as T;
};

/** Reads a VM's OpenCode sessions, with two requests to the server itself. Subagents' sessions (with a parent) are left out. */
export async function readOpenCodeSessions(server: OpenCodeServer): Promise<ListedSession[]> {
  const [list, active] = await Promise.all([get<SessionList>(server, "/api/session?archived=false&limit=50"), get<ActiveSessions>(server, "/api/session/active")]);
  const working = new Set(Object.keys(active.data ?? {}));
  const sessions: ListedSession[] = [];
  for (const entry of list.data ?? []) {
    const directory = entry.location?.directory;
    if (typeof entry.id !== "string" || typeof directory !== "string" || entry.parentID !== undefined) continue;
    sessions.push({
      id: entry.id,
      title: typeof entry.title === "string" && entry.title ? entry.title : null,
      directory,
      providerId: typeof entry.model?.providerID === "string" ? entry.model.providerID : null,
      modelId: typeof entry.model?.id === "string" ? entry.model.id : null,
      updatedAt: typeof entry.time?.updated === "number" ? entry.time.updated : 0,
      workingSince: working.has(entry.id) ? Date.now() : null,
    });
  }
  return sessions;
}

async function readCatalog(server: OpenCodeServer): Promise<Catalog> {
  const [models, providers] = await Promise.all([get<ModelList>(server, "/api/model"), get<ProviderList>(server, "/api/integration")]);
  const catalog: Catalog = { at: Date.now(), providers: new Map(), models: new Map() };
  for (const { id, name } of providers.data ?? []) if (typeof id === "string" && typeof name === "string") catalog.providers.set(id, name);
  for (const { providerID, modelID, name } of models.data ?? []) {
    if (typeof providerID === "string" && typeof modelID === "string" && typeof name === "string") catalog.models.set(`${providerID}/${modelID}`, name);
  }
  return catalog;
}

/** A name from an id the catalog lacks: "anthropic/claude-opus-5-5" becomes "Claude Opus 5.5". */
export function readableName(id: string) {
  return (id.split("/").at(-1) ?? id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")
    .replace(/(\d) (?=\d)/g, "$1.");
}

function named(listed: ListedSession, catalog: Catalog | undefined): OpenCodeSession {
  const { providerId, modelId, ...session } = listed;
  return {
    ...session,
    provider: providerId ? { id: providerId, name: catalog?.providers.get(providerId) ?? readableName(providerId) } : null,
    model: modelId ? (providerId && catalog?.models.get(`${providerId}/${modelId}`)) || readableName(modelId) : null,
  };
}

/**
 * The branch VM Bridge last saw a worktree on. The `opencode/<name>` one `vb opencode` makes says nothing the worktree's
 * name does not, and `HEAD` is a detached checkout, so neither is shown: the agent may since have moved to a real branch,
 * which the next look at the worktree (the terminal's sidebar, `vb opencode resume`) notes.
 */
const usefulBranch = (worktree: { name: string; branch: string }) => worktree.branch !== `opencode/${worktree.name}` && worktree.branch !== "HEAD";

/**
 * Puts each session under its repository and branch from its folder, newest first. A session counts when its folder is a
 * project's checkout on this VM, or a worktree `vb opencode` noted there: the rest are in folders VM Bridge does not
 * manage, or worktrees since removed, which `vb opencode resume` cannot open.
 */
export function describeOpenCodeSessions(sessions: readonly OpenCodeSession[], vmId: string, store: Pick<Store, "projects" | "openCodeWorktrees">): VmOpenCodeSession[] {
  const described: VmOpenCodeSession[] = [];
  const projects = store.projects().flatMap((project) => {
    const checkout = project.vms.find((entry) => entry.vmId === vmId)?.checkoutPath;
    return checkout ? [{ project, checkout, worktrees: store.openCodeWorktrees(project.id).filter((row) => row.vmId === vmId) }] : [];
  });
  for (const session of sessions) {
    for (const { project, checkout, worktrees } of projects) {
      const prefix = worktreePath(checkout, "");
      const name = session.directory.startsWith(prefix) ? session.directory.slice(prefix.length) : null;
      const worktree = name !== null && worktreeName.test(name) ? worktrees.find((row) => row.name === name) : undefined;
      if (session.directory !== checkout && !worktree) continue;
      described.push({
        id: session.id,
        title: session.title ?? "Untitled",
        projectId: project.id,
        repository: project.title,
        branch: worktree && usefulBranch(worktree) ? worktree.branch : null,
        provider: session.provider,
        model: session.model,
        activity: session.workingSince
          ? { state: "working", since: session.workingSince }
          : // A session with a model has had a turn, which ended.
            session.model
            ? { state: "done", since: session.updatedAt }
            : { state: "idle", since: null },
        updatedAt: session.updatedAt,
        resumeCommand: worktree ? `vb opencode resume ${worktree.name}` : null,
      });
      break;
    }
  }
  return described.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The last OpenCode sessions read from each VM. Only an awake VM OpenCode ran on is asked (see `Fleet.runningOpenCode`),
 * so reading never wakes a VM or starts OpenCode. A VM that cannot be asked, such as a sleeping one, keeps its last list.
 */
export class OpenCodeSessions {
  private readonly latest = new Map<string, OpenCodeSession[]>();
  private readonly catalogs = new Map<string, Catalog>();

  constructor(private readonly fleet: Pick<Fleet, "connected" | "runningOpenCode" | "emit">) {}

  get(vmId: string): readonly OpenCodeSession[] {
    return this.latest.get(vmId) ?? [];
  }

  /** The catalog held for a VM, read again only when a session names an id it lacks, or after a long while. */
  private async catalog(vmId: string, server: OpenCodeServer, sessions: readonly ListedSession[]) {
    const held = this.catalogs.get(vmId);
    const missing = sessions.some(({ providerId, modelId }) => providerId && (!held?.providers.has(providerId) || (modelId && !held.models.has(`${providerId}/${modelId}`))));
    if (held && Date.now() - held.at < (missing ? catalogRetryMs : catalogMaxAgeMs)) return held;
    const fresh = await readCatalog(server).catch(() => held);
    if (fresh) this.catalogs.set(vmId, fresh);
    return fresh;
  }

  async refresh(vmId: string) {
    const server = await this.fleet.runningOpenCode(vmId);
    if (!server) return;
    const listed = await readOpenCodeSessions(server).catch(() => null);
    if (!listed) return;
    const catalog = await this.catalog(vmId, server, listed);
    // OpenCode does not say when a turn started, so a running one counts from when it was first seen running.
    const before = new Map(this.get(vmId).map((session) => [session.id, session.workingSince]));
    const sessions = listed.map((session) => named({ ...session, workingSince: session.workingSince && (before.get(session.id) ?? session.workingSince) }, catalog));
    if (JSON.stringify(sessions) === JSON.stringify(this.get(vmId))) return;
    this.latest.set(vmId, sessions);
    this.fleet.emit("changed");
  }

  async refreshAll() {
    await Promise.all(this.fleet.connected().map((vmId) => this.refresh(vmId)));
  }
}
