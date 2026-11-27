import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BudgetReached } from "../budget.ts";
import { message, NoProvider, type Fleet } from "../fleet.ts";
import { primaryVm, type Store } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import { cliVersion, NoOpenCodeKey, OpenCodeUnreachable, type OpenCodeServer } from "../vm/opencode.ts";
import type { Viewer, WatchUpgrade } from "../watch/watch.ts";
import { previewRelay } from "./preview.ts";

/**
 * Each project's OpenCode address is VM Bridge's own with this and the project's ID after it. OpenCode's clients keep
 * the path of the address they are given, except `opencode api`, which asks from the root: those requests are known by
 * their password instead.
 */
export const openCodePrefix = "/opencode/";

const retryAfterSeconds = 10;
/**
 * OpenCode's clients check a server with `GET /api/info` and give up after about 5 seconds, which a sleeping VM never
 * makes. Past this, VM Bridge answers for it while the VM wakes. The client's next requests wait for the VM, and it asks
 * again once the VM is up.
 */
const infoWaitMs = 3_000;
const wakingInfo = () =>
  Response.json(
    { version: cliVersion, pid: 0, hostname: "VM Bridge", urls: [], paths: { tmp: "/tmp/opencode" }, capabilities: { persistentPty: true } },
    { headers: { "cache-control": "no-store" } },
  );
/** Typing in a terminal counts as activity, but the VM's row is written at most this often for it. */
const touchEveryMs = 10_000;

/** OpenCode's WebSockets that take a one-use ticket from an earlier request, as browsers cannot send a password. */
const ticketed = [
  /^\/api\/pty\/[\w-]+\/connect$/,
  /^\/api\/experimental\/persistent-pty\/[\w-]+\/connect$/,
  /^\/api\/experimental\/client-mcp$/,
];

/** As `opencode pair`'s codes: one use, for ten minutes. */
const pairingMs = 10 * 60_000;
/**
 * Where OpenCode's clients trade a pairing code for a password. VM Bridge answers it, at the root too: OpenCode's phone
 * app takes only an address without a path, and the code says which project it is for.
 */
const connectPath = /^\/auth\/connect\/([^/]+)$/;

/** Pairing on the VM would hand out a credential for its own server, which only VM Bridge holds. */
const blocked = (path: string) => path === "/api/pair" || path.startsWith("/api/pair/") || path.startsWith("/auth/");

/**
 * Not sent on to the VM: credentials are VM Bridge's to check and the VM's to get, hop-by-hop headers belong to this
 * connection, and the VM answers uncompressed so nothing here has to tell a decoded body from its encoding.
 */
const droppedRequestHeaders = [
  "authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
];
/** A cookie from the VM's server would be its credential. The rest describe the VM's connection, not this one. */
const droppedResponseHeaders = ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"];

/** The password a stock OpenCode client sends: in Basic auth, or in `auth_token` (base64 of user:password) where it cannot set headers. */
export function givenPassword(request: Request, url: URL): string | null {
  const encoded = request.headers.get("authorization")?.match(/^Basic\s+(\S+)$/i)?.[1] ?? url.searchParams.get("auth_token");
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

const atRoot = (path: string) => path === "/openapi.json" || path.startsWith("/api/");

/**
 * Requests for OpenCode: under a project's address, a pairing code at the root, or at the root with a password, which
 * T3's clients never send.
 */
export function isOpenCodeRequest(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith(openCodePrefix) || connectPath.test(url.pathname)) return true;
  return atRoot(url.pathname) && givenPassword(request, url) !== null;
}

const digest = (text: string) => createHash("sha256").update(text).digest();
const same = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

const problem = (status: number, text: string, headers: Record<string, string> = {}) =>
  Response.json({ message: text }, { status, headers });
const notFound = () => problem(404, "Not found");
const tryAgain = (text: string) => problem(503, text, { "retry-after": String(retryAfterSeconds) });

/** As OpenCode's own server answers, so clients ask for the password the same way. */
function unauthorized(request: Request) {
  const headers = new Headers();
  const mode = request.headers.get("sec-fetch-mode");
  if (!mode || mode === "navigate") headers.set("www-authenticate", 'Basic realm="Secure Area"');
  return Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401, headers });
}

