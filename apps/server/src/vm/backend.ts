import type { Preview } from "@opencoredev/sandbox-sdk";
import type { OpenSocket } from "../runtime.ts";

/** One Effect RPC frame. VM Bridge forwards T3's payloads without modelling them. */
export type Frame = { _tag: string; [key: string]: unknown };

export interface Exit extends Frame {
  _tag: "Exit";
  requestId: string;
  exit: { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };
}

const disconnected = (requestId: string): Exit => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "The VM disconnected. Retry once it is back." }] },
});

/** `path`, with any query, on a VM's preview. */
export function previewTarget(preview: Preview, path: string) {
  const base = new URL(preview.url);
  const url = new URL(path, base.origin);
  // Some providers carry preview credentials in the query string. They replace any the client sent under the same
  // name, which would otherwise reach the provider's proxy in place of the real ones.
  for (const key of new Set(base.searchParams.keys())) url.searchParams.delete(key);
  for (const [key, value] of base.searchParams) url.searchParams.append(key, value);
  return url;
}

/**
 * A connection to the T3 server on one VM: authenticated HTTP plus the RPC WebSocket.
 * The bearer token and preview headers never leave this class.
 */
export class Backend {
  private socket?: WebSocket;
  private serial = 0;
  private readonly handlers = new Map<string, (frame: Frame) => void>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closing = false;
  onClose?: () => void;

  constructor(
    readonly vmId: string,
    private readonly preview: Preview,
    private readonly token: string,
    private readonly openSocket: OpenSocket,
  ) {}

  get open() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private url(path: string) {
    return previewTarget(this.preview, path);
  }

  private headers(extra?: RequestInit["headers"]) {
    const headers = new Headers(extra);
    for (const [name, value] of Object.entries(this.preview.headers ?? {})) headers.set(name, value);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("x-t3-orchestration-protocol", "2");
    return headers;
  }

  async http(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(this.url(path), {
        ...init,
        headers: this.headers(init.headers),
        // A redirect could carry the bearer token to another origin.
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      // Fetch errors can include the preview URL, which may hold credentials.
      throw new Error(`The T3 server on VM ${this.vmId} did not answer.`);
    }
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.http(path, init);
    if (!response.ok) throw new Error(`The T3 server on VM ${this.vmId} answered ${response.status} for ${path}.`);
    return (await response.json()) as T;
  }

  /** Resolves once the RPC socket is open. Rejects with status 401 in the message when the token is refused. */
  async connect(timeoutMs = 15_000): Promise<void> {
    const ticket = await this.http("/api/auth/websocket-ticket/rpc", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (ticket.status === 401) throw new TokenRejected(this.vmId);
    if (!ticket.ok) throw new Error(`The T3 server on VM ${this.vmId} refused a socket ticket (${ticket.status}).`);
    const url = this.url("/ws?orchestrationProtocol=2");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ((await ticket.json()) as { ticket: string }).ticket);

    let socket: WebSocket;
    try {
      socket = await this.openSocket(url, this.preview.headers ?? {}, timeoutMs);
    } catch (error) {
      throw new Error(`Cannot open the T3 socket on VM ${this.vmId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.closing) {
      socket.close();
      throw new Error(`The T3 socket on VM ${this.vmId} closed while connecting.`);
    }
    this.socket = socket;
    // Listeners, not onmessage and onclose, which Workers' WebSocket lacks.
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => {
      clearInterval(this.heartbeat);
      // First, so the streams this ends see the VM reconnecting rather than a dropped connection.
      if (!this.closing) this.onClose?.();
      for (const [requestId, handler] of this.handlers) handler(disconnected(requestId));
      this.handlers.clear();
    });
    this.heartbeat = setInterval(() => this.open && this.socket?.send('{"_tag":"Ping"}'), 5_000);
  }

  /**
   * Opens one of T3's media WebSockets, such as a preview tab's stream, at `path` with `query`, under a fresh media
   * ticket of VM Bridge's own session.
   */
  async media(path: string, query: URLSearchParams, timeoutMs = 15_000): Promise<WebSocket> {
    const ticket = await this.http("/api/auth/websocket-ticket/media", { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
    if (!ticket.ok) throw new Error(`The T3 server on VM ${this.vmId} refused a media ticket (${ticket.status}).`);
    const url = this.url(path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    for (const [key, value] of query) url.searchParams.set(key, value);
    url.searchParams.set("wsTicket", ((await ticket.json()) as { ticket: string }).ticket);
    try {
      return await this.openSocket(url, this.preview.headers ?? {}, timeoutMs);
    } catch (error) {
      throw new Error(`Cannot open ${path} on VM ${this.vmId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private receive(data: string) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      this.socket?.close();
      return;
    }
    for (const frame of (Array.isArray(decoded) ? decoded : [decoded]) as Frame[]) {
      if (frame._tag === "Pong") continue;
      const requestId = String(frame.requestId);
      this.handlers.get(requestId)?.(frame);
      // T3 streams wait for an Ack before sending the next chunk.
      if (frame._tag === "Chunk") this.socket?.send(JSON.stringify({ _tag: "Ack", requestId }));
      if (frame._tag === "Exit") this.handlers.delete(requestId);
    }
  }

  /** Sends one RPC request. Returns a function that interrupts it. */
  request(tag: string, payload: unknown, handler: (frame: Frame) => void): () => void {
    if (!this.open) throw new Error(`VM ${this.vmId} is disconnected. Nothing was sent.`);
    const id = String(++this.serial);
    this.handlers.set(id, handler);
    this.socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return () => {
      if (!this.handlers.delete(id)) return;
      if (this.open) this.socket!.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
    };
  }

  /** A request with a single result. Rejects with `T3Rejected` only when T3 itself answered with a failure. */
  call<T>(tag: string, payload: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise((resolve, reject) => {
      let cancel = () => {};
      const timer = setTimeout(() => {
        cancel();
        reject(new Error(`T3 ${tag} timed out on VM ${this.vmId}.`));
      }, timeoutMs);
      try {
        cancel = this.request(tag, payload, (frame) => {
          if (frame._tag !== "Exit") return;
          clearTimeout(timer);
          const { exit } = frame as Exit;
          if (exit._tag === "Success") resolve(exit.value as T);
          // A closed socket fails its open requests too; that is not T3's answer.
          else reject(this.open ? new T3Rejected(tag, this.vmId) : new Error(`VM ${this.vmId} disconnected during T3 ${tag}.`));
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * Closes the socket and resolves once it has closed. Some providers (boxd) wake a paused VM on any
   * proxy traffic, so a close handshake still in flight would undo a sleep.
   */
  close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }
}

export class T3Rejected extends Error {
  constructor(tag: string, vmId: string) {
    super(`T3 ${tag} failed on VM ${vmId}.`);
  }
}

export class TokenRejected extends Error {
  constructor(vmId: string) {
    super(`The T3 server on VM ${vmId} rejected VM Bridge's session.`);
  }
}
