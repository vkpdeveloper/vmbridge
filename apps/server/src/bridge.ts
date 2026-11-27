// VM Bridge's parts, wired together the same way on every runtime. Bun's entry is index.ts, a Worker's is workers/.
import type { Address } from "@vmbridge/contracts";
import { AgentAuth } from "./agent-auth/profiles.ts";
import { Budget } from "./budget.ts";
import { Clients } from "./auth/clients.ts";
import { DashboardAuth } from "./auth/dashboard.ts";
import type { Passwords } from "./auth/password.ts";
import { type Encryption, openEncryption, type KeySource } from "./encryption.ts";
import { Fleet } from "./fleet.ts";
import { Clones } from "./gateway/clones.ts";
import { FileTrees } from "./gateway/files.ts";
import { T3Gateway } from "./gateway/http.ts";
import { openCodeLauncher } from "./gateway/opencode-launch.ts";
import { OpenCodeGateway } from "./gateway/opencode.ts";
import { Hub } from "./gateway/hub.ts";
import { RemoteBranches } from "./gateway/repos.ts";
import { Rpc } from "./gateway/rpc.ts";
import type { OpenSocket } from "./runtime.ts";
import { Secrets, Settings } from "./settings.ts";
import { Skills, type Machine } from "./skills.ts";
import type { Sql } from "./sql.ts";
import { Store } from "./store.ts";
import { Traffic } from "./traffic.ts";
import { Usage } from "./usage.ts";
import { Stats } from "./vm/stats.ts";
import { WatchLinks } from "./watch/links.ts";
import { Watch } from "./watch/watch.ts";

export interface BridgeRuntime {
  db: Sql;
  key: (create: boolean) => KeySource;
  passwords: Passwords;
  openSocket: OpenSocket;
  /** Every address a host name resolves to, to keep branch lookups off private hosts. Undefined where fetch cannot reach them anyway. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Skills and instructions files on the machine VM Bridge runs on. Absent where there is none, such as on Workers. */
  machine?: Machine;
  /** Where VM Bridge can be reached now, for the watch links it gives out. Called only once the bridge is open. */
  addresses: () => Promise<Address[]>;
  /** The watch page (see watch/). */
  watchPage: () => Promise<Response>;
  /** Runs once encryption is open, before the fleet reads any saved value: moves older data in, seals or drops plain values. */
  prepare(parts: { encryption: Encryption; migrated: boolean; markMigrated: () => void; secrets: Secrets; store: Store; skills: Skills }): void;
}

export function openBridge(runtime: BridgeRuntime) {
  const { db } = runtime;
  const settings = new Settings(db);
  const { encryption, key, migrated, markMigrated } = openEncryption(db, runtime.key);
  const secrets = new Secrets(db, encryption);
  const store = new Store(db, encryption);
  const traffic = new Traffic(db);
  const skills = new Skills(db, encryption, runtime.machine);
  // Before AgentAuth, which reads the sign-ins it may import.
  runtime.prepare({ encryption, migrated, markMigrated, secrets, store, skills });
  const agents = new AgentAuth(db, settings, encryption);

  const fleet = new Fleet(store, settings, secrets, traffic, agents, skills, runtime.openSocket);
  skills.on("changed", () => {
    fleet.emit("changed");
    void fleet.shareSkills();
  });
  const stats = new Stats(fleet);
  const usage = new Usage(store, () => fleet.connected());
  for (const event of ["changed", "awake", "offline"] as const) fleet.on(event, () => usage.sync());
  const branches = new RemoteBranches(() => secrets.get("github.token"), runtime.resolve);
  const files = new FileTrees(db, () => secrets.get("github.token"), branches);
  const budget = new Budget(settings, usage);
  fleet.refusal = () => budget.refusal();
  const hub = new Hub(store, settings, fleet, traffic, stats, budget, files);
  agents.onChange = () => {
    fleet.emit("changed");
    void hub.credentialsChanged().catch(() => {});
  };
  const clones = new Clones(hub);
  const clients = new Clients(db);
  // What a VM's agents pushed before it slept is what the "@" menu lists while it sleeps, when the VM gave no list.
  fleet.on("offline", (vmId) => {
    if (store.vm(vmId)?.state === "sleeping") void files.refresh(store.projects().filter((project) => project.vms.some((entry) => entry.vmId === vmId)));
  });
  const rpc = new Rpc(hub, clones, branches, traffic, () => secrets.has("github.token"), files);
  const hasOpenCodeKey = () => Boolean(settings.get("agentProfiles").opencode);
  const gateway = new T3Gateway(hub, rpc, clients, openCodeLauncher({ store, hub, clones, traffic, hasKey: hasOpenCodeKey }));
  const opencode = new OpenCodeGateway(store, fleet, traffic, hasOpenCodeKey);
  const auth = new DashboardAuth(db, secrets, runtime.passwords);
  const watch = new Watch({
    links: new WatchLinks(db, encryption),
    store,
    fleet,
    traffic,
    openSocket: runtime.openSocket,
    addresses: runtime.addresses,
    page: runtime.watchPage,
  });
  return { settings, encryption, key, secrets, store, traffic, agents, skills, fleet, stats, usage, budget, hub, gateway, opencode, clients, auth, watch };
}

export type Bridge = ReturnType<typeof openBridge>;
