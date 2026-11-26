import type { GitHubAccount } from "@vmbridge/contracts";

export class GitHubRejected extends Error {}

/**
 * Headers for GitHub's REST API. GitHub answers 403 to a request with no User-Agent, and only some runtimes add one:
 * Bun does, Cloudflare Workers do not.
 */
export function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "vmbridge",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Reads the account a personal access token belongs to, with the token's scopes and expiry. */
export async function fetchGitHubAccount(token: string): Promise<GitHubAccount> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubRejected("Could not reach GitHub.");
  }
  if (response.status === 401) throw new GitHubRejected("GitHub rejected that token.");
  if (!response.ok) throw new GitHubRejected(`GitHub answered ${response.status}.`);
  const user = (await response.json()) as { id: number; login: string; name: string | null; avatar_url: string; html_url: string };
  // Classic tokens list their scopes in this header. Fine-grained tokens send none.
  const scopes = response.headers.get("x-oauth-scopes");
  // For example "2026-12-21 10:00:00 UTC". Missing when the token never expires.
  const expiration = response.headers.get("github-authentication-token-expiration");
  const expiresAt = expiration ? Date.parse(expiration.replace(" UTC", "Z").replace(" ", "T")) : NaN;
  return {
    login: user.login,
    name: user.name || null,
    avatarUrl: user.avatar_url,
    profileUrl: user.html_url,
    // GitHub's private address for the account. Commits link to the account without exposing an email,
    // and pushes still work when the account blocks pushes that expose a private email.
    email: `${user.id}+${user.login}@users.noreply.github.com`,
    scopes: scopes === null ? null : scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
    expiresAt: Number.isNaN(expiresAt) ? null : expiresAt,
    checkedAt: Date.now(),
  };
}

/** `owner/name` of repositories the token can reach, most recently pushed first. */
export async function fetchGitHubRepos(token: string): Promise<string[]> {
  const response = await fetch("https://api.github.com/user/repos?per_page=100&sort=pushed", {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new GitHubRejected("Could not reach GitHub.");
  });
  if (!response.ok) throw new GitHubRejected(`GitHub answered ${response.status}.`);
  return ((await response.json()) as { full_name: string }[]).map((repo) => repo.full_name);
}
