import type { Clients, Refusal } from "../auth/clients.ts";
import { clientSessionMs } from "../auth/clients.ts";
import { message } from "../fleet.ts";
import type { Frame } from "../vm/backend.ts";
import type { WatchUpgrade } from "../watch/watch.ts";
import { assetPrefix, bridgeAssetUrl, heldOwner, relayedAsset, uploadPrefix } from "./attachments.ts";
import { bridgeAuth, bridgeScopes, type Hub } from "./hub.ts";
import { iconOwner, keptIconHeaders } from "./icons.ts";
import { previewQuery, previewRelay, previewStreamPath } from "./preview.ts";
import type { Rpc, RpcClient } from "./rpc.ts";
import { historyPage, latestOrdinal } from "./saved.ts";
import type { Projection, Wire } from "./types.ts";

export interface SocketData {
  clientId: string;
  cancels: Map<string, () => void>;
}

/** A connected T3 client: Bun's ServerWebSocket, or a Worker's WebSocket with its data beside it. */
export interface ClientSocket {
  readonly data: SocketData;
  readonly readyState: number;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

/**
 * Accepts a `/ws` upgrade with `data` for the new socket, which then reports to `opened`, `received` and `closed`.
 * Returns the response to send, undefined when the runtime answers the upgrade itself (Bun), or null when the request
 * is not a WebSocket upgrade.
 */
export type Upgrade = (request: Request, data: SocketData) => Response | undefined | null;

const open = 1;

const json = (value: unknown, status = 200) => Response.json(value, { status });
const notFound = () => new Response("Not Found", { status: 404 });
const unauthenticated = () => json({ code: "auth_invalid", reason: "invalid_credential", traceId: crypto.randomUUID() }, 401);

/** The RFC 8693 exchange that trades a pairing link's token for a bearer token. */
export const tokenExchange = {
  grant: "urn:ietf:params:oauth:grant-type:token-exchange",
  subject: "urn:t3:params:oauth:token-type:environment-bootstrap",
  requested: "urn:ietf:params:oauth:token-type:access_token",
};

/** What a request turned out to be, for the log: the device it came from, or why it was refused or failed. */
interface Seen {
  clientId?: string;
  refusal?: Refusal;
  failure?: string;
}

const knownPaths = new Set(["/ws", "/oauth/token", "/.well-known/t3/environment", "/api/auth/session", "/api/orchestration/shell", "/api/projects", previewStreamPath]);

/**
 * A path as the log shows it. Ids are folded, and an upload or asset URL's token, which is what lets anyone send or
 * read the file, never shows. With `known`, a path VM Bridge does not serve is not shown at all: anyone can send one.
 */
export function logPath(path: string, known = false) {
  if (path.startsWith(uploadPrefix)) return `${uploadPrefix}:token`;
  if (bridgeAssetUrl.test(path)) return `${assetPrefix}:file`;
  const shown = path.replace(/\/threads\/[^/]+/, "/threads/:id");
  if (!known) return shown;
  if (knownPaths.has(shown) || /^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/.test(shown)) return shown;
  return /^\/api\/orchestration\/threads\/:id(?:\/(bounded|history|transcript))?$/.test(shown) ? shown : "an unknown path";
}

/** A WebSocket close code in plain words, with the reason the closing side gave. */
export function closeText(code: number, reason: string) {
  const words: Record<number, string> = { 1000: "closed normally", 1001: "going away", 1005: "no reason given", 1006: "connection lost", 1011: "server error" };
  return [`code ${code}`, reason || words[code]].filter(Boolean).join(", ");
}

/** A header the dashboard's connection test sends, so its reads do not count as T3 clients trying to connect. */
export const connectionTestHeader = "x-vmbridge-connection-test";
/** How long after reading the environment a T3 client that can connect has opened its WebSocket. */
const connectFollowMs = 30_000;
/** Reads with no WebSocket after them, within `connectTroubleWindowMs`, that mean clients reach VM Bridge but cannot connect. */
const connectTroubleReads = 5;
const connectTroubleWindowMs = 10 * 60_000;

/** Paths a T3 client uses. Everything else belongs to the dashboard. */
export const isT3Path = (path: string) => path === "/ws" || path === "/oauth/token" || path.startsWith("/api/") || path.startsWith("/.well-known/t3/");

/**
 * The T3 server surface VM Bridge exposes: pairing, bearer sessions, the RPC WebSocket, and the
 * few HTTP reads T3 makes outside RPC. T3 routes use bearer tokens only, never cookies, so any
 * origin may call them; the hosted and desktop T3 apps come from origins VM Bridge cannot list.
 */
export class T3Gateway {
  private readonly sockets = new Set<ClientSocket>();
  /** Open preview streams, which end with their device's access like its RPC sockets. */
  private readonly streams = new Set<{ clientId: string; end: (code: number, reason: string) => void }>();
  private readonly expiry: ReturnType<typeof setInterval>;
  /**
   * When T3 clients read the environment since a WebSocket last opened. A client reads it before every connect, so
   * reads that no WebSocket follows are clients that reach VM Bridge but fail to connect, as when a browser refuses
   * the answers. Such a client sends no credential before failing, so this cannot say which device it is.
   */
  private unfollowedReads: number[] = [];
  private troubleCheck?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly hub: Hub,
    private readonly rpc: Rpc,
    private readonly clients: Clients,
    /** `vmbridge opencode`, which opens OpenCode in a new worktree and removes it after (see opencode-launch.ts). */
    private readonly openCodeWorktrees?: (request: Request) => Promise<Response>,
  ) {
    this.expiry = setInterval(() => {
      for (const socket of this.sockets) if (!clients.valid(socket.data.clientId)) socket.close(1008, "Session expired");
      for (const stream of this.streams) if (!clients.valid(stream.clientId)) stream.end(1008, "Session expired");
    }, 30_000);
  }

