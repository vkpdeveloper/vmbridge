import type { SessionActivity } from "@vmbridge/contracts";

/** A T3 wire object. VM Bridge reads a few known fields and forwards the rest untouched. */
export type Wire = Record<string, unknown>;

/** A shell row (project or thread): always has an ID. */
export type Row = Wire & { id: string };

export interface Shell extends Wire {
  projects?: Row[];
  threads?: Row[];
  archivedThreads?: Row[];
  snapshotSequence?: number;
}

export interface ShellItem extends Wire {
  kind: string;
  snapshot?: Shell;
  project?: Row;
  projectId?: string;
  thread?: Row;
  threadId?: string;
  location?: string;
  sequence?: number;
}

export interface ProviderEntry extends Wire {
  instanceId: string;
  driver: string;
  enabled?: boolean;
}

export interface ServerConfig extends Wire {
  environment?: Wire & { orchestrationProtocolVersion?: number; serverVersion?: string };
  providers?: ProviderEntry[];
  settings?: Wire;
}

export interface Projection extends Wire {
  thread?: Row;
  updatedAt?: string;
  turnItems?: (Wire & { ordinal?: number })[];
  visibleTurnItems?: (Wire & { position?: number })[];
  runs?: (Wire & { ordinal?: number })[];
}

export interface ScheduledTasks extends Wire {
  tasks: (Wire & { id: string; enabled?: boolean; blockedByPolicy?: boolean; nextRunAt?: string | null })[];
  timeZone?: string;
}

export const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export const threadsOf = (shell: Shell | undefined) => [...(shell?.threads ?? []), ...(shell?.archivedThreads ?? [])];

const busy = new Set(["preparing", "queued", "starting", "running", "waiting", "pending"]);

/** A running turn, queued work, or a pending approval. */
export const isWorking = (thread: Wire) =>
  Boolean(thread.activeRunId || thread.pendingRuntimeRequest) || busy.has(String(thread.status)) || busy.has(String(thread.activityRunStatus));

const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** What a thread is doing, decided in the order T3's sidebar decides its status. */
export function threadActivity(thread: Wire): SessionActivity {
  const request = thread.pendingRuntimeRequest as { kind?: unknown } | null | undefined;
  if (request) return { state: request.kind === "user_input" ? "input" : "approval", since: null };
  const run = String(thread.activityRunStatus ?? thread.status);
  const started = time(thread.activityRunStartedAt) ?? time(thread.latestRunStartedAt);
  if (run === "running" || run === "waiting") return { state: thread.blockedOnThreadWait === true ? "waiting" : "working", since: started };
  if (run === "preparing" || run === "starting" || run === "queued") return { state: "starting", since: started };
  if (Array.isArray(thread.pendingBackgroundTasks) && thread.pendingBackgroundTasks.length > 0) return { state: "waiting", since: null };
  const finished = time(thread.latestRunCompletedAt);
  if (thread.status === "failed") return { state: "failed", since: finished };
  if (thread.status === "completed") return { state: "done", since: finished };
  return { state: "idle", since: null };
}

/** Working threads keep a VM awake. Open UIs do not. */
export const hasLiveWork = (shell: Shell) => threadsOf(shell).some(isWorking);
