import { githubHeaders } from "../github.ts";
import type { ProjectRow } from "../store.ts";
import type { Wire } from "./types.ts";

/** `owner/name` for a github.com URL or shorthand (`owner/name`, `git@github.com:owner/name`). */
export function githubName(reference: string): string | undefined {
  const trimmed = reference.trim().replace(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/i, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed.replace(/\.git$/, "");
  const url = URL.parse(trimmed);
  const name = url?.pathname.replace(/^\/|\/+$/g, "").replace(/\.git$/, "");
  if (url?.hostname === "github.com" && name && /^[\w.-]+\/[\w.-]+$/.test(name)) return name;
}

export const githubRepository = (name: string) => ({
  provider: "github",
  nameWithOwner: name,
  url: `https://github.com/${name}`,
  sshUrl: `git@github.com:${name}.git`,
});

export function repositoryIdentity(project: Pick<ProjectRow, "url">, workspaceRoot: string) {
  const url = new URL(project.url);
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  const [owner, name] = path.slice(1).split("/");
  const github = url.hostname === "github.com" && owner && name;
  return {
    canonicalKey: url.host + (github ? path.toLowerCase() : path),
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: project.url },
    rootPath: workspaceRoot,
    webUrl: url.origin + path,
    displayName: path.slice(1),
    ...(github ? { provider: "github", owner, name } : {}),
  };
}

/** Accepts only plain HTTPS remotes on public hosts, so nothing odd reaches `git clone` on a VM. */
export function normalizeRemote(reference: string): string {
  const github = githubName(reference);
  if (github) return `https://github.com/${github}.git`;
  const url = URL.parse(reference.trim());
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/[\w./-]+$/.test(url.pathname)) {
    throw new Error("Use an HTTPS repository URL, such as https://github.com/owner/repo.");
  }
  if (!publicHost(url.hostname)) throw notPublic();
  return url.href;
}

const notPublic = () => new Error("VM Bridge reads repositories on public HTTPS hosts only.");

/**
 * IPv4 ranges that are not the public internet: this network, private, CGNAT (Tailscale), loopback, link-local,
 * protocol assignments, benchmarking, multicast and reserved.
 */
const privateIpv4: [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xe0000000, 3],
];

function publicIpv4(value: number): boolean {
  return !privateIpv4.some(([start, bits]) => value >>> (32 - bits) === start >>> (32 - bits));
}

/** The eight groups of an IPv6 address as the URL parser writes it: compressed, lowercase, no dotted IPv4. */
function ipv6Groups(address: string): number[] {
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...gap, ...right].map((group) => Number.parseInt(group, 16));
}

function publicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const [first = 0] = groups;
  const embedded = (high: number, low: number) => publicIpv4(((high << 16) | low) >>> 0);
  // Mapped (::ffff:a.b.c.d) and compatible (::a.b.c.d) IPv4 count as the IPv4 address, which covers :: and ::1 too.
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0 || groups[5] === 0xffff)) return embedded(groups[6]!, groups[7]!);
  // NAT64 and 6to4 also carry an IPv4 address.
  if (first === 0x64 && groups[1] === 0xff9b) return embedded(groups[6]!, groups[7]!);
  if (first === 0x2002) return embedded(groups[1]!, groups[2]!);
  // Unique local (Tailscale's too), link-local, site-local and multicast.
  return (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80 && (first & 0xffc0) !== 0xfec0 && (first & 0xff00) !== 0xff00;
}

