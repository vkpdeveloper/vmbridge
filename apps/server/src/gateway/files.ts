import type { Box } from "../providers/index.ts";
import { sleep } from "../runtime.ts";
import type { Sql } from "../sql.ts";
import type { ProjectRow } from "../store.ts";
import { githubHeaders } from "../github.ts";
import { quote } from "../vm/runtime.ts";
import { githubName, type RemoteBranches } from "./repos.ts";
import type { Wire } from "./types.ts";

/** One of T3's `ProjectEntry` values. */
export interface Entry {
  path: string;
  kind: "file" | "directory";
}

/** An entry with what ranking compares, lowercased once when the tree loads. */
interface Indexed extends Entry {
  lower: string;
  name: string;
}

interface Tree {
  /** Files and the folders they are in, top-level first: the order a bare "@" lists them in. */
  entries: Indexed[];
  /** GitHub stopped listing part way, so some files are missing. */
  truncated: boolean;
  fetchedAt: number;
}

/** A checkout or thread worktree on a VM, by its path there. */
export interface Worktree {
  projectId: string;
  path: string;
}

/** A tree older than this is still searched, and fetched again in the background. */
const freshMs = 5 * 60_000;
/** Trees kept in memory at once. The rest are read back from the database when searched again. */
const keptTrees = 16;
/** The most of a VM's file list that is read, about as much as GitHub's tree API gives before it truncates. */
const maxListingBytes = 8 * 1024 * 1024;
/** Paths per database row stay under Durable Object SQL's 2 MB value limit, even with multibyte names. */
const chunkChars = 500_000;
/** Files T3 offers when the composer asks for images only (T3's `PROJECT_FAVICON_EXTENSIONS`). */
const images = /\.(avif|bmp|gif|ico|heic|heif|jpeg|jpg|png|svg|tif|tiff|webp|icns)$/i;

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const collator = new Intl.Collator();

/** Paths, one per line, in rows of at most `chunkChars`. Always at least one row, so an empty list is kept too. */
function chunked(files: readonly string[]) {
  const chunks: string[] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const path of files) {
    if (size + path.length > chunkChars && chunk.length) {
      chunks.push(chunk.join("\n"));
      chunk = [];
      size = 0;
    }
    chunk.push(path);
    size += path.length + 1;
  }
  if (chunk.length || !chunks.length) chunks.push(chunk.join("\n"));
  return chunks;
}

const unchunked = (rows: readonly { paths: string }[]) => rows.flatMap((row) => (row.paths ? row.paths.split("\n") : []));

const listedKey = (vmId: string, path: string) => `vm\0${vmId}\0${path}`;

/** Every file and every folder above one, sorted shallow first, then by path. */
export function indexTree(files: readonly string[]): Indexed[] {
  const entries = new Map<string, Entry>();
  for (const path of files) {
    entries.set(path, { path, kind: "file" });
    for (let folder = parentOf(path); folder && !entries.has(folder); folder = parentOf(folder)) {
      entries.set(folder, { path: folder, kind: "directory" });
    }
  }
  const depth = (path: string) => path.split("/").length;
  return [...entries.values()]
    .map((entry) => ({ ...entry, depth: depth(entry.path), lower: entry.path.toLowerCase(), name: entry.path.slice(entry.path.lastIndexOf("/") + 1).toLowerCase() }))
    .sort((left, right) => left.depth - right.depth || collator.compare(left.path, right.path))
    .map(({ depth: _, ...entry }) => entry);
}

// Ranking is T3's own (`scoreSubsequenceMatch` and `scoreQueryMatch` in t3code packages/shared/src/searchRanking.ts),
// ported because the matcher T3's server uses, fff, is a native library that indexes a folder on disk. Lower is better.

/**
 * Scores at or above this found the term only as a scattered subsequence. T3 adds 100; this is higher so no whole
 * match, whose score grows with where in a long path it is, reaches it.
 */
const fuzzyBase = 10_000;
/** Each kind of match in `score` ranks after every match of the kind before. */
const tier = 1_000_000;

function subsequence(value: string, query: string): number | null {
  let queryIndex = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== query[queryIndex]) continue;
    if (first === -1) first = index;
    if (previous !== -1) gaps += index - previous - 1;
    previous = index;
    queryIndex++;
    if (queryIndex === query.length) {
      const span = index - first + 1 - query.length;
      return first * 2 + gaps * 3 + span + Math.min(64, value.length - query.length);
    }
  }
  return null;
}

