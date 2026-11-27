// `vmbridge opencode` and `vmbridge login`: OpenCode on one of VM Bridge's VMs, in a new worktree of this repository.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { OpenCodeLaunchEvent } from "@vmbridge/contracts";
import { databasePath, dataDir, defaultPort, pairThisMachine, tokenExchange } from "@vmbridge/server";

interface SignIn {
  url: string;
  token: string;
  /** Paired from this machine's own data folder, so it can pair again on its own. */
  local: boolean;
}

const signInPath = () => join(dataDir(), "cli.json");

function saved(): SignIn | null {
  try {
    const value = JSON.parse(readFileSync(signInPath(), "utf8")) as Partial<SignIn>;
    return typeof value.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token, local: value.local === true } : null;
  } catch {
    return null;
  }
}

function save(signIn: SignIn) {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(signInPath(), JSON.stringify(signIn), { mode: 0o600 });
  return signIn;
}

/** The saved sign-in. On the machine VM Bridge runs on, the CLI pairs itself the first time; elsewhere it needs `login`. */
function signIn(): SignIn {
  const existing = saved();
  if (existing) return existing;
  if (!existsSync(databasePath())) {
    throw new Error("Sign in to VM Bridge first with `vmbridge login <pairing link>`. Make the link in the dashboard, under Devices.");
  }
  return save({ url: `http://127.0.0.1:${defaultPort}`, token: pairThisMachine(`Terminal on ${hostname()}`), local: true });
}

export async function login(link: string | undefined) {
  if (!link) throw new Error("Usage: vmbridge login <pairing link>. Make the link in the dashboard, under Devices.");
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("That is not a link.");
  }
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("That is not a pairing link: it has no #token=.");
  const response = await fetch(new URL("/oauth/token", url.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: tokenExchange.grant,
      subject_token_type: tokenExchange.subject,
      requested_token_type: tokenExchange.requested,
      subject_token: token,
    }),
  }).catch(() => null);
  if (!response) throw new Error(`Could not reach VM Bridge at ${url.origin}.`);
  if (!response.ok) throw new Error("VM Bridge did not take that link. Each link works once, for 15 minutes, so make a new one.");
  const { access_token } = (await response.json()) as { access_token: string };
  save({ url: url.origin, token: access_token, local: false });
  console.log(`Signed in to VM Bridge at ${url.origin}.`);
}

function git(args: string[], cwd?: string) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  return result.success ? result.stdout.toString().trim() : null;
}

/** OpenCode 2's terminal app, which speaks to the OpenCode servers VM Bridge runs. */
function checkOpenCode() {
  const found = Bun.which("opencode");
  const version = found ? Bun.spawnSync([found, "--version"], { stderr: "pipe" }).stdout.toString().trim() : "";
  if (!/^opencode v2\./.test(version)) {
    throw new Error(`${found ? `This is ${version || "an unknown OpenCode"}, and VM Bridge needs OpenCode 2` : "OpenCode is not installed"}. Install it with \`npm install -g @opencode/cli\`, then run this again.`);
  }
  return found!;
}

function launch(signIn: SignIn, body: { remote: string; branch: string | null; resume: string | null }) {
  return fetch(new URL("/api/vmbridge/opencode", signIn.url), {
    method: "POST",
    headers: { authorization: `Bearer ${signIn.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error(`Could not reach VM Bridge at ${signIn.url}. Is it running?`);
  });
}

/** Reads the launch's JSON lines as they come, printing each step with the seconds since the start. */
async function follow(response: Response) {
  const started = Date.now();
  const at = () => `${Math.round((Date.now() - started) / 1000)}s`.padStart(4);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const event = JSON.parse(line) as OpenCodeLaunchEvent;
      if ("step" in event) console.log(`${at()}  ${event.step}`);
      else if ("notice" in event) console.log(`${at()}  Note: ${event.notice}`);
      else if ("error" in event) throw new Error(event.error);
      else {
        const { branch, base, vm } = event.ready;
        console.log(`${at()}  Ready: ${branch}${base ? ` from ${base}` : ""} on ${vm}\n`);
        return event.ready;
      }
    }
  }
  throw new Error("VM Bridge stopped answering before OpenCode was ready.");
}

/**
 * Finds or adds this repository's project, has VM Bridge make a worktree on one of its VMs and start OpenCode there,
 * then opens OpenCode's terminal app on it. The worktree starts from the current branch when origin has it. `resume`
 * opens a worktree that was kept, by its name, instead of making one.
 */
export async function openCode(options: { branch?: string; resume?: string }) {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("Run this inside a git repository.");
  const remote = git(["remote", "get-url", "origin"], root);
  if (!remote) throw new Error("This repository has no `origin` remote, so a VM cannot clone it.");
  const body = { remote, branch: options.branch ?? (git(["branch", "--show-current"], root) || null), resume: options.resume ?? null };
  const opencode = checkOpenCode();

  let session = signIn();
  let response = await launch(session, body);
  if (response.status === 401) {
    rmSync(signInPath(), { force: true });
    if (!session.local) throw new Error("VM Bridge signed this terminal out. Sign in again with `vmbridge login <pairing link>`.");
    session = signIn();
    response = await launch(session, body);
  }
  if (!response.ok) throw new Error(`VM Bridge answered ${response.status}.`);
  const ready = await follow(response);

  // OpenCode runs here, in this repository's folder. The VM has no such folder, so OpenCode works in the worktree.
  const child = Bun.spawn([opencode, "--server", new URL(ready.path, session.url).toString()], {
    cwd: root,
    env: { ...process.env, OPENCODE_PASSWORD: ready.password },
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Ctrl+C belongs to OpenCode. This process stays to tidy up after it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.exitCode = await child.exited;
  process.off("SIGINT", ignore);

  const answer = await fetch(new URL("/api/vmbridge/opencode", session.url), {
    method: "DELETE",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: ready.projectId, vmId: ready.vmId, name: ready.name }),
  })
    .then((response) => (response.ok ? (response.json() as Promise<{ removed: boolean }>) : null))
    .catch(() => null);
  if (answer?.removed) console.log(`Removed the worktree ${ready.branch}.`);
  else {
    console.log(`Kept the worktree ${ready.branch} at ${ready.directory} on ${ready.vm}: it has work that is not pushed, or an agent is still running.`);
    console.log(`Open it again with: vb opencode --resume ${ready.name}`);
  }
}
