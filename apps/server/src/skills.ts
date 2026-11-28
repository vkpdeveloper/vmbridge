import type { Sql } from "./sql.ts";
import { EventEmitter } from "node:events";
import { skillNamePattern, skillUploadProblem, uploadLimits, type AgentKind, type LocalSkill, type SkillInfo, type SkillSearchResult, type SkillSource } from "@vmbridge/contracts";
import { Encryption } from "./encryption.ts";
import { Instructions } from "./instructions.ts";
import { Settings, type Plaintext } from "./settings.ts";
import { skillHash, skillsFingerprint, type SkillFile, type SkillsState } from "./vm/skills.ts";
import { screenSkill } from "./watch/skill.ts";

export class SkillError extends Error {}

/**
 * Skills and instructions files on the machine VM Bridge runs on, which it can install and keep in sync. Only Bun
 * has one (see bun/machine.ts): on Cloudflare Workers there are no local files, and skills and instructions come
 * from the dashboard and skills.sh only.
 */
export interface Machine {
  /** Skills in this machine's Claude Code and Codex skill folders. `dir` is the real folder. */
  skills(): { name: string; dir: string; description: string | null }[];
  /** Every file of a skill folder. Throws a `SkillError` when it is too big or has no SKILL.md. */
  readSkill(dir: string): SkillFile[];
  /** Whether a skill folder still has its SKILL.md. */
  hasSkill(dir: string): boolean;
  /** The real folder a path from the dashboard names, `~` allowed. Undefined when there is none. */
  resolve(path: string): string | undefined;
  /** A path as the dashboard shows it, the home folder as `~`. */
  tildify(path: string): string;
  /** An agent's global instructions file, its path as the dashboard shows it. */
  instructions(agent: AgentKind): { path: string; text: string } | undefined;
}

interface SkillRow {
  name: string;
  source: SkillSource;
  ref: string;
  description: string | null;
  hash: string;
  files: string;
  installedAt: number;
  updatedAt: number;
}

const columns = "name, source, ref, description, hash, files, installed_at AS installedAt, updated_at AS updatedAt";
const skillsSh = "https://skills.sh";
const validRepo = /^[\w.-]+\/[\w.-]+$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// A 1 MB skill can expand up to 6x in JSON when bytes are escaped as \uXXXX, plus path and envelope overhead.
const maxDownloadBytes = uploadLimits.skillBytes * 6 + 512 * 1024;

function decodeUtf8(bytes: Uint8Array, skillId: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new SkillError(`skills.sh sent invalid UTF-8 for ${skillId}.`);
    throw error;
  }
}

