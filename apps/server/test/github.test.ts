import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchGitHubAccount, GitHubRejected } from "../src/github.ts";

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
