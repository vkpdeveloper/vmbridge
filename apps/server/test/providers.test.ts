import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { boatProvider } from "../src/providers/boat.ts";
import { daytonaProvider } from "../src/providers/daytona.ts";
import { instaboxError } from "../src/providers/index.ts";
import { retryNotFound } from "../src/providers/sdk.ts";
import type { CreateVm } from "../src/providers/types.ts";

describe("creating a boxd VM", () => {
  test("tries again when boxd loses track of the machine it just made, and gives up on anything else", async () => {
    const missing = new SandboxError("boxd request failed: the sandbox does not exist", { code: "not_found", provider: "boxd" });
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(missing) : Promise.resolve("box"));
    expect(await retryNotFound(flaky, 3, 1)).toBe("box");
    expect(calls).toBe(3);

    calls = 0;
    const quota = new SandboxError("Quota exceeded", { code: "quota", provider: "boxd" });
    await expect(retryNotFound(() => (calls++, Promise.reject(quota)), 3, 1)).rejects.toBe(quota);
    expect(calls).toBe(1);

    calls = 0;
    await expect(retryNotFound(() => (calls++, Promise.reject(missing)), 3, 1)).rejects.toBe(missing);
    expect(calls).toBe(3);
  });
});

describe("Instabox errors", () => {
  // As the SDK throws them: the HTTP status and Instabox's code are only in the cause.
  const quota = (providerCode: string) =>
    new SandboxError("Instabox create failed: a provider limit or billing stopped the request", {
      code: "quota",
      provider: "instabox",
      cause: JSON.stringify({ operation: "create", status: 429, providerCode }),
    });

  test("a full plan says what to do, and stays a quota error", () => {
    const error = instaboxError(quota("quota_exceeded"));
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "quota", message: "Your Instabox plan's machine limit is reached. Delete a machine or upgrade the plan." });
  });

  test("other limits keep the SDK's message", () => {
    const limited = quota("rate_limited");
    expect(instaboxError(limited)).toBe(limited);
  });
});

function boatSdkName(key: string, labels: Record<string, string>) {
  return "sandbox-sdk:1:" + deflateRawSync(JSON.stringify([key, labels])).toString("base64url");
}

async function withMockFetch(
  envKey: "BOAT_API_BASE" | "DAYTONA_API_URL",
  baseUrl: string,
  handler: (request: Request) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const previousFetch = globalThis.fetch;
  const previousEnv = process.env[envKey];
  process.env[envKey] = baseUrl;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(input instanceof Request ? input : new Request(String(input), init)))) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = previousEnv;
  }
}

