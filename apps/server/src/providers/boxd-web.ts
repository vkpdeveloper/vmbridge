import type { ExecResult as BoxdExecResult, Machine, MachineCreateParams, Proxy, Snapshot } from "@boxd-sh/sdk/web";
import { BoxdError, MachineFileNotFoundError } from "@boxd-sh/sdk/web";
import { SandboxError, type ErrorCode } from "@opencoredev/sandbox-sdk";
import type { ExecInput, ExecResult, FileInfo, Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { ProviderState } from "./types.ts";

/**
 * boxd over gRPC-web (`@boxd-sh/sdk/web`), for runtimes where grpc-js cannot run, Cloudflare Workers above all.
 * It is a sandbox-sdk provider, so the SDK builds the same `Box` (run, start, process, files, preview) on top.
 *
 * Machines keep the SDK's boxd conventions: an `sbxsdk-` name and the key and labels in
 * /var/lib/sandbox-sdk/metadata.json. Either boxd driver can list, connect to and delete the other's VMs.
 *
 * gRPC-web is half-duplex: there is no `streamExec`, so a command cannot read stdin as it runs. Stdin is uploaded
 * to a file first, and output arrives when the command ends.
 */

/** On Workers grpc-js cannot run, so boxd always goes over gRPC-web there. `VMBRIDGE_BOXD_WEB=1` picks it on Bun too. */
export const useBoxdWeb = () => process.env.VMBRIDGE_BOXD_WEB === "1" || globalThis.navigator?.userAgent === "Cloudflare-Workers";

type MachineSummary = Pick<Machine, "id" | "name" | "status" | "createdAt">;

/** The parts of the `@boxd-sh/sdk/web` client this provider uses. */
export interface BoxdWebClient {
  machines: {
    create(params: MachineCreateParams): Promise<MachineSummary>;
    get(id: string): Promise<MachineSummary>;
    list(): Promise<MachineSummary[]>;
    delete(id: string): Promise<void>;
    waitUntilReady(id: string, params: { timeout: number }): Promise<MachineSummary>;
    exec(id: string, params: { command: string; timeout: number }): Promise<Pick<BoxdExecResult, "stdout" | "stderr" | "exitCode">>;
    pause(id: string): Promise<unknown>;
    resume(id: string): Promise<unknown>;
    setBotProtection(id: string, mode: "off"): Promise<void>;
    files: {
      upload(id: string, path: string, data: Uint8Array): Promise<number>;
      download(id: string, path: string): Promise<Uint8Array>;
    };
    proxies: {
      list(id: string): Promise<Pick<Proxy, "domain" | "isDefault">[]>;
      setPort(id: string, port: number): Promise<void>;
    };
  };
  snapshots: {
    create(machine: string, name: string): Promise<unknown>;
    get(name: string): Promise<Pick<Snapshot, "status">>;
    delete(name: string): Promise<void>;
  };
}

export interface BoxdWebOptions {
  /** Redacted from error messages. */
  apiKey: string;
  /** Control calls and plain guest commands. Default: 30 s. */
  requestTimeoutMs?: number;
  /** How long a new or restored machine may take to boot. Default: 90 s. */
  readyTimeoutMs?: number;
}

export type BoxdWebProvider = Provider<{ client: BoxdWebClient }, "pause" | "size" | "snapshot" | "snapshot-delete"> & {
  /** Sleeping SDK machines, which `list` leaves out because reading their labels would wake them. */
  listSleeping(): Promise<{ id: string; state: ProviderState }[]>;
};

const metadataPath = "/var/lib/sandbox-sdk/metadata.json";
const notFoundMarker = "SDK_FILE_NOT_FOUND";
const vcpus = { small: 1, medium: 2, large: 4 } as const;

// Same table as the SDK's own boxd adapter, so both drivers report the same codes.
const grpcCodes = new Map<number, ErrorCode>([
  [1, "aborted"],
  [3, "invalid_argument"],
  [4, "timeout"],
  [5, "not_found"],
  [6, "invalid_argument"],
  [7, "auth"],
  [8, "quota"],
  [9, "invalid_argument"],
  [12, "unsupported"],
  [14, "unavailable"],
  [16, "auth"],
]);

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const fail = (message: string, code: ErrorCode, sandboxId?: string) => new SandboxError(message, { code, provider: "boxd", sandboxId });

export function boxdWebError(error: unknown, apiKey: string, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, "<redacted>");
  if (error instanceof MachineFileNotFoundError || /\bno such file\b/i.test(message)) return fail("File does not exist", "file_not_found", sandboxId);
  if (error instanceof BoxdError && /^exec timed out after \d+ms$/.test(message)) return fail("boxd request timed out", "timeout", sandboxId);
  const grpc = error instanceof BoxdError && error.grpcCode !== undefined ? grpcCodes.get(error.grpcCode) : undefined;
  return fail(`boxd request failed: ${message}`, grpc ?? "provider", sandboxId);
}

