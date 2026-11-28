import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Address } from "@vmbridge/contracts";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import type { Box } from "../src/providers/index.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import { WatchLinks } from "../src/watch/links.ts";
import { watchUrlPath } from "../src/watch/skill.ts";
import { Watch } from "../src/watch/watch.ts";
import { testEncryption } from "./key.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function deferred() {
  return Promise.withResolvers<void>();
}

class FakeFleet extends EventEmitter<{ awake: [vmId: string]; offline: [vmId: string]; changed: [] }> {
  readonly boxes = new Map<string, Box>();
  box = (vmId: string) => this.boxes.get(vmId);
  connected = () => [...this.boxes.keys()];
}

function fakeBox(onWrite?: (count: number) => Promise<void>) {
  const files = new Map<string, { data: string; mode: number | undefined }>();
  let writes = 0;
  let active = 0;
  let maxActive = 0;
  const box = {
    files: {
      write: async (entries: Record<string, string>, options?: { mode?: number }) => {
        writes++;
        active++;
        if (active > maxActive) maxActive = active;
        try {
          await onWrite?.(writes);
          for (const [path, data] of Object.entries(entries)) files.set(path, { data, mode: options?.mode });
        } finally {
          active--;
        }
      },
      remove: async (path: string) => {
        if (!files.delete(path)) throw new SandboxError("missing", { code: "file_not_found" });
      },
    },
  } as unknown as Box;
  return {
    files,
    box,
    get writes() {
      return writes;
    },
    get maxActive() {
      return maxActive;
    },
  };
}

function setup() {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const links = new WatchLinks(db, testEncryption);
  const fleet = new FakeFleet();
  const traffic = new Traffic();
  let addresses: Address[] = [{ kind: "local", label: "This Mac", url: "http://127.0.0.1:3790" }];
  const watch = new Watch({
    links,
    store,
    fleet: fleet as unknown as Fleet,
    traffic,
    openSocket,
    addresses: async () => addresses,
    page: async () => new Response("<!doctype html><title>Live screen</title>"),
  });
  store.insertVm({ id: "vm1", provider: "kubi", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
  store.updateVm("vm1", { sandboxId: "scr_vm1" });
  fleet.emit("changed");
  return {
    fleet,
    watch,
    setAddresses: (next: Address[]) => {
      addresses = next;
    },
  };
}

describe("watch link delivery fencing", () => {
  test("in-flight write on an old box resolving after offline -> box2 -> awake still writes box2", async () => {
    const { fleet, watch } = setup();
    await watch.refresh();

    const started = deferred();
    const release = deferred();
    const box1 = fakeBox(async () => {
      started.resolve();
      await release.promise;
    });
    const box2 = fakeBox();

    fleet.boxes.set("vm1", box1.box);
    fleet.emit("awake", "vm1");
    await started.promise;

    fleet.emit("offline", "vm1");
    fleet.boxes.set("vm1", box2.box);
    fleet.emit("awake", "vm1");

    release.resolve();
    await settle();

    expect(box1.writes).toBe(1);
    expect(box2.writes).toBe(1);
    expect(box2.files.get(watchUrlPath)).toEqual({ data: `${watch.url("vm1")}\n`, mode: 0o600 });
  });

  test("same-box-reference reconnect across offline -> awake still rewrites after prior write resolves", async () => {
    const { fleet, watch } = setup();
    await watch.refresh();

    const started = deferred();
    const release = deferred();
    const sameBox = fakeBox(async (n) => {
      if (n === 1) {
        started.resolve();
        await release.promise;
      }
    });

    fleet.boxes.set("vm1", sameBox.box);
    fleet.emit("awake", "vm1");
    await started.promise;

    fleet.emit("offline", "vm1");
    fleet.emit("awake", "vm1");

    release.resolve();
    await settle();

    expect(sameBox.writes).toBe(2);
    expect(sameBox.maxActive).toBe(1);
    expect(sameBox.files.get(watchUrlPath)).toEqual({ data: `${watch.url("vm1")}\n`, mode: 0o600 });
  });

  test("failed write clears delivered cache so a subsequent delivery of the same URL is not suppressed", async () => {
    const { fleet, watch, setAddresses } = setup();
    const vmBox = fakeBox(async (n) => {
      if (n === 2) {
        vmBox.files.delete(watchUrlPath);
        throw new Error("write failed");
      }
    });

    fleet.boxes.set("vm1", vmBox.box);
    await watch.refresh();
    const url1 = watch.url("vm1")!;
    expect(vmBox.writes).toBe(1);
    expect(vmBox.files.get(watchUrlPath)).toEqual({ data: `${url1}\n`, mode: 0o600 });

    // Rotating to a second address fails mid-write, leaving disk state unknown.
    setAddresses([{ kind: "local", label: "Alt", url: "http://127.0.0.1:4790" }]);
    await watch.refresh();
    expect(vmBox.writes).toBe(2);
    expect(vmBox.files.has(watchUrlPath)).toBe(false);

    // Reverting to url1 must still rewrite rather than hitting a stale delivered entry.
    setAddresses([{ kind: "local", label: "This Mac", url: "http://127.0.0.1:3790" }]);
    await watch.refresh();
    expect(vmBox.writes).toBe(3);
    expect(vmBox.files.get(watchUrlPath)).toEqual({ data: `${url1}\n`, mode: 0o600 });

    // Once written, an unchanged refresh is cached again.
    await watch.refresh();
    expect(vmBox.writes).toBe(3);
  });
});
