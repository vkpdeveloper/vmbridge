import {
  agentFeedbackModes,
  agentKinds,
  machineNameMaxLength,
  providerIds,
  vmSizes,
  type LiveMessage,
  type BridgeNetworkInfo,
  type Overview,
  type ProviderId,
  type ProviderInfo,
  type RepoRule,
  type VmInfo,
  type VmSize,
  type BridgeUpdate,
  type OpenCodeConnection,
} from "@vmbridge/contracts";
import { analyticsReport } from "./analytics.ts";
import { InvalidSignIn, type AgentAuth, type TokenInput } from "./agent-auth/profiles.ts";
import { InvalidPassword, TooManyAttempts, type DashboardAuth } from "./auth/dashboard.ts";
import { testAddress } from "./connection-test.ts";
import { fetchGitHubAccount, fetchGitHubRepos, GitHubRejected } from "./github.ts";
import type { Clients } from "./auth/clients.ts";
import { message, providerValues, type Fleet } from "./fleet.ts";
import type { Hub } from "./gateway/hub.ts";
import { keptIconHeaders, projectIcon } from "./gateway/icons.ts";
import type { T3Gateway } from "./gateway/http.ts";
import { openCodePrefix, type OpenCodeGateway } from "./gateway/opencode.ts";
import { newToken } from "./auth/tokens.ts";
import { githubName } from "./gateway/repos.ts";
import { agentKind, agentName } from "./gateway/agents.ts";
import { isWorking, str } from "./gateway/types.ts";
import { BoatSignInError, type BoatSignIn } from "./providers/boat-sign-in.ts";
import { hasScreen, providers } from "./providers/index.ts";
import { envVars, machineName, saveEnvVars, type Secrets, type Settings } from "./settings.ts";
import { InstructionsError, isInstructionName } from "./instructions.ts";
import { SkillError, type Skills } from "./skills.ts";
import type { Store, VmRow } from "./store.ts";
import type { Traffic } from "./traffic.ts";
import type { Usage } from "./usage.ts";
import type { Budget } from "./budget.ts";
import { envNameProblem, envValueProblem } from "./vm/runtime.ts";
import type { SkillsState } from "./vm/skills.ts";
import type { Stats } from "./vm/stats.ts";
import { addressPreference, type Watch } from "./watch/watch.ts";

/**
 * Where VM Bridge is reached, and the settings for it. Bun's covers loopback, Tailscale, the local network and
 * Cloudflare Tunnel (bun/bridge-network.ts). A Worker has only the address it was reached on.
 */
export interface BridgeNetwork {
  /** `request` is the one asking, whose address a Worker shows as its own. */
  info(request: Request): Promise<BridgeNetworkInfo>;
  /** Whether the dashboard's API answers on this Host header, against DNS rebinding. */
  allows(host: string | null): Promise<boolean>;
  /** A POST to /network/<setting>, such as the Tailscale HTTPS switch. Null when this runtime has no such setting. */
  change(setting: string, input: Record<string, unknown>): Promise<BridgeNetworkInfo | null>;
}

/** Who sent a request, for login throttling, and whether it arrived over HTTPS, for the cookie's Secure flag. */
export interface RequestOrigin {
  address: string;
  secure: boolean;
}

export interface AdminDeps {
  version: string;
  startedAt: number;
  network: BridgeNetwork;
  /** Where the dashboard password is set instead of the dashboard, such as a Worker's secret. Null when it can be changed here. */
  passwordSource: string | null;
  /** A newer VM Bridge release, or null, how this runtime moves to it, and the install the Update button runs, if it has one. */
  update: { available: () => string | null; how: BridgeUpdate["how"]; install: (() => Promise<void>) | null };
  settings: Settings;
  secrets: Secrets;
  store: Store;
  fleet: Fleet;
  boat: BoatSignIn;
  hub: Hub;
  traffic: Traffic;
  clients: Clients;
  auth: DashboardAuth;
  gateway: T3Gateway;
  opencode: OpenCodeGateway;
  agents: AgentAuth;
  stats: Stats;
  skills: Skills;
  usage: Usage;
  budget: Budget;
  watch: Watch;
}

export class BadRequest extends Error {}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const loggedIn = (cookie: string) => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": cookie } });
const isProvider = (id: unknown): id is ProviderId => (providerIds as readonly unknown[]).includes(id);
const isSize = (size: unknown): size is VmSize => (vmSizes as readonly unknown[]).includes(size);

/** Whether a browser sent this from a page on the address it was sent to. Browsers send Origin with every POST. */
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  try {
    const url = new URL(origin);
    return host !== null && new URL(`${url.protocol}//${host}`).host === url.host;
  } catch {
    return false;
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequest("Send a JSON object.");
  return value as Record<string, unknown>;
}

