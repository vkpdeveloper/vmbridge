import type { ProjectIcon, ProjectIconColor } from "@vmbridge/contracts";
import type { Sql } from "../sql.ts";
import type { Backend } from "../vm/backend.ts";
import { assetPrefix } from "./attachments.ts";

/** Stands where a VM ID goes in an asset URL, for a project logo VM Bridge keeps (see `ProjectIcons`). */
export const iconOwner = "icon";
/** The file name T3 gives a project with no logo file. */
const missingMarker = "project-favicon-missing";
/** Larger files are not kept: T3 shows them from the VM while it is awake. */
const maxIconBytes = 512 * 1024;
const t3AssetUrl = /^\/api\/assets\/[\w.-]+\/([^/\\?#\s]+)$/;

async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = response.headers.get("content-length") ?? "";
  if (/^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface StoredIcon {
  contentType: string;
  /** Hex SHA-256 of the bytes. It names the file in URLs, so only someone who has the logo can make its link. */
  revision: string;
  /** T3's file name for it, which carries T3's own revision. */
  name: string;
}

/**
 * The logo T3 finds in each project's repository, such as a favicon, kept from the last time a VM holding the
 * project was awake. The dashboard shows it, and T3 clients get it while the VM sleeps, when T3 cannot serve it.
 */
export class ProjectIcons {
  private readonly refreshing = new Set<string>();

  constructor(private readonly db: Sql) {}

  get(projectId: string): StoredIcon | undefined {
    return this.db.one<StoredIcon>("SELECT content_type AS contentType, revision, name FROM project_icons WHERE project_id = ?", projectId);
  }

  file(revision: string) {
    const row = this.db.one<{ contentType: string; data: Uint8Array<ArrayBuffer> | ArrayBuffer }>(
      "SELECT content_type AS contentType, data FROM project_icons WHERE revision = ?",
      revision,
    );
    return row && new Blob([row.data], { type: row.contentType });
  }

  /**
   * Asks the VM's T3 for a project's logo, the way T3 clients do, and keeps a copy. Skips the download when T3's
   * file name, which changes with the file, is the one kept. A failure keeps the last copy.
   */
  async refresh(projectId: string, cwd: string, backend: Pick<Backend, "call" | "http">) {
    if (this.refreshing.has(projectId)) return;
    this.refreshing.add(projectId);
    try {
      const result = await backend.call<{ relativeUrl?: unknown }>("assets.createUrl", { resource: { _tag: "project-favicon", cwd } }, 30_000);
      const relativeUrl = typeof result?.relativeUrl === "string" ? result.relativeUrl : "";
      const name = t3AssetUrl.exec(relativeUrl)?.[1];
      if (!name) return;
      if (name === missingMarker) {
        this.db.run("DELETE FROM project_icons WHERE project_id = ?", projectId);
        return;
      }
      if (this.get(projectId)?.name === name) return;
      const response = await backend.http(relativeUrl);
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!response.ok || !contentType.startsWith("image/")) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const bytes = await readBounded(response, maxIconBytes);
      if (!bytes) return;
      const revision = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      this.db.run(
        `INSERT INTO project_icons (project_id, content_type, data, revision, name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data,
           revision = excluded.revision, name = excluded.name, fetched_at = excluded.fetched_at`,
        projectId, contentType, bytes, revision, name, Date.now(),
      );
    } catch {
      // The VM went to sleep, or its T3 has no logo route. The last copy stays.
    } finally {
      this.refreshing.delete(projectId);
    }
  }
}

/** The URL T3 clients load a kept logo from. */
export function iconAssetUrl(icon: StoredIcon) {
  return `${assetPrefix}${iconOwner}.${icon.revision}/${encodeURIComponent(icon.name)}`;
}

/**
 * Headers for a kept logo. Its URL names its bytes, so it never changes. An SVG can hold scripts and VM Bridge's
 * origin also serves the dashboard, so one opened as a page is sandboxed.
 */
export function keptIconHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
  };
}

/** T3's colors for project letters, in T3's order: the color a name gets is picked by its place here. */
const colors: readonly ProjectIconColor[] = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];

/** T3's letters and color for a project with no icon of its own, worked out from its name as T3 does. */
export function nameIcon(title: string): { text: string; color: ProjectIconColor } {
  const name = title.normalize("NFKC").trim();
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  let text = "PR";
  const firstWord = words[0];
  if (firstWord) {
    const glyphs = Array.from(firstWord);
    const first = glyphs[0]!;
    const second = glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ?? (words.length > 1 ? Array.from(words.at(-1)!)[0] : glyphs.at(-1)) ?? first;
    text = Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
  }
  let index = 0;
  for (const glyph of name.toLocaleLowerCase("en-US") || "project") index = (index * 31 + glyph.codePointAt(0)!) % colors.length;
  return { text, color: colors[index]! };
}

/**
 * The icon T3 shows for a project, in T3's order: the one picked in T3, then the logo in its repository, then
 * letters from its name. A picked icon from T3's icon set is shown as letters in its color.
 */
export function projectIcon(projectId: string, title: string, picked: unknown, stored: StoredIcon | undefined): ProjectIcon {
  const choice = (picked ?? {}) as { kind?: unknown; text?: unknown; emoji?: unknown; color?: unknown };
  const color = colors.find((entry) => entry === choice.color);
  if (choice.kind === "monogram" && typeof choice.text === "string" && color) return { kind: "monogram", text: choice.text, color };
  if (choice.kind === "emoji" && typeof choice.emoji === "string") return { kind: "emoji", emoji: choice.emoji };
  if (choice.kind === "lucide" && color) return { kind: "monogram", text: nameIcon(title).text, color };
  if (stored) return { kind: "image", url: `/admin/api/projects/${encodeURIComponent(projectId)}/icon?v=${stored.revision}` };
  return { kind: "monogram", ...nameIcon(title) };
}
