import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { bridgeScopes, Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const shortcut = (key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "modKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: false,
  ...modifiers,
});

/** Two of T3's defaults, as a VM reports them: `mod+b` toggles the sidebar, and `f6` and `shift+f6` move focus. */
const defaults = [
  { command: "sidebar.toggle", shortcut: shortcut("b", { modKey: true }) },
  { command: "workspace.focusNext", shortcut: shortcut("f6") },
  { command: "workspace.focusNext", shortcut: shortcut("f6", { shiftKey: true }), whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } } },
];

/** A VM's T3 server, recording the settings patches it is sent and applying them shallowly. */
function settingsVm(settings: Wire = { sidebarAutoSettleAfterDays: 7, branchNamePrefix: "t3/" }) {
  const updates: Wire[] = [];
  const config = { environment: { orchestrationProtocolVersion: 2, capabilities: {} }, settings, keybindings: defaults, providers: [] };
  const backend = {
    call: async (tag: string, payload: Wire) => {
      if (tag === "server.getConfig") return config;
      if (tag === "server.updateSettings") {
        updates.push(payload.patch as Wire);
        config.settings = { ...config.settings, ...(payload.patch as Wire) };
        return config.settings;
      }
      return null;
    },
    request: () => () => {},
  } as unknown as Backend;
  return { backend, updates };
}

/** A hub over `db` (fresh unless given, to stand for a restart), with vm1 and vm2 awake when their backends are given. */
function setup(backends: Record<string, Backend | undefined>, db = openDatabase(":memory:")) {
  const store = new Store(db, testEncryption);
  const traffic = new Traffic(db);
  for (const vmId of ["vm1", "vm2"]) {
    if (!store.vm(vmId)) store.insertVm({ id: vmId, provider: "kubi", name: vmId, size: "medium", state: "ready", createdAt: 0 });
  }
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends[id],
    connected: () => Object.keys(backends).filter((id) => backends[id]),
    any: async () => {},
  }) as unknown as Fleet;
  const settings = new Settings(store.db);
  settings.set("defaultProvider", "kubi");
  const hub = new Hub(store, settings, fleet, traffic, unmeasured);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const sent: Wire[] = [];
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
  let id = 0;
  /** Sends a request and returns its exit. */
  const call = async (tag: string, payload: Wire = {}) => {
    const requestId = ++id;
    await rpc.handle(client, { _tag: "Request", id: requestId, tag, payload });
    return sent.find((frame) => frame.requestId === requestId && frame._tag === "Exit")?.exit as Wire;
  };
  const value = async (tag: string, payload: Wire = {}) => {
    const exit = await call(tag, payload);
    expect(exit._tag).toBe("Success");
    return exit.value as Wire;
  };
  return { db, hub, call, value };
}

const failure = (exit: Wire) => ((exit.cause as Wire[])[0]!.error as Wire);

test("paired clients may change settings", () => {
  expect(bridgeScopes).toContain("settings:write");
});

