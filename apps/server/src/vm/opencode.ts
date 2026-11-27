// `opencode serve` on a VM, beside T3, for stock OpenCode clients that connect through VM Bridge (see gateway/opencode.ts).
import type { Preview } from "@opencoredev/sandbox-sdk";
import type { Box } from "../providers/index.ts";
import type { OpenSocket } from "../runtime.ts";
import { previewTarget } from "./backend.ts";
import { installOpenCode, put, quote, root, runProgram, writes } from "./runtime.ts";

export const opencodePort = 4096;
const dir = `${root}/opencode`;
const passwordPath = `${dir}/password`;
const startPath = `${dir}/start.sh`;
const processName = "opencode";

// Its data, state and cache live apart from the OpenCode that T3 runs. Its config does not: the skills sync writes
// OpenCode's instructions to the usual config folder, and the env file sets OPENCODE_CONFIG where a VM needs one.
// OpenCode keeps OPENCODE_PASSWORD out of the shells its agents run.
const startScript = `#!/bin/bash
set -euo pipefail
. ${root}/env
OPENCODE_PASSWORD="$(cat ${passwordPath})"
export OPENCODE_PASSWORD XDG_DATA_HOME=${dir}/data XDG_STATE_HOME=${dir}/state XDG_CACHE_HOME=${dir}/cache
cd "$1"
exec opencode serve --hostname 0.0.0.0 --port ${opencodePort}
`;

/**
 * Asks the server on the VM itself, so it needs no preview: prints busy or idle, refused when it has another password,
 * or down when nothing answers.
 */
const probeScript = `const auth="Basic "+Buffer.from("opencode:"+require("fs").readFileSync(process.argv[1],"utf8")).toString("base64");
fetch("http://127.0.0.1:${opencodePort}/api/session/active",{headers:{authorization:auth},signal:AbortSignal.timeout(10000)})
.then(async(r)=>r.status===401?"refused":r.ok?(Object.keys((await r.json()).data??{}).length?"busy":"idle"):"status "+r.status,()=>"down")
.then((s)=>process.stdout.write(s))`;
const probe = `node -e ${quote(probeScript)} ${passwordPath}`;

const waitScript = `for _ in $(seq 120); do
  state="$(${probe})"
  case "$state" in idle|busy) exit 0 ;; refused) echo "OpenCode refused VM Bridge's password." >&2; exit 1 ;; esac
  sleep 1
done
echo "OpenCode did not answer within 2 minutes." >&2
exit 1`;

export class NoOpenCodeKey extends Error {
  constructor() {
    super("Add an OpenCode key in VM Bridge to use OpenCode.");
  }
}

/** Starts OpenCode in `cwd` unless it answers already, installing it first if the VM lacks it. */
export async function startOpenCode(box: Box, password: string, cwd: string) {
  const state = (
    await runProgram(
      box,
      [
        "umask 077",
        `mkdir -p ${dir} && chmod 700 ${dir}`,
        put,
        writes({ [passwordPath]: password, [startPath]: startScript }),
        `. ${root}/env`,
        `[ -n "\${OPENCODE_API_KEY:-}" ] || { echo nokey; exit 0; }`,
        installOpenCode,
        probe,
      ].join("\n"),
      "Starting OpenCode",
      10 * 60_000,
    )
  ).trim();
  if (state === "nokey") throw new NoOpenCodeKey();
  if (state === "idle" || state === "busy") return;
  // Refused: a server from before is running with another password.
  if (state === "refused") await box.process(processName).restart();
  else {
    try {
      await box.start(`bash ${startPath} ${quote(cwd)}`, { name: processName });
    } catch (error) {
      // A record left by a server that stopped answering: replace it.
      if (!(error instanceof Error && error.message.includes("already running"))) throw error;
      await box.process(processName).restart();
    }
  }
  await runProgram(box, `. ${root}/env\n${waitScript}`, "Starting OpenCode", 150_000);
}

/** Whether an agent runs in OpenCode on the VM now. False when OpenCode is not running. */
export async function openCodeBusy(box: Box) {
  const answer = await box.run(`[ -f ${passwordPath} ] && . ${root}/env && ${probe} || echo down`, { timeoutMs: 20_000 });
  return answer.stdout.trim() === "busy";
}

/** Stops OpenCode, so the next request starts it again with the env file as it is now. Nothing to stop is fine. */
export async function stopOpenCode(box: Box) {
  try {
    await box.process(processName).stop();
  } catch {
    // Not running.
  }
}

export class OpenCodeUnreachable extends Error {}

/** The OpenCode server on one VM, reached through its preview. The VM's password and the preview never leave this class. */
export class OpenCodeServer {
  constructor(
    readonly vmId: string,
    private readonly preview: Preview,
    private readonly password: string,
    private readonly openSocket: OpenSocket,
  ) {}

  /** A preview with an expiry stops working then, so a new one is fetched a minute before. */
  get expiring() {
    return this.preview.expiresAt !== undefined && this.preview.expiresAt - Date.now() < 60_000;
  }

  private headers(extra?: Headers) {
    const headers = new Headers(extra);
    for (const [name, value] of Object.entries(this.preview.headers ?? {})) headers.set(name, value);
    headers.set("authorization", `Basic ${btoa(`opencode:${this.password}`)}`);
    return headers;
  }

  /** `path` carries its query. */
  async fetch(path: string, init: RequestInit & { headers: Headers }): Promise<Response> {
    try {
      // A redirect could carry the password to another origin.
      return await fetch(previewTarget(this.preview, path), { ...init, headers: this.headers(init.headers), redirect: "error" });
    } catch {
      // Fetch errors can include the preview URL, which may hold credentials.
      throw new OpenCodeUnreachable(`OpenCode on VM ${this.vmId} did not answer.`);
    }
  }

  async socket(path: string, timeoutMs = 15_000): Promise<WebSocket> {
    const url = previewTarget(this.preview, path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      return await this.openSocket(url, Object.fromEntries(this.headers()), timeoutMs);
    } catch {
      throw new OpenCodeUnreachable(`Cannot open an OpenCode socket on VM ${this.vmId}.`);
    }
  }
}
