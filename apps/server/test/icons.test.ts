import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { T3Gateway } from "../src/gateway/http.ts";
import { Hub } from "../src/gateway/hub.ts";
import { nameIcon, projectIcon } from "../src/gateway/icons.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const projectId = "p1";
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

/** A VM's T3 that answers project logo requests with `name`, and serves `png` for it. */
function fakeT3() {
  const state = { name: "v1-favicon.png", downloads: 0 };
  const backend = {
    call: async (tag: string, payload: Wire) => {
      expect(tag).toBe("assets.createUrl");
      expect(payload).toEqual({ resource: { _tag: "project-favicon", cwd: "/workspace/fikrabot" } });
      return { relativeUrl: `/api/assets/signed.token/${state.name}`, expiresAt: 1 };
    },
    http: async () => {
      state.downloads++;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  } as unknown as Backend;
  return { backend, state };
}

/** VM Bridge with project p1 on VM vm1, which is asleep. */
function setup() {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "kubi", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  store.insertProject({ id: projectId, url: "https://github.com/a/fikrabot", branch: null, title: "fikrabot", createdAt: 0 });
  store.addProjectVm(projectId, "vm1");
  const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, connected: () => [] }) as unknown as Fleet;
  const traffic = { record: () => {}, refused: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, { get: () => null, lastDisk: () => null });
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const gateway = new T3Gateway(hub, rpc, new Clients(store.db));
  const sent: Wire[] = [];
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
  const createUrl = async () => {
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "assets.createUrl", payload: { resource: { _tag: "project-favicon", cwd: `/projects/${projectId}` } } });
    for (let tries = 0; tries < 20 && !sent.length; tries++) await Bun.sleep(0);
    return sent.pop()!.exit as { _tag: string; value?: { relativeUrl: string } };
  };
  const fetch = (path: string) => gateway.fetch(new Request(`http://bridge${path}`), () => null, () => null) as Promise<Response>;
  return { hub, createUrl, fetch, close: () => (gateway.close(), hub.close()) };
}

test("a project's logo is kept while its VM is awake, and T3 clients get it while the VM sleeps", async () => {
  const { hub, createUrl, fetch, close } = setup();
  expect((await createUrl())._tag).toBe("Failure");

  const t3 = fakeT3();
  await hub.icons.refresh(projectId, "/workspace/fikrabot", t3.backend);
  const minted = await createUrl();
  expect(minted._tag).toBe("Success");
  const url = minted.value!.relativeUrl;
  // Named by the logo's hash, which only someone who has the logo can work out, and T3's own file name.
  expect(url).toMatch(/^\/api\/assets\/icon\.[0-9a-f]{64}\/v1-favicon\.png$/);
  const served = await fetch(url);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("content-security-policy")).toContain("sandbox");
  expect((await fetch(url.replace(/icon\.[0-9a-f]+/, `icon.${"0".repeat(64)}`))).status).toBe(404);

  // The same file is not downloaded again. A project whose logo was removed loses the copy.
  await hub.icons.refresh(projectId, "/workspace/fikrabot", t3.backend);
  expect(t3.state.downloads).toBe(1);
  t3.state.name = "project-favicon-missing";
  await hub.icons.refresh(projectId, "/workspace/fikrabot", t3.backend);
  expect((await createUrl())._tag).toBe("Failure");
  expect((await fetch(url)).status).toBe(404);
  close();
});

test("the dashboard shows the icon T3 would: the one picked in T3, then the logo, then letters from the name", () => {
  const stored = { contentType: "image/png", revision: "abc", name: "v1-favicon.png" };
  expect(projectIcon("p1", "fikrabot", { kind: "emoji", emoji: "🚀" }, stored)).toEqual({ kind: "emoji", emoji: "🚀" });
  expect(projectIcon("p1", "fikrabot", { kind: "monogram", text: "FB", color: "teal" }, stored)).toEqual({ kind: "monogram", text: "FB", color: "teal" });
  // T3's icon set is not in the dashboard: its color, with the name's letters.
  expect(projectIcon("p1", "fikrabot", { kind: "lucide", name: "rocket", color: "rose" }, stored)).toEqual({ kind: "monogram", text: "FT", color: "rose" });
  expect(projectIcon("p1", "fikrabot", null, stored)).toEqual({ kind: "image", url: "/admin/api/projects/p1/icon?v=abc" });
  expect(projectIcon("p1", "fikrabot", null, undefined)).toEqual({ kind: "monogram", ...nameIcon("fikrabot") });

  expect(nameIcon("fikrabot").text).toBe("FT");
  expect(nameIcon("vm bridge").text).toBe("VB");
  expect(nameIcon("app2-web").text).toBe("A2");
  expect(nameIcon("--").text).toBe("PR");
});

