import type { Wire } from "./types.ts";

/**
 * T3 settings that VM Bridge saves from T3's settings screen and sets on every VM, so they apply whichever VM runs a
 * thread. Each is a plain value or struct that T3 deep-merges (`applyServerSettingsPatch` in T3 Code), so merging and
 * resending them is exact. Left out: credentials and providers, paths and lifecycle VM Bridge manages, per-project
 * overrides (each project's live on the VM that owns it), settings for the machine's own devices and speech, access,
 * and settings T3 merges in its own way.
 */
export const fleetSettingKeys = new Set([
  // Settings T3 clients copy to every connected environment as they change on one.
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
  "textGenerationModelSelection",
  // Threads and models.
  "defaultModelSelection",
  "fallbackModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "responseStreamingMode",
  "promptSuggestionsEnabled",
  "threadTitleInstructions",
  "sidebarAutoSettleKeepPullRequests",
  "idleCompaction",
  "hiddenThreadTags",
  "hideTaggedThreads",
  "workflowsEnabled",
  "workflowSkippedRunsKept",
  "enableAgentBrowserAccess",
  // Source control.
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "removeAgentCreditsOnMerge",
  "sourceControlWriterModelSelection",
  "reviewGuidesEnabled",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "pullRequestMergeMethod",
  // VM Bridge's own icon in T3's environment list.
  "environmentIcon",
]);

const isStruct = (value: unknown): value is Wire => typeof value === "object" && value !== null && !Array.isArray(value);

/** T3's merge: structs merge key by key, anything else replaces, and `undefined` leaves a key alone. */
export function mergeSettings(current: Wire, patch: Wire): Wire {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = next[key];
    next[key] = isStruct(existing) && isStruct(value) ? mergeSettings(existing, value) : value;
  }
  return next;
}

/** Whether `settings` already has every value in `patch`, so sending it would change nothing. */
export function hasSettings(settings: unknown, patch: Wire): boolean {
  if (!isStruct(settings)) return false;
  return Object.entries(patch).every(([key, value]) =>
    isStruct(value) ? hasSettings(settings[key], value) : JSON.stringify(settings[key]) === JSON.stringify(value),
  );
}

const kind = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/**
 * Keys in `patch` VM Bridge can't save: outside `fleetSettingKeys`, or a value of a different kind than the setting
 * holds now (`current`), which would leave clients a config they can't read. A null setting takes any value.
 */
export function refusedSettings(patch: Wire, current: Wire): string[] {
  return Object.entries(patch).flatMap(([key, value]) => {
    if (value === undefined) return [];
    const held = current[key];
    const fits = held === undefined || held === null || value === null || kind(held) === kind(value);
    return fleetSettingKeys.has(key) && fits ? [] : [key];
  });
}
