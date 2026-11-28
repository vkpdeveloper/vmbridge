import { str, threadsOf, type Row, type Shell, type Wire } from "./types.ts";

/**
 * Commands that only change how T3 shows or files a thread, or settings it reads at the thread's next turn. VM Bridge
 * answers these itself and shows the result at once, then sends them to the thread's VM in the background: now when
 * it is awake, at its next connect when it is not. A sleeping VM is not woken for them.
 */
const heldCommandTypes = new Set([
  "thread.settle",
  "thread.auto-settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.archive",
  "thread.unarchive",
  "thread.visit",
  "thread.mark-unread",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.model-selection.set",
]);

/** Held settings a thread's next turn uses: a message sent after one is refused fails too, as it would have in T3. */
const nextTurnCommandTypes = new Set(["thread.runtime-mode.set", "thread.interaction-mode.set", "thread.model-selection.set"]);

/** Remembers a next-turn setting the VM refused for its thread, or forgets an older refusal one it accepted replaces. */
export function noteRefusedSetting(refusedSettings: Map<string, Set<string>>, command: Wire, refused: boolean) {
  const threadId = str(command.threadId);
  const type = String(command.type);
  if (!threadId || !nextTurnCommandTypes.has(type)) return;
  const types = refusedSettings.get(threadId) ?? new Set<string>();
  if (refused) types.add(type);
  else types.delete(type);
  if (types.size) refusedSettings.set(threadId, types);
  else refusedSettings.delete(threadId);
}

const renameFields = new Set(["type", "commandId", "threadId", "title"]);

/**
 * Whether VM Bridge holds a command (see `heldCommandTypes`). A metadata update is held only when it just renames the
 * thread: the others can move its worktree or start work. A delete is held unless it is the conditional one T3 checks
 * against the thread's messages, which VM Bridge cannot see.
 */
export function isHeldCommand(command: Wire) {
  if (command.type === "thread.metadata.update") return typeof command.title === "string" && Object.keys(command).every((key) => renameFields.has(key));
  if (command.type === "thread.delete") return command.onlyIfUnused !== true;
  return heldCommandTypes.has(String(command.type));
}

/**
 * Mirrors T3's own reducer for these commands on a cached shell (`dispatchThreadMutation` in T3's
 * `apps/server/src/orchestration-v2/Orchestrator.ts`). Re-applying a command gives the same result, since `at` is
 * when VM Bridge accepted it, so it can be laid over every VM update until the VM's shell shows it.
 */
export function applyHeldCommand(shell: Shell, command: Wire, at: string) {
  const id = str(command.threadId);
  const thread = threadsOf(shell).find((row) => row.id === id);
  if (!thread) return;
  if (command.type === "thread.delete") {
    // T3 deletes the thread's side chats with it.
    const deleted = (row: Row) => row.id === thread.id || isSideChatOf(row, thread.id);
    shell.threads = (shell.threads ?? []).filter((row) => !deleted(row));
    shell.archivedThreads = (shell.archivedThreads ?? []).filter((row) => !deleted(row));
    return;
  }
  const next = changed(thread, command, at);
  if (next === thread) return;
  shell.threads = (shell.threads ?? []).filter((row) => row.id !== id);
  shell.archivedThreads = (shell.archivedThreads ?? []).filter((row) => row.id !== id);
  const field = next.archivedAt ? "archivedThreads" : "threads";
  shell[field] = [...shell[field]!, next];
}

function isSideChatOf(row: Row, parentId: string) {
  const lineage = row.lineage as Wire | undefined;
  return lineage?.sideChat === true && lineage.parentThreadId === parentId;
}

/** Commands T3 refuses for an archived thread. */
const refusedWhenArchived = new Set(["thread.settle", "thread.auto-settle", "thread.unsettle", "thread.snooze", "thread.unsnooze", "thread.pin", "thread.unpin"]);

/** T3 ends a pull request watch when a thread is settled or archived, and keeps what it watched as `endedWatch`. */
function withoutWatches(thread: Row) {
  if (!Array.isArray(thread.pullRequests)) return {};
  const pullRequests = (thread.pullRequests as Wire[]).map(({ watch, endedWatch, ...rest }) => {
    const ended = watch ?? endedWatch;
    return ended === undefined ? rest : { ...rest, endedWatch: ended };
  });
  return { pullRequests };
}