/** Exact, then prefix, then at a word boundary, then anywhere, then as a subsequence. */
function match(value: string, query: string, boundaries: readonly string[]): number | null {
  if (value === query) return 0;
  const length = Math.min(64, Math.max(0, value.length - query.length));
  if (value.startsWith(query)) return 2 + length;
  const at = value.indexOf(query);
  // A match at a boundary is also a match anywhere, so only a value with one is checked for boundaries.
  if (at !== -1) {
    let boundary = -1;
    for (const marker of boundaries) {
      const found = value.indexOf(marker + query);
      if (found !== -1 && (boundary === -1 || found < boundary)) boundary = found + marker.length;
    }
    return boundary === -1 ? 6 + at * 2 + length : 4 + boundary * 2 + length;
  }
  const fuzzy = subsequence(value, query);
  return fuzzy === null ? null : fuzzyBase + fuzzy;
}

/**
 * The term in the entry's own name, then in its folders, then scattered through its name, then through its path: a
 * file's name beats its folders', and a typed word found whole beats letters picked out of a longer name.
 */
function score(entry: Indexed, term: string): number | null {
  // A term with a slash in it names folders, so only the whole path can match it.
  const name = term.includes("/") ? null : match(entry.name, term, ["-", "_", ".", " "]);
  if (name !== null && name < fuzzyBase) return name;
  const path = match(entry.lower, term, ["/", "-", "_", ".", " "]);
  if (path !== null && path < fuzzyBase) return tier + path;
  if (name !== null) return 2 * tier + name;
  return path === null ? null : 3 * tier + path;
}

/** T3's `projects.searchEntries` over a list of entries, with T3's query rules and result shape. */
export function searchEntries(entries: readonly Indexed[], input: Wire, incomplete = false): { entries: Entry[]; truncated: boolean } {
  // As T3 normalizes it: a leading "@", "." or "/" is part of how the path was typed, not of the path.
  const query = String(input.query ?? "").trim().replace(/^[@./]+/, "").toLowerCase();
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, input.limit as number) : 80;
  const wanted = (entry: Indexed) =>
    input.imageOnly === true ? entry.kind === "file" && images.test(entry.path) : input.kind === undefined || entry.kind === input.kind;
  // Like T3's finder, words separated by spaces must all match.
  const terms = query.split(/\s+/).filter(Boolean);
  const ranked: { entry: Indexed; score: number }[] = [];
  for (const entry of entries) {
    if (!wanted(entry)) continue;
    let total = 0;
    for (const term of terms) {
      const termScore = score(entry, term);
      if (termScore === null) {
        total = -1;
        break;
      }
      total += termScore;
    }
    if (total >= 0) ranked.push({ entry, score: total });
  }
  // Entries come shallow first, and the sort is stable, so ties keep that order.
  if (terms.length) ranked.sort((left, right) => left.score - right.score);
  return {
    entries: ranked.slice(0, limit).map(({ entry }) => ({ path: entry.path, kind: entry.kind })),
    truncated: incomplete || ranked.length > limit,
  };
}

/**
 * The files of each project's checkouts and worktrees, so the composer's "@" menu can list them while their VM sleeps.
 * Kept in the database, and searched in memory. An awake VM is always asked instead.
 *
 * The list a VM gave as it went to sleep comes first: it has the worktree's uncommitted and unpushed files, and works
 * for any git host. Without one, the files GitHub has are listed, at the thread's branch when GitHub has it, and
 * otherwise the project's branch or the repository's default branch. A new thread's branch is often only on its VM
 * until it is pushed, and starts from the default.
 */
export class FileTrees {
  /** GitHub's trees by `<projectId> <ref>` and VMs' lists by `listedKey`, least recently searched first. */
  private readonly trees = new Map<string, Tree>();
  private readonly pending = new Map<string, Promise<Tree>>();

  constructor(
    private readonly db: Sql,
    private readonly githubToken: () => string | undefined,
    private readonly branches: Pick<RemoteBranches, "branches">,
    /** How long listing a VM's files may hold up its sleep. Lists that take longer are not waited for. */
    private readonly captureMs = 10_000,
  ) {}

