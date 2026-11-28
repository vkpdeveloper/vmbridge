import { timingSafeEqual } from "node:crypto";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Fetch } from "@opencoredev/sandbox-sdk/provider";
import type { BoatOutcome, ProviderSignIn } from "@vmbridge/contracts";
import { sleep } from "../runtime.ts";
import type { Secrets } from "../settings.ts";
import type { SignIn } from "./types.ts";

/**
 * "Sign in with boat": OAuth with PKCE (docs.boat.dev/oauth-apps) through one public VM Bridge app, so nobody registers
 * their own. The app has no secret, so every install shares its client ID.
 *
 * Boat only sends people back to an address the app lists, and every install has its own (Tailscale, a home network,
 * a Worker). So Boat sends them to one page on VM Bridge's website (apps/landing/app/boat/callback), which forwards
 * the code to the install named in `state`. The page never sees the PKCE verifier, so the code is useless to it.
 *
 * Boat rotates refresh tokens: every refresh kills the previous access token, and using an old refresh token more
 * than a minute later disconnects the app. So one refresh runs at a time, and its tokens are saved before use. Bun
 * runs one process and a Worker one Durable Object, so a promise in memory is enough to keep it to one.
 */

// Release builds bake in the ID from the repository's secret (scripts/compile.ts). Cloudflare and source installs
// build without it, so they use this one. It is no secret: Boat shows it in every sign-in link.
export const boatClientId = process.env.VMBRIDGE_BOAT_CLIENT_ID || "boatapp_WyVQRBIeJPzt2s8xynbGJpVc";
export const boatRedirectUri = process.env.VMBRIDGE_BOAT_REDIRECT_URI || "https://vmbridge.ordinity.com/boat/callback";
const authorizeUrl = "https://boat.dev/api/boat/oauth2/authorize";
const tokenUrl = "https://boat.dev/api/boat/oauth2/token";
const revokeUrl = "https://boat.dev/api/boat/oauth2/revoke";
const meUrl = "https://boat.dev/api/v1/me";

/**
 * Only what VM Bridge calls: the account's email (account.read, shown in Accounts so people know which Boat account is
 * connected), list, create, wake (resume), rename and extend (update), stop and delete its own VMs, run commands and
 * move files in them, open T3's port (host), and save and check base snapshots. `sandbox.delete-own` keeps it from
 * deleting VMs it did not create.
 *
 * Left out on purpose: `environment.read`, which with `exec` makes Boat add `environment.values.read`, the
 * environments' secrets. A person who wants VMs in one environment picks it on Boat's page when connecting.
 */
const scopes = [
  "account.read",
  "sandbox.read",
  "sandbox.create",
  "sandbox.resume",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.delete-own",
  "exec",
  "file.read",
  "file.write",
  "host",
  "snapshot.read",
  "snapshot.write",
];

const savedName = "provider.boat.signIn";
const pendingName = "provider.boat.signInPending";
/** Boat's codes last 5 minutes. A person may take longer to choose on Boat's page. */
const pendingMs = 15 * 60_000;
/** Access tokens last an hour. Refresh this long before, so a long request does not outlive its token. */
const refreshEarlyMs = 5 * 60_000;
/** Boat's docs give no lifetime for an unused refresh token, so a connection never goes longer than this without one. */
const idleRefreshMs = 24 * 60 * 60_000;
/** Boat accepts the same refresh again for a minute, for a response that was lost. The last resend leaves before this. */
const resendWindowMs = 50_000;

interface Saved {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshedAt: number;
  connectedAt: number;
  /** The Boat account's email or login, or null when Boat did not say. */
  account: string | null;
}

