// VM Bridge on Bun: the server, timers and files on this machine. Bun-only pieces live here and in bun/, so the rest
// can run elsewhere too.
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { version } from "../../../package.json" with { type: "json" };
import { Admin } from "./admin.ts";
import { DashboardAuth } from "./auth/dashboard.ts";
import { importAuthFiles } from "./bun/auth-files.ts";
import { bunMachine } from "./bun/machine.ts";
import { openDashboard } from "./bun/dashboard.ts";
import { withSecurityHeaders } from "./security-headers.ts";
import { runJobs } from "./bun/jobs.ts";
import { bunPasswords } from "./bun/password.ts";
import { openSocket } from "./bun/socket.ts";
import { openDatabase } from "./bun/sqlite.ts";
import { openEncryption } from "./encryption.ts";
import { openBridge } from "./bridge.ts";
import { BunNetwork } from "./bun/bridge-network.ts";
import { localKey } from "./bun/key.ts";
import { bridgeJobs } from "./jobs.ts";
import { fetchGitHubAccount } from "./github.ts";
import { maxUploadBytes, uploadPrefix } from "./gateway/attachments.ts";
import { isT3Path, type SocketData } from "./gateway/http.ts";
import { isOpenCodeRequest } from "./gateway/opencode.ts";
import { Listeners } from "./bun/listeners.ts";
import { networkInfo, wantedHosts } from "./bun/network.ts";
import { Secrets, type Plaintext } from "./settings.ts";
import type { Sql } from "./sql.ts";
import { CloudflareTunnel, requestOrigin } from "./bun/tunnel.ts";
import { releaseCheck } from "./release.ts";
import { isWatchPath, type Viewer } from "./watch/watch.ts";

/** A T3 client's RPC socket, or a relayed stream's: a watch page's or a preview tab's. */
type Socket = SocketData | { viewer: Viewer };

export { version };
export { childEnv } from "./bun/env.ts";
export const defaultPort = 3774;
export const dataDir = () => process.env.VMBRIDGE_HOME || join(homedir(), ".vmbridge");
export const databasePath = (dir = dataDir()) => join(dir, "main.db");
/** Running as the compiled release binary, not with Bun from source. Only the binary can update itself. */
export const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
export { checksumFor, isNewer, latestVersion, releaseRepo } from "./release.ts";

/**
 * Data saved before encryption existed is sealed, until `openEncryption` says that ran. Each table moves in one
 * transaction, so a start cut short finishes the rest next time. After that VM Bridge never writes a value
 * unencrypted, so one found was put there by something else, and is removed.
 */