async function readBoundedText(response: Response, limit: number, skillId: string): Promise<string> {
  const rawLength = response.headers.get("content-length");
  const length = rawLength ? Number(rawLength) : NaN;
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new SkillError(`skills.sh download for ${skillId} is too large.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new SkillError(`skills.sh download for ${skillId} is too large.`);
    return decodeUtf8(bytes, skillId);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new SkillError(`skills.sh download for ${skillId} is too large.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeUtf8(combined, skillId);
}

/** The `description` from SKILL.md's front matter, including YAML's folded and literal block forms. */
export function skillDescription(skillMd: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1];
  if (!front) return null;
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) return null;
  let value = lines[at]!.slice("description:".length).trim();
  if (!value || /^[>|][+-]?$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line)) break;
      block.push(line.trim());
    }
    value = block.join(" ");
  }
  value = value.replace(/^(["'])(.*)\1$/, "$2").trim();
  return value ? value.slice(0, 400) : null;
}

function describe(files: SkillFile[]) {
  const skillMd = files.find((file) => file.path === "SKILL.md");
  return skillMd ? skillDescription(Buffer.from(skillMd.data, "base64").toString("utf8")) : null;
}

/**
 * The skills every VM gets, kept in VM Bridge's database with their files: from skills.sh, uploaded in the dashboard,
 * or copied from a folder on this machine and re-read when that folder changes. With `syncAll`, every skill in this
 * machine's skill folders is installed that way. The agents' global instructions files go to every VM with them, in
 * the same sync. Emits `changed` whenever the set, a skill's or instructions file's content, or `syncAll` changes.
 */
export class Skills extends EventEmitter<{ changed: [] }> {
  private readonly settings: Settings;
  readonly instructions: Instructions;

  constructor(
    private readonly db: Sql,
    /** Skill files are stored encrypted: local skills can hold anything their folder does. */
    private readonly encryption: Encryption,
    /** Absent where VM Bridge has no local files, such as on Cloudflare Workers. */
    private readonly machine?: Machine,
  ) {
    super();
    this.settings = new Settings(db);
    this.instructions = new Instructions(db, encryption, this.settings, machine);
    this.instructions.on("changed", () => this.emit("changed"));
  }

  /** Whether VM Bridge can read skills and instructions files on the machine it runs on. */
  get hasMachine() {
    return this.machine !== undefined;
  }

  get syncAll() {
    return this.settings.get("syncLocalSkills");
  }

  /** Turning it off keeps the skills it installed until they are removed. */
  setSyncAll(sync: boolean) {
    this.settings.set("syncLocalSkills", sync);
    // The switch itself is part of what the dashboard shows, so it changed even when no skill did.
    if (!this.refreshLocal()) this.emit("changed");
  }

  private rows() {
    return this.db.all<SkillRow>(`SELECT ${columns} FROM skills ORDER BY name`);
  }

  private row(name: string) {
    return this.db.one<SkillRow>(`SELECT ${columns} FROM skills WHERE name = ?`, name);
  }

  list(): SkillInfo[] {
    return this.rows().map((row) => ({
      name: row.name,
      source: row.source,
      ref: row.source === "local" && this.machine ? this.machine.tildify(row.ref) : row.ref,
      description: row.description,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * What a VM should have. One with a screen also gets the skill that shows it (see watch/skill.ts), unless an
   * installed skill has its name: like on the VM, the user's skill wins.
   */
  state(screen = false): SkillsState {
    const skills = this.db.all<{ name: string; hash: string }>("SELECT name, hash FROM skills ORDER BY name");
    if (screen && !skills.some((skill) => skill.name === screenSkill.name)) skills.push({ name: screenSkill.name, hash: screenSkill.hash });
    const instructions = this.instructions.state();
    return { fingerprint: skillsFingerprint(skills, instructions), skills, instructions };
  }

  files(name: string): SkillFile[] {
    const row = this.row(name);
    if (!row && name === screenSkill.name) return screenSkill.files;
    if (!row) throw new Error(`The skill ${name} is no longer installed.`);
    return JSON.parse(this.encryption.open(row.files, `skill:${name}`)) as SkillFile[];
  }

  /**
   * Encrypts, or drops, skills and pasted instructions stored unencrypted (see `Plaintext`). Returns what it changed.
   */
  plaintext(action: Plaintext): string[] {
    const rows = this.db.all<{ name: string; files: string }>("SELECT name, files FROM skills")
      .filter((row) => !Encryption.isSealed(row.files));
    this.db.transaction(() => {
      for (const row of rows) {
        if (action === "seal") this.db.run("UPDATE skills SET files = ? WHERE name = ?", this.encryption.seal(row.files, `skill:${row.name}`), row.name);
        else this.db.run("DELETE FROM skills WHERE name = ?", row.name);
      }
    });
    return [...rows.map((row) => `skill ${row.name}`), ...this.instructions.plaintext(action)];
  }

  private write(name: string, source: SkillSource, ref: string, files: SkillFile[]) {
    const hash = skillHash(files);
    const existing = this.row(name);
    if (existing?.source === source && existing.ref === ref && existing.hash === hash) return false;
    const now = Date.now();
    this.db.run(
      `INSERT INTO skills (name, source, ref, description, hash, files, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET source = excluded.source, ref = excluded.ref, description = excluded.description, hash = excluded.hash,
           files = excluded.files, updated_at = excluded.updated_at`,
      name, source, ref, describe(files), hash, this.encryption.seal(JSON.stringify(files), `skill:${name}`), now, now,
    );
    return true;
  }

  private save(name: string, source: SkillSource, ref: string, files: SkillFile[]) {
    if (!this.write(name, source, ref, files)) return false;
    this.emit("changed");
    return true;
  }

  private claim(name: string, source: SkillSource, ref: string) {
    if (!skillNamePattern.test(name)) throw new SkillError(`${name} is not a usable skill folder name.`);
    const existing = this.row(name);
    if (existing && (existing.source !== source || existing.ref !== ref)) {
      const from = existing.source === "upload" ? "an upload" : existing.source === "local" && this.machine ? this.machine.tildify(existing.ref) : existing.ref;
      throw new SkillError(`A skill named ${name} is already installed from ${from}.`);
    }
  }

  async search(query: string): Promise<SkillSearchResult[]> {
    const response = await fetch(`${skillsSh}/api/search?${new URLSearchParams({ q: query })}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`skills.sh answered ${response.status}.`);
    const body = (await response.json()) as { skills?: unknown } | null;
    const skills = Array.isArray(body?.skills) ? body.skills : [];
    return skills.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const skill = entry as { source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown };
      if (typeof skill.source !== "string" || !validRepo.test(skill.source)) return [];
      if (typeof skill.skillId !== "string" || !skillNamePattern.test(skill.skillId)) return [];
      return [{
        source: skill.source,
        skillId: skill.skillId,
        name: typeof skill.name === "string" && skill.name ? skill.name : skill.skillId,
        installs: typeof skill.installs === "number" && Number.isFinite(skill.installs) ? skill.installs : 0,
      }];
    });
  }

  /** Installs, or updates to what skills.sh has now. Returns whether anything changed. */
  async installFromSkillsSh(source: string, skillId: string) {
    if (!validRepo.test(source)) throw new SkillError("Name the repository as owner/repo.");
    this.claim(skillId, "skills.sh", source);
    const [owner, repo] = source.toLowerCase().split("/") as [string, string];
    const url = `${skillsSh}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(skillId)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) throw new SkillError(`skills.sh has no files for ${source}/${skillId}.`);
    if (!response.ok) throw new Error(`skills.sh answered ${response.status}.`);
    const bodyText = await readBoundedText(response, maxDownloadBytes, skillId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new SkillError(`skills.sh sent an unreadable response for ${skillId}.`);
    }
    const rawFiles = parsed && typeof parsed === "object" ? (parsed as { files?: unknown }).files : undefined;
    if (!Array.isArray(rawFiles)) throw new SkillError(`skills.sh sent an unusable response for ${skillId}.`);
    if (rawFiles.length > uploadLimits.skillFiles) throw new SkillError(`${skillId} has more than ${uploadLimits.skillFiles} files.`);
    const files: SkillFile[] = [];
    const sizes: { path: string; size: number }[] = [];
    for (const entry of rawFiles) {
      if (!entry || typeof entry !== "object") throw new SkillError(`skills.sh sent an unusable file for ${skillId}.`);
      const { path, contents } = entry as { path?: unknown; contents?: unknown };
      if (typeof path !== "string" || typeof contents !== "string") {
        throw new SkillError(`skills.sh sent an unusable file for ${skillId}.`);
      }
      const buf = Buffer.from(contents, "utf8");
      files.push({ path, data: buf.toString("base64") });
      sizes.push({ path, size: buf.byteLength });
    }
    const problem = skillUploadProblem(skillId, sizes);
    if (problem) throw new SkillError(problem);
    const changed = this.db.transaction(() => {
      this.claim(skillId, "skills.sh", source);
      return this.write(skillId, "skills.sh", source, files);
    });
    if (changed) this.emit("changed");
    return changed;
  }

  async update(name: string) {
    const row = this.row(name);
    if (!row) throw new SkillError("That skill is not installed.");
    if (row.source === "local") throw new SkillError("Local skills update on their own when their files change.");
    if (row.source === "upload") throw new SkillError("Upload it again to update it.");
    return this.installFromSkillsSh(row.ref, row.name);
  }

  /**
   * Installs, or replaces, a skill uploaded in the dashboard. `files` comes straight from the request, so it is checked
   * here whatever the dashboard checked. Returns whether anything changed.
   */
  installUpload(name: string, files: unknown) {
    if (!Array.isArray(files)) throw new SkillError("Send the skill's files.");
    const checked: SkillFile[] = [];
    const sizes: { path: string; size: number }[] = [];
    for (const file of files as unknown[]) {
      const { path, data, executable } = (file ?? {}) as Record<string, unknown>;
      if (typeof path !== "string" || typeof data !== "string" || !base64.test(data) || (executable !== undefined && typeof executable !== "boolean")) {
        throw new SkillError("Each file needs a path and its contents in base64.");
      }
      checked.push({ path, data, ...(executable ? { executable: true } : {}) });
      sizes.push({ path, size: Buffer.from(data, "base64").length });
    }
    const problem = skillUploadProblem(name, sizes);
    if (problem) throw new SkillError(problem);
    this.claim(name, "upload", "");
    return this.save(name, "upload", "", checked);
  }

  /** Only a skill in this machine's skill folders, so the dashboard can't be used to read any other folder. */
  installLocal(path: string) {
    if (!this.machine) throw new SkillError("This VM Bridge has no local skill folders.");
    const dir = this.machine.resolve(path);
    // One answer for a missing folder and a forbidden one, so this can't be used to probe the disk either.
    const skill = this.machine.skills().find((found) => found.dir === dir);
    if (!skill) throw new SkillError(`${path} is not a skill in this machine's skill folders.`);
    this.claim(skill.name, "local", skill.dir);
    return this.save(skill.name, "local", skill.dir, this.machine.readSkill(skill.dir));
  }

  remove(name: string) {
    if (this.db.run("DELETE FROM skills WHERE name = ?", name)) this.emit("changed");
  }

  /** Skills in this machine's Claude Code and Codex skill folders. */
  discover(): LocalSkill[] {
    const machine = this.machine;
    if (!machine) return [];
    const names = new Set(this.rows().map((row) => row.name));
    return machine.skills().map(({ name, dir, description }) => ({ name, path: machine.tildify(dir), description, installed: names.has(name) }));
  }

  /**
   * Re-reads installed local skills, saving those whose files changed. A folder that is gone keeps its last copy, or
   * with `syncAll` is removed, and every skill new on this machine is installed. Two folders with the same skill name:
   * the first the machine lists wins. A skill too big to read is skipped, keeping any copy it had.
   */
  refreshLocal() {
    const machine = this.machine;
    if (!machine) return false;
    const all = this.syncAll;
    let changed = false;
    for (const row of this.rows().filter((entry) => entry.source === "local")) {
      let files: SkillFile[];
      try {
        files = machine.readSkill(row.ref);
      } catch {
        if (all && !machine.hasSkill(row.ref)) {
          this.remove(row.name);
          changed = true;
        }
        continue;
      }
      if (this.save(row.name, "local", row.ref, files)) changed = true;
    }
    if (!all) return changed;
    const names = new Set(this.rows().map((row) => row.name));
    for (const { name, dir } of machine.skills()) {
      if (names.has(name) || !skillNamePattern.test(name)) continue;
      names.add(name);
      try {
        if (this.save(name, "local", dir, machine.readSkill(dir))) changed = true;
      } catch {}
    }
    return changed;
  }
}