test("oversized and rejected icon responses are canceled without buffering the whole body", async () => {
  const { hub, createUrl, fetch, close } = setup();
  const makeBackend = (name: string, respond: () => Response) =>
    ({
      call: async () => ({ relativeUrl: `/api/assets/signed.token/${name}`, expiresAt: 1 }),
      http: async () => respond(),
    }) as unknown as Backend;

  // Declared Content-Length over 512 KiB is canceled before pulling any chunk, even if cancel stays pending.
  let pulledOversizedHeader = 0;
  let canceledOversizedHeader = false;
  const oversizedHeaderStream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulledOversizedHeader++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        canceledOversizedHeader = true;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  await hub.icons.refresh(
    projectId,
    "/workspace/fikrabot",
    makeBackend(
      "v1-big-header.png",
      () => new Response(oversizedHeaderStream, { headers: { "content-type": "image/png", "content-length": String(512 * 1024 + 1) } }),
    ),
  );
  expect(canceledOversizedHeader).toBe(true);
  expect(pulledOversizedHeader).toBe(0);
  expect(oversizedHeaderStream.locked).toBe(false);
  expect((await createUrl())._tag).toBe("Failure");

  // Chunked stream without Content-Length stops as soon as it crosses 512 KiB and releases the reader.
  let pulledChunks = 0;
  let canceledStream = false;
  const chunkedOversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulledChunks++;
      if (pulledChunks > 10) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(200 * 1024));
    },
    cancel() {
      canceledStream = true;
      return new Promise(() => {});
    },
  });
  await hub.icons.refresh(
    projectId,
    "/workspace/fikrabot",
    makeBackend("v2-big-stream.png", () => new Response(chunkedOversized, { headers: { "content-type": "image/png" } })),
  );
  expect(canceledStream).toBe(true);
  expect(pulledChunks).toBeLessThanOrEqual(4);
  expect(chunkedOversized.locked).toBe(false);
  expect((await createUrl())._tag).toBe("Failure");

  // Non-image responses cancel their body rather than leaking the stream.
  let canceledWrongType = false;
  const wrongTypeStream = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() {
      canceledWrongType = true;
    },
  });
  await hub.icons.refresh(
    projectId,
    "/workspace/fikrabot",
    makeBackend("v3-html.png", () => new Response(wrongTypeStream, { headers: { "content-type": "text/html" } })),
  );
  expect(canceledWrongType).toBe(true);
  expect(wrongTypeStream.locked).toBe(false);
  expect((await createUrl())._tag).toBe("Failure");

  // A valid multi-chunk icon of exactly 512 KiB (with an empty chunk and non-decimal Content-Length) is reassembled verbatim.
  const exactLimit = new Uint8Array(512 * 1024);
  for (let i = 0; i < exactLimit.length; i++) exactLimit[i] = i & 0xff;
  const parts = [exactLimit.slice(0, 200_000), new Uint8Array(0), exactLimit.slice(200_000)];
  let idx = 0;
  const validStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < parts.length) controller.enqueue(parts[idx++]!);
      else controller.close();
    },
  });
  await hub.icons.refresh(
    projectId,
    "/workspace/fikrabot",
    makeBackend("v4-exact-limit.png", () => new Response(validStream, { headers: { "content-type": "image/png", "content-length": "0x80001" } })),
  );
  const minted = await createUrl();
  expect(minted._tag).toBe("Success");
  const served = await fetch(minted.value!.relativeUrl);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(exactLimit);
  expect(validStream.locked).toBe(false);
  close();
});
