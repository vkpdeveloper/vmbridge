import { deflateRawSync, inflateRawSync } from "node:zlib";
import { connectSandbox, SandboxError, type ErrorCode } from "@opencoredev/sandbox-sdk";
import { createHttpClient, type ExecInput, type ExecResult, type Fetch, type FileInfo, type HttpClient, type Provider, type SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { SelectOption } from "@vmbridge/contracts";
import { sleep } from "../runtime.ts";
import { notFound, sdkDriver } from "./sdk.ts";
import { required, type Box, type Credentials, type ProviderConfig, type ProviderDefinition, type ProviderState } from "./types.ts";

/**
 * Boat (boat.dev) over its HTTP API (https://boat.dev/api/v1), as a sandbox-sdk provider, so the SDK builds the same
 * `Box` on top. It reads its token on every request, so a signed-in connection's tokens can refresh while it runs
 * (see boat-sign-in.ts). An API key works the same way.
 *
 * VMs keep the SDK's Boat conventions, so VMs from earlier releases still list and connect: the key and labels are
 * deflated into the VM name, and commands run as the VM's user with /workspace made on first use.
 *
 * Boat keeps each command line in the VM's command history, so secrets never go in one: environment variables other
 * than the SDK's own and stdin go up as private files the command reads and removes.
 */

interface BoatEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
}

interface BoatSavedSnapshot {
  status: "saving" | "ready" | "failed";
  error?: string;
}

interface BoatSandbox {
  id: string;
  name?: string | null;
  state: string;
  createdAt?: string | number;
}

type CommandResult =
  | { kind: "finished"; stdout: string; stderr: string; exitCode: number | null; truncated: boolean }
  | { kind: "started"; processId: number }
  | { kind: "unknown" };

const apiUrl = "https://boat.dev/api/v1";
const machines = { small: "small", medium: "default", large: "large" } as const;
const running = new Set(["ready", "idle", "running"]);
const settling = new Set(["stopping", "archiving", "securing", "provisioning", "starting", "resuming", "queued"]);
const failed = new Set(["error", "failed", "deleted"]);

/** Boat stops a VM this long after it starts. VM Bridge sleeps idle VMs much sooner; this caps cost if it is down. */
const ttlSeconds = 12 * 60 * 60;

const metadataPrefix = "sandbox-sdk:1:";
/** Boat's limit on one file upload. Larger data goes up in parts. */
const partBytes = 4 * 1024 * 1024;
/** Files up to this size come back in the output of one command; larger ones through a signed download link. */
const inlineReadBytes = 16 * 1024;
/** Exit code of a guest file operation on a path that does not exist. */
const missingExit = 44;
/** Exit code when /workspace or a command's private files could not be set up, so the command itself never ran. */
const setupExit = 125;
/** How long a dropped output stream may take to come back. */
const reconnectMs = 60_000;

/** The SDK's own variables. They hold nothing secret, so they go on the command line. */
const plainEnv = new Set(["CI", "PAGER", "GIT_TERMINAL_PROMPT", "DEBIAN_FRONTEND", "TERM", "NO_COLOR", "SANDBOX_SDK_RUN", "GIT_INDEX_FILE"]);

/** Runs once per VM: the SDK runs commands in /workspace, which the VM's user cannot create alone. */
const prepareWorkspace = `flock -x /tmp/.sandbox-sdk-workspace-ready.lock sh -c 'if [ ! -f /tmp/.sandbox-sdk/prepared-workspace ]; then sudo mkdir -p /workspace && sudo chown "$(id -u):$(id -g)" /workspace && mkdir -p /tmp/.sandbox-sdk && touch /tmp/.sandbox-sdk/prepared-workspace || exit 1; fi'`;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const fail = (message: string, code: ErrorCode = "provider", sandboxId?: string) => new SandboxError(message, { code, provider: "boat", sandboxId });

/** The SDK's metadata in a VM name. Writing the same encoding keeps VMs from either version readable by both. */
function sdkName(key: string | undefined, labels: Record<string, string>) {
  const { "sandbox-sdk": _, ...rest } = labels;
  const name = metadataPrefix + deflateRawSync(JSON.stringify([key ?? null, rest])).toString("base64url");
  if (name.length > 120) throw fail("VM labels are too long for a Boat VM name.", "unsupported");
  return name;
}