function changed(thread: Row, command: Wire, at: string): Row {
  // T3 rejects these, so the VM's state stays as it is.
  if (thread.archivedAt && refusedWhenArchived.has(String(command.type))) return thread;
  // T3 skips an automatic settle once the user chose a state or the thread moved on.
  if (
    command.type === "thread.auto-settle" &&
    (thread.settledOverride != null || Date.parse(String(thread.updatedAt)) > Date.parse(String(command.snapshotAt)))
  ) {
    return thread;
  }
  const limitRecovery = thread.limitRecovery as Wire | null | undefined;
  switch (command.type) {
    case "thread.settle":
    case "thread.auto-settle": {
      const already = thread.settledOverride === "settled" && thread.settledAt != null && thread.pinnedAt == null;
      const snoozed = thread.snoozedUntil != null || thread.snoozedAt != null;
      return {
        ...thread,
        settledOverride: "settled",
        settledAt: already ? thread.settledAt : (str(command.settledAt) ?? at),
        // Settled threads refuse recovery, so T3 disarms a pending resume.
        ...(limitRecovery && { limitRecovery: { ...limitRecovery, autoResume: false, snooze: false } }),
        ...withoutWatches(thread),
        unsettledAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: already && !snoozed ? thread.updatedAt : at,
      };
    }
    case "thread.unsettle": {
      const already = thread.settledOverride === "active";
      const restore = command.restoreUnsettledAt;
      return {
        ...thread,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: already ? (thread.unsettledAt ?? null) : restore === undefined ? at : restore,
        updatedAt: already ? thread.updatedAt : at,
      };
    }
    case "thread.snooze": {
      const until = Date.parse(String(command.snoozedUntil));
      // T3 refuses a wake time that is not in the future.
      if (!(until > Date.parse(at))) return thread;
      return {
        ...thread,
        snoozedUntil: new Date(until).toISOString(),
        limitRecovery: limitRecovery ? { ...limitRecovery, snooze: false } : null,
        snoozedAt: at,
        updatedAt: at,
      };
    }
    case "thread.unsnooze": {
      const already = thread.snoozedUntil == null;
      return { ...thread, snoozedUntil: null, snoozedAt: null, updatedAt: already ? thread.updatedAt : at };
    }
    case "thread.pin": {
      const already = thread.pinnedAt != null;
      const settled = thread.settledOverride === "settled";
      const promotes = settled || thread.snoozedUntil != null;
      const orderKey = str(command.orderKey);
      return {
        ...thread,
        pinnedAt: already ? thread.pinnedAt : at,
        ...(!already && orderKey !== undefined && { pinOrderKey: orderKey }),
        settledOverride: settled ? "active" : thread.settledOverride,
        settledAt: settled ? null : thread.settledAt,
        ...(settled && { unsettledAt: at }),
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: already && !promotes ? thread.updatedAt : at,
      };
    }
    case "thread.unpin":
      return { ...thread, pinnedAt: null, pinOrderKey: null, updatedAt: thread.pinnedAt == null ? thread.updatedAt : at };
    case "thread.archive":
      return thread.archivedAt ? thread : { ...thread, archivedAt: at, titleRegeneration: null, ...withoutWatches(thread), updatedAt: at };
    case "thread.unarchive":
      return thread.archivedAt ? { ...thread, archivedAt: null, updatedAt: at } : thread;
    case "thread.visit": {
      // T3 refuses a visit time it cannot read, and records a visit only when it moves the read mark forward. It also
      // counts opens for search ranking, by its own clock; that shows once the VM reports it.
      const visitedAt = Date.parse(String(command.visitedAt));
      if (Number.isNaN(visitedAt)) return thread;
      const last = thread.lastVisitedAt == null ? null : Date.parse(String(thread.lastVisitedAt));
      if (last !== null && visitedAt <= last) return thread;
      return { ...thread, lastVisitedAt: new Date(visitedAt).toISOString() };
    }
    case "thread.mark-unread": {
      // T3 refuses a thread with no finished run, and marks it read up to just before that run finished.
      if (thread.latestRunCompletedAt == null) return thread;
      const lastVisitedAt = new Date(Date.parse(String(thread.latestRunCompletedAt)) - 1).toISOString();
      // A snooze whose time passed ends here, before the read mark moves back.
      const snoozeExpired = thread.snoozedUntil != null && Date.parse(String(thread.snoozedUntil)) <= Date.parse(at);
      return { ...thread, lastVisitedAt, ...(snoozeExpired && { snoozedUntil: null, snoozedAt: null }) };
    }
    case "thread.metadata.update": {
      // Held only as a rename. T3 trims the title and refuses an empty one.
      const title = String(command.title).trim();
      return title ? { ...thread, title, titleRegeneration: null, updatedAt: at } : thread;
    }
    case "thread.runtime-mode.set":
      return { ...thread, runtimeMode: command.runtimeMode, updatedAt: at };
    case "thread.interaction-mode.set":
      return { ...thread, interactionMode: command.interactionMode, updatedAt: at };
    case "thread.model-selection.set": {
      const modelSelection = command.modelSelection as Wire | undefined;
      const instanceId = str(modelSelection?.instanceId);
      if (!modelSelection || !instanceId) return thread;
      // T3 refuses to switch a running thread to another agent.
      if (instanceId !== thread.providerInstanceId && thread.activeRunId != null) return thread;
      return { ...thread, providerInstanceId: instanceId, modelSelection, updatedAt: at };
    }
    default:
      return thread;
  }
}
