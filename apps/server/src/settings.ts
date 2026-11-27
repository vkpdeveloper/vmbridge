import type { Sql } from "./sql.ts";
import { machineNameMaxLength, type AgentFeedbackMode, type AgentKind, type GitHubAccount, type ProviderId, type RepoRule, type VmSize } from "@vmbridge/contracts";
import { Encryption } from "./encryption.ts";
import type { KeybindingRule } from "./gateway/keybindings.ts";
import type { ServerConfig, Wire } from "./gateway/types.ts";

export interface ProviderPreference {
  enabled?: boolean;
  displayName?: string;
}

interface SettingValues {
  /** Stable T3 environment identity. Never changes once created. */
  bridgeId: string;
  /** Whether first-run onboarding was finished. Until then the dashboard sends you there. */
  onboarded: boolean;
  /** The name T3 shows for this machine. */
  machineName: string;
  /** Providers added in Accounts, in order. VMs on a removed provider keep running but get no new VMs beside them. */
  providers: ProviderId[];
  /** One of `providers`. New VMs go here unless a repository rule picks another. */
  defaultProvider: ProviderId | null;
  repoRules: RepoRule[];
  /** Non-secret provider fields, such as a Boat environment name. Secrets live in the secrets table. */
  providerOptions: Partial<Record<ProviderId, Record<string, string>>>;
  /** Null: each provider's own default size (see `ProviderDefinition.defaultSize`). */
  vmSize: VmSize | null;
  idleMinutes: number;
  /** Exact npm `t3` version for new VMs; null resolves the latest release when a VM is created. */
  t3Version: string | null;
  /** The GitHub account VM Bridge's token belongs to. The token itself is the `github.token` secret. */
  github: GitHubAccount | null;
  /** T3 shell snapshot sequence. Only grows, across restarts, so clients never see it go back. */
  shellSequence: number;
  /** T3 agent provider switches and display names set from T3's settings screen. */
  agentPreferences: Record<string, ProviderPreference>;
  /** Keyboard shortcuts saved from T3's settings, as T3's `keybindings.json` holds them (see gateway/keybindings.ts). */
  keybindings: KeybindingRule[];
  /** T3 settings saved from T3's settings screen, set on every VM (see gateway/fleet-settings.ts). */
  t3Settings: Wire;
  /** T3's agent feedback mode on every VM. T3 ships it off. */
  agentFeedback: AgentFeedbackMode;
  /** The sign-in profile each agent uses on every VM (see agent-auth/profiles.ts). */
  agentProfiles: Partial<Record<AgentKind, string>>;
  /** Agents whose global instructions file on this machine every VM gets. */
  instructionSync: Partial<Record<AgentKind, boolean>>;
  /** Every skill in this machine's skill folders is installed, and removed when its folder goes. */
  syncLocalSkills: boolean;
  /** T3's config from the last VM removed, kept while no VM has one (see `Hub.forget`). */
  fallbackConfig: { vmId: string; config: ServerConfig } | null;
  /**
   * Cloudflare Tunnel. Off until the user turns it on, since it puts VM Bridge on the public internet. `port` is the
   * loopback listener cloudflared forwards to, kept so a dashboard-made tunnel's hostname keeps pointing at it.
   * A dashboard tunnel's token is the `cloudflare.tunnelToken` secret.
   */
  cloudflareTunnel: { enabled: boolean; hostname: string | null; port: number | null };
  /** Listen on the local network too. Off by default, for existing installs as well: it is plain HTTP. */
  localNetwork: boolean;
  /** On Workers, the origin requests last came in on: the address watch links use (see watch/watch.ts). */
  workerOrigin: string | null;
  /** The monthly spending budget (see budget.ts). Refusing at the limit is off until the user turns it on. */
  budget: { monthlyUsd: number | null; stopAtLimit: boolean };
  /** The start of the month T3 last got a budget notice in, so it gets one a month. */
  budgetNoticeMonth: number | null;
  /** The latest VM Bridge release seen on GitHub, for the dashboard's update notice. Checked every few hours. */
  latestRelease: { version: string; checkedAt: number } | null;
}

/** The dashboard password's hash. Older versions kept it unencrypted, as the `dashboardKeyHash` setting. */
export const passwordHashSecret = "dashboard.passwordHash";
const legacyPasswordHash = "dashboardKeyHash";

const defaultMachineName = "VM Bridge";

/** Trimmed, with blank meaning the default. Null when it is too long. */
export function machineName(input: string): string | null {
  const name = input.trim() || defaultMachineName;
  return name.length <= machineNameMaxLength ? name : null;
}

