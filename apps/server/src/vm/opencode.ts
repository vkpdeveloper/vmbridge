// `opencode serve` on a VM, beside T3, for stock OpenCode clients that connect through VM Bridge (see gateway/opencode.ts).
import type { Preview } from "@opencoredev/sandbox-sdk";
import type { Box } from "../providers/index.ts";
import type { OpenSocket } from "../runtime.ts";
import { previewTarget } from "./backend.ts";
import { put, quote, root, runProgram, writes } from "./runtime.ts";

export const opencodePort = 4096;

/**
 * Where `vmbridge opencode` makes a worktree: beside the checkout, under a folder git and the project's own files never
 * see, as `/workspace/.worktrees/<repo>/<name>`.
 */
export const worktreePath = (checkout: string, name: string) => {
  const slash = checkout.lastIndexOf("/");
  return `${checkout.slice(0, slash)}/.worktrees/${checkout.slice(slash + 1)}/${name}`;
};
/** A worktree's name, as the gateway takes it from an OpenCode address. */
export const worktreeName = /^[a-z0-9]{4,32}$/;

/**
 * Mends the links between the checkout and a worktree (both shell words, quoted), then points the worktree's `.git`
 * file at the checkout by the checkout's own path. Git writes the path it resolved instead, and right after a Boat VM
 * resumes that is a folder its lazily restored disk is served from for a while (/var/lib/ascii-lazy/retired/...),
 * which stops holding the repository later, leaving git unable to open the worktree.
 */
export const fixWorktreeLinks = (checkout: string, path: string) =>
  `git -C ${checkout} worktree repair ${path} >/dev/null 2>&1 || true
id="$(sed -n 's|^gitdir: .*/worktrees/||p' ${path}/.git 2>/dev/null || true)"
if [ -n "$id" ] && [ -d ${checkout}/.git/worktrees/"$id" ]; then printf 'gitdir: %s/.git/worktrees/%s\\n' ${checkout} "$id" > ${path}/.git; fi`;

/** Prints the branch a worktree is on, or nothing when its folder is gone. */
export function findWorktreeProgram(checkout: string, name: string) {
  const path = quote(worktreePath(checkout, name));
  return `[ -d ${path} ] || exit 0
${fixWorktreeLinks(quote(checkout), path)}
git -C ${path} rev-parse --abbrev-ref HEAD`;
}

/**
 * Prints each worktree in the checkout's worktree folder that git can open, as its name, branch and the Unix time its
 * folder last changed, tab-separated, one per line.
 */
export function listWorktreesProgram(checkout: string) {
  return `for path in ${quote(worktreePath(checkout, ""))}*/; do
  [ -d "$path" ] || continue
  path="\${path%/}"
  ${fixWorktreeLinks(quote(checkout), '"$path"')}
  branch="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null)" || continue
  printf '%s\\t%s\\t%s\\n' "\${path##*/}" "$branch" "$(date -r "$path" +%s)"
done`;
}

/**
 * Removes a worktree and its `opencode/<name>` branch once nothing would be lost: no uncommitted or untracked files,
 * and no commit that is not on the remote. Prints `removed`, or `kept` and the branch it is on, which an agent may have
 * changed.
 */
export function removeWorktreeProgram(checkout: string, name: string) {
  const path = quote(worktreePath(checkout, name));
  const branch = quote(`refs/heads/opencode/${name}`);
  const keep = `{ printf 'kept %s' "$(git -C ${path} branch --show-current)"; exit 0; }`;
  // Work counts as safe only when git says so: a check git cannot run keeps the worktree.
  return `pushed() { local ahead; ahead="$(git -C "$1" rev-list -1 "$2" --not --remotes 2>/dev/null)" && [ -z "$ahead" ]; }
cd ${quote(checkout)}
if [ -d ${path} ]; then
  ${fixWorktreeLinks(quote(checkout), path)}
  status="$(git -C ${path} status --porcelain)" && [ -z "$status" ] || ${keep}
  pushed ${path} HEAD || ${keep}
  ! git show-ref -q --verify ${branch} || pushed . ${branch} || ${keep}
  git worktree remove --force ${path}
fi
git worktree prune
# Its branch goes only once a remote has all of it, so commits left there when an agent switched away, or when the
# folder went first, stay in the checkout.
if pushed . ${branch}; then git branch -D ${quote(`opencode/${name}`)} >/dev/null 2>&1 || true; fi
printf removed`;
}
const dir = `${root}/opencode`;
const passwordPath = `${dir}/password`;
const startPath = `${dir}/start.sh`;
const processName = "opencode";