function readName(name: string | null | undefined): Pick<SandboxInfo, "key" | "labels"> | undefined {
  if (!name?.startsWith(metadataPrefix)) return undefined;
  try {
    const [key, labels] = JSON.parse(inflateRawSync(Buffer.from(name.slice(metadataPrefix.length), "base64url"), { maxOutputLength: 65_536 }).toString()) as [unknown, unknown];
    if (key !== null && typeof key !== "string") return undefined;
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) return undefined;
    const entries = Object.entries(labels);
    if (!entries.every(([, value]) => typeof value === "string")) return undefined;
    return { ...(key === null ? {} : { key }), labels: { ...(Object.fromEntries(entries) as Record<string, string>), "sandbox-sdk": "1" } };
  } catch {
    return undefined;
  }
}

function info(sandbox: BoatSandbox): SandboxInfo {
  const metadata = readName(sandbox.name);
  if (!metadata) throw fail("This Boat VM was not made by VM Bridge.", "not_found", sandbox.id);
  return {
    id: sandbox.id,
    ...metadata,
    createdAt: new Date(sandbox.createdAt ?? Number.NaN).getTime(),
    state: running.has(sandbox.state) ? "running" : "stopped",
  };
}

function commandResult(value: unknown): CommandResult {
  if (!value || typeof value !== "object") return { kind: "unknown" };
  const result = value as Record<string, unknown>;
  if (typeof result.stdout === "string" && typeof result.stderr === "string" && (result.exitCode === null || typeof result.exitCode === "number")) {
    return {
      kind: "finished",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
    };
  }
  if (typeof result.processId === "number") return { kind: "started", processId: result.processId };
  return { kind: "unknown" };
}

/** One frame of a command's output stream: a JSON object per line. */
type Frame =
  | { type: "stdout" | "stderr"; data: string; nextOffset?: number }
  | { type: "attached" | "heartbeat" | "reconnect"; stdoutOffset?: number; stderrOffset?: number }
  | { type: "exit"; exitCode: number | null; timedOut?: boolean }
  | { type: "error" };

async function* lines(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (line) yield line;
    }
  }
  // A last line with no newline is a frame cut off when the stream dropped, so it is left out: the follower reconnects
  // from the offsets it has, and Boat sends that output again.
}

export interface BoatOptions {
  credentials: Credentials;
  /** For tests. Default: the global `fetch`. */
  fetch?: Fetch;
}

export type BoatProvider = Provider<{ client: HttpClient<"api"> }, never> & { client: HttpClient<"api"> };