const defaults: { [K in keyof SettingValues]: () => SettingValues[K] } = {
  bridgeId: () => crypto.randomUUID(),
  onboarded: () => false,
  machineName: () => defaultMachineName,
  providers: () => [],
  defaultProvider: () => null,
  repoRules: () => [],
  providerOptions: () => ({}),
  vmSize: () => null,
  idleMinutes: () => 5,
  t3Version: () => null,
  github: () => null,
  shellSequence: () => 0,
  agentPreferences: () => ({}),
  keybindings: () => [],
  t3Settings: () => ({}),
  agentFeedback: () => "off",
  agentProfiles: () => ({}),
  instructionSync: () => ({}),
  syncLocalSkills: () => false,
  fallbackConfig: () => null,
  cloudflareTunnel: () => ({ enabled: false, hostname: null, port: null }),
  localNetwork: () => false,
  workerOrigin: () => null,
  budget: () => ({ monthlyUsd: null, stopAtLimit: false }),
  budgetNoticeMonth: () => null,
  latestRelease: () => null,
};

export class Settings {
  constructor(private readonly db: Sql) {
    // Persist the identity on first start so pairings survive restarts.
    if (!this.db.one("SELECT 1 FROM settings WHERE key = 'bridgeId'")) this.set("bridgeId", defaults.bridgeId());
    // Installs from before onboarding existed that already have a password and a provider never need it. Their
    // password hash is still the plain setting that `Secrets.plaintext` moves later.
    if (!this.db.one("SELECT 1 FROM settings WHERE key = 'onboarded'")) {
      const hasPassword = this.db.one("SELECT 1 FROM settings WHERE key = ?", legacyPasswordHash) !== undefined;
      this.set("onboarded", hasPassword && this.get("providers").length > 0);
    }
  }

  get<K extends keyof SettingValues>(key: K): SettingValues[K] {
    const row = this.db.one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as SettingValues[K]) : defaults[key]();
  }

  set<K extends keyof SettingValues>(key: K, value: SettingValues[K]): void {
    this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }
}

/**
 * What to do with a value stored unencrypted: `seal` it when it was saved before VM Bridge encrypted its data, or
 * `drop` it once that was done, since VM Bridge never writes one after and someone else must have put it there.
 */
export type Plaintext = "seal" | "drop";

/** Secret values never leave the server through the admin API; only their presence does. Stored encrypted. */
export class Secrets {
  constructor(
    private readonly db: Sql,
    private readonly encryption: Encryption,
  ) {}

  get(name: string): string | undefined {
    const value = this.db.one<{ value: string }>("SELECT value FROM secrets WHERE name = ?", name)?.value;
    return value === undefined ? undefined : this.encryption.open(value, `secret:${name}`);
  }

  has(name: string): boolean {
    return this.db.one("SELECT 1 FROM secrets WHERE name = ?", name) !== undefined;
  }

  set(name: string, value: string | null): void {
    if (value === null || value === "") this.db.run("DELETE FROM secrets WHERE name = ?", name);
    else {
      this.db.run(
        "INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
        name, this.encryption.seal(value, `secret:${name}`),
      );
    }
  }

  /**
   * Encrypts, or drops, values stored unencrypted (see `Plaintext`), including the password hash older versions kept
   * in settings. Returns what it changed.
   */
  plaintext(action: Plaintext): string[] {
    const rows = this.db.all<{ name: string; value: string }>("SELECT name, value FROM secrets");
    const plain = rows.filter((row) => !Encryption.isSealed(row.value));
    const legacy = this.db.one<{ value: string }>("SELECT value FROM settings WHERE key = ?", legacyPasswordHash);
    this.db.transaction(() => {
      for (const row of plain) this.set(row.name, action === "seal" ? row.value : null);
      if (legacy) {
        // Planted later, it would choose the dashboard password.
        if (action === "seal") this.set(passwordHashSecret, JSON.parse(legacy.value) as string | null);
        this.db.run("DELETE FROM settings WHERE key = ?", legacyPasswordHash);
      }
    });
    return [...plain.map((row) => `secret ${row.name}`), ...(legacy ? ["old dashboard password setting"] : [])];
  }
}

/** Environment variables every VM gets, set in the dashboard. Kept as one secret, since the values are secrets too. */
export const envVars = (secrets: Secrets): Record<string, string> => JSON.parse(secrets.get("env") ?? "{}");

export const saveEnvVars = (secrets: Secrets, vars: Record<string, string>) => secrets.set("env", Object.keys(vars).length ? JSON.stringify(vars) : null);