/** Every request needs the password, so a preflight can be answered for any origin. OpenCode's answers say who may read them. */
function preflight(request: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": request.headers.get("origin") ?? "*",
      "access-control-allow-methods": request.headers.get("access-control-request-method") ?? "GET, POST, PUT, PATCH, DELETE",
      "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "authorization, content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}

/** Resolves to null when `promise` takes longer than `ms`. It keeps running, and a late failure is not unhandled. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A path as the log shows it, with OpenCode's IDs, such as ses_..., folded. */
const logPath = (path: string) => path.replace(/\/[a-z]{2,4}_[\w-]+/g, "/:id");

interface Seen {
  vmId?: string;
  refusal?: string;
  failure?: string;
}

/**
 * OpenCode's server on each project's VM, for stock OpenCode clients. VM Bridge checks the project's own password, wakes
 * the VM, starts OpenCode there, and signs in to it with the VM's password, which never leaves VM Bridge. HTTP, the
 * event stream and WebSockets pass through as OpenCode sends them.
 */
export class OpenCodeGateway {
  /** Aborted as a VM goes offline, ending every request and event stream open to its OpenCode. */
  private readonly ends = new Map<string, AbortController>();
  private readonly relays = new Set<{ vmId: string; end: (code: number, reason: string) => void }>();
  private readonly touched = new Map<string, number>();
  private readonly pairings = new Map<string, { projectId: string; expires: number }>();

  constructor(
    private readonly store: Store,
    private readonly fleet: Fleet,
    private readonly traffic: Traffic,
    /** Whether VM Bridge has an OpenCode key to give VMs. OpenCode is not started without one. */
    private readonly hasKey: () => boolean,
    /**
     * How long a request waits for its VM to wake and OpenCode to start before it is told to try again. OpenCode's
     * clients wait as long as it takes, so this is just under the 100 seconds Cloudflare's tunnel waits for an answer.
     */
    private readonly wakeWaitMs = 90_000,
  ) {
    fleet.on("offline", (vmId) => this.end(vmId, "The VM went to sleep"));
  }

  private end(vmId: string, reason: string) {
    this.ends.get(vmId)?.abort();
    this.ends.delete(vmId);
    for (const relay of this.relays) if (relay.vmId === vmId) relay.end(1001, reason);
  }

  private endSignal(vmId: string) {
    let controller = this.ends.get(vmId);
    if (!controller) {
      controller = new AbortController();
      this.ends.set(vmId, controller);
    }
    return controller.signal;
  }

  /** Ends a project's open OpenCode connections, as after its password changed. */
  disconnect(projectId: string) {
    const project = this.store.project(projectId);
    const vmId = project && primaryVm(project)?.vmId;
    if (vmId) this.end(vmId, "The password changed");
    for (const [code, pairing] of this.pairings) if (pairing.projectId === projectId) this.pairings.delete(code);
  }

  /** A code an OpenCode client trades once, at the project's address, for its password, as a scanned `opencode pair` QR code does. */
  pairingCode(projectId: string) {
    const now = Date.now();
    for (const [code, pairing] of this.pairings) if (pairing.expires <= now) this.pairings.delete(code);
    const code = randomBytes(16).toString("base64url");
    this.pairings.set(code, { projectId, expires: now + pairingMs });
    return { code, expiresInSeconds: pairingMs / 1000 };
  }

  /**
   * Answers as OpenCode's own server does for a client that wants JSON. The client asks from any origin, as a web app.
   * At a project's address the code must be that project's; at the root (`projectId` null) it names the project.
   */
  private redeem(request: Request, projectId: string | null, code: string, seen: Seen) {
    const pairing = this.pairings.get(code);
    const valid = pairing && (projectId === null || pairing.projectId === projectId) && pairing.expires > Date.now();
    const password = valid ? this.store.openCodePassword(pairing.projectId) : null;
    const headers = { "access-control-allow-origin": request.headers.get("origin") ?? "*", "cache-control": "no-store", vary: "Origin" };
    if (!password) {
      seen.refusal = "expired pairing code";
      return Response.json({ _tag: "UnauthorizedError", message: "Pairing link expired or already used" }, { status: 401, headers });
    }
    this.pairings.delete(code);
    return Response.json({ token: password }, { headers });
  }

