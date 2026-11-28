import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Overview } from "@vmbridge/contracts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { dashboardKey, databasePath, start } from "../src/index.ts";
import { threadActivity } from "../src/gateway/types.ts";

const password = "sessions test password";
let cleanup = async () => {};
afterEach(() => {
  const run = cleanup;
  cleanup = async () => {};
  return run();
});

test("a VM's sessions name their agent and model as T3 lists them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-sessions-"));
  const keys = dashboardKey(dir);
  await keys.set(password);
  keys.close();
  const db = openDatabase(databasePath(dir));
  db.run("INSERT INTO vms (id, provider, name, size, state, created_at) VALUES ('a1b2c3d4e5f6', 'e2b', 'vm1', 'medium', 'sleeping', 0)");
  const config = {
    environment: { environmentId: "env1", orchestrationProtocolVersion: 2 },
    providers: [
      { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }] },
      { instanceId: "codex", driver: "codex", enabled: true, models: [] },
    ],
  };
  const thread = (id: string, provider: string, model: string) => ({ id, projectId: null, title: id, status: "idle", providerInstanceId: provider, modelSelection: { provider, model } });
  const shell = { snapshotSequence: 1, projects: [], threads: [thread("t1", "claudeAgent", "claude-opus-5-5"), thread("t2", "codex", "gpt-6"), thread("t3", "pi", "pi-1")], archivedThreads: [] };
  for (const id of ["t1", "t2", "t3"]) db.run("INSERT INTO threads (id, vm_id) VALUES (?, 'a1b2c3d4e5f6')", id);
  db.run("INSERT INTO vm_snapshots (vm_id, config, shell) VALUES ('a1b2c3d4e5f6', ?, ?)", JSON.stringify(config), JSON.stringify(shell));
  db.close();

  const bridge = await start({ dir, host: "127.0.0.1", port: 0 });
  cleanup = async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${bridge.port}`;
  const login = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ key: password }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const overview = (await (await fetch(`${base}/admin/api/overview`, { headers: { cookie } })).json()) as Overview;

  expect(overview.vms[0]!.sessions.map(({ agent, model }) => ({ agent, model }))).toEqual([
    { agent: { kind: "claude", name: "Claude" }, model: "Claude Opus 5.5" },
    // A model its agent does not list keeps its ID. An agent VM Bridge has no logo for keeps its name.
    { agent: { kind: "codex", name: "Codex" }, model: "gpt-6" },
    { agent: { kind: null, name: "Pi" }, model: "pi-1" },
  ]);
});

test("a thread's status is decided as T3's sidebar decides it", () => {
  const at = "2026-11-28T10:00:00.000Z";
  const ms = Date.parse(at);
  const cases: [Record<string, unknown>, ReturnType<typeof threadActivity>][] = [
    // A question for the user outranks the run it belongs to.
    [{ status: "running", activeRunId: "r1", pendingRuntimeRequest: { kind: "user_input" } }, { state: "input", since: null }],
    [{ status: "running", pendingRuntimeRequest: { kind: "command_execution_approval" } }, { state: "approval", since: null }],
    [{ status: "running", activityRunStartedAt: at }, { state: "working", since: ms }],
    [{ status: "running", latestRunStartedAt: at, blockedOnThreadWait: true }, { state: "waiting", since: ms }],
    [{ status: "queued" }, { state: "starting", since: null }],
    [{ status: "completed", latestRunCompletedAt: at, pendingBackgroundTasks: [{ id: "b1" }] }, { state: "waiting", since: null }],
    [{ status: "completed", latestRunCompletedAt: at }, { state: "done", since: ms }],
    [{ status: "failed", latestRunCompletedAt: at }, { state: "failed", since: ms }],
    [{ status: "interrupted" }, { state: "idle", since: null }],
    [{ status: "idle" }, { state: "idle", since: null }],
  ];
  for (const [thread, activity] of cases) expect(threadActivity(thread)).toEqual(activity);
});
