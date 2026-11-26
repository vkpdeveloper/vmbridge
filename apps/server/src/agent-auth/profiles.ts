import type { AgentAuthMethod, AgentKind, AgentProfile, ClaudeLogin, CodexLogin } from "@vmbridge/contracts";
import type { Encryption } from "../encryption.ts";
import type { Settings } from "../settings.ts";
import type { Sql } from "../sql.ts";
import { ClaudeCodeRejected, exchangeSetupToken, parsePastedCode, startClaudeSignIn, type ClaudeSignIn } from "./claude.ts";
import {
  codexAccount,
  codexTokenAccounts,
  completeDeviceCode,
  deviceCodeTtlMs,
  parseCodexAuth,
  refreshCodexAuth,
  requestDeviceCode,
  SignInExpired,
  verificationUrl,
  type CodexAuthFile,
} from "./codex.ts";

/** Claude and OpenCode keep their token in the profile; Codex keeps its auth.json beside it. */
interface StoredProfile {
  id: string;
  agent: AgentKind;
  method: AgentAuthMethod;
  name: string;
  detail: string | null;
  createdAt: number;
  error: string | null;
  token?: string;
  baseUrl?: string;
  /** When Codex was last signed in. Token refreshes keep it; signing in again changes it. */
  signedInAt?: number;
}

/** What VM Bridge passes into a VM for its agents. */
export interface AgentSecrets {
  codexAuthJson?: string;
  /** Which Codex sign-in `codexAuthJson` holds. Unlike the file, it stays the same when the tokens refresh. */
  codexSignIn?: string;
  claudeOAuthToken?: string;
  anthropicAuthToken?: string;
  anthropicBaseUrl?: string;
  opencodeApiKey?: string;
}

export type TokenInput =
  | { agent: "claude"; method: "setup-token"; name: string; token: string }
  | { agent: "claude"; method: "auth-token"; name: string; token: string; baseUrl: string | null }
  | { agent: "opencode"; method: "api-key"; name: string; token: string };

export class InvalidSignIn extends Error {}

/** Refresh Codex well before its 10-day access token runs out, so no VM has to refresh it on its own. */
const codexRefreshMarginMs = 2 * 24 * 60 * 60_000;
/** A Codex access token lasts 10 days, so one running out much later than that did not come from OpenAI. */
const codexAccessTokenMaxMs = 14 * 24 * 60 * 60_000;
/** How far ahead a VM's clock may run when it stamps a refresh. */
const clockSkewMs = 5 * 60_000;
/** Each VM's auth.json is checked with ChatGPT at most this often. */
const codexAdoptIntervalMs = 10 * 60_000;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "default";

/** Asks a service to list models with the token. Only a 401 means the token is wrong. */
async function checkToken(url: string, headers: Record<string, string>, service: string) {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new InvalidSignIn(`Could not reach ${service}.`);
  }
  // 403 means the token is real but may not list models, which is enough for a sign-in check.
  if (response.ok || response.status === 403) return;
  if (response.status === 401) throw new InvalidSignIn(`${service} rejected that token.`);
  throw new InvalidSignIn(`${service} answered ${response.status}.`);
}

const anthropicHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
});

/**
 * Sealing contexts for a profile and its Codex auth.json. They keep the paths of the files sign-ins used to be, so
 * those files move into the database unchanged (see bun/auth-files.ts).
 */
export const profileContext = (id: string) => `auths/${id}/profile.json`;
export const codexAuthContext = (id: string) => `auths/${id}/auth.json`;

/**
 * Agent sign-ins, one row per profile in `agent_profiles`, encrypted: VMs get the plain text, which exists here only
 * in memory. Every VM gets the profile each agent uses, never sign-ins from the VM provider.
 */
export class AgentAuth {
  private readonly logins = new Map<string, CodexLogin & { abort: AbortController }>();
  private readonly claudeLogins = new Map<string, ClaudeSignIn>();
  /** Codex refreshes one at a time: OpenAI rotates refresh tokens, so two at once would break the sign-in. */
  private codexQueue: Promise<unknown> = Promise.resolve();
  /** When each VM's auth.json was last checked with ChatGPT. */
  private readonly codexAdoptChecks = new Map<string, number>();
  onChange: () => void = () => {};

  constructor(
    private readonly db: Sql,
    private readonly settings: Settings,
    private readonly encryption: Encryption,
  ) {}

