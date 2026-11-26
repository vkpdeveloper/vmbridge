// VM Bridge's own releases on GitHub: the dashboard's update notice and `vmbridge update` both read them.

import { githubHeaders } from "./github.ts";
import type { Job } from "./jobs.ts";
import type { Settings } from "./settings.ts";

export const releaseRepo = "vkpdeveloper/vmbridge";

/** Checked at most this often for the dashboard, since GitHub limits requests without a token to 60 an hour. */
export const releaseCheckMs = 6 * 60 * 60_000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The latest release's version, such as 1.2.0, from its tag. GitHub leaves drafts and prereleases out of "latest". */
export async function latestVersion(fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher(`https://api.github.com/repos/${releaseRepo}/releases/latest`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked for the latest release.`);
  const { tag_name: tag } = (await response.json()) as { tag_name?: unknown };
  if (typeof tag !== "string" || !parse(tag)) throw new Error("The latest release has no version tag.");
  return tag.replace(/^v/, "");
}

function parse(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(version.trim());
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined } : null;
}

/** Whether `candidate` is a later version than `current`. 1.2.0 is later than 1.2.0-beta.1; text that is not a version never is. */
export function isNewer(candidate: string, current: string): boolean {
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i++) {
    if (next.numbers[i] !== now.numbers[i]) return next.numbers[i]! > now.numbers[i]!;
  }
  return now.prerelease && !next.prerelease;
}

/** The SHA-256 a SHA256SUMS file lists for `file`, with lines like `<hash>  <file>` or `<hash> *<file>`. */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === file) return match[1]!.toLowerCase();
  }
  return null;
}

/**
 * The dashboard's update notice: a job that asks GitHub for the latest release at most every releaseCheckMs and saves
 * the answer, and the newer release it found, if any.
 */
export function releaseCheck(settings: Settings, current: string, fetcher: Fetcher = fetch) {
  const job: Job = {
    name: "release check",
    everyMs: 60 * 60_000,
    run: async () => {
      const saved = settings.get("latestRelease");
      if (saved && Date.now() - saved.checkedAt < releaseCheckMs) return;
      // Offline or limited by GitHub: the next hourly run tries again.
      const latest = await latestVersion(fetcher).catch(() => null);
      if (latest) settings.set("latestRelease", { version: latest, checkedAt: Date.now() });
    },
  };
  const available = () => {
    const latest = settings.get("latestRelease")?.version;
    return latest && isNewer(latest, current) ? latest : null;
  };
  return { job, available };
}
