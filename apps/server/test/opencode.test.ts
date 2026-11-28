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
      // Two of OpenCode's events, the first split across chunks. With `hold`, the stream stays open after them.
      const chunks = ['data: {"id":"evt_1","type":"server.', 'connected","data":{}}\n\n', 'data: {"id":"evt_2","type":"x","data":{}}\n\n'];
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
            else if (url.searchParams.has("hold")) await new Promise((resolve) => request.signal.addEventListener("abort", resolve));
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

/** `startMs` is how long starting OpenCode takes, as after a wake. A started server is kept until it is forgotten, as Fleet keeps it. */
function setup({ awake = true, wakeMs = 0, wakeWaitMs = 1_000, port = vm.port, startMs = 0 } = {}) {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  store.insertVm({ id: "vm1", provider: "kubi", name: "vm1", size: "medium", state: awake ? "ready" : "sleeping", createdAt: 0 });
  for (const id of ["p1", "p2"]) store.insertProject({ id, url: `https://github.com/acme/${id}.git`, branch: null, title: id, createdAt: 0 });
  store.addProjectVm("p1", "vm1");
  store.setOpenCodePassword("p1", projectPassword);
  store.setOpenCodePassword("p2", "other-pass");
  const calls = { place: [] as string[], wake: 0, forgot: 0, starts: 0, branch: "fix/login" as string | null };
  let up = awake;
  let kept: Promise<OpenCodeServer> | undefined;
  const start = async () => {
    calls.starts++;
    await Bun.sleep(startMs);
    return new OpenCodeServer("vm1", preview(port ?? 0), vmPassword, openSocket);
  };
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
    opencode: () => (kept ??= start()),
    // What git on the VM says of the worktree, when the VM is awake.
    worktreeState: async (_vmId: string, _projectId: string, _name: string, base: string | null) =>
      up ? { branch: calls.branch, sync: { base: base ?? "main", ahead: 2, behind: 1 }, ports: [5173] } : null,
    portPreview: async () => (up ? preview(port ?? 0) : null),
    openSocket,
    lease: () => () => {},
    touch: () => {},
    forgetOpenCode: (_vmId: string, server: OpenCodeServer) => {
      calls.forgot++;
      const current = kept;
      void current?.then((started) => {
        if (started === server && kept === current) kept = undefined;
      });
    },
  }) as unknown as Fleet;
  const pullRequests: { repository: string; branch: string }[] = [];
  const pullRequest = async (repository: string, branch: string) => {
    pullRequests.push({ repository, branch });
    if (branch !== "fix/login") return null;
    return { number: 7, url: `https://github.com/${repository}/pull/7`, state: "open" as const, checks: "failing" as const, review: "approved" as const };
  };
  const gateway = new OpenCodeGateway(store, fleet, new Traffic(db), () => true, pullRequest, wakeWaitMs);
  return { gateway, calls, store, pullRequests };
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

  test("answers a worktree's branch from git on the VM, its pull request, base and dev servers, waking no VM, and notes the branch", async () => {
    const { gateway, calls, store, pullRequests } = setup();
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "ab12cd34", branch: "opencode/ab12cd34", base: "main" });
    const ask = async (path: string, password = projectPassword) => {
      const response = await send(gateway, path, { headers: { authorization: basic(password) } });
      return response.status === 200 ? await response.json() : response.status;
    };
    const status = "/opencode/p1/w/vm1/ab12cd34/vmbridge/status";
    expect(await ask(status)).toEqual({
      branch: "fix/login",
      pullRequest: { number: 7, url: "https://github.com/acme/p1/pull/7", state: "open", checks: "failing", review: "approved" },
      vm: "ready",
      sync: { base: "main", ahead: 2, behind: 1 },
      ports: [5173],
    });
    expect(store.openCodeWorktrees("p1")[0]!.branch).toBe("fix/login");
    calls.branch = "HEAD";
    expect(await ask(status)).toMatchObject({ branch: "HEAD", pullRequest: null });
    expect(await ask(status, "other-pass")).toBe(401);
    expect(await ask("/opencode/p1/vmbridge/status")).toBe(404);
    expect(pullRequests).toEqual([{ repository: "acme/p1", branch: "fix/login" }]);
    expect(calls.wake).toBe(0);
    expect(asked).toEqual([]);
  });

  test("answers the branch VM Bridge noted while the worktree's VM sleeps", async () => {
    const { gateway, calls, store } = setup({ awake: false });
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "ab12cd34", branch: "opencode/ab12cd34", base: "main" });
    const response = await send(gateway, "/opencode/p1/w/vm1/ab12cd34/vmbridge/status", { headers: { authorization: basic(projectPassword) } });
    expect(await response.json()).toEqual({ branch: "opencode/ab12cd34", pullRequest: null, vm: "sleeping", sync: null, ports: [] });
    expect(calls.wake).toBe(0);
  });

  test("relays a dev server's port with the preview's credentials, passing its own cookies both ways", async () => {
    const { gateway } = setup();
    const response = await send(gateway, `/opencode/p1/w/vm1/ab12cd34/vmbridge/port/5173/src/main.ts?v=1&auth_token=${btoa(`opencode:${projectPassword}`)}`, {
      headers: { authorization: "Bearer app-token", cookie: "theme=dark" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(`session=${vmPassword}`);
    const [request] = asked;
    expect(request!.path).toBe(`/src/main.ts?v=1&preview_token=${previewToken}`);
    expect(request!.headers.get("x-preview")).toBe(previewHeader);
    expect(request!.headers.get("cookie")).toBe("theme=dark");
    expect(request!.headers.get("authorization")).toBe("Bearer app-token");
    await send(gateway, "/opencode/p1/w/vm1/ab12cd34/vmbridge/port/5173/", { headers: { authorization: basic(projectPassword) } });
    expect(asked[1]!.headers.get("authorization")).toBeNull();

    expect((await send(gateway, "/opencode/p1/w/vm1/ab12cd34/vmbridge/port/5173")).status).toBe(401);
    expect((await send(gateway, "/opencode/p1/vmbridge/port/5173/", { headers: { authorization: basic(projectPassword) } })).status).toBe(404);
    expect(asked).toHaveLength(2);
  });

  test("answers a dev server's port on a sleeping VM without waking it", async () => {
    const { gateway, calls } = setup({ awake: false });
    const response = await send(gateway, "/opencode/p1/w/vm1/ab12cd34/vmbridge/port/5173/", { headers: { authorization: basic(projectPassword) } });
    expect(response.status).toBe(503);
    expect(calls.wake).toBe(0);
    expect(asked).toEqual([]);
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

  test("an event stream connects at once to a sleeping VM's project without waking it", async () => {
    const { gateway, calls } = setup({ awake: false });
    const controller = new AbortController();
    const response = await send(gateway, "/opencode/p1/api/event", { headers: { authorization: basic(projectPassword) }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const first = await response.body!.getReader().read();
    expect(JSON.parse(new TextDecoder().decode(first.value).slice("data: ".length))).toMatchObject({ type: "server.connected", data: {} });
    expect(calls.place).toEqual([]);
    expect(calls.wake).toBe(0);
    expect(asked).toEqual([]);
    controller.abort();
  });

  test("an event stream stays open while its VM sleeps, and gets OpenCode's events before the prompt that wakes it", async () => {
    const { gateway, store } = setup({ awake: false });
    store.setCheckout("p1", "vm1", "/workspace/app");
    const fleet = (gateway as unknown as { fleet: EventEmitter & { machineReady(): boolean } }).fleet;
    const auth = { authorization: basic(projectPassword) };
    const controller = new AbortController();
    const response = await send(gateway, "/opencode/p1/api/event?hold", { headers: auth, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // A read still waiting when `readFor` stops gets the next chunk, so it is kept for the next call.
    let reading: ReturnType<typeof reader.read> | null = null;
    /** What the client got after `ms`, and whether its stream ended. */
    const readFor = async (ms: number) => {
      const until = Bun.sleep(ms).then(() => null);
      for (;;) {
        reading ??= reader.read();
        const next = await Promise.race([reading, until]);
        if (!next) return false;
        reading = null;
        if (next.done) return true;
        text += decoder.decode(next.value);
      }
    };
    const prompt = () => send(gateway, "/opencode/p1/api/session/ses_1/prompt", { method: "POST", headers: auth, body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }) });

    expect((await prompt()).status).toBe(200);
    expect(asked.map((entry) => entry.path.split("?")[0])).toEqual(["/api/event", "/api/session/ses_1/prompt"]);
    expect(await readFor(50)).toBe(false);
    // VM Bridge's own `server.connected` and none of OpenCode's, then OpenCode's toast and events.
    expect(text.match(/server\.connected/g)).toHaveLength(1);
    expect(text).toContain("tui.toast.show");
    expect(text).toContain('"id":"evt_2"');

    // Asleep: the client's stream stays open, and the next prompt joins it to OpenCode again before it is sent.
    asked = [];
    text = "";
    fleet.emit("offline", "vm1");
    expect(await readFor(50)).toBe(false);
    expect((await prompt()).status).toBe(200);
    expect(asked.map((entry) => entry.path.split("?")[0])).toEqual(["/api/event", "/api/session/ses_1/prompt"]);
    expect(await readFor(50)).toBe(false);
    expect(text).toBe('data: {"id":"evt_2","type":"x","data":{}}\n\n');

    // A new password ends it.
    gateway.disconnect("p1");
    expect(await readFor(50)).toBe(true);
  });

  test("an event stream whose OpenCode stops while the VM is awake ends, so the client loads again", async () => {
    const { gateway } = setup();
    const response = await send(gateway, "/opencode/p1/api/event", { headers: { authorization: basic(projectPassword) } });
    // The test VM's stream ends after two events.
    expect(await response.text()).toContain('"id":"evt_2"');
  });

  test("an event stream the client gave up on while OpenCode started keeps the server, so the client's next try connects", async () => {
    // As OpenCode's terminal app: a try that shows no event within 2 seconds (here 100 ms) is given up, and the next
    // starts a second later (here 200 ms). Starting OpenCode after a wake, or checking it after VM Bridge restarted,
    // takes longer than a try waits, so a client could connect only to a server started for an earlier try.
    const { gateway, calls } = setup({ startMs: 250 });
    const decoder = new TextDecoder();
    let connected = false;
    for (let attempt = 0; attempt < 8 && !connected; attempt++) {
      const signal = AbortSignal.timeout(100);
      const gaveUp = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null)));
      const answer = send(gateway, "/opencode/p1/api/event", { headers: { authorization: basic(projectPassword) }, signal });
      const first = await Promise.race([answer.then((response) => (response.ok ? response.body!.getReader().read() : null)), gaveUp]);
      connected = Boolean(first?.value && decoder.decode(first.value).includes("server."));
      if (!connected) await Bun.sleep(200);
    }
    expect(connected).toBe(true);
    expect(calls.starts).toBe(1);
    expect(calls.forgot).toBe(0);
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
      expect(frames).toHaveLength(3);
      expect(JSON.parse(frames[0]!.slice("data: ".length))).toMatchObject({ type: "server.connected", data: {} });
      expect(frames[2]).toBe('data: {"id":"evt_2","type":"x","data":{}}');
      const toast = frames.findIndex((frame) => frame.includes("tui.toast.show"));
      expect(toast).toBe(1);
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