  list(): AgentProfile[] {
    const inUse = this.settings.get("agentProfiles");
    return this.stored()
      .map(({ token: _token, baseUrl: _baseUrl, ...profile }) => ({ ...profile, inUse: inUse[profile.agent] === profile.id }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Checks a Claude or OpenCode token with its service, then saves it. */
  async addToken(input: TokenInput, detail: string | null = null): Promise<AgentProfile> {
    let baseUrl: string | undefined;
    if (input.method === "setup-token") {
      await checkToken("https://api.anthropic.com/v1/models", anthropicHeaders(input.token), "Anthropic");
    } else if (input.method === "auth-token") {
      baseUrl = input.baseUrl ? this.parseBaseUrl(input.baseUrl) : undefined;
      await checkToken(`${baseUrl ?? "https://api.anthropic.com"}/v1/models`, anthropicHeaders(input.token), baseUrl ? new URL(baseUrl).host : "Anthropic");
    } else {
      await checkToken("https://opencode.ai/inference/v1/models", { authorization: `Bearer ${input.token}` }, "OpenCode");
    }
    const fallback = { "setup-token": "Claude subscription", "auth-token": "Anthropic token", "api-key": "OpenCode" }[input.method];
    return this.save({
      id: this.newId(input.agent, input.name || fallback),
      agent: input.agent,
      method: input.method,
      name: input.name || fallback,
      detail: baseUrl ?? detail,
      createdAt: Date.now(),
      error: null,
      token: input.token,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  /** Starts a Codex device sign-in. The person enters the code at OpenAI; the sign-in saves itself once approved. */
  async startCodexLogin(name: string): Promise<CodexLogin> {
    const code = await requestDeviceCode();
    const login = {
      id: crypto.randomUUID(),
      userCode: code.userCode,
      verificationUrl,
      expiresAt: Date.now() + deviceCodeTtlMs,
      status: "pending" as CodexLogin["status"],
      error: null as string | null,
      abort: new AbortController(),
    };
    this.logins.set(login.id, login);
    void completeDeviceCode(code, login.abort.signal)
      .then((file) => {
        this.saveCodex(file, name);
        login.status = "done";
      })
      .catch((error: unknown) => {
        login.status = "failed";
        login.error = login.abort.signal.aborted ? "Cancelled." : error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.onChange();
        setTimeout(() => this.logins.delete(login.id), 10 * 60_000).unref?.();
      });
    return this.codexLogin(login.id)!;
  }

  codexLogin(id: string): CodexLogin | undefined {
    const login = this.logins.get(id);
    if (!login) return undefined;
    const { abort: _abort, ...view } = login;
    return view;
  }

  cancelCodexLogin(id: string) {
    this.logins.get(id)?.abort.abort();
  }

  /** Starts a Claude sign-in. The person approves at claude.ai and pastes back the code it shows. */
  startClaudeLogin(): ClaudeLogin {
    const id = crypto.randomUUID();
    const signIn = startClaudeSignIn();
    this.claudeLogins.set(id, signIn);
    setTimeout(() => this.claudeLogins.delete(id), 15 * 60_000).unref?.();
    return { id, url: signIn.url };
  }

  async finishClaudeLogin(id: string, pasted: string, name: string): Promise<AgentProfile> {
    const signIn = this.claudeLogins.get(id);
    if (!signIn) throw new InvalidSignIn("That sign-in expired. Start again.");
    const { code, state } = parsePastedCode(pasted);
    if (!code) throw new InvalidSignIn("Paste the code Claude showed.");
    if (state && state !== signIn.state) throw new InvalidSignIn("That code is from a different sign-in. Start again.");
    // A code works once, so this sign-in is over whatever Claude answers.
    this.claudeLogins.delete(id);
    try {
      const { token, email } = await exchangeSetupToken(signIn, code);
      return await this.addToken({ agent: "claude", method: "setup-token", name, token }, email);
    } catch (error) {
      throw error instanceof ClaudeCodeRejected ? new InvalidSignIn(error.message) : error;
    }
  }

  use(id: string) {
    const profile = this.read(id);
    this.settings.set("agentProfiles", { ...this.settings.get("agentProfiles"), [profile.agent]: profile.id });
    this.onChange();
  }

  remove(id: string) {
    const profile = this.read(id);
    this.db.run("DELETE FROM agent_profiles WHERE id = ?", profile.id);
    const inUse = { ...this.settings.get("agentProfiles") };
    if (inUse[profile.agent] === profile.id) {
      // Another profile for the same agent takes over, so removing one does not sign the agent out.
      const next = this.stored().find((other) => other.agent === profile.agent);
      if (next) inUse[profile.agent] = next.id;
      else delete inUse[profile.agent];
      this.settings.set("agentProfiles", inUse);
    }
    this.onChange();
  }

  /** The sign-ins every VM gets. Refreshes Codex first when it is close to expiring. */
  async vmSecrets(): Promise<AgentSecrets> {
    const inUse = this.settings.get("agentProfiles");
    const secrets: AgentSecrets = {};
    const claude = inUse.claude ? this.find(inUse.claude) : undefined;
    if (claude?.method === "setup-token") secrets.claudeOAuthToken = claude.token;
    if (claude?.method === "auth-token") {
      secrets.anthropicAuthToken = claude.token;
      secrets.anthropicBaseUrl = claude.baseUrl;
    }
    const opencode = inUse.opencode ? this.find(inUse.opencode) : undefined;
    if (opencode) secrets.opencodeApiKey = opencode.token;
    const codex = await this.refreshCodex(false);
    const signedIn = this.codexInUse()?.profile;
    if (codex && signedIn) {
      secrets.codexAuthJson = codex;
      secrets.codexSignIn = `${signedIn.id}@${signedIn.signedInAt ?? signedIn.createdAt}`;
    }
    return secrets;
  }

  /** True when the Codex sign-in in use should be refreshed now. */
  codexDue(): boolean {
    const current = this.codexInUse();
    return Boolean(current && !current.profile.error && this.due(current.file));
  }

  /**
   * Refreshes the Codex sign-in in use when it is due. Returns the auth.json VMs should have:
   * with `onlyChanged`, only when a refresh happened.
   */
  refreshCodex(onlyChanged: boolean): Promise<string | undefined> {
    const run = async () => {
      const current = this.codexInUse();
      if (!current) return undefined;
      if (current.profile.error || !this.due(current.file)) return onlyChanged ? undefined : JSON.stringify(current.file, null, 2);
      try {
        const fresh = await refreshCodexAuth(current.file);
        this.writeCodex(current.profile.id, fresh);
        return JSON.stringify(fresh, null, 2);
      } catch (error) {
        if (error instanceof SignInExpired) {
          this.save({ ...current.profile, error: error.message });
          this.onChange();
        }
        // A failed refresh leaves the current tokens, which still work until they expire.
        return onlyChanged ? undefined : JSON.stringify(current.file, null, 2);
      }
    };
    const next = this.codexQueue.then(run, run);
    this.codexQueue = next;
    return next;
  }

  /**
   * Takes a VM's auth.json when Codex on that VM refreshed the tokens itself, which retires the refresh token
   * VM Bridge holds. A VM can write anything to that file, so VM Bridge first asks ChatGPT whether the file's
   * access token belongs to the same account. That check only reads: refreshing to check would retire the
   * refresh token Codex on the VM holds.
   */
  adoptCodex(text: string, vmId: string): Promise<boolean> {
    const run = async () => {
      const current = this.codexInUse();
      const theirs = parseCodexAuth(text);
      const accountId = current ? codexAccount(current.file).accountId : null;
      if (!current || !theirs || !accountId || !this.plausiblyNewer(theirs, current.file)) return false;
      const lastCheck = this.codexAdoptChecks.get(vmId);
      if (lastCheck !== undefined && Date.now() - lastCheck < codexAdoptIntervalMs) return false;
      this.codexAdoptChecks.set(vmId, Date.now());
      try {
        if (!(await codexTokenAccounts(theirs.tokens.access_token)).includes(accountId)) return false;
      } catch {
        // VM Bridge's own tokens stay as they are.
        return false;
      }
      this.writeCodex(current.profile.id, theirs);
      if (current.profile.error) this.save({ ...current.profile, error: null });
      return true;
    };
    const next = this.codexQueue.then(run, run);
    this.codexQueue = next;
    return next;
  }

  /** Cheap checks before asking ChatGPT: same account, new tokens, a real date between ours and now, and a short-lived token. */
  private plausiblyNewer(theirs: CodexAuthFile, ours: CodexAuthFile) {
    // A refresh always brings a new access token. Our access token with another refresh token is just a swapped refresh token.
    if (theirs.tokens.refresh_token === ours.tokens.refresh_token || theirs.tokens.access_token === ours.tokens.access_token) return false;
    if (codexAccount(theirs).accountId !== codexAccount(ours).accountId) return false;
    const refreshedAt = Date.parse(theirs.last_refresh);
    if (!Number.isFinite(refreshedAt) || refreshedAt <= Date.parse(ours.last_refresh) || refreshedAt > Date.now() + clockSkewMs) return false;
    const { expiresAt } = codexAccount(theirs);
    return expiresAt !== null && expiresAt <= Date.now() + codexAccessTokenMaxMs;
  }

  private due(file: CodexAuthFile) {
    const { expiresAt } = codexAccount(file);
    if (expiresAt) return expiresAt - Date.now() < codexRefreshMarginMs;
    return Date.now() - Date.parse(file.last_refresh) > 5 * 24 * 60 * 60_000;
  }

  private codexInUse() {
    const id = this.settings.get("agentProfiles").codex;
    const profile = id ? this.find(id) : undefined;
    if (!profile) return undefined;
    const file = this.codexAuth(profile.id);
    return file ? { profile, file } : undefined;
  }

  private saveCodex(file: CodexAuthFile, name: string) {
    const { email, accountId } = codexAccount(file);
    // Signing in to the same ChatGPT account again replaces that profile's tokens.
    const existing = this.stored().find((profile) => {
      const saved = profile.agent === "codex" ? this.codexAuth(profile.id) : null;
      return saved !== null && codexAccount(saved).accountId === accountId;
    });
    // Never named after the email: names show unblurred in the dashboard.
    const label = name || "ChatGPT account";
    const profile = existing
      ? { ...existing, error: null, name: name || existing.name, signedInAt: Date.now() }
      : { id: this.newId("codex", label), agent: "codex" as const, method: "chatgpt" as const, name: label, detail: email, createdAt: Date.now(), error: null };
    this.save(profile, file);
  }

  private writeCodex(id: string, file: CodexAuthFile) {
    this.db.run("UPDATE agent_profiles SET codex_auth = ? WHERE id = ?", this.encryption.seal(JSON.stringify(file, null, 2), codexAuthContext(id)), id);
  }

  /** Saves the profile, with its Codex tokens in the same transaction, since saving can put it in use straight away. */
  private save(profile: StoredProfile, codex?: CodexAuthFile): AgentProfile {
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO agent_profiles (id, profile) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET profile = excluded.profile",
        profile.id,
        this.encryption.seal(JSON.stringify(profile, null, 2), profileContext(profile.id)),
      );
      if (codex) this.writeCodex(profile.id, codex);
    });
    // The first profile for an agent is the one VMs use.
    const inUse = this.settings.get("agentProfiles");
    if (!inUse[profile.agent]) this.settings.set("agentProfiles", { ...inUse, [profile.agent]: profile.id });
    this.onChange();
    return this.list().find((entry) => entry.id === profile.id)!;
  }

  private codexAuth(id: string): CodexAuthFile | null {
    const sealed = this.db.one<{ codexAuth: string | null }>("SELECT codex_auth AS codexAuth FROM agent_profiles WHERE id = ?", id)?.codexAuth;
    return sealed ? parseCodexAuth(this.encryption.open(sealed, codexAuthContext(id))) : null;
  }

  private stored(): StoredProfile[] {
    return this.db.all<{ id: string }>("SELECT id FROM agent_profiles ORDER BY id").flatMap(({ id }) => {
      const profile = this.find(id);
      return profile ? [profile] : [];
    });
  }

  private find(id: string): StoredProfile | undefined {
    const sealed = this.db.one<{ profile: string }>("SELECT profile FROM agent_profiles WHERE id = ?", id)?.profile;
    if (sealed === undefined) return undefined;
    try {
      return JSON.parse(this.encryption.open(sealed, profileContext(id))) as StoredProfile;
    } catch {
      return undefined;
    }
  }

  private read(id: string): StoredProfile {
    const profile = this.find(id);
    if (!profile) throw new InvalidSignIn("No such sign-in.");
    return profile;
  }

  private newId(agent: AgentKind, name: string) {
    const base = `${agent}-${slug(name)}`;
    let id = base;
    for (let n = 2; this.db.one("SELECT 1 FROM agent_profiles WHERE id = ?", id); n++) id = `${base}-${n}`;
    return id;
  }

  private parseBaseUrl(text: string) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new InvalidSignIn("The base URL is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidSignIn("The base URL must start with https:// or http://.");
    return url.toString().replace(/\/+$/, "");
  }
}