const stateOf = (status: Machine["status"]): ProviderState =>
  status === "running" ? "running" : status === "suspended" || status === "hibernated" ? "paused" : "stopped";

/** Creates the SDK's directories and records the key and labels, as the SDK's adapter does on a new machine. */
const setupCommand = (metadata: string) =>
  `if ! mkdir -p /workspace /var/lib/sandbox-sdk 2>/dev/null || [ ! -w /workspace ] || [ ! -w /var/lib/sandbox-sdk ]; then ` +
  `sudo -n install -d -o "$(id -u)" -g "$(id -g)" /workspace /var/lib/sandbox-sdk; fi && ` +
  `test -w /workspace && test -w /var/lib/sandbox-sdk && mkdir -p /tmp/.sandbox-sdk && printf %s ${quote(metadata)} > ${metadataPath}`;

/** Where each command's stdin waits until the command starts. */
const stdinDir = "/tmp/.sandbox-sdk/stdin";

const statScript = `import os,sys,json,stat
def info(p):
 s=os.lstat(p)
 t='symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file'
 return {'path':p,'type':t,'size':s.st_size,'modifiedAt':int(s.st_mtime*1000)}
p=sys.argv[1]
try:
 if sys.argv[2]=='stat': out=info(p)
 else:
  out=[]
  for n in os.listdir(p):
   try: out.append(info(os.path.join(p,n)))
   except FileNotFoundError: pass
except FileNotFoundError:
 print('${notFoundMarker}'); sys.exit(0)
print(json.dumps(out))`;

/**
 * The shell line for one command. GNU `timeout` makes its own process group and signals all of it, so a timed-out
 * command leaves nothing running. `tag` names the line so an abort can find that group.
 */
export function execLine(input: Pick<ExecInput, "command" | "cwd" | "env" | "timeoutMs">, stdinPath: string | undefined, tag: string) {
  const exports = Object.entries(input.env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(`Invalid environment variable name: ${name}`, "invalid_argument");
    return `export ${name}=${quote(value)}\n`;
  });
  const removeStdin = stdinPath ? `rm -f -- ${quote(stdinPath)}\n` : "";
  // A missing cwd fails the command (exit 2), not the call.
  const script = `# ${tag}\n${removeStdin}cd -- ${quote(input.cwd)} || exit 2\n${exports.join("")}exec sh -c ${quote(input.command)}`;
  const seconds = (input.timeoutMs / 1000).toFixed(3);
  const stdin = stdinPath ? quote(stdinPath) : "/dev/null";
  return `if command -v timeout >/dev/null 2>&1; then exec timeout -k 2 ${seconds}s sh -c ${quote(script)} < ${stdin}; else exec sh -c ${quote(script)} < ${stdin}; fi`;
}