  private touch(vmId: string) {
    const now = Date.now();
    if (now - (this.touched.get(vmId) ?? 0) < touchEveryMs) return;
    this.touched.set(vmId, now);
    this.fleet.touch(vmId, now);
  }

  /** `relay` accepts a WebSocket upgrade, such as a terminal's. */
  async fetch(request: Request, relay: WatchUpgrade): Promise<Response | undefined> {
    const started = performance.now();
    const seen: Seen = {};
    const response = await this.route(request, relay, seen).catch((error: unknown) => {
      seen.failure = message(error);
      // These say what to change in VM Bridge. Any other error goes out as a fixed text, as a provider's or the VM's
      // own could name the VM's address.
      if (error instanceof NoOpenCodeKey || error instanceof BudgetReached || error instanceof NoProvider) return problem(503, error.message);
      return problem(502, "VM Bridge could not reach OpenCode on this project's VM.");
    });
    const path = logPath(this.target(new URL(request.url))?.path.split("?")[0] ?? "/");
    if (seen.refusal) this.traffic.refused({ path: `OpenCode ${path}`, reason: seen.refusal });
    else if (seen.vmId) {
      const ok = !response || response.status < 400;
      this.traffic.record({
        kind: "http",
        operation: `OpenCode ${request.method} ${path}`,
        vmId: seen.vmId,
        status: ok ? "ok" : "error",
        ...(ok ? {} : { reason: seen.failure ?? `HTTP ${response.status}` }),
        durationMs: Math.round(performance.now() - started),
      });
    }
    return response;
  }

  /** The project a request names in its path, if any, and the path and query to ask the VM, without the password. */
  private target(url: URL): { projectId: string | null; path: string } | null {
    let projectId: string | null = null;
    let path = url.pathname;
    if (path.startsWith(openCodePrefix)) {
      const rest = path.slice(openCodePrefix.length);
      const slash = rest.indexOf("/");
      projectId = slash < 0 ? rest : rest.slice(0, slash);
      path = slash < 0 ? "/" : rest.slice(slash);
      if (!projectId) return null;
    } else if (!atRoot(path) && !connectPath.test(path)) return null;
    const query = new URLSearchParams(url.search);
    query.delete("auth_token");
    const search = query.toString();
    return { projectId, path: search ? `${path}?${search}` : path };
  }

  private accepts(projectId: string, password: string | null) {
    const expected = this.store.openCodePassword(projectId);
    return password !== null && expected !== null && same(password, expected);
  }

  private projectFor(password: string) {
    return this.store.projects().find((project) => this.accepts(project.id, password));
  }

