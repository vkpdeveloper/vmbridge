import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Address, AddressKind, VmInfo } from "@vmbridge/contracts";
import type { Fleet } from "../fleet.ts";
import { hasScreen } from "../providers/index.ts";
import type { OpenSocket } from "../runtime.ts";
import type { Store, VmRow } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import type { WatchLinks } from "./links.ts";
import { ViewOnlyFilter } from "./rfb.ts";
import { watchUrlPath } from "./skill.ts";

/** A watch page's socket, or a T3 client's preview stream: Bun's ServerWebSocket, or a Worker's WebSocket. */
export interface ViewerSocket {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
}

/** One relayed stream, a watch page's or a preview tab's. The runtime's socket reports to it. */
export interface Viewer {
  opened(socket: ViewerSocket): void;
  received(data: string | ArrayBuffer | Uint8Array): void;
  closed(): void;
}

/**
 * Accepts a stream's WebSocket upgrade for `viewer`. Returns the response to send, undefined when the runtime answers
 * the upgrade itself (Bun), or null when the request is not an upgrade.
 */
export type WatchUpgrade = (request: Request, viewer: Viewer) => Response | undefined | null;

/** How a stream ends, for the watch page. Any other close means it reconnects. */
export const asleepCode = 4000;
const endedCode = 4001;
/** A page sends only its handshake before the screen's stream opens; more than this is not a viewer. */
const earlyLimit = 64 * 1024;

export const isWatchPath = (path: string) => path === "/watch" || path.startsWith("/watch/");

/** The same answer as any path VM Bridge does not serve, so a wrong token tells nothing. */
const notFound = () => new Response("Not found", { status: 404 });

/** The address links handed out use: the one most devices can reach. */
export const addressPreference: AddressKind[] = ["cloudflare", "worker", "tailscale-https", "tailscale-dns", "tailscale", "lan", "local"];

/**
 * The page's own headers. Its token is in the URL, so nothing it loads may send a referrer, and no cache or index may
 * keep it. It loads only its own files and connects only to its own stream.
 */
const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

/** How long the screen's stream may take to open. */
const openTimeoutMs = 15_000;

export interface WatchDeps {
  links: WatchLinks;
  store: Store;
  fleet: Fleet;
  traffic: Traffic;
  openSocket: OpenSocket;
  /** Where VM Bridge can be reached now, for the links it gives out. */
  addresses: () => Promise<Address[]>;
  /** The watch page, as the dashboard's build made it. */
  page: () => Promise<Response>;
}

const bytes = (data: unknown) => (data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null);

/**
 * Watch links: a page at `/watch/<token>` that shows a VM's screen live, for VMs whose provider has one (Kubi). The
 * token is the only credential, so the page needs no dashboard login and shows nothing but the screen. Its stream
 * goes through VM Bridge, which opens the screen's own stream with a fresh ticket each time: the provider's key,
 * ticket and addresses never reach the browser. Watching never wakes a VM, and does not count as activity.
 *
 * Every VM with a screen gets a link when it is created, or first seen. VM Bridge also puts the link on the VM, in
 * `watchUrlPath`, whenever it wakes and whenever the link or VM Bridge's address changes, so agents there can give it
 * to the user.
 */
export class Watch {
  /** The origin links use, once known. */
  private base: string | null = null;
  /** What each awake VM has in `watchUrlPath`: the link, or null when the file is removed. */
  private readonly delivered = new Map<string, string | null>();
  private readonly delivering = new Map<string, Promise<void>>();
  /** Ends each open stream, by VM. */
  private readonly viewers = new Map<string, Set<() => void>>();

  constructor(private readonly deps: WatchDeps) {
    deps.fleet.on("changed", () => this.ensure());
    deps.fleet.on("awake", (vmId) => {
      this.ensure();
      // A woken VM may have restarted from an older disk: write its file again.
      this.delivered.delete(vmId);
      void this.deliver(vmId);
    });
    deps.fleet.on("offline", (vmId) => this.delivered.delete(vmId));
  }

  /** The link a VM's file and the dashboard show, or null while it is off. */
  url(vmId: string): string | null {
    const token = this.deps.links.token(vmId);
    return token && this.base ? `${this.base}/watch/${token}` : null;
  }

  /** What the dashboard shows about a VM's link. Null for a VM without a screen. */
  info(vm: VmRow): VmInfo["watchLink"] {
    return hasScreen(vm.provider) ? { url: this.url(vm.id) } : null;
  }

  /** Replaces the VM's link with a new one. Pages open on the old one stop at once. */
  renew(vmId: string) {
    this.deps.links.create(vmId);
    this.changed(vmId);
  }

  /** Turns the VM's link off until it is renewed. */
  off(vmId: string) {
    this.deps.links.off(vmId);
    this.changed(vmId);
  }

  private changed(vmId: string) {
    for (const end of this.viewers.get(vmId) ?? []) end();
    void this.deliver(vmId);
    this.deps.fleet.emit("changed");
  }

  /** Gives every VM with a screen a link, once: one turned off stays off. */
  private ensure() {
    for (const vm of this.deps.store.vms()) {
      if (vm.state !== "gone" && hasScreen(vm.provider) && !this.deps.links.has(vm.id)) this.deps.links.create(vm.id);
    }
  }

