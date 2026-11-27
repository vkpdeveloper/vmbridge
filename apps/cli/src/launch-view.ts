// How `vmbridge opencode` shows a launch: a live step list in a terminal, one plain line per step anywhere else.
import type { OpenCodeLaunchEvent } from "@vmbridge/contracts";

export type Ready = Extract<OpenCodeLaunchEvent, { ready: unknown }>["ready"];
export type Update = Extract<OpenCodeLaunchEvent, { step: string } | { detail: string } | { notice: string }>;

interface Step {
  text: string;
  started: number;
  ended: number | null;
  /** What it is doing now, from the latest `detail`. */
  detail: string | null;
  failed: boolean;
}

type Row = { step: Step } | { notice: string };

/** The launch so far: its steps and notices in order, and the steps still to come. Times are in ms. */
export class Launch {
  readonly rows: Row[] = [];
  readonly started: number;
  /** Steps every launch ends with, shown as waiting until they start. Placement's own steps are not known ahead. */
  waiting: string[];

  constructor(started: number, waiting: string[]) {
    this.started = started;
    this.waiting = waiting;
  }

  get steps() {
    return this.rows.flatMap((row) => ("step" in row ? [row.step] : []));
  }

  /** The step running now, if any. */
  get current() {
    const last = this.steps.at(-1);
    return last && last.ended === null ? last : undefined;
  }

  update(event: Update, now: number) {
    if ("step" in event) {
      this.end(now);
      this.rows.push({ step: { text: event.step, started: now, ended: null, detail: null, failed: false } });
      const at = this.waiting.indexOf(event.step);
      if (at >= 0) this.waiting = this.waiting.slice(at + 1);
    } else if ("detail" in event) {
      const current = this.current;
      if (current) current.detail = event.detail;
    } else this.rows.push({ notice: event.notice });
  }

  /** Ends the running step. A failed launch marks it failed. */
  end(now: number, failed = false) {
    const current = this.current;
    if (!current) return;
    current.ended = now;
    current.detail = null;
    current.failed = failed;
  }
}