export function boat(options: BoatOptions): BoatProvider {
  const { credentials } = options;
  const client = createHttpClient({
    provider: "boat",
    label: "Boat",
    planes: {
      api: {
        baseUrl: apiUrl,
        auth: async () => ({ authorization: `Bearer ${await credentials.token()}` }),
        refresh: () => credentials.refresh(),
      },
    },
    defaultPlane: "api",
    fetch: options.fetch,
    timeoutMs: 90_000,
    idempotencyHeader: "Idempotency-Key",
    secrets: () => credentials.secretValues(),
    authHint: "Connect Boat again in Accounts, or check the API key.",
  });

  const call = async <T>(request: () => Promise<T>, sandboxId?: string): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw fail(`Boat request failed: ${error instanceof Error ? error.message : String(error)}`, "provider", sandboxId);
    }
  };

  const sandbox = async (id: string) => (await client.json({ method: "GET", path: "/sandboxes/{sandboxId}", params: { sandboxId: id }, sandboxId: id })) as unknown as { sandbox: BoatSandbox };

  /** Runs one command and waits for it (`timeoutSeconds`), or starts it in the background (`detached`). */
  async function command(id: string, body: { command: string; timeoutSeconds?: number; detached?: boolean }, cleanup = false) {
    const request = { method: "POST" as const, path: "/sandboxes/{sandboxId}/commands", params: { sandboxId: id }, sandboxId: id, body };
    return commandResult((cleanup ? await client.cleanup(request) : await client.request(request)).json());
  }

  /** A short guest command's stdout. Exit 44 is a missing path. */
  async function guest(id: string, script: string, missing = false) {
    const result = await command(id, { command: script, timeoutSeconds: 60 });
    if (result.kind !== "finished") throw fail("Boat returned an unexpected result for a short command.", "outcome_unknown", id);
    if (result.truncated) throw fail("Boat cut short a command's output.", "provider", id);
    if (missing && result.exitCode === missingExit) throw fail("File does not exist", "file_not_found", id);
    if (result.exitCode !== 0) throw fail("A Boat file operation failed.", "provider", id);
    return result.stdout;
  }

  /** Runs a Node script in the VM with `args`. /workspace is made first when a path is under it. */
  const node = (id: string, script: string, args: string[]) => {
    const workspace = args.some((arg) => arg === "/workspace" || arg.startsWith("/workspace/"));
    const line = `node -e ${quote(`try {${script}} catch (e) { process.exit(e.code === 'ENOENT' ? ${missingExit} : 45) }`)} ${args.map(quote).join(" ")}`;
    return guest(id, workspace ? `${prepareWorkspace}; ${line}` : line, true);
  };

  const upload = (id: string, path: string, data: Uint8Array) =>
    client.request({
      method: "PUT",
      path: "/sandboxes/{sandboxId}/files",
      params: { sandboxId: id },
      sandboxId: id,
      body: { path, content: Buffer.from(data).toString("base64"), encoding: "base64" },
    });

  /**
   * Uploads files into a new directory only the VM's user can read, each in parts of at most `partBytes`. Returns the
   * shell line that joins each file's parts into `dir/<name>`, and each file's part paths.
   */
  async function stage(id: string, dir: string, files: Record<string, Uint8Array>) {
    const parts = Object.fromEntries(
      Object.entries(files).map(([name, data]) => [name, Array.from({ length: Math.max(1, Math.ceil(data.length / partBytes)) }, (_, index) => `${dir}/${name}.${index}`)]),
    );
    const all = Object.values(parts).flat();
    await guest(id, `mkdir -p /tmp/.sandbox-sdk && mkdir -m 700 -- ${quote(dir)} && (umask 077 && touch -- ${all.map(quote).join(" ")})`);
    // Each part is its own file, so they go up together: every request is a round trip to Boat.
    await Promise.all(
      Object.entries(files).flatMap(([name, data]) => parts[name]!.map((part, index) => upload(id, part, data.subarray(index * partBytes, (index + 1) * partBytes)))),
    );
    const join = Object.entries(parts)
      .map(([name, paths]) => `cat -- ${paths.map(quote).join(" ")} > ${quote(`${dir}/${name}`)}`)
      .join(" && ");
    return { join: `(umask 077 && ${join})`, parts };
  }

  /** Follows a background command's output until it exits, picking the stream up again where it dropped. */
  async function follow(id: string, processId: number, onChunk: ExecInput["onChunk"], signal: AbortSignal): Promise<ExecResult> {
    const offsets = { stdout: 0, stderr: 0 };
    let droppedAt: number | undefined;
    for (;;) {
      try {
        const response = await client.stream({
          method: "GET",
          path: "/sandboxes/{sandboxId}/commands/{processId}/stream",
          params: { sandboxId: id, processId },
          sandboxId: id,
          query: { stdoutOffset: offsets.stdout, stderrOffset: offsets.stderr },
          signal,
          startupTimeoutMs: reconnectMs,
          idleTimeoutMs: reconnectMs,
        });
        if (!response.body) throw fail("Boat sent a command stream with no body.", "unavailable", id);
        let reconnect = false;
        for await (const line of lines(response.body)) {
          droppedAt = undefined;
          const frame = JSON.parse(line) as Frame;
          if (frame.type === "stdout" || frame.type === "stderr") {
            if (frame.nextOffset !== undefined) {
              // Output already seen, sent again after a reconnect.
              if (frame.nextOffset <= offsets[frame.type]) continue;
              offsets[frame.type] = frame.nextOffset;
            }
            if (frame.data) onChunk({ stream: frame.type, text: frame.data });
          } else if (frame.type === "exit") {
            return { exitCode: frame.exitCode, timedOut: frame.timedOut === true };
          } else if (frame.type === "error") {
            throw fail("Boat's command stream failed.", "provider", id);
          } else if (frame.type === "attached" || frame.type === "heartbeat" || frame.type === "reconnect") {
            offsets.stdout = Math.max(offsets.stdout, frame.stdoutOffset ?? 0);
            offsets.stderr = Math.max(offsets.stderr, frame.stderrOffset ?? 0);
            if (frame.type === "reconnect") {
              reconnect = true;
              break;
            }
          }
        }
        if (!reconnect) throw fail("Boat's command stream ended before the command did.", "unavailable", id);
      } catch (error) {
        if (signal.aborted) throw fail("The command stream was cancelled.", "aborted", id);
        const transient = error instanceof SandboxError ? error.code === "unavailable" || error.code === "timeout" : !(error instanceof SyntaxError);
        droppedAt ??= Date.now();
        if (!transient || Date.now() - droppedAt >= reconnectMs) throw error;
        await sleep(1_000);
      }
    }
  }

  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    const marker = `/tmp/.sandbox-sdk-setup-${crypto.randomUUID()}`;
    const privateEnv = Object.entries(input.env).filter(([name]) => !plainEnv.has(name));
    for (const [name] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(`Invalid environment variable name: ${name}`, "invalid_argument", id);
    }
    const exports = Object.entries(input.env)
      .filter(([name]) => plainEnv.has(name))
      .map(([name, value]) => `export ${name}=${quote(value)}; `)
      .join("");

    // The command's private files: its environment and stdin. The command removes them as it starts.
    const dir = privateEnv.length || input.stdin ? `/tmp/.sandbox-sdk/exec-${crypto.randomUUID()}` : undefined;
    let started = false;
    let processId: number | undefined;
    let finished = false;
    const controller = new AbortController();
    let cancel = () => {};
    let isCancelled = false;
    const cancelled = new Promise<"cancelled">((resolve) => {
      cancel = () => {
        isCancelled = true;
        resolve("cancelled");
      };
    });
    const timer = setTimeout(cancel, input.timeoutMs);
    input.signal?.addEventListener("abort", cancel, { once: true });

    /** Kills the command and everything it started. */
    async function stop() {
      if (processId === undefined) return;
      const answer = (await client
        .cleanup({ method: "DELETE", path: "/sandboxes/{sandboxId}/commands/{processId}", params: { sandboxId: id, processId }, sandboxId: id })
        .then((response) => response.json())
        .catch(() => undefined)) as { running?: boolean } | undefined;
      if (answer?.running !== false) throw fail("Boat could not confirm the command stopped. Delete the VM before trying again.", "outcome_unknown", id);
    }

    try {
      // Every way out of the command line removes the private files: the command as it starts, a failed setup before
      // it exits, and `finally` below for a command that never ran.
      const removeDir = dir ? `/bin/rm -rf -- ${quote(dir)}; ` : "";
      const setupFailed = `{ ${removeDir}echo setup-failed > ${quote(marker)}; exit ${setupExit}; }`;
      let setup = "";
      let stdin = "/dev/null";
      if (dir) {
        const encoder = new TextEncoder();
        // Only what the command has: an empty file would still cost an upload.
        const files: Record<string, Uint8Array> = {};
        if (privateEnv.length) files.env = encoder.encode(privateEnv.map(([name, value]) => `export ${name}=${quote(value)}\n`).join(""));
        if (input.stdin) files.stdin = encoder.encode(input.stdin);
        const staged = await stage(id, dir, files);
        if (files.stdin) stdin = `${dir}/stdin`;
        const sourceEnv = files.env ? ` && . ${quote(`${dir}/env`)}` : "";
        setup = `${staged.join}${sourceEnv} || ${setupFailed}; `;
      }
      // Timed out or aborted while the files went up: never started, and `finally` removes the files.
      if (isCancelled || input.signal?.aborted) return { exitCode: null, timedOut: true };
      const line =
        `(${prepareWorkspace}) || ${setupFailed}; ${setup}` +
        `{ ${removeDir}(${exports}cd ${quote(input.cwd)} && exec sh -c ${quote(input.command)}); } < ${quote(stdin)}`;
      started = true;
      const launched = await command(id, { command: line, detached: true });
      if (launched.kind !== "started" || !Number.isSafeInteger(launched.processId) || launched.processId < 1) {
        throw fail("Boat did not confirm the command started.", "outcome_unknown", id);
      }
      processId = launched.processId;
      if (input.signal?.aborted) cancel();

      const following = follow(id, processId, input.onChunk, controller.signal).then((result) => {
        finished = true;
        return result;
      });
      following.catch(() => {});
      const outcome = await Promise.race([following, cancelled]);
      if (outcome === "cancelled") {
        await stop();
        controller.abort();
        await following.catch(() => {});
        return { exitCode: null, timedOut: true };
      }
      if (!outcome.timedOut && outcome.exitCode === setupExit) {
        const check = await command(id, { command: `if [ -f ${quote(marker)} ]; then cat ${quote(marker)}; rm -f -- ${quote(marker)}; fi`, timeoutSeconds: 10 });
        if (check.kind === "finished" && check.stdout.trim() === "setup-failed") throw fail("Boat could not set up the command, so it did not run.", "provider", id);
      }
      return outcome;
    } catch (error) {
      if (processId !== undefined && !finished) await stop();
      // Sent, but no process came back: it may be running.
      if (started && processId === undefined && !(error instanceof SandboxError && ["auth", "quota", "invalid_argument", "not_found"].includes(error.code))) {
        throw fail("Boat may have started the command without saying so. Check or delete the VM before trying again.", "outcome_unknown", id);
      }
      throw error;
    } finally {
      controller.abort();
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      // The command removes its files as it starts; this covers a command that never did.
      if (dir && !finished) await command(id, { command: `rm -rf -- ${quote(dir)}`, timeoutSeconds: 10 }, true).catch(() => {});
    }
  }

  const statScript =
    "const fs=require('fs'),p=require('path');const stat=x=>{const s=fs.lstatSync(x);return {path:x,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'file',size:s.size,modifiedAt:s.mtimeMs}};";

  async function readRange(id: string, path: string, offset: number, length: number) {
    const chunks: Buffer[] = [];
    for (let at = 0; at < length; at += inlineReadBytes) {
      const size = Math.min(inlineReadBytes, length - at);
      const text = await node(
        id,
        "const f=require('fs'),fd=f.openSync(process.argv[1],'r');try{const b=Buffer.alloc(Number(process.argv[3]));const n=f.readSync(fd,b,0,b.length,Number(process.argv[2]));process.stdout.write(b.subarray(0,n).toString('base64'))}finally{f.closeSync(fd)}",
        [path, String(offset + at), String(size)],
      );
      const chunk = Buffer.from(text, "base64");
      chunks.push(chunk);
      if (chunk.length < size) break;
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async function read(id: string, path: string) {
    const text = await node(
      id,
      "const f=require('fs'),fd=f.openSync(process.argv[1],'r');try{const size=f.fstatSync(fd).size,b=Buffer.alloc(Math.min(size,16384)),n=f.readSync(fd,b,0,b.length,0);process.stdout.write(size+'\\n'+b.subarray(0,n).toString('base64'))}finally{f.closeSync(fd)}",
      [path],
    );
    const newline = text.indexOf("\n");
    const size = Number(text.slice(0, newline));
    if (newline < 0 || !Number.isSafeInteger(size) || size < 0) throw fail("Boat returned an invalid file size.", "provider", id);
    const head = Buffer.from(text.slice(newline + 1), "base64");
    if (size <= inlineReadBytes) return new Uint8Array(head);
    // Larger files: copied to a private place first, so the download gets one consistent version, then fetched
    // through a link Boat signs for five minutes.
    const dir = `/tmp/.sandbox-sdk/download-${crypto.randomUUID()}`;
    const file = `${dir}/file`;
    try {
      const copied = Number(
        await node(
          id,
          "const f=require('fs');f.mkdirSync('/tmp/.sandbox-sdk',{recursive:true});f.mkdirSync(process.argv[2],{mode:0o700});f.copyFileSync(process.argv[1],process.argv[2]+'/file');process.stdout.write(String(f.statSync(process.argv[2]+'/file').size))",
          [path, dir],
        ),
      );
      const link = (await client.json({
        method: "POST",
        path: "/sandboxes/{sandboxId}/files/download-url",
        params: { sandboxId: id },
        sandboxId: id,
        body: { path: file, ttlSeconds: 300 },
        readOnly: true,
      })) as { url?: unknown } | undefined;
      if (typeof link?.url !== "string") throw fail("Boat returned no download link.", "provider", id);
      const body = (await client.request({ method: "GET", path: link.url, auth: false, sandboxId: id, maxBytes: copied + 1 })).body;
      if (body.length !== copied) throw fail("The file download from Boat was incomplete.", "provider", id);
      return body;
    } finally {
      await node(id, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [dir]).catch(() => {});
    }
  }

  async function write(id: string, path: string, data: Uint8Array, mode?: number) {
    if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777)) throw fail("mode must be an integer from 0 to 0o7777", "invalid_argument", id);
    const normal = path.replace(/\/+/g, "/");
    // Boat writes directly only under the user's home and /tmp, and only up to one part.
    if (mode === undefined && data.length <= partBytes && (normal.startsWith("/home/user/") || normal.startsWith("/tmp/"))) {
      try {
        await upload(id, path, data);
        return;
      } catch (error) {
        if (!(error instanceof SandboxError && error.code === "invalid_argument")) throw error;
      }
    }
    const dir = `/tmp/.sandbox-sdk/write-${crypto.randomUUID()}`;
    let done = false;
    try {
      const { parts } = await stage(id, dir, { part: data });
      await node(
        id,
        "const f=require('fs'),[d,dir,n,m]=process.argv.slice(1);try{f.mkdirSync(require('path').dirname(d),{recursive:true});const fd=f.openSync(d,'w',m?0o600:0o666);try{if(m)f.fchmodSync(fd,Number(m));for(let i=0;i<Number(n);i++)f.writeFileSync(fd,f.readFileSync(dir+'/part.'+i))}finally{f.closeSync(fd)}}finally{f.rmSync(dir,{recursive:true,force:true})}",
        [path, dir, String(parts.part!.length), mode === undefined ? "" : String(mode)],
      );
      done = true;
    } finally {
      if (!done) await node(id, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [dir]).catch(() => {});
    }
  }

  const fileInfo = (value: unknown): FileInfo => {
    const entry = value as Partial<FileInfo> | null;
    if (!entry || typeof entry.path !== "string" || typeof entry.size !== "number" || typeof entry.modifiedAt !== "number") throw fail("Boat returned invalid file details.");
    if (entry.type !== "file" && entry.type !== "directory" && entry.type !== "symlink") throw fail("Boat returned an invalid file type.");
    return { path: entry.path, type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt };
  };

  async function sandboxes(labels: Record<string, string>) {
    const found: SandboxInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = (await client.json({ method: "GET", path: "/sandboxes", query: { limit: 200, cursor } })) as unknown as {
        sandboxes: BoatSandbox[];
        pageInfo?: { hasMore?: boolean; nextCursor?: string };
      };
      for (const entry of page.sandboxes) {
        if (!readName(entry.name)) continue;
        const sandboxInfo = info(entry);
        if (Object.entries(labels).every(([key, value]) => sandboxInfo.labels[key] === value)) found.push(sandboxInfo);
      }
      if (!page.pageInfo?.hasMore) break;
      cursor = page.pageInfo.nextCursor;
      if (!cursor || seen.has(cursor)) throw fail("Boat returned an invalid page of VMs.");
      seen.add(cursor);
    } while (cursor);
    return found;
  }

  return {
    name: "boat",
    keyMode: "best-effort",
    capabilities: new Set<never>(),
    client,

    // VM Bridge creates Boat VMs in its driver below, which knows environments and snapshots.
    create: () => Promise.reject(fail("Create Boat VMs through VM Bridge's Boat driver.", "unsupported")),
    find: (key) => call(async () => (await sandboxes({})).find((entry) => entry.key === key)),
    connect: (id) => call(async () => info((await sandbox(id)).sandbox), id),
    list: (labels) => call(() => sandboxes(labels)),

    async destroy(id) {
      try {
        await client.request({ method: "DELETE", path: "/sandboxes/{sandboxId}", params: { sandboxId: id }, sandboxId: id, headers: { "X-Ascii-Confirm-Delete": id } });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },

    exec: (id, input) => call(() => exec(id, input), id),

    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      listOrder: "name",
      readRange: (id, path, range) => readRange(id, path, range.offset, range.length),
      read: (id, path) => call(() => read(id, path), id),
      write: (id, path, data, writeOptions) => call(() => write(id, path, data, writeOptions?.mode), id),
      stat: async (id, path) => fileInfo(JSON.parse(await node(id, `${statScript}process.stdout.write(JSON.stringify(stat(process.argv[1])))`, [path]))),
      list: async (id, path) => {
        const entries = JSON.parse(
          await node(id, `${statScript}process.stdout.write(JSON.stringify(fs.readdirSync(process.argv[1]).sort().map(x=>stat(p.join(process.argv[1],x)))))`, [path]),
        ) as unknown;
        if (!Array.isArray(entries)) throw fail("Boat returned an invalid directory listing.", "provider", id);
        return entries.map(fileInfo);
      },
      mkdir: async (id, path) => void (await node(id, "require('fs').mkdirSync(process.argv[1],{recursive:true})", [path])),
      remove: async (id, path, { recursive }) =>
        void (await node(id, "require('fs').rmSync(process.argv[1],{recursive:process.argv[2]==='true'})", [path, String(recursive)])),
    },

    // A port's link carries a token Boat checks as a cookie.
    previewUrl: (id, port) =>
      call(async () => {
        const host = (await client.json({ method: "POST", path: "/sandboxes/{sandboxId}/host", params: { sandboxId: id }, sandboxId: id, body: { port } })) as {
          url?: unknown;
          isProtected?: unknown;
          access?: unknown;
        };
        if (typeof host?.url !== "string" || !host.url) throw fail("Boat returned no link for the port.", "provider", id);
        const url = new URL(host.url);
        const token = url.searchParams.get("_token");
        if (token) {
          if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw fail("Boat returned an invalid port token.", "provider", id);
          url.searchParams.delete("_token");
          return { url: url.toString(), headers: { Cookie: `_port_auth=${token}` } };
        }
        if (host.isProtected === true || host.access === "private") throw fail("Boat returned a private port link with no token.", "provider", id);
        return { url: url.toString() };
      }, id),

    native: () => ({ client }),
  };
}

