import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { AgentAuth, AgentSecrets } from "../src/agent-auth/profiles.ts";
import { BudgetReached } from "../src/budget.ts";
import { bunMachine } from "../src/bun/machine.ts";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Fleet } from "../src/fleet.ts";
import { FileTrees } from "../src/gateway/files.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import { threadStamp } from "../src/gateway/saved.ts";
import type { Projection, Shell, Wire } from "../src/gateway/types.ts";
import type { SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { Box, Driver } from "../src/providers/index.ts";
import { saveEnvVars, Secrets, Settings } from "../src/settings.ts";
import { Skills } from "../src/skills.ts";
import type { VmLoad } from "../src/placement.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { T3Rejected } from "../src/vm/backend.ts";
import { programFiles } from "./vm-program.ts";
import { testEncryption } from "./key.ts";

/** No resource readings: placement goes by thread counts and size labels alone. */
const unmeasured = { get: () => null, lastDisk: () => null };

/** Returned by a fake T3 answer to leave the request open, as T3 does for streams. */
const open = Symbol("open");
/** Returned by a fake T3 answer to fail the request, as T3 does when it rejects a command. */
const fail = Symbol("fail");

/** Just enough of a T3 server for a `Backend`: socket tickets, the RPC socket, and the shell read. */
function fakeT3() {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const state = {
    sockets,
    shell: { threads: [{ id: "t1", status: "idle" }], archivedThreads: [], projects: [] } as Shell,
    answer: (tag: string, _payload: Wire): unknown => (tag.toLowerCase().includes("subscribe") ? open : null),
    /** A thread's whole history, as `GET /api/orchestration/threads/:threadId` answers it. */
    thread: async (threadId: string): Promise<Response> =>
      Response.json({ snapshotSequence: 1, projection: { thread: { id: threadId }, updatedAt: "2026-01-01T00:00:00.000Z", turnItems: [], visibleTurnItems: [] } }),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/websocket-ticket/rpc") return Response.json({ ticket: "ticket" });
      if (path === "/api/orchestration/shell") return Response.json(state.shell);
      const thread = /^\/api\/orchestration\/threads\/([^/]+)$/.exec(path);
      if (thread) return state.thread(decodeURIComponent(thread[1]!));
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/projects/mutate") return Response.json({});
      if (path === "/ws" && server.upgrade(request, { data: undefined })) return undefined;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      async message(socket, raw) {
        const frame = JSON.parse(String(raw)) as Wire;
        if (frame._tag !== "Request") return;
        const value = await state.answer(String(frame.tag), frame.payload as Wire);
        if (value === open) return;
        const exit = value === fail ? { _tag: "Failure", cause: [] } : { _tag: "Success", value };
        socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }));
      },
    },
  });
  servers.push(server);
  return { ...state, state, url: `http://127.0.0.1:${server.port}` };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const fleets: Fleet[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const fleet of fleets.splice(0)) fleet.close();
  for (const server of servers.splice(0)) server.stop(true);
});

const ok = (stdout = "") => ({ ok: true, exitCode: 0, stdout, stderr: "", output: stdout });
const failed = { ok: false, exitCode: 1, stdout: "", stderr: "", output: "" };
const envPath = "/workspace/.vmbridge/env";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function setup(skillRoots?: string[]) {
  const t3 = fakeT3();
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  settings.set("providers", ["boxd"]);
  settings.set("defaultProvider", "boxd");
  settings.set("t3Version", "1.0.0");
  const store = new Store(db, testEncryption);
  const secrets = new Secrets(db, testEncryption);
  const recorded: Parameters<Traffic["record"]>[0][] = [];
  const traffic = { record: (event: Parameters<Traffic["record"]>[0]) => void recorded.push(event) } as unknown as Traffic;
  const signIns: AgentSecrets = {};
  const agents = { vmSecrets: async () => ({ ...signIns }), adoptCodex: () => {}, codexDue: () => false } as unknown as AgentAuth;
  const skills = new Skills(db, testEncryption, bunMachine(undefined, () => skillRoots ?? []));

  /** The VM's files, and its T3 server: whether it runs and the env file it started with, as agents inherit it. */
  const files: Record<string, string> = {};
  const server = { running: false, env: "", starts: 0, restarts: 0, failRestart: false };
  /**
   * What OpenCode's server on the VM says about its agents, or another probe `answer`, and how often VM Bridge stopped
   * it. With `failStop`, stopping it fails.
   */
  const opencode = { busy: false, answer: undefined as string | undefined, stops: 0, failStop: false };
  /** What each skills sync sent, and the order skill syncs and T3 starts happened in. */
  const synced: { skills: { name: string; files?: unknown[] }[]; instructions: { agent: string; text: string }[] }[] = [];
  const order: string[] = [];
  /** Every call that reaches the VM: commands, file reads and writes, starts and preview URLs. */
  const calls: string[] = [];
  const startedPath = "/workspace/.vmbridge/t3/credentials";
  const startServer = () => {
    server.running = true;
    server.env = files[envPath] ?? "";
    // As start-t3.sh does.
    files[startedPath] = /^VMBRIDGE_CREDENTIALS=(.*)$/m.exec(server.env)?.[1] ?? "";
  };
  /** Does what a program `prepareVm` or `writeCredentials` sends does to the files, and reports as `prepareVm` reads it. */
  const runProgram = (program: string) => {
    Object.assign(files, programFiles(program));
    for (const [, paths] of program.matchAll(/^rm -f (.+)$/gm)) for (const path of paths!.split(" ")) delete files[path];
    const incoming = "/workspace/.vmbridge/codex/auth.json.incoming";
    if (files[incoming] !== undefined) {
      files["/workspace/.vmbridge/codex/auth.json"] = files[incoming];
      delete files[incoming];
    }
    if (!program.includes("setup.sh")) return ok();
    const report = [
      files["/workspace/.vmbridge/skills.json"] !== undefined && `skills ${btoa(files["/workspace/.vmbridge/skills.json"])}`,
      server.running && `t3 ${btoa(JSON.stringify({ orchestrationProtocolVersion: 2 }))}`,
      files[startedPath] !== undefined && `started ${files[startedPath]}`,
    ];
    return ok(report.filter(Boolean).join("\n"));
  };
  const box = {
    id: "sb1",
    run: async (command: string, options: { stdin?: string } = {}) => {
      calls.push(command);
      if (command === "bash -s") return runProgram(options.stdin!);
      if (command.includes("auth session issue")) return ok("token");
      if (command.includes("well-known")) return server.running ? ok(JSON.stringify({ orchestrationProtocolVersion: 2 })) : failed;
      if (command.startsWith("rm -f ")) for (const path of command.slice(6).split(" ")) delete files[path];
      if (command.includes("/api/session/active")) return ok(opencode.answer ?? (opencode.busy ? "busy" : "idle"));
      // As skills.mjs does, minus the files.
      if (command.includes("skills.mjs")) {
        const incoming = JSON.parse(files["/workspace/.vmbridge/skills-incoming.json"]!) as {
          fingerprint: string;
          skills: { name: string; hash: string }[];
          instructions: { agent: string; text: string }[];
        };
        synced.push(incoming);
        order.push("skills");
        const applied = Object.fromEntries(incoming.skills.map((skill) => [skill.name, skill.hash]));
        files["/workspace/.vmbridge/skills.json"] = JSON.stringify({ fingerprint: incoming.fingerprint, skills: applied });
      }
      return ok();
    },
    files: {
      read: async (path: string) => {
        calls.push(`read ${path}`);
        if (files[path] === undefined) throw new Error("No such file.");
        return files[path];
      },
      write: async (written: Record<string, string>) => {
        calls.push(`write ${Object.keys(written).join(" ")}`);
        Object.assign(files, written);
      },
    },
    start: async () => {
      calls.push("start");
      server.starts++;
      order.push("start");
      startServer();
    },
    process: (name: string) => ({
      stop: async () => {
        if (name === "opencode" && opencode.failStop) throw new Error("The provider did not answer.");
        if (name === "opencode") opencode.stops++;
      },
      restart: async () => {
        server.restarts++;
        order.push("restart");
        for (const socket of t3.sockets) socket.close();
        startServer();
        if (server.failRestart) throw new Error("T3 did not answer in time.");
      },
    }),
    preview: async () => (calls.push("preview"), { url: t3.url, headers: {} }),
  } as unknown as Box;
  const events: string[] = [];
  // Pauses by default, like boxd and Instabox: T3 keeps running through sleep.
  const driver = {
    create: async () => (events.push("create"), box),
    wake: async () => (events.push("wake"), box),
    sleep: async (): Promise<{ checkpoint?: string }> => (events.push("sleep"), {}),
    destroy: async (sandboxId: string) => void events.push(`destroy ${sandboxId}`),
    connect: async () => box,
    keepAlive: async () => {},
    deleteCheckpoint: async (checkpoint: string) => void events.push(`delete checkpoint ${checkpoint}`),
    list: async (): Promise<SandboxInfo[]> => [],
  };
  /** Another Fleet on the same database, as after VM Bridge restarts. */
  const newFleet = () => {
    const fleet = new Fleet(store, settings, secrets, traffic, agents, skills, openSocket);
    fleet.driver = () => driver as unknown as Driver;
    fleets.push(fleet);
    return fleet;
  };
  const fleet = newFleet();
  return { t3, db, store, settings, secrets, fleet, newFleet, driver, box, events, traffic, recorded, signIns, agents, files, server, opencode, skills, synced, order, calls };
}

