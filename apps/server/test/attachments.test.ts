import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { T3Gateway } from "../src/gateway/http.ts";
import { Hub } from "../src/gateway/hub.ts";
import { bridgeJobs } from "../src/jobs.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };
const threadUuid = "0f8b6d1e-2c3a-4b5d-8e9f-0a1b2c3d4e5f";

/** A VM's T3 server: answers attachment and asset calls the way T3 does, and records what reaches it. */
function fakeVm() {
  const requests: { tag: string; payload: Wire }[] = [];
  const uploads: { path: string; bytes: Uint8Array; type: string | null }[] = [];
  const assets: { path: string; range: string | null }[] = [];
  let minted = 0;
  let assetResponse = () => new Response("png", { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  const answer = (tag: string, payload: Wire): Wire => {
    if (tag === "attachments.createUploadUrl") {
      minted++;
      return { attachmentId: `pending-00000000-0000-4000-8000-00000000000${minted}`, relativeUrl: `/api/attachments/upload/vmtoken${minted}`, expiresAt: 1 };
    }
    if (tag === "assets.createUrl") return { relativeUrl: "/api/assets/payload.signature/image.png", expiresAt: 2, sourcePath: "/workspace/a.png" };
    return { from: tag, payload };
  };
  const backend = {
    request: (tag: string, payload: Wire, handler: (frame: Wire) => void) => {
      requests.push({ tag, payload });
      queueMicrotask(() => handler({ _tag: "Exit", exit: { _tag: "Success", value: answer(tag, payload) } }));
      return () => {};
    },
    call: async (tag: string, payload: Wire) => {
      requests.push({ tag, payload });
      return answer(tag, payload);
    },
    http: async (path: string, init: RequestInit = {}) => {
      if (path.startsWith("/api/attachments/upload/")) {
        uploads.push({ path, bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), type: new Headers(init.headers).get("content-type") });
        return new Response(null, { status: 204 });
      }
      assets.push({ path, range: new Headers(init.headers).get("range") });
      return assetResponse();
    },
  } as unknown as Backend;
  return { backend, requests, uploads, assets, serve: (response: () => Response) => (assetResponse = response) };
}

function setup(backends: Record<string, Backend | undefined>, capabilities?: Wire) {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  for (const id of ["vm1", "vm2"]) store.insertVm({ id, provider: "kubi", name: id, size: "medium", state: "ready", createdAt: 0 });
  if (capabilities) store.saveSnapshot("vm1", "config", { environment: { environmentId: "env1", orchestrationProtocolVersion: 2, capabilities } });
  store.setThreadVm(threadUuid, "vm1");
  store.setThreadVm("Thread One", "vm2");
  const woken: string[] = [];
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends[id],
    connected: () => Object.keys(backends).filter((id) => backends[id]),
    ensure: async (id: string) => {
      woken.push(id);
      return backends[id];
    },
    lease: () => () => {},
  }) as unknown as Fleet;
  const recorded: Wire[] = [];
  const traffic = { record: (entry: Wire) => recorded.push(entry), refused: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const gateway = new T3Gateway(hub, rpc, new Clients(store.db));
  const sent: Wire[] = [];
  let open = true;
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => open };
  let id = 0;
  const call = async (tag: string, payload: Wire) => {
    const requestId = ++id;
    await rpc.handle(client, { _tag: "Request", id: requestId, tag, payload });
    for (let tries = 0; tries < 20 && !sent.some((frame) => frame.requestId === requestId); tries++) await Bun.sleep(0);
    return sent.find((frame) => frame.requestId === requestId)!.exit as Wire;
  };
  const fetch = (path: string, init?: RequestInit) =>
    gateway.fetch(new Request(`http://bridge${path}`, init), () => null, () => null) as Promise<Response>;
  const close = () => {
    gateway.close();
    hub.close();
  };
  const leave = () => (open = false);
  return { store, hub, rpc, client, call, fetch, close, woken, recorded, leave };
}

const bytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => index % 251);
const value = (exit: Wire) => (exit as { value: Wire }).value;
const failure = (exit: Wire) => JSON.stringify(exit.cause);