describe("keyboard shortcuts", () => {
  test("a saved shortcut replaces the default, is in the config, and survives a restart", async () => {
    const vm1 = settingsVm();
    const { db, hub, value } = setup({ vm1: vm1.backend });
    await hub.fleet.onConnect("vm1", vm1.backend);
    const saved = await value("server.upsertKeybinding", {
      key: "mod+shift+b",
      command: "sidebar.toggle",
      replace: { key: "mod+b", command: "sidebar.toggle" },
    });
    const expected = [...defaults.slice(1), { command: "sidebar.toggle", shortcut: shortcut("b", { modKey: true, shiftKey: true }) }];
    expect(saved).toEqual({ keybindings: expected, issues: [] });
    expect((await value("server.getConfig")).keybindings).toEqual(expected);
    // The VM's own shortcuts file is left alone.
    expect(vm1.updates).toEqual([]);
    hub.close();

    // VM Bridge restarts with the VM asleep: the shortcut is still there.
    const restarted = setup({}, db);
    expect((await restarted.value("server.getConfig")).keybindings).toEqual(expected);
    restarted.hub.close();
  });

  test("changing one of a command's defaults keeps its others, and resetting it restores it", async () => {
    const vm1 = settingsVm();
    const { hub, value } = setup({ vm1: vm1.backend });
    await hub.fleet.onConnect("vm1", vm1.backend);
    // Settings spells the default's condition its own way; it is the same rule.
    await value("server.upsertKeybinding", { key: "f7", command: "workspace.focusNext", replace: { key: "shift+f6", command: "workspace.focusNext", when: "!(terminalFocus)" } });
    const focusNext = async () =>
      ((await value("server.getConfig")).keybindings as Wire[]).filter((binding) => binding.command === "workspace.focusNext").map((binding) => binding.shortcut);
    expect(await focusNext()).toEqual([shortcut("f6"), shortcut("f7")]);

    await value("server.upsertKeybinding", { key: "shift+f6", command: "workspace.focusNext", when: "!terminalFocus", replace: { key: "f7", command: "workspace.focusNext" } });
    expect(await focusNext()).toEqual([shortcut("f6"), shortcut("f6", { shiftKey: true })]);
    hub.close();
  });

  test("a removed shortcut is gone, and an invalid one is refused the way T3 refuses it", async () => {
    const vm1 = settingsVm();
    const { hub, call, value } = setup({ vm1: vm1.backend });
    await hub.fleet.onConnect("vm1", vm1.backend);
    await value("server.upsertKeybinding", { key: "cmd+k", command: "commandPalette.toggle" });
    // The same shortcut, spelled as settings spells it.
    await value("server.removeKeybinding", { key: "meta+k", command: "commandPalette.toggle" });
    expect((await value("server.getConfig")).keybindings).toEqual(defaults);

    const refused = await call("server.upsertKeybinding", { key: "mod+k+j", command: "commandPalette.toggle" });
    expect(refused._tag).toBe("Failure");
    expect(failure(refused)._tag).toBe("KeybindingsConfigParseError");
    expect(hub.settings.get("keybindings")).toEqual([]);
    hub.close();
  });
});

describe("T3 settings", () => {
  test("a change is saved, shown, and set on every awake VM, and on a VM that connects later", async () => {
    const vm1 = settingsVm();
    const vm2 = settingsVm();
    const backends: Record<string, Backend | undefined> = { vm1: vm1.backend };
    const { hub, value } = setup(backends);
    await hub.fleet.onConnect("vm1", vm1.backend);
    const patch = { sidebarAutoSettleAfterDays: null, branchNamePrefix: "me/" };
    const settings = await value("server.updateSettings", { patch });
    expect(settings).toMatchObject(patch);
    await settle();
    expect(vm1.updates).toEqual([patch]);
    expect((await value("server.getConfig")).settings).toMatchObject(patch);

    await hub.fleet.onConnect("vm2", vm2.backend);
    expect(vm2.updates).toEqual([patch]);
    // Already set there: waking again sends nothing.
    backends.vm2 = vm2.backend;
    hub.fleet.emit("awake", "vm2");
    await settle();
    expect(vm2.updates).toHaveLength(1);
    hub.close();
  });

  test("a setting VM Bridge can't save is refused by name, and nothing in the patch is saved", async () => {
    const vm1 = settingsVm();
    const { hub, call } = setup({ vm1: vm1.backend });
    await hub.fleet.onConnect("vm1", vm1.backend);
    const refused = await call("server.updateSettings", { patch: { branchNamePrefix: "me/", worktreesDirectory: "/tmp" } });
    expect(failure(refused)).toMatchObject({ _tag: "ServerSettingsError", operation: "write-managed-setting", managedSetting: "worktreesDirectory" });
    // A value of the wrong kind would leave clients a config they can't read.
    const garbled = await call("server.updateSettings", { patch: { branchNamePrefix: 42 } });
    expect(failure(garbled).managedSetting).toBe("branchNamePrefix");
    expect(hub.settings.get("t3Settings")).toEqual({});
    expect(vm1.updates).toEqual([]);
    hub.close();
  });
});
