import { hashToken, newToken } from "../auth/tokens.ts";
import type { Sql } from "../sql.ts";
import type { Backend } from "../vm/backend.ts";
import { str, type Wire } from "./types.ts";

/** Where T3 clients send an upload's bytes, on VM Bridge and on each VM's T3 server alike. */
export const uploadPrefix = "/api/attachments/upload/";
/** Where T3 clients load assets, such as an attachment shown in a message. */
export const assetPrefix = "/api/assets/";

/** T3's per-file limits (`PROVIDER_SEND_TURN_MAX_*_BYTES`). The VM checks the rest when it gets the file. */
const maxImageBytes = 10 * 1024 * 1024;
export const maxUploadBytes = 50 * 1024 * 1024;
/** T3's `ATTACHMENT_UPLOAD_URL_TTL_MS`. */
const uploadUrlMs = 10 * 60_000;
/** How long an in-progress upload body may stream before a sweep reclaims an orphaned row. */
const receiveMs = 60 * 60_000;
/** How long an upload waits for the message that sends it, as long as T3 keeps its pending uploads. */
const keepMs = 24 * 60 * 60_000;
/** Durable Object SQL takes at most 2 MB in one value. */
const chunkBytes = 1024 * 1024;

/** T3's pending attachment IDs (`createPendingAttachmentId`), which VM Bridge mints in the same form. */
const pendingId = /^pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z0-9]{1,10})?$/;

/** T3's `attachmentFileExtension`, as an ID suffix. */
function idSuffix(name: string) {
  const extension = /\.([a-z0-9]{1,10})$/.exec(name.toLowerCase())?.[1];
  return `-${extension && extension !== "part" ? extension : "bin"}`;
}

interface Upload {
  id: string;
  type: "image" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
  state: "waiting" | "receiving" | "ready" | "sent";
  vmId: string | null;
  vmAttachmentId: string | null;
}

const columns =
  "id, type, name, mime_type AS mimeType, size_bytes AS sizeBytes, state, vm_id AS vmId, vm_attachment_id AS vmAttachmentId";

/**
 * Attachments a T3 client uploads before sending them. T3 asks for an upload URL without saying which thread the
 * file is for, so VM Bridge keeps the bytes itself and hands them to the thread's VM when a message names them,
 * under the ID that VM gives them. The bytes are dropped once the VM has them.
 */
export class Attachments {
  constructor(private readonly db: Sql) {}

  /** `attachments.createUploadUrl`: an upload slot with a one-use URL. */
  mint(input: Wire, clientId: string) {
    const type = input.type === "file" ? "file" : "image";
    const name = str(input.name)?.trim();
    const mimeType = str(input.mimeType)?.trim();
    const size = input.sizeBytes;
    const max = type === "file" ? maxUploadBytes : maxImageBytes;
    if (!name || name.length > 255 || !mimeType || mimeType.length > 100 || typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > max) {
      throw new Error("This attachment cannot be uploaded.");
    }
    const now = Date.now();
    this.sweep(now);
    const id = `pending-${crypto.randomUUID()}${type === "file" ? idSuffix(name) : ""}`;
    const token = newToken();
    const expiresAt = now + uploadUrlMs;
    this.db.run(
      "INSERT INTO attachment_uploads (id, token_hash, client_id, type, name, mime_type, size_bytes, state, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)",
      id, hashToken(token), clientId, type, name, mimeType, size, expiresAt,
    );
    return { attachmentId: id, relativeUrl: `${uploadPrefix}${token}`, expiresAt };
  }

