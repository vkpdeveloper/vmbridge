import { createHash } from "node:crypto";
import type { AgentSecrets } from "../agent-auth/profiles.ts";
import type { Encryption } from "../encryption.ts";
import type { Box } from "../providers/index.ts";
import { opencodeConfigPath, screenToolsFiles, screenToolsSetup, type ScreenTools } from "./screen-tools.ts";

/** Everything VM Bridge installs or keeps lives here, on the disk that survives sleep. */
export const root = "/workspace/.vmbridge";
export const t3Port = 3773;
export const t3DataDir = `${root}/t3`;
/** VM Bridge clones each project's repository here. */
export const checkoutRoot = "/workspace";

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const codexAuthPath = `${root}/codex/auth.json`;

const gitConfigPath = `${root}/gitconfig`;
const gitCredentialsPath = `${root}/git-credentials`;
/** The fingerprint of the sign-ins the running T3 server read from the env file when it started. */
const startedCredentialsPath = `${t3DataDir}/credentials`;

/** Credentials VM Bridge passes into a VM. Agents and git use only these, never the provider's. */
export interface VmCredentials extends AgentSecrets {
  github?: { token: string; login: string; name: string; email: string };
  /** Environment variables set in the dashboard. Absent rather than empty, so having none leaves the fingerprint as it was. */
  env?: Record<string, string>;
  /** Set on Kubi VMs only, whose agents get browser and desktop tools (see screen-tools.ts). */
  screen?: { kubiKey?: string };
}

/** Sign-in variables a provider may set on its machines. VM Bridge clears them and sets its own. */
const providerVars = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENCODE_API_KEY",
  "KUBI_API_KEY",
];

/** The variables VM Bridge sets itself. Every name in here is reserved: the dashboard cannot set it. */
function managedVars(credentials: VmCredentials): Record<string, string | undefined> {
  return {
    T3CODE_HOME: `${root}/t3-home`,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    GH_TOKEN: credentials.github?.token,
    GITHUB_TOKEN: credentials.github?.token,
    // Agents run without a terminal: fail fast instead of waiting for a password.
    GIT_TERMINAL_PROMPT: "0",
    // gh, Codex and Claude keep sign-ins and sessions in these folders instead of the home folder,
    // where a provider may have put its own sign-ins.
    GH_CONFIG_DIR: `${root}/gh-config`,
    CODEX_HOME: `${root}/codex`,
    CLAUDE_CONFIG_DIR: `${root}/claude`,
    CLAUDE_CODE_OAUTH_TOKEN: credentials.claudeOAuthToken,
    ANTHROPIC_AUTH_TOKEN: credentials.anthropicAuthToken,
    ANTHROPIC_BASE_URL: credentials.anthropicBaseUrl,
    OPENCODE_API_KEY: credentials.opencodeApiKey,
    // The Kubi key for agents: read and control only (see kubi.ts), never the one VM Bridge itself uses.
    KUBI_API_KEY: credentials.screen?.kubiKey,
    OPENCODE_CONFIG: credentials.screen ? opencodeConfigPath() : undefined,
  };
}

/**
 * Names the dashboard cannot set: those VM Bridge sets or clears, and those that would break shells, T3 or the
 * agents. Bash refuses to assign its readonly and array variables (UID, SHELLOPTS, GROUPS), which would stop every
 * script that reads the env file. Prefixes cover T3's and VM Bridge's own settings, bash's own variables (BASHOPTS,
 * BASHPID, BASH_FUNC_ and the rest) and the dynamic linker.
 */
const reservedNames = new Set([
  ...Object.keys(managedVars({})),
  ...providerVars,
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "IFS",
  "ENV",
  "BASH_ENV",
  "SHLVL",
  "UID",
  "EUID",
  "PPID",
  "SHELLOPTS",
  "GROUPS",
  "FUNCNAME",
  "DIRSTACK",
  "PIPESTATUS",
  "POSIXLY_CORRECT",
]);
const reservedPrefixes = ["T3CODE_", "VMBRIDGE_", "LD_", "BASH"];