/** Whether an IP address, as `URL` or DNS gives it, is on the public internet. Anything unparsable is not. */
export function publicAddress(address: string): boolean {
  const hostname = URL.parse(`https://${address.includes(":") ? `[${address}]` : address}/`)?.hostname;
  if (!hostname) return false;
  if (hostname.startsWith("[")) return publicIpv6(hostname.slice(1, -1));
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return publicIpv4(((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

/**
 * Whether a `URL.hostname` can be a public host. The URL parser has already turned every IPv4 spelling (decimal,
 * octal, shortened) into dotted form. A name passes unless it is local by definition; what it resolves to is
 * checked separately, where the runtime can resolve names.
 */
function publicHost(hostname: string): boolean {
  const name = hostname.replace(/\.$/, "").toLowerCase();
  if (name.startsWith("[") || /^[\d.]+$/.test(name)) return publicAddress(name.replace(/^\[|\]$/g, ""));
  // A single label resolves through the search domains of this machine's network, never to a public git host.
  return name.includes(".") && !name.endsWith(".localhost");
}

/** Every IP address a host name resolves to. Bun resolves before fetching; on Workers, fetch cannot reach private addresses. */
export type Resolve = (hostname: string) => Promise<string[]>;

interface Branches {
  names: string[];
  defaultBranch: string | null;
  at: number;
}

/** Remote branches for projects whose VM is asleep or not created yet. */
export class RemoteBranches {
  private readonly cache = new Map<string, Branches>();
  /** Lookups in flight by URL, so repeated refreshes share one. */
  private readonly pending = new Map<string, Promise<Branches>>();
  /** Lookups running per host, and the ones waiting for a turn. */
  private readonly hosts = new Map<string, { running: number; waiting: (() => void)[] }>();

  constructor(
    private readonly githubToken: () => string | undefined,
    private readonly resolve?: Resolve,
  ) {}

  async check(url: string) {
    await this.branches(url, true);
  }

  async branches(url: string, refresh = false): Promise<Branches> {
    const cached = this.cache.get(url);
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached;
    let lookup = this.pending.get(url);
    if (!lookup) {
      lookup = this.perHost(url, () => this.lookup(url)).finally(() => this.pending.delete(url));
      this.pending.set(url, lookup);
    }
    const branches = await lookup;
    this.cache.set(url, branches);
    return branches;
  }

  private lookup(url: string): Promise<Branches> {
    const github = githubName(url);
    if (!github) return lsRemote(url, { resolve: this.resolve });
    // Git's own protocol lists every branch in one request and has no API rate limit. The REST API is the fallback,
    // and explains a private or missing repository better.
    const token = this.githubToken();
    return lsRemote(`https://github.com/${github}.git`, { token, resolve: this.resolve }).catch(() => this.github(github, token));
  }

  /** Runs `lookup` once fewer than a few lookups are running against the URL's host, so one slow host cannot pile them up. */
  private async perHost<T>(url: string, lookup: () => Promise<T>): Promise<T> {
    const host = URL.parse(url)?.host ?? url;
    let slot = this.hosts.get(host);
    if (!slot) {
      slot = { running: 0, waiting: [] };
      this.hosts.set(host, slot);
    }
    // A finished lookup hands its turn straight to the next waiting one.
    if (slot.running < lookupsPerHost) slot.running++;
    else await new Promise<void>((resolve) => slot.waiting.push(resolve));
    try {
      return await lookup();
    } finally {
      const next = slot.waiting.shift();
      if (next) next();
      else if (--slot.running === 0) this.hosts.delete(host);
    }
  }

  private async github(name: string, token: string | undefined): Promise<Branches> {
    const headers = githubHeaders(token);
    const get = async <T>(path: string) => {
      const response = await fetch(`https://api.github.com/repos/${name}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) {
        throw new Error(token ? `GitHub has no repository ${name} that this account can read.` : `Repository ${name} is private or missing. Connect GitHub in the VM Bridge dashboard.`);
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${name}.`);
      return (await response.json()) as T;
    };
    const [repo, branches] = await Promise.all([
      get<{ default_branch: string }>(""),
      get<{ name: string }[]>("/branches?per_page=100"),
    ]);
    return { names: branches.map((branch) => branch.name).sort(), defaultBranch: repo.default_branch, at: Date.now() };
  }

  /** T3's `vcs.listRefs` result for a project with no reachable checkout. */
  async refs(project: ProjectRow, input: Wire) {
    const branches = await this.branches(project.url, input.refresh === true);
    const current = project.branch ?? branches.defaultBranch;
    const refs: Wire[] = [];
    if (current && input.refKind !== "remote") {
      refs.push({ name: current, current: true, isDefault: current === branches.defaultBranch, worktreePath: null });
    }
    if (input.refKind !== "local") {
      for (const name of branches.names) {
        if (name === current && !input.includeMatchingRemoteRefs && input.refKind !== "remote") continue;
        refs.push({
          name: `origin/${name}`,
          isRemote: true,
          remoteName: "origin",
          upstreamRef: `refs/remotes/origin/${name}`,
          current: false,
          isDefault: name === branches.defaultBranch,
          worktreePath: null,
        });
      }
    }
    const query = typeof input.query === "string" ? input.query.toLowerCase().trim() : "";
    const filtered = refs.filter((ref) => String(ref.name).toLowerCase().includes(query));
    const cursor = Number.isSafeInteger(input.cursor) ? Math.max(0, input.cursor as number) : 0;
    const limit = Number.isSafeInteger(input.limit) ? Math.min(200, Math.max(1, input.limit as number)) : 50;
    return {
      refs: filtered.slice(cursor, cursor + limit),
      isRepo: true,
      isAtRepositoryRoot: true,
      hasPrimaryRemote: true,
      totalCount: filtered.length,
      nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
    };
  }

  /** A VCS status for a checkout VM Bridge cannot read right now. It never claims the tree is clean or dirty in detail. */
  async status(project: ProjectRow, cwd: string) {
    const branches = await this.branches(project.url).catch(() => null);
    const refName = project.branch ?? branches?.defaultBranch ?? null;
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: refName !== null && refName === branches?.defaultBranch,
      refName,
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      ...(githubName(project.url) ? { sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" } } : {}),
    };
  }
}

const decoder = new TextDecoder();

/**
 * Git pkt-lines without their trailing newline. Flush, delimiter and response-end packets are null. Throws on a
 * malformed or cut-off packet, and on an `ERR` packet, which ends the exchange.
 */
export function pktLines(bytes: Uint8Array): (string | null)[] {
  const unreadable = () => new Error("The repository sent an unreadable answer.");
  const lines: (string | null)[] = [];
  let at = 0;
  while (at < bytes.length) {
    const header = decoder.decode(bytes.subarray(at, at + 4));
    if (!/^[0-9a-f]{4}$/i.test(header)) throw unreadable();
    const length = Number.parseInt(header, 16);
    if (length <= 2) {
      lines.push(null);
      at += 4;
      continue;
    }
    if (length < 4 || at + length > bytes.length) throw unreadable();
    const line = decoder.decode(bytes.subarray(at + 4, at + length)).replace(/\n$/, "");
    if (line.startsWith("ERR ")) throw new Error("The repository refused to list its branches.");
    lines.push(line);
    at += length;
  }
  return lines;
}

const pkt = (line: string) => `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

/** Branches and the default branch from ref lines of either protocol: `<oid> <ref>`, then capabilities or attributes. */
export function parseRefs(lines: (string | null)[]): Omit<Branches, "at"> {
  const names = new Set<string>();
  let defaultBranch: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    // Version 0 puts capabilities after a NUL on the first line; version 2 puts attributes after spaces.
    const [refPart = "", capabilities = ""] = line.split("\0");
    const [, ref, ...attributes] = refPart.split(" ");
    const symref = [...attributes, ...capabilities.split(" ")].find((entry) => entry.startsWith("symref-target:") || entry.startsWith("symref=HEAD:"));
    if (ref === "HEAD" && symref?.includes("refs/heads/")) defaultBranch = symref.slice(symref.indexOf("refs/heads/") + "refs/heads/".length);
    if (ref?.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
  }
  return { names: [...names].sort(), defaultBranch };
}

/**
 * The largest answer read from a git host. Version 2 lists only branches, about 60 bytes each, so this fits over
 * 100,000 of them; a version 0 list of every tag and pull request ref of a very large repository is a few MB.
 */
const maxResponseBytes = 8 * 1024 * 1024;
const maxRedirects = 3;
const lookupsPerHost = 4;

const tooLarge = () => new Error("The repository's answer is too large to read.");

/** The body, read as it arrives and cancelled once it passes the cap, so a hostile host cannot fill memory. */
async function readCapped(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > maxResponseBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Throwing out of the loop cancels the stream.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxResponseBytes) throw tooLarge();
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Refuses a URL that is not HTTPS to a public host, or whose name resolves to any address that is not public. */
async function checkPublic(target: string, resolve: Resolve | undefined) {
  const url = URL.parse(target);
  if (url?.protocol !== "https:" || url.username || url.password || !publicHost(url.hostname)) throw notPublic();
  if (!resolve || url.hostname.startsWith("[") || /^[\d.]+$/.test(url.hostname)) return;
  const addresses = await resolve(url.hostname).catch(() => []);
  if (addresses.length === 0) throw new Error("Could not read the repository's branches.");
  if (!addresses.every(publicAddress)) throw notPublic();
}

/**
 * What `git ls-remote --symref <url> HEAD refs/heads/*` prints, read over git's HTTP protocol with fetch, so it runs
 * wherever VM Bridge does. HTTPS only and never prompts. Like git, it asks for protocol version 2, which lists only
 * branches, reads version 0's full list from servers without it, and reads a static ("dumb") server's refs file when
 * the answer is not the smart protocol's. `token` goes to github.com only. Every host it talks to must be public, and
 * with `resolve`, so must every address the host's name resolves to.
 */
export async function lsRemote(url: string, options: { token?: string; resolve?: Resolve } = {}): Promise<Branches> {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Only HTTPS repositories can be read.");
  let base = parsed.href.replace(/\/+$/, "");
  const headers: Record<string, string> = { "git-protocol": "version=2", "user-agent": "git/vmbridge" };
  if (options.token && parsed.hostname === "github.com") headers.authorization = `Basic ${btoa(`x-access-token:${options.token}`)}`;
  const request = async (path: string, init: RequestInit = {}, initial = false) => {
    let target = `${base}${path}`;
    for (let hop = 0; ; hop++) {
      await checkPublic(target, options.resolve);
      const response = await fetch(target, {
        ...init,
        headers: { ...headers, ...init.headers },
        // Redirects are followed here, so each hop's host is checked before it is requested.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      const location = response && response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      // Like git, only the first request follows redirects, and later ones go where it ended up. A request carrying
      // the token follows none, so the token cannot leave github.com.
      if (location && initial && hop < maxRedirects && !headers.authorization) {
        await response?.body?.cancel();
        // An unparsable location fails the public check on the next hop.
        target = URL.parse(location, target)?.href ?? "";
        continue;
      }
      if (!response?.ok) throw new Error("Could not read the repository's branches.");
      if (initial) {
        if (!target.endsWith(path)) throw new Error("The repository redirected somewhere that is not a repository.");
        base = target.slice(0, -path.length);
      }
      return { type: response.headers.get("content-type") ?? "", bytes: await readCapped(response) };
    }
  };

  const info = await request("/info/refs?service=git-upload-pack", {}, true);
  // Git tells the two apart the same way: only smart servers answer with this type.
  if (!info.type.startsWith("application/x-git-upload-pack-advertisement")) return dumbRefs(info.bytes, () => request("/HEAD"));
  let advertised = pktLines(info.bytes);
  // Smart HTTP may start with a service line and a flush before what the protocol itself sends.
  if (advertised[0]?.startsWith("# service=")) advertised = advertised.slice(2);
  if (advertised[0] !== "version 2") return { ...parseRefs(advertised), at: Date.now() };
  // A SHA-256 repository refuses a request that does not name its object format, so echo the advertised one.
  const objectFormat = advertised.find((line) => line?.startsWith("object-format="));
  const capabilities = `${pkt("command=ls-refs\n")}${objectFormat ? pkt(`${objectFormat}\n`) : ""}`;
  const body = `${capabilities}0001${pkt("symrefs\n")}${pkt("ref-prefix HEAD\n")}${pkt("ref-prefix refs/heads/\n")}0000`;
  const refs = await request("/git-upload-pack", { method: "POST", body, headers: { "content-type": "application/x-git-upload-pack-request" } });
  return { ...parseRefs(pktLines(refs.bytes)), at: Date.now() };
}

/** A static server's `info/refs`, one `<oid>\t<ref>` per line, with the default branch from its `HEAD` file. */
async function dumbRefs(bytes: Uint8Array, head: () => Promise<{ bytes: Uint8Array }>): Promise<Branches> {
  const names = new Set<string>();
  for (const line of decoder.decode(bytes).split("\n")) {
    if (!line) continue;
    const match = /^[0-9a-f]{40,64}\t(\S+)$/.exec(line);
    // Anything else, such as a login page, is not a repository.
    if (!match) throw new Error("The repository sent an unreadable answer.");
    if (match[1]!.startsWith("refs/heads/")) names.add(match[1]!.slice("refs/heads/".length));
  }
  const defaultBranch = await head()
    .then(({ bytes }) => /^ref: refs\/heads\/(\S+)/.exec(decoder.decode(bytes))?.[1] ?? null)
    .catch(() => null);
  return { names: [...names].sort(), defaultBranch, at: Date.now() };
}