describe("Boat cleanup and state reconciliation", () => {
  test("create() cleans up via direct DELETE with confirmation header without calling connect", async () => {
    const requests: { method: string; path: string; confirm: string | null }[] = [];
    await withMockFetch(
      "BOAT_API_BASE",
      "https://boat.test",
      (request) => {
        const { pathname: path } = new URL(request.url);
        const { method } = request;
        requests.push({ method, path, confirm: request.headers.get("X-Ascii-Confirm-Delete") });

        if (method === "POST" && path === "/sandboxes") {
          return Response.json({ sandbox: { id: "boat-new", name: null, state: "provisioning", createdAt: new Date().toISOString() } });
        }
        if (method === "PATCH" && path === "/sandboxes/boat-new") {
          return Response.json({ error: { code: "invalid_request", message: "patch failed" } }, { status: 400 });
        }
        if (method === "DELETE" && path === "/sandboxes/boat-new") {
          if (request.headers.get("X-Ascii-Confirm-Delete") !== "boat-new") {
            return Response.json({ error: { code: "confirm_required", message: "missing confirm" } }, { status: 409 });
          }
          return Response.json({});
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
      async () => {
        const driver = boatProvider.open({ values: { apiKey: "boat_test" } });
        const input: CreateVm = { key: "vm-boat-1", size: "small", labels: { vmbridge: "test" }, ports: [3773] };

        const error = await driver.create(input).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SandboxError);
        expect(error).toMatchObject({ code: "invalid_argument", provider: "boat" });
        expect((error as Error).message).toContain("PATCH /sandboxes/{sandboxId}");
        expect((error as Error).message).toContain("patch failed");
        expect(requests).toEqual([
          { method: "POST", path: "/sandboxes", confirm: null },
          { method: "PATCH", path: "/sandboxes/boat-new", confirm: null },
          { method: "DELETE", path: "/sandboxes/boat-new", confirm: "boat-new" },
        ]);
      },
    );
  });

  test("states() drops VMs deleted concurrently (404 or native deleted) and keeps the rest", async () => {
    const createdAt = new Date().toISOString();
    const labels = { vmbridge: "test" };
    const listed = [
      { id: "b-run", name: boatSdkName("k-run", labels), state: "ready", createdAt },
      { id: "b-404", name: boatSdkName("k-404", labels), state: "stopped", createdAt },
      { id: "b-del", name: boatSdkName("k-del", labels), state: "deleted", createdAt },
      { id: "b-stop", name: boatSdkName("k-stop", labels), state: "stopped", createdAt },
      { id: "b-wake", name: boatSdkName("k-wake", labels), state: "resuming", createdAt },
    ];
    const byId = new Map<string, { status: number; body: Record<string, unknown> }>([
      ["b-del", { status: 200, body: { sandbox: { id: "b-del", state: "deleted" } } }],
      ["b-stop", { status: 200, body: { sandbox: { id: "b-stop", state: "stopped" } } }],
      ["b-wake", { status: 200, body: { sandbox: { id: "b-wake", state: "resuming" } } }],
    ]);

    await withMockFetch(
      "BOAT_API_BASE",
      "https://boat.test",
      (request) => {
        const { pathname: path } = new URL(request.url);
        if (request.method === "GET" && path === "/sandboxes") {
          return Response.json({ sandboxes: listed, pageInfo: { hasMore: false } });
        }
        const match = path.match(/^\/sandboxes\/([^/]+)$/);
        if (request.method === "GET" && match) {
          const entry = byId.get(match[1] ?? "");
          if (!entry) return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
          return Response.json(entry.body, { status: entry.status });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
      async () => {
        const driver = boatProvider.open({ values: { apiKey: "boat_test" } });
        expect(await driver.states(labels)).toEqual(
          new Map([
            ["b-run", "running"],
            ["b-stop", "stopped"],
            ["b-wake", "running"],
          ]),
        );
      },
    );
  });
});

describe("Daytona cleanup and destroy resilience", () => {
  type QueuedResponse = { status: number; body: Record<string, unknown> };

  function makeHandler(
    requests: { method: string; path: string }[],
    getQueue: Map<string, QueuedResponse[]>,
    deleteQueue: Map<string, QueuedResponse[]>,
  ) {
    return (request: Request) => {
      const { pathname: path } = new URL(request.url);
      const { method } = request;
      requests.push({ method, path });

      if (method === "POST" && path === "/sandbox") {
        return Response.json({ id: "dtn-new", state: "creating" });
      }
      const match = path.match(/^\/sandbox\/([^/]+)$/);
      if (match) {
        const id = match[1] ?? "";
        if (method === "GET") {
          const next = getQueue.get(id)?.shift();
          if (!next) return Response.json({ message: "not found" }, { status: 404 });
          return Response.json(next.body, { status: next.status });
        }
        if (method === "DELETE") {
          const next = deleteQueue.get(id)?.shift();
          if (!next) return Response.json({});
          return Response.json(next.body, { status: next.status });
        }
      }
      return Response.json({ message: "not found" }, { status: 404 });
    };
  }

  test("create() cleans up via direct DELETE without calling connect", async () => {
    const requests: { method: string; path: string }[] = [];
    const getQueue = new Map<string, QueuedResponse[]>([
      ["dtn-new", [{ status: 200, body: { id: "dtn-new", state: "build_failed", errorReason: "boom" } }]],
    ]);
    const deleteQueue = new Map<string, QueuedResponse[]>([["dtn-new", [{ status: 200, body: {} }]]]);

    await withMockFetch("DAYTONA_API_URL", "https://daytona.test", makeHandler(requests, getQueue, deleteQueue), async () => {
      const driver = daytonaProvider.open({ values: { apiKey: "dtn_test" } });
      const input: CreateVm = { key: "vm-dtn-1", size: "medium", labels: { vmbridge: "test" }, ports: [3773] };

      await expect(driver.create(input)).rejects.toThrow("build_failed");
      expect(requests).toEqual([
        { method: "POST", path: "/sandbox" },
        { method: "GET", path: "/sandbox/dtn-new" },
        { method: "DELETE", path: "/sandbox/dtn-new" },
      ]);
    });
  });

  test("destroy() resolves cleanly on 409 when already destroyed/destroying, transitioning to destroyed, or 404 on retry", async () => {
    const requests: { method: string; path: string }[] = [];
    const getQueue = new Map<string, QueuedResponse[]>();
    const deleteQueue = new Map<string, QueuedResponse[]>();

    await withMockFetch("DAYTONA_API_URL", "https://daytona.test", makeHandler(requests, getQueue, deleteQueue), async () => {
      const driver = daytonaProvider.open({ values: { apiKey: "dtn_test" } });

      // Already destroyed on 409
      requests.length = 0;
      deleteQueue.set("d1", [{ status: 409, body: { message: "conflict" } }]);
      getQueue.set("d1", [{ status: 200, body: { id: "d1", state: "destroyed" } }]);
      await driver.destroy("d1");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d1" },
        { method: "GET", path: "/sandbox/d1" },
      ]);

      // Already destroying on 409
      requests.length = 0;
      deleteQueue.set("d2", [{ status: 409, body: { message: "conflict" } }]);
      getQueue.set("d2", [{ status: 200, body: { id: "d2", state: "destroying" } }]);
      await driver.destroy("d2");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d2" },
        { method: "GET", path: "/sandbox/d2" },
      ]);

      // Transitions from stopping -> destroyed while settling
      requests.length = 0;
      deleteQueue.set("d3", [{ status: 409, body: { message: "conflict" } }]);
      getQueue.set("d3", [
        { status: 200, body: { id: "d3", state: "stopping" } },
        { status: 200, body: { id: "d3", state: "stopping" } },
        { status: 200, body: { id: "d3", state: "destroyed" } },
      ]);
      await driver.destroy("d3");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d3" },
        { method: "GET", path: "/sandbox/d3" },
        { method: "GET", path: "/sandbox/d3" },
        { method: "GET", path: "/sandbox/d3" },
      ]);

      // Finishes archiving -> stopped, then retry DELETE returns 404
      requests.length = 0;
      deleteQueue.set("d4", [
        { status: 409, body: { message: "conflict" } },
        { status: 404, body: { message: "not found" } },
      ]);
      getQueue.set("d4", [
        { status: 200, body: { id: "d4", state: "archiving" } },
        { status: 200, body: { id: "d4", state: "stopped" } },
      ]);
      await driver.destroy("d4");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d4" },
        { method: "GET", path: "/sandbox/d4" },
        { method: "GET", path: "/sandbox/d4" },
        { method: "DELETE", path: "/sandbox/d4" },
      ]);

      // Real conflict on a non-settling, non-gone state still rejects
      requests.length = 0;
      deleteQueue.set("d5", [{ status: 409, body: { message: "conflict" } }]);
      getQueue.set("d5", [{ status: 200, body: { id: "d5", state: "started" } }]);
      await expect(driver.destroy("d5")).rejects.toBeInstanceOf(SandboxError);
    });
  });

  test("destroy() rethrows non-409 DELETE failures immediately without calling GET", async () => {
    const requests: { method: string; path: string }[] = [];
    const getQueue = new Map<string, QueuedResponse[]>([
      ["d-403", [{ status: 200, body: { id: "d-403", state: "destroying" } }]],
    ]);
    const deleteQueue = new Map<string, QueuedResponse[]>([
      ["d-403", [{ status: 403, body: { message: "forbidden" } }]],
    ]);

    await withMockFetch("DAYTONA_API_URL", "https://daytona.test", makeHandler(requests, getQueue, deleteQueue), async () => {
      const driver = daytonaProvider.open({ values: { apiKey: "dtn_test" } });
      const error = await driver.destroy("d-403").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SandboxError);
      expect(error).toMatchObject({ code: "auth", provider: "daytona" });
      expect((error as Error).message).toContain("HTTP 403");
      expect(requests).toEqual([{ method: "DELETE", path: "/sandbox/d-403" }]);
    });
  });

  test("destroy() handles retry 409 during concurrent deletion and rethrows if still active", async () => {
    const requests: { method: string; path: string }[] = [];
    const getQueue = new Map<string, QueuedResponse[]>();
    const deleteQueue = new Map<string, QueuedResponse[]>();

    await withMockFetch("DAYTONA_API_URL", "https://daytona.test", makeHandler(requests, getQueue, deleteQueue), async () => {
      const driver = daytonaProvider.open({ values: { apiKey: "dtn_test" } });

      // Retry 409 followed by GET -> destroying resolves cleanly
      requests.length = 0;
      deleteQueue.set("d-r1", [
        { status: 409, body: { message: "stopping" } },
        { status: 409, body: { message: "already destroying" } },
      ]);
      getQueue.set("d-r1", [
        { status: 200, body: { id: "d-r1", state: "stopping" } },
        { status: 200, body: { id: "d-r1", state: "stopped" } },
        { status: 200, body: { id: "d-r1", state: "destroying" } },
      ]);
      await driver.destroy("d-r1");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d-r1" },
        { method: "GET", path: "/sandbox/d-r1" },
        { method: "GET", path: "/sandbox/d-r1" },
        { method: "DELETE", path: "/sandbox/d-r1" },
        { method: "GET", path: "/sandbox/d-r1" },
      ]);

      // Retry 409 followed by GET -> 404 resolves cleanly
      requests.length = 0;
      deleteQueue.set("d-r2", [
        { status: 409, body: { message: "archiving" } },
        { status: 409, body: { message: "conflict" } },
      ]);
      getQueue.set("d-r2", [
        { status: 200, body: { id: "d-r2", state: "archiving" } },
        { status: 200, body: { id: "d-r2", state: "stopped" } },
        { status: 404, body: { message: "not found" } },
      ]);
      await driver.destroy("d-r2");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d-r2" },
        { method: "GET", path: "/sandbox/d-r2" },
        { method: "GET", path: "/sandbox/d-r2" },
        { method: "DELETE", path: "/sandbox/d-r2" },
        { method: "GET", path: "/sandbox/d-r2" },
      ]);

      // Retry 409 followed by GET -> started rejects with the retry 409 error
      requests.length = 0;
      deleteQueue.set("d-r3", [
        { status: 409, body: { message: "stopping" } },
        { status: 409, body: { message: "still busy" } },
      ]);
      getQueue.set("d-r3", [
        { status: 200, body: { id: "d-r3", state: "stopping" } },
        { status: 200, body: { id: "d-r3", state: "stopped" } },
        { status: 200, body: { id: "d-r3", state: "started" } },
      ]);
      const error = await driver.destroy("d-r3").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SandboxError);
      expect((error as Error).message).toContain("still busy");
      expect(requests).toEqual([
        { method: "DELETE", path: "/sandbox/d-r3" },
        { method: "GET", path: "/sandbox/d-r3" },
        { method: "GET", path: "/sandbox/d-r3" },
        { method: "DELETE", path: "/sandbox/d-r3" },
        { method: "GET", path: "/sandbox/d-r3" },
      ]);
    });
  });
});