  /** The bytes for an upload URL. Answers with T3's statuses: 204, 400 for a wrong size, 404 for an unknown or used URL. */
  async receive(token: string, request: Request): Promise<{ status: number; clientId?: string }> {
    const row = this.db.one<{ id: string; sizeBytes: number; clientId: string | null }>(
      "SELECT id, size_bytes AS sizeBytes, client_id AS clientId FROM attachment_uploads WHERE token_hash = ? AND state = 'waiting' AND expires_at > ?",
      hashToken(token), Date.now(),
    );
    if (!row) return { status: 404 };
    const clientId = row.clientId ?? undefined;
    const length = request.headers.get("content-length");
    if (length !== null && Number(length) !== row.sizeBytes) return { status: 400, clientId };
    // Claimed first with a streaming deadline so a second request cannot mix bytes in and sweeps keep active uploads alive.
    const claimedAt = Date.now();
    if (
      this.db.run(
        "UPDATE attachment_uploads SET state = 'receiving', expires_at = ? WHERE id = ? AND state = 'waiting' AND expires_at > ?",
        claimedAt + receiveMs,
        row.id,
        claimedAt,
      ) !== 1
    ) {
      return { status: 404 };
    }
    try {
      const stored = await this.store(row.id, row.sizeBytes, request.body);
      if (stored === "missing") return { status: 404, clientId };
      if (stored === "bad-size") {
        this.db.run("DELETE FROM attachment_uploads WHERE id = ?", row.id);
        return { status: 400, clientId };
      }
    } catch (error) {
      this.db.run("DELETE FROM attachment_uploads WHERE id = ?", row.id);
      throw error;
    }
    if (this.db.run("UPDATE attachment_uploads SET state = 'ready', expires_at = ? WHERE id = ? AND state = 'receiving'", Date.now() + keepMs, row.id) !== 1) {
      return { status: 404, clientId };
    }
    return { status: 204, clientId };
  }

  /** Saves the body in chunks. Reports whether the body matched `size` or the upload row vanished mid-stream. */
  private async store(id: string, size: number, body: ReadableStream<Uint8Array> | null): Promise<"ok" | "bad-size" | "missing"> {
    let received = 0;
    let seq = 0;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = (bytes: number) => {
      const chunk = new Uint8Array(bytes);
      let offset = 0;
      const rest: Uint8Array[] = [];
      for (const piece of pending) {
        const taken = Math.min(piece.byteLength, bytes - offset);
        chunk.set(piece.subarray(0, taken), offset);
        offset += taken;
        if (taken < piece.byteLength) rest.push(piece.subarray(taken));
      }
      pending = rest;
      pendingBytes -= bytes;
      if (!this.db.one("SELECT 1 FROM attachment_uploads WHERE id = ? AND state = 'receiving'", id)) return false;
      this.db.run("INSERT INTO attachment_chunks (upload_id, seq, data) VALUES (?, ?, ?)", id, seq++, chunk);
      return true;
    };
    const reader = body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > size) {
        await reader.cancel();
        return "bad-size";
      }
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= chunkBytes) {
        if (!flush(chunkBytes)) {
          await reader.cancel();
          return "missing";
        }
      }
    }
    if (pendingBytes > 0 && !flush(pendingBytes)) return "missing";
    return received === size ? "ok" : "bad-size";
  }

  /** `attachments.delete`. */
  remove(attachmentId: string) {
    this.db.run("DELETE FROM attachment_uploads WHERE id = ?", attachmentId);
  }

  /** Drops expired uploads and their chunks so abandoned files do not linger until the next upload. */
  sweep(now = Date.now()): number {
    return this.db.run("DELETE FROM attachment_uploads WHERE expires_at <= ?", now);
  }

  /** An upload that is complete and still held here, as T3 would answer for its own pending upload. */
  held(attachmentId: string) {
    return this.db.one<Upload>(`SELECT ${columns} FROM attachment_uploads WHERE id = ? AND state = 'ready' AND expires_at > ?`, attachmentId, Date.now());
  }

  /** A held upload's bytes. */
  file(attachmentId: string) {
    const upload = this.held(attachmentId);
    if (!upload) return undefined;
    // Durable Object SQL gives an ArrayBuffer for a BLOB, bun:sqlite a Uint8Array.
    const chunks = this.db.all<{ data: Uint8Array<ArrayBuffer> | ArrayBuffer }>("SELECT data FROM attachment_chunks WHERE upload_id = ? ORDER BY seq", attachmentId);
    return { upload, body: new Blob(chunks.map((chunk) => chunk.data), { type: upload.mimeType }) };
  }

  /**
   * Gives the VM every upload `payload` names, and returns the payload with each one's ID replaced by the ID the VM
   * gave it. An upload already given to this VM keeps its ID there, so a retried message does not send it again.
   */
  async handOver<T>(payload: T, vmId: string, backend: Backend): Promise<T> {
    const ids = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === "string" && pendingId.test(value)) ids.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(payload);
    const replaced = new Map<string, string>();
    for (const id of ids) {
      const upload = this.db.one<Upload>(`SELECT ${columns} FROM attachment_uploads WHERE id = ? AND expires_at > ?`, id, Date.now());
      // Not one of VM Bridge's: the VM answers for it as for any unknown attachment.
      if (upload) replaced.set(id, await this.send(upload, vmId, backend));
    }
    if (!replaced.size) return payload;
    const replace = (value: unknown): unknown => {
      if (typeof value === "string") return replaced.get(value) ?? value;
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      return value;
    };
    return replace(payload) as T;
  }

  private async send(upload: Upload, vmId: string, backend: Backend): Promise<string> {
    if (upload.state === "sent") {
      if (upload.vmId === vmId && upload.vmAttachmentId) return upload.vmAttachmentId;
      throw new Error(`Attachment '${upload.name}' went to another VM. Attach it again.`);
    }
    if (upload.state !== "ready") throw new Error(`Attachment '${upload.name}' has not finished uploading.`);
    const minted = await backend.call<Wire>("attachments.createUploadUrl", {
      ...(upload.type === "file" ? { type: "file" } : {}),
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
    });
    const attachmentId = str(minted.attachmentId);
    const relativeUrl = str(minted.relativeUrl);
    // Only T3's upload route: the request carries VM Bridge's session.
    if (!attachmentId || !relativeUrl || !/^\/api\/attachments\/upload\/[\w.-]+$/.test(relativeUrl)) {
      throw new Error(`The T3 server on VM ${vmId} gave no upload URL.`);
    }
    const file = this.file(upload.id);
    if (!file) throw new Error(`Attachment '${upload.name}' expired. Attach it again.`);
    const response = await backend.http(relativeUrl, {
      method: "POST",
      headers: { "content-type": upload.mimeType },
      body: file.body,
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) throw new Error(`The T3 server on VM ${vmId} refused attachment '${upload.name}' (${response.status}).`);
    this.db.transaction(() => {
      this.db.run("UPDATE attachment_uploads SET state = 'sent', vm_id = ?, vm_attachment_id = ? WHERE id = ?", vmId, attachmentId, upload.id);
      this.db.run("DELETE FROM attachment_chunks WHERE upload_id = ?", upload.id);
    });
    return attachmentId;
  }
}