describe("attachments through VM Bridge", () => {
  test("an upload is held until a message sends it, then handed to the thread's VM under the VM's ID", async () => {
    const vm1 = fakeVm();
    const { call, fetch, close, recorded } = setup({ vm1: vm1.backend });
    const file = bytes(2 * 1024 * 1024 + 123);
    const minted = value(await call("attachments.createUploadUrl", { type: "file", name: "notes.TXT", mimeType: "text/plain", sizeBytes: file.byteLength }));
    expect(minted.attachmentId).toMatch(/^pending-[0-9a-f-]{36}-txt$/);
    expect(minted.relativeUrl).toMatch(/^\/api\/attachments\/upload\/[\w-]+$/);
    // Nothing reaches a VM before the message names its thread.
    expect(vm1.requests).toEqual([]);

    const url = String(minted.relativeUrl);
    expect((await fetch(url, { method: "POST", body: file, headers: { "content-type": "text/plain" } })).status).toBe(204);
    // A used URL is spent.
    expect((await fetch(url, { method: "POST", body: file })).status).toBe(404);
    // The token never reaches the log.
    expect(recorded.map((entry) => entry.operation)).toContain("POST /api/attachments/upload/:token");
    expect(JSON.stringify(recorded)).not.toContain(url.split("/").at(-1));

    const attachment = { type: "file", id: minted.attachmentId, name: "notes.TXT", mimeType: "text/plain", sizeBytes: file.byteLength };
    const dispatch = (commandId: string) =>
      call("orchestration.dispatchCommand", { type: "message.dispatch", commandId, threadId: threadUuid, message: { text: "hi", attachments: [attachment] } });
    expect((await dispatch("cmd1"))._tag).toBe("Success");
    expect(vm1.requests[0]).toEqual({ tag: "attachments.createUploadUrl", payload: { type: "file", name: "notes.TXT", mimeType: "text/plain", sizeBytes: file.byteLength } });
    expect(vm1.uploads).toHaveLength(1);
    expect(vm1.uploads[0]!.path).toBe("/api/attachments/upload/vmtoken1");
    expect(vm1.uploads[0]!.type).toBe("text/plain");
    expect(vm1.uploads[0]!.bytes).toEqual(file);
    const sentMessage = vm1.requests[1]!.payload.message as { attachments: Wire[] };
    expect(sentMessage.attachments[0]!.id).toBe("pending-00000000-0000-4000-8000-000000000001");

    // A message sent again with the same file reuses what the VM has.
    expect((await dispatch("cmd2"))._tag).toBe("Success");
    expect(vm1.uploads).toHaveLength(1);
    expect((vm1.requests.at(-1)!.payload.message as { attachments: Wire[] }).attachments[0]!.id).toBe("pending-00000000-0000-4000-8000-000000000001");
    close();
  });

  test("a device that leaves while its files are handed over gets nothing run", async () => {
    const vm1 = fakeVm();
    const { rpc, client, call, fetch, close, leave } = setup({ vm1: vm1.backend });
    const minted = value(await call("attachments.createUploadUrl", { name: "a.png", mimeType: "image/png", sizeBytes: 3 }));
    expect((await fetch(String(minted.relativeUrl), { method: "POST", body: bytes(3) })).status).toBe(204);
    const upload = vm1.backend.http.bind(vm1.backend);
    vm1.backend.http = async (path, init) => {
      leave();
      return upload(path, init);
    };
    const attachment = { type: "image", id: minted.attachmentId, name: "a.png", mimeType: "image/png", sizeBytes: 3 };
    await rpc.handle(client, {
      _tag: "Request",
      id: 99,
      tag: "orchestration.dispatchCommand",
      payload: { type: "message.dispatch", commandId: "cmd1", threadId: threadUuid, message: { text: "hi", attachments: [attachment] } },
    });
    await Bun.sleep(0);
    expect(vm1.uploads).toHaveLength(1);
    expect(vm1.requests.map((request) => request.tag)).toEqual(["attachments.createUploadUrl"]);
    close();
  });

  test("an upload of the wrong size is refused and gone, and a message naming it fails without reaching the VM", async () => {
    const vm1 = fakeVm();
    const { call, fetch, close } = setup({ vm1: vm1.backend });
    const minted = value(await call("attachments.createUploadUrl", { name: "a.png", mimeType: "image/png", sizeBytes: 10 }));
    expect((await fetch(String(minted.relativeUrl), { method: "POST", body: bytes(11) })).status).toBe(400);
    const exit = await call("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: "cmd1",
      threadId: threadUuid,
      message: { text: "", attachments: [{ type: "image", id: minted.attachmentId, name: "a.png", mimeType: "image/png", sizeBytes: 10 }] },
    });
    // Unknown to VM Bridge now, so the VM answers for it as for any missing upload.
    expect(exit._tag).toBe("Success");
    expect(vm1.uploads).toEqual([]);

    // One not uploaded yet fails the command with a reason the client shows.
    const waiting = value(await call("attachments.createUploadUrl", { name: "b.png", mimeType: "image/png", sizeBytes: 10 }));
    const refused = await call("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: "cmd2",
      threadId: threadUuid,
      message: { text: "", attachments: [{ type: "image", id: waiting.attachmentId, name: "b.png", mimeType: "image/png", sizeBytes: 10 }] },
    });
    expect(failure(refused)).toContain("has not finished uploading");
    expect(vm1.requests.map((request) => request.tag)).toEqual(["orchestration.dispatchCommand"]);
    close();
  });

  test("asset URLs come from the attachment's VM and point at VM Bridge, which relays them", async () => {
    const vm1 = fakeVm();
    const vm2 = fakeVm();
    const { call, fetch, close } = setup({ vm1: vm1.backend, vm2: vm2.backend });
    const minted = value(await call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: `${threadUuid}-11111111-2222-4333-8444-555555555555` } }));
    expect(minted).toMatchObject({ relativeUrl: "/api/assets/vm1.payload.signature/image.png", expiresAt: 2 });
    expect(vm2.requests).toEqual([]);
    // T3 makes a thread ID safe for the file name; the attachment still finds its thread.
    await call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: "thread-one-11111111-2222-4333-8444-555555555555-pdf" } });
    expect(vm2.requests.map((request) => request.tag)).toEqual(["assets.createUrl"]);

    const image = await fetch(String(minted.relativeUrl), { headers: { range: "bytes=0-1" } });
    expect(await image.text()).toBe("png");
    expect(vm1.assets).toEqual([{ path: "/api/assets/payload.signature/image.png", range: "bytes=0-1" }]);
    expect(image.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(image.headers.get("content-security-policy")).toBeNull();

    // A page the VM sends is sandboxed here whatever its own policy says: VM Bridge's origin also serves the dashboard.
    const bridgePolicy = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
    for (const policy of ["sandbox allow-scripts allow-same-origin", "sandbox-invalid", "default-src 'self'"]) {
      vm1.serve(() => new Response("<script>", { headers: { "content-type": "text/html", "content-security-policy": policy } }));
      const page = await fetch("/api/assets/vm1.other.signature/page.html");
      // Two policies, both enforced: the VM's can only narrow VM Bridge's.
      expect(page.headers.get("content-security-policy")).toBe(`${policy}, ${bridgePolicy}`);
    }
    expect((await fetch("/api/assets/nope.payload.signature/image.png")).status).toBe(404);
    close();
  });

  test("a file link that climbs out of /api/assets/ is refused without asking the VM", async () => {
    const vm1 = fakeVm();
    const { fetch, close } = setup({ vm1: vm1.backend });
    // Unauthenticated links, relayed with VM Bridge's own token: `..` would reach /api/projects or /. One the URL
    // parser already collapsed no longer looks like a file link and needs a bearer like any other route.
    for (const path of ["/api/assets/vm1.../projects", "/api/assets/vm1.payload.signature/%2e%2e", "/api/assets/vm1.../%2E%2E"]) {
      expect([401, 404]).toContain((await fetch(path)).status);
    }
    expect(vm1.assets).toEqual([]);
    close();
  });

  test("a sleeping VM is not woken for an asset, and an unknown pending upload reads as missing", async () => {
    const vm1 = fakeVm();
    const { call, fetch, close, woken } = setup({ vm2: vm1.backend });
    const asleep = await call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: `${threadUuid}-11111111-2222-4333-8444-555555555555` } });
    expect(failure(asleep)).toContain("This VM is asleep.");
    expect((await fetch("/api/assets/vm1.payload.signature/image.png")).status).toBe(404);
    expect(woken).toEqual([]);

    const missing = await call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: "pending-11111111-2222-4333-8444-555555555555" } });
    expect(missing.cause).toEqual([{ _tag: "Fail", error: expect.objectContaining({ _tag: "AssetAttachmentNotFoundError" }) }]);
    close();
  });

  test("a held upload is found, served safely and deleted on request", async () => {
    const { call, fetch, close } = setup({});
    const page = new TextEncoder().encode("<script>alert(1)</script>");
    const minted = value(await call("attachments.createUploadUrl", { type: "file", name: "x.html", mimeType: "text/html", sizeBytes: page.byteLength }));
    await fetch(String(minted.relativeUrl), { method: "POST", body: page });
    const resource = { _tag: "attachment", attachmentId: minted.attachmentId };
    const asset = value(await call("assets.createUrl", { resource }));
    const served = await fetch(String(asset.relativeUrl));
    expect(await served.text()).toBe("<script>alert(1)</script>");
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");

    // A void answer still carries `value`, which the client requires.
    expect(await call("attachments.delete", { attachmentId: minted.attachmentId })).toEqual({ _tag: "Success", value: null });
    expect((await call("assets.createUrl", { resource })).cause).toEqual([{ _tag: "Fail", error: expect.objectContaining({ _tag: "AssetAttachmentNotFoundError" }) }]);
    expect((await fetch(String(asset.relativeUrl))).status).toBe(404);
    close();
  });

  test("clients are told uploads work when the VMs take them, up to what VM Bridge holds", () => {
    const { hub, close } = setup({}, { attachmentUploads: true, questionAttachments: true, fileAttachments: { maxUploadBytes: 500 * 1024 * 1024 } });
    expect(hub.descriptor().capabilities).toMatchObject({ attachmentUploads: true, questionAttachments: true, fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 } });
    close();
    const older = setup({}, {});
    expect(older.hub.descriptor().capabilities).toMatchObject({ attachmentUploads: false });
    expect(older.hub.descriptor().capabilities).not.toHaveProperty("fileAttachments");
    older.close();
  });

  test("scheduled attachment sweep reclaims expired uploads and their chunks while keeping fresh and active uploads", async () => {
    const { hub, call, fetch, close } = setup({});
    try {
      const data = new TextEncoder().encode("abandon-me");
      const expired = value(await call("attachments.createUploadUrl", { type: "file", name: "old.txt", mimeType: "text/plain", sizeBytes: data.byteLength }));
      const fresh = value(await call("attachments.createUploadUrl", { type: "file", name: "new.txt", mimeType: "text/plain", sizeBytes: data.byteLength }));
      expect((await fetch(String(expired.relativeUrl), { method: "POST", body: data })).status).toBe(204);
      expect((await fetch(String(fresh.relativeUrl), { method: "POST", body: data })).status).toBe(204);

      hub.store.db.run("UPDATE attachment_uploads SET expires_at = ? WHERE id = ?", Date.now() - 1, String(expired.attachmentId));
      const jobs = bridgeJobs({
        hub,
        fleet: hub.fleet,
        stats: { sampleAll: async () => {} } as never,
        usage: { sync: () => {} } as never,
        budget: { status: () => ({ level: "ok" }) } as never,
        traffic: { record: () => {} } as never,
        watch: { refresh: async () => {} } as never,
      });
      const sweepJob = jobs.find((job) => job.name === "attachment sweep");
      expect(sweepJob).toBeDefined();
      await sweepJob!.run();

      expect(hub.store.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM attachment_uploads WHERE id = ?", String(expired.attachmentId))?.n).toBe(0);
      expect(hub.store.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM attachment_chunks WHERE upload_id = ?", String(expired.attachmentId))?.n).toBe(0);
      expect(hub.attachments.held(String(fresh.attachmentId))).toBeDefined();
      expect(hub.store.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM attachment_chunks WHERE upload_id = ?", String(fresh.attachmentId))?.n).toBe(1);

      // A streaming upload claimed near its URL TTL extends its deadline so sweeps do not drop it mid-body.
      const streaming = value(await call("attachments.createUploadUrl", { type: "file", name: "slow.txt", mimeType: "text/plain", sizeBytes: data.byteLength }));
      const originalExpiry = Number(streaming.expiresAt);
      let pushRest!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data.subarray(0, 4));
          pushRest = () => {
            controller.enqueue(data.subarray(4));
            controller.close();
          };
        },
      });
      const uploading = fetch(String(streaming.relativeUrl), { method: "POST", body });
      await Bun.sleep(0);
      expect(hub.attachments.sweep(originalExpiry + 1)).toBe(0);
      pushRest();
      expect((await uploading).status).toBe(204);
      expect(new Uint8Array(await hub.attachments.file(String(streaming.attachmentId))!.body.arrayBuffer())).toEqual(data);

      // If an in-flight row disappears before completion, receive() does not report a false 204.
      const removed = value(await call("attachments.createUploadUrl", { type: "file", name: "gone.txt", mimeType: "text/plain", sizeBytes: data.byteLength }));
      let finishRemoved!: () => void;
      const removedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          finishRemoved = () => {
            controller.enqueue(data);
            controller.close();
          };
        },
      });
      const removedUpload = fetch(String(removed.relativeUrl), { method: "POST", body: removedBody });
      await Bun.sleep(0);
      hub.attachments.remove(String(removed.attachmentId));
      finishRemoved();
      expect((await removedUpload).status).toBe(404);
    } finally {
      close();
    }
  });
});