describe("creating and deleting VMs", () => {
  test("deleting a VM still being created waits for it, then deletes it at the provider", async () => {
    const { fleet, store, driver, box, events } = setup();
    const created = gate();
    driver.create = async () => (events.push("create"), await created.promise, box);

    const creating = fleet.create();
    const [vm] = store.vms();
    expect(vm?.state).toBe("provisioning");
    const deleting = fleet.destroy(vm!.id);
    await Bun.sleep(5);
    expect(store.vm(vm!.id)).not.toBeNull();

    created.release();
    await creating;
    await deleting;
    expect(events).toEqual(["create", "destroy sb1"]);
    expect(store.vm(vm!.id)).toBeNull();
  });

  test("two requests for T3's configuration at once start one VM", async () => {
    const { fleet, store, events } = setup();
    const [a, b] = await Promise.all([fleet.any(), fleet.any()]);
    expect(a).toBe(b);
    expect(store.vms()).toHaveLength(1);
    expect(events).toEqual(["create", "wake"]);
  });

  test("records create, first start, sleep, wake and delete for analytics, but not a reconnect", async () => {
    const { fleet, store, newFleet } = setup();
    const waking: [string, boolean][] = [];
    fleet.on("waking", (id, fromSleep) => waking.push([id, fromSleep]));
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);
    // A wake connects after the sleep, never in the same millisecond as here.
    await Bun.sleep(2);
    await fleet.ensure(vm.id);
    // VM Bridge restarts while the VM runs: connecting again is not a start.
    fleet.close();
    const after = newFleet();
    after.on("waking", (id, fromSleep) => waking.push([id, fromSleep]));
    await after.ensure(vm.id);
    await after.destroy(vm.id);
    // Each wake tells the threads it is coming; the reconnect says it is not a wake from sleep.
    expect(waking).toEqual([[vm.id, true], [vm.id, true], [vm.id, false]]);
    const recorded = store.vmEvents(0, Date.now() + 1);
    expect(recorded.map((event) => event.kind)).toEqual(["create", "start", "sleep", "wake", "delete"]);
    expect(recorded.every((event) => event.vmId === vm.id && event.provider === "boxd")).toBe(true);
    expect(recorded.find((event) => event.kind === "wake")?.durationMs).toBeNumber();
  });
});

describe("VMs VM Bridge lost track of", () => {
  const sandbox = (id: string, key: string | undefined, bridge: string): SandboxInfo => ({ id, key, labels: { "sandbox-sdk": "1", vmbridge: bridge }, state: "running", createdAt: 0 });

  test("deletes this bridge's VMs nobody has on record and drops creates a restart cut short, touching nothing else", async () => {
    const { fleet, store, settings, driver, events } = setup();
    const ours = settings.get("bridgeId").slice(0, 12);
    const kept = await fleet.create();
    // Created before VM Bridge stopped: the row never got its sandbox.
    store.insertVm({ id: "aaaaaaaaaaaa", provider: "boxd", name: "vm-aaaaaa", size: "medium", state: "provisioning", createdAt: 0 });
    store.saveBase("boxd", "medium", { builder: "sb-builder" });
    driver.list = async () => [
      sandbox("sb1", kept.id, ours),
      sandbox("sb-stuck", "aaaaaaaaaaaa", ours),
      sandbox("sb-deleted-row", "bbbbbbbbbbbb-m1abc", ours),
      sandbox("sb-build", "base-cccccccccccc", ours),
      sandbox("sb-builder", "base-dddddddddddd", ours),
      sandbox("sb-other-bridge", "eeeeeeeeeeee", "otherbridge0"),
      sandbox("sb-no-key", undefined, ours),
      sandbox("sb-own-key", "my-app", ours),
    ];
    events.length = 0;
    await fleet.reconcile("boxd");
    expect(events).toEqual(["destroy sb-stuck", "destroy sb-deleted-row", "destroy sb-build"]);
    expect(store.vm("aaaaaaaaaaaa")).toBeNull();
    expect(store.vm(kept.id)).not.toBeNull();
  });

  test("leaves a VM alone while its create runs", async () => {
    const { fleet, store, settings, driver, box, events } = setup();
    const created = gate();
    driver.create = async () => (events.push("create"), await created.promise, box);
    const creating = fleet.create();
    await until(() => events.includes("create"));
    const [vm] = store.vms();
    driver.list = async () => [sandbox("sb1", vm!.id, settings.get("bridgeId").slice(0, 12))];
    await fleet.reconcile("boxd");
    created.release();
    await creating;
    expect(events).toEqual(["create"]);
    expect(store.vm(vm!.id)).toMatchObject({ sandboxId: "sb1" });
  });

  test("records whether it worked, so a failure from a refused key clears once the provider answers", async () => {
    const { fleet, driver, recorded } = setup();
    driver.list = async () => {
      throw new Error("Boat GET /sandboxes failed (HTTP 401 unauthorized)");
    };
    await fleet.reconcile("boxd");
    driver.list = async () => [];
    await fleet.reconcile("boxd");
    expect(recorded).toEqual([
      { kind: "provider", operation: "look for untracked VMs", provider: "boxd", status: "error", reason: "Boat GET /sandboxes failed (HTTP 401 unauthorized)" },
      { kind: "provider", operation: "look for untracked VMs", provider: "boxd", status: "ok" },
    ]);
  });

  test("runs on start, before VMs reconnect", async () => {
    const { store, settings, driver, events, newFleet } = setup();
    driver.list = async () => [sandbox("sb-lost", "ffffffffffff", settings.get("bridgeId").slice(0, 12))];
    await newFleet().resume();
    await until(() => events.includes("destroy sb-lost"));
    expect(store.vms()).toEqual([]);
  });
});