/** Stands where a VM ID goes in an asset URL, for an upload VM Bridge still holds. VM IDs are 12 hex digits. */
export const heldOwner = "upload";
/** T3's asset URL (`AssetCreateUrlResult.relativeUrl`): a signed token, then a file name. */
const t3AssetUrl = /^\/api\/assets\/([\w.-]+)\/([^/\\?#\s]+)$/;
/** VM Bridge's: the same, with the VM that signed the token in front of it. */
export const bridgeAssetUrl = /^\/api\/assets\/([\da-z]+)\.([\w.-]+)\/([^/\\?#\s]+)$/;

/** A VM's asset URL as clients get it: on VM Bridge, which relays it to that VM. */
export function relayedAssetUrl(vmId: string, relativeUrl: unknown) {
  const match = typeof relativeUrl === "string" ? t3AssetUrl.exec(relativeUrl) : null;
  if (!match) throw new Error(`The T3 server on VM ${vmId} gave no asset URL.`);
  return `${assetPrefix}${vmId}.${match[1]}/${match[2]}`;
}

/** The URL of an upload VM Bridge holds, for a client checking its upload is still there. The ID is a random UUID. */
export function heldAssetUrl(upload: { id: string; name: string }) {
  const name = encodeURIComponent(upload.name).replace(/^\.{1,2}$/, "file");
  return `${assetPrefix}${heldOwner}.${upload.id}/${name}`;
}

/** Headers of a VM's asset response that clients get, such as the ranges a video player asks for. */
const assetHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "content-security-policy", "cache-control", "etag", "last-modified"];
/** T3's policy for HTML it serves: scripts run, in an opaque origin with no cookies or storage. */
const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

/**
 * A VM's asset response, as VM Bridge passes it on. VM Bridge's origin also serves the dashboard, and an agent can
 * change what the T3 server on its VM sends, so anything a browser could open as a page is sandboxed even when the
 * VM did not ask for it.
 */
export function relayedAsset(upstream: Response) {
  const headers = new Headers();
  for (const name of assetHeaders) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-content-type-options", "nosniff");
  const media = /^(?:image\/(?!svg)|audio\/|video\/|application\/pdf\b)/i.test(headers.get("content-type") ?? "");
  // A second policy of VM Bridge's own: browsers enforce every policy, so the VM's can only add restrictions.
  if (!media) headers.append("content-security-policy", sandbox);
  return new Response(upstream.body, { status: upstream.status, headers });
}