  /** T3 clients that keep reaching VM Bridge without connecting: how many tries, since when. Null when none. */
  connectTrouble(now = Date.now()): { since: number; reads: number } | null {
    const failed = this.unfollowedReads.filter((at) => now - at >= connectFollowMs && now - at <= connectTroubleWindowMs);
    return failed.length >= connectTroubleReads ? { since: failed[0]!, reads: failed.length } : null;
  }

  private noteEnvironmentRead() {
    const now = Date.now();
    this.unfollowedReads = [...this.unfollowedReads.filter((at) => now - at <= connectTroubleWindowMs), now];
    // The dashboard follows fleet changes; it hears once the read has had its time to be followed.
    if (this.troubleCheck) return;
    this.troubleCheck = setTimeout(() => {
      this.troubleCheck = undefined;
      this.hub.fleet.emit("changed");
    }, connectFollowMs + 1_000);
    this.troubleCheck.unref?.();
  }

  connected(): Set<string> {
    return new Set([...this.sockets].map((socket) => socket.data.clientId));
  }

  /** Ends a revoked device's open connections. */
  disconnect(clientId: string) {
    for (const socket of this.sockets) if (socket.data.clientId === clientId) socket.close(1008, "Device removed");
    for (const stream of this.streams) if (stream.clientId === clientId) stream.end(1008, "Device removed");
  }

  /** `upgrade` accepts the RPC WebSocket, and `relay` a preview tab's stream. */
  async fetch(request: Request, upgrade: Upgrade, relay: WatchUpgrade): Promise<Response | undefined> {
    const origin = request.headers.get("origin");
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const seen: Seen = {};
    const response = await this.route(request, upgrade, relay, seen).catch((error) => {
      seen.failure = message(error);
      return json({ error: "bridge_unavailable", message: seen.failure }, 503);
    });
    if (!response) return undefined;
    // T3's desktop app strips `Origin` from its requests but its renderer still checks the answer, so a request with no
    // `Origin` gets the wildcard, as T3's own server sends. Nothing here is sent with cookies, so `*` is enough.
    response.headers.set("access-control-allow-origin", origin ?? "*");
    response.headers.set("vary", "Origin");
    // Assets keep the caching T3 gives them: their URLs are signed anew for each new copy.
    if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
    if (!seen.clientId) {
      // Anyone can send these, so failures are only counted, by path and reason. Pairing logs itself; discovery and
      // preflights are not worth a line. A session check with a bad token answers 200 but is still a refusal.
      if (seen.refusal || !response.ok) {
        const reason = seen.refusal?.reason ?? seen.failure ?? `HTTP ${response.status}`;
        this.hub.traffic.refused({ path: logPath(path, true), reason, ...(seen.refusal?.clientId ? { clientId: seen.refusal.clientId } : {}) });
      }
    } else if (path !== "/api/auth/session") {
      this.hub.traffic.record({
        kind: "http",
        operation: `${request.method} ${logPath(path)}`,
        clientId: seen.clientId,
        status: response.ok ? "ok" : "error",
        ...(response.ok ? {} : { reason: seen.failure ?? `HTTP ${response.status}` }),
        durationMs: Math.round(performance.now() - started),
      });
    }
    return response;
  }