describe("waking", () => {
  test("a VM that wakes but fails setup is closed and put back to sleep", async () => {
    const { fleet, store, t3, events } = setup();
    fleet.onConnect = async () => {
      throw new Error("T3 sent something unexpected.");
    };
    const failures: string[] = [];
    fleet.on("wakeFailed", (_, reason) => failures.push(reason));
    const vm = await fleet.create();
    await expect(fleet.ensure(vm.id)).rejects.toThrow("T3 sent something unexpected.");
    expect(failures).toEqual(["T3 sent something unexpected."]);
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.vm(vm.id)).toMatchObject({ state: "error", error: "T3 sent something unexpected." });
    expect(fleet.backend(vm.id)).toBeUndefined();
    await until(() => t3.sockets.size === 0);
  });

  test("waking a paused VM takes one command in it, and using a connected VM takes none", async () => {
    const { fleet, calls } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);
    calls.length = 0;
    await fleet.ensure(vm.id);
    expect(calls).toEqual(["bash -s", "preview"]);
    calls.length = 0;
    await fleet.ensure(vm.id);
    expect(calls).toEqual([]);
  });

  test("T3 refusing a request is told apart from the socket dropping", async () => {
    const { fleet, t3 } = setup();
    const backend = await fleet.ensure((await fleet.create()).id);
    t3.state.answer = () => fail;
    expect(await backend.call("orchestration.dispatchCommand", {}).catch((error: unknown) => error)).toBeInstanceOf(T3Rejected);
    t3.state.answer = () => {
      for (const socket of t3.sockets) socket.close();
      return open;
    };
    const dropped = await backend.call("orchestration.dispatchCommand", {}).catch((error: unknown) => error);
    expect(dropped).toBeInstanceOf(Error);
    expect(dropped).not.toBeInstanceOf(T3Rejected);
  });
});

describe("a spent budget", () => {
  const reason = "VM Bridge reached this month's budget of $1.00.";

  test("refuses new VMs and wakes with its reason, leaving a sleeping VM asleep until the budget is raised", async () => {
    const { fleet, store, events } = setup();
    fleet.onConnect = async () => {};
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);
    // A wake connects after the sleep, never in the same millisecond as here.
    await Bun.sleep(2);
    fleet.refusal = () => reason;
    events.length = 0;

    await expect(fleet.create()).rejects.toThrow(reason);
    await expect(fleet.ensure(vm.id)).rejects.toBeInstanceOf(BudgetReached);
    expect(events).toEqual([]);
    expect(store.vms().map((entry) => entry.state)).toEqual(["sleeping"]);

    fleet.refusal = () => null;
    await fleet.ensure(vm.id);
    expect(events).toEqual(["wake"]);
  });

  test("never stops a VM already running: it keeps serving, and a dropped connection reconnects", async () => {
    const { fleet, store, t3, events } = setup();
    fleet.reconnectPausesMs = [1, 1, 1];
    fleet.onConnect = async () => {};
    const vm = await fleet.create();
    const before = await fleet.ensure(vm.id);
    t3.state.shell = { threads: [{ id: "t1", status: "running" }], archivedThreads: [], projects: [] } as Shell;
    fleet.refusal = () => reason;
    events.length = 0;

    expect(await fleet.ensure(vm.id)).toBe(before);
    for (const socket of t3.sockets) socket.close();
    await until(() => Boolean(fleet.backend(vm.id)?.open) && fleet.backend(vm.id) !== before);
    expect(store.vm(vm.id)?.state).toBe("ready");
    expect(events).toEqual(["wake"]);
  });
});

describe("checkpoints", () => {
  test("waking from a checkpoint deletes the checkpoint", async () => {
    const { fleet, store, driver, box, events } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    await fleet.sleep(vm.id);
    driver.wake = async () => (events.push("wake"), { ...box, id: "sb2" });
    await fleet.ensure(vm.id);
    expect(events).toEqual(["create", "wake", "sleep", "wake", "delete checkpoint cp1"]);
    expect(store.vm(vm.id)).toMatchObject({ sandboxId: "sb2", checkpoint: null });
  });

  test("a checkpoint that could not be deleted after a wake is deleted by the next sweep", async () => {
    const { fleet, store, driver, box, events } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    await fleet.sleep(vm.id);
    driver.wake = async () => (events.push("wake"), { ...box, id: "sb2" });
    driver.deleteCheckpoint = async () => {
      throw new Error("Railway is down.");
    };
    await fleet.ensure(vm.id);
    expect(store.retiredSnapshots("boxd")).toEqual(["cp1"]);
    driver.deleteCheckpoint = async (checkpoint) => void events.push(`delete checkpoint ${checkpoint}`);
    await fleet.bases.sweep("boxd");
    expect(events.at(-1)).toBe("delete checkpoint cp1");
    expect(store.retiredSnapshots("boxd")).toEqual([]);
  });

  test("deleting a VM asleep as a checkpoint deletes the checkpoint", async () => {
    const { fleet, driver, events } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    await fleet.sleep(vm.id);
    await fleet.destroy(vm.id);
    expect(events).toEqual(["create", "wake", "sleep", "destroy sb1", "delete checkpoint cp1"]);
  });

  test("a VM a failed wake put back to sleep as a checkpoint is not slept again", async () => {
    const { fleet, store, driver, events } = setup();
    fleet.onConnect = async () => {
      throw new Error("T3 sent something unexpected.");
    };
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    const vm = await fleet.create();
    await expect(fleet.ensure(vm.id)).rejects.toThrow("T3 sent something unexpected.");
    await fleet.sleep(vm.id);
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.vm(vm.id)).toMatchObject({ state: "error", checkpoint: "cp1" });
  });
});

