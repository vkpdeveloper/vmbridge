// `vmbridge opencode resume`: the list of a repository's worktrees to pick one from, last used first.
import type { OpenCodeWorktree } from "@vmbridge/contracts";
import { line, painter, type Output, type Paint, type Segment } from "./launch-view.ts";

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** How many worktrees show at once. The list scrolls past that. */
const shown = 6;
const maxWidth = 80;

/** The picker's lines with `selected` highlighted, scrolled to keep it in view. */
export function pickerFrame(project: string, worktrees: OpenCodeWorktree[], selected: number, now: number, width: number, paint: Paint) {
  const inner = Math.min(width - 1, maxWidth);
  const first = Math.min(Math.max(0, selected - shown + 1), Math.max(0, worktrees.length - shown));
  const lines = [line([["foreground", `  Open a worktree of ${project}`]], inner, paint), ""];
  if (first > 0) lines.push(line([["faint", `    ↑ ${first} more`]], inner, paint));
  for (const [offset, worktree] of worktrees.slice(first, first + shown).entries()) {
    const on = first + offset === selected;
    const when = ago(now - Date.parse(worktree.lastUsedAt));
    const where = `${worktree.vm}${worktree.asleep ? ", asleep" : ""}`;
    const room = Math.max(0, inner - 4 - [...worktree.branch].length - where.length - when.length - 4);
    const title: Segment[] = [
      [on ? "primary" : "faint", on ? "  ❯ " : "    "],
      [on ? "foreground" : "muted", worktree.branch],
      ["faint", `  ${where}${" ".repeat(room)}  `],
      ["muted", when],
    ];
    lines.push(line(title, inner, paint));
    lines.push(line([["faint", "    "], [on ? "muted" : "faint", worktree.lastPrompt ?? "No prompt yet"]], inner, paint));
  }
  const after = worktrees.length - first - shown;
  if (after > 0) lines.push(line([["faint", `    ↓ ${after} more`]], inner, paint));
  lines.push("", line([["faint", "  ↑↓ move · enter open · esc cancel"]], inner, paint));
  return lines;
}

type Key = "up" | "down" | "open" | "cancel" | null;

/** What a keypress means in the picker. Arrow keys, j and k, enter, and esc, q or Ctrl+C. */
export function keyOf(data: string): Key {
  if (data === "\x1b[A" || data === "k") return "up";
  if (data === "\x1b[B" || data === "j") return "down";
  if (data === "\r" || data === "\n") return "open";
  if (data === "\x1b" || data === "q" || data === "\x03") return "cancel";
  return null;
}

/** Plain lines for a terminal that can't take keys, with the command to open each. */
export function worktreeList(project: string, worktrees: OpenCodeWorktree[], now: number) {
  return [
    `Worktrees of ${project}, last used first:`,
    ...worktrees.map((worktree) => `  ${worktree.name}  ${worktree.branch}  ${worktree.vm}  ${ago(now - Date.parse(worktree.lastUsedAt))}  ${worktree.lastPrompt ?? ""}`.trimEnd()),
    "Open one with: vb opencode resume <id>",
  ];
}

/**
 * Lets the user pick a worktree with the keyboard. Answers its name, or null when they cancel. The list is cleared
 * afterwards, so what runs next starts where it began.
 */
export function pickWorktree(
  project: string,
  worktrees: OpenCodeWorktree[],
  out: Output = process.stdout,
  input: NodeJS.ReadStream = process.stdin,
): Promise<string | null> {
  const paint = painter(out.getColorDepth?.() ?? 1);
  let selected = 0;
  let drawn = 0;
  const draw = (lines: string[]) => {
    const up = drawn ? `\x1b[${drawn}F` : "";
    out.write(`${up}${lines.map((text) => `\x1b[2K${text}\n`).join("")}\x1b[J`);
    drawn = lines.length;
  };
  const render = () => draw(pickerFrame(project, worktrees, selected, Date.now(), out.columns || 80, paint));

  return new Promise((resolve) => {
    const restore = () => out.write("\x1b[?25h");
    const finish = (name: string | null) => {
      input.off("data", onKey);
      input.setRawMode?.(false);
      input.pause();
      draw([]);
      restore();
      process.off("exit", restore);
      resolve(name);
    };
    const onKey = (chunk: Buffer) => {
      const key = keyOf(chunk.toString());
      if (key === "up") selected = (selected - 1 + worktrees.length) % worktrees.length;
      else if (key === "down") selected = (selected + 1) % worktrees.length;
      else if (key === "open") return finish(worktrees[selected]!.name);
      else if (key === "cancel") return finish(null);
      else return;
      render();
    };
    out.write("\x1b[?25l");
    process.on("exit", restore);
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onKey);
    render();
  });
}
