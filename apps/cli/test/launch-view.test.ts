import { expect, test } from "bun:test";
import { duration, frame, Launch, launchView, painter, summary, type Ready } from "../src/launch-view.ts";

const plain = painter(1);
const ready: Ready = {
  path: "/opencode/p/w/vm/ab12",
  password: "secret-password",
  projectId: "p",
  project: "fikrabot",
  vmId: "vm",
  vm: "vm-3f2a1c",
  name: "ab12",
  directory: "/workspace/fikrabot/.worktrees/ab12",
  branch: "opencode/ab12",
  base: "main",
  sessionId: null,
};

/** A cold launch as the server sends it, at the times it took. */
function coldLaunch() {
  const launch = new Launch(0, ["Making a worktree", "Starting OpenCode"]);
  launch.update({ step: "Finding a VM for fikrabot" }, 0);
  launch.update({ step: "Waking vm-3f2a1c on Daytona" }, 200);
  launch.update({ detail: "Waiting for Daytona" }, 300);
  launch.update({ detail: "Starting T3" }, 12_000);
  return launch;
}

test("steps end when the next starts, the latest detail shows, and waiting steps go once they start", () => {
  const launch = coldLaunch();
  expect(launch.steps.map((step) => [step.text, step.ended])).toEqual([
    ["Finding a VM for fikrabot", 200],
    ["Waking vm-3f2a1c on Daytona", null],
  ]);
  expect(launch.current?.detail).toBe("Starting T3");
  expect(launch.waiting).toEqual(["Making a worktree", "Starting OpenCode"]);

  launch.update({ notice: "Every VM is busy" }, 24_000);
  launch.update({ step: "Making a worktree" }, 24_000);
  expect(launch.waiting).toEqual(["Starting OpenCode"]);
  expect(launch.steps[1]?.detail).toBeNull();
  expect(launch.rows.some((row) => "notice" in row)).toBe(true);
});

test("a frame shows done, running and waiting steps with their times, and never a line wider than the terminal", () => {
  const lines = frame(coldLaunch(), 14_250, 60, plain);
  expect(lines.join("\n")).toMatchInlineSnapshot(`
"  ✓ Finding a VM for fikrabot                          0.2s
  ⠹ Waking vm-3f2a1c on Daytona                       14.0s
    └ Starting T3
  · Making a worktree
  · Starting OpenCode

  ━━━━━━━━━━━━━━━━━━━━━━━━━━────────────────────────  14.2s"
`);
  for (const width of [20, 40, 120]) {
    for (const text of frame(coldLaunch(), 14_250, width, plain)) expect([...text].length).toBeLessThan(width);
  }
});

test("a failed launch marks its step and drops what was still to come", () => {
  const launch = coldLaunch();
  launch.end(20_000, true);
  const lines = frame(launch, 20_000, 60, plain, true);
  expect(lines[1]).toContain("✕ Waking vm-3f2a1c on Daytona");
  expect(lines.join("\n")).not.toContain("Making a worktree");
  expect(lines.join("\n")).not.toContain("━");
});

test("the summary keeps each step's time and never shows the password", () => {
  const launch = coldLaunch();
  launch.update({ step: "Starting OpenCode" }, 27_000);
  launch.end(36_000);
  const lines = summary(launch, ready, 36_000, 80, plain);
  expect(lines).toEqual([
    "  ✓ Ready in 36.0s  opencode/ab12 from main on vm-3f2a1c",
    "    Finding a VM for fikrabot 0.2s · Waking vm-3f2a1c on Daytona 26.8s",
    "    Starting OpenCode 9.0s",
  ]);
  const text = lines.join("\n");
  expect(text).not.toContain(ready.password);
});

test("colours follow the terminal's depth, and none without colour", () => {
  expect(painter(24)("primary", "x")).toBe("\x1b[38;2;139;92;246mx\x1b[39m");
  expect(painter(8)("success", "x")).toBe("\x1b[32mx\x1b[39m");
  expect(painter(1)("success", "x")).toBe("x");
});

test("durations read as seconds, then minutes", () => {
  expect([duration(0), duration(4_260), duration(59_990), duration(64_000)]).toEqual(["0.0s", "4.2s", "59.9s", "1m 04s"]);
});

test("off a terminal it prints one plain line per step, as a log keeps them", () => {
  let written = "";
  let clock = 0;
  const view = launchView({ isTTY: false, write: (text) => (written += text) }, [], () => clock);
  view.update({ step: "Finding a VM for fikrabot" });
  view.update({ detail: "Waiting for Daytona" });
  clock = 24_400;
  view.update({ step: "Making a worktree" });
  view.update({ notice: "Every VM is busy" });
  clock = 36_000;
  view.ready(ready);
  expect(written).toBe(
    "  0s  Finding a VM for fikrabot\n 24s  Making a worktree\n 24s  Note: Every VM is busy\n 36s  Ready: opencode/ab12 from main on vm-3f2a1c\n\n",
  );
});