/** Why a name cannot be an environment variable on the VMs, or null when it can. */
export function envNameProblem(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "Use letters, digits and underscores, not starting with a digit.";
  if (name.length > 128) return "Use at most 128 characters.";
  if (reservedNames.has(name) || reservedPrefixes.some((prefix) => name.startsWith(prefix))) return `${name} is reserved. VM Bridge or the VM sets it.`;
  return null;
}

/** Why a value cannot be an environment variable's, or null when it can. */
export function envValueProblem(value: string) {
  if (value.includes("\0")) return "Values cannot contain a null character.";
  if (Buffer.byteLength(value) > 32_768) return "Use at most 32,768 bytes.";
  return null;
}

function envFile(credentials: VmCredentials, fingerprint: string) {
  const lines = [
    `unset ${providerVars.join(" ")}`,
    `export PATH="${root}/node/bin:${root}/npm/bin:${root}/gh/bin:$PATH"`,
    // Not exported: only start-t3.sh reads it, to record what the server starts with.
    `VMBRIDGE_CREDENTIALS=${fingerprint}`,
  ];
  for (const [name, value] of Object.entries(managedVars(credentials))) if (value) lines.push(`export ${name}=${quote(value)}`);
  // Single quotes keep every value exact, newlines and `$` included. An empty one is still set. A name saved before it
  // was reserved is left out: one that bash refuses would stop setup on every VM.
  for (const [name, value] of Object.entries(credentials.env ?? {})) if (!envNameProblem(name)) lines.push(`export ${name}=${quote(value)}`);
  return `${lines.join("\n")}\n`;
}

/** A git config value, quoted so names with spaces, quotes or `#` survive. */
const gitValue = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Git setup every VM includes from its global config. The empty helper drops any credential helper
 * the provider set for github.com, so git only ever uses VM Bridge's token.
 */
