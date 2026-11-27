import { DurableObject } from "cloudflare:workers";
// A default import: esbuild, which wrangler bundles with, has no named imports from JSON.
import packageJson from "../../../../package.json" with { type: "json" };
import { Admin, type BridgeNetwork } from "../admin.ts";
import { webPasswords } from "../auth/password.ts";
import { openBridge, type Bridge } from "../bridge.ts";
import { keyFromText, keyVariable } from "../encryption.ts";
import { message } from "../fleet.ts";
import type { Upgrade } from "../gateway/http.ts";
import { isOpenCodeRequest } from "../gateway/opencode.ts";
import { bridgeJobs } from "../jobs.ts";
import { releaseCheck } from "../release.ts";
import { isWatchPath, type WatchUpgrade } from "../watch/watch.ts";
import { workersFetchCompat } from "../providers/workers-fetch.ts";
import { withSecurityHeaders } from "../security-headers.ts";
import { passwordVariable, secretProblems, setupPage, type Env } from "./env.ts";
import { AlarmJobs } from "./jobs.ts";
import { openSocket, upgrader, watchUpgrader } from "./socket.ts";
import { openDoDatabase } from "./sql.ts";

/** An HMAC of the password the dashboard hash was made from, so a new VMBRIDGE_PASSWORD replaces it. */
const passwordSourceSecret = "dashboard.passwordSource";

/** A Worker answers on the one address Cloudflare routes to it. */
const workerNetwork: BridgeNetwork = {
  info: async (request) => ({ platform: "workers", addresses: [{ kind: "worker", label: "This Worker", url: new URL(request.url).origin }] }),
  // Cloudflare routes to a Worker by hostname, so a name someone else points at it never reaches it: DNS rebinding,
  // which the check on Bun is for, cannot happen.
  allows: async () => true,
  change: async () => null,
};

interface Running {
  bridge: Bridge;
  admin: Admin;
  upgrade: Upgrade;
  watchUpgrade: WatchUpgrade;
  jobs: AlarmJobs;
}

/**
 * The whole of VM Bridge on Cloudflare: one Durable Object, so there is one database (its SQLite), one fleet and one
 * set of connected T3 clients. The front Worker (index.ts) sends it the dashboard's API and T3's routes. Its jobs run
 * from alarms. Everything is rebuilt from the database when the object starts, as when Bun's VM Bridge restarts.
 */
export class BridgeObject extends DurableObject<Env> {
  private running: Running | null = null;
  /** Why the bridge could not open, such as a key that does not match the data. Never holds a secret. */
  private failure: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    workersFetchCompat();
    if (secretProblems(env).length > 0) return;
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.running = await this.open();
        await this.running.jobs.start();
      } catch (error) {
        this.failure = message(error);
        console.error(`[error] VM Bridge could not start: ${this.failure}`);
      }
    });
  }

  private async open(): Promise<Running> {
    const env = this.env;
    const key = keyFromText(env.VMBRIDGE_ENCRYPTION_KEY ?? "", keyVariable);
    const bridge = openBridge({
      db: openDoDatabase(this.ctx.storage),
      key: () => ({ key, location: keyVariable, created: false }),
      passwords: webPasswords,
      openSocket,
      // The Durable Object learns its address from the requests it gets: see `fetch`.
      addresses: async () => {
        const url = bridge.settings.get("workerOrigin");
        return url ? [{ kind: "worker", label: "This Worker", url }] : [];
      },
      watchPage: () => env.ASSETS.fetch(new Request(new URL("/dashboard/watch.html", bridge.settings.get("workerOrigin") ?? "https://localhost").href)),
      // Left out: Workers' fetch cannot reach private addresses, which the lookup keeps branch reads away from on Bun.
      resolve: undefined,
      prepare: ({ migrated, markMigrated, secrets, store, skills }) => {
        // Nothing on Workers was ever saved unencrypted, so a plain value was put there by something else.
        for (const what of [secrets, store, skills].flatMap((table) => table.plaintext("drop"))) {
          console.error(`Removed the ${what}: it was not encrypted, so VM Bridge did not save it.`);
        }
        if (!migrated) markMigrated();
      },
    });
    const { secrets, encryption, auth, hub, fleet, stats, usage, budget, traffic, gateway, watch } = bridge;

    // The password is a Worker secret. Its hash is made again only when it changes, which also ends every session.
    const password = env.VMBRIDGE_PASSWORD ?? "";
    const source = encryption.fingerprint(`dashboard password\n${password}`);
    if (!auth.hasKey() || secrets.get(passwordSourceSecret) !== source) {
      await auth.setKey(password);
      secrets.set(passwordSourceSecret, source);
    }

    // A Worker updates when its GitHub repository gets the new release, so the dashboard shows how instead of a button.
    const release = releaseCheck(bridge.settings, packageJson.version);
    const update = { available: release.available, how: "cloudflare" as const, install: null };
    const admin = new Admin({ ...bridge, version: packageJson.version, startedAt: Date.now(), network: workerNetwork, passwordSource: `the Worker's ${passwordVariable} secret`, update });
    const jobs = new AlarmJobs(this.ctx.storage, [...bridgeJobs({ hub, fleet, stats, usage, budget, traffic, watch }), release.job]);
    // A recreated Durable Object already knows its address; without this, links would read as off until the next alarm.
    await watch.refresh();
    void fleet.resume();
    traffic.record({ kind: "system", operation: "VM Bridge started" });
    return { bridge, admin, upgrade: upgrader(gateway), watchUpgrade: watchUpgrader(), jobs };
  }

  async fetch(request: Request): Promise<Response> {
    const running = this.running;
    if (!running) return setupPage(this.failure ? [this.failure] : secretProblems(this.env));
    const url = new URL(request.url);
    const { settings, watch } = running.bridge;
    if (settings.get("workerOrigin") !== url.origin) {
      settings.set("workerOrigin", url.origin);
      void watch.refresh();
    }
    if (isWatchPath(url.pathname)) return (await watch.fetch(request, running.watchUpgrade)) ?? new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/admin/api/")) {
      // Cloudflare sets cf-connecting-ip itself, replacing any a client sent.
      const origin = { address: request.headers.get("cf-connecting-ip") ?? "unknown", secure: url.protocol === "https:" };
      return withSecurityHeaders(await running.admin.fetch(request, origin));
    }
    // Before T3's paths: `opencode api` asks for /api/ paths at the root.
    if (isOpenCodeRequest(request)) return (await running.bridge.opencode.fetch(request, running.watchUpgrade)) ?? new Response("Not found", { status: 404 });
    return (await running.bridge.gateway.fetch(request, running.upgrade, running.watchUpgrade)) ?? new Response("Not found", { status: 404 });
  }

  async alarm() {
    await this.running?.jobs.alarm();
  }
}
