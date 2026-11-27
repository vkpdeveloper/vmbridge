import { EventEmitter } from "node:events";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { openSocket } from "../src/bun/socket.ts";
import type { Fleet } from "../src/fleet.ts";
import { isOpenCodeRequest, OpenCodeGateway, promptText } from "../src/gateway/opencode.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import { OpenCodeServer } from "../src/vm/opencode.ts";
import { testEncryption } from "./key.ts";

const projectPassword = "project-pass-1";
const vmPassword = "vm-pass-9f2c";
const previewToken = "preview-token-77ab";
const previewHeader = "preview-header-31cd";
const secrets = [vmPassword, previewToken, previewHeader, "127.0.0.1"];

/** What the VM's OpenCode was asked. */
let asked: { path: string; headers: Headers }[] = [];
let upstreamStatus = 200;
const vm = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    asked.push({ path: url.pathname + url.search, headers: request.headers });
    if (url.pathname === "/api/event") {
      // Two of OpenCode's events, the first split across chunks.
      const chunks = ['data: {"id":"evt_1","type":"server.', 'connected","data":{}}\n\n', 'data: {"id":"evt_2","type":"x","data":{}}\n\n'];
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
            else controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({ path: url.pathname }, { status: upstreamStatus, headers: { "set-cookie": `session=${vmPassword}` } });
  },
});
afterAll(() => vm.stop(true));

const preview = (port: number) => ({ url: `http://127.0.0.1:${port}/?preview_token=${previewToken}`, headers: { "x-preview": previewHeader } });

function setup({ awake = true, wakeMs = 0, wakeWaitMs = 1_000, port = vm.port } = {}) {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  store.insertVm({ id: "vm1", provider: "kubi", name: "vm1", size: "medium", state: awake ? "ready" : "sleeping", createdAt: 0 });
  for (const id of ["p1", "p2"]) store.insertProject({ id, url: `https://github.com/acme/${id}.git`, branch: null, title: id, createdAt: 0 });
  store.addProjectVm("p1", "vm1");
  store.setOpenCodePassword("p1", projectPassword);
  store.setOpenCodePassword("p2", "other-pass");
  const calls = { place: [] as string[], wake: 0, forgot: 0 };
  let up = awake;
  const server = new OpenCodeServer("vm1", preview(port ?? 0), vmPassword, openSocket);
  const fleet = Object.assign(new EventEmitter(), {
    machineReady: () => up,
    place: async (projectId: string) => {
      calls.place.push(projectId);
      return "vm1";
    },
    // OpenCode waits only for the VM to be prepared, never for T3.
    machine: async () => {
      calls.wake++;
      await Bun.sleep(wakeMs);
      up = true;
    },
    opencode: async () => server,
    lease: () => () => {},
    touch: () => {},
    forgetOpenCode: () => void calls.forgot++,
  }) as unknown as Fleet;
  const gateway = new OpenCodeGateway(store, fleet, new Traffic(db), () => true, wakeWaitMs);
  return { gateway, calls, store };
}

const basic = (password: string) => `Basic ${btoa(`opencode:${password}`)}`;
const noUpgrade = () => null;

function send(gateway: OpenCodeGateway, path: string, init: RequestInit = {}) {
  return gateway.fetch(new Request(`http://bridge.test${path}`, init), noUpgrade) as Promise<Response>;
}

