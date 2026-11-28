import { quote, root } from "./runtime.ts";

/**
 * Browser and desktop tools for the agents on a Kubi VM, whose screen is a whole desktop: X display :0 with Chromium
 * open and its debugging port on 127.0.0.1:9222. Claude Code, Codex and OpenCode each get, as MCP servers:
 * - `browser`: Playwright's MCP server attached to that Chromium, so every step shows on the screen.
 * - `desktop`: a small server here that takes screenshots and drives the mouse and keyboard with xdotool.
 * - `kubi`: Kubi's hosted MCP server, only when the user gave a Kubi key for agents. Agents read it from KUBI_API_KEY.
 *
 * Only paths and names go into the agents' configs, never the key. Nothing here runs on other providers' VMs.
 */

export interface ScreenTools {
  /** The VM's Kubi screen. Kubi's tools take it as `screen`, as its key may reach the user's other screens too. */
  screenId: string;
  /** Whether the VM has a Kubi key for agents, in KUBI_API_KEY. */
  kubi: boolean;
}

/** Pinned like the other tools VM Bridge installs. Changing it reinstalls on every Kubi VM as it next connects. */
const playwrightMcpVersion = "0.0.86";
const kubiMcpUrl = "https://mcp.trykubi.com";
const display = ":0";

const paths = () => ({
  browser: `${root}/browser-mcp.sh`,
  desktop: `${root}/desktop-mcp.cjs`,
  opencode: `${root}/opencode.json`,
  claude: `${root}/claude/.claude.json`,
  codex: "/etc/codex/config.toml",
});

/** The OpenCode config file Kubi VMs point OPENCODE_CONFIG at. OpenCode merges it with the user's own. */
export const opencodeConfigPath = () => paths().opencode;

interface LocalServer {
  command: string;
  args: string[];
}

function servers({ screenId, kubi }: ScreenTools) {
  const local: Record<string, LocalServer> = {
    browser: { command: "bash", args: [paths().browser] },
    desktop: { command: "node", args: kubi ? [paths().desktop, screenId] : [paths().desktop] },
  };
  return { local, remote: kubi ? { kubi: kubiMcpUrl } : {} };
}

/** Claude Code's user-level servers, in `.claude.json`. Claude expands `${KUBI_API_KEY}` when it connects. */
export function claudeServers(tools: ScreenTools) {
  const { local, remote } = servers(tools);
  const entries: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(local)) entries[name] = { type: "stdio", ...server, env: { DISPLAY: display } };
  for (const [name, url] of Object.entries(remote)) entries[name] = { type: "http", url, headers: { Authorization: "Bearer ${KUBI_API_KEY}" } };
  return entries;
}

/**
 * Codex's system config, below the user's own config.toml, so VM Bridge owns the whole file. Codex passes servers only
 * a few variables of its own, so DISPLAY is set here.
 */
export function codexConfig(tools: ScreenTools) {
  const { local, remote } = servers(tools);
  // JSON strings are valid TOML basic strings.
  const string = (value: string) => JSON.stringify(value);
  const lines = ["# Written by VM Bridge on Kubi VMs, which replaces it each time the VM connects."];
  for (const [name, server] of Object.entries(local)) {
    lines.push(
      "",
      `[mcp_servers.${name}]`,
      `command = ${string(server.command)}`,
      `args = [${server.args.map(string).join(", ")}]`,
      `env = { DISPLAY = ${string(display)} }`,
      // Starting Chromium can take a few seconds.
      "startup_timeout_sec = 30",
    );
  }
  for (const [name, url] of Object.entries(remote)) lines.push("", `[mcp_servers.${name}]`, `url = ${string(url)}`, 'bearer_token_env_var = "KUBI_API_KEY"');
  return `${lines.join("\n")}\n`;
}

