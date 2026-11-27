import { primaryVm, type ProjectRow } from "../store.ts";
import { message } from "../fleet.ts";
import type { Hub } from "./hub.ts";
import { projectRoot, repoName } from "./paths.ts";
import { githubName, githubRepository, normalizeRemote } from "./repos.ts";
import { str, type Wire } from "./types.ts";

const canonical = (url: string) => {
  const github = githubName(url);
  return github ? `github.com/${github.toLowerCase()}` : url.replace(/\/+$/, "").replace(/\.git$/, "");
};

/**
 * Projects VM Bridge knows, and T3's clone flow for adding one. "Cloning" a project places it on
 * a VM: create or reuse the VM, clone the repository there, and register it with that VM's T3.
 */
export class Clones {
  private readonly snapshots = new Map<string, Wire>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly hub: Hub) {
    for (const snapshot of hub.store.clones<Wire>()) {
      const projectId = String(snapshot.projectId);
      // A clone cut short by a restart is reported failed, so T3 offers a retry.
      if (snapshot.phase === "running") {
        const project = hub.store.project(projectId);
        const done = Boolean(project && primaryVm(project)?.checkoutPath);
        this.snapshots.set(projectId, {
          ...snapshot,
          phase: done ? "done" : "failed",
          error: done ? null : "VM Bridge restarted during the clone. Retry to finish it.",
          endedAt: new Date().toISOString(),
          sequence: Number(snapshot.sequence) + 1,
        });
      } else this.snapshots.set(projectId, snapshot);
    }
  }

  list() {
    return [...this.snapshots.values()];
  }

  /** The project for a remote, if there is one. */
  find(reference: string): ProjectRow | null {
    const url = canonical(normalizeRemote(reference));
    return this.hub.store.projects().find((project) => canonical(project.url) === url) ?? null;
  }

  /** Adds a project for a remote, or returns the existing one. */
  add(reference: string, options: { branch?: string | null; title?: string; id?: string } = {}): ProjectRow {
    const url = normalizeRemote(reference);
    const existing = this.find(url);
    if (existing) return existing;
    if (options.branch && (!/^[\w./-]+$/.test(options.branch) || options.branch.startsWith("-") || options.branch.includes(".."))) {
      throw new Error("That is not a valid branch name.");
    }
    const id = options.id && /^[\w-]{1,128}$/.test(options.id) ? options.id : crypto.randomUUID();
    const project = {
      id,
      url,
      branch: options.branch ?? null,
      title: options.title?.trim() || repoName(url),
      createdAt: Date.now(),
    };
    this.hub.store.insertProject(project);
    this.hub.fleet.emit("changed");
    this.hub.emit("shell");
    return { ...project, vms: [] };
  }

  private checkout(project: ProjectRow) {
    const name = githubName(project.url);
    return {
      projectId: project.id,
      remoteUrl: project.url,
      repository: name ? githubRepository(name) : null,
      destinationPath: projectRoot(project),
    };
  }

  /** T3 `projectClone.start`. */
  start(input: Wire) {
    const reference = str(input.remoteUrl)?.trim() || str(input.repository) || "";
    const project = this.add(reference, { title: str(input.title), id: str(input.projectId) });
    const { destinationPath, ...result } = this.checkout(project);
    if (!this.running.has(project.id)) this.run(project);
    return { ...result, cwd: destinationPath };
  }

  /** T3 `projectClone.retry`. */
  retry(projectId: string) {
    const project = this.hub.store.project(projectId);
    if (!project || this.running.has(projectId) || this.snapshots.get(projectId)?.phase !== "failed") return false;
    this.run(project);
    return true;
  }

  private run(project: ProjectRow) {
    const previous = this.snapshots.get(project.id);
    let snapshot: Wire = {
      ...this.checkout(project),
      phase: "running",
      stage: "connecting",
      percent: null,
      detail: null,
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      sequence: Number(previous?.sequence ?? -1) + 1,
    };
    const publish = (next: Wire) => {
      snapshot = { ...snapshot, ...next, sequence: Number(snapshot.sequence) + 1 };
      this.snapshots.set(project.id, snapshot);
      this.hub.store.saveClone(project.id, snapshot);
      this.hub.emit("clones");
    };
    this.snapshots.set(project.id, snapshot);
    this.hub.store.saveClone(project.id, snapshot);
    this.hub.emit("clones");
    const job = this.hub.fleet
      .place(project.id, (detail) => publish({ detail }))
      .then(
        () => publish({ phase: "done", stage: "checkout", percent: 100, detail: null, endedAt: new Date().toISOString() }),
        (error) => publish({ phase: "failed", error: message(error).slice(0, 1000), endedAt: new Date().toISOString() }),
      )
      .finally(() => this.running.delete(project.id));
    this.running.set(project.id, job);
  }

  settle() {
    return Promise.all(this.running.values());
  }
}