const text = (value: unknown, label: string) => {
  if (typeof value !== "string") throw new BadRequest(`${label} must be text.`);
  return value.trim();
};

/** The dashboard sends its own range, such as the start of the month in its time zone. */
function timeRange(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = Number(params.get("from"));
  const to = Number(params.get("to") ?? Date.now());
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new BadRequest("Send a time range.");
  return { from, to };
}

/**
 * The dashboard's API under /admin/api. Every route except login and first password setup needs the dashboard cookie.
 * Secret values go in and never come out: responses only say whether each one is set. The exceptions are credentials
 * VM Bridge makes for clients to copy, such as pairing links and OpenCode passwords.
 */
export class Admin {
  /** The dashboard's install of a new release is running. A second Update click while it runs does nothing. */
  private installing = false;
  private installError: string | null = null;

  constructor(private readonly deps: AdminDeps) {}

  async fetch(request: Request, origin: RequestOrigin): Promise<Response> {
    const path = new URL(request.url).pathname.slice("/admin/api".length);
    const { auth } = this.deps;
    if (!(await this.deps.network.allows(request.headers.get("host")))) return new Response("Unknown host", { status: 421 });
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) return json({ error: "Send this from the dashboard." }, 403);
    // A JSON body forces a CORS preflight, which VM Bridge never answers, so other sites cannot post here.
    if (request.method !== "GET" && !request.headers.get("content-type")?.startsWith("application/json")) {
      return json({ error: "Send JSON." }, 415);
    }
    try {
      if (path === "/auth" && request.method === "GET") {
        return json({ authenticated: auth.authenticated(request), hasPassword: auth.hasKey(), onboarded: this.deps.settings.get("onboarded") });
      }
      const { address, secure } = origin;
      if (path === "/login" && request.method === "POST") {
        const { key } = await body(request);
        const cookie = await auth.login(typeof key === "string" ? key : "", address, secure);
        if (!cookie) return json({ error: "That key is not right." }, 401);
        return loggedIn(cookie);
      }
      // The first password, set in onboarding with the code only the terminal that started VM Bridge printed.
      if (path === "/setup" && request.method === "POST") {
        const { code, key } = await body(request);
        const cookie = await auth.claim(typeof code === "string" ? code : "", typeof key === "string" ? key : "", address, secure);
        if (!cookie) return json({ error: "This setup link does not work. Open the link printed in the terminal where VM Bridge is running." }, 401);
        return loggedIn(cookie);
      }
      // Before the session check: Boat's page sends the browser here from another site, which never brings the
      // dashboard's SameSite=Strict cookie. The sign-in's state is what proves the person started it (see BoatSignIn).
      if (path === "/providers/boat/callback" && request.method === "GET") return await this.boatCallback(request);
      if (!auth.authenticated(request)) return json({ error: "Log in first." }, 401);
      return await this.route(request, path, address);
    } catch (error) {
      if (error instanceof TooManyAttempts) return json({ error: error.message }, 429);
      if (error instanceof BadRequest || error instanceof InvalidPassword || error instanceof InvalidSignIn || error instanceof GitHubRejected || error instanceof SkillError || error instanceof InstructionsError) return json({ error: error.message }, 400);
      return json({ error: message(error) }, 500);
    }
  }

  private async route(request: Request, path: string, address: string): Promise<Response> {
    const { settings, secrets, store, fleet, hub, clients, auth, gateway, agents, skills } = this.deps;
    const method = request.method;
    const [, section, id, action] = path.split("/");

    if (path === "/logout" && method === "POST") {
      const headers = new Headers({ "content-type": "application/json" });
      for (const cookie of auth.logout(request)) headers.append("set-cookie", cookie);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    if (path === "/key" && method === "POST") {
      if (this.deps.passwordSource) throw new BadRequest(`Change the password in ${this.deps.passwordSource}.`);
      const input = await body(request);
      const current = typeof input.current === "string" ? input.current : "";
      const next = text(input.key, "The password");
      // Not 401: the session is still fine, and the dashboard treats 401 as logged out.
      if (!(await auth.changeKey(current, next, address))) return json({ error: "The current password is not right." }, 403);
      return json({ ok: true });
    }
    if (path === "/onboarding" && method === "POST") {
      const { sync } = await body(request);
      if (typeof sync !== "boolean") throw new BadRequest("Say whether to bring your skills and instructions.");
      // One choice for everything this machine has: every local skill and every agent's global instructions file.
      if (sync) {
        skills.setSyncAll(true);
        for (const agent of agentKinds) skills.instructions.setSync(agent, true);
      }
      settings.set("onboarded", true);
      return json({ ok: true });
    }
    if (path === "/overview" && method === "GET") return json(this.overview());
    if (path === "/update" && method === "POST") {
      const { install, available } = this.deps.update;
      if (!install || !available()) throw new BadRequest("There is no update to install from the dashboard.");
      if (!this.installing) {
        this.installing = true;
        this.installError = null;
        // When the install works, VM Bridge restarts on the new release before this settles.
        void install()
          .catch((error) => {
            this.installError = message(error);
          })
          .finally(() => {
            this.installing = false;
            fleet.emit("changed");
          });
        fleet.emit("changed");
      }
      return json({ ok: true }, 202);
    }
    if (path === "/events" && method === "GET") return this.events(request);
    if (path === "/traffic" && method === "GET") return json(this.deps.traffic.recent);
    if (path === "/usage" && method === "GET") {
      const { from, to } = timeRange(request);
      return json(this.deps.usage.report(from, to));
    }
    if (path === "/budget" && method === "PUT") {
      const input = await body(request);
      const current = settings.get("budget");
      let monthlyUsd = current.monthlyUsd;
      if (input.monthlyUsd !== undefined) {
        monthlyUsd = input.monthlyUsd === null ? null : Number(input.monthlyUsd);
        if (monthlyUsd !== null && !(Number.isFinite(monthlyUsd) && monthlyUsd > 0 && monthlyUsd <= 1_000_000)) throw new BadRequest("Enter a budget above $0, or leave it empty for none.");
      }
      if (input.stopAtLimit !== undefined && typeof input.stopAtLimit !== "boolean") throw new BadRequest("Say whether to stop at the budget.");
      settings.set("budget", { monthlyUsd, stopAtLimit: input.stopAtLimit ?? current.stopAtLimit });
      fleet.emit("changed");
      return json(this.deps.budget.status());
    }
    if (path === "/analytics" && method === "GET") {
      const { from, to } = timeRange(request);
      // Days split at the dashboard's midnights.
      const timeZone = new URL(request.url).searchParams.get("tz") || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        return json(analyticsReport(store, this.deps.usage, from, to, timeZone));
      } catch (error) {
        if (error instanceof RangeError) throw new BadRequest("Unknown time zone.");
        throw error;
      }
    }

    if (path === "/network" && method === "GET") return json(await this.deps.network.info(request));
    if (path === "/network/test" && method === "POST") {
      const { addresses } = await this.deps.network.info(request);
      return json(await Promise.all(addresses.map((address) => testAddress(address.url, settings.get("bridgeId")))));
    }
    if (section === "projects" && id && action === "icon" && method === "GET") {
      const icon = hub.icons.get(id);
      const file = icon && hub.icons.file(icon.revision);
      if (!file) return json({ error: "This project has no logo." }, 404);
      return new Response(file, { headers: keptIconHeaders(file.type) });
    }
    // A project's OpenCode address and password, made the first time, and a new pairing code for a QR code. `renew`
    // makes a new password and ends the connections and pairing codes that used the old one.
    if (section === "projects" && id && action === "opencode" && method === "POST") {
      if (!store.project(id)) return json({ error: "Not found." }, 404);
      const renew = (await body(request)).renew === true;
      let password = store.openCodePassword(id);
      if (!password || renew) {
        password = newToken();
        store.setOpenCodePassword(id, password);
        if (renew) this.deps.opencode.disconnect(id);
      }
      const { addresses } = await this.deps.network.info(request);
      const urls = addresses.map((address) => ({ ...address, url: `${address.url}${openCodePrefix}${id}` }));
      // A phone cannot reach this machine's loopback address. The one most devices can reach goes first, as clients keep it.
      const reachable = addressPreference.flatMap((kind) => (kind === "local" ? [] : urls.filter((url) => url.kind === kind)));
      const pairing = reachable.length > 0 ? { ...this.deps.opencode.pairingCode(id), urls: reachable.map((url) => url.url) } : null;
      return json({ urls, password, pairing } satisfies OpenCodeConnection);
    }
    if (section === "network" && id && !action && method === "POST") {
      const changed = await this.deps.network.change(id, await body(request));
      return changed ? json(changed) : json({ error: "Not found." }, 404);
    }

    if (section === "providers") {
      if (!id) return json(providerIds.map((provider) => this.providerInfo(provider)));
      if (!isProvider(id)) return json({ error: "Unknown provider." }, 404);
      const definition = providers[id];
      if (!action && method === "PUT") {
        const { values } = await body(request);
        if (!values || typeof values !== "object") throw new BadRequest("Send the provider's values.");
        const options = { ...settings.get("providerOptions")[id] };
        // Every value is checked before any is saved.
        for (const field of definition.fields) {
          const value = (values as Record<string, unknown>)[field.key];
          if (value === undefined) continue;
          if (value !== null && typeof value !== "string") throw new BadRequest(`${field.label} must be text.`);
          const problem = field.kind === "secret" && value?.trim() ? await definition.check?.(field.key, value.trim()) : null;
          if (problem) throw new BadRequest(problem);
        }
        for (const field of definition.fields) {
          const value = (values as Record<string, string | null | undefined>)[field.key];
          if (value === undefined) continue;
          const trimmed = value?.trim() ?? "";
          if (field.kind === "secret") {
            // An empty secret field means "leave it as it is"; null clears it.
            if (value === null || trimmed) secrets.set(`provider.${id}.${field.key}`, value === null ? null : trimmed);
          } else if (trimmed) options[field.key] = trimmed;
          else delete options[field.key];
        }
        settings.set("providerOptions", { ...settings.get("providerOptions"), [id]: options });
        // New values, such as a key replacing one the provider refused, try a failed setup again, and recheck the
        // provider at once so a failure from the old key clears (or shows again) now, not at the next check.
        if (settings.get("providers").includes(id)) {
          fleet.prepareBase(id, true);
          void fleet.reconcile(id);
        }
        fleet.emit("changed");
        // Some values reach the provider's VMs, such as Kubi's key for agents.
        void hub.credentialsChanged().catch(() => {});
        return json(this.providerInfo(id));
      }
      if (action === "verify" && method === "POST") {
        await fleet.driver(id).verify();
        return json({ ok: true });
      }
      if (action === "options" && method === "GET") {
        const field = new URL(request.url).searchParams.get("field") ?? "";
        return json(await fleet.driver(id).options(field));
      }
      if (action === "add" && method === "POST") {
        await this.addProvider(id);
        return json(this.providerInfo(id));
      }
      if (id === "boat" && action === "connect" && method === "POST") {
        const back = (await body(request)).back;
        if (typeof back !== "string" || !back.startsWith("/dashboard") || back.startsWith("//")) throw new BadRequest("Say which dashboard page to come back to.");
        // The address the browser uses, which sameOrigin checked against the host. Boat's page sends it back there.
        const origin = request.headers.get("origin") ?? new URL(request.url).origin;
        return json({ url: await this.deps.boat.start(origin, back) });
      }
      if (id === "boat" && action === "disconnect" && method === "POST") {
        await this.deps.boat.disconnect();
        this.signInChanged(id);
        return json(this.providerInfo(id));
      }
      if (action === "setup" && method === "POST") {
        if (!settings.get("providers").includes(id)) throw new BadRequest(`Add ${definition.label} first.`);
        fleet.prepareBase(id, true);
        return json(this.providerInfo(id));
      }
      if (action === "default" && method === "POST") {
        if (!settings.get("providers").includes(id)) throw new BadRequest(`Add ${definition.label} first.`);
        settings.set("defaultProvider", id);
        this.providersChanged();
        return json(this.providerInfo(id));
      }
      // VMs already on the provider keep running. Only new VMs stop going there.
      if (!action && method === "DELETE") {
        const remaining = settings.get("providers").filter((entry) => entry !== id);
        settings.set("providers", remaining);
        // Its base snapshots are billed until deleted, so a failure stays on the provider in Accounts.
        void fleet.bases.drop(id).catch((error) =>
          this.deps.traffic.record({ kind: "provider", operation: "remove provider", provider: id, status: "error", reason: message(error) }),
        );
        if (settings.get("defaultProvider") === id) settings.set("defaultProvider", remaining[0] ?? null);
        this.providersChanged();
        return json(this.providerInfo(id));
      }
    }

    if (path === "/github/repos" && method === "GET") {
      const token = secrets.get("github.token");
      return json(token ? await fetchGitHubRepos(token) : []);
    }
    if (path === "/repo-rules" && method === "PUT") {
      const { rules } = await body(request);
      if (!Array.isArray(rules)) throw new BadRequest("Send the repository rules.");
      const seen = new Set<string>();
      const parsed = rules.map((rule): RepoRule => {
        const repo = typeof rule?.repo === "string" ? githubName(rule.repo) : undefined;
        if (!repo) throw new BadRequest("Name each repository as owner/name.");
        if (seen.has(repo.toLowerCase())) throw new BadRequest(`${repo} is listed twice.`);
        seen.add(repo.toLowerCase());
        if (rule.provider !== null && !isProvider(rule.provider)) throw new BadRequest("Unknown provider.");
        if (rule.size !== null && !isSize(rule.size)) throw new BadRequest("Pick small, medium or large.");
        return { repo, provider: rule.provider, size: rule.size };
      });
      settings.set("repoRules", parsed);
      fleet.emit("changed");
      return json(parsed);
    }

    if (path === "/github" && method === "PUT") {
      const token = text((await body(request)).token, "The token");
      if (!token) throw new BadRequest("Paste a personal access token.");
      const account = await fetchGitHubAccount(token);
      secrets.set("github.token", token);
      settings.set("github", account);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      hub.emit("config");
      return json(account);
    }
    if (path === "/github/check" && method === "POST") {
      const token = secrets.get("github.token");
      if (!token) throw new BadRequest("Connect GitHub first.");
      const account = await fetchGitHubAccount(token);
      settings.set("github", account);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      hub.emit("config");
      return json(account);
    }
    if (path === "/github" && method === "DELETE") {
      secrets.set("github.token", null);
      settings.set("github", null);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      hub.emit("config");
      return json({ ok: true });
    }

    // Several at once, as pasted: every one is checked before any is saved, so VMs get them in a single update.
    if (path === "/env" && method === "PUT") {
      const { vars } = await body(request);
      if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new BadRequest("Send the variables.");
      const added: Record<string, string> = {};
      for (const [name, value] of Object.entries(vars)) {
        const problem = envNameProblem(name) ?? (typeof value === "string" ? envValueProblem(value) : "The value must be text.");
        // Reserved-name problems already say the name.
        if (problem) throw new BadRequest(problem.startsWith(name) ? problem : `${name}: ${problem}`);
        added[name] = value as string;
      }
      saveEnvVars(secrets, { ...envVars(secrets), ...added });
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      return json(Object.keys(envVars(secrets)));
    }

    // Environment variables for every VM. Values go in and never come out.
    if (section === "env" && id) {
      const name = decodeURIComponent(id);
      // Each change reads the saved variables right before writing them, after any await, so overlapping saves keep each other's.
      if (!action && method === "PUT") {
        const problem = envNameProblem(name);
        if (problem) throw new BadRequest(problem);
        const { value } = await body(request);
        if (typeof value !== "string") throw new BadRequest("The value must be text.");
        const invalid = envValueProblem(value);
        if (invalid) throw new BadRequest(invalid);
        saveEnvVars(secrets, { ...envVars(secrets), [name]: value });
      } else if (!action && method === "DELETE") {
        const { [name]: _removed, ...rest } = envVars(secrets);
        saveEnvVars(secrets, rest);
      } else return json({ error: "Not found." }, 404);
      fleet.emit("changed");
      void hub.credentialsChanged().catch(() => {});
      return json(Object.keys(envVars(secrets)));
    }

    if (path === "/agents" && method === "POST") {
      const input = await body(request);
      const name = input.name === undefined ? "" : text(input.name, "The name");
      const token = text(input.token, "The token");
      if (!token) throw new BadRequest("Paste the token.");
      let profile: TokenInput;
      if (input.agent === "claude" && input.method === "setup-token") profile = { agent: "claude", method: "setup-token", name, token };
      else if (input.agent === "claude" && input.method === "auth-token") {
        const baseUrl = input.baseUrl == null ? "" : text(input.baseUrl, "The base URL");
        profile = { agent: "claude", method: "auth-token", name, token, baseUrl: baseUrl || null };
      } else if (input.agent === "opencode" && input.method === "api-key") profile = { agent: "opencode", method: "api-key", name, token };
      else throw new BadRequest("Unknown sign-in method.");
      return json(await agents.addToken(profile));
    }
    if (section === "agents" && id && action === "use" && method === "POST") {
      agents.use(id);
      return json({ ok: true });
    }
    if (section === "agents" && id && !action && method === "DELETE") {
      agents.remove(id);
      return json({ ok: true });
    }
    if (path === "/claude-login" && method === "POST") return json(agents.startClaudeLogin());
    if (section === "claude-login" && id && method === "POST") {
      const input = await body(request);
      const name = input.name === undefined ? "" : text(input.name, "The name");
      return json(await agents.finishClaudeLogin(id, text(input.code, "The code"), name));
    }
    if (path === "/codex-login" && method === "POST") {
      const { name } = await body(request);
      return json(await agents.startCodexLogin(name === undefined ? "" : text(name, "The name")));
    }
    if (section === "codex-login" && id) {
      if (method === "GET") {
        const login = agents.codexLogin(id);
        return login ? json(login) : json({ error: "That sign-in expired. Start again." }, 404);
      }
      if (method === "DELETE") {
        agents.cancelCodexLogin(id);
        return json({ ok: true });
      }
    }

    if (path === "/settings" && method === "PUT") {
      const input = await body(request);
      if (input.vmSize !== undefined) {
        if (input.vmSize !== null && !isSize(input.vmSize)) throw new BadRequest("Pick default, small, medium or large.");
        settings.set("vmSize", input.vmSize);
      }
      if (input.idleMinutes !== undefined) {
        const minutes = Number(input.idleMinutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new BadRequest("Idle minutes must be 1 to 240.");
        settings.set("idleMinutes", minutes);
      }
      if (input.t3Version !== undefined) {
        const version = input.t3Version === null ? "" : text(input.t3Version, "The T3 version");
        if (version && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new BadRequest("Use an exact version, such as 0.1.11.");
        settings.set("t3Version", version || null);
      }
      if (input.agentFeedback !== undefined) {
        const mode = agentFeedbackModes.find((entry) => entry === input.agentFeedback);
        if (!mode) throw new BadRequest("Pick off, on-request or auto.");
        if (mode !== settings.get("agentFeedback")) hub.setAgentFeedback(mode);
      }
      if (input.machineName !== undefined) {
        const name = machineName(text(input.machineName, "The machine name"));
        if (!name) throw new BadRequest(`Keep the machine name to ${machineNameMaxLength} characters.`);
        settings.set("machineName", name);
        // Clients subscribed to T3's server config get the new name right away.
        hub.emit("config");
      }
      // A new default size needs its own base snapshot, and a new T3 version an updated one. Either may fix a failed build.
      if (input.vmSize !== undefined || input.t3Version !== undefined) fleet.prepareBases(true);
      fleet.emit("changed");
      return json(this.overview().settings);
    }

    if (section === "pairing") {
      if (!id && method === "GET") return json(clients.links());
      if (!id && method === "POST") {
        let link;
        try {
          link = clients.createLink(text((await body(request)).name, "The name"));
        } catch (error) {
          throw new BadRequest(message(error));
        }
        const network = await this.deps.network.info(request);
        const urls = network.addresses.map((address) => {
          const url = `${address.url}/pair#token=${link.token}`;
          return { kind: address.kind, label: address.label, url };
        });
        return json({ link: link.link, urls });
      }
      if (id && method === "DELETE") {
        clients.deleteLink(id);
        return json({ ok: true });
      }
    }
    if (section === "clients" && id && method === "DELETE") {
      clients.revoke(id);
      gateway.disconnect(id);
      fleet.emit("changed");
      return json({ ok: true });
    }

    if (section === "skills") {
      if (id === "local" && !action && method === "GET") return json(skills.discover());
      if (id === "local" && !action && method === "PUT") {
        const input = await body(request);
        if (typeof input.sync !== "boolean") throw new BadRequest("Say whether to sync every local skill.");
        skills.setSyncAll(input.sync);
        return json(skills.discover());
      }
      if (id === "search" && !action && method === "GET") {
        const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
        return json(query ? await skills.search(query) : []);
      }
      if (!id && method === "POST") {
        const input = await body(request);
        if (input.source === "skills.sh") await skills.installFromSkillsSh(text(input.repo, "The repository"), text(input.skill, "The skill"));
        else if (input.source === "local") await skills.installLocal(text(input.path, "The folder"));
        else if (input.source === "upload") skills.installUpload(text(input.name, "The skill's name"), input.files);
        else throw new BadRequest("Pick a skill from skills.sh or this machine, or upload one.");
        return json(skills.list());
      }
      if (id && action === "update" && method === "POST") return json({ changed: await skills.update(decodeURIComponent(id)) });
      if (id && !action && method === "DELETE") {
        skills.remove(decodeURIComponent(id));
        return json(skills.list());
      }
    }

    if (path === "/instructions" && method === "GET") return json(skills.instructions.saved());
    if (section === "instructions" && id && isInstructionName(id) && !action && method === "PUT") {
      const input = await body(request);
      if (typeof input.text !== "string") throw new BadRequest(`Send the text of ${id}.`);
      skills.instructions.save(id, input.text);
      return json(skills.instructions.saved());
    }
    if (section === "instructions" && id && !action && method === "PUT") {
      const agent = agentKinds.find((kind) => kind === id);
      if (!agent) return json({ error: "No such agent." }, 404);
      const input = await body(request);
      if (typeof input.sync !== "boolean") throw new BadRequest("Say whether to sync it.");
      skills.instructions.setSync(agent, input.sync);
      return json(skills.instructions.list());
    }

    if (section === "vms" && id) {
      const vm = store.vm(id);
      if (!vm) return json({ error: "No such VM." }, 404);
      if (action === "wake" && method === "POST") {
        void fleet.ensure(id).catch(() => {});
        return json({ ok: true });
      }
      // A fresh reading for an open details panel. It never wakes the VM.
      if (action === "stats" && method === "GET") return json(await this.deps.stats.sample(id));
      if (action === "sleep" && method === "POST") {
        await Promise.all([hub.saveBeforeSleep(id), hub.keepFiles(id)]);
        await fleet.sleep(id);
        return json({ ok: true });
      }
      if (!action && method === "DELETE") {
        await fleet.destroy(id);
        hub.emit("shell");
        return json({ ok: true });
      }
      if (action === "watch" && (method === "POST" || method === "DELETE")) {
        if (!hasScreen(vm.provider)) throw new BadRequest("This VM has no screen.");
        if (method === "POST") this.deps.watch.renew(id);
        else this.deps.watch.off(id);
        return json({ url: this.deps.watch.url(id) });
      }
    }
    if (section === "vms" && !id && method === "POST") {
      const { provider, size } = await body(request);
      if (provider !== undefined && !isProvider(provider)) throw new BadRequest("Unknown provider.");
      if (size !== undefined && !isSize(size)) throw new BadRequest("Pick small, medium or large.");
      const vm = await fleet.create({ provider, size });
      void fleet.ensure(vm.id).catch(() => {});
      return json({ id: vm.id });
    }

    return json({ error: "Not found." }, 404);
  }

  private providerInfo(id: ProviderId, problems = this.deps.traffic.problems()): ProviderInfo {
    const definition = providers[id];
    const { settings, secrets } = this.deps;
    const values = { ...settings.get("providerOptions")[id] };
    const secretsSet = definition.fields
      .filter((field) => field.kind === "secret" && secrets.has(`provider.${id}.${field.key}`))
      .map((field) => field.key);
    const all = providerValues(settings, secrets, id);
    // Boat is the only provider with a sign-in.
    const signIn = definition.signIn ? this.deps.boat.status() : null;
    return {
      id,
      label: definition.label,
      website: definition.website,
      fields: definition.fields,
      features: definition.features,
      sizes: definition.sizes,
      defaultSize: definition.defaultSize,
      values,
      secretsSet,
      configured: Boolean(signIn?.connected) || definition.fields.every((field) => !field.required || Boolean(all[field.key])),
      added: settings.get("providers").includes(id),
      isDefault: settings.get("defaultProvider") === id,
      setup: this.deps.fleet.setup(id),
      problem: problems.providers.get(id) ?? null,
      signIn,
    };
  }

  /** Checks the provider's credentials, then adds it. The first provider added becomes the default. */
  private async addProvider(id: ProviderId) {
    const { fleet, settings } = this.deps;
    await fleet.driver(id).verify();
    const added = settings.get("providers");
    if (!added.includes(id)) {
      settings.set("providers", [...added, id]);
      // No VM is created there until it is built, so the first one already starts from it.
      fleet.prepareBase(id);
    }
    if (!settings.get("defaultProvider")) settings.set("defaultProvider", id);
    this.providersChanged();
  }

  /** A new connection, like a new key, tries a failed setup again and rechecks the provider. */
  private signInChanged(id: ProviderId) {
    const { fleet, settings } = this.deps;
    if (settings.get("providers").includes(id)) {
      fleet.prepareBase(id, true);
      void fleet.reconcile(id);
    }
    this.providersChanged();
  }

  /**
   * Where Boat's page sends the browser after the person chose (through VM Bridge's website, see BoatSignIn). Goes
   * back to the dashboard page the connect started on, adding Boat when it is not added yet, with `boat=connected` or
   * `boat=` and what went wrong.
   */
  private async boatCallback(request: Request): Promise<Response> {
    const go = (back: string, outcome: string) => {
      const url = new URL(back, "http://bridge");
      url.searchParams.set("boat", outcome);
      return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, "referrer-policy": "no-referrer", "cache-control": "no-store" } });
    };
    let back: string;
    try {
      back = await this.deps.boat.finish(new URL(request.url).searchParams);
    } catch (error) {
      return go("/dashboard?view=accounts&tab=provider", error instanceof BoatSignInError ? error.message : `Boat sign-in failed: ${message(error)}`);
    }
    this.signInChanged("boat");
    if (!this.deps.settings.get("providers").includes("boat")) {
      try {
        await this.addProvider("boat");
      } catch (error) {
        return go(back, `Connected, but Boat could not be added: ${message(error)}`);
      }
    }
    return go(back, "connected");
  }

  private providersChanged() {
    this.deps.fleet.emit("changed");
    // T3's agent list labels agents with the provider when there is only one.
    this.deps.hub.emit("config");
  }

  private availableUpdate(): BridgeUpdate | null {
    const version = this.deps.update.available();
    if (!version) return null;
    return { version, how: this.deps.update.how, installing: this.installing, error: this.installError };
  }

  overview(): Overview {
    const { settings, secrets, store, fleet, hub, clients, gateway } = this.deps;
    const defaultProvider = settings.get("defaultProvider");
    const agents = this.deps.agents.list();
    const projects = store.projects();
    const idleMs = settings.get("idleMinutes") * 60_000;
    const skills = this.deps.skills.state();
    const screenSkills = this.deps.skills.state(true);
    const problems = this.deps.traffic.problems();
    // What T3 lists for each agent, from the VMs' last reports: its name and its models' names.
    const agentReports = new Map(hub.agents().map((report) => [report.instanceId, report]));
    const vms = store
      .vms()
      .filter((vm) => vm.state !== "gone")
      .map((vm): VmInfo => {
        const idle = vm.state === "ready" && !fleet.leased(vm.id);
        return {
          id: vm.id,
          name: vm.name,
          provider: vm.provider,
          providerLabel: providers[vm.provider].label,
          sandboxId: vm.sandboxId,
          size: vm.size,
          sizeLabel: providers[vm.provider].sizes[vm.size],
          state: vm.state,
          error: vm.error,
          createdAt: vm.createdAt,
          lastActivityAt: vm.lastActivityAt,
          lastConnectedAt: vm.lastConnectedAt,
          lastSleptAt: vm.lastSleptAt,
          sleepsAt: idle ? (vm.lastActivityAt ?? vm.createdAt) + idleMs : null,
          projects: projects.filter((project) => project.vms.some((entry) => entry.vmId === vm.id)).map((project) => project.id),
          sessions: hub.vmThreads(vm.id).map((thread) => {
            const selection = thread.modelSelection as { model?: unknown; provider?: unknown } | undefined;
            const instance = str(thread.providerInstanceId) ?? str(selection?.provider);
            const report = instance ? agentReports.get(instance) : undefined;
            const driver = report?.driver ?? instance;
            const slug = str(selection?.model) ?? null;
            const listed = (report?.models as { slug?: unknown; name?: unknown }[] | undefined)?.find((model) => model.slug === slug);
            return {
              threadId: thread.id,
              title: String(thread.title ?? "Untitled"),
              projectId: typeof thread.projectId === "string" ? thread.projectId : null,
              model: str(listed?.name) ?? slug,
              agent: driver ? { kind: agentKind(driver), name: report?.displayName ?? agentName(driver) } : null,
              status: String(thread.status ?? "idle"),
              working: isWorking(thread),
              updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : null,
            };
          }),
          t3Version: vm.t3Version,
          updatePending: fleet.behind(vm),
          stats: vm.state === "ready" || vm.state === "busy" ? this.deps.stats.get(vm.id) : null,
          skillsPending: this.skillsPending(vm, hasScreen(vm.provider) ? screenSkills : skills),
          problem: problems.vms.get(vm.id) ?? null,
          watchLink: this.deps.watch.info(vm),
        };
      });
    return {
      bridge: { id: settings.get("bridgeId"), version: this.deps.version, startedAt: this.deps.startedAt, update: this.availableUpdate() },
      setup: {
        provider: Boolean(defaultProvider),
        github: secrets.has("github.token"),
        agents: agents.some((profile) => profile.inUse),
      },
      providers: settings.get("providers").map((id) => this.providerInfo(id, problems)),
      defaultProvider,
      repoRules: settings.get("repoRules"),
      github: secrets.has("github.token") ? settings.get("github") : null,
      agents,
      env: Object.keys(envVars(secrets)),
      settings: {
        machineName: settings.get("machineName"),
        vmSize: settings.get("vmSize"),
        idleMinutes: settings.get("idleMinutes"),
        t3Version: settings.get("t3Version"),
        agentFeedback: settings.get("agentFeedback"),
      },
      clients: clients.list(gateway.connected()),
      connectTrouble: gateway.connectTrouble(),
      vms,
      projects: projects.map((project) => ({
        id: project.id,
        title: project.title,
        icon: projectIcon(project.id, project.title, hub.pickedIcon(project.id), hub.icons.get(project.id)),
        url: project.url,
        branch: project.branch,
        vmIds: project.vms.map((entry) => entry.vmId),
        createdAt: project.createdAt,
      })),
      skills: this.deps.skills.list(),
      syncLocalSkills: this.deps.skills.syncAll,
      instructions: this.deps.skills.instructions.list(),
      savedInstructions: this.deps.skills.instructions.savedNames(),
      machine: this.deps.skills.hasMachine,
      passwordSource: this.deps.passwordSource,
      budget: this.deps.budget.status(),
    };
  }

  private skillsPending(vm: VmRow, skills: SkillsState) {
    return vm.sandboxId !== null && vm.skills !== skills.fingerprint && (skills.skills.length > 0 || skills.instructions.length > 0 || vm.skills !== null);
  }

  /** Server-sent events: every traffic event, and a fresh overview whenever the fleet changes. */
  private events(request: Request) {
    const { traffic, fleet, hub, auth } = this.deps;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup();
          controller.close();
        };
        const send = (live: LiveMessage) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(live)}\n\n`));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const changed = () => {
          timer ??= setTimeout(() => {
            timer = undefined;
            send({ type: "overview", overview: this.overview() });
          }, 200);
        };
        const unsubscribe = traffic.subscribe((event) => send({ type: "traffic", event }));
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
        fleet.on("changed", changed);
        hub.on("shell", changed);
        // The cookie was checked when the stream opened. Stop sending once that session ends.
        const unwatch = auth.watch(request, close);
        send({ type: "overview", overview: this.overview() });
        cleanup = () => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          unsubscribe();
          unwatch();
          fleet.off("changed", changed);
          hub.off("shell", changed);
        };
        request.signal.addEventListener("abort", close);
      },
      cancel: () => {
        closed = true;
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }
}
