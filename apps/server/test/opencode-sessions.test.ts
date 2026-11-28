import { EventEmitter } from "node:events";
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { openSocket } from "../src/bun/socket.ts";
import type { Fleet } from "../src/fleet.ts";
import { Store } from "../src/store.ts";
import { OpenCodeServer, worktreePath } from "../src/vm/opencode.ts";
import { OpenCodeSessions, describeOpenCodeSessions, readableName } from "../src/vm/opencode-sessions.ts";
import { testEncryption } from "./key.ts";

const checkout = "/workspace/acme";
const worktree = (name: string) => worktreePath(checkout, name);

/** OpenCode 2.4.2's answers, as the real server gave them. */
const entry = (id: string, directory: string, extra: object = {}) => ({
  id,
  projectID: "x",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 100 },
  location: { directory },
  ...extra,
});
let listed = [
  entry("ses_work", worktree("abcd1234"), { title: "Fix login", model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "default" }, time: { created: 1, updated: 300 } }),
  entry("ses_idle", worktree("wxyz5678"), { title: "Docs", model: { id: "mystery-9", providerID: "newco" }, time: { created: 1, updated: 200 } }),
  entry("ses_root", checkout),
  entry("ses_sub", worktree("abcd1234"), { title: "Subagent", parentID: "ses_work" }),
  entry("ses_elsewhere", "/home/other"),
  entry("ses_gone", worktree("gone1234")),
];
let asked: string[] = [];
/** False while OpenCode has just started and lists no providers or models yet. */
let catalogLoaded = true;
const vm = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    asked.push(url.pathname + url.search);
    if (url.pathname === "/api/session") return Response.json({ data: listed, cursor: { previous: null, next: null } });
    if (!catalogLoaded && (url.pathname === "/api/model" || url.pathname === "/api/integration")) return Response.json({ data: [] });
    if (url.pathname === "/api/model") return Response.json({ data: [{ providerID: "anthropic", modelID: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
    if (url.pathname === "/api/integration") return Response.json({ data: [{ id: "anthropic", name: "Anthropic" }, { id: "newco", name: "NewCo AI" }] });
    if (url.pathname === "/api/session/active") return Response.json({ data: { ses_work: { running: true } } });
    return new Response("no", { status: 404 });
  },
});
afterAll(() => vm.stop(true));

function setup() {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "kubi", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
  store.insertProject({ id: "p1", url: "https://github.com/acme/acme.git", branch: null, title: "acme", createdAt: 0 });
  store.addProjectVm("p1", "vm1");
  store.setCheckout("p1", "vm1", checkout);
  store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "abcd1234", branch: "opencode/abcd1234", base: null });
  store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "wxyz5678", branch: "fix/docs", base: null });
  const server = new OpenCodeServer("vm1", { url: `http://127.0.0.1:${vm.port}/`, headers: {} }, "pw", openSocket);
  const state = { connected: ["vm1"], server: server as OpenCodeServer | null, looked: 0, changed: 0 };
  const fleet = Object.assign(new EventEmitter(), {
    connected: () => state.connected,
    runningOpenCode: async () => (state.looked++, state.server),
  }) as unknown as Fleet;
  fleet.on("changed", () => state.changed++);
  return { store, state, sessions: new OpenCodeSessions(fleet) };
}

describe("OpenCode sessions of a VM", () => {
  test("maps folders to repository and branch, working or idle, newest first, and the command that reopens each", async () => {
    asked = [];
    const { store, sessions } = setup();
    await sessions.refresh("vm1");
    const shown = describeOpenCodeSessions(sessions.get("vm1"), "vm1", store);
    const anthropic = { id: "anthropic", name: "Anthropic" };
    expect(shown).toEqual([
      // The generated opencode/<name> branch says nothing, so it is left out.
      { id: "ses_work", title: "Fix login", projectId: "p1", repository: "acme", branch: null, provider: anthropic, model: "Claude Opus 5.5", working: true, updatedAt: 300, resumeCommand: "vb opencode resume abcd1234" },
      // A provider the catalog names, with a model it lacks: the id is cleaned up.
      { id: "ses_idle", title: "Docs", projectId: "p1", repository: "acme", branch: "fix/docs", provider: { id: "newco", name: "NewCo AI" }, model: "Mystery 9", working: false, updatedAt: 200, resumeCommand: "vb opencode resume wxyz5678" },
      { id: "ses_root", title: "Untitled", projectId: "p1", repository: "acme", branch: null, provider: null, model: null, working: false, updatedAt: 100, resumeCommand: null },
    ]);
    expect(asked.sort()).toEqual(["/api/integration", "/api/model", "/api/session/active", "/api/session?archived=false&limit=50"]);

    // Names are kept: the next look asks for the sessions only, though one id is still not in the catalog.
    asked = [];
    await sessions.refresh("vm1");
    expect(asked.sort()).toEqual(["/api/session/active", "/api/session?archived=false&limit=50"]);
  });

  test("reads the catalog again a minute later when OpenCode had not loaded it yet", async () => {
    catalogLoaded = false;
    try {
      const { sessions } = setup();
      await sessions.refresh("vm1");
      const newco = () => sessions.get("vm1").find((session) => session.id === "ses_idle")?.provider?.name;
      expect(newco()).toBe("Newco");
      catalogLoaded = true;
      await sessions.refresh("vm1");
      expect(newco()).toBe("Newco");
      setSystemTime(Date.now() + 61_000);
      await sessions.refresh("vm1");
      expect(newco()).toBe("NewCo AI");
    } finally {
      catalogLoaded = true;
      setSystemTime();
    }
  });

  test("asks only a VM whose OpenCode is already running, and keeps the last list when it is not", async () => {
    const { state, sessions } = setup();
    state.server = null;
    await sessions.refreshAll();
    expect(sessions.get("vm1")).toEqual([]);
    expect(state.changed).toBe(0);

    state.server = setup().state.server;
    await sessions.refreshAll();
    expect(sessions.get("vm1")).toHaveLength(5);
    expect(state.changed).toBe(1);
    // An unchanged list is not a change, so the dashboard is not pushed an update for it.
    await sessions.refreshAll();
    expect(state.changed).toBe(1);

    // Asleep, or OpenCode stopped: nothing is read, and the last list stays.
    state.connected = [];
    state.server = null;
    asked = [];
    await sessions.refreshAll();
    await sessions.refresh("vm1");
    expect(asked).toEqual([]);
    expect(sessions.get("vm1")).toHaveLength(5);
  });

  test("a failing OpenCode keeps the last list", async () => {
    const { state, sessions } = setup();
    await sessions.refresh("vm1");
    const bad = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x", { status: 500 }) });
    state.server = new OpenCodeServer("vm1", { url: `http://127.0.0.1:${bad.port}/`, headers: {} }, "pw", openSocket);
    await sessions.refresh("vm1");
    expect(sessions.get("vm1")).toHaveLength(5);
    bad.stop(true);
  });

  test("falls back to a cleaned-up id when the catalog has no name", () => {
    expect(readableName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(readableName("anthropic/claude-sonnet-4.5")).toBe("Claude Sonnet 4.5");
    expect(readableName("gpt_5_codex")).toBe("Gpt 5 Codex");
  });
});