  /**
   * Picks up a change of address, and brings every awake VM's file up to date. Run on a schedule and in the
   * background, so it never throws: a failure, such as VM Bridge stopping meanwhile, waits for the next run.
   */
  async refresh() {
    try {
      const addresses = await this.deps.addresses();
      this.base = addressPreference.map((kind) => addresses.find((address) => address.kind === kind)).find(Boolean)?.url.replace(/\/+$/, "") ?? null;
      this.ensure();
      await Promise.all(this.deps.fleet.connected().map((vmId) => this.deliver(vmId)));
    } catch {}
  }

  /** Writes the VM's link to its file, or removes the file while the link is off. One at a time per VM, and only on a change. */
  private deliver(vmId: string): Promise<void> {
    const run = async () => {
      const vm = this.deps.store.vm(vmId);
      const box = this.deps.fleet.box(vmId);
      if (!vm || !box || !hasScreen(vm.provider)) return;
      // Without an address yet, an existing link is not "off".
      if (!this.base && this.deps.links.token(vmId)) return;
      const url = this.url(vmId);
      if (this.delivered.has(vmId) && this.delivered.get(vmId) === url) return;
      try {
        if (url) await box.files.write({ [watchUrlPath]: `${url}\n` }, { mode: 0o600 });
        else {
          await box.files.remove(watchUrlPath).catch((error: unknown) => {
            if (!(error instanceof SandboxError && error.code === "file_not_found")) throw error;
          });
        }
        this.delivered.set(vmId, url);
      } catch {
        // No reason: the error could quote the file.
        this.deps.traffic.record({ kind: "system", operation: "give the VM its watch link", vmId, status: "error" });
      }
    };
    const next = (this.delivering.get(vmId) ?? Promise.resolve()).then(run);
    this.delivering.set(vmId, next);
    void next.finally(() => {
      if (this.delivering.get(vmId) === next) this.delivering.delete(vmId);
    });
    return next;
  }

  /** Answers `/watch/...`: the page and its stream for a working token, and the same 404 as any unknown path otherwise. */
  async fetch(request: Request, upgrade: WatchUpgrade): Promise<Response | undefined> {
    const match = /^\/watch\/([^/]+)(\/stream)?$/.exec(new URL(request.url).pathname);
    const vmId = match ? this.deps.links.vmFor(match[1]!) : null;
    if (!match || !vmId) return notFound();
    if (match[2]) {
      if (request.method !== "GET") return notFound();
      const upgraded = upgrade(request, this.viewer(vmId));
      return upgraded === null ? notFound() : upgraded;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    const page = await this.deps.page();
    if (!page.ok) return new Response("The page is not available.", { status: 503, headers: { "cache-control": "no-store" } });
    return new Response(request.method === "HEAD" ? null : page.body, { headers: pageHeaders });
  }

  /** Opens the VM's screen stream. A screen that is not running only answers that, so this never wakes the VM. */
  private async screen(vmId: string): Promise<{ socket: WebSocket } | { code: number; reason: string }> {
    const vm = this.deps.store.vm(vmId);
    if (!vm?.sandboxId || vm.state === "sleeping" || vm.state === "gone") return { code: asleepCode, reason: "Asleep" };
    try {
      const stream = await this.deps.fleet.driver(vm.provider).screen?.(vm.sandboxId);
      if (stream === null) return { code: asleepCode, reason: "Asleep" };
      if (!stream) return { code: endedCode, reason: "No screen" };
      return { socket: await this.deps.openSocket(stream.url, {}, openTimeoutMs, stream.protocols) };
    } catch {
      // Whatever went wrong stays here: its message could name the provider's addresses.
      return { code: endedCode, reason: "Unavailable" };
    }
  }

  /** Passes the screen's frames to the page, and only the page's requests for frames to the screen. */
  private viewer(vmId: string): Viewer {
    const filter = new ViewOnlyFilter();
    let page: ViewerSocket | undefined;
    let screen: WebSocket | undefined;
    /** What the page sent before the screen's stream opened. */
    const early: Uint8Array[] = [];
    let earlyBytes = 0;
    let ended = false;
    const end = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      this.viewers.get(vmId)?.delete(stop);
      screen?.close();
      page?.close(code, reason);
    };
    const stop = () => end(endedCode, "Link changed");

    return {
      opened: (socket) => {
        page = socket;
        const viewers = this.viewers.get(vmId) ?? new Set();
        viewers.add(stop);
        this.viewers.set(vmId, viewers);
        void this.screen(vmId).then((opened) => {
          if (!("socket" in opened)) return end(opened.code, opened.reason);
          if (ended) return opened.socket.close();
          screen = opened.socket;
          // Listeners, not onmessage and onclose, which Workers' WebSocket lacks.
          screen.addEventListener("message", (event: MessageEvent<unknown>) => {
            const data = bytes(event.data);
            if (data) page?.send(data);
          });
          screen.addEventListener("close", () => end(endedCode, "Ended"));
          screen.addEventListener("error", () => end(endedCode, "Ended"));
          for (const data of early.splice(0)) screen.send(data);
        });
      },
      received: (data) => {
        const chunk = bytes(data);
        const allowed = chunk && filter.push(chunk);
        if (!allowed) return end(1008, "View only");
        if (allowed.length === 0) return;
        if (screen) return screen.send(allowed);
        earlyBytes += allowed.length;
        if (earlyBytes > earlyLimit) return end(1008, "Too much before the stream opened");
        early.push(allowed);
      },
      closed: () => {
        page = undefined;
        end(1000, "");
      },
    };
  }
}