  /**
   * T3's `projects.searchEntries` answer for `folder` (relative to the worktree root, "" for the root) of the worktree
   * at `worktree.path` on its VM, or at `branch` on GitHub when the VM gave no list. Undefined when neither can be read.
   */
  async search(project: ProjectRow, branch: string | null, folder: string, input: Wire, worktree?: { vmId: string; path: string }) {
    const tree = (worktree && this.listed(worktree.vmId, worktree.path)) ?? (await this.pushed(project, branch));
    if (!tree) return undefined;
    const scoped = folder
      ? tree.entries.flatMap((entry) => (entry.path.startsWith(`${folder}/`) ? [{ ...entry, path: entry.path.slice(folder.length + 1), lower: entry.lower.slice(folder.length + 1) }] : []))
      : tree.entries;
    return searchEntries(scoped, input, tree.truncated);
  }

  /**
   * Lists the files of each worktree on a VM about to sleep, as git sees them: committed or not, minus what it ignores.
   * Returns within `captureMs` whatever the VM does, so sleeping never waits long. A worktree that cannot be listed
   * keeps its last list. Lists of the VM's worktrees not named here are dropped, as their threads are gone.
   */
  async capture(vmId: string, box: Pick<Box, "run">, worktrees: readonly Worktree[]) {
    const named = new Set(worktrees.map((worktree) => worktree.path));
    for (const { path } of this.db.all<{ path: string }>("SELECT DISTINCT path FROM vm_file_lists WHERE vm_id = ?", vmId)) {
      if (named.has(path)) continue;
      this.db.run("DELETE FROM vm_file_lists WHERE vm_id = ? AND path = ?", vmId, path);
      this.trees.delete(listedKey(vmId, path));
    }
    const listing = Promise.all(
      worktrees.map(async ({ projectId, path }) => {
        const command = `git -C ${quote(path)} ls-files -z --cached --others --exclude-standard`;
        const result = await box.run(command, { timeoutMs: this.captureMs, maxOutputBytes: maxListingBytes }).catch(() => null);
        // A list cut short has lost its start, so it is not kept: the "@" menu falls back to GitHub's for this one.
        if (!result?.ok || result.truncated) return;
        // Unmerged files are listed once per side. A name with a line break cannot be kept, as for GitHub's.
        const files = [...new Set(result.stdout.split("\0"))].filter((file) => file && !file.includes("\n"));
        const tree = { entries: indexTree(files), truncated: false, fetchedAt: Date.now() };
        this.keep(listedKey(vmId, path), tree);
        this.saveListed(projectId, vmId, path, files, tree.fetchedAt);
      }),
    );
    await Promise.race([listing, sleep(this.captureMs)]);
  }

  /** Fetches again every tree kept for these projects, or each one's default tree when none is, as when their VM goes to sleep. */
  async refresh(projects: readonly ProjectRow[]) {
    await Promise.all(
      projects.map(async (project) => {
        const kept = this.db.all<{ ref: string }>("SELECT DISTINCT ref FROM file_trees WHERE project_id = ?", project.id).map((row) => row.ref);
        const refs = kept.length ? kept : [await this.ref(project, null)];
        await Promise.all(refs.flatMap((ref) => (ref ? [this.fetchTree(project, ref)] : [])));
      }),
    ).catch(() => {});
  }

  /** The list the VM gave for this worktree as it went to sleep. */
  private listed(vmId: string, path: string): Tree | undefined {
    const key = listedKey(vmId, path);
    let tree = this.trees.get(key);
    if (!tree) {
      const rows = this.db.all<{ paths: string; captured_at: number }>(
        "SELECT paths, captured_at FROM vm_file_lists WHERE vm_id = ? AND path = ? ORDER BY seq",
        vmId,
        path,
      );
      if (!rows.length) return undefined;
      tree = { entries: indexTree(unchunked(rows)), truncated: false, fetchedAt: rows[0]!.captured_at };
    }
    this.keep(key, tree);
    return tree;
  }

  /** The files GitHub has for the thread's branch, or for the branch it started from. */
  private async pushed(project: ProjectRow, branch: string | null) {
    const ref = await this.ref(project, branch).catch(() => null);
    return ref ? await this.tree(project, ref).catch(() => null) : null;
  }

