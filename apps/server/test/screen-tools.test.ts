import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfig, opencodeConfig, screenToolsFiles } from "../src/vm/screen-tools.ts";

const withKey = { screenId: "scr_1", kubi: true };
const withoutKey = { screenId: "scr_1", kubi: false };

describe("agent configs on Kubi VMs", () => {
  test("Codex gets the browser and desktop on display :0, and Kubi's server with the key from the environment", () => {
    expect(Bun.TOML.parse(codexConfig(withKey))).toEqual({
      mcp_servers: {
        browser: { command: "bash", args: ["/workspace/.vmbridge/browser-mcp.sh"], env: { DISPLAY: ":0" }, startup_timeout_sec: 30 },
        desktop: { command: "node", args: ["/workspace/.vmbridge/desktop-mcp.cjs", "scr_1"], env: { DISPLAY: ":0" }, startup_timeout_sec: 30 },
        kubi: { url: "https://mcp.trykubi.com", bearer_token_env_var: "KUBI_API_KEY" },
      },
    });
    expect(Object.keys((Bun.TOML.parse(codexConfig(withoutKey)) as { mcp_servers: object }).mcp_servers)).toEqual(["browser", "desktop"]);
  });

  test("OpenCode gets the same servers in its own format, without asking for an OAuth sign-in", () => {
    expect(JSON.parse(opencodeConfig(withKey)).mcp).toEqual({
      browser: { type: "local", command: ["bash", "/workspace/.vmbridge/browser-mcp.sh"], environment: { DISPLAY: ":0" }, enabled: true },
      desktop: { type: "local", command: ["node", "/workspace/.vmbridge/desktop-mcp.cjs", "scr_1"], environment: { DISPLAY: ":0" }, enabled: true },
      kubi: { type: "remote", url: "https://mcp.trykubi.com", oauth: false, headers: { Authorization: "Bearer {env:KUBI_API_KEY}" }, enabled: true },
    });
    expect(Object.keys(JSON.parse(opencodeConfig(withoutKey)).mcp)).toEqual(["browser", "desktop"]);
  });
});

