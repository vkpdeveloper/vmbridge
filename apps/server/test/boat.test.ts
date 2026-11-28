import { describe, expect, test } from "bun:test";
import { boat } from "../src/providers/boat.ts";
import { BoatSignIn, boatClientId } from "../src/providers/boat-sign-in.ts";
import type { Credentials } from "../src/providers/types.ts";
import { GET as relay } from "../../landing/app/boat/callback/route.ts";

/** Secrets kept in memory, as the database would keep them. */
function memorySecrets() {
  const values = new Map<string, string>();
  return {
    values,
    get: (name: string) => values.get(name),
    set: (name: string, value: string | null) => void (value ? values.set(name, value) : values.delete(name)),
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const tokens = (n: number) => ({ access_token: `boat_access_${n}`, refresh_token: `boatrt_${n}`, token_type: "Bearer", expires_in: 3600 });
const form = (init: RequestInit) => new URLSearchParams(String(init.body));

/** Starts a connect and finishes it the way Boat's page would come back. */
async function connected(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  const secrets = memorySecrets();
  const signIn = new BoatSignIn(secrets, fetcher);
  const authorize = new URL(await signIn.start("https://bridge.example.ts.net", "/dashboard?view=accounts"));
  await signIn.finish(new URLSearchParams({ code: "code_1", state: authorize.searchParams.get("state")!, iss: "https://boat.dev" }));
  return { secrets, signIn, authorize };
}

/** Moves the saved access token to just before it expires, as an hour later. */
function expireSoon(secrets: ReturnType<typeof memorySecrets>) {
  const saved = JSON.parse(secrets.values.get("provider.boat.signIn")!);
  secrets.values.set("provider.boat.signIn", JSON.stringify({ ...saved, expiresAt: Date.now() + 60_000, refreshedAt: Date.now() - 3_600_000 }));
}

describe("Boat sign-in", () => {
  test("a connect sends Boat a PKCE challenge, and the callback trades the code with its verifier", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { signIn, authorize } = await connected(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return json(tokens(1));
      return json({ ok: true, user: { login: "someone", email: "someone@example.com" } });
    });

    const params = authorize.searchParams;
    expect(params.get("client_id")).toBe(boatClientId);
    expect(params.get("code_challenge_method")).toBe("S256");
    // No environments (whose secrets come with them), and no deleting VMs it did not create.
    expect(params.get("scope")!.split(" ")).not.toContainAnyValues(["environment.read", "sandbox.delete"]);
    // The callback page finds the install from the state alone.
    expect(atob(params.get("state")!.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/"))).toBe("https://bridge.example.ts.net");

    const exchange = form(calls[0]!.init);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("client_secret")).toBeNull();
    const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier")!)));
    expect(Buffer.from(challenge).toString("base64url")).toBe(params.get("code_challenge")!);

    expect(signIn.status()).toEqual({ connected: true, account: "someone@example.com" });
    expect(await signIn.token()).toBe("boat_access_1");
  });

  test("a callback with another state connects nothing, and a state works only once", async () => {
    const secrets = memorySecrets();
    const signIn = new BoatSignIn(secrets, async () => json(tokens(1)));
    const state = new URL(await signIn.start("https://bridge.example", "/dashboard")).searchParams.get("state")!;

    await expect(signIn.finish(new URLSearchParams({ code: "c", state: `${state}x` }))).rejects.toThrow("not for this VM Bridge");
    expect(signIn.status().connected).toBe(false);
    // A stranger's link does not spoil the person's own.
    expect(await signIn.finish(new URLSearchParams({ code: "c", state }))).toBe("/dashboard");
    await expect(signIn.finish(new URLSearchParams({ code: "c", state }))).rejects.toThrow("not for this VM Bridge");
  });

  test("requests that all find the token expiring share one refresh, and the rotated refresh token replaces the old", async () => {
    let refreshes = 0;
    const sent: string[] = [];
    const { secrets, signIn } = await connected(async (url, init) => {
      if (!url.endsWith("/oauth2/token")) return json({ user: { login: "a" } });
      if (form(init).get("grant_type") === "authorization_code") return json(tokens(1));
      refreshes++;
      sent.push(form(init).get("refresh_token")!);
      await Bun.sleep(20);
      return json(tokens(2));
    });
    expireSoon(secrets);

    expect(await Promise.all([signIn.token(), signIn.token(), signIn.token()])).toEqual(["boat_access_2", "boat_access_2", "boat_access_2"]);
    expect(refreshes).toBe(1);
    expect(sent).toEqual(["boatrt_1"]);
    expect(JSON.parse(secrets.values.get("provider.boat.signIn")!).refreshToken).toBe("boatrt_2");
  });

  test("a refresh whose answer was lost is sent again unchanged", async () => {
    const sent: string[] = [];
    const { secrets, signIn } = await connected(async (url, init) => {
      if (!url.endsWith("/oauth2/token")) return json({ user: { login: "a" } });
      if (form(init).get("grant_type") === "authorization_code") return json(tokens(1));
      sent.push(String(init.body));
      if (sent.length === 1) throw new TypeError("fetch failed");
      return json(tokens(2));
    });
    expireSoon(secrets);

    expect(await signIn.token()).toBe("boat_access_2");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]!);
  });

  test("the daily job refreshes only a connection nothing has used for a day", async () => {
    let refreshes = 0;
    const { secrets, signIn } = await connected(async (url, init) => {
      if (!url.endsWith("/oauth2/token")) return json({ user: { login: "a" } });
      if (form(init).get("grant_type") === "authorization_code") return json(tokens(1));
      refreshes++;
      return json(tokens(2));
    });
    await signIn.keepFresh();
    expect(refreshes).toBe(0);

    const saved = JSON.parse(secrets.values.get("provider.boat.signIn")!);
    secrets.values.set("provider.boat.signIn", JSON.stringify({ ...saved, refreshedAt: Date.now() - 25 * 3_600_000 }));
    await signIn.keepFresh();
    expect(refreshes).toBe(1);
    expect(await signIn.token()).toBe("boat_access_2");
  });

  test("a disconnect while a refresh is on its way is not undone by the refresh's answer", async () => {
    let answer = () => {};
    const { secrets, signIn } = await connected(async (url, init) => {
      if (url.endsWith("/oauth2/revoke")) return new Response(null, { status: 200 });
      if (!url.endsWith("/oauth2/token")) return json({ user: { login: "a" } });
      if (form(init).get("grant_type") === "authorization_code") return json(tokens(1));
      await new Promise<void>((resolve) => (answer = resolve));
      return json(tokens(2));
    });
    expireSoon(secrets);
    const refresh = signIn.refresh();
    await Bun.sleep(5);
    expect(await signIn.disconnect()).toBe(true);
    answer();
    await refresh;
    expect(signIn.status().connected).toBe(false);
  });

  test("connecting again gives up the earlier connection's access on Boat", async () => {
    const revoked: string[] = [];
    let n = 0;
    const fetcher = async (url: string, init: RequestInit) => {
      if (url.endsWith("/oauth2/revoke")) {
        revoked.push(form(init).get("token")!);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/oauth2/token")) return json(tokens(++n));
      return json({ user: { login: "a" } });
    };
    const { signIn } = await connected(fetcher);
    const state = new URL(await signIn.start("https://bridge.example.ts.net", "/dashboard")).searchParams.get("state")!;
    await signIn.finish(new URLSearchParams({ code: "code_2", state }));
    expect(revoked).toEqual(["boatrt_1"]);
    expect(await signIn.token()).toBe("boat_access_2");
  });

  test("a refresh token Boat refuses ends the connection", async () => {
    const { secrets, signIn } = await connected(async (url, init) => {
      if (!url.endsWith("/oauth2/token")) return json({ user: { login: "a" } });
      if (form(init).get("grant_type") === "authorization_code") return json(tokens(1));
      return json({ error: "invalid_grant", error_description: "revoked" }, 400);
    });
    expireSoon(secrets);

    await expect(signIn.token()).rejects.toThrow("Connect Boat again");
    expect(signIn.status().connected).toBe(false);
  });
});

