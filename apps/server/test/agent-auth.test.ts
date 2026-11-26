import { afterEach, describe, expect, test } from "bun:test";
import { AgentAuth, InvalidSignIn } from "../src/agent-auth/profiles.ts";
import type { CodexAuthFile } from "../src/agent-auth/codex.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Settings } from "../src/settings.ts";
import { prepareVm } from "../src/vm/runtime.ts";
import { recordingBox } from "./vm-program.ts";
import { testEncryption } from "./key.ts";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

/** Answers every request with `answer`, and records what was asked. */
function fakeFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return calls;
}

function setup() {
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  return { db, settings, auth: new AgentAuth(db, settings, testEncryption) };
}

const stored = (db: ReturnType<typeof openDatabase>, id: string) =>
  db.one<{ profile: string; codexAuth: string | null }>("SELECT profile, codex_auth AS codexAuth FROM agent_profiles WHERE id = ?", id)!;

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function codexFile(account: string, refresh: string, expiresInMs: number, lastRefresh = new Date()): CodexAuthFile {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: `${account}@example.com`, "https://api.openai.com/auth": { chatgpt_account_id: account } }),
      access_token: jwt({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }),
      refresh_token: refresh,
      account_id: account,
    },
    last_refresh: lastRefresh.toISOString(),
  };
}

const day = 24 * 60 * 60_000;

/** Signs in to Codex through the device flow, answering each OpenAI step. */
async function signInCodex(auth: AgentAuth, file: CodexAuthFile) {
  fakeFetch((url) => {
    if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: "0" });
    if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_challenge: "c", code_verifier: "v" });
    return Response.json(file.tokens);
  });
  const login = await auth.startCodexLogin("");
  for (let i = 0; i < 50 && auth.codexLogin(login.id)?.status === "pending"; i++) await Bun.sleep(5);
  expect(auth.codexLogin(login.id)?.status).toBe("done");
}

