import { expect, test } from "bun:test";
import type { OpenCodeWorktree } from "@vmbridge/contracts";
import { painter } from "../src/launch-view.ts";
import { ago, keyOf, pickerFrame, worktreeList } from "../src/worktree-picker.ts";

const now = Date.parse("2026-11-28T12:00:00Z");
const worktree = (name: string, minutesAgo: number, extra: Partial<OpenCodeWorktree> = {}): OpenCodeWorktree => ({
  name,
  branch: `opencode/${name}`,
  base: "main",
  vm: "vm-b593d5",
  asleep: false,
  lastPrompt: null,
  createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
  lastUsedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  ...extra,
});

test("times read as how long ago", () => {
  expect([0, 5 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(ago)).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
});

test("the frame marks the selected worktree, says when a VM sleeps, and shows the last prompt", () => {
  const lines = pickerFrame("forge", [worktree("ab12cd34", 5, { lastPrompt: "Fix the login redirect" }), worktree("ef56ab78", 180, { asleep: true })], 1, now, 80, painter(1));
  expect(lines).toEqual([
    "  Open a worktree of forge",
    "",
    expect.stringMatching(/^ {4}opencode\/ab12cd34 {2}vm-b593d5 +5m ago$/),
    "    Fix the login redirect",
    expect.stringMatching(/^ {2}❯ opencode\/ef56ab78 {2}vm-b593d5, asleep +3h ago$/),
    "    No prompt yet",
    "",
    "  ↑↓ move · enter open · esc cancel",
  ]);
  for (const text of lines) expect([...text].length).toBeLessThanOrEqual(79);
});

test("a long list scrolls to keep the selected worktree in view, and lines fit narrow terminals", () => {
  const many = Array.from({ length: 10 }, (_, n) => worktree(`ab12cd3${n}`, n));
  const lines = pickerFrame("forge", many, 8, now, 40, painter(1));
  expect(lines).toContain("    ↑ 3 more");
  expect(lines).toContain("    ↓ 1 more");
  expect(lines.some((text) => text.includes("❯ opencode/ab12cd38"))).toBe(true);
  for (const text of lines) expect([...text].length).toBeLessThanOrEqual(39);
});

test("keys", () => {
  expect(["\x1b[A", "k", "\x1b[B", "j", "\r", "\x1b", "q", "\x03", "x"].map(keyOf)).toEqual(["up", "up", "down", "down", "open", "cancel", "cancel", "cancel", null]);
});

test("without a terminal to pick in, the list says how to open one", () => {
  expect(worktreeList("forge", [worktree("ab12cd34", 5, { lastPrompt: "Fix it" })], now)).toEqual([
    "Worktrees of forge, last used first:",
    "  ab12cd34  opencode/ab12cd34  vm-b593d5  5m ago  Fix it",
    "Open one with: vb opencode resume <id>",
  ]);
});
