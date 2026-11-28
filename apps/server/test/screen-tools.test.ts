import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  async function talk(
    requests: object[],
    options: { rawPrefix?: string; xdotool?: (dir: string) => string; awaitExit?: boolean } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-desktop-"));
    dirs.push(dir);
    writeFileSync(join(dir, "server.cjs"), screenToolsFiles(withKey)["/workspace/.vmbridge/desktop-mcp.cjs"]!);
    writeFileSync(
      join(dir, "xdotool"),
      options.xdotool?.(dir) ?? `#!/bin/sh\necho "$DISPLAY $*" >> "${dir}/xdotool.log"\n`,
    );
    chmodSync(join(dir, "xdotool"), 0o755);
    const input =
      (options.rawPrefix ?? "") +
      requests.map((request) => `${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`).join("");
    const server = Bun.spawn(["node", join(dir, "server.cjs"), "scr_1"], {
      stdin: "pipe",
      stdout: "pipe",
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    server.stdin.write(input);
    if (options.awaitExit) server.stdin.end();
    type Answer = { jsonrpc?: string; id: number; result?: Record<string, unknown>; error?: { code: number } };
    const answers = new Map<number, Answer>();
    const reader = server.stdout.getReader();
    let text = "";
    while (answers.size < requests.filter((request) => "id" in request).length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      const lines = text.split("\n");
      text = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        const answer = JSON.parse(line) as Answer;
        answers.set(answer.id, answer);
      }
    }
    const exitCode = options.awaitExit ? await server.exited : (server.kill(), null);
    const log = () => {
      const logPath = join(dir, "xdotool.log");
      return existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [];
    };
    return { answers, log, exitCode };
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
    ]);
    expect(answers.get(1)!.result).toEqual({ content: [{ type: "text", text: "x must be a whole number of pixels, 0 or more." }], isError: true });
    expect(answers.get(2)!.error!.code).toBe(-32601);
  });

  test("drag validates destination coordinates before pressing the mouse button", async () => {
    const { answers, log } = await talk([
      { id: 1, method: "tools/call", params: { name: "drag", arguments: { x: 1, y: 2, to_x: -5, to_y: 4 } } },
    ]);
    expect(answers.get(1)!.result).toEqual({
      content: [{ type: "text", text: "to_x must be a whole number of pixels, 0 or more." }],
      isError: true,
    });
    expect(log()).toEqual([]);
  });

  test("drag releases the mouse button when the mousedown step fails and preserves its error", async () => {
    const { answers, log } = await talk(
      [{ id: 1, method: "tools/call", params: { name: "drag", arguments: { x: 1, y: 2, to_x: 3, to_y: 4 } } }],
      {
        xdotool: (dir) =>
          `#!/bin/sh\necho "$DISPLAY $*" >> "${dir}/xdotool.log"\nif [ "$1" = "mousemove" ] && [ "$3" = "1" ]; then echo "mousedown failed" >&2; exit 1; fi\nif [ "$1" = "mouseup" ]; then echo "mouseup failed" >&2; exit 1; fi\n`,
      },
    );
    expect(answers.get(1)!.result).toEqual({
      content: [{ type: "text", text: "mousedown failed" }],
      isError: true,
    });
    expect(log()).toEqual([
      ":0 mousemove --sync 1 2 mousedown 1",
      ":0 mouseup 1",
    ]);
  });

  test("drag releases the mouse button when the move-and-release step fails", async () => {
    const { answers, log } = await talk(
      [{ id: 1, method: "tools/call", params: { name: "drag", arguments: { x: 1, y: 2, to_x: 3, to_y: 4 } } }],
      {
        xdotool: (dir) =>
          `#!/bin/sh\necho "$DISPLAY $*" >> "${dir}/xdotool.log"\nif [ "$1" = "mousemove" ] && [ "$3" = "3" ]; then echo "move failed" >&2; exit 1; fi\n`,
      },
    );
    expect(answers.get(1)!.result).toEqual({
      content: [{ type: "text", text: "move failed" }],
      isError: true,
    });
    expect(log()).toEqual([
      ":0 mousemove --sync 1 2 mousedown 1",
      ":0 mousemove --sync 3 4 mouseup 1",
      ":0 mouseup 1",
    ]);
  });

  test("ignores non-object JSON lines on stdin and keeps answering requests", async () => {
    const { answers, exitCode } = await talk([{ id: 1, method: "ping" }], {
      rawPrefix: 'null\n123\n"hi"\n[]\n',
      awaitExit: true,
    });
    expect(answers.get(1)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(exitCode).toBe(0);
  });
});
