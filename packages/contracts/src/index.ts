// Types shared by the VM Bridge server and its web dashboard. The admin API returns these shapes.

export const providerIds = ["boat", "boxd", "daytona", "e2b", "freestyle", "instabox", "kubi", "railway", "superserve"] as const;
export type ProviderId = (typeof providerIds)[number];

export const vmSizes = ["small", "medium", "large"] as const;
export type VmSize = (typeof vmSizes)[number];

export const machineNameMaxLength = 40;

/** T3's agent feedback modes: whether agents may show a card offering to send a report to the T3 team. */
export const agentFeedbackModes = ["off", "on-request", "auto"] as const;
export type AgentFeedbackMode = (typeof agentFeedbackModes)[number];

export interface ProviderField {
  key: string;
  label: string;
  kind: "secret" | "text" | "select";
  required: boolean;
  help?: string;
  placeholder?: string;
  /** A `select` field's fixed choices, shown without loading them from the provider. The first is the default. */
  options?: SelectOption[];
}

/** How a provider keeps a VM between bursts of work. */
export type SleepMode = "pause" | "stop" | "checkpoint";

export interface ProviderFeatures {
  sleep: SleepMode;
  /** VM disk and agent sessions survive sleep. */
  keepsDisk: boolean;
  /** Memory and running processes survive sleep. */
  keepsMemory: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  website: string;
  fields: ProviderField[];
  features: ProviderFeatures;
  sizes: Record<VmSize, string>;
  /** The size new VMs get when no setting or rule picks one. */
  defaultSize: VmSize;
  /** Non-secret field values. Secret fields report only whether they are set. */
  values: Record<string, string>;
  secretsSet: string[];
  configured: boolean;
  /** Added in Accounts, so VM Bridge can create VMs on it. */
  added: boolean;
  /** New VMs go here unless a repository rule picks another provider. */
  isDefault: boolean;
  setup: ProviderSetup;
  /** The latest background failure on this provider not since put right, such as a VM or snapshot it could not delete. */
  problem: string | null;
}

/**
 * The base snapshot new VMs on a provider start from, at the size they get by default. While the first one builds,
 * no VM is created there. After a failure, VMs there start the slower way without one.
 */
export type ProviderSetup =
  | { state: "unsupported" }
  | { state: "none" }
  | { state: "building"; startedAt: number }
  | { state: "ready" }
  | { state: "failed"; reason: string };

/** Where new VMs for one GitHub repository go. Null fields fall back to the defaults. */
export interface RepoRule {
  /** `owner/name` */
  repo: string;
  provider: ProviderId | null;
  size: VmSize | null;
}

export interface SelectOption {
  value: string;
  label: string;
  detail?: string;
}

/** `worker`: the address a Cloudflare Workers deploy is reached on, its workers.dev name or a custom domain. */
export type AddressKind = "local" | "lan" | "tailscale" | "tailscale-dns" | "tailscale-https" | "cloudflare" | "worker";

export interface Address {
  kind: AddressKind;
  label: string;
  url: string;
}

/**
 * quick: a random trycloudflare.com address that changes on every start. named: the user's hostname on a tunnel
 * VM Bridge creates with their logged-in cloudflared. token: a tunnel made in the Cloudflare dashboard.
 */
export type TunnelMode = "quick" | "named" | "token";

export interface CloudflareInfo {
  installed: boolean;
  /** cloudflared on this machine is logged in to a Cloudflare account, so VM Bridge can make a named tunnel. */
  loggedIn: boolean;
  enabled: boolean;
  hostname: string | null;
  hasToken: boolean;
  mode: TunnelMode;
  state: "off" | "starting" | "running" | "failed";
  /** The public address, once the tunnel is running and it works. */
  url: string | null;
  error: string | null;
  /** The loopback port cloudflared forwards to. A token tunnel's hostname must point at it. */
  port: number | null;
}

/** VM Bridge running with Bun on the user's machine. */
export interface NetworkInfo {
  platform: "bun";
  port: number;
  /** Whether VM Bridge answers on the local network. `fixed`: set by --host, so the switch cannot change it. */
  localNetwork: { enabled: boolean; fixed: boolean };
  addresses: Address[];
  tailscale: {
    installed: boolean;
    running: boolean;
    dnsName: string | null;
    httpsUrl: string | null;
  };
  cloudflare: CloudflareInfo;
}

