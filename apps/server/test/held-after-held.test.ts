import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Shell, Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { T3Rejected, type Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };

const makeThread = (id: string) => ({
  id,
  title: `Thread ${id}`,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  archivedAt: null,
  pinnedAt: null,
  lastVisitedAt: "2026-11-21T00:00:00.000Z",
  latestRunCompletedAt: "2026-11-22T00:00:00.000Z",
  activeRunId: null,
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  updatedAt: "2026-11-21T00:00:00.000Z",
});

type ExitFrame = {
  exit?: {
    _tag: string;
    value?: unknown;
    cause?: { _tag: string; error?: Wire }[];
  };
};

function setup(threadIds = ["t1"]) {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  const threads = threadIds.map(makeThread);
  store.saveSnapshot("vm1", "shell", { threads, archivedThreads: [], projects: [] } satisfies Shell);
  for (const id of threadIds) store.setThreadVm(id, "vm1");

  const backends = new Map<string, Backend>();
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends.get(id),
    touch: () => {},
    lease: () => () => {},
    ensure: async (id: string) => backends.get(id),
  }) as unknown as Fleet;
  const traffic = { record: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const sent: ExitFrame[] = [];
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as ExitFrame), open: () => true };
  const dispatch = (payload: object) =>
    rpc.handle(client, { _tag: "Request", id: sent.length, tag: "orchestration.dispatchCommand", payload: { commandId: crypto.randomUUID(), ...payload } });
  return { store, fleet, hub, backends, sent, dispatch, threads };
}

async function connect({ fleet, backends, threads }: ReturnType<typeof setup>) {
  const dispatched: { payload: Wire; answer: (sequence: number) => void; reject: (error: Error) => void }[] = [];
  const forwarded: Wire[] = [];
  let shellStream: (frame: unknown) => void = () => {};
  const backend = {
    call: (tag: string, payload: Wire) => {
      if (tag === "server.getConfig") return Promise.resolve({ environment: { orchestrationProtocolVersion: 2 } });
      if (tag !== "orchestration.dispatchCommand") return Promise.resolve(null);
      return new Promise((resolve, reject) => dispatched.push({ payload, answer: (sequence) => resolve({ sequence }), reject }));
    },
    request: (tag: string, payload: Wire, handler: (frame: unknown) => void) => {
      if (tag === "orchestration.subscribeShell") shellStream = handler;
      if (tag === "orchestration.dispatchCommand") {
        forwarded.push(payload);
        handler({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { sequence: 20 } } });
      }
      return () => {};
    },
  } as unknown as Backend;
  backends.set("vm1", backend);
  await fleet.onConnect("vm1", backend);
  shellStream({ _tag: "Chunk", values: [{ kind: "snapshot", snapshot: { snapshotSequence: 10, projects: [], threads, archivedThreads: [] } }] });
  fleet.emit("awake", "vm1");
  return { dispatched, forwarded };
}

const lastError = (sent: ExitFrame[]) => sent.at(-1)?.exit?.cause?.[0]?.error;