interface Pending {
  state: string;
  verifier: string;
  /** The dashboard page to go back to. */
  back: string;
  startedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** A connect that did not finish. `outcome` is all the dashboard is told, so nobody can put words in its toast. */
export class BoatSignInError extends Error {
  constructor(
    readonly outcome: BoatOutcome,
    message: string,
  ) {
    super(message);
  }
}

/** Compares without leaking how much of `a` matched, as this route takes guesses from anyone. */
function same(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const random = (size: number) => base64url(crypto.getRandomValues(new Uint8Array(size)));

const unanswered = () =>
  new SandboxError("Boat did not answer while refreshing VM Bridge's access. It is tried again on the next request.", { code: "unavailable", provider: "boat" });

const lost = () =>
  new SandboxError("Boat ended VM Bridge's access. Connect Boat again in Accounts.", { code: "auth", provider: "boat" });

/** State carries the install's origin for the callback page, then a random part only this install knows. */
export function boatState(origin: string) {
  return `${base64url(new TextEncoder().encode(origin))}.${random(32)}`;
}

export class BoatSignIn implements SignIn {
  private refreshing?: Promise<void>;

  constructor(
    private readonly secrets: Pick<Secrets, "get" | "set">,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  private saved(): Saved | null {
    const text = this.secrets.get(savedName);
    return text ? (JSON.parse(text) as Saved) : null;
  }

  private save(saved: Saved | null) {
    this.secrets.set(savedName, saved && JSON.stringify(saved));
  }

  connected(): boolean {
    return this.saved() !== null;
  }

  status(): ProviderSignIn {
    const saved = this.saved();
    return { connected: saved !== null, account: saved?.account ?? null };
  }

  /** Changes on each connect and disconnect, never on a refresh, so drivers are rebuilt only then. */
  connection(): string | null {
    return this.saved()?.connectedAt.toString() ?? null;
  }

  /** Where to send the browser to connect: Boat's page that asks the person. `back` is the dashboard page to return to. */
  async start(origin: string, back: string): Promise<string> {
    const verifier = random(48);
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const pending: Pending = { state: boatState(origin), verifier, back, startedAt: Date.now() };
    // Kept in the database, so a restart (or a Durable Object put to sleep) while the person is on Boat's page is fine.
    this.secrets.set(pendingName, JSON.stringify(pending));
    const url = new URL(authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: boatClientId,
      redirect_uri: boatRedirectUri,
      scope: scopes.join(" "),
      state: pending.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  /**
   * Finishes a connect with what Boat sent back. Returns the dashboard page to go back to. Without a matching state
   * it throws and changes nothing: this route has no session cookie to check (the dashboard's is SameSite=Strict, and
   * this request comes from another site), so the state is what proves the person started it here.
   */
  async finish(query: URLSearchParams): Promise<string> {
    const text = this.secrets.get(pendingName);
    const pending = text ? (JSON.parse(text) as Pending) : null;
    const state = query.get("state");
    if (!pending || !state || !same(state, pending.state)) throw new BoatSignInError("invalid", "This Boat sign-in link is not for this VM Bridge. Connect again from Accounts.");
    // One use only.
    this.secrets.set(pendingName, null);
    if (Date.now() - pending.startedAt > pendingMs) throw new BoatSignInError("expired", "The Boat sign-in took too long. Connect again.");
    if (query.get("error") === "access_denied") throw new BoatSignInError("denied", "Boat access was not allowed.");
    const code = query.get("code");
    if (!code) throw new BoatSignInError("invalid", "Boat sent back no sign-in code. Connect again.");
    const tokens = await this.tokens(
      { grant_type: "authorization_code", code, redirect_uri: boatRedirectUri, code_verifier: pending.verifier },
      "Boat did not accept the sign-in. Connect again.",
    );
    const now = Date.now();
    // Connecting again replaces an earlier connection, whose access is given up rather than left alive on Boat.
    const earlier = this.saved();
    this.save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + tokens.expires_in * 1000,
      refreshedAt: now,
      connectedAt: now,
      account: await this.account(tokens.access_token),
    });
    if (earlier) await this.revoke(earlier.refreshToken);
    return pending.back;
  }

  /** Only shown to the person, so a failure leaves it out rather than failing the connect. */
  private async account(accessToken: string): Promise<string | null> {
    try {
      const response = await this.fetcher(meUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const { user } = (await response.json()) as { user?: { email?: string | null; login?: string | null } };
      return user?.email || user?.login || null;
    } catch {
      return null;
    }
  }

  /**
   * Forgets the tokens, then revokes VM Bridge's access on Boat. Forgets them even when Boat cannot be reached, and
   * returns false then, so the person can end the access on Boat themselves.
   */
  async disconnect(): Promise<boolean> {
    const saved = this.saved();
    this.save(null);
    return saved ? await this.revoke(saved.refreshToken) : true;
  }

  private async revoke(refreshToken: string): Promise<boolean> {
    try {
      const response = await this.fetcher(revokeUrl, {
        method: "POST",
        body: new URLSearchParams({ token: refreshToken, client_id: boatClientId }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async token(): Promise<string> {
    let saved = this.saved();
    if (!saved) throw lost();
    if (saved.expiresAt - Date.now() < refreshEarlyMs) {
      await this.refresh();
      saved = this.saved();
      if (!saved) throw lost();
    }
    return saved.accessToken;
  }

  /** For a daily job: refreshes a connection nothing has used for a day, so its refresh token never sits unused. */
  async keepFresh(): Promise<void> {
    const saved = this.saved();
    if (saved && Date.now() - saved.refreshedAt > idleRefreshMs) await this.refresh();
  }

  /** One refresh at a time. Calls while one runs wait for it. */
  refresh(): Promise<void> {
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** The secrets errors must never show. */
  secretValues(): string[] {
    const saved = this.saved();
    return saved ? [saved.accessToken, saved.refreshToken] : [];
  }

  private async refreshNow() {
    const saved = this.saved();
    if (!saved) throw lost();
    // Requests sent with the access token a refresh just replaced fail with 401 and ask again. The new one is fine.
    if (Date.now() - saved.refreshedAt < 30_000) return;
    const tokens = await this.tokens({ grant_type: "refresh_token", refresh_token: saved.refreshToken }, null);
    // A disconnect or a new connect while Boat answered wins: these tokens belong to a connection that is gone.
    const current = this.saved();
    if (current?.refreshToken !== saved.refreshToken || current.connectedAt !== saved.connectedAt) return;
    const now = Date.now();
    this.save({ ...saved, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: now + tokens.expires_in * 1000, refreshedAt: now });
  }

  /**
   * One call to Boat's token endpoint. A response that never arrived is sent again, unchanged, within Boat's minute.
   * A refused refresh token means Boat ended the connection, so it is forgotten.
   */
  private async tokens(form: Record<string, string>, refused: string | null): Promise<TokenResponse> {
    const body = new URLSearchParams({ ...form, client_id: boatClientId }).toString();
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null;
      try {
        response = await this.fetcher(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // Lost on the way, or timed out: sent again below.
      }
      if (response && response.status < 500) {
        const json = (await response.json().catch(() => null)) as (Partial<TokenResponse> & { error?: string }) | null;
        if (response.ok && json?.access_token && json.refresh_token && typeof json.expires_in === "number") return json as TokenResponse;
        if (refused !== null) throw new BoatSignInError("refused", refused);
        if (json?.error === "invalid_grant") {
          // Unless a new connect replaced it meanwhile.
          if (this.saved()?.refreshToken === form.refresh_token) this.save(null);
          throw lost();
        }
        throw new SandboxError(`Boat refused to refresh VM Bridge's access (HTTP ${response.status}).`, { code: "auth", provider: "boat" });
      }
      // Every resend must reach Boat inside its minute: a wait that would end past it is not taken, and a wait that
      // ran late (a paused process, a slow timer) sends nothing.
      const wait = 1_000 * 2 ** attempt;
      if (Date.now() + wait - started > resendWindowMs) throw unanswered();
      await sleep(wait);
      if (Date.now() - started > resendWindowMs) throw unanswered();
    }
  }

}