describe("placing new threads", () => {
  /** A project already on its primary VM, and the live turns placement sees on each VM (2 vCPUs each). */
  async function placed() {
    const context = setup();
    context.fleet.onConnect = async () => {};
    context.store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    const primary = await context.fleet.place("p1");
    const turns = new Map<string, number>();
    const claimed: string[] = [];
    const placeThread = (only?: ReadonlySet<string>) =>
      context.fleet.placeThread("p1", {
        only,
        load: (vm): VmLoad => ({ vmId: vm.id, awake: Boolean(context.fleet.backend(vm.id)), turns: turns.get(vm.id) ?? 0, vcpus: 2, memory: null, disk: null }),
        placed: (vmId) => claimed.push(vmId),
        progress: () => {},
      });
    return { ...context, primary, turns, claimed, placeThread };
  }

  test("a VM with room takes the thread", async () => {
    const { primary, turns, events, placeThread, claimed } = await placed();
    turns.set(primary, 3);
    expect(await placeThread()).toEqual({ vmId: primary, notice: null });
    expect(claimed).toEqual([primary]);
    expect(events).toEqual(["create", "wake"]);
  });

  test("a full VM gets a second one like it, which holds the same project under the same ID", async () => {
    const { primary, turns, store, settings, placeThread } = await placed();
    // A rule changed since the primary was made: the new VM still matches the primary.
    settings.set("repoRules", [{ repo: "acme/app", provider: null, size: "large" }]);
    turns.set(primary, 4);
    const second = await placeThread();
    expect(second.notice).toBeNull();
    expect(second.vmId).not.toBe(primary);
    expect(store.vm(second.vmId)).toMatchObject({ provider: "boxd", size: store.vm(primary)!.size });
    expect(store.project("p1")?.vms.map((entry) => entry.vmId)).toEqual([primary, second.vmId]);
    expect(store.project("p1")?.vms[1]?.checkoutPath).toBe("/workspace/app");
  });

  test("with the budget spent, a full project gets no new VM: the thread goes to its awake VM with the busy notice", async () => {
    const { primary, turns, fleet, store, events, placeThread } = await placed();
    turns.set(primary, 4);
    fleet.refusal = () => "VM Bridge reached this month's budget.";
    events.length = 0;
    const placement = await placeThread();
    expect(placement.vmId).toBe(primary);
    expect(placement.notice).not.toBeNull();
    expect(store.vms()).toHaveLength(1);
    expect(events).toEqual([]);
  });

  test("with the budget spent, a thread for a sleeping project fails with the budget's reason", async () => {
    const { primary, fleet, placeThread } = await placed();
    await fleet.sleep(primary);
    await Bun.sleep(2);
    fleet.refusal = () => "VM Bridge reached this month's budget.";
    await expect(placeThread()).rejects.toThrow("VM Bridge reached this month's budget.");
  });

  test("waking a VM for a placement says which VM, and what the wake is doing as it goes", async () => {
    const { primary, fleet, store } = await placed();
    await fleet.sleep(primary);
    await Bun.sleep(2);
    const steps: string[] = [];
    const details: string[] = [];
    await fleet.placeThread("p1", {
      load: (vm): VmLoad => ({ vmId: vm.id, awake: Boolean(fleet.backend(vm.id)), turns: 0, vcpus: 2, memory: null, disk: null }),
      placed: () => {},
      progress: (step) => steps.push(step),
      detail: (text) => details.push(text),
    });
    expect(steps).toEqual([`Waking ${store.vm(primary)!.name} on boxd`]);
    expect(details).toEqual(["Waiting for boxd", "Preparing the VM", "Starting T3", "Waiting for T3 to answer", "Reading T3's settings"]);
  });

  test("for OpenCode, a placement waits only until the VM is prepared, never for T3, which goes on starting", async () => {
    const { primary, fleet } = await placed();
    await fleet.sleep(primary);
    await Bun.sleep(2);
    const t3Answers = gate();
    fleet.onConnect = () => t3Answers.promise;
    const details: string[] = [];
    const placement = await fleet.placeThread("p1", {
      load: (vm): VmLoad => ({ vmId: vm.id, awake: Boolean(fleet.backend(vm.id)), turns: 0, vcpus: 2, memory: null, disk: null }),
      placed: () => {},
      progress: () => {},
      detail: (text) => details.push(text),
      forOpenCode: true,
    });
    expect(placement.vmId).toBe(primary);
    expect(details).toEqual(["Waiting for boxd", "Preparing the VM"]);
    expect(fleet.machineReady(primary)).toBe(true);
    expect(fleet.backend(primary)).toBeUndefined();
    t3Answers.release();
    await until(() => Boolean(fleet.backend(primary)));
  });

  test("T3 failing after OpenCode took the VM leaves it awake for OpenCode", async () => {
    const { primary, fleet, store, events } = await placed();
    await fleet.sleep(primary);
    await Bun.sleep(2);
    const t3Answers = gate();
    fleet.onConnect = async () => {
      await t3Answers.promise;
      throw new Error("T3 sent something unexpected.");
    };
    const wake = fleet.ensure(primary);
    wake.catch(() => {});
    await fleet.machine(primary);
    // As a worktree being made, or OpenCode starting, holds it.
    const release = fleet.lease(primary);
    events.length = 0;
    t3Answers.release();
    await expect(wake).rejects.toThrow("T3 sent something unexpected.");
    release();
    expect(events).toEqual([]);
    expect(store.vm(primary)).toMatchObject({ state: "error" });
    expect(fleet.machineReady(primary)).toBe(true);
  });

  test("a sleeping VM with room is woken before a new one is made", async () => {
    const { primary, turns, fleet, events, placeThread } = await placed();
    turns.set(primary, 4);
    const second = (await placeThread()).vmId;
    await fleet.sleep(second);
    events.length = 0;
    expect(await placeThread()).toEqual({ vmId: second, notice: null });
    expect(events).toEqual(["wake"]);
  });

  test("a thread starting from a branch only one VM has goes there, asleep or busy, and by the usual rules once that VM is gone", async () => {
    const { primary, turns, fleet, store, events, placeThread } = await placed();
    turns.set(primary, 4);
    const second = (await placeThread()).vmId;
    await fleet.sleep(second);
    turns.set(primary, 0);
    events.length = 0;
    expect(await placeThread(new Set([second]))).toEqual({ vmId: second, notice: null });
    expect(events).toEqual(["wake"]);

    // Busy, it still takes the thread, as a new VM would not have the branch either.
    turns.set(second, 4);
    expect(await placeThread(new Set([second]))).toEqual({ vmId: second, notice: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." });
    expect(store.project("p1")?.vms).toHaveLength(2);

    store.removeVmFromProjects(second);
    expect((await placeThread(new Set([second]))).vmId).toBe(primary);
  });

  test("when the provider refuses another VM, the thread goes to the least loaded one with a notice, and later threads do not ask again", async () => {
    const { primary, turns, store, driver, events, placeThread } = await placed();
    turns.set(primary, 5);
    driver.create = async () => {
      events.push("create");
      throw new Error("Quota exceeded.");
    };
    events.length = 0;
    expect(await placeThread()).toEqual({ vmId: primary, notice: "This VM is running 5 threads on 2 vCPUs, so this one may be slow." });
    // The refused VM leaves no row behind.
    expect(store.vms().map((vm) => vm.id)).toEqual([primary]);
    expect((await placeThread()).vmId).toBe(primary);
    expect(events).toEqual(["create"]);
  });
});

function idleFleet() {
  const context = setup();
  const hub = new Hub(context.store, context.settings, context.fleet, context.traffic, unmeasured);
  // Only the fleet's own lifecycle is under test here, not T3's streams.
  context.fleet.onConnect = async () => {};
  return { ...context, hub };
}

describe("idle sleep", () => {
  const later = () => Date.now() + 24 * 60 * 60_000;

  test("is dropped when a request takes the VM while transcripts are being saved", async () => {
    const { fleet, hub, t3, events } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    let release = () => {};
    const read = t3.state.thread;
    t3.state.thread = (threadId) => {
      release = fleet.lease(vm.id);
      return read(threadId);
    };

    await hub.sweep(later());
    expect(events).toEqual(["create", "wake"]);
    expect(fleet.backend(vm.id)).toBeDefined();
    release();
  });

  test("waits while an agent runs in OpenCode, which counts as activity, and goes ahead an idle period after it stops", async () => {
    const { fleet, hub, store, events, opencode } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    opencode.busy = true;
    const first = later();
    await hub.sweep(first);
    expect(events).toEqual(["create", "wake"]);
    expect(store.vm(vm.id)?.lastActivityAt).toBe(first);

    opencode.busy = false;
    // Within the idle period of the last time it was busy, the VM is not even asked.
    await hub.sweep(first + 60_000);
    expect(events).toEqual(["create", "wake"]);
    await hub.sweep(first + 24 * 60 * 60_000);
    expect(events).toEqual(["create", "wake", "sleep"]);
  });

  test("is dropped when the VM started work while transcripts were being saved", async () => {
    const { fleet, hub, t3, events } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const read = t3.state.thread;
    t3.state.thread = (threadId) => {
      t3.state.shell = { threads: [{ id: "t1", status: "running" }] };
      return read(threadId);
    };

    await hub.sweep(later());
    expect(events).toEqual(["create", "wake"]);
    expect(fleet.backend(vm.id)).toBeDefined();
  });

  test("first saves the whole history of each thread with no copy, or one its row has moved past, and no other", async () => {
    const { fleet, hub, store, t3, events } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const row = (id: string, updatedAt: string) => ({ id, status: "idle", updatedAt, itemCount: 2 });
    t3.state.shell = { threads: [row("new", "2026-01-02"), row("same", "2026-01-02"), row("moved", "2026-01-03")] };
    for (const id of ["same", "moved"]) store.setThreadVm(id, vm.id);
    const old = { thread: { id: "same" }, updatedAt: "2026-01-02", visibleTurnItems: [] };
    store.saveProjection("same", vm.id, old.updatedAt, threadStamp(row("same", "2026-01-02")), old);
    store.saveProjection("moved", vm.id, old.updatedAt, threadStamp(row("moved", "2026-01-02")), { ...old, thread: { id: "moved" } });
    // Longer than the newest turns `orchestration.getThreadProjection` would give.
    const rows = Array.from({ length: 300 }, (_, position) => ({ position, sourceItemId: `i${position}` }));
    const reads: string[] = [];
    t3.state.thread = async (threadId) => {
      reads.push(threadId);
      return Response.json({ snapshotSequence: 9, projection: { thread: { id: threadId }, updatedAt: "2026-01-03", visibleTurnItems: rows } });
    };

    await hub.sweep(later());
    expect(reads.sort()).toEqual(["moved", "new"]);
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.projection<Projection>("new", vm.id)?.visibleTurnItems).toHaveLength(300);
    expect(store.projection<Projection>("moved", vm.id)?.visibleTurnItems).toHaveLength(300);
    expect(store.projection<Projection>("same", vm.id)).toEqual(old);
  });

  test("a save that fails or never answers keeps the thread's last copy and does not keep the VM awake", async () => {
    const { fleet, hub, store, t3, events } = idleFleet();
    hub.sleepSaveMs = 100;
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    t3.state.shell = { threads: [{ id: "failing", status: "idle" }, { id: "stuck", status: "idle" }] };
    store.setThreadVm("failing", vm.id);
    const old = { thread: { id: "failing" }, updatedAt: "2026-01-01", visibleTurnItems: [{ position: 0 }] };
    store.saveProjection("failing", vm.id, old.updatedAt, null, old);
    t3.state.thread = (threadId) => (threadId === "failing" ? Promise.resolve(new Response(null, { status: 500 })) : new Promise(() => {}));

    const started = Date.now();
    await hub.sweep(later());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.projection<Projection>("failing", vm.id)).toEqual(old);
    expect(store.projection("stuck", vm.id)).toBeNull();
  });

  test("keeps each project's local branches, so they are still known while the VM sleeps", async () => {
    const { fleet, hub, store, t3, events } = idleFleet();
    const vm = await fleet.create();
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", vm.id);
    store.setCheckout("p1", vm.id, "/workspace/app");
    await fleet.ensure(vm.id);
    t3.state.answer = (tag) => (tag === "vcs.listRefs" ? { refs: [{ name: "main" }, { name: "hand-made" }, { name: "origin/main", isRemote: true }] } : null);

    await hub.sweep(later());
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(await hub.localBranches("p1", vm.id)).toEqual(new Set(["main", "hand-made"]));
  });

  test("lists each worktree's files as it goes to sleep, and a VM that does not answer cannot hold the sleep up", async () => {
    const context = setup();
    const { fleet, store, box, t3, events } = context;
    const trees = new FileTrees(store.db, () => undefined, { branches: async () => ({ names: [], defaultBranch: "main", at: 0 }) }, 50);
    const hub = new Hub(store, context.settings, fleet, context.traffic, unmeasured, undefined, trees);
    fleet.onConnect = async () => {};
    const vm = await fleet.create();
    store.insertProject({ id: "p1", url: "https://git.example.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", vm.id);
    store.setCheckout("p1", vm.id, "/workspace/app");
    t3.state.shell = { threads: [{ id: "t1", status: "idle", projectId: "p1", worktreePath: "/workspace/wt/one" }], archivedThreads: [], projects: [] };
    const run = box.run.bind(box);
    let listing: "answer" | "hang" = "answer";
    box.run = (async (command: string, options?: { stdin?: string }) => {
      const path = /^git -C '(.+)' ls-files/.exec(command)?.[1];
      if (!path) return run(command, options);
      if (listing === "hang") return new Promise(() => {});
      return ok(`${path === "/workspace/app" ? "untracked.md" : "unpushed.ts"}\0`);
    }) as typeof box.run;
    const search = (path: string) => trees.search(store.project("p1")!, null, "", { query: "", limit: 10 }, { vmId: vm.id, path });

    await fleet.ensure(vm.id);
    await hub.sweep(later());
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect((await search("/workspace/app"))?.entries).toEqual([{ path: "untracked.md", kind: "file" }]);
    expect((await search("/workspace/wt/one"))?.entries).toEqual([{ path: "unpushed.ts", kind: "file" }]);

    listing = "hang";
    await fleet.ensure(vm.id);
    await hub.sweep(later());
    expect(events).toEqual(["create", "wake", "sleep", "wake", "sleep"]);
    expect((await search("/workspace/app"))?.entries).toEqual([{ path: "untracked.md", kind: "file" }]);
  });

  test("a request arriving once the VM is going to sleep waits for it, then wakes the VM", async () => {
    const { fleet, hub, driver, events } = idleFleet();
    const vm = await fleet.create();
    const before = await fleet.ensure(vm.id);
    const asleep = gate();
    driver.sleep = async () => (events.push("sleep"), await asleep.promise, {});

    const sweeping = hub.sweep(later());
    await until(() => events.includes("sleep"));
    // The closing socket is no longer handed out.
    expect(fleet.backend(vm.id)).toBeUndefined();
    const waking = fleet.ensure(vm.id);
    asleep.release();
    await sweeping;
    const after = await waking;
    expect(after).not.toBe(before);
    expect(after.open).toBe(true);
    expect(events).toEqual(["create", "wake", "sleep", "wake"]);
  });

  test("streams the sleep ends see a sleeping VM, so T3 subscriptions stay open", async () => {
    const { fleet, store } = setup();
    const vm = await fleet.create();
    const backend = await fleet.ensure(vm.id);
    const seen: (string | undefined)[] = [];
    backend.request("orchestration.subscribeThread", { threadId: "t1" }, (frame) => {
      if (frame._tag === "Exit") seen.push(store.vm(vm.id)?.state);
    });
    await fleet.sleep(vm.id);
    expect(seen).toEqual(["sleeping"]);
  });
});

describe("sign-in changes", () => {
  const working: Shell = { threads: [{ id: "t1", status: "running" }] };
  const idle: Shell = { threads: [{ id: "t1", status: "idle" }] };

  test("an idle VM restarts T3 with the new sign-ins, and its streams see it starting rather than dropping", async () => {
    const { fleet, hub, store, server, signIns } = idleFleet();
    const vm = await fleet.create();
    const before = await fleet.ensure(vm.id);
    const ended: (string | undefined)[] = [];
    before.request("orchestration.subscribeThread", { threadId: "t1" }, (frame) => {
      if (frame._tag === "Exit") ended.push(store.vm(vm.id)?.state);
    });
    const awake: string[] = [];
    fleet.on("awake", (id) => awake.push(id));

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
    expect(ended).toEqual(["starting"]);
    expect(awake).toEqual([vm.id]);
    expect(fleet.backend(vm.id)?.open).toBe(true);
    expect(fleet.backend(vm.id)).not.toBe(before);
    expect(store.vm(vm.id)?.state).toBe("ready");

    // Nothing changed since, so nothing restarts.
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(1);
  });

  test("only a Kubi VM gets the agents' screen tools, and Kubi's key for agents until it is removed", async () => {
    const other = idleFleet();
    await other.fleet.ensure((await other.fleet.create()).id);
    expect(Object.keys(other.files).filter((path) => /opencode\.json|desktop-mcp|codex-system/.test(path))).toEqual([]);
    expect(other.files[envPath]).not.toMatch(/KUBI_API_KEY=|OPENCODE_CONFIG=/);

    const { fleet, hub, settings, secrets, server, files } = idleFleet();
    settings.set("providers", ["kubi"]);
    settings.set("defaultProvider", "kubi");
    secrets.set("provider.kubi.agentKey", "kubi_agents");
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    expect(files[envPath]).toContain("export KUBI_API_KEY='kubi_agents'");
    expect(files[envPath]).toContain("export OPENCODE_CONFIG='/workspace/.vmbridge/opencode.json'");
    expect(Object.keys(JSON.parse(files["/workspace/.vmbridge/opencode.json"]!).mcp)).toEqual(["browser", "desktop", "kubi"]);

    secrets.set("provider.kubi.agentKey", null);
    await hub.credentialsChanged();
    expect(server.restarts).toBe(1);
    expect(server.env).not.toContain("KUBI_API_KEY=");
    expect(Object.keys(JSON.parse(files["/workspace/.vmbridge/opencode.json"]!).mcp)).toEqual(["browser", "desktop"]);
  });

  test("a busy VM gets the files now and restarts T3 only once its work ends", async () => {
    const { fleet, hub, t3, files, server, signIns } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    t3.state.shell = working;

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(files[envPath]).toContain("export OPENCODE_API_KEY='oc-new'");
    await hub.sweep();
    expect(server.restarts).toBe(0);
    expect(server.env).not.toContain("OPENCODE_API_KEY=");

    t3.state.shell = idle;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
  });

  test("a VM with an agent running in OpenCode restarts only once it stops, and then stops OpenCode too", async () => {
    const { fleet, hub, store, files, server, signIns, opencode } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    // As once OpenCode has started there.
    store.updateVm(vm.id, { opencodePassword: "vm-password" });
    opencode.busy = true;

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(files[envPath]).toContain("export OPENCODE_API_KEY='oc-new'");
    await hub.sweep();
    expect(server.restarts).toBe(0);
    expect(opencode.stops).toBe(0);

    opencode.busy = false;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    // The next OpenCode request starts it again, with the new key.
    expect(opencode.stops).toBe(1);
  });

  test("an OpenCode that does not answer may be running an agent, so the VM waits to restart", async () => {
    const { fleet, hub, store, server, signIns, opencode } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    store.updateVm(vm.id, { opencodePassword: "vm-password" });
    opencode.answer = "unknown";
    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(0);

    // Nothing listening is as good as idle.
    opencode.answer = "down";
    await hub.sweep();
    expect(server.restarts).toBe(1);
  });

  test("an OpenCode older than its clients runs no agents they started, so it counts as idle", async () => {
    const { fleet, hub, store, server, signIns, opencode } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    store.updateVm(vm.id, { opencodePassword: "vm-password" });
    opencode.answer = "old";
    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(1);
  });

  test("a stop that fails while OpenCode still answers holds back the restart, which the next sweep tries again", async () => {
    const { fleet, hub, store, server, signIns, opencode } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    store.updateVm(vm.id, { opencodePassword: "vm-password" });
    opencode.failStop = true;
    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(0);

    opencode.failStop = false;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    expect(opencode.stops).toBe(1);
  });

  test("a VM held by a request restarts only once the request is done", async () => {
    const { fleet, hub, server, signIns } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const release = fleet.lease(vm.id);

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(0);

    release();
    await hub.sweep();
    expect(server.restarts).toBe(1);
  });

  test("a restart that reports failure after relaunching T3 still counts what T3 started with", async () => {
    const { fleet, hub, server, signIns } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);

    server.failRestart = true;
    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");

    // Going back to the old sign-ins must restart T3 again, as it now runs with the new ones.
    server.failRestart = false;
    delete signIns.opencodeApiKey;
    await hub.credentialsChanged();
    expect(server.restarts).toBe(2);
    expect(server.env).not.toContain("OPENCODE_API_KEY=");
  });

  test.each(["pause", "stop"])("a VM that sleeps by %s gets the new sign-ins when it wakes", async (style) => {
    const { fleet, hub, driver, events, server, signIns } = idleFleet();
    if (style === "stop") {
      driver.sleep = async () => {
        events.push("sleep");
        server.running = false;
        return {};
      };
    }
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(server.env).not.toContain("OPENCODE_API_KEY=");
    await fleet.ensure(vm.id);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
    expect([server.starts, server.restarts]).toEqual(style === "pause" ? [1, 1] : [2, 0]);
  });

  test("switching Codex accounts restarts T3, a Codex token refresh does not", async () => {
    const { fleet, hub, files, server, signIns } = idleFleet();
    Object.assign(signIns, { codexAuthJson: '{"account":"a","refresh":1}', codexSignIn: "codex-a@1" });
    const vm = await fleet.create();
    await fleet.ensure(vm.id);

    signIns.codexAuthJson = '{"account":"a","refresh":2}';
    await hub.credentialsChanged();
    expect(files["/workspace/.vmbridge/codex/auth.json"]).toBe(signIns.codexAuthJson);
    expect(server.restarts).toBe(0);

    Object.assign(signIns, { codexAuthJson: '{"account":"b","refresh":1}', codexSignIn: "codex-b@2" });
    await hub.credentialsChanged();
    expect(server.restarts).toBe(1);
  });

  test("adopting a VM's Codex tokens gives every VM the file, since that VM's refresh retired theirs", async () => {
    const { fleet, files, signIns, agents, calls } = setup();
    signIns.codexAuthJson = "bridge-tokens";
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const codexPath = "/workspace/.vmbridge/codex/auth.json";
    files[codexPath] = "refreshed-on-vm";
    // As AgentAuth does: the adopted tokens are fresh, so nothing is due afterwards.
    Object.assign(agents, {
      codexDue: () => true,
      adoptCodex: async (text: string) => {
        signIns.codexAuthJson = `${text} as VM Bridge saved it`;
        return true;
      },
      refreshCodex: async (onlyChanged: boolean) => (onlyChanged ? undefined : signIns.codexAuthJson),
    });
    calls.length = 0;
    await fleet.syncCodexAuth();
    expect(calls).toContain(`write ${codexPath}`);
    expect(files[codexPath]).toBe("refreshed-on-vm as VM Bridge saved it");
  });

  test("after VM Bridge restarts, an idle VM with older sign-ins restarts T3 before it is used", async () => {
    const { fleet, newFleet, server, signIns } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    fleet.close();

    signIns.opencodeApiKey = "oc-new";
    const restarted = newFleet();
    await restarted.ensure(vm.id);
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
  });

  test("a VM whose T3 started with an unkeyed fingerprint from an older version restarts T3 with a keyed one", async () => {
    const { fleet, newFleet, store, files, server, db } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const keyed = store.vm(vm.id)!.t3Credentials;
    fleet.close();
    const unkeyed = createHash("sha256").update("{}").digest("hex");
    files["/workspace/.vmbridge/t3/credentials"] = unkeyed;
    db.run("UPDATE vms SET t3_credentials = 'unkeyed'");

    await newFleet().ensure(vm.id);
    expect(server.restarts).toBe(1);
    expect(store.vm(vm.id)?.t3Credentials).toBe(keyed);
    expect(keyed).not.toBe(unkeyed);
  });

  test("after VM Bridge restarts, a busy VM with older sign-ins restarts T3 once its work ends", async () => {
    const { fleet, newFleet, store, settings, traffic, t3, server, signIns } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    fleet.close();
    t3.state.shell = working;

    signIns.opencodeApiKey = "oc-new";
    const restarted = newFleet();
    const hub = new Hub(store, settings, restarted, traffic, unmeasured);
    restarted.onConnect = async () => {};
    await restarted.ensure(vm.id);
    await hub.sweep();
    expect(server.restarts).toBe(0);

    t3.state.shell = idle;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
  });

  test("a removed GitHub token leaves the VM at once, even mid-turn", async () => {
    const { fleet, hub, t3, files, secrets, settings, server } = idleFleet();
    secrets.set("github.token", "github_pat_old");
    settings.set("github", { login: "octo", name: null, avatarUrl: "", profileUrl: "", email: "1+octo@users.noreply.github.com", scopes: null, expiresAt: null, checkedAt: 0 });
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    expect(files["/workspace/.vmbridge/git-credentials"]).toContain("github_pat_old");
    t3.state.shell = working;

    secrets.set("github.token", null);
    settings.set("github", null);
    await hub.credentialsChanged();
    expect(files["/workspace/.vmbridge/git-credentials"]).toBeUndefined();
    expect(files[envPath]).not.toContain("GH_TOKEN=");
    expect(server.restarts).toBe(0);
  });

  test("sign-ins removed while a VM sleeps are scrubbed by the first command it runs on waking", async () => {
    const { fleet, hub, files, secrets, settings, server, signIns, calls } = idleFleet();
    secrets.set("github.token", "github_pat_old");
    settings.set("github", { login: "octo", name: null, avatarUrl: "", profileUrl: "", email: "1+octo@users.noreply.github.com", scopes: null, expiresAt: null, checkedAt: 0 });
    signIns.opencodeApiKey = "oc-old";
    saveEnvVars(secrets, { NPM_TOKEN: "npm-old" });
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);

    secrets.set("github.token", null);
    settings.set("github", null);
    delete signIns.opencodeApiKey;
    saveEnvVars(secrets, {});
    await hub.credentialsChanged();
    // Asleep: nothing could be written yet.
    expect(files["/workspace/.vmbridge/git-credentials"]).toContain("github_pat_old");

    calls.length = 0;
    await fleet.ensure(vm.id);
    expect(calls[0]).toBe("bash -s");
    expect(files["/workspace/.vmbridge/git-credentials"]).toBeUndefined();
    for (const old of ["github_pat_old", "oc-old", "npm-old"]) {
      expect(files[envPath]).not.toContain(old);
      expect(server.env).not.toContain(old);
    }
  });
});

