// `vmbridge opencode` and `vmbridge login`: OpenCode on one of VM Bridge's VMs, in a new worktree of this repository.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { OpenCodeLaunchEvent, OpenCodeWorktrees } from "@vmbridge/contracts";
import { databasePath, dataDir, defaultPort, pairThisMachine, tokenExchange } from "@vmbridge/server";
import { launchView, type LaunchView } from "./launch-view.ts";
import { sidebarConfig } from "./opencode-sidebar.ts";
import { pickWorktree, worktreeList } from "./worktree-picker.ts";

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

/**
 * Sends a request to `/api/vmbridge/opencode` with the saved sign-in. When VM Bridge has signed this terminal out, one
 * on the VM Bridge machine pairs again on its own; elsewhere the user has to sign in again.
 */
async function ask(init: RequestInit & { query?: string }) {
  const send = (signIn: SignIn) =>
    fetch(new URL(`/api/vmbridge/opencode${init.query ?? ""}`, signIn.url), {
      ...init,
      headers: { authorization: `Bearer ${signIn.token}`, "content-type": "application/json" },
    }).catch(() => {
      throw new Error(`Could not reach VM Bridge at ${signIn.url}. Is it running?`);
    });
  let session = signIn();
  let response = await send(session);
  if (response.status === 401) {
    rmSync(signInPath(), { force: true });
    if (!session.local) throw new Error("VM Bridge signed this terminal out. Sign in again with `vmbridge login <pairing link>`.");
    session = signIn();
    response = await send(session);
  }
  if (!response.ok) throw new Error(`VM Bridge answered ${response.status}.`);
  return { session, response };
}

/** This repository's folder, its `origin` and its branch. */
function repository() {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("Run this inside a git repository.");
  const remote = git(["remote", "get-url", "origin"], root);
  if (!remote) throw new Error("This repository has no `origin` remote, so a VM cannot clone it.");
  return { root, remote, branch: git(["branch", "--show-current"], root) || null };
}

/** Reads the launch's JSON lines as they come and shows each on `view`. Answers the ready event. */
async function follow(response: Response, view: LaunchView) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line) as OpenCodeLaunchEvent;
        if ("error" in event) throw new Error(event.error);
        if ("ready" in event) {
          view.ready(event.ready);
          return event.ready;
        }
        view.update(event);
      }
    }
    throw new Error("VM Bridge stopped answering before OpenCode was ready.");
  } catch (error) {
    view.fail();
    throw error;
  }
}

/**
 * Finds or adds this repository's project, has VM Bridge make a worktree on one of its VMs and start OpenCode there,
 * then opens OpenCode's terminal app on it. The worktree starts from the current branch when origin has it.
 */
export async function openCode(options: { branch?: string }) {
  const { root, remote, branch } = repository();
  await open(root, { remote, branch: options.branch ?? branch, resume: null });
}

/**
 * Opens one of this repository's worktrees again, in the OpenCode session last prompted there: the one named, or one
 * picked from those VM Bridge noted, last used first. Listing wakes no VM.
 */
export async function resumeOpenCode(name: string | undefined) {
  const { root, remote } = repository();
  if (!name) {
    const { response } = await ask({ method: "GET", query: `?${new URLSearchParams({ remote })}` });
    const { project, worktrees } = (await response.json()) as OpenCodeWorktrees;
    if (!project || worktrees.length === 0) {
      return console.log(`No worktrees of ${project ?? "this repository"} to open again. Start one with \`vb opencode\`.`);
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) return console.log(worktreeList(project, worktrees, Date.now()).join("\n"));
    const picked = await pickWorktree(project, worktrees);
    if (!picked) return;
    name = picked;
  }
  await open(root, { remote, branch: null, resume: name });
}

/** Launches OpenCode on a VM as `body` asks, runs its terminal app here, then tidies the worktree up. */
async function open(root: string, body: { remote: string; branch: string | null; resume: string | null }) {
  const opencode = checkOpenCode();
  const { session, response } = await ask({ method: "POST", body: JSON.stringify(body) });
  // The steps every launch ends with, shown as waiting until they start. They match the server's step names.
  const ready = await follow(response, launchView(process.stdout, body.resume ? ["Starting OpenCode"] : ["Making a worktree", "Starting OpenCode"]));

  // OpenCode runs here, in this repository's folder. The VM has no such folder, so OpenCode works in the worktree.
  const args = [opencode, "--server", new URL(ready.path, session.url).toString()];
  if (ready.sessionId) args.push("--session", ready.sessionId);
  const child = Bun.spawn(args, {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_PASSWORD: ready.password,
      OPENCODE_CLI_CONFIG_CONTENT: sidebarConfig({
        repository: ready.project,
        repositoryUrl: ready.repositoryUrl ?? null,
        vm: ready.provider ? `${ready.vm} (${ready.provider})` : ready.vm,
        status: new URL(`${ready.path}/vmbridge/status`, session.url).toString(),
      }),
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Ctrl+C belongs to OpenCode. This process stays to tidy up after it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.exitCode = await child.exited;
  process.off("SIGINT", ignore);

  // VM Bridge answers at once and removes the worktree in the background, unless it holds work.
  await fetch(new URL("/api/vmbridge/opencode", session.url), {
    method: "DELETE",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: ready.projectId, vmId: ready.vmId, name: ready.name }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
  console.log(`Cleaning up ${ready.branch} in the background. If it has work, \`vb opencode resume ${ready.name}\` opens it again.`);
}