describe("Boat API", () => {
  /** A fake Boat API that runs one background command and streams its output, dropping the stream once. */
  function fakeBoat(firstStream?: string) {
    const calls: { method: string; path: string; body: string; authorization: string | null }[] = [];
    let streams = 0;
    let token = "boat_access_1";
    const credentials: Credentials = {
      token: async () => token,
      refresh: async () => {
        token = "boat_access_2";
      },
      secretValues: () => [token],
    };
    const fetch = async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const authorization = new Headers(init.headers).get("authorization");
      calls.push({ method: init.method ?? "GET", path, body: String(init.body ?? ""), authorization });
      if (authorization === "Bearer boat_access_1") return json({ error: { code: "unauthorized" } }, 401);
      if (path === "/sandboxes/sb_1/commands" && init.method === "POST") {
        const { detached } = JSON.parse(String(init.body)) as { detached?: boolean };
        return json(detached ? { processId: 7 } : { stdout: "", stderr: "", exitCode: 0 });
      }
      if (path === "/sandboxes/sb_1/files") return json({ ok: true });
      if (path === "/sandboxes/sb_1/commands/7/stream") {
        streams++;
        if (streams === 1 && firstStream !== undefined) return new Response(firstStream);
        const frames =
          streams === 1
            ? [{ type: "attached", stdoutOffset: 0, stderrOffset: 0 }, { type: "stdout", data: "hel", nextOffset: 3 }, { type: "reconnect", stdoutOffset: 3 }]
            : [{ type: "stdout", data: "hel", nextOffset: 3 }, { type: "stdout", data: "lo", nextOffset: 5 }, { type: "exit", exitCode: 3 }];
        return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
      }
      return json({}, 404);
    };
    return { calls, provider: boat({ credentials, fetch }) };
  }

  test("a command's secrets and stdin go up as files, never in the command Boat records, and output survives a reconnect", async () => {
    const { calls, provider } = fakeBoat();
    let output = "";
    const result = await provider.exec("sb_1", {
      command: "deploy",
      cwd: "/workspace",
      env: { CI: "1", API_TOKEN: "tok_very_secret" },
      stdin: "stdin_secret",
      timeoutMs: 10_000,
      onChunk: (chunk) => (output += chunk.text),
    });

    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(output).toBe("hello");
    const commands = calls.filter((call) => call.path === "/sandboxes/sb_1/commands").map((call) => call.body);
    for (const body of commands) {
      expect(body).not.toContain("tok_very_secret");
      expect(body).not.toContain("stdin_secret");
    }
    expect(commands.at(-1)).toContain("export CI='1'");
    const uploads = calls.filter((call) => call.path === "/sandboxes/sb_1/files").map((call) => Buffer.from(JSON.parse(call.body).content, "base64").toString());
    expect(uploads).toEqual(["export API_TOKEN='tok_very_secret'\n", "stdin_secret"]);
  });

  test("a frame cut off when the stream drops is not parsed: the follower reconnects and gets the output again", async () => {
    const { provider } = fakeBoat(`${JSON.stringify({ type: "stdout", data: "hel", nextOffset: 3 })}\n{"type":"stdout","da`);
    let output = "";
    const result = await provider.exec("sb_1", { command: "x", cwd: "/workspace", env: {}, timeoutMs: 10_000, onChunk: (chunk) => (output += chunk.text) });
    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(output).toBe("hello");
  });

  test("a refused token is refreshed once and the request sent again with the new one", async () => {
    const { calls, provider } = fakeBoat();
    await provider.files.mkdir("sb_1", "/tmp/x");
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer boat_access_1", "Bearer boat_access_2"]);
  });
});

describe("Boat callback page", () => {
  const callback = (state: string) => relay(new Request(`https://vmbridge.ordinity.com/boat/callback?code=c&state=${encodeURIComponent(state)}`));
  const stateFor = (origin: string) => `${Buffer.from(origin).toString("base64url")}.random`;

  test("asks before handing the code to the address in state, and never forwards it on its own", async () => {
    const response = callback(stateFor("https://attacker.example"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("https://attacker.example");
    expect(html).toContain('href="https://attacker.example/admin/api/providers/boat/callback?code=c&amp;state=');
  });

  test("refuses a state that is not an http(s) origin", async () => {
    for (const origin of ["javascript:alert(1)", "https://a.example/path", "https://user@a.example", "<script>"]) {
      expect(callback(stateFor(origin)).status).toBe(400);
    }
  });
});