describe("environment variables", () => {
  const working: Shell = { threads: [{ id: "t1", status: "running" }] };
  const idle: Shell = { threads: [{ id: "t1", status: "idle" }] };

  test("a busy VM gets them once its work ends, an idle one at once, and removing one restarts T3 again", async () => {
    const { fleet, hub, t3, store, secrets, files, server } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    t3.state.shell = working;

    saveEnvVars(secrets, { API_URL: "https://example.test" });
    await hub.credentialsChanged();
    await hub.sweep();
    expect(files[envPath]).toContain("export API_URL='https://example.test'");
    expect(server.restarts).toBe(0);
    expect(fleet.behind(store.vm(vm.id)!)).toBe(true);

    t3.state.shell = idle;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export API_URL='https://example.test'");
    expect(fleet.behind(store.vm(vm.id)!)).toBe(false);

    // Saving the same value again changes nothing.
    saveEnvVars(secrets, { API_URL: "https://example.test" });
    await hub.credentialsChanged();
    expect(server.restarts).toBe(1);

    saveEnvVars(secrets, {});
    await hub.credentialsChanged();
    expect(server.restarts).toBe(2);
    expect(server.env).not.toContain("API_URL");
    expect(fleet.behind(store.vm(vm.id)!)).toBe(false);
  });

  test.each(["pause", "stop"])("a VM asleep (%s) through a change starts T3 with it on wake", async (style) => {
    const { fleet, hub, driver, events, secrets, server } = idleFleet();
    if (style === "stop") {
      driver.sleep = async () => {
        events.push("sleep");
        server.running = false;
        return {};
      };
    }
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);

    saveEnvVars(secrets, { API_URL: "https://example.test" });
    await hub.credentialsChanged();
    expect(server.env).not.toContain("API_URL");
    await fleet.ensure(vm.id);
    expect(server.env).toContain("export API_URL='https://example.test'");
    expect([server.starts, server.restarts]).toEqual(style === "pause" ? [1, 1] : [2, 0]);
  });

  test("a new VM starts T3 with them", async () => {
    const { fleet, secrets, server } = setup();
    saveEnvVars(secrets, { API_URL: "https://example.test" });
    await fleet.ensure((await fleet.create()).id);
    expect(server.env).toContain("export API_URL='https://example.test'");
    expect([server.starts, server.restarts]).toEqual([1, 0]);
  });
});