/**
 * OpenCode's clients speak its 2.x API, which npm ships as @opencode/cli. npm's opencode-ai is the 1.x line, which
 * T3's own OpenCode agent keeps using, so this one gets its own folder.
 */
export const cliVersion = "2.4.2";
const cliPrefix = `${dir}/cli`;
const cli = `${cliPrefix}/bin/opencode`;
const installCli = `${cli} --version 2>/dev/null | grep -qxF "opencode v${cliVersion}" || npm install -g --prefix ${cliPrefix} --no-audit --no-fund --loglevel=error @opencode/cli@${cliVersion} >&2`;

// Its data, state and cache live apart from the OpenCode that T3 runs, and from what a 1.x server here left. Its config
// does not: the skills sync writes OpenCode's instructions to the usual config folder, and the env file sets
// OPENCODE_CONFIG where a VM needs one. OpenCode keeps OPENCODE_PASSWORD out of the shells its agents run.
const startScript = `#!/bin/bash
set -euo pipefail
. ${root}/env
OPENCODE_PASSWORD="$(cat ${passwordPath})"
export OPENCODE_PASSWORD XDG_DATA_HOME=${dir}/v2/data XDG_STATE_HOME=${dir}/v2/state XDG_CACHE_HOME=${dir}/v2/cache
cd "$1"
exec ${cli} serve --hostname 0.0.0.0 --port ${opencodePort}
`;

/**
 * Asks the server on the VM itself, so it needs no preview: prints busy or idle, refused when it has another password,
 * old when it is not OpenCode 2, down when nothing listens, or unknown when a request failed another way, such as
 * timing out.
 */
const probeScript = `const auth="Basic "+Buffer.from("opencode:"+require("fs").readFileSync(process.argv[1],"utf8")).toString("base64");
const ask=(path)=>fetch("http://127.0.0.1:${opencodePort}"+path,{headers:{authorization:auth},signal:AbortSignal.timeout(10000)});
const json=(r)=>r.json().catch(()=>null);
(async()=>{
let r;
try{r=await ask("/api/info")}catch(e){return e?.cause?.code==="ECONNREFUSED"?"down":"unknown"}
if(r.status===401)return "refused";
const info=await json(r);
if(!String(info?.version).startsWith("2."))return "old";
try{r=await ask("/api/session/active")}catch{return "unknown"}
if(!r.ok)return "status "+r.status;
const active=await json(r);
return active?(Object.keys(active.data??{}).length?"busy":"idle"):"unknown";
})().then((s)=>process.stdout.write(s))`;
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
export async function startOpenCode(box: Box, password: string, cwd: string, detail: (text: string) => void = () => {}) {
  detail("Checking OpenCode on the VM");
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
        installCli,
        probe,
      ].join("\n"),
      "Starting OpenCode",
      10 * 60_000,
    )
  ).trim();
  if (state === "nokey") throw new NoOpenCodeKey();
  if (state === "idle" || state === "busy") return;
  detail("Starting the OpenCode server");
  // A server from before is running with another password, or is OpenCode 1. Restarted, it runs this start script.
  if (state === "refused" || state === "old") await box.process(processName).restart();
  else {
    try {
      await box.start(`bash ${startPath} ${quote(cwd)}`, { name: processName });
    } catch (error) {
      // A record left by a server that stopped answering: replace it.
      if (!(error instanceof Error && error.message.includes("already running"))) throw error;
      await box.process(processName).restart();
    }
  }
  detail("Waiting for OpenCode to answer");
  await runProgram(box, `. ${root}/env\n${waitScript}`, "Starting OpenCode", 150_000);
}

async function probeState(box: Box) {
  const answer = await box.run(`[ -f ${passwordPath} ] && . ${root}/env && ${probe} || echo down`, { timeoutMs: 20_000 });
  return answer.stdout.trim();
}

/**
 * Whether an agent may be running in OpenCode on the VM now. Only an idle answer or nothing listening says no, so a
 * server that did not answer in time is not restarted or put to sleep under a running agent. A server with another
 * password, or OpenCode 1, counts as idle: no client reaches its agents through VM Bridge, and the next request
 * replaces it.
 */
export async function openCodeBusy(box: Box) {
  return !["idle", "down", "refused", "old"].includes(await probeState(box));
}

/**
 * Stops OpenCode, so the next request starts it again with the env file as it is now. Providers word "not running"
 * differently, so after a failed stop, only nothing listening counts as stopped.
 */
export async function stopOpenCode(box: Box) {
  const stopped = await box.process(processName).stop().then(
    () => true,
    () => false,
  );
  if (!stopped && (await probeState(box)) !== "down") throw new Error("VM Bridge could not stop OpenCode on the VM.");
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