/** OpenCode's config, which Kubi VMs name in OPENCODE_CONFIG. */
export function opencodeConfig(tools: ScreenTools) {
  const { local, remote } = servers(tools);
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(local)) {
    mcp[name] = { type: "local", command: [server.command, ...server.args], environment: { DISPLAY: display }, enabled: true };
  }
  for (const [name, url] of Object.entries(remote)) {
    mcp[name] = { type: "remote", url, oauth: false, headers: { Authorization: "Bearer {env:KUBI_API_KEY}" }, enabled: true };
  }
  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2)}\n`;
}

/**
 * Sets VM Bridge's servers in Claude Code's `.claude.json`, which Claude itself rewrites, and removes one VM Bridge set
 * before that should be gone, such as `kubi` once the key is removed. A server the user changed is theirs and stays.
 */
const claudeMergeScript = `const fs = require("fs");
const [path, set, drop] = process.argv.slice(1).map((value, index) => (index ? JSON.parse(value) : value));
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") process.exit(0);
}
if (config === null || typeof config !== "object" || Array.isArray(config)) process.exit(0);
const servers = { ...config.mcpServers };
for (const [name, server] of Object.entries(drop)) if (JSON.stringify(servers[name]) === JSON.stringify(server)) delete servers[name];
const next = { ...config, mcpServers: { ...servers, ...set } };
if (JSON.stringify(next) === JSON.stringify(config)) process.exit(0);
fs.writeFileSync(path + ".vmbridge-new", JSON.stringify(next, null, 2) + "\\n");
fs.renameSync(path + ".vmbridge-new", path);`;

/**
 * The desktop server: MCP over stdio, newline-delimited JSON-RPC, with no dependencies. Coordinates are pixels of the
 * screenshot, which is the whole display at its own size. `scrot` takes the screenshot, as no tool on the screen does.
 */
const desktopServer = `"use strict";
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const screen = process.argv[2];
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":0" };
const run = (command, args) =>
  new Promise((resolve, reject) =>
    execFile(command, args, { env, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout),
    ),
  );
const xdotool = (...args) => run("xdotool", args.map(String));
const pixel = (value, name) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(name + " must be a whole number of pixels, 0 or more.");
  return value;
};
const whole = { type: "integer", minimum: 0 };
const point = { x: whole, y: whole };
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const done = [{ type: "text", text: "Done. Take a screenshot to see the result." }];
const mouse = { left: 1, middle: 2, right: 3 };
const wheel = { up: 4, down: 5, left: 6, right: 7 };