function gitConfig(github: VmCredentials["github"]) {
  const lines = ['[credential "https://github.com"]', "\thelper ="];
  if (github) {
    lines.push(
      `\thelper = store --file ${gitCredentialsPath}`,
      "[user]",
      `\tname = ${gitValue(github.name)}`,
      `\temail = ${gitValue(github.email)}`,
      // SSH remotes go over HTTPS with the token: VMs have no SSH key for GitHub.
      '[url "https://github.com/"]',
      "\tinsteadOf = git@github.com:",
      "\tinsteadOf = ssh://git@github.com/",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Written by the setup script once it succeeds, holding `setupStamp` of the version it set up. */
export const setupStampPath = `${root}/setup-stamp`;

/**
 * OpenCode's clients speak its 2.x API, which npm ships as @opencode/cli. npm's opencode-ai is the 1.x line, which
 * T3's own OpenCode agent keeps using, so this one gets its own folder.
 */
export const openCodeCliVersion = "2.4.2";
export const openCodeDir = `${root}/opencode`;
export const openCodeCli = `${openCodeDir}/cli/bin/opencode`;
/**
 * Installs the CLI unless the VM has this version. Setup starts it in the background and OpenCode's start runs it
 * again, so it holds a lock: a start waits for an install already running instead of racing it. Its own npm cache keeps
 * it from waiting on the cache lock of setup's install running beside it.
 */
export const installOpenCodeCli = `(command -v flock >/dev/null && flock 9; ${openCodeCli} --version 2>/dev/null | grep -qxF "opencode v${openCodeCliVersion}" || npm install -g --prefix ${openCodeDir}/cli --cache ${openCodeDir}/npm-cache --no-audit --no-fund --loglevel=error @opencode/cli@${openCodeCliVersion} >&2) 9>${openCodeDir}/cli.lock`;

/**
 * Idempotent: installs Node when missing, the exact `t3` version, the agent CLIs, gh, and Git access. Connecting skips
 * it while the VM's stamp matches, so changing this text makes every VM run it once more.
 */
const setupScript = `#!/bin/bash
set -euo pipefail
umask 077
# First, so the script's own variables below replace any of the same name from the dashboard.
. ${root}/env
root=${root}
version="$1"
stamp="$2"

fetch() { if command -v curl >/dev/null; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

# t3 needs Node 20.11 or later (import.meta.dirname). E2B's base image has 20.9.
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)'
}
if ! node_ok; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported CPU" >&2; exit 70 ;; esac
  base=https://nodejs.org/dist/latest-v22.x
  file="$(fetch "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.gz" '$2 ~ a { print $2 }')"
  rm -rf "$root/node" && mkdir -p "$root/node"
  fetch "$base/$file" | tar -xz -C "$root/node" --strip-components=1
fi

if ! command -v git >/dev/null; then
  if command -v sudo >/dev/null; then sudo -n apt-get update -qq && sudo -n apt-get install -y -qq git
  else apt-get update -qq && apt-get install -y -qq git; fi
fi

# The GitHub CLI, for agents opening pull requests. It signs in with GH_TOKEN. A pinned release, as GitHub's API
# refuses anonymous calls from IPs that many VMs share (boxd), while release downloads have no such limit.
# Optional: setup goes on without it. Every step is chained, as set -e does not apply inside a function called with ||.
ghversion=2.105.0
install_gh() {
  local gharch
  case "$(uname -m)" in x86_64) gharch=amd64 ;; aarch64|arm64) gharch=arm64 ;; *) return 1 ;; esac
  rm -rf "$root/gh.new" && mkdir -p "$root/gh.new" &&
    fetch "https://github.com/cli/cli/releases/download/v$ghversion/gh_\${ghversion}_linux_$gharch.tar.gz" | tar -xz -C "$root/gh.new" --strip-components=1 &&
    rm -rf "$root/gh" && mv "$root/gh.new" "$root/gh"
}
# Beside the npm install below.
if ! "$root/gh/bin/gh" --version 2>/dev/null | grep -Fq "version $ghversion "; then
  { install_gh || { rm -rf "$root/gh.new"; echo "Could not install the GitHub CLI $ghversion. Setup goes on without it." >&2; }; } &
  gh_pid=$!
fi
mkdir -p "$root/gh-config"

# OpenCode's CLI, for \`vb opencode\`, in the background: setup does not wait for it, and OpenCode's start waits only
# if it is still installing then.
mkdir -p ${openCodeDir}
setsid nohup bash -c ${quote(installOpenCodeCli)} > ${openCodeDir}/install.log 2>&1 < /dev/null &

# Images usually have Node and the agent CLIs already: install only what is missing, in one npm run.
missing=()
installed="$(node -p "require('$root/npm/lib/node_modules/t3/package.json').version" 2>/dev/null || true)"
[ "$installed" = "$version" ] || missing+=("t3@$version")
command -v codex >/dev/null || missing+=(@openai/codex)
command -v claude >/dev/null || missing+=(@anthropic-ai/claude-code)
[ \${#missing[@]} -eq 0 ] || npm install -g --prefix "$root/npm" --no-audit --no-fund --loglevel=error "\${missing[@]}"
mkdir -p "$root/codex" "$root/claude"
# The npm launcher downloads the T3 runtime on first use. Do it now rather than during a request.
t3 --version >/dev/null
[ -z "\${gh_pid:-}" ] || wait "$gh_pid"

git config --global --get-all include.path | grep -Fxq "$root/gitconfig" || git config --global --add include.path "$root/gitconfig"

# Shells opened on the VM, such as over SSH, get what T3 and its agents get. Shells under T3 already have it, as their
# turn started with it, so a change waiting for a busy VM does not reach a turn halfway.
line='[ -n "\${T3CODE_HOME:-}" ] || [ ! -r ${root}/env ] || . ${root}/env'
for rc in .profile .bashrc .bash_profile .bash_login; do
  file="$HOME/$rc"
  case "$rc" in .bash_profile|.bash_login) [ -f "$file" ] || continue ;; esac
  grep -Fqsx "$line" "$file" || printf '\\n%s\\n' "$line" >> "$file"
done

printf '%s' "$stamp" > ${setupStampPath}
`;

/**
 * What a VM set up for this `t3` version holds in `setupStampPath`. A VM, or a base snapshot, holding it skips setup
 * when it connects.
 */
export function setupStamp(t3Version: string) {
  return createHash("sha256").update(`${setupScript}\n${t3Version}`).digest("hex");
}

// Sets only VMBRIDGE_ variables, which the dashboard cannot: assigning a name the env file exported would change it for T3
// and its agents, and a value set in the dashboard would change the script.
const startScript = `#!/bin/bash
set -euo pipefail
. ${root}/env
mkdir -p ${t3DataDir}
printf '%s' "$VMBRIDGE_CREDENTIALS" > ${startedCredentialsPath}
# T3 refuses to start when a runtime record from before a VM stop names a dead or reused PID.
VMBRIDGE_RUNTIME=${t3DataDir}/userdata/server-runtime.json
if [ -f "$VMBRIDGE_RUNTIME" ]; then
  VMBRIDGE_PID="$(node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid;if(Number.isSafeInteger(p))process.stdout.write(String(p))}catch{}' "$VMBRIDGE_RUNTIME")"
  if [ -z "$VMBRIDGE_PID" ] || ! tr '\\0' ' ' < "/proc/$VMBRIDGE_PID/cmdline" 2>/dev/null | grep -q -- ${t3DataDir}; then rm -f "$VMBRIDGE_RUNTIME"; fi
fi
cd ${checkoutRoot}
exec t3 --base-dir ${t3DataDir} --host 0.0.0.0 --port ${t3Port} --no-browser
`;

/** Prints T3's environment descriptor, or exits 1 when no server answers. */
const probeScript = `fetch("http://127.0.0.1:${t3Port}/.well-known/t3/environment",{signal:AbortSignal.timeout(10000)}).then(r=>r.ok?r.text():Promise.reject()).then(t=>process.stdout.write(t),()=>process.exit(1))`;
const probe = `. ${root}/env && node -e ${quote(probeScript)}`;

/** T3's settings file, which it reloads whenever the file changes. */
const t3SettingsPath = `${t3DataDir}/userdata/settings.json`;

/**
 * Switches on T3's OpenCode instance, which T3 ships switched off. Leaves the file alone when it already says whether
 * OpenCode is on, so a user who switched it off on the VM keeps it off, and when it is not a settings object.
 */
const enableOpenCodeScript = `const fs = require("fs");
const path = process.argv[1];
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") process.exit(0);
}
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
if (!isObject(settings)) process.exit(0);
const instances = settings.providerInstances ?? {};
if (!isObject(instances)) process.exit(0);
const opencode = instances.opencode;
if (opencode !== undefined && !isObject(opencode)) process.exit(0);
if (typeof opencode?.enabled === "boolean" || typeof opencode?.config?.enabled === "boolean") process.exit(0);
settings.providerInstances = { ...instances, opencode: { driver: "opencode", ...opencode, enabled: true } };
fs.mkdirSync(require("path").dirname(path), { recursive: true });
fs.writeFileSync(path + ".vmbridge-new", JSON.stringify(settings, null, 2) + "\\n");
fs.renameSync(path + ".vmbridge-new", path);`;

/** Exits 0 when the first Codex auth.json was refreshed later than the second. */
const newerScript = `const at=(p)=>Date.parse(JSON.parse(require("fs").readFileSync(p,"utf8")).last_refresh);process.exit(at(process.argv[1])>at(process.argv[2])?0:1)`;

let latest: { version: string; at: number } | undefined;

/** Resolves the npm `t3` version to install: the pinned one, or the latest release. */
export async function resolveT3Version(pinned: string | null) {
  if (pinned) return pinned;
  if (latest && Date.now() - latest.at < 10 * 60_000) return latest.version;
  const response = await fetch("https://registry.npmjs.org/t3/latest", { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for t3.`);
  const { version } = (await response.json()) as { version: string };
  latest = { version, at: Date.now() };
  return version;
}

export async function check(box: Box, command: string, what: string, timeoutMs = 120_000) {
  const result = await box.run(command, { timeoutMs });
  // Only the tail: setup output is install noise, and the env file is never echoed.
  if (!result.ok) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.output.slice(-600)}`);
  return result.stdout;
}

/**
 * Identifies the sign-ins and variables a T3 server starts with, to tell when a running one has older ones. Codex counts by
 * sign-in rather than by auth.json, which changes every time its tokens refresh and needs no restart.
 */
export function credentialsFingerprint(credentials: VmCredentials, encryption: Encryption) {
  const { codexAuthJson: _refreshes, ...rest } = credentials;
  return encryption.fingerprint(JSON.stringify(rest));
}

/** Installs the OpenCode CLI unless the VM has it. Its output goes to stderr, as stdout is for reports. */
const installOpenCode = `command -v opencode >/dev/null || npm install -g --prefix ${root}/npm --no-audit --no-fund --loglevel=error opencode-ai >&2`;

/** Writes a file atomically, creating its folder, from base64 on stdin. */
export const put = `put() { mkdir -p "\${1%/*}" && base64 -d > "$1.vmbridge-new" && mv -f "$1.vmbridge-new" "$1"; }`;

/**
 * Shell lines writing each file with `put`. The content goes as base64 in a quoted heredoc, so it never reaches a
 * command line, where other users of the VM could read it, and nothing in it can end the heredoc early.
 */
export const writes = (files: Record<string, string>) =>
  Object.entries(files)
    .map(([path, text]) => `put ${quote(path)} <<'VMBRIDGE_FILE'\n${Buffer.from(text).toString("base64").replace(/.{1,76}/g, "$&\n")}VMBRIDGE_FILE`)
    .join("\n");

/**
 * Providers whose SDK sends stdin through several more requests than a file write and a plain command take together:
 * Daytona about 1.7s a program against 0.5s. On E2B the file is slower than stdin.
 */
const programFileProviders = new Set(["daytona"]);

/**
 * The program goes up as a file only the VM's user can read, which becomes the command's stdin and is removed before
 * anything in it runs. A file left by a command that never started is removed here.
 */
async function runFromFile(box: Box, program: string, timeoutMs: number) {
  const path = `/tmp/.vmbridge-program-${crypto.randomUUID()}`;
  await box.files.write(path, program, { mode: 0o600 });
  try {
    return await box.run(`(rm -f ${path}; exec bash -s) < ${path}`, { timeoutMs });
  } catch (error) {
    await box.run(`rm -f ${path}`).catch(() => {});
    throw error;
  }
}

/**
 * Runs a bash program in the VM in one exec. It goes on stdin, so the files it writes never reach a command line. Bash
 * reads `main` whole before running it, and it runs without stdin, so nothing it starts can read the rest of the program.
 */
export async function runProgram(box: Box, body: string, what: string, timeoutMs = 120_000) {
  const program = `set -euo pipefail\nmain() {\n${body}\n}\nmain </dev/null\n`;
  const result = programFileProviders.has(box.provider) ? await runFromFile(box, program, timeoutMs) : await box.run("bash -s", { stdin: program, timeoutMs });
  // Only stderr's tail: setup output is install noise, and stdout can hold the VM's Codex sign-in.
  if (!result.ok) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.slice(-600)}`);
  return result.stdout;
}

/** The sign-in files to write, Codex's aside, and those to delete because their sign-in is gone. */
function signIns(credentials: VmCredentials, fingerprint: string) {
  const { github, codexAuthJson } = credentials;
  const files: Record<string, string> = { [`${root}/env`]: envFile(credentials, fingerprint), [gitConfigPath]: gitConfig(github) };
  if (github) files[gitCredentialsPath] = `https://${encodeURIComponent(github.login)}:${encodeURIComponent(github.token)}@github.com\n`;
  // Older versions kept the GitHub token in `github` too.
  const removed = [`${root}/github`, ...(github ? [] : [gitCredentialsPath]), ...(codexAuthJson ? [] : [codexAuthPath])];
  return { files, removed };
}

/**
 * Writes the sign-ins into the VM, removing those that are gone. Git and gh read them on their next command;
 * agents get them from T3's environment, so only once T3 restarts.
 */
export async function writeCredentials(box: Box, credentials: VmCredentials, fingerprint: string) {
  const { files, removed } = signIns(credentials, fingerprint);
  if (credentials.codexAuthJson) files[codexAuthPath] = credentials.codexAuthJson;
  await runProgram(box, ["umask 077", put, writes(files), `rm -f ${removed.join(" ")}`].join("\n"), "Writing sign-ins");
}

/** What `startT3` needs to know about a T3 server, as found in the VM. */
export interface T3Status {
  /** The `/.well-known/t3/environment` text, or null when no server answers. */
  descriptor: string | null;
  /** The fingerprint of the sign-ins the server started with, or null when it never recorded one. */
  credentials: string | null;
}

export interface PreparedVm {
  /** The VM's Codex auth.json when Codex there refreshed its tokens after VM Bridge last did. The VM keeps it. */
  codexAuth: string | null;
  /** The VM's skills manifest, or null when it has none. */
  skillsManifest: string | null;
  t3: T3Status;
}

/**
 * Brings a VM up to date in one exec, on every wake and connect: writes the sign-ins and scripts, runs setup unless the
 * VM's stamp says it already did for this T3 version, and reports what the connect needs next (see `PreparedVm`).
 * `fingerprint` is the credentials' `credentialsFingerprint`, which T3 records when it starts with them.
 */
export async function prepareVm(box: Box, t3Version: string, credentials: VmCredentials, fingerprint: string): Promise<PreparedVm> {
  const { files, removed } = signIns(credentials, fingerprint);
  const stamp = setupStamp(t3Version);
  const incoming = `${codexAuthPath}.incoming`;
  const tools: ScreenTools | undefined = credentials.screen && { screenId: box.id, kubi: Boolean(credentials.screen.kubiKey) };
  const lines = [
    "umask 077",
    `mkdir -p ${root} && chmod 700 ${root}`,
    put,
    writes({ ...files, ...(tools ? screenToolsFiles(tools) : {}), [`${root}/setup.sh`]: setupScript, [`${root}/start-t3.sh`]: startScript }),
    `rm -f ${removed.join(" ")}`,
    `. ${root}/env`,
    // Setup's output goes to stderr: stdout is the report below. A VM that lost T3 since its stamp runs setup again.
    `if [ "$(cat ${setupStampPath} 2>/dev/null)" != ${quote(stamp)} ] || ! command -v t3 >/dev/null; then bash ${root}/setup.sh ${quote(t3Version)} ${quote(stamp)} >&2; fi`,
    // Outside setup, as it follows the sign-ins rather than the image. Only with a sign-in: without one the CLI is not
    // installed, and T3 would list OpenCode as broken.
    `if [ -n "\${OPENCODE_API_KEY:-}" ]; then`,
    `  ${installOpenCode}`,
    `  node -e ${quote(enableOpenCodeScript)} ${t3SettingsPath}`,
    "fi",
    ...(tools ? [screenToolsSetup(tools)] : []),
  ];
  if (credentials.codexAuthJson) {
    lines.push(
      writes({ [incoming]: credentials.codexAuthJson }),
      // Codex on the VM may have refreshed its tokens while VM Bridge could not reach it, retiring the refresh token VM
      // Bridge holds. Then the VM keeps its file and VM Bridge adopts it.
      `if [ -f ${codexAuthPath} ] && node -e ${quote(newerScript)} ${codexAuthPath} ${incoming}; then rm -f ${incoming}; echo "codex $(base64 < ${codexAuthPath} | tr -d '\\n')"; else mv -f ${incoming} ${codexAuthPath}; fi`,
    );
  }
  lines.push(
    `[ ! -f ${root}/skills.json ] || echo "skills $(base64 < ${root}/skills.json | tr -d '\\n')"`,
    `if answer="$(node -e ${quote(probeScript)})"; then echo "t3 $(printf '%s' "$answer" | base64 | tr -d '\\n')"; fi`,
    `[ ! -f ${startedCredentialsPath} ] || echo "started $(cat ${startedCredentialsPath})"`,
  );
  const stdout = await runProgram(box, lines.join("\n"), "VM setup", 10 * 60_000);
  const report = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) report.set(line.slice(0, space), line.slice(space + 1));
  }
  const decoded = (key: string) => {
    const value = report.get(key);
    return value === undefined ? null : Buffer.from(value, "base64").toString();
  };
  return {
    codexAuth: decoded("codex"),
    skillsManifest: decoded("skills"),
    t3: { descriptor: decoded("t3"), credentials: report.get("started") ?? null },
  };
}

/** The VM's Codex auth.json, which Codex rewrites when it refreshes its own tokens. */
export async function readCodexAuth(box: Box): Promise<string | null> {
  try {
    return await box.files.read(codexAuthPath);
  } catch {
    return null;
  }
}

/** Replaces the VM's Codex sign-in. Codex reads the file again before it next refreshes. */
export async function writeCodexAuth(box: Box, authJson: string) {
  await box.files.write({ [codexAuthPath]: authJson }, { mode: 0o600 });
}

export interface T3Server {
  /** The server's `/.well-known/t3/environment` descriptor. */
  descriptor: { orchestrationProtocolVersion?: number; serverVersion?: string };
  token: string;
  /**
   * Fingerprint of the sign-ins the running server started with, as it recorded them, or null for a server
   * started before VM Bridge recorded them. Read back rather than assumed, since a restart can fail either side
   * of relaunching the server.
   */
  credentials: string | null;
}

/**
 * Starts the T3 server unless it already answers, and issues VM Bridge a session token when it has none.
 * With `restart`, a server already running is restarted, so it and the agents it runs read the env file
 * again. Only safe while nothing runs on the VM. `found` is what `prepareVm` found, which saves probing again.
 */
export async function startT3(box: Box, token: string | null, restart = false, found?: T3Status): Promise<T3Server> {
  let descriptor = found ? found.descriptor : await probeT3(box);
  // What the VM recorded holds until the server starts again here. Undefined: read it below.
  let credentials = found?.credentials;
  if (descriptor && restart) {
    // A failed restart leaves the old server answering, or none, which the start below handles.
    await box.process("t3").restart().catch(() => {});
    descriptor = await probeT3(box);
    credentials = undefined;
  }
  if (!descriptor) {
    const options = {
      name: "t3",
      ready: { http: { port: t3Port, path: "/.well-known/t3/environment" } },
      readyTimeoutMs: 120_000,
    };
    try {
      await box.start(`bash ${root}/start-t3.sh`, options);
    } catch (error) {
      // A record left by a server that stopped answering: replace it.
      if (!(error instanceof Error && error.message.includes("already running"))) throw error;
      await box.process("t3").restart();
    }
    descriptor = await probeT3(box);
    if (!descriptor) throw new Error("The T3 server started but does not answer. See its log in the VM.");
    credentials = undefined;
  }
  token ??= (
    await check(
      box,
      `. ${root}/env && t3 auth session issue --base-dir ${t3DataDir} --ttl 30d --label 'VM Bridge' --token-only`,
      "Issuing a T3 session",
    )
  ).trim();
  if (credentials === undefined) credentials = await box.files.read(startedCredentialsPath).catch(() => null);
  return { descriptor: JSON.parse(descriptor) as T3Server["descriptor"], token, credentials };
}

async function probeT3(box: Box) {
  const answer = await box.run(probe, { timeoutMs: 15_000 });
  return answer.ok ? answer.stdout : null;
}

/**
 * Sets up a VM to save as a base snapshot for new VMs: the tools only, with no sign-ins, variables or GitHub token.
 * Checks that T3 starts, then stops it and removes its data, so each VM made from the base gets its own T3 server.
 * The setup stamp stays, so those VMs skip setup when they first connect.
 */
export async function prepareBase(box: Box, t3Version: string) {
  // No sign-ins, so nothing to fingerprint; the env file goes before the snapshot anyway.
  await prepareVm(box, t3Version, {}, "");
  await startT3(box, null);
  await box.process("t3").stop();
  // Providers snapshot a running VM like a power cut (Instabox says so), so writes still in memory would be lost.
  await check(box, `rm -rf ${t3DataDir} ${root}/env ${gitConfigPath} && sync`, "Clearing the base VM");
}