/**
 * What each request authenticates with: the sign-in while it is connected, otherwise the saved API key. Read for every
 * request, because VMs already open keep the provider they were opened with: after a disconnect, or a key saved or
 * replaced later, they use what is saved now instead of failing until they reconnect.
 */
export function boatCredentials(config: ProviderConfig): Credentials {
  const { signIn } = config;
  const key = () => (config.latest?.() ?? config.values).apiKey || null;
  const keyToken = () => {
    const value = key();
    if (value) return value;
    // Disconnected with no key saved: the sign-in says to connect again.
    if (signIn) return signIn.token();
    throw new SandboxError("Add a Boat API key or connect Boat in Accounts.", { code: "auth", provider: "boat" });
  };
  return {
    token: async () => (signIn?.connected() ? signIn.token() : keyToken()),
    // A key cannot be refreshed: a refused one stays refused.
    refresh: async () => (signIn?.connected() ? signIn.refresh() : undefined),
    // The key the driver opened with too, in case an error still carries it.
    secretValues: () => [...(signIn?.secretValues() ?? []), config.values.apiKey, key()].filter((value): value is string => Boolean(value)),
  };
}

export const boatProvider: ProviderDefinition = {
  id: "boat",
  label: "Boat",
  website: "https://boat.dev",
  fields: [
    { key: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "boat_...", keyOnly: true },
    {
      key: "environment",
      label: "Environment",
      kind: "select",
      required: false,
      help: "The Boat environment new VMs start in.",
      // A connected Boat cannot list environments, and uses the one picked on Boat's page while connecting.
      keyOnly: true,
    },
  ],
  signIn: true,
  features: {
    sleep: "stop",
    keepsDisk: true,
    keepsMemory: false,
  },
  sizes: { small: "2 vCPU, 4 GB", medium: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB" },
  defaultSize: "small",

  open(config) {
    const signedIn = () => config.signIn?.connected() === true;
    if (!signedIn()) required(config, "apiKey", "Boat API key");
    const provider = boat({ credentials: boatCredentials(config) });
    const { client } = provider;
    const base = sdkDriver({ id: "boat", provider, sleep: "pause" });

    const get = async (sandboxId: string) =>
      ((await client.json({ method: "GET", path: "/sandboxes/{sandboxId}", params: { sandboxId }, sandboxId })) as unknown as { sandbox: BoatSandbox }).sandbox;

    const environments = async () => ((await client.json({ method: "GET", path: "/environments" })) as unknown as { environments: BoatEnvironment[] }).environments;

    async function waitRunning(sandboxId: string) {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const { state } = await get(sandboxId);
        if (running.has(state)) return;
        if (failed.has(state)) throw new Error(`Boat VM ${sandboxId} is ${state}.`);
        await sleep(1000);
      }
      throw new Error(`Boat VM ${sandboxId} did not start within 5 minutes.`);
    }

    const connect = (sandboxId: string): Promise<Box> => connectSandbox(provider, sandboxId, { recoverSecrets: false });

    async function deleteSaved(name: string) {
      try {
        await client.request({ method: "DELETE", path: "/saved-snapshots/{name}", params: { name } });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }

    return {
      ...base,

      // Listing VMs needs only `sandbox.read`, which a sign-in has. Environments need a scope it leaves out.
      async verify() {
        await client.json({ method: "GET", path: "/sandboxes", query: { limit: 1 } });
      },

      async options(field): Promise<SelectOption[]> {
        if (field !== "environment") return [];
        if (signedIn()) throw new Error("Connected Boat cannot list environments. To use one, disconnect and pick it on Boat's page when you connect again.");
        return (await environments()).map((environment) => ({
          value: environment.name,
          label: environment.isDefault ? `${environment.name} (default)` : environment.name,
        }));
      },

      // A VM from a saved snapshot gets the snapshot's machine type, and `noEnv: false` keeps it from inheriting the
      // snapshot VM's environment choice.
      async create(input, from) {
        const environment = (!signedIn() && config.values.environment) || undefined;
        const { sandbox } = (await client.json({
          method: "POST",
          path: "/sandboxes",
          // Apart from the key of a plain create, which follows when a create from a snapshot fails.
          idempotencyKey: from ? `${input.key}-base` : input.key,
          body: {
            ttlSeconds,
            ...(from ? { from, noEnv: false } : { type: machines[input.size] }),
            ...(environment ? { environment, noEnv: false } : {}),
          },
          timeoutMs: 90_000,
        })) as unknown as { sandbox: BoatSandbox };
        try {
          await client.request({
            method: "PATCH",
            path: "/sandboxes/{sandboxId}",
            params: { sandboxId: sandbox.id },
            sandboxId: sandbox.id,
            body: { name: sdkName(input.key, input.labels) },
          });
          await waitRunning(sandbox.id);
          return await connect(sandbox.id);
        } catch (error) {
          await provider.destroy(sandbox.id).catch(() => undefined);
          throw error;
        }
      },

      connect,

      // Boat keeps saved snapshots until deleted. A plan includes at least 10; past that each one is billed to the
      // wallet, and a save with an empty wallet fails with credit_required.
      async snapshot(box) {
        const name = `vmbridge-base-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
        try {
          // Inside the try: Boat may save the snapshot even when this request times out.
          await client.request({ method: "POST", path: "/saved-snapshots", body: { sandboxId: box.id, name }, timeoutMs: 90_000 });
          const deadline = Date.now() + 10 * 60_000;
          while (Date.now() < deadline) {
            const { snapshot } = (await client.json({ method: "GET", path: "/saved-snapshots/{name}", params: { name } })) as unknown as { snapshot: BoatSavedSnapshot };
            if (snapshot.status === "ready") return name;
            if (snapshot.status === "failed") throw new Error(`Boat could not save the snapshot: ${snapshot.error ?? "no reason given"}.`);
            await sleep(2000);
          }
          throw new Error("Boat did not finish the snapshot within 10 minutes.");
        } catch (error) {
          await deleteSaved(name).catch(() => undefined);
          throw error;
        }
      },

      deleteCheckpoint: deleteSaved,

      async states(labels) {
        const states = await base.states(labels);
        // Boat's transitional states list as stopped. Keep them apart so a waking VM is not slept again.
        for (const [id, state] of states) {
          if (state !== "stopped") continue;
          const { state: native } = await get(id);
          if (running.has(native) || settling.has(native)) states.set(id, "running" satisfies ProviderState);
        }
        return states;
      },

      async sleep(box) {
        await client.request({ method: "POST", path: "/sandboxes/{sandboxId}/stop", params: { sandboxId: box.id }, sandboxId: box.id, body: {} });
        return {};
      },

      async wake(vm) {
        const deadline = Date.now() + 3 * 60_000;
        let { state } = await get(vm.sandboxId);
        // A stop must finish before Boat accepts a resume.
        while (["stopping", "archiving", "securing"].includes(state) && Date.now() < deadline) {
          await sleep(1000);
          ({ state } = await get(vm.sandboxId));
        }
        if (!running.has(state) && !settling.has(state)) {
          await client.request({
            method: "POST",
            path: "/sandboxes/{sandboxId}/resume",
            params: { sandboxId: vm.sandboxId },
            sandboxId: vm.sandboxId,
            body: { ttlSeconds },
          });
        }
        await waitRunning(vm.sandboxId);
        return connect(vm.sandboxId);
      },

      async keepAlive(box) {
        // Boat's auto-stop timer counts from start. Push it back while agents work.
        await client.request({ method: "PATCH", path: "/sandboxes/{sandboxId}", params: { sandboxId: box.id }, sandboxId: box.id, body: { ttlSeconds } });
      },

      async destroy(sandboxId) {
        try {
          await provider.destroy(sandboxId);
        } catch (error) {
          // Connections made before VM Bridge asked for `sandbox.delete` hold only `sandbox.delete-own`, which cannot
          // delete VMs an API key created. Connecting again grants the new scope.
          if (signedIn() && error instanceof SandboxError && error.code === "auth") {
            throw new Error("Boat did not let this connection delete a VM it did not create. Disconnect Boat in Accounts, connect it again, then delete.");
          }
          throw error;
        }
      },
    };
  },
};