export function boxdWeb(client: BoxdWebClient, options: BoxdWebOptions): BoxdWebProvider {
  const { apiKey } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;

  const call = async <T>(sandboxId: string | undefined, request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      throw boxdWebError(error, apiKey, sandboxId);
    }
  };

  /** Runs a short guest command and returns its stdout. Any failure is the operation's failure. */
  const raw = async (id: string, command: string) => {
    const result = await client.machines.exec(id, { command, timeout: requestTimeoutMs });
    if (result.exitCode !== 0) throw fail("Guest operation failed", "provider", id);
    return result.stdout;
  };

  const notSdkMachine = (id: string) => fail("Not an SDK machine", "not_found", id);
  const invalidMetadata = "Invalid SDK metadata";

  async function describe(machine: MachineSummary): Promise<SandboxInfo> {
    if (!machine.name.startsWith("sbxsdk-")) throw notSdkMachine(machine.id);
    let text: string;
    try {
      text = new TextDecoder().decode(await client.machines.files.download(machine.id, metadataPath));
    } catch (error) {
      const mapped = boxdWebError(error, apiKey, machine.id);
      if (mapped.code === "file_not_found") throw fail("SDK metadata is missing", "not_found", machine.id);
      throw mapped;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(text);
    } catch {
      throw fail(invalidMetadata, "provider", machine.id);
    }
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("labels" in metadata) ||
      !("createdAt" in metadata) ||
      (metadata.labels !== null &&
        (typeof metadata.labels !== "object" ||
          Array.isArray(metadata.labels) ||
          !Object.values(metadata.labels).every((value) => typeof value === "string")))
    ) {
      throw fail(invalidMetadata, "provider", machine.id);
    }
    const key = "key" in metadata && typeof metadata.key === "string" ? metadata.key : undefined;
    const labels = (metadata.labels ?? {}) as Record<string, string>;
    const createdAt = typeof metadata.createdAt === "number" ? metadata.createdAt : Date.now();
    return { id: machine.id, key, labels, createdAt: machine.createdAt?.getTime() ?? createdAt, state: stateOf(machine.status) };
  }

  /** `describe`, or null for a machine that is not a readable SDK machine. */
  async function tryDescribe(machine: MachineSummary) {
    try {
      return await describe(machine);
    } catch (error) {
      if (error instanceof SandboxError && (error.code === "not_found" || error.message === invalidMetadata)) return null;
      throw error;
    }
  }

  const sdkMachines = async () =>
    (await client.machines.list()).filter((machine) => machine.name.startsWith("sbxsdk-") && machine.status !== "destroyed");

  async function known() {
    const infos: SandboxInfo[] = [];
    const asleep: MachineSummary[] = [];
    for (const machine of await sdkMachines()) {
      if (machine.status !== "running") {
        asleep.push(machine);
        continue;
      }
      const info = await tryDescribe(machine);
      if (info) infos.push(info);
    }
    return { infos, asleep };
  }

  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    const tag = `vmbridge-exec-${crypto.randomUUID()}`;
    // The command removes its stdin file as it starts. Until then it can hold sign-ins, so it waits in a folder only
    // the VM's user can open, and is removed below if the command never ran.
    const stdinPath = input.stdin ? `${stdinDir}/${crypto.randomUUID()}` : undefined;
    let ran = false;
    let onAbort = () => {};
    try {
      if (stdinPath) await writeFile(id, stdinPath, new TextEncoder().encode(input.stdin), `umask 077 && mkdir -p -m 700 -- ${stdinDir}`);
      const started = Date.now();
      const running = client.machines.exec(id, {
        command: execLine(input, stdinPath, tag),
        // boxd's own deadline only backs up `timeout` in the guest, which ends the command first.
        timeout: input.timeoutMs + 15_000,
      });
      running.catch(() => {});
      const aborted = new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      const outcome = await Promise.race([running, aborted]);
      if (outcome === "aborted") {
        // `[v]` keeps the pattern from matching this kill command itself. `timeout` leads the group, so the negative
        // PID kills the command's children too. No `--`: dash, the usual Linux `sh`, takes it for a PID and kills nothing.
        const pattern = quote(`[v]${tag.slice(1)}`);
        await raw(id, `for p in $(pgrep -f ${pattern}); do kill -9 -"$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done; true`);
        return { exitCode: null, timedOut: true };
      }
      ran = true;
      if (outcome.stdout) input.onChunk({ stream: "stdout", text: outcome.stdout });
      if (outcome.stderr) input.onChunk({ stream: "stderr", text: outcome.stderr });
      // 124 is `timeout`'s own exit code, 137 its kill after the grace period.
      const timedOut = (outcome.exitCode === 124 || outcome.exitCode === 137) && Date.now() - started >= input.timeoutMs;
      return { exitCode: timedOut ? null : outcome.exitCode, timedOut };
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      if (stdinPath && !ran) await raw(id, `rm -f -- ${quote(stdinPath)}`).catch(() => {});
    }
  }

  /** `makeParent` is the guest command that creates the file's folder when the upload finds it missing. */
  async function writeFile(id: string, path: string, data: Uint8Array, makeParent = `mkdir -p -- "$(dirname -- ${quote(path)})"`) {
    const written = await client.machines.files.upload(id, path, data).catch(async (error: unknown) => {
      const mapped = boxdWebError(error, apiKey, id);
      if (mapped.code !== "file_not_found" && mapped.code !== "not_found") throw mapped;
      await raw(id, makeParent);
      return client.machines.files.upload(id, path, data);
    });
    if (written !== data.length) throw fail("Incomplete file upload", "provider", id);
  }

  async function guestStat(id: string, path: string, mode: "stat" | "list") {
    const out = await raw(id, `python3 -c ${quote(statScript)} ${quote(path)} ${mode}`);
    if (out.trim() === notFoundMarker) throw fail("File does not exist", "file_not_found", id);
    return JSON.parse(out) as unknown;
  }

  const provider: BoxdWebProvider = {
    name: "boxd",
    keyMode: "best-effort",
    capabilities: new Set(["pause", "size", "snapshot", "snapshot-delete"] as const),

    create: (input) =>
      call(undefined, async () => {
        if (input.from !== undefined && (input.size !== undefined || Object.keys(input.env ?? {}).length > 0)) {
          throw fail("boxd snapshot restore inherits size and environment; overrides are not supported", "unsupported");
        }
        if (typeof input.size === "object") throw fail("boxd sizes are small, medium or large here", "unsupported");
        const autoSuspendTimeout = input.idleTimeoutMs === undefined ? 0 : Math.ceil(input.idleTimeoutMs / 1000);
        const name = `sbxsdk-${crypto.randomUUID()}`;
        const createdAt = Date.now();
        let machine =
          input.from !== undefined
            ? await client.machines.create({ name, fromSnapshot: input.from, isolated: true, config: { autoSuspendTimeout } })
            : await client.machines.create({
                name,
                env: input.env,
                isolated: true,
                config: { autoSuspendTimeout, autoDestroyTimeout: 0, vcpu: input.size ? vcpus[input.size] : undefined },
              });
        try {
          if (machine.status !== "running") machine = await client.machines.waitUntilReady(machine.id, { timeout: readyTimeoutMs });
          await raw(machine.id, setupCommand(JSON.stringify({ key: input.key ?? null, labels: input.labels, createdAt })));
          return { id: machine.id, key: input.key, labels: input.labels, createdAt: machine.createdAt?.getTime() ?? createdAt, state: "running" };
        } catch (error) {
          await client.machines.delete(machine.id).catch(() => {});
          throw error;
        }
      }),

    list: (labels) =>
      call(undefined, async () =>
        (await known()).infos.filter((info) => Object.entries(labels).every(([key, value]) => info.labels[key] === value)),
      ),

    // Like the SDK's adapter, this reads sleeping machines' metadata too, which wakes them.
    find: (key) =>
      call(undefined, async () => {
        const { infos, asleep } = await known();
        let found = infos.find((info) => info.key === key);
        for (const machine of asleep) {
          if (found) break;
          const info = await tryDescribe(machine);
          if (info?.key === key) found = info;
        }
        return found;
      }),

    connect: (id) => call(id, async () => describe(await client.machines.get(id))),

    destroy: (id) =>
      call(id, async () => {
        try {
          await client.machines.delete(id);
        } catch (error) {
          if (boxdWebError(error, apiKey, id).code !== "not_found") throw error;
        }
      }),

    exec: (id, input) => call(id, () => exec(id, input)),

    files: {
      writeCreatesParents: true,
      listOrder: "directory",
      read: (id, path) => call(id, () => client.machines.files.download(id, path)),
      write: (id, path, data) => call(id, () => writeFile(id, path, data)),
      stat: (id, path) => call(id, async () => (await guestStat(id, path, "stat")) as FileInfo),
      list: (id, path) => call(id, async () => (await guestStat(id, path, "list")) as FileInfo[]),
      mkdir: (id, path) => call(id, async () => void (await raw(id, `mkdir -p -- ${quote(path)}`))),
      remove: (id, path, { recursive }) =>
        call(id, async () => {
          const out = await raw(
            id,
            `if [ ! -e ${quote(path)} ] && [ ! -L ${quote(path)} ]; then echo ${notFoundMarker}; else rm -f${recursive ? "r" : ""} -- ${quote(path)}; fi`,
          );
          if (out.trim() === notFoundMarker) throw fail("File does not exist", "file_not_found", id);
        }),
    },

    previewUrl: (id, port) =>
      call(id, async () => {
        const proxy = (await client.machines.proxies.list(id)).find((entry) => entry.isDefault);
        if (!proxy) throw fail("Default proxy is not ready", "unavailable", id);
        await client.machines.proxies.setPort(id, port);
        await client.machines.setBotProtection(id, "off");
        return { url: `https://${proxy.domain}` };
      }),

    native: () => ({ client }),

    pause: (id) => call(id, async () => void (await client.machines.pause(id))),
    resume: (id) => call(id, async () => void (await client.machines.resume(id))),

    snapshot: (id, snapshotOptions) =>
      call(id, async () => {
        if (snapshotOptions?.expiresInMs) throw fail("boxd keeps snapshots until they are deleted; omit expiresInMs", "unsupported", id);
        const name = `sbxsdk-${crypto.randomUUID()}`;
        const deadline = Date.now() + readyTimeoutMs;
        try {
          await client.snapshots.create(id, name);
          while (Date.now() < deadline) {
            const { status } = await client.snapshots.get(name);
            if (status === "ready") return { id: name };
            if (status === "failed") throw fail("boxd snapshot capture failed", "provider", id);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw fail("boxd snapshot did not become ready", "timeout", id);
        } catch (error) {
          await client.snapshots.delete(name).catch(() => {});
          throw error;
        }
      }),

    deleteSnapshot: (snapshotId) =>
      call(undefined, async () => {
        try {
          await client.snapshots.delete(snapshotId);
          return true;
        } catch (error) {
          if (boxdWebError(error, apiKey).code === "not_found") return false;
          throw error;
        }
      }),

    listSleeping: () =>
      call(undefined, async () =>
        (await sdkMachines()).filter((machine) => machine.status !== "running").map((machine) => ({ id: machine.id, state: stateOf(machine.status) })),
      ),
  };
  return provider;
}