/** VM Bridge deployed to Cloudflare Workers: one HTTPS address, and no local network, Tailscale or tunnel. */
export interface WorkerNetworkInfo {
  platform: "workers";
  addresses: Address[];
}

export type BridgeNetworkInfo = NetworkInfo | WorkerNetworkInfo;

/** A step a T3 client takes to connect: the CORS preflight, the environment read, and the RPC WebSocket. */
export type ConnectionStep = "preflight" | "environment" | "socket";

/** One address tested the way a T3 client connects to it. A step passes when it has no problems. */
export interface AddressTest {
  url: string;
  steps: { step: ConnectionStep; problems: string[] }[];
}

export interface PairingLink {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

/** A device paired with VM Bridge through a pairing link. */
export interface ClientInfo {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  /** The last time its RPC WebSocket was open, to the minute. Null when it never connected. */
  lastConnectedAt: number | null;
  connected: boolean;
}

export type VmState = "provisioning" | "starting" | "ready" | "busy" | "sleeping" | "error" | "gone";

/** The agent running a session: the name T3 shows, and which logo it has, when VM Bridge knows it. */
export interface SessionAgent {
  kind: AgentKind | null;
  name: string;
}

export interface VmSession {
  threadId: string;
  title: string;
  projectId: string | null;
  /** The model's name as its agent lists it, such as "Claude Opus 5.5", or its ID when the agent does not list it. */
  model: string | null;
  agent: SessionAgent | null;
  status: string;
  /** A turn is running, queued, or waiting on an approval. */
  working: boolean;
  updatedAt: string | null;
}

/** Used and total, in bytes. */
export interface Usage {
  used: number;
  total: number;
}

/** One reading of an awake VM's resources. A part the VM could not report is null. */
export interface VmStats {
  /** When VM Bridge took the reading. */
  at: number;
  /** The VM's own memory, or its container's limit when it has one. */
  memory: Usage | null;
  /** Share of the last 10 s some task waited on memory (PSI `some avg10`), 0 to 100. Null without PSI. */
  memoryPressure: number | null;
  /** CPU use over one second as a share of all cores, 0 to 1. */
  cpu: { usage: number; cores: number } | null;
  /** The filesystem holding /workspace. */
  disk: Usage | null;
  /** Memory is nearly full or tasks often wait on it. */
  highMemory: boolean;
}

export interface VmInfo {
  id: string;
  name: string;
  provider: ProviderId;
  providerLabel: string;
  sandboxId: string | null;
  size: VmSize;
  sizeLabel: string;
  state: VmState;
  error: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  lastConnectedAt: number | null;
  lastSleptAt: number | null;
  /** When the idle timer will put the VM to sleep, if it is awake and idle. */
  sleepsAt: number | null;
  projects: string[];
  sessions: VmSession[];
  t3Version: string | null;
  /** T3 on the VM has not started with the current sign-ins and environment variables yet. */
  updatePending: boolean;
  /** The latest resource reading while the VM is awake. */
  stats: VmStats | null;
  /** The VM has not got the installed skills or synced instructions yet. A sleeping VM gets them when it wakes. */
  skillsPending: boolean;
  /** The latest background failure on this VM not since put right, such as a failed sleep that may leave it running. */
  problem: string | null;
  /** The link to watch the VM's screen live. Null for VMs without a screen; `url` is null while the link is off. */
  watchLink: { url: string | null } | null;
}

/** Where an installed skill comes from: skills.sh, a folder on the machine running VM Bridge, or the dashboard. */
export type SkillSource = "skills.sh" | "local" | "upload";

/** A skill VM Bridge installs on every VM. */
export interface SkillInfo {
  /** Its folder name on the VMs. */
  name: string;
  source: SkillSource;
  /** `owner/repo` for skills.sh, the folder for a local skill, empty for an upload. */
  ref: string;
  description: string | null;
  updatedAt: number;
}

/** A skill found in this machine's Claude Code or Codex skill folders. */
export interface LocalSkill {
  name: string;
  path: string;
  description: string | null;
  installed: boolean;
}

/** An agent's global instructions file found on the machine running VM Bridge. */
export interface InstructionFile {
  agent: AgentKind;
  path: string;
  /** Every VM gets it, at the path that agent reads. */
  sync: boolean;
}

/** The instructions files that can be pasted in the dashboard. Codex and OpenCode read AGENTS.md, Claude Code CLAUDE.md. */
export const instructionNames = ["AGENTS.md", "CLAUDE.md"] as const;
export type InstructionName = (typeof instructionNames)[number];

/** Which pasted file each agent reads. A pasted file wins over that agent's file on the machine running VM Bridge. */
export const instructionFor: Record<AgentKind, InstructionName> = { claude: "CLAUDE.md", codex: "AGENTS.md", opencode: "AGENTS.md" };

/** One file of a skill, relative to its folder. */
export interface SkillFile {
  path: string;
  /** Base64, so scripts and images survive as they are. */
  data: string;
  executable?: boolean;
}

/**
 * Limits for a pasted instructions file and an uploaded skill. A skill is stored sealed as one row, base64 twice
 * over, so 1 MB of files stays under the 2 MB a Durable Object row can hold.
 */
export const uploadLimits = { instructionBytes: 256 * 1024, skillBytes: 1024 * 1024, skillFiles: 100 };

/** A usable skill folder name, which is also its name on the VMs. */
export const skillNamePattern = /^[A-Za-z0-9][\w.-]{0,99}$/;

const utf8 = new TextEncoder();

/**
 * What is wrong with an uploaded skill's files, by path and decoded size, or null when nothing is. The dashboard checks
 * before sending, and the server again, since anyone can call its API.
 */
export function skillUploadProblem(name: string, files: { path: string; size: number }[]): string | null {
  if (!skillNamePattern.test(name)) return `${name || "That"} is not a usable skill name. Use letters, digits, dots, dashes and underscores.`;
  if (files.length > uploadLimits.skillFiles) return `${name} has more than ${uploadLimits.skillFiles} files.`;
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    // Relative, inside the skill's folder, and nothing a shell or the VM's file system would read differently.
    // File systems limit names in bytes, so lengths are UTF-8 bytes.
    const unsafe =
      utf8.encode(file.path).length > 500 ||
      /[\x00-\x1f\\]/.test(file.path) ||
      parts.some((part) => !part || part === "." || part === ".." || utf8.encode(part).length > 255);
    if (unsafe) return `${name} has a file outside its folder or with an unusable name: ${file.path.slice(0, 100)}`;
    if (paths.has(file.path)) return `${name} has ${file.path} twice.`;
    paths.add(file.path);
    bytes += file.size;
  }
  // A file and a folder of the same name cannot both be written.
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join("/"))) return `${name} has ${parts.slice(0, i).join("/")} as both a file and a folder.`;
    }
  }
  if (bytes > uploadLimits.skillBytes) return `${name} is larger than 1 MB.`;
  if (!paths.has("SKILL.md")) return `${name} has no SKILL.md at its top.`;
  return null;
}