describe("agent sign-in profiles", () => {
  test("keeps tokens encrypted and never lists them", async () => {
    const { db, auth } = setup();
    fakeFetch(() => Response.json({ data: [] }));
    const profile = await auth.addToken({ agent: "opencode", method: "api-key", name: "Work", token: "oc-secret" });

    expect(profile).toMatchObject({ id: "opencode-work", agent: "opencode", inUse: true, error: null });
    expect(JSON.stringify(auth.list())).not.toContain("oc-secret");
    expect(stored(db, "opencode-work").profile).not.toContain("oc-secret");
    expect(await auth.vmSecrets()).toEqual({ opencodeApiKey: "oc-secret" });
  });

  test("rejects a token its service refuses", async () => {
    const { auth } = setup();
    const calls = fakeFetch(() => new Response("{}", { status: 401 }));
    const adding = auth.addToken({ agent: "claude", method: "auth-token", name: "", token: "bad", baseUrl: "https://proxy.example.com/" });
    expect(adding).rejects.toBeInstanceOf(InvalidSignIn);
    await adding.catch(() => {});
    expect(calls[0]?.url).toBe("https://proxy.example.com/v1/models");
    expect(auth.list()).toEqual([]);
  });

  test("one Claude profile in use at a time, and removing it hands over to the next", async () => {
    const { auth } = setup();
    fakeFetch(() => Response.json({ data: [] }));
    const subscription = await auth.addToken({ agent: "claude", method: "setup-token", name: "Personal", token: "sk-ant-oat01-x" });
    const proxy = await auth.addToken({ agent: "claude", method: "auth-token", name: "Proxy", token: "proxy-token", baseUrl: "https://proxy.example.com" });
    expect(await auth.vmSecrets()).toEqual({ claudeOAuthToken: "sk-ant-oat01-x" });

    auth.use(proxy.id);
    expect(await auth.vmSecrets()).toEqual({ anthropicAuthToken: "proxy-token", anthropicBaseUrl: "https://proxy.example.com" });

    auth.remove(proxy.id);
    expect(auth.list().map((profile) => [profile.id, profile.inUse])).toEqual([[subscription.id, true]]);
  });

  test("works with numeric setTimeout handles without unref (Workers)", async () => {
    const { auth } = setup();
    const delays: number[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    globalThis.setTimeout = ((_fn: (...args: unknown[]) => void, ms = 0) =>
      delays.push(ms) as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout;
    try {
      expect(auth.startClaudeLogin().id).toBeTruthy();
      await signInCodex(auth, codexFile("acct-1", "refresh-1", 10 * day));
      await Bun.sleep(5);
      expect(delays).toEqual([15 * 60_000, 10 * 60_000]);
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("Claude sign-in", () => {
  test("swaps the pasted code for a one-year token, like claude setup-token", async () => {
    const { auth } = setup();
    const login = auth.startClaudeLogin();
    const url = new URL(login.url);
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("user:inference");
    const state = url.searchParams.get("state")!;

    const calls = fakeFetch((target) =>
      target.endsWith("/oauth/token") ? Response.json({ access_token: "sk-ant-oat01-new", account: { email_address: "me@example.com" } }) : Response.json({ data: [] }),
    );
    const profile = await auth.finishClaudeLogin(login.id, ` the-code#${state} `, "");

    const exchange = JSON.parse(String(calls[0]?.init?.body));
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: "the-code", state, expires_in: 365 * 24 * 60 * 60 });
    expect(calls[1]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(profile).toMatchObject({ agent: "claude", method: "setup-token", name: "Claude subscription", detail: "me@example.com", inUse: true });
    expect(await auth.vmSecrets()).toEqual({ claudeOAuthToken: "sk-ant-oat01-new" });
    // A code works once, so the sign-in is gone.
    expect(auth.finishClaudeLogin(login.id, `the-code#${state}`, "")).rejects.toThrow("expired");
  });

  test("refuses a code from another sign-in without sending it", async () => {
    const { auth } = setup();
    const calls = fakeFetch(() => Response.json({}));
    const login = auth.startClaudeLogin();
    expect(auth.finishClaudeLogin(login.id, "the-code#someone-else", "")).rejects.toBeInstanceOf(InvalidSignIn);
    expect(calls).toHaveLength(0);
  });
});

describe("Codex sign-in", () => {
  test("device sign-in saves a Codex auth.json", async () => {
    const { db, auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", 10 * day));
    const [profile] = auth.list();
    expect(profile).toMatchObject({ id: "codex-chatgpt-account", agent: "codex", method: "chatgpt", name: "ChatGPT account", detail: "acct-1@example.com", inUse: true });
    const { codexAuth } = stored(db, profile!.id);
    expect(codexAuth).not.toContain("refresh-1");
    const saved = JSON.parse(testEncryption.open(codexAuth!, `auths/${profile!.id}/auth.json`)) as CodexAuthFile;
    expect(saved).toMatchObject({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { refresh_token: "refresh-1", account_id: "acct-1" } });
  });

  test("refreshes once when close to expiry, and VMs get the new tokens", async () => {
    const { auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    expect(auth.codexDue()).toBe(true);
    const fresh = codexFile("acct-1", "refresh-2", 10 * day);
    const calls = fakeFetch(() => Response.json(fresh.tokens));

    const [a, b] = await Promise.all([auth.refreshCodex(true), auth.refreshCodex(true)]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    expect(JSON.parse(a!).tokens.refresh_token).toBe("refresh-2");
    expect(b).toBeUndefined();
    expect(JSON.parse((await auth.vmSecrets()).codexAuthJson!).tokens.refresh_token).toBe("refresh-2");
  });

  test("a refresh token OpenAI retired marks the profile to sign in again", async () => {
    const { auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    fakeFetch(() => Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 }));
    expect(await auth.refreshCodex(true)).toBeUndefined();
    expect(auth.list()[0]?.error).toContain("Sign in again");
    expect(auth.codexDue()).toBe(false);
  });

  /** The refresh token VM Bridge holds, read without refreshing it. */
  const bridgeRefreshToken = (db: ReturnType<typeof openDatabase>) => {
    const id = "codex-chatgpt-account";
    return (JSON.parse(testEncryption.open(stored(db, id).codexAuth!, `auths/${id}/auth.json`)) as CodexAuthFile).tokens.refresh_token;
  };

  const accountsCheck = "https://chatgpt.com/backend-api/wham/accounts/check";
  /** ChatGPT's answer to the accounts check: the accounts the access token can use. */
  const accounts = (...ids: string[]) => () => Response.json({ accounts: ids.map((id) => ({ id })), account_ordering: ids, default_account_id: ids[0] ?? null });
  const newer = (refresh: string) => JSON.stringify(codexFile("acct-1", refresh, 10 * day, new Date(Date.now() + 60_000)));

  test("takes tokens a VM refreshed itself once ChatGPT accepts its access token for the same account", async () => {
    const { db, auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    const calls = fakeFetch(accounts("acct-1"));
    expect(await auth.adoptCodex(JSON.stringify(codexFile("acct-2", "other", 10 * day)), "vm-1")).toBe(false);
    expect(await auth.adoptCodex(JSON.stringify(codexFile("acct-1", "older", 10 * day, new Date(Date.now() - 5 * day))), "vm-1")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(bridgeRefreshToken(db)).toBe("refresh-1");

    const fromVm = codexFile("acct-1", "from-vm", 10 * day, new Date(Date.now() + 60_000));
    expect(await auth.adoptCodex(JSON.stringify(fromVm), "vm-1")).toBe(true);
    // One read-only check with the VM's access token. No refresh, so Codex on the VM keeps a working refresh token.
    expect(calls.map((call) => call.url)).toEqual([accountsCheck]);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${fromVm.tokens.access_token}`);
    expect(auth.codexDue()).toBe(false);
    expect(bridgeRefreshToken(db)).toBe("from-vm");
  });

  test("keeps only the sign-in from a VM's file, so a key planted next to real tokens reaches no other VM", async () => {
    const { db, auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    fakeFetch(accounts("acct-1"));
    const planted = { ...JSON.parse(newer("from-vm")), auth_mode: "apikey", OPENAI_API_KEY: "sk-planted", base_url: "https://elsewhere.example" };
    expect(await auth.adoptCodex(JSON.stringify(planted), "vm-1")).toBe(true);
    const [profile] = auth.list();
    const saved = JSON.parse(testEncryption.open(stored(db, profile!.id).codexAuth!, `auths/${profile!.id}/auth.json`));
    expect(Object.keys(saved).sort()).toEqual(["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"]);
    expect(saved).toEqual({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: planted.tokens, last_refresh: planted.last_refresh });
  });

  test("ignores a VM's file with a made-up date, expiry or refresh token without asking ChatGPT", async () => {
    const { db, auth } = setup();
    const signedIn = codexFile("acct-1", "refresh-1", day);
    await signInCodex(auth, signedIn);
    const calls = fakeFetch(accounts("acct-1"));
    const farFuture = codexFile("acct-1", "attacker", 10 * day, new Date("9999-01-01T00:00:00Z"));
    const notADate = { ...codexFile("acct-1", "attacker", 10 * day), last_refresh: "not a date" };
    const longLived = codexFile("acct-1", "attacker", 365 * day, new Date(Date.now() + 60_000));
    // The access token VM Bridge gave out, still valid, paired with a refresh token that is not.
    const swapped = { ...signedIn, tokens: { ...signedIn.tokens, refresh_token: "attacker" }, last_refresh: new Date(Date.now() + 60_000).toISOString() };
    for (const file of [farFuture, notADate, longLived, swapped]) expect(await auth.adoptCodex(JSON.stringify(file), "vm-1")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(bridgeRefreshToken(db)).toBe("refresh-1");
    expect(auth.codexDue()).toBe(true);
  });

  test("keeps its own tokens when ChatGPT refuses the VM's access token, or it belongs to another account", async () => {
    const { db, auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    fakeFetch(() => new Response("{}", { status: 401 }));
    expect(await auth.adoptCodex(newer("forged"), "vm-1")).toBe(false);
    // The file claims acct-1, but ChatGPT says its access token is for someone else.
    fakeFetch(accounts("acct-other"));
    expect(await auth.adoptCodex(newer("foreign"), "vm-2")).toBe(false);
    fakeFetch(() => Response.json({ accounts: [{ id: "acct-1", is_deactivated: true }] }));
    expect(await auth.adoptCodex(newer("deactivated"), "vm-3")).toBe(false);

    expect(bridgeRefreshToken(db)).toBe("refresh-1");
    expect(auth.list()[0]?.error).toBeNull();
    expect(auth.codexDue()).toBe(true);
  });

  test("asks ChatGPT about each VM's file at most once in a while", async () => {
    const { auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    const calls = fakeFetch(() => new Response("{}", { status: 401 }));
    await auth.adoptCodex(newer("forged-1"), "vm-1");
    await auth.adoptCodex(newer("forged-2"), "vm-1");
    expect(calls).toHaveLength(1);
    await auth.adoptCodex(newer("from-vm-2"), "vm-2");
    expect(calls).toHaveLength(2);
  });

  test("VMs tell a new Codex sign-in apart from a token refresh", async () => {
    const { auth } = setup();
    await signInCodex(auth, codexFile("acct-1", "refresh-1", day));
    const first = (await auth.vmSecrets()).codexSignIn;
    fakeFetch(() => Response.json(codexFile("acct-1", "refresh-2", 10 * day).tokens));
    await auth.refreshCodex(true);
    expect((await auth.vmSecrets()).codexSignIn).toBe(first!);

    await Bun.sleep(2);
    await signInCodex(auth, codexFile("acct-1", "refresh-3", 10 * day));
    expect((await auth.vmSecrets()).codexSignIn).not.toBe(first!);
  });
});

describe("VM sign-ins", () => {
  test("VMs get only VM Bridge sign-ins, with provider ones cleared", async () => {
    const { box, written, commands } = recordingBox();
    await prepareVm(box, "1.0.0", { claudeOAuthToken: "sk-ant-oat01-x", codexAuthJson: "{}" }, "fingerprint");
    const env = written["/workspace/.vmbridge/env"]!;
    expect(env.split("\n")[0]).toContain("GH_TOKEN GITHUB_TOKEN");
    expect(env.split("\n")[0]).toContain("ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY");
    expect(env).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-x'");
    expect(env).toContain("export CODEX_HOME='/workspace/.vmbridge/codex'");
    expect(env).toContain("export CLAUDE_CONFIG_DIR='/workspace/.vmbridge/claude'");
    expect(env).not.toContain("OPENCODE_API_KEY=");
    // Moved into place in the VM unless Codex there refreshed it later.
    expect(written["/workspace/.vmbridge/codex/auth.json.incoming"]).toBe("{}");
    expect(commands).toEqual(["bash -s"]);
    // Without a GitHub token, the provider's GitHub helpers are still switched off.
    expect(written["/workspace/.vmbridge/gitconfig"]).toBe('[credential "https://github.com"]\n\thelper =\n');
  });

  test("git on the VM uses the GitHub token, the account's name and its noreply email", async () => {
    const { box, written } = recordingBox();
    const github = { token: "github_pat_abc", login: "octo-cat", name: 'Mona "Octo" Lisa', email: "1+octo-cat@users.noreply.github.com" };
    await prepareVm(box, "1.0.0", { github }, "fingerprint");
    expect(written["/workspace/.vmbridge/git-credentials"]).toBe("https://octo-cat:github_pat_abc@github.com\n");
    const config = written["/workspace/.vmbridge/gitconfig"]!;
    expect(config).toContain("\thelper = store --file /workspace/.vmbridge/git-credentials");
    expect(config).toContain('\tname = "Mona \\"Octo\\" Lisa"');
    expect(config).toContain('\temail = "1+octo-cat@users.noreply.github.com"');
    expect(config).toContain("\tinsteadOf = git@github.com:");
    expect(written["/workspace/.vmbridge/env"]).toContain("export GH_TOKEN='github_pat_abc'");
  });
});