describe("Hub.afterHeld unanswered-replay guards", () => {
  test("unanswered held model-selection blocks t1 message.dispatch with OrchestrationV2DispatchCommandError and succeeds once answered", async () => {
    const context = setup();
    await context.dispatch({ type: "thread.model-selection.set", threadId: "t1", modelSelection: { instanceId: "codex", model: "gpt-5.5" } });
    const { dispatched, forwarded } = await connect(context);
    expect(dispatched.map((entry) => entry.payload.type)).toEqual(["thread.model-selection.set"]);

    const first = context.dispatch({ type: "message.dispatch", threadId: "t1", text: "First" });
    await Bun.sleep(0);
    expect(forwarded).toEqual([]);
    dispatched[0]!.reject(new Error("Request timed out"));
    await first;

    expect(context.sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(lastError(context.sent)).toMatchObject({
      _tag: "OrchestrationV2DispatchCommandError",
      commandType: "message.dispatch",
      message: expect.stringMatching(/earlier changes/),
    });
    expect(forwarded).toEqual([]);
    expect(context.store.heldCommands("vm1")).toHaveLength(1);

    const second = context.dispatch({ type: "message.dispatch", threadId: "t1", text: "Second" });
    await Bun.sleep(0);
    expect(dispatched).toHaveLength(2);
    expect(forwarded).toEqual([]);
    dispatched[1]!.answer(11);
    await second;

    expect(context.sent.at(-1)?.exit?._tag).toBe("Success");
    expect(forwarded.map((command) => [command.type, command.text])).toEqual([["message.dispatch", "Second"]]);
  });

  test("blocking on an unanswered replay preserves a pending refusedSettings refusal for t1", async () => {
    const context = setup();
    const { dispatched, forwarded } = await connect(context);

    await context.dispatch({ type: "thread.runtime-mode.set", threadId: "t1", runtimeMode: "full-access" });
    dispatched[0]!.reject(new T3Rejected("orchestration.dispatchCommand", "vm1"));
    await Bun.sleep(0);

    await context.dispatch({ type: "thread.model-selection.set", threadId: "t1", modelSelection: { instanceId: "codex", model: "gpt-5.5" } });
    const blocked = context.dispatch({ type: "message.dispatch", threadId: "t1", text: "Blocked by timeout" });
    await Bun.sleep(0);
    dispatched[1]!.reject(new Error("Request timed out"));
    await blocked;

    expect(lastError(context.sent)).toMatchObject({
      _tag: "OrchestrationV2DispatchCommandError",
      commandType: "message.dispatch",
      message: expect.stringMatching(/earlier changes/),
    });
    expect(forwarded).toEqual([]);

    // Once replay succeeds, the preserved refusal still stops the next message, and only that one.
    const refused = context.dispatch({ type: "message.dispatch", threadId: "t1", text: "Blocked by refusal" });
    await Bun.sleep(0);
    dispatched[2]!.answer(11);
    await refused;

    expect(lastError(context.sent)).toMatchObject({
      _tag: "OrchestrationV2DispatchCommandError",
      commandType: "message.dispatch",
      message: expect.stringMatching(/refused the change to its settings/),
    });
    expect(forwarded).toEqual([]);

    await context.dispatch({ type: "message.dispatch", threadId: "t1", text: "Allowed after refusal" });
    expect(context.sent.at(-1)?.exit?._tag).toBe("Success");
    expect(forwarded.map((command) => command.text)).toEqual(["Allowed after refusal"]);
  });

  test("a held command queued for t1 after message.dispatch entered afterHeld does not fail it once earlier held commands are answered", async () => {
    const context = setup();
    const { dispatched, forwarded } = await connect(context);

    await context.dispatch({ type: "thread.runtime-mode.set", threadId: "t1", runtimeMode: "full-access" });
    const sending = context.dispatch({ type: "message.dispatch", threadId: "t1", text: "Go" });
    await Bun.sleep(0);
    expect(forwarded).toEqual([]);

    // Queue a newer held command on the same thread while message.dispatch is already awaiting replayHeld.
    await context.dispatch({ type: "thread.settle", threadId: "t1" });
    dispatched[0]!.answer(11);
    await Bun.sleep(0);
    expect(dispatched.map((entry) => entry.payload.type)).toEqual(["thread.runtime-mode.set", "thread.settle"]);

    // Even if that later command gets no answer, message.dispatch already had its earlier command confirmed.
    dispatched[1]!.reject(new Error("Request timed out"));
    await sending;

    expect(context.sent.at(-1)?.exit?._tag).toBe("Success");
    expect(forwarded.map((command) => [command.type, command.text])).toEqual([["message.dispatch", "Go"]]);
    // The answered runtime-mode change awaits its shell echo; the later settle remains unanswered for future calls.
    expect(context.store.heldCommands("vm1").map((row) => row.payload.type)).toEqual(["thread.runtime-mode.set", "thread.settle"]);

    const later = context.dispatch({ type: "message.dispatch", threadId: "t1", text: "After settle" });
    await Bun.sleep(0);
    expect(dispatched.map((entry) => entry.payload.type)).toEqual(["thread.runtime-mode.set", "thread.settle", "thread.settle"]);
    dispatched[2]!.reject(new Error("Request timed out"));
    await later;
    expect(context.sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(forwarded.map((command) => command.text)).toEqual(["Go"]);
  });

  test("a stuck held command on t1 does not block mutations on t2 or threadless mutations, but still blocks t2 when t2 also has a held command behind it", async () => {
    const context = setup(["t1", "t2"]);
    const { dispatched, forwarded } = await connect(context);

    await context.dispatch({ type: "thread.model-selection.set", threadId: "t1", modelSelection: { instanceId: "codex", model: "gpt-5.5" } });

    const onT2 = context.dispatch({ type: "message.dispatch", threadId: "t2", text: "Other thread" });
    await Bun.sleep(0);
    dispatched[0]!.reject(new Error("Request timed out"));
    await onT2;

    expect(context.sent.at(-1)?.exit?._tag).toBe("Success");
    expect(forwarded.map((command) => [command.threadId, command.text])).toEqual([["t2", "Other thread"]]);

    const threadless = context.hub.afterHeld("vm1", { cwd: "/projects/p1" });
    await Bun.sleep(0);
    dispatched[1]!.reject(new Error("Request timed out"));
    await expect(threadless).resolves.toBeUndefined();

    // A held command on t2 queued behind t1's stuck command is never reached by sendHeld, so t2's dispatch is blocked.
    await context.dispatch({ type: "thread.runtime-mode.set", threadId: "t2", runtimeMode: "full-access" });
    dispatched[2]!.reject(new Error("Request timed out"));
    await Bun.sleep(0);

    const blockedT2 = context.dispatch({ type: "message.dispatch", threadId: "t2", text: "Blocked on t2" });
    await Bun.sleep(0);
    dispatched[3]!.reject(new Error("Request timed out"));
    await blockedT2;

    expect(context.sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(lastError(context.sent)).toMatchObject({
      _tag: "OrchestrationV2DispatchCommandError",
      commandType: "message.dispatch",
      message: expect.stringMatching(/earlier changes/),
    });
    expect(forwarded.map((command) => command.text)).toEqual(["Other thread"]);
  });
});