export interface SkillSearchResult {
  /** `owner/repo` */
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

/** T3's colors for a project's letters. */
export type ProjectIconColor =
  | "gray" | "red" | "orange" | "amber" | "yellow" | "lime" | "green" | "emerald" | "teal"
  | "cyan" | "sky" | "blue" | "indigo" | "violet" | "purple" | "fuchsia" | "pink" | "rose";

/** The icon T3 shows for a project: its repository's logo, or letters or an emoji. */
export type ProjectIcon =
  | { kind: "image"; url: string }
  | { kind: "monogram"; text: string; color: ProjectIconColor }
  | { kind: "emoji"; emoji: string };

export interface ProjectInfo {
  id: string;
  title: string;
  icon: ProjectIcon;
  url: string;
  branch: string | null;
  /** VMs holding the project, primary first. */
  vmIds: string[];
  createdAt: number;
}

export interface Setup {
  provider: boolean;
  github: boolean;
  agents: boolean;
}

export const agentKinds = ["codex", "claude", "opencode"] as const;
export type AgentKind = (typeof agentKinds)[number];

/**
 * How a profile signs its agent in. `chatgpt`: Codex device sign-in. `setup-token`: `claude setup-token`.
 * `auth-token`: ANTHROPIC_AUTH_TOKEN, optionally sent to an Anthropic-compatible base URL. `api-key`: OpenCode key.
 */
export type AgentAuthMethod = "chatgpt" | "setup-token" | "auth-token" | "api-key";

/** An agent sign-in saved in VM Bridge. Each agent uses one profile at a time on every VM. */
export interface AgentProfile {
  id: string;
  agent: AgentKind;
  method: AgentAuthMethod;
  name: string;
  /** The ChatGPT account email, or the base URL an Anthropic token goes to. */
  detail: string | null;
  createdAt: number;
  inUse: boolean;
  /** Set when the sign-in stopped working, such as a Codex sign-in that can no longer refresh. */
  error: string | null;
}

/** A Claude sign-in waiting for the code claude.ai shows after approval. */
export interface ClaudeLogin {
  id: string;
  url: string;
}

/** A Codex device sign-in in progress. */
export interface CodexLogin {
  id: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  status: "pending" | "done" | "failed";
  error: string | null;
}

/** The GitHub account VM Bridge's personal access token belongs to. */
export interface GitHubAccount {
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
  /** The address VMs commit with: GitHub's private noreply address for the account. */
  email: string;
  /** A classic token's scopes. Null for fine-grained tokens, which have no scope list. */
  scopes: string[] | null;
  expiresAt: number | null;
  checkedAt: number;
}

export interface BridgeSettings {
  /** The name T3 shows for this machine. */
  machineName: string;
  /** Null: each provider's default size. */
  vmSize: VmSize | null;
  idleMinutes: number;
  t3Version: string | null;
  /** Set in T3 on every VM. */
  agentFeedback: AgentFeedbackMode;
}

/** A newer VM Bridge release. Only the release binary and a Worker check, so it is null when run from source. */
export interface BridgeUpdate {
  version: string;
  /**
   * How to move to it. "dashboard": the dashboard installs it and restarts the background service. "command":
   * `vmbridge update` in a terminal. "cloudflare": bring the release into the Worker's GitHub repository, which deploys it.
   */
  how: "dashboard" | "command" | "cloudflare";
  /** The dashboard started installing it, and VM Bridge has not restarted yet. */
  installing: boolean;
  /** Why the last install from the dashboard failed. */
  error: string | null;
}

export interface Overview {
  bridge: { id: string; version: string; startedAt: number; update: BridgeUpdate | null };
  setup: Setup;
  /** Added providers, in the order they were added. */
  providers: ProviderInfo[];
  defaultProvider: ProviderId | null;
  repoRules: RepoRule[];
  github: GitHubAccount | null;
  agents: AgentProfile[];
  /** Names of the environment variables every VM gets. Their values never leave VM Bridge's server. */
  env: string[];
  settings: BridgeSettings;
  clients: ClientInfo[];
  /** T3 clients keep reaching VM Bridge but never open a connection, as when their browser refuses its answers. */
  connectTrouble: { since: number; reads: number } | null;
  vms: VmInfo[];
  projects: ProjectInfo[];
  skills: SkillInfo[];
  /** Every skill on this machine is installed and kept in sync, not only the ones picked. */
  syncLocalSkills: boolean;
  instructions: InstructionFile[];
  /** Instructions files pasted in the dashboard. Their text comes from `GET /instructions`. */
  savedInstructions: InstructionName[];
  /** VM Bridge can read skills and instructions files on the machine it runs on. False on Cloudflare Workers. */
  machine: boolean;
  /** Where the password is changed instead of the dashboard, such as a Worker's secret. Null when the dashboard changes it. */
  passwordSource: string | null;
  budget: BudgetStatus;
}

/** The monthly budget and this month's estimated spend against it. */
export interface BudgetStatus {
  /** In US dollars. Null: no budget. */
  monthlyUsd: number | null;
  /** Refuse new VMs and wakes once the month's estimate reaches the budget. */
  stopAtLimit: boolean;
  /** Since the start of `monthStart`'s month, in VM Bridge's time zone (UTC on Workers). */
  spent: Estimate;
  monthStart: number;
  /** "warning" from 80% of the budget, "over" from 100%. Always "ok" without a budget. */
  level: "ok" | "warning" | "over";
}

export type Currency = "USD" | "EUR";

/** A provider's published prices for the machines VM Bridge creates. Null: the provider does not publish it. */
export interface ProviderPricing {
  provider: ProviderId;
  label: string;
  /** The machine each size gets. */
  machines: Record<VmSize, string>;
  /** The currency the provider publishes its prices in. Estimates convert them to US dollars. */
  currency: Currency;
  /** The pricing page the numbers come from. */
  source: string;
  /** When they were read from it, YYYY-MM-DD. */
  asOf: string;
  /** Per hour while running, at full use. */
  runningHourly: Record<VmSize, number>;
  /** Per hour while asleep, before storage billed per GiB. */
  asleepHourly: Record<VmSize, number | null>;
  /** Disk or snapshot storage per GiB-month. Null when included or not published. */
  storageGibMonth: number | null;
  sleeping: string;
  snapshots: string;
  plans: string;
  /** Why an estimate may be off, such as billing only busy CPU. */
  caveat?: string;
}

/** An estimated cost in US dollars. `partial` when part of the time has no published price. */
export interface Estimate {
  amount: number;
  partial: boolean;
}

export interface VmUsage {
  vmId: string;
  name: string;
  provider: ProviderId;
  size: VmSize;
  awakeMs: number;
  asleepMs: number;
  /** The VM was deleted since. */
  deleted: boolean;
  estimate: Estimate;
}

export interface ProviderUsage {
  provider: ProviderId;
  awakeMs: number;
  asleepMs: number;
  estimate: Estimate;
}

/** Awake time of the VMs holding a repository. A VM holding several counts for each. */
export interface RepoUsage {
  /** `owner/name` for GitHub, else the URL. */
  repo: string;
  awakeMs: number;
  vms: number;
}

/** Base snapshots or sleep checkpoints kept on one provider. */
export interface SnapshotUsage {
  provider: ProviderId;
  kind: "base" | "checkpoint";
  count: number;
  /** Total time they were kept. */
  heldMs: number;
}

/** Usage and estimated costs between `from` and `to`. */
export interface UsageReport {
  from: number;
  to: number;
  prices: ProviderPricing[];
  providers: ProviderUsage[];
  vms: VmUsage[];
  repos: RepoUsage[];
  snapshots: SnapshotUsage[];
  total: Estimate;
  /** The fixed rate euro prices convert to US dollars at. */
  eurUsd: ExchangeRate;
}

/** US dollars per euro, from `source` on `asOf` (YYYY-MM-DD). */
export interface ExchangeRate {
  rate: number;
  source: string;
  asOf: string;
}

/** One provider's time and estimated cost on one day. */
export interface ProviderDay {
  provider: ProviderId;
  awakeMs: number;
  asleepMs: number;
  estimate: Estimate;
}

/** One calendar day in the dashboard's time zone. */
export interface AnalyticsDay {
  /** The midnight it starts at. */
  start: number;
  providers: ProviderDay[];
  created: number;
  deleted: number;
  wakes: number;
  sleeps: number;
  /** Threads with a turn that day. */
  threads: number;
  turns: number;
  /** Provider null: the error names no provider or VM. */
  errors: { provider: ProviderId | null; count: number }[];
}

/** VMs created, woken and put to sleep on one provider. Times are medians, null when none was timed. */
export interface ProviderActivity {
  provider: ProviderId;
  created: number;
  deleted: number;
  wakes: number;
  sleeps: number;
  /** The provider making the VM. */
  createMs: number | null;
  /** A new VM's first start: installing and connecting. */
  startMs: number | null;
  /** Waking from sleep until connected. */
  wakeMs: number | null;
}

export interface SizeActivity {
  provider: ProviderId;
  size: VmSize;
  vms: number;
  awakeMs: number;
}

export interface RepoActivity {
  /** `owner/name` for GitHub, else the URL. */
  repo: string;
  awakeMs: number;
  threads: number;
  turns: number;
}

/** Turns one agent and model ran. */
export interface AgentActivity {
  /** Display name, such as Codex. */
  agent: string;
  model: string | null;
  threads: number;
  turns: number;
}

/** Everything VM Bridge recorded between `from` and `to`, by day where it helps. */
export interface AnalyticsReport {
  from: number;
  to: number;
  days: AnalyticsDay[];
  providers: ProviderActivity[];
  sizes: SizeActivity[];
  repos: RepoActivity[];
  agents: AgentActivity[];
  snapshots: SnapshotUsage[];
  /** Threads with a turn in the range. */
  threads: number;
  total: Estimate;
}

export interface TrafficEvent {
  id: number;
  at: number;
  kind: "rpc" | "http" | "provider" | "system";
  operation: string;
  clientId?: string;
  vmId?: string;
  provider?: ProviderId;
  status?: "ok" | "error";
  /** Why it failed, or why a device's connection ended. */
  reason?: string;
  durationMs?: number;
}

export type LiveMessage =
  | { type: "traffic"; event: TrafficEvent }
  | { type: "overview"; overview: Overview };

export interface PairingUrl {
  kind: AddressKind;
  label: string;
  url: string;
}

export interface CreatedPairing {
  link: PairingLink;
  urls: PairingUrl[];
}

/** How OpenCode connects to a project: an address for each way VM Bridge can be reached, and the project's password. */
export interface OpenCodeConnection {
  urls: Address[];
  password: string;
}

export interface ApiError {
  error: string;
}