describe("skills", () => {
  /** This machine's skill folder, the only place local skills install from. */
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vmbridge-skill-"));
    temps.push(root);
  });

  /** A local skill folder holding just a SKILL.md, as written on this machine. */
  function folder(name: string, body: string) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`);
    return dir;
  }

  test("reach an awake VM at once, even mid-turn, without restarting T3", async () => {
    const { fleet, store, skills, t3, synced, server } = setup([root]);
    const vm = await fleet.create();
    const backend = await fleet.ensure(vm.id);
    t3.state.shell = { threads: [{ id: "t1", status: "running" }] };

    skills.installLocal(folder("review", "Reviews code."));
    await fleet.shareSkills();
    expect(synced.map((sync) => sync.skills.map((skill) => skill.name))).toEqual([["review"]]);
    expect(store.vm(vm.id)?.skills).toBe(skills.state().fingerprint);
    expect([server.starts, server.restarts]).toEqual([1, 0]);
    expect(fleet.backend(vm.id)).toBe(backend);

    // Already there: nothing is sent again.
    await fleet.shareSkills();
    expect(synced).toHaveLength(1);
  });

  test("only a skill whose files changed is sent again", async () => {
    const { fleet, skills, synced } = setup([root]);
    const review = folder("review", "Reviews code.");
    skills.installLocal(review);
    skills.installLocal(folder("deploy", "Deploys."));
    const vm = await fleet.create();
    await fleet.ensure(vm.id);

    writeFileSync(join(review, "SKILL.md"), "---\nname: review\ndescription: Reviews code, carefully.\n---\n");
    expect(skills.refreshLocal()).toBe(true);
    await fleet.shareSkills();
    const last = synced.at(-1)!.skills;
    expect(last.map((skill) => [skill.name, Boolean(skill.files)])).toEqual([["deploy", false], ["review", true]]);
  });

  test.each(["pause", "stop"])("a VM asleep (%s) through changes has them before anything uses it on wake", async (style) => {
    const { fleet, store, skills, driver, events, server, synced, order } = setup([root]);
    if (style === "stop") {
      driver.sleep = async () => {
        events.push("sleep");
        server.running = false;
        return {};
      };
    }
    const kept = folder("review", "Reviews code.");
    skills.installLocal(kept);
    skills.installLocal(folder("deploy", "Deploys."));
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);
    order.length = 0;

    skills.remove("deploy");
    writeFileSync(join(kept, "SKILL.md"), "---\nname: review\ndescription: Reviews code, carefully.\n---\n");
    skills.refreshLocal();
    await fleet.shareSkills();
    expect(order).toEqual([]);
    expect(store.vm(vm.id)?.skills).not.toBe(skills.state().fingerprint);

    fleet.onConnect = async () => void order.push("connect");
    await fleet.ensure(vm.id);
    expect(order).toEqual(style === "pause" ? ["skills", "connect"] : ["skills", "start", "connect"]);
    expect(synced.at(-1)!.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(store.vm(vm.id)?.skills).toBe(skills.state().fingerprint);
  });

  test("with sync all, every local skill reaches an awake VM, new ones follow and deleted ones go", async () => {
    const base = mkdtempSync(join(tmpdir(), "vmbridge-roots-"));
    temps.push(base);
    const [claudeRoot, agentsRoot] = [join(base, "claude"), join(base, "agents")];
    const add = (root: string, name: string, body: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n`);
    };
    add(claudeRoot, "alpha", "Claude's alpha.");
    add(agentsRoot, "alpha", "Another alpha.");
    add(agentsRoot, "beta", "Beta.");
    const { fleet, skills, synced } = setup([claudeRoot, agentsRoot]);
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const names = () => synced.at(-1)!.skills.map((skill) => skill.name);

    skills.setSyncAll(true);
    await fleet.shareSkills();
    expect(names()).toEqual(["alpha", "beta"]);
    // The first folder with a name wins.
    expect(skills.list().find((skill) => skill.name === "alpha")?.description).toBe("Claude's alpha.");

    add(agentsRoot, "gamma", "Gamma.");
    expect(skills.refreshLocal()).toBe(true);
    await fleet.shareSkills();
    expect(names()).toEqual(["alpha", "beta", "gamma"]);

    rmSync(join(agentsRoot, "beta"), { recursive: true });
    expect(skills.refreshLocal()).toBe(true);
    await fleet.shareSkills();
    expect(names()).toEqual(["alpha", "gamma"]);

    // Off: what it installed stays, and a deleted folder keeps its last copy.
    skills.setSyncAll(false);
    rmSync(join(agentsRoot, "gamma"), { recursive: true });
    add(agentsRoot, "delta", "Delta.");
    expect(skills.refreshLocal()).toBe(false);
    expect(skills.list().map((skill) => skill.name)).toEqual(["alpha", "gamma"]);
  });

  test("a new VM has every skill before T3 first starts", async () => {
    const { fleet, skills, order } = setup([root]);
    skills.installLocal(folder("review", "Reviews code."));
    await fleet.ensure((await fleet.create()).id);
    expect(order).toEqual(["skills", "start"]);
  });
});

