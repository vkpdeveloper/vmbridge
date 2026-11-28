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
  pullRequest: null,
  lastPrompt: null,
  createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
  lastUsedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  ...extra,
});

test("times read as how long ago", () => {
  expect([0, 5 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(ago)).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
});

const pull = { number: 142, url: "https://github.com/acme/forge/pull/142", state: "open" } as const;

test("the frame marks the selected worktree, with its branch, pull request, whether its VM runs, and the last prompt", () => {
  const worktrees = [
    worktree("ab12cd34", 5, { branch: "fix/login-redirect", pullRequest: pull, lastPrompt: "Fix the login redirect" }),
    worktree("ef56ab78", 180, { asleep: true }),
  ];
  const lines = pickerFrame("forge", worktrees, 1, now, 80, painter(1));
  expect(lines).toEqual([
    "  Open a worktree of forge",
    "",
    expect.stringMatching(/^ {4}fix\/login-redirect {2}#142 open +vm-b593d5 ● running {2}  5m ago$/),
    "    Fix the login redirect",
    expect.stringMatching(/^ {2}❯ opencode\/ef56ab78 +vm-b593d5 ○ asleep {2}  3h ago$/),
    "    No prompt yet",
    "",
    "  ↑↓ move · enter open · esc cancel",
  ]);
  for (const text of lines) expect([...text].length).toBeLessThanOrEqual(79);
  // The VM's state and the time line up from row to row.
  expect(lines[2]!.length).toBe(lines[4]!.length);
});

test("a long branch gives way, so its pull request, VM and time stay whole", () => {
  const long = worktree("ab12cd34", 5, { branch: "feat/a-very-long-branch-name-that-goes-on-and-on", pullRequest: { ...pull, state: "merged" } });
  const [, , row] = pickerFrame("forge", [long], 0, now, 80, painter(1));
  expect(row).toMatch(/^ {2}❯ feat\/a-very-long-branch-name-t…  #142 merged  vm-b593d5 ● running {4}5m ago$/);
  expect([...row!].length).toBe(79);
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
  expect(worktreeList("forge", [worktree("ab12cd34", 5, { pullRequest: pull, lastPrompt: "Fix it" }), worktree("ef56ab78", 9, { asleep: true })], now)).toEqual([
    "Worktrees of forge, last used first:",
    "  ab12cd34  opencode/ab12cd34  #142 open  vm-b593d5 ● running  5m ago  Fix it",
    "  ef56ab78  opencode/ef56ab78  vm-b593d5 ○ asleep  9m ago",
    "Open one with: vb opencode resume <id>",
  ]);
});