/** `4.2s` under a minute, `1m 04s` from then on. */
export function duration(ms: number) {
  const tenths = Math.max(0, Math.floor(ms / 100));
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// VM Bridge's colours, from apps/web/src/styles.css, with the nearest of the 16 basic colours for older terminals.
const tones = {
  foreground: { hex: "#ededed", basic: 39 },
  muted: { hex: "#8f8f8f", basic: 37 },
  faint: { hex: "#5c5c5c", basic: 90 },
  primary: { hex: "#8b5cf6", basic: 95 },
  dim: { hex: "#3b2a66", basic: 35 },
  success: { hex: "#3ecf8e", basic: 32 },
  warning: { hex: "#f5b74e", basic: 33 },
  destructive: { hex: "#f2555a", basic: 31 },
} as const;

export type Tone = keyof typeof tones;
type Segment = [tone: Tone, text: string];

/** Paints text for a terminal of this colour depth (as `getColorDepth` answers): 24 bits, a few colours, or none. */
export function painter(depth: number) {
  return (tone: Tone, text: string) => {
    if (depth < 4 || !text) return text;
    const { hex, basic } = tones[tone];
    if (depth < 24) return `\x1b[${basic}m${text}\x1b[39m`;
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  };
}

type Paint = ReturnType<typeof painter>;

/** Joins segments into one line no wider than `width`, cutting the text, never the colours, with an ellipsis. */
function line(segments: Segment[], width: number, paint: Paint) {
  let room = width;
  let out = "";
  for (const [tone, text] of segments) {
    if (room <= 0) break;
    const chars = [...text];
    const fits = chars.length <= room;
    out += paint(tone, fits ? text : `${chars.slice(0, Math.max(0, room - 1)).join("")}…`);
    room -= fits ? chars.length : room;
  }
  return out;
}

const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** The widest the list gets, so times line up near the names on wide terminals. */
const maxWidth = 72;

/**
 * The bar: one equal part per step, filled for those done. The running step's part has no real percentage, so a short
 * light moves across it instead of filling it.
 */
function bar(launch: Launch, now: number, cells: number): Segment[] {
  const done = launch.steps.filter((step) => step.ended !== null).length;
  const running = launch.current ? 1 : 0;
  const total = Math.max(1, done + running + launch.waiting.length);
  const filled = Math.round((done / total) * cells);
  const active = running ? Math.max(3, Math.round(cells / total)) : 0;
  const segments: Segment[] = [["primary", "━".repeat(filled)]];
  if (active) {
    const light = Math.floor((now - launch.started) / 100) % (active + 2);
    for (let cell = 0; cell < Math.min(active, cells - filled); cell++) {
      segments.push(cell === light || cell === light - 1 ? ["primary", "━"] : ["dim", "━"]);
    }
  }
  segments.push(["faint", "─".repeat(Math.max(0, cells - filled - active))]);
  return segments;
}

/** The live view's lines at `now`. `final` drops the bar and the steps still to come, as after a failure. */
export function frame(launch: Launch, now: number, width: number, paint: Paint, final = false) {
  const inner = Math.min(width - 1, maxWidth);
  const timeWidth = 7;
  const nameWidth = Math.max(4, inner - 4 - timeWidth);
  const lines: string[] = [];
  const row = (mark: Segment, text: string, tone: Tone, time: string, timeTone: Tone) => {
    const name = [...text].length > nameWidth ? `${[...text].slice(0, nameWidth - 1).join("")}…` : time ? text.padEnd(nameWidth) : text;
    return line([["foreground", "  "], mark, ["foreground", " "], [tone, name], [timeTone, time && time.padStart(timeWidth)]], inner, paint);
  };
  for (const entry of launch.rows) {
    if ("notice" in entry) {
      lines.push(line([["warning", "  ! "], ["warning", entry.notice]], inner, paint));
      continue;
    }
    const step = entry.step;
    if (step.ended !== null) {
      const mark: Segment = step.failed ? ["destructive", "✕"] : ["success", "✓"];
      lines.push(row(mark, step.text, step.failed ? "destructive" : "muted", duration(step.ended - step.started), "faint"));
      continue;
    }
    const frameAt = Math.floor((now - launch.started) / 100) % spinner.length;
    lines.push(row(["primary", spinner.charAt(frameAt)], step.text, "foreground", duration(now - step.started), "foreground"));
    if (step.detail) lines.push(line([["faint", "    └ "], ["muted", step.detail]], inner, paint));
  }
  if (final) return lines;
  for (const text of launch.waiting) lines.push(row(["faint", "·"], text, "faint", "", "faint"));
  lines.push("");
  const total = duration(now - launch.started);
  lines.push(line([["foreground", "  "], ...bar(launch, now, Math.max(4, inner - 4 - total.length)), ["foreground", "  "], ["muted", total]], inner, paint));
  return lines;
}

/** What stays on screen once OpenCode is ready: a line on the result, then each step's time over as few lines as fit. */
export function summary(launch: Launch, ready: Ready, now: number, width: number, paint: Paint) {
  const inner = Math.min(width - 1, maxWidth);
  const where = `${ready.branch}${ready.base ? ` from ${ready.base}` : ""} on ${ready.vm}`;
  const times: string[] = [];
  for (const step of launch.steps) {
    const time = `${step.text} ${duration((step.ended ?? now) - step.started)}`;
    const joined = times.length ? `${times.at(-1)} · ${time}` : time;
    if (times.length && joined.length + 4 <= inner) times[times.length - 1] = joined;
    else times.push(time);
  }
  const notices = launch.rows.flatMap((row) => ("notice" in row ? [line([["warning", "  ! "], ["warning", row.notice]], inner, paint)] : []));
  return [
    line([["success", "  ✓ "], ["foreground", `Ready in ${duration(now - launch.started)}`], ["muted", `  ${where}`]], inner, paint),
    ...times.map((text) => line([["faint", `    ${text}`]], inner, paint)),
    ...notices,
  ];
}

/** Where the launch is shown. `process.stdout` in use; tests pass their own. */
export interface Output {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
  getColorDepth?(): number;
}

export interface LaunchView {
  update(event: Update): void;
  /** The launch failed. The caller prints why. */
  fail(): void;
  ready(ready: Ready): void;
}

/** A live view on a terminal, else plain lines as a log or CI keeps them. */
export function launchView(out: Output, waiting: string[], now = () => Date.now()): LaunchView {
  return out.isTTY ? liveView(out, waiting, now) : plainView(out, now);
}

/** One line per step with whole seconds since the start, and no escape codes. Details are left out. */
function plainView(out: Output, now: () => number): LaunchView {
  const started = now();
  const at = () => `${Math.round((now() - started) / 1000)}s`.padStart(4);
  return {
    update(event) {
      if ("step" in event) out.write(`${at()}  ${event.step}\n`);
      else if ("notice" in event) out.write(`${at()}  Note: ${event.notice}\n`);
    },
    fail() {},
    ready({ branch, base, vm }) {
      out.write(`${at()}  Ready: ${branch}${base ? ` from ${base}` : ""} on ${vm}\n\n`);
    },
  };
}

const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";
// Terminals that know it show a whole frame at once; others ignore it.
const syncStart = "\x1b[?2026h";
const syncEnd = "\x1b[?2026l";

/**
 * Redraws the launch in place ten times a second while a step runs. Each frame is written at once, over the last, and
 * no line is wider than the terminal, so a line never wraps and the count of lines to go back up stays right. The
 * cursor is hidden meanwhile and shown again however the launch ends, Ctrl+C included.
 */
function liveView(out: Output, waiting: string[], now: () => number): LaunchView {
  const launch = new Launch(now(), waiting);
  const paint = painter(out.getColorDepth?.() ?? 1);
  const width = () => out.columns || 80;
  let drawn = 0;

  const draw = (lines: string[]) => {
    const up = drawn ? `\x1b[${drawn}F` : "";
    out.write(`${syncStart}${up}${lines.map((text) => `\x1b[2K${text}\n`).join("")}\x1b[J${syncEnd}`);
    drawn = lines.length;
  };
  const tick = () => draw(frame(launch, now(), width(), paint));
  const restore = () => out.write(showCursor);
  const interrupt = () => {
    stop();
    process.exit(130);
  };
  const timer = setInterval(tick, 100);
  const stop = () => {
    clearInterval(timer);
    restore();
    process.off("exit", restore);
    process.off("SIGINT", interrupt);
  };
  out.write(hideCursor);
  process.on("exit", restore);
  process.on("SIGINT", interrupt);

  return {
    update(event) {
      launch.update(event, now());
      tick();
    },
    fail() {
      launch.end(now(), true);
      draw(frame(launch, now(), width(), paint, true));
      stop();
    },
    ready(ready) {
      launch.end(now());
      // Clears the list so OpenCode's terminal app starts on a clean screen, leaving only the summary.
      draw(summary(launch, ready, now(), width(), paint));
      stop();
    },
  };
}