describe("instructions", () => {
  const agentDirs = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
  const saved = agentDirs.map((name) => process.env[name]);
  afterEach(() => agentDirs.forEach((name, at) => (saved[at] === undefined ? delete process.env[name] : (process.env[name] = saved[at]))));

  test("reach a new VM before T3 starts, then each edit and their removal while it is awake", async () => {
    // This machine's agent folders, with only Codex's file.
    const base = mkdtempSync(join(tmpdir(), "vmbridge-home-"));
    temps.push(base);
    for (const name of agentDirs) process.env[name] = join(base, name);
    mkdirSync(process.env.CODEX_HOME!);
    const agentsMd = join(process.env.CODEX_HOME!, "AGENTS.md");
    writeFileSync(agentsMd, "v1");

    const { fleet, store, skills, synced, order } = setup();
    skills.instructions.refresh();
    expect(skills.instructions.list()).toEqual([{ agent: "codex", path: agentsMd, sync: false }]);
    skills.instructions.setSync("codex", true);
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    expect(order).toEqual(["skills", "start"]);
    expect(synced.at(-1)!.instructions.map((file) => [file.agent, file.text])).toEqual([["codex", "v1"]]);

    writeFileSync(agentsMd, "v2");
    expect(skills.instructions.refresh()).toBe(true);
    await fleet.shareSkills();
    expect(synced.at(-1)!.instructions.map((file) => file.text)).toEqual(["v2"]);

    skills.instructions.setSync("codex", false);
    await fleet.shareSkills();
    expect(synced.at(-1)!.instructions).toEqual([]);
    expect(store.vm(vm.id)?.skills).toBe(skills.state().fingerprint);
    expect(synced).toHaveLength(3);
  });
});

