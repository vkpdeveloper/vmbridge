import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchGitHubAccount, fetchPullRequest, GitHubRejected } from "../src/github.ts";

const answer = (response: Response) => spyOn(globalThis, "fetch").mockResolvedValue(response);

afterEach(() => mock.restore());

describe("GitHub token check", () => {
  test("sends a User-Agent, which GitHub requires and Cloudflare Workers leave out", async () => {
    const fetch = answer(Response.json({ id: 1, login: "octocat", name: null, avatar_url: "", html_url: "" }));
    await fetchGitHubAccount("github_pat_right");
    const headers = new Headers(fetch.mock.calls[0]![1]!.headers);
    expect(headers.get("user-agent")).toBe("vmbridge");
    expect(headers.get("authorization")).toBe("Bearer github_pat_right");
  });

  test("a token GitHub refuses gives a plain error", async () => {
    answer(new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const check = fetchGitHubAccount("github_pat_wrong");
    await expect(check).rejects.toBeInstanceOf(GitHubRejected);
    await expect(check).rejects.toThrow("GitHub rejected that token.");
  });

  test("a fine-grained token reads its account and commits with the noreply address", async () => {
    answer(
      Response.json(
        { id: 583231, login: "octocat", name: "", avatar_url: "https://avatars.example/octocat", html_url: "https://github.com/octocat" },
        { headers: { "github-authentication-token-expiration": "2026-12-21 10:00:00 UTC" } },
      ),
    );
    const account = await fetchGitHubAccount("github_pat_right");
    expect(account).toMatchObject({
      login: "octocat",
      name: null,
      email: "583231+octocat@users.noreply.github.com",
      scopes: null,
      expiresAt: Date.UTC(2026, 11, 21, 10),
    });
  });
});

describe("a branch's pull request", () => {
  const pull = (fields: object) => Response.json([{ number: 142, html_url: "https://github.com/acme/forge/pull/142", state: "open", draft: false, merged_at: null, ...fields }]);

  test("is asked for by the branch in the repository's own account, in any state, and reads as GitHub shows it", async () => {
    const fetch = answer(pull({}));
    expect(await fetchPullRequest("acme/forge", "fix/login", "github_pat_right")).toEqual({ number: 142, url: "https://github.com/acme/forge/pull/142", state: "open" });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe("/repos/acme/forge/pulls");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ head: "acme:fix/login", state: "all" });

    answer(pull({ state: "closed", merged_at: "2026-11-27T10:00:00Z" }));
    expect((await fetchPullRequest("acme/forge", "fix/login"))?.state).toBe("merged");
    answer(pull({ state: "closed" }));
    expect((await fetchPullRequest("acme/forge", "fix/login"))?.state).toBe("closed");
    answer(pull({ draft: true }));
    expect((await fetchPullRequest("acme/forge", "fix/login"))?.state).toBe("draft");
  });

  test("is none when the branch has none, or GitHub does not answer", async () => {
    answer(Response.json([]));
    expect(await fetchPullRequest("acme/forge", "opencode/ab12cd34")).toBeNull();
    answer(new Response("", { status: 403 }));
    expect(await fetchPullRequest("acme/forge", "opencode/ab12cd34")).toBeNull();
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await fetchPullRequest("acme/forge", "opencode/ab12cd34")).toBeNull();
  });
});