const tools = [
  {
    name: "screenshot",
    description:
      "The whole desktop now, as a PNG. Every other tool takes pixels of this image." +
      (screen ? " This desktop is Kubi screen " + screen + ": pass screen \\"" + screen + "\\" to Kubi's tools." : ""),
    inputSchema: { type: "object", properties: {} },
    async run() {
      const file = path.join(os.tmpdir(), "vmbridge-desktop-" + process.pid + "-" + Date.now() + ".png");
      try {
        await run("scrot", ["--overwrite", "--silent", "--pointer", file]);
        return [{ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" }];
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  },
  {
    name: "click",
    description: "Clicks at a point. button: left (default), right or middle. count: 2 double-clicks.",
    inputSchema: {
      type: "object",
      properties: { ...point, button: { enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 } },
      required: ["x", "y"],
    },
    async run({ x, y, button = "left", count = 1 }) {
      if (!mouse[button] || ![1, 2, 3].includes(count)) throw new Error("Use button left, right or middle, and count 1 to 3.");
      await xdotool("mousemove", "--sync", pixel(x, "x"), pixel(y, "y"), "click", "--repeat", count, mouse[button]);
    },
  },
  {
    name: "move",
    description: "Moves the pointer to a point, to hover.",
    inputSchema: { type: "object", properties: point, required: ["x", "y"] },
    async run({ x, y }) {
      await xdotool("mousemove", "--sync", pixel(x, "x"), pixel(y, "y"));
    },
  },
  {
    name: "drag",
    description: "Presses the left button at x, y, moves to to_x, to_y and releases it there.",
    inputSchema: { type: "object", properties: { ...point, to_x: whole, to_y: whole }, required: ["x", "y", "to_x", "to_y"] },
    async run({ x, y, to_x, to_y }) {
      const fromX = pixel(x, "x");
      const fromY = pixel(y, "y");
      const toX = pixel(to_x, "to_x");
      const toY = pixel(to_y, "to_y");
      try {
        await xdotool("mousemove", "--sync", fromX, fromY, "mousedown", 1);
        await xdotool("mousemove", "--sync", toX, toY, "mouseup", 1);
      } catch (error) {
        await xdotool("mouseup", 1).catch(() => {});
        throw error;
      }
    },
  },
  {
    name: "scroll",
    description: "Turns the mouse wheel at a point. amount is in notches, 3 by default.",
    inputSchema: {
      type: "object",
      properties: { ...point, direction: { enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["x", "y", "direction"],
    },
    async run({ x, y, direction, amount = 3 }) {
      if (!wheel[direction] || !Number.isInteger(amount) || amount < 1 || amount > 50) throw new Error("Use direction up, down, left or right, and amount 1 to 50.");
      await xdotool("mousemove", "--sync", pixel(x, "x"), pixel(y, "y"), "click", "--repeat", amount, wheel[direction]);
    },
  },
  {
    name: "type",
    description: "Types text into the focused window.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 10000 } }, required: ["text"] },
    async run({ text }) {
      if (typeof text !== "string") throw new Error("text must be a string.");
      await xdotool("type", "--delay", 12, "--", text);
    },
  },
  {
    name: "key",
    description: "Presses keys or chords, in xdotool names, such as Return, ctrl+s or alt+Tab. Separate several with spaces.",
    inputSchema: { type: "object", properties: { keys: { type: "string", maxLength: 200 } }, required: ["keys"] },
    async run({ keys }) {
      const names = typeof keys === "string" ? keys.split(/\\s+/).filter(Boolean) : [];
      if (!names.length) throw new Error("Name at least one key.");
      await xdotool("key", "--", ...names);
    },
  },
];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

/** Runs a tool and, after an action, waits for the screen to settle so the next call sees its result. Never rejects. */
async function act(tool, args) {
  try {
    const content = await tool.run(args);
    if (!content) await settle();
    return { content: content || done };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

// Tool calls run one at a time, in the order they came. Agents may send several at once, and they share one mouse,
// keyboard and screen: run together, a drag could release in the middle of typed text.
let turn = Promise.resolve();

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  // Notifications and non-object JSON values need no answer.
  if (!message || typeof message !== "object" || Array.isArray(message) || message.id === undefined || message.id === null) return;
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      return send({
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "desktop", version: "1.0.0" },
          instructions:
            "The VM's own desktop, the one a person watching the screen sees. Take a screenshot, act on its pixels, then take another." +
            (screen ? " This desktop is Kubi screen " + screen + ": pass screen \\"" + screen + "\\" to Kubi's tools." : ""),
        },
      });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: tools.map(({ run, ...tool }) => tool) } });
    if (method === "tools/call") {
      const tool = tools.find((entry) => entry.name === (params && params.name));
      if (!tool) return send({ id, error: { code: -32602, message: "Unknown tool" } });
      const call = turn.then(() => act(tool, (params && params.arguments) || {}));
      turn = call;
      return send({ id, result: await call });
    }
    send({ id, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) void handle(line).catch(() => {});
  }
});
`;

/** Playwright's MCP server on the screen's Chromium. Starts Chromium first when someone closed it. */
const browserServer = () => `#!/bin/bash
export DISPLAY="\${DISPLAY:-${display}}"
up() { (exec 3<>/dev/tcp/127.0.0.1/9222) 2>/dev/null; }
if ! up; then
  setsid chromium --remote-debugging-port=9222 >/dev/null 2>&1 < /dev/null &
  for _ in $(seq 50); do up && break; sleep 0.2; done
fi
# Its files go to a temporary folder rather than into the project's checkout.
exec ${root}/npm/bin/playwright-mcp --cdp-endpoint http://127.0.0.1:9222 --output-dir "\${TMPDIR:-/tmp}/playwright-mcp" "$@"
`;

/** The files to write on a Kubi VM. Codex's goes to its own folder first; `screenToolsSetup` copies it into /etc. */
export function screenToolsFiles(tools: ScreenTools): Record<string, string> {
  return {
    [paths().browser]: browserServer(),
    [paths().desktop]: desktopServer,
    [paths().opencode]: opencodeConfig(tools),
    [`${root}/codex-system.toml`]: codexConfig(tools),
  };
}

/**
 * Shell lines installing what the tools need and registering them with Claude Code and Codex, after the files are
 * written. Optional: the VM sets up without them, as with gh. Every step is chained, as set -e does not apply here.
 */
export function screenToolsSetup(tools: ScreenTools) {
  const without = claudeServers({ ...tools, kubi: false });
  const withKubi = claudeServers({ ...tools, kubi: true });
  const set = tools.kubi ? withKubi : without;
  const drop = Object.fromEntries(Object.entries(withKubi).filter(([name]) => !(name in set)));
  const installed = `node -p "require('${root}/npm/lib/node_modules/@playwright/mcp/package.json').version" 2>/dev/null`;
  const { claude, codex } = paths();
  return `screen_tools() {
  { command -v xdotool >/dev/null && command -v scrot >/dev/null; } ||
    { sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xdotool scrot; } || return 1
  [ "$(${installed})" = ${playwrightMcpVersion} ] ||
    npm install -g --prefix ${root}/npm --no-audit --no-fund --loglevel=error @playwright/mcp@${playwrightMcpVersion} || return 1
  mkdir -p ${root}/claude && node -e ${quote(claudeMergeScript)} ${claude} ${quote(JSON.stringify(set))} ${quote(JSON.stringify(drop))} || return 1
  cmp -s ${root}/codex-system.toml ${codex} || sudo -n install -D -m 644 ${root}/codex-system.toml ${codex}
}
screen_tools >&2 || echo "Could not set up the browser and desktop tools for agents. Setup goes on without them." >&2`;
}