describe("a dropped T3 connection", () => {
  /** Drops the VM's T3 socket from the VM's side, as when T3 restarts there or the network fails. */
  const drop = (t3: ReturnType<typeof fakeT3>) => {
    for (const socket of t3.sockets) socket.close();
  };

  test("reconnects, and an open thread stream picks up on the new connection without ending", async () => {
    const { fleet, store, t3, traffic } = setup();
    fleet.reconnectPausesMs = [1, 1, 1];
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    fleet.onConnect = async () => {};
    const requested: string[] = [];
    t3.state.answer = (tag) => (requested.push(tag), tag.toLowerCase().includes("subscribe") ? open : null);
    const vm = await fleet.create();
    const before = await fleet.ensure(vm.id);
    store.setThreadVm("t1", vm.id);
    const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
    const sent: Wire[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => void sent.push(frame as Wire), open: () => true };
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "orchestration.subscribeThread", payload: { threadId: "t1" } });
    await until(() => requested.includes("orchestration.subscribeThread"));

    drop(t3);
    await until(() => requested.filter((tag) => tag === "orchestration.subscribeThread").length === 2);
    expect(fleet.backend(vm.id)?.open).toBe(true);
    expect(fleet.backend(vm.id)).not.toBe(before);
    expect(store.vm(vm.id)?.state).toBe("ready");
    expect(sent.filter((frame) => frame._tag === "Exit")).toEqual([]);
    hub.close();
  });

  test("goes to sleep when it cannot reconnect, so the VM does not run unseen", async () => {
    const { fleet, store, t3, driver, events } = setup();
    fleet.reconnectPausesMs = [1, 1, 1];
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.wake = async () => {
      events.push("wake");
      throw new Error("The provider did not answer.");
    };

    drop(t3);
    await until(() => store.vm(vm.id)?.state === "sleeping");
    expect(events).toEqual(["create", "wake", "wake", "wake", "wake", "sleep"]);
    expect(fleet.backend(vm.id)).toBeUndefined();
  });

  test("a VM that failed while it may still run is put to sleep by the idle sweep, and reconnected after a restart", async () => {
    const { fleet, newFleet, store, settings, traffic, events } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    fleet.close();
    store.updateVm(vm.id, { state: "error", error: "The T3 connection dropped." });

    const restarted = newFleet();
    restarted.onConnect = async () => {};
    await restarted.resume();
    await until(() => store.vm(vm.id)?.state === "ready");
    expect(events).toEqual(["create", "wake", "wake"]);

    restarted.close();
    store.updateVm(vm.id, { state: "error" });
    const hub = new Hub(store, settings, newFleet(), traffic, unmeasured);
    await hub.sweep();
    expect(events).toEqual(["create", "wake", "wake"]);
    await hub.sweep(Date.now() + 24 * 60 * 60_000);
    expect(events).toEqual(["create", "wake", "wake", "sleep"]);
    expect(store.vm(vm.id)?.state).toBe("sleeping");
  });
});

describe("stopping VM Bridge", () => {
  test("puts awake VMs with nothing running to sleep, however recently used, and leaves working ones awake", async () => {
    const { fleet, hub, t3, events } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    t3.state.shell = { threads: [{ id: "t1", status: "running" }] };
    await hub.sleepIdle(1_000);
    expect(events).toEqual(["create", "wake"]);

    t3.state.shell = { threads: [{ id: "t1", status: "idle" }] };
    await hub.sleepIdle(1_000);
    expect(events).toEqual(["create", "wake", "sleep"]);
  });

  test("gives up on a provider that does not answer, so stopping cannot hang", async () => {
    const { fleet, hub, driver } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = () => new Promise(() => {});
    const started = Date.now();
    await hub.sleepIdle(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the npm registry being unreachable", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("still wakes a VM on the T3 version it last ran", async () => {
    const { fleet, store, settings } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);

    settings.set("t3Version", null);
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("registry.npmjs.org")) {
        asked.push(url);
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    await fleet.ensure(vm.id);
    expect(asked).toHaveLength(1);
    expect(store.vm(vm.id)).toMatchObject({ state: "ready", t3Version: "1.0.0" });
  });
});

describe("automations", () => {
  const minute = 60_000;

  /** An idle, connected VM with one enabled automation next running at `nextRunAt`. */
  async function scheduled(nextRunAt: number) {
    const context = setup();
    context.fleet.onConnect = async () => {};
    const vm = await context.fleet.create();
    await context.fleet.ensure(vm.id);
    context.store.saveSnapshot(vm.id, "scheduled_tasks", { tasks: [{ id: "a1", enabled: true, nextRunAt: new Date(nextRunAt).toISOString() }] });
    const hub = new Hub(context.store, context.settings, context.fleet, context.traffic, unmeasured);
    context.fleet.onConnect = async () => {};
    return { ...context, hub, vm };
  }

  test("do not keep their VM awake, which wakes a couple of minutes before the next run", async () => {
    const runAt = Date.now() + 3 * 60 * minute;
    const { fleet, hub, store, events, vm } = await scheduled(runAt);
    await hub.sweep(Date.now() + 60 * minute);
    expect(events).toEqual(["create", "wake", "sleep"]);

    // A manual Sleep stays asleep until the run is near.
    await hub.sweep(runAt - 10 * minute);
    expect(events).toEqual(["create", "wake", "sleep"]);
    await hub.sweep(runAt - minute);
    await until(() => Boolean(fleet.backend(vm.id)));
    expect(events).toEqual(["create", "wake", "sleep", "wake"]);

    // Awake for the run, however long the VM has been idle.
    store.updateVm(vm.id, { lastActivityAt: 0 });
    await hub.sweep(runAt);
    expect(fleet.backend(vm.id)).toBeDefined();
  });

  test("a run that came due while the VM slept wakes it once, not on every sweep", async () => {
    const runAt = Date.now() - 30 * minute;
    const { fleet, hub, store, events, vm } = await scheduled(runAt);
    // As when VM Bridge was stopped through the run: the VM slept before it was due.
    await fleet.sleep(vm.id);
    store.updateVm(vm.id, { lastSleptAt: runAt - minute });
    await hub.sweep();
    await until(() => Boolean(fleet.backend(vm.id)));

    // T3 reported nothing newer before the VM slept again: it is not woken for that run again.
    await hub.sweep(Date.now() + 60 * minute);
    expect(store.vm(vm.id)?.state).toBe("sleeping");
    await hub.sweep(Date.now() + 61 * minute);
    expect(events).toEqual(["create", "wake", "sleep", "wake", "sleep"]);
  });
});