async function expectNoSecrets(response: Response) {
  const text = (await response.text()) + JSON.stringify([...response.headers]);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

beforeEach(() => {
  asked = [];
  upstreamStatus = 200;
});

describe("OpenCode gateway", () => {
  test("refuses a missing or wrong password, and an unknown project the same way, without asking the VM", async () => {
    const { gateway, calls } = setup();
    for (const [path, authorization] of [
      ["/opencode/p1/api/session", undefined],
      ["/opencode/p1/api/session", basic("wrong")],
      ["/opencode/p1/api/session", basic("other-pass")],
      ["/opencode/nope/api/session", basic(projectPassword)],
      ["/api/session", basic("wrong")],
    ] as const) {
      const response = await send(gateway, path, authorization ? { headers: { authorization } } : {});
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" });
    }
    expect(asked).toEqual([]);
    expect(calls.place).toEqual([]);
  });

  test("strips the prefix and swaps the client's credentials for the VM's, which never come back", async () => {
    const { gateway } = setup();
    const response = await send(gateway, `/opencode/p1/api/session?directory=%2Fw&auth_token=${btoa(`opencode:${projectPassword}`)}`, {
      headers: { cookie: "mine=1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [request] = asked;
    expect(request!.path).toBe(`/api/session?directory=%2Fw&preview_token=${previewToken}`);
    expect(request!.headers.get("authorization")).toBe(basic(vmPassword));
    expect(request!.headers.get("x-preview")).toBe(previewHeader);
    expect(request!.headers.get("cookie")).toBeNull();
    await expectNoSecrets(response);
  });

  test("finds the project by its password for requests at the root, as `opencode api` sends them", async () => {
    const { gateway, calls } = setup();
    const response = await send(gateway, "/api/session", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(200);
    expect(calls.place).toEqual(["p1"]);
    expect(asked[0]!.path).toStartWith("/api/session?");
    expect(isOpenCodeRequest(new Request("http://bridge.test/api/session"))).toBe(false);
  });

  test("refuses paths that would leave the one it checked, and pairing", async () => {
    const { gateway } = setup();
    for (const path of ["/opencode/p1//evil.test/x", "/opencode/p1/\\evil.test/x", "/opencode/p1/api/pair", "/opencode/p1/auth/connect"]) {
      const response = await send(gateway, path, { headers: { authorization: basic(projectPassword) } });
      expect(response.status).toBe(404);
    }
    expect(asked).toEqual([]);
  });

  test("a pairing code trades once for the project's password, at that project's address only", async () => {
    const { gateway } = setup();
    const { code } = gateway.pairingCode("p1");
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await send(gateway, `/opencode/p2/auth/connect/${code}`)).status).toBe(401);
    const response = await send(gateway, `/opencode/p1/auth/connect/${code}`, { headers: { origin: "https://app.opencode.test" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.opencode.test");
    expect(await response.json()).toEqual({ token: projectPassword });
    // OpenCode's clients read a 401 as an expired link.
    expect((await send(gateway, `/opencode/p1/auth/connect/${code}`)).status).toBe(401);
    expect((await send(gateway, "/opencode/p1/auth/connect/made-up")).status).toBe(401);
    expect(asked).toEqual([]);
  });

  test("at the root, as OpenCode's phone app asks, the code names the project and its password then routes requests", async () => {
    const { gateway } = setup();
    expect(isOpenCodeRequest(new Request("http://bridge.test/auth/connect/abc"))).toBe(true);
    const { code } = gateway.pairingCode("p1");
    const { token } = (await (await send(gateway, `/auth/connect/${code}`)).json()) as { token: string };
    expect(token).toBe(projectPassword);
    expect((await send(gateway, `/auth/connect/${code}`)).status).toBe(401);
    const response = await send(gateway, "/api/info", { headers: { authorization: basic(token) } });
    expect(response.status).toBe(200);
    expect(asked[0]!.path).toBe(`/api/info?preview_token=${previewToken}`);
  });

  test("a new password ends the pairing codes made before it", async () => {
    const { gateway } = setup();
    const { code } = gateway.pairingCode("p1");
    gateway.disconnect("p1");
    expect((await send(gateway, `/opencode/p1/auth/connect/${code}`)).status).toBe(401);
  });

  test("holds a request while the VM wakes", async () => {
    const { gateway, calls } = setup({ awake: false, wakeMs: 100 });
    const response = await send(gateway, "/opencode/p1/api/session", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(200);
    expect(calls.wake).toBe(1);
  });

  test("a request that waited while the password changed is refused, as the change ended only open connections", async () => {
    const { gateway, store } = setup({ awake: false, wakeMs: 100 });
    const waiting = send(gateway, "/opencode/p1/api/session", { headers: { authorization: basic(projectPassword) } });
    await Bun.sleep(20);
    store.setOpenCodePassword("p1", "renewed-pass");
    gateway.disconnect("p1");
    expect((await waiting).status).toBe(401);
    expect(asked).toEqual([]);
  });

  test("asks the client to try again when waking takes too long", async () => {
    const { gateway } = setup({ awake: false, wakeMs: 500, wakeWaitMs: 50 });
    const response = await send(gateway, "/opencode/p1/api/session", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(asked).toEqual([]);
  });

  test("answers OpenCode's health check itself while the VM wakes, so the client does not give up", async () => {
    const { gateway, calls } = setup({ awake: false, wakeMs: 300, wakeWaitMs: 50 });
    const auth = { headers: { authorization: basic(projectPassword) } };
    const response = await send(gateway, "/opencode/p1/api/info", auth);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { version: string }).version).toStartWith("2.");
    expect(asked).toEqual([]);
    // The wake goes on.
    expect(calls.wake).toBe(1);
  });

  test("a worktree address goes to its VM, and OpenCode's question for the server's folder gets the worktree", async () => {
    const { gateway, store } = setup();
    store.setCheckout("p1", "vm1", "/workspace/app");
    const auth = { headers: { authorization: basic(projectPassword) } };
    expect((await send(gateway, "/opencode/p1/w/vm1/ab12cd34/api/location", auth)).status).toBe(200);
    expect(asked[0]!.path).toStartWith(`/api/location?${new URLSearchParams({ "location[directory]": "/workspace/.worktrees/app/ab12cd34" })}`);
    // A folder the client names goes through as it is, so the VM can say it has no such folder.
    await send(gateway, "/opencode/p1/w/vm1/ab12cd34/api/fs/list?location%5Bdirectory%5D=%2FUsers%2Fme", auth);
    expect(asked[1]!.path).toStartWith("/api/fs/list?location%5Bdirectory%5D=%2FUsers%2Fme");
  });

  test("a prompt in a worktree makes its session the one to open again, and uses come first in the list", async () => {
    const { gateway, store } = setup();
    store.setCheckout("p1", "vm1", "/workspace/app");
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "ab12cd34", branch: "opencode/ab12cd34", base: "main" });
    await Bun.sleep(2);
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "ef56ab78", branch: "opencode/ef56ab78", base: "main" });
    expect(store.openCodeWorktrees("p1").map((row) => row.name)).toEqual(["ef56ab78", "ab12cd34"]);

    await Bun.sleep(2);
    const prompt = { parts: [{ type: "text", text: "  Fix the login\n redirect  " }] };
    const response = await send(gateway, "/opencode/p1/w/vm1/ab12cd34/api/session/ses_1/prompt", {
      method: "POST",
      headers: { authorization: basic(projectPassword), "content-type": "application/json" },
      body: JSON.stringify(prompt),
    });
    expect(response.status).toBe(200);
    // The body still reaches the VM whole.
    expect(asked[0]!.path).toStartWith("/api/session/ses_1/prompt");
    await Bun.sleep(5);
    const [first] = store.openCodeWorktrees("p1");
    expect(first).toMatchObject({ name: "ab12cd34", sessionId: "ses_1", lastPrompt: "Fix the login redirect" });
  });

  test("a worktree address names only the project's own VMs and plain worktree names", async () => {
    const { gateway, store } = setup();
    store.setCheckout("p1", "vm1", "/workspace/app");
    const auth = { headers: { authorization: basic(projectPassword) } };
    expect((await send(gateway, "/opencode/p1/w/vm2/ab12cd34/api/info", auth)).status).toBe(404);
    expect((await send(gateway, "/opencode/p1/w/vm1/..%2Fetc/api/info", auth)).status).toBe(404);
    expect(asked).toEqual([]);
  });

  test("an event stream does not wake a sleeping VM", async () => {
    const { gateway, calls } = setup({ awake: false });
    const response = await send(gateway, "/opencode/p1/api/event", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(calls.place).toEqual([]);
    expect(calls.wake).toBe(0);
  });

  test("an event stream gets a toast naming the VM, for the folder the app works in, between OpenCode's events", async () => {
    const { gateway, store } = setup();
    store.setCheckout("p1", "vm1", "/workspace/app");
    const auth = { headers: { authorization: basic(projectPassword) } };
    for (const [path, directory] of [
      ["/opencode/p1/api/event", "/workspace/app"],
      ["/opencode/p1/w/vm1/ab12cd34/api/event", "/workspace/.worktrees/app/ab12cd34"],
    ] as const) {
      const frames = (await (await send(gateway, path, auth)).text()).split("\n\n").filter(Boolean);
      expect(frames.filter((frame) => !frame.includes("tui.toast.show"))).toEqual([
        'data: {"id":"evt_1","type":"server.connected","data":{}}',
        'data: {"id":"evt_2","type":"x","data":{}}',
      ]);
      const toast = frames.findIndex((frame) => frame.includes("tui.toast.show"));
      expect(toast).toBeGreaterThan(0);
      const event = JSON.parse(frames[toast]!.slice("data: ".length));
      expect(event.id).toStartWith("evt_");
      expect(event.location).toEqual({ directory });
      expect(event.data).toMatchObject({ title: "VM Bridge", variant: "info" });
      expect(event.data.message).toStartWith("Running on vm1 (");
    }
  });

  test("a VM that does not answer gets a fixed error naming nothing of the VM", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = closed.port;
    await closed.stop(true);
    const { gateway, calls } = setup({ port });
    const response = await send(gateway, "/opencode/p1/api/session", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(502);
    expect(calls.forgot).toBe(1);
    await expectNoSecrets(response);
  });

  test("a VM that refuses VM Bridge's password is forgotten, and its answer is not passed on", async () => {
    upstreamStatus = 401;
    const { gateway, calls } = setup();
    const response = await send(gateway, "/opencode/p1/api/session", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(502);
    expect(calls.forgot).toBe(1);
    await expectNoSecrets(response);
  });
});

test("a prompt's text is found however OpenCode nests it, and cut short", () => {
  expect(promptText({ parts: [{ type: "file", url: "x" }, { type: "text", text: "hello" }] })).toBe("hello");
  expect(promptText({ command: "review", arguments: "" })).toBe("review");
  expect(promptText({ parts: [] })).toBeNull();
  expect(promptText({ text: "a".repeat(300) })!.length).toBe(120);
});
