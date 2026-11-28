import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { AlertCircleIcon, CancelCircleIcon, CheckmarkCircle02Icon, CircleIcon, Clock01Icon, DashedLineCircleIcon, HelpCircleIcon } from "@hugeicons/core-free-icons";
import type { SessionActivity, SessionState } from "@vmbridge/contracts";
import { cn } from "@/lib/utils";
import { useTick } from "./api.ts";

/** Labels and colors as T3's sidebar has them. */
const looks: Record<SessionState, { label: string; icon: IconSvgElement; className: string }> = {
  working: { label: "Working", icon: DashedLineCircleIcon, className: "text-sky-600 dark:text-sky-300/80" },
  starting: { label: "Starting", icon: DashedLineCircleIcon, className: "text-sky-600 dark:text-sky-300/80" },
  approval: { label: "Needs approval", icon: AlertCircleIcon, className: "text-amber-600 dark:text-amber-300/90" },
  input: { label: "Needs input", icon: HelpCircleIcon, className: "text-indigo-600 dark:text-indigo-300/90" },
  waiting: { label: "Waiting", icon: Clock01Icon, className: "text-muted-foreground" },
  failed: { label: "Failed", icon: CancelCircleIcon, className: "text-red-600 dark:text-red-300/90" },
  done: { label: "Done", icon: CheckmarkCircle02Icon, className: "text-emerald-600 dark:text-emerald-300/90" },
  idle: { label: "Idle", icon: CircleIcon, className: "text-muted-foreground" },
};

/** "12s", "3m" or "1h 5m", as T3 times a running turn. */
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "now", "5m ago", "2h ago" or "3d ago", for a turn that ended. */
function ago(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** What a session is doing, such as "Working 3m" or "Done 5m ago". */
export function SessionStatus({ activity }: { activity: SessionActivity }) {
  const { state, since } = activity;
  // A turn still going is timed, like T3's "Working 3m". One that ended says how long ago.
  const ongoing = state === "working" || state === "starting" || state === "waiting";
  // Each second only while a turn runs, for its timer.
  const now = useTick(ongoing && since ? 1000 : 30_000);
  const look = looks[state];
  const time = since ? (ongoing ? duration(now - since) : ago(now - since)) : null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-xs font-medium", look.className)}>
      <HugeiconsIcon icon={look.icon} className="size-3.5" strokeWidth={2} />
      {time ? `${look.label} ${time}` : look.label}
    </span>
  );
}