describe("the desktop server", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the server with an xdotool that logs its arguments, sends `requests`, and returns the answers by id. */
  async function talk(requests: object[]) {
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-desktop-"));
    dirs.push(dir);
    writeFileSync(join(dir, "server.cjs"), screenToolsFiles(withKey)["/workspace/.vmbridge/desktop-mcp.cjs"]!);
    writeFileSync(join(dir, "xdotool"), `#!/bin/sh\necho "$DISPLAY $*" >> "${dir}/xdotool.log"\n`);
    chmodSync(join(dir, "xdotool"), 0o755);
    const input = requests.map((request) => `${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`).join("");
    const server = Bun.spawn(["node", join(dir, "server.cjs"), "scr_1"], {
      stdin: "pipe",
      stdout: "pipe",
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    server.stdin.write(input);
    type Answer = { id: number; result?: Record<string, unknown>; error?: { code: number } };
    const answers = new Map<number, Answer>();
    const reader = server.stdout.getReader();
    let text = "";
    while (answers.size < requests.filter((request) => "id" in request).length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      for (const line of text.split("\n").slice(0, -1)) {
        const answer = JSON.parse(line) as Answer;
        answers.set(answer.id, answer);
      }
    }
    server.kill();
    const log = () => readFileSync(join(dir, "xdotool.log"), "utf8").trim().split("\n");
    return { answers, log };
  }

  test("speaks MCP, names its screen for Kubi's tools, and drives xdotool on display :0, one call at a time", async () => {
    const { answers, log } = await talk([
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "click", arguments: { x: 10, y: 20, count: 2 } } },
      { id: 4, method: "tools/call", params: { name: "drag", arguments: { x: 1, y: 2, to_x: 3, to_y: 4 } } },
      { id: 5, method: "tools/call", params: { name: "type", arguments: { text: "--help" } } },
      { id: 6, method: "tools/call", params: { name: "key", arguments: { keys: "ctrl+l Return" } } },
    ]);
    expect(answers.get(1)!.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect(answers.get(1)!.result!.instructions).toContain('pass screen "scr_1"');
    const tools = answers.get(2)!.result!.tools as { name: string; description: string }[];
    expect(tools.map((tool) => tool.name)).toEqual(["screenshot", "click", "move", "drag", "scroll", "type", "key"]);
    expect(tools[0]!.description).toContain("Kubi screen scr_1");
    for (const id of [3, 4, 5, 6]) expect(answers.get(id)!.result!.isError).toBeUndefined();
    // Calls sent together still run in order, so the drag ends before typing starts. Typed text comes after `--`, so it
    // is never read as an option.
    expect(log()).toEqual([
      ":0 mousemove --sync 10 20 click --repeat 2 1",
      ":0 mousemove --sync 1 2 mousedown 1",
      ":0 mousemove --sync 3 4 mouseup 1",
      ":0 type --delay 12 -- --help",
      ":0 key -- ctrl+l Return",
    ]);
  });

  test("answers a bad call as a tool error, and an unknown method as a protocol error", async () => {
    const { answers } = await talk([
      { id: 1, method: "tools/call", params: { name: "click", arguments: { x: -1, y: "top" } } },
      { id: 2, method: "resources/list" },
      { id: 3, method: "tools/call", params: { name: "type", arguments: { text: "a".repeat(10001) } } },
      { id: 4, method: "tools/call", params: { name: "type", arguments: { text: "TYPE_SECRET\u0000tail" } } },
      { id: 5, method: "tools/call", params: { name: "key", arguments: { keys: "KEY_SECRET\u0000tail" } } },
    ]);
    expect(answers.get(1)!.result).toEqual({ content: [{ type: "text", text: "x must be a whole number of pixels, 0 or more." }], isError: true });
    expect(answers.get(2)!.error!.code).toBe(-32601);
    expect(answers.get(3)!.result).toEqual({ content: [{ type: "text", text: "text must be at most 10000 characters." }], isError: true });
    expect(answers.get(4)!.result).toEqual({ content: [{ type: "text", text: "text must not contain null bytes." }], isError: true });
    expect(answers.get(5)!.result).toEqual({ content: [{ type: "text", text: "keys must not contain null bytes." }], isError: true });
  });

  test("scales xdotool timeout for long typed text and omits typed arguments from failure messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-desktop-timeout-"));
    dirs.push(dir);
    writeFileSync(join(dir, "server.cjs"), screenToolsFiles(withKey)["/workspace/.vmbridge/desktop-mcp.cjs"]!);
    writeFileSync(
      join(dir, "stub.cjs"),
      `const cp = require("child_process");
const fs = require("fs");
cp.execFile = (command, args, options, cb) => {
  fs.appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, JSON.stringify({ command, len: args.at(-1).length, timeout: options.timeout }) + "\\n");
  if (args.at(-1).includes("TIMEOUT_SECRET")) {
    const err = new Error("Command failed: " + command + " " + args.join(" "));
    err.killed = true;
    return cb(err, "", "");
  }
  if (args.at(-1).includes("EXIT_SECRET")) {
    const err = new Error("Command failed: " + command + " " + args.join(" "));
    err.code = 1;
    return cb(err, "", "");
  }
  cb(null, "", "");
};
`,
    );
    const requests = [
      { id: 1, method: "tools/call", params: { name: "type", arguments: { text: "x".repeat(5000) } } },
      { id: 2, method: "tools/call", params: { name: "type", arguments: { text: "TIMEOUT_SECRET" } } },
      { id: 3, method: "tools/call", params: { name: "type", arguments: { text: "EXIT_SECRET" } } },
    ];
    const server = Bun.spawn(["node", "--require", join(dir, "stub.cjs"), join(dir, "server.cjs"), "scr_1"], {
      stdin: "pipe",
      stdout: "pipe",
    });
    server.stdin.write(requests.map((request) => `${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`).join(""));
    type Answer = { id: number; result?: { content: { type: string; text: string }[]; isError?: boolean } };
    const answers = new Map<number, Answer>();
    const reader = server.stdout.getReader();
    let text = "";
    while (answers.size < requests.length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      for (const line of text.split("\n").slice(0, -1)) {
        const answer = JSON.parse(line) as Answer;
        answers.set(answer.id, answer);
      }
    }
    server.kill();

    const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { command: string; len: number; timeout: number });
    expect(calls[0]).toEqual({ command: "xdotool", len: 5000, timeout: 20000 + 5000 * 24 });
    expect(answers.get(1)!.result!.isError).toBeUndefined();
    expect(answers.get(2)!.result).toEqual({ content: [{ type: "text", text: "xdotool timed out after 20s." }], isError: true });
    expect(answers.get(3)!.result).toEqual({ content: [{ type: "text", text: "xdotool failed (exit 1)." }], isError: true });
  });
});