function plaintext(db: Sql, dir: string, migrated: boolean, tables: { plaintext(action: Plaintext): string[] }[]) {
  const changed = tables.flatMap((table) => table.plaintext(migrated ? "drop" : "seal"));
  if (migrated) {
    for (const what of changed) console.error(`Removed the ${what} from ${databasePath(dir)}: it was not encrypted, so VM Bridge did not save it.`);
  } else if (changed.length > 0) {
    // Rewrites the database so the replaced plain text is not left behind in free pages or the write-ahead log.
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}

/** Dashboard password setup, for the CLI to run before the server starts. */
export function dashboardKey(dir = dataDir()) {
  const db = openDatabase(databasePath(dir));
  const { encryption, key, migrated } = openEncryption(db, (create) => localKey(dir, create));
  const secrets = new Secrets(db, encryption);
  // An older version's unencrypted password hash moves first, so it still counts as set. Starting records that
  // sealing ran, once the other tables are done too.
  plaintext(db, dir, migrated, [secrets]);
  const auth = new DashboardAuth(db, secrets, bunPasswords);
  return {
    encryptionKey: { location: key.location, created: key.created },
    isSet: () => auth.hasKey(),
    set: (key: string) => auth.setKey(key),
    close: () => db.close(),
  };
}

export interface StartOptions {
  dir?: string;
  /** Listen on this one address instead of loopback, Tailscale and the local network switch. 0.0.0.0 is every network. */
  host?: string;
  port?: number;
  /**
   * Installs the latest release and restarts VM Bridge on it, for the dashboard's Update button. It rejects when the
   * install fails; when it works, this process is stopped before it settles. Without it the dashboard shows the command.
   */
  installUpdate?: () => Promise<void>;
}

export async function start(options: StartOptions = {}) {
  const host = options.host;
  const dir = options.dir ?? dataDir();
  const db = openDatabase(databasePath(dir));
  const development = process.env.VMBRIDGE_DEV === "1";
  const dashboard = await openDashboard(development);
  // Set before the bridge calls it, once listening.
  let network: BunNetwork;
  const bridge = openBridge({
    db,
    key: (create) => localKey(dir, create),
    passwords: bunPasswords,
    openSocket,
    resolve: async (hostname) => (await Bun.dns.lookup(hostname)).map((entry) => entry.address),
    machine: bunMachine(dir),
    addresses: async () => (await network.info()).addresses,
    watchPage: dashboard.watchPage,
    prepare: ({ encryption, migrated, markMigrated, secrets, store, skills }) => {
      importAuthFiles(join(dir, "auths"), db, encryption);
      plaintext(db, dir, migrated, [secrets, store, skills]);
      if (!migrated) markMigrated();
    },
  });
  const { settings, key: encryptionKey, secrets, traffic, skills, fleet, stats, usage, budget, hub, gateway, opencode, auth, watch } = bridge;
  // Defined before the server starts listening; its listener only opens once the tunnel is on.
  let tunnel: CloudflareTunnel;
  let listeners: Listeners<Socket>;
  const served = () => ({ hosts: listeners.hosts(), port: listeners.port, fixed: host !== undefined, localNetwork: settings.get("localNetwork") });
  network = new BunNetwork({ served, applyAddresses: () => listeners.apply(), settings, secrets, tunnel: () => tunnel });
  // Only the release binary checks (below): from source, `git pull` updates.
  const release = releaseCheck(settings, version);
  const update = {
    available: release.available,
    how: options.installUpdate ? ("dashboard" as const) : ("command" as const),
    install: options.installUpdate ?? null,
  };
  const admin = new Admin({ ...bridge, version, startedAt: Date.now(), network, passwordSource: null, update });
  // A relayed stream's socket carries its viewer; any other is a T3 client's RPC socket, so the casts only drop the viewer case.
  const websocket: WebSocketHandler<Socket> = {
    maxPayloadLength: 16 * 1024 * 1024,
    open(socket) {
      if ("viewer" in socket.data) socket.data.viewer.opened(socket);
      else gateway.opened(socket as ServerWebSocket<SocketData>);
    },
    message(socket, raw) {
      if ("viewer" in socket.data) socket.data.viewer.received(raw);
      else gateway.received(socket as ServerWebSocket<SocketData>, String(raw));
    },
    close(socket, code, reason) {
      if ("viewer" in socket.data) socket.data.viewer.closed();
      else gateway.closed(socket as ServerWebSocket<SocketData>, code, reason);
    },
  };

  /** Set once stopping starts. Requests then get a 503, so a client reconnecting at once does not land on this process. */
  let stopping = false;
  /** `viaTunnel` marks the loopback listener only cloudflared forwards to, whose proxy headers can be trusted. */
  const serve = (hostname: string, port: number, viaTunnel: boolean) =>
    Bun.serve<Socket>({
      hostname,
      port,
      // Attachment uploads are the one large body: T3 takes files of up to 50 MB. Every other body is held to 2 MB below.
      maxRequestBodySize: maxUploadBytes + 1024 * 1024,
      // Long enough for the dashboard's event stream between heartbeats.
      idleTimeout: 60,
      development,
      routes: {
        ...dashboard.routes,
        "/": new Response(null, { status: 302, headers: { location: "/dashboard" } }),
      },
      fetch(request, server) {
        if (stopping) return new Response("VM Bridge is stopping", { status: 503, headers: { "retry-after": "1" } });
        const { pathname: path, search } = new URL(request.url);
        // A body without a length (chunked) could otherwise grow to the upload limit. OpenCode's go to the VM as they
        // arrive, and its prompts can carry files.
        const length = request.headers.get("content-length");
        const opencodeRequest = isOpenCodeRequest(request);
        if (request.body && !path.startsWith(uploadPrefix) && !opencodeRequest && (length === null || !(Number(length) <= 2 * 1024 * 1024))) {
          return new Response("Request body too large", { status: 413 });
        }
        // Routes match exactly, so /dashboard/ would miss. The browser keeps the fragment (onboarding's #code=) across the redirect.
        if (path.startsWith("/dashboard/") && path.endsWith("/")) {
          return new Response(null, { status: 302, headers: { location: `${path.replace(/\/+$/, "")}${search}` } });
        }
        if (path.startsWith("/admin/api/")) {
          return admin.fetch(request, requestOrigin(request, server.requestIP(request)?.address, viaTunnel)).then(withSecurityHeaders);
        }
        const relay = (upgrade: Request, viewer: Viewer) => (server.upgrade(upgrade, { data: { viewer } }) ? undefined : null);
        // Before T3's paths: `opencode api` asks for /api/ paths at the root.
        if (opencodeRequest) {
          // A request can wait for its VM to wake for longer than the 60 seconds above (see OpenCodeGateway).
          server.timeout(request, 100);
          return opencode.fetch(request, relay);
        }
        if (isT3Path(path)) return gateway.fetch(request, (upgrade, data) => (server.upgrade(upgrade, { data }) ? undefined : null), relay);
        // Before the dashboard's files, which would otherwise answer for any path.
        if (isWatchPath(path)) return watch.fetch(request, relay);
        // The dashboard lives under /dashboard, a path T3 clients never request, and its files at the root.
        if (dashboard.fetch && (request.method === "GET" || request.method === "HEAD")) return dashboard.fetch(request);
        return new Response("Not found", { status: 404 });
      },
      websocket,
    });
  /**
   * In development each listener serves the dashboard itself, and Bun adds its bundled files (script, styles, icons) to
   * a server's routes only once that server has served the page. Until then they answer 404 to a browser that already
   * has the page, such as one left open across a restart or on a new tunnel listener. Requesting the page once here
   * adds them up front.
   */
  const listen = async (hostname: string, port: number, viaTunnel: boolean) => {
    const listener = serve(hostname, port, viaTunnel);
    if (development) await fetch(new URL("/dashboard", listener.url)).then((response) => response.arrayBuffer(), () => {});
    return listener;
  };
  listeners = new Listeners(
    (hostname, port) => listen(hostname, port, false),
    async () => (host ? [host] : wantedHosts(settings.get("localNetwork"))),
    options.port ?? defaultPort,
  );
  await listeners.start();
  tunnel = new CloudflareTunnel({ settings, secrets, traffic, dir, listen: (tunnelPort) => listen("127.0.0.1", tunnelPort, true) });
  void tunnel.apply();
  void watch.refresh();

  // Installed local skills and instructions files follow edits on this machine. Reading a few small files is cheaper than watching them reliably.
  skills.instructions.refresh();
  const localSkills = {
    name: "local skills",
    everyMs: 5_000,
    run: async () => {
      try {
        skills.refreshLocal();
        skills.instructions.refresh();
      } catch {}
    },
  };
  // Follows Tailscale coming up or changing address, and the local network appearing or changing.
  const addresses = { name: "addresses", everyMs: 5_000, run: () => listeners.apply() };
  if (compiled) void release.job.run();
  const stopJobs = runJobs([
    ...bridgeJobs({ hub, fleet, stats, usage, budget, traffic, watch }),
    localSkills,
    ...(host ? [] : [addresses]),
    ...(compiled ? [release.job] : []),
  ]);
  void fleet.resume();
  // Accounts saved by older versions lack the details the dashboard shows.
  const githubToken = secrets.get("github.token");
  if (githubToken && !settings.get("github")?.checkedAt) {
    void fetchGitHubAccount(githubToken).then((account) => settings.set("github", account), () => {});
  }
  traffic.record({ kind: "system", operation: "VM Bridge started" });

  return {
    port: listeners.port,
    /** Opens first password setup in the dashboard. Null when a password exists. Show it only to whoever started VM Bridge. */
    setupCode: auth.createSetupCode(),
    /** Where this install's encryption key lives, and whether this start made it. */
    encryptionKey: { location: encryptionKey.location, created: encryptionKey.created },
    network: () => networkInfo(served(), tunnel.info()),
    /** Waits a little for the Cloudflare Tunnel's address, so it can be printed with the others. */
    tunnelReady: () => tunnel.ready(20_000),
    /**
     * `restarting` means another VM Bridge starts as soon as this one exits (an update, or a new start taking over), so
     * stopping is kept short: clients reconnect on their own within a second or two of that one listening.
     */
    async stop({ restarting = false } = {}) {
      stopping = true;
      stopJobs();
      gateway.close(restarting);
      await Promise.all([tunnel.stop(), listeners.stop(), dashboard.stop()]);
      // Some providers have no idle timeout of their own: a VM left awake here would run until VM Bridge starts again.
      // On a restart that is moments away, and the next one's idle sweep puts them to sleep as usual.
      if (!restarting) await hub.sleepIdle(15_000);
      hub.close();
      fleet.close();
      usage.close();
      db.close();
    },
  };
}