  private async route(request: Request, relay: WatchUpgrade, seen: Seen): Promise<Response | undefined> {
    if (request.method === "OPTIONS") return preflight(request);
    const url = new URL(request.url);
    const target = this.target(url);
    if (!target) return notFound();
    const pathname = target.path.split("?")[0]!;
    // `..` in any spelling, `%2e%2e` too, or a second `//`, would leave the path VM Bridge checked.
    if (new URL(pathname, "http://vm").pathname !== pathname) return notFound();
    const code = request.method === "GET" ? connectPath.exec(pathname)?.[1] : undefined;
    if (code) return this.redeem(request, target.projectId, code, seen);
    if (blocked(pathname)) return notFound();

    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const password = givenPassword(request, url);
    let project = target.projectId === null ? undefined : (this.store.project(target.projectId) ?? undefined);
    let signedIn = false;
    if (password !== null) {
      if (target.projectId === null) project = this.projectFor(password);
      signedIn = Boolean(project && this.accepts(project.id, password));
    }
    const withTicket = upgrade && url.searchParams.has("ticket") && ticketed.some((pattern) => pattern.test(pathname));
    // An unknown project gets the same answer as a wrong password.
    if (!project || (!signedIn && !withTicket)) {
      seen.refusal = password === null ? "no password" : "wrong password";
      return unauthorized(request);
    }
    if (!this.hasKey()) return problem(503, new NoOpenCodeKey().message);

    // Neither wakes a sleeping VM: a ticket comes from a VM that was awake, and an idle client reopens its event stream
    // on its own, which would wake the VM again each time it slept.
    const waking = signedIn && !(request.method === "GET" && pathname === "/api/event");
    const primary = primaryVm(project)?.vmId;
    let ready: Promise<{ vmId: string; server: OpenCodeServer }>;
    if (waking) ready = this.wake(project.id);
    else if (primary && this.fleet.backend(primary)) ready = this.fleet.opencode(primary).then((server) => ({ vmId: primary, server }));
    else return tryAgain("This project's VM is asleep. Send a request to wake it.");
    const info = waking && request.method === "GET" && pathname === "/api/info";
    const found = await within(ready, info ? Math.min(infoWaitMs, this.wakeWaitMs) : this.wakeWaitMs);
    if (!found) return info ? wakingInfo() : tryAgain("This project's VM is waking. Try again in a moment.");
    // A new password while this waited ended only the connections open then, so this one is checked again.
    if (signedIn && !this.accepts(project.id, password)) {
      seen.refusal = "wrong password";
      return unauthorized(request);
    }
    const { vmId, server } = found;
    seen.vmId = vmId;
    if (upgrade) return this.socket(request, relay, vmId, server, target.path, seen);
    return this.forward(request, vmId, server, target.path, seen);
  }

  /** Wakes the project's VM, making it one if it has none, and starts OpenCode there. */
  private async wake(projectId: string) {
    const vmId = await this.fleet.place(projectId);
    await this.fleet.ensure(vmId);
    return { vmId, server: await this.fleet.opencode(vmId) };
  }

  private async forward(request: Request, vmId: string, server: OpenCodeServer, path: string, seen: Seen) {
    const headers = new Headers(request.headers);
    for (const name of droppedRequestHeaders) headers.delete(name);
    headers.set("accept-encoding", "identity");
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
    // Held awake until OpenCode answers. An event stream after that counts only as its requests do.
    const release = this.fleet.lease(vmId);
    let upstream: Response;
    try {
      upstream = await server.fetch(path, {
        method: request.method,
        headers,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
        signal: AbortSignal.any([request.signal, this.endSignal(vmId)]),
      });
    } catch (error) {
      if (error instanceof OpenCodeUnreachable) this.fleet.forgetOpenCode(vmId, server);
      throw error;
    } finally {
      release();
    }
    if (upstream.status === 401) {
      // The VM's server has another password than VM Bridge gave it. The next request starts it with VM Bridge's.
      this.fleet.forgetOpenCode(vmId, server);
      await upstream.body?.cancel();
      seen.failure = "OpenCode on the VM refused VM Bridge's password";
      return problem(502, "VM Bridge could not sign in to OpenCode on this project's VM. Try again.");
    }
    const answer = new Headers(upstream.headers);
    for (const name of droppedResponseHeaders) answer.delete(name);
    if (!answer.has("cache-control")) answer.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: answer });
  }

  private socket(request: Request, relay: WatchUpgrade, vmId: string, server: OpenCodeServer, path: string, seen: Seen) {
    const stream = {
      vmId,
      ...previewRelay(
        () =>
          server.socket(path).catch((error: unknown) => {
            if (error instanceof OpenCodeUnreachable) this.fleet.forgetOpenCode(vmId, server);
            throw error;
          }),
        () => this.relays.delete(stream),
      ),
    };
    const viewer: Viewer = {
      ...stream.viewer,
      received: (data) => {
        this.touch(vmId);
        stream.viewer.received(data);
      },
    };
    this.relays.add(stream);
    const upgraded = relay(request, viewer);
    if (upgraded !== null) return upgraded;
    this.relays.delete(stream);
    seen.failure = "not a WebSocket upgrade";
    return problem(400, "Send a WebSocket upgrade.");
  }
}
