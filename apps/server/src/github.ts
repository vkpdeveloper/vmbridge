import type { GitHubAccount, PullRequest, PullRequestStatus } from "@vmbridge/contracts";

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

/**
 * The pull request from `branch` of `repository` (`owner/name`), the newest when there were several, or null when it
 * has none or GitHub did not answer in time.
 */
export async function fetchPullRequest(repository: string, branch: string, token?: string): Promise<PullRequest | null> {
  const owner = repository.split("/")[0];
  const query = new URLSearchParams({ head: `${owner}:${branch}`, state: "all", per_page: "1" });
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls?${query}`, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const [pull] = (await response.json().catch(() => [])) as { number: number; html_url: string; state: string; draft?: boolean; merged_at: string | null }[];
  if (!pull) return null;
  const state = pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open";
  return { number: pull.number, url: pull.html_url, state };
}

const checksQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

const checksByState: Record<string, PullRequestStatus["checks"]> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "running", EXPECTED: "running" };
const reviewByDecision: Record<string, PullRequestStatus["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

/**
 * `fetchPullRequest` with the last commit's checks and the review decision. Those come from GitHub's GraphQL API,
 * which needs a token, and only matter while the pull request is open, so they are null otherwise.
 */
export async function fetchPullRequestStatus(repository: string, branch: string, token?: string): Promise<PullRequestStatus | null> {
  const pull = await fetchPullRequest(repository, branch, token);
  if (!pull) return null;
  const none = { ...pull, checks: null, review: null };
  if (!token || (pull.state !== "open" && pull.state !== "draft")) return none;
  const [owner, name] = repository.split("/");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query: checksQuery, variables: { owner, name, number: pull.number } }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response?.ok) return none;
  type Answer = {
    data?: { repository?: { pullRequest?: { reviewDecision: string | null; commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } } | null } | null };
  };
  const found = ((await response.json().catch(() => ({}))) as Answer).data?.repository?.pullRequest;
  const rollup = found?.commits.nodes[0]?.commit.statusCheckRollup?.state;
  const decision = found?.reviewDecision;
  return { ...pull, checks: (rollup ? checksByState[rollup] : undefined) ?? null, review: (decision ? reviewByDecision[decision] : undefined) ?? null };
}