  private async ref(project: ProjectRow, branch: string | null) {
    const remote = await this.branches.branches(project.url);
    const wanted = branch ?? project.branch;
    return wanted && remote.names.includes(wanted) ? wanted : (project.branch ?? remote.defaultBranch);
  }

  /** The kept tree, fetched again in the background once it is old, or a new one when none is kept. */
  private async tree(project: ProjectRow, ref: string): Promise<Tree> {
    const key = `${project.id} ${ref}`;
    const tree = this.trees.get(key) ?? this.load(project.id, ref);
    if (!tree) return this.fetchTree(project, ref);
    this.keep(key, tree);
    if (Date.now() - tree.fetchedAt > freshMs) void this.fetchTree(project, ref).catch(() => {});
    return tree;
  }

  private keep(key: string, tree: Tree) {
    this.trees.delete(key);
    this.trees.set(key, tree);
    for (const oldest of this.trees.keys()) {
      if (this.trees.size <= keptTrees) break;
      this.trees.delete(oldest);
    }
  }

  private load(projectId: string, ref: string): Tree | undefined {
    const rows = this.db.all<{ paths: string; truncated: number; fetched_at: number }>(
      "SELECT paths, truncated, fetched_at FROM file_trees WHERE project_id = ? AND ref = ? ORDER BY seq",
      projectId,
      ref,
    );
    if (!rows.length) return undefined;
    // An empty repository is kept as one empty row.
    return { entries: indexTree(unchunked(rows)), truncated: rows[0]!.truncated === 1, fetchedAt: rows[0]!.fetched_at };
  }

  /** Fetches a tree from GitHub and keeps it. Searches arriving meanwhile share the one request. */
  private fetchTree(project: ProjectRow, ref: string): Promise<Tree> {
    const key = `${project.id} ${ref}`;
    let running = this.pending.get(key);
    if (!running) {
      running = this.download(project, ref)
        .then((tree) => {
          this.keep(key, tree.tree);
          this.save(project.id, ref, tree.files, tree.tree);
          return tree.tree;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    return running;
  }

  private async download(project: ProjectRow, ref: string) {
    const name = githubName(project.url);
    if (!name) throw new Error("Only GitHub repositories can be searched while their VM sleeps.");
    const token = this.githubToken();
    const response = await fetch(`https://api.github.com/repos/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub answered ${response.status} for ${name}.`);
    }
    const body = (await response.json()) as { tree?: { path?: unknown; type?: unknown }[]; truncated?: boolean };
    // Blobs are files. Trees are folders, which come back from the files' paths; commits are submodules, not listed.
    const files = (body.tree ?? []).flatMap((entry) => (entry.type === "blob" && typeof entry.path === "string" && !entry.path.includes("\n") ? [entry.path] : []));
    return { files, tree: { entries: indexTree(files), truncated: body.truncated === true, fetchedAt: Date.now() } };
  }

  private save(projectId: string, ref: string, files: readonly string[], tree: Tree) {
    try {
      this.db.transaction(() => {
        this.db.run("DELETE FROM file_trees WHERE project_id = ? AND ref = ?", projectId, ref);
        chunked(files).forEach((paths, seq) => {
          this.db.run(
            "INSERT INTO file_trees (project_id, ref, seq, paths, truncated, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
            projectId,
            ref,
            seq,
            paths,
            tree.truncated ? 1 : 0,
            tree.fetchedAt,
          );
        });
      });
    } catch {
      // The project was removed while its tree was fetched. Memory still answers until it is dropped.
    }
  }

  private saveListed(projectId: string, vmId: string, path: string, files: readonly string[], capturedAt: number) {
    try {
      this.db.transaction(() => {
        this.db.run("DELETE FROM vm_file_lists WHERE vm_id = ? AND path = ?", vmId, path);
        chunked(files).forEach((paths, seq) => {
          this.db.run(
            "INSERT INTO vm_file_lists (project_id, vm_id, path, seq, paths, captured_at) VALUES (?, ?, ?, ?, ?, ?)",
            projectId,
            vmId,
            path,
            seq,
            paths,
            capturedAt,
          );
        });
      });
    } catch {
      // The project left the VM while it was listed. Memory still answers until it is dropped.
    }
  }
}