  private async route(request: Request, upgrade: Upgrade, relay: WatchUpgrade, seen: Seen): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-t3-orchestration-protocol, b3, traceparent, dpop",
        },
      });
    }
    if (path === "/.well-known/t3/environment" && request.method === "GET") {
      if (!request.headers.has(connectionTestHeader)) this.noteEnvironmentRead();
      return json(this.hub.descriptor());
    }
    if (path === "/oauth/token" && request.method === "POST") return this.exchange(request, seen);
    if (path === "/ws") {
      if (url.searchParams.get("orchestrationProtocol") !== "2") {
        seen.refusal = { reason: `T3 protocol ${url.searchParams.get("orchestrationProtocol") ?? "missing"}, not 2` };
        return json({ code: "orchestration_protocol_incompatible", orchestrationProtocolVersion: 2 }, 426);
      }
      const redeemed = this.clients.redeemTicket(url.searchParams.get("wsTicket") ?? "");
      if ("refused" in redeemed) {
        seen.refusal = redeemed.refused;
        return unauthenticated();
      }
      const upgraded = upgrade(request, { clientId: redeemed.clientId, cancels: new Map() });
      if (upgraded !== null) return upgraded;
      seen.refusal = { reason: "not a WebSocket upgrade", clientId: redeemed.clientId };
      return json({ error: "websocket_required" }, 400);
    }
    if (path === previewStreamPath) return this.previewStream(request, url, relay, seen);
    // Signed URLs, as on T3: the token in the path is the credential, and clients send no bearer with them.
    if (path.startsWith(uploadPrefix) && request.method === "POST") return this.upload(request, path.slice(uploadPrefix.length), seen);
    const asset = bridgeAssetUrl.exec(path);
    if (asset && (request.method === "GET" || request.method === "HEAD")) {
      const response = await this.asset(request, asset[1]!, asset[2]!, asset[3]!);
      if (response.status === 404) seen.refusal = { reason: "unknown or expired file link" };
      return response;
    }

    const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const client = bearer ? this.clients.authenticate(bearer) : null;
    if (bearer && !client) seen.refusal = this.clients.refusal(bearer);
    if (path === "/api/auth/session") {
      return json({
        authenticated: Boolean(client),
        auth: bridgeAuth,
        ...(client
          ? {
              scopes: bridgeScopes,
              permissions: bridgeScopes,
              sessionMethod: "bearer-access-token",
              expiresAt: new Date(client.expiresAt).toISOString(),
            }
          : {}),
      });
    }
    if (!client) {
      seen.refusal ??= { reason: "no token" };
      return unauthenticated();
    }
    seen.clientId = client.id;

    const ticketFor = /^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/.exec(path);
    if (ticketFor && request.method === "POST") {
      const { ticket, expiresAt } = this.clients.ticket(client.id, ticketFor[1] === "media" ? "media" : "rpc");
      return json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (path === "/api/vmbridge/opencode" && this.openCodeWorktrees) return this.openCodeWorktrees(request);
    if (path === "/api/orchestration/shell" && request.method === "GET") return json(this.hub.shell());
    if (path === "/api/projects" && request.method === "GET") {
      const projects = (this.hub.shell().projects ?? []).map((project) => ({ ...project, deletedAt: null }));
      return json({ projects, updatedAt: new Date().toISOString() });
    }
    const thread = /^\/api\/orchestration\/threads\/([^/]+)(?:\/(bounded|history|transcript))?$/.exec(path);
    if (thread && request.method === "GET") return this.thread(decodeURIComponent(thread[1]!), thread[2], url);
    seen.failure = "not a route VM Bridge serves";
    return json({ error: "unsupported_bridge_route" }, 404);
  }

  /**
   * A preview tab's stream, relayed to the T3 server on the VM that owns the tab's thread and no other: a tab exists
   * only on its thread's VM. A VM that is not awake has no tabs, which the client hears as a closed tab.
   */
  private previewStream(request: Request, url: URL, relay: WatchUpgrade, seen: Seen) {
    const redeemed = this.clients.redeemTicket(url.searchParams.get("wsTicket") ?? "", "media");
    if ("refused" in redeemed) {
      seen.refusal = redeemed.refused;
      return unauthenticated();
    }
    const { clientId } = redeemed;
    const query = previewQuery(url);
    const stream = {
      clientId,
      ...previewRelay(
        async () => {
          const vmId = this.hub.store.threadVm(query.get("threadId") ?? "");
          const backend = vmId ? this.hub.fleet.backend(vmId) : undefined;
          return backend ? backend.media(previewStreamPath, query) : null;
        },
        () => this.streams.delete(stream),
      ),
    };
    this.streams.add(stream);
    const upgraded = relay(request, stream.viewer);
    if (upgraded !== null) return upgraded;
    this.streams.delete(stream);
    seen.refusal = { reason: "not a WebSocket upgrade", clientId };
    return json({ error: "websocket_required" }, 400);
  }

  private async upload(request: Request, token: string, seen: Seen) {
    const { status, clientId } = await this.hub.attachments.receive(token, request);
    if (clientId) seen.clientId = clientId;
    if (status === 204) return new Response(null, { status });
    if (status === 400) {
      seen.failure = "upload not the size announced";
      return new Response("The upload is not the size it was announced as.", { status });
    }
    seen.refusal = { reason: "unknown or expired upload link" };
    return notFound();
  }

  /**
   * An asset, from the VM that signed its URL. A VM that is not awake is not woken for it, and the client shows the
   * asset as missing. An upload VM Bridge still holds is served from here, as a download unless it is an image, and
   * so is a project logo it kept.
   */
  private async asset(request: Request, owner: string, token: string, name: string) {
    if (owner === iconOwner) {
      const file = this.hub.icons.file(token);
      if (!file) return notFound();
      return new Response(request.method === "HEAD" ? null : file, { headers: keptIconHeaders(file.type) });
    }
    if (owner === heldOwner) {
      const file = this.hub.attachments.file(token);
      if (!file) return notFound();
      const image = /^image\/(?:png|jpeg|gif|webp)$/i.test(file.upload.mimeType);
      return new Response(request.method === "HEAD" ? null : file.body, {
        headers: {
          "content-type": image ? file.upload.mimeType : "application/octet-stream",
          ...(image ? {} : { "content-disposition": "attachment" }),
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    }
    // The link is unauthenticated and the VM is asked with VM Bridge's own token, so it must name a file under
    // /api/assets/ and nothing else: a token or name of `..` (or `%2e%2e`) would otherwise reach any T3 route.
    const upstreamPath = `${assetPrefix}${token}/${name}`;
    if (new URL(upstreamPath, "http://vm").pathname !== upstreamPath) return notFound();
    const backend = this.hub.store.vm(owner) ? this.hub.fleet.backend(owner) : undefined;
    if (!backend) return notFound();
    const headers = new Headers();
    for (const header of ["range", "if-range"]) {
      const value = request.headers.get(header);
      if (value !== null) headers.set(header, value);
    }
    const upstream = await backend.http(upstreamPath, { method: request.method, headers, signal: AbortSignal.timeout(10 * 60_000) });
    return relayedAsset(upstream);
  }

  private async exchange(request: Request, seen: Seen) {
    const body = new URLSearchParams(await request.text());
    if (
      body.get("grant_type") !== tokenExchange.grant ||
      body.get("subject_token_type") !== tokenExchange.subject ||
      body.get("requested_token_type") !== tokenExchange.requested
    ) {
      seen.refusal = { reason: "unsupported pairing request" };
      return json({ error: "unsupported_grant_type" }, 400);
    }
    const access = this.clients.exchange(body.get("subject_token") ?? "");
    if (!access) {
      seen.refusal = { reason: "unknown, used or expired pairing link" };
      return json({ error: "invalid_grant" }, 400);
    }
    this.hub.traffic.record({ kind: "system", operation: "Device paired" });
    // The dashboard's device list follows fleet changes.
    this.hub.fleet.emit("changed");
    return json({
      access_token: access,
      issued_token_type: tokenExchange.requested,
      token_type: "Bearer",
      expires_in: clientSessionMs / 1000,
      scope: bridgeScopes.join(" "),
    });
  }

  /**
   * Thread reads: from the VM when it is awake, from the saved copy of the thread while it sleeps. The copy is the
   * whole history, so the bounded snapshot is all of it, and a history page is for a cursor the VM gave while awake.
   */
  private async thread(threadId: string, view: string | undefined, url: URL) {
    const vmId = await this.hub.routeSoon({ threadId });
    const backend = this.hub.fleet.backend(vmId);
    if (!backend) {
      // The copied transcript leaves out the waking notice, which is not part of the thread.
      const cached = view === "transcript" ? this.hub.store.projection<Projection>(threadId, vmId) : this.hub.sleepingProjection(threadId, vmId);
      if (!cached) return json({ error: "vm_sleeping_no_snapshot" }, 503);
      const projection = this.hub.out(cached, vmId) as Projection;
      const snapshotSequence = this.hub.shellSequence(vmId);
      if (view === "transcript") {
        return json({ threadId, title: projection.thread?.title, updatedAt: projection.updatedAt, items: projection.visibleTurnItems ?? [] });
      }
      if (view === "history") {
        const page = historyPage(projection, url.searchParams, snapshotSequence);
        return page ? json(page) : json({ error: "invalid_history_cursor" }, 400);
      }
      return json({ projection, snapshotSequence, historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: latestOrdinal(projection) });
    }
    // VM Bridge caches plain projections, so ask the VM for the uncompacted form.
    const query = new URLSearchParams(url.search);
    for (const key of ["compactIds", "compactTurnItems", "dedupeBodies"]) query.delete(key);
    const upstream = await backend.http(`${url.pathname}?${query}`);
    const value = (await upstream.json()) as Wire;
    if (upstream.ok && !view && !value.hasMoreHistory && value.projection) this.hub.cacheProjection(threadId, vmId, value.projection);
    return json(this.hub.out(value, vmId), upstream.status);
  }

  opened(socket: ClientSocket) {
    this.sockets.add(socket);
    this.unfollowedReads = [];
    this.clients.markConnected(socket.data.clientId, true);
    this.hub.traffic.record({ kind: "system", operation: "Device connected", clientId: socket.data.clientId });
    this.hub.fleet.emit("changed");
  }

  received(socket: ClientSocket, raw: string) {
    if (!this.clients.valid(socket.data.clientId)) return socket.close(1008, "Session expired");
    this.clients.markConnected(socket.data.clientId);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return socket.close(1008, "Invalid JSON");
    }
    const client: RpcClient = {
      clientId: socket.data.clientId,
      cancels: socket.data.cancels,
      send: (frame) => {
        if (socket.readyState === open) socket.send(JSON.stringify(frame));
      },
      open: () => socket.readyState === open && this.clients.valid(socket.data.clientId),
    };
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      this.rpc.handle(client, frame as Frame).catch(() => socket.close(1008, "Invalid RPC message"));
    }
  }

  /** `code` and `reason` are the WebSocket close frame's, or 1006 and nothing when the connection just dropped. */
  closed(socket: ClientSocket, code: number, reason: string) {
    this.sockets.delete(socket);
    this.clients.markConnected(socket.data.clientId, true);
    this.hub.traffic.record({ kind: "system", operation: "Device disconnected", clientId: socket.data.clientId, reason: closeText(code, reason) });
    for (const cancel of socket.data.cancels.values()) cancel();
    socket.data.cancels.clear();
    this.hub.fleet.emit("changed");
  }

  /** Ends every connection as VM Bridge stops: 1012 (service restart) when another VM Bridge starts right after, 1001 (going away) otherwise. */
  close(restarting = false) {
    clearInterval(this.expiry);
    clearTimeout(this.troubleCheck);
    const [code, reason] = restarting ? [1012, "VM Bridge is restarting"] : [1001, "VM Bridge stopped"];
    // Written now: the sockets' close events may not run before the process ends.
    for (const socket of this.sockets) {
      this.clients.markConnected(socket.data.clientId, true);
      socket.close(code, reason);
    }
    for (const stream of this.streams) stream.end(code, reason);
  }
}
