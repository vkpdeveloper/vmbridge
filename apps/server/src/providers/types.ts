import type { Preview, SandboxBase } from "@opencoredev/sandbox-sdk";
import type { SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { ProviderFeatures, ProviderField, ProviderId, SelectOption, VmSize } from "@vmbridge/contracts";

/** The provider-neutral sandbox handle: commands, files, background processes, previews. */
export type Box = SandboxBase<unknown>;

export type ProviderState = "running" | "paused" | "stopped";

export interface CreateVm {
  /** VM Bridge's own VM ID, used as the provider key so a retried create finds the same sandbox. */
  key: string;
  size: VmSize;
  labels: Record<string, string>;
  /** Ports VM Bridge needs reachable: T3's and OpenCode's. */
  ports: number[];
}

export interface SleepResult {
  /** Set when sleeping replaced the sandbox with a checkpoint (the sandbox itself is gone). */
  checkpoint?: string;
}

export interface WakeVm extends CreateVm {
  sandboxId: string;
  checkpoint: string | null;
}

/** A live, view-only stream of a VM's screen: a WebSocket carrying RFB (VNC), opened with these subprotocols. */
export interface ScreenStream {
  url: URL;
  /** They hold the stream's one-use credential, so they never leave VM Bridge. */
  protocols: string[];
}

export interface Driver {
  readonly id: ProviderId;
  /** Throws a readable error when the credentials are missing or rejected. */
  verify(): Promise<void>;
  /** Choices for a `select` field, such as Boat environments. */
  options(field: string): Promise<SelectOption[]>;
  /** With `from`, starts from a base snapshot `snapshot` made, which fixes the machine size. */
  create(input: CreateVm, from?: string): Promise<Box>;
  /** Saves a VM's disk as a base snapshot new VMs can start from. Absent when the provider cannot. */
  snapshot?(box: Box): Promise<string>;
  connect(sandboxId: string): Promise<Box>;
  /**
   * Every sandbox carrying `labels`, with the key and labels it was created with. Providers that cannot read a sleeping
   * sandbox's labels without waking it (boxd) leave sleeping ones out.
   */
  list(labels: Record<string, string>): Promise<SandboxInfo[]>;
  /** Provider state of every sandbox carrying `labels`. Absent IDs no longer exist. */
  states(labels: Record<string, string>): Promise<Map<string, ProviderState>>;
  sleep(box: Box): Promise<SleepResult>;
  /** Wakes a sleeping VM. The returned box can have a new ID when the provider restores from a checkpoint. */
  wake(vm: WakeVm): Promise<Box>;
  /** Extends provider-side auto-stop timers while agents work. */
  keepAlive(box: Box): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  /** Deletes a checkpoint `sleep` made, or a base snapshot `snapshot` made, once nothing needs it. One already gone is fine. */
  deleteCheckpoint(checkpoint: string): Promise<void>;
  /** A stream of the VM's screen, or null while it is not running. Never wakes it. Present when the definition's `screen` is. */
  screen?(sandboxId: string): Promise<ScreenStream | null>;
  /**
   * A preview of a port other than T3's. Absent: `box.preview(port)`, which suits providers that give each port its own
   * preview. boxd's preview points the machine's one default route at the port, which would take it from T3.
   */
  preview?(box: Box, port: number): Promise<Preview>;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  website: string;
  fields: ProviderField[];
  features: ProviderFeatures;
  sizes: Record<VmSize, string>;
  /** The size new VMs get unless a setting or repository rule picks one: the closest to 2 vCPU and 8 GB. */
  defaultSize: VmSize;
  /** Its VMs have a desktop VM Bridge can stream to a watch link (see watch/). */
  screen?: boolean;
  /** It can be connected by signing in, instead of its key field (Boat, see boat-sign-in.ts). */
  signIn?: boolean;
  /** Why a new value for a secret field cannot be saved, or null when it can. Absent: any value can. */
  check?(field: string, value: string): Promise<string | null>;
  open(config: ProviderConfig): Driver;
}

export interface ProviderConfig {
  /** Field values by key: secrets and plain options together. */
  values: Record<string, string>;
  /** The provider's sign-in, connected or not. While connected, the provider uses it instead of its key field. */
  signIn?: SignIn;
}

/** A sign-in that can be connected and disconnected while drivers and their VMs stay open. */
export interface SignIn extends Credentials {
  connected(): boolean;
}

/** Bearer credentials that may change while a driver is open, such as OAuth tokens. */
export interface Credentials {
  /** The token for the next request. */
  token(): Promise<string>;
  /** Gets a new token after the provider refused the current one. */
  refresh(): Promise<void>;
  /** Values errors must never show. */
  secretValues(): string[];
}

export function required(config: ProviderConfig, key: string, label: string): string {
  const value = config.values[key];
  if (!value) throw new Error(`${label} is not set.`);
  return value;
}
