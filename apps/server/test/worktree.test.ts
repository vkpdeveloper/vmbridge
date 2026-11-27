import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorktreeProgram, worktreePath } from "../src/vm/opencode.ts";

/** Runs a shell program as runProgram does on a VM, here against real git repositories. */
function sh(program: string, cwd?: string) {
  const result = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${program}`], { cwd, stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A clone of a bare origin, as /workspace/<repo> on a VM, with a worktree on `opencode/<name>` from origin/main. */
function setUp(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "vmb-worktree-"));
  dirs.push(dir);
  const git = "git -c user.name=t -c user.email=t@t -c init.defaultBranch=main";
  sh(`${git} init --quiet --bare origin.git
${git} clone --quiet origin.git app 2>/dev/null
cd app && ${git} commit --quiet --allow-empty -m first && git push --quiet origin main`, dir);
  const checkout = join(dir, "app");
  const path = worktreePath(checkout, name);
  sh(`git worktree add --quiet -b opencode/${name} ${path} origin/main`, checkout);
  const commit = (message: string) => sh(`${git} commit --quiet --allow-empty -m ${message}`, path);
  return { checkout, path, commit, remove: () => sh(removeWorktreeProgram(checkout, name)) };
}

const branches = (checkout: string) => sh("git branch --format='%(refname:short)'", checkout).trim().split("\n");

describe("removing a vmbridge opencode worktree", () => {
  test("goes with its branch when it holds nothing", () => {
    const { checkout, remove } = setUp("ab12cd34");
    expect(remove()).toBe("removed");
    expect(sh("git worktree list --porcelain", checkout)).not.toContain(".worktrees");
    expect(branches(checkout)).toEqual(["main"]);
  });

  test("stays while it has uncommitted or untracked files", () => {
    const { checkout, path, remove } = setUp("ab12cd34");
    writeFileSync(join(path, "notes.md"), "draft");
    expect(remove()).toBe("kept opencode/ab12cd34");
    expect(branches(checkout)).toContain("opencode/ab12cd34");
  });

  test("stays while it has commits that are not pushed, naming the branch an agent moved it to, and goes once they are", () => {
    const { path, commit, remove } = setUp("ab12cd34");
    sh("git switch --quiet -c fix/login", path);
    commit("work");
    expect(remove()).toBe("kept fix/login");
    sh("git push --quiet origin fix/login", path);
    expect(remove()).toBe("removed");
  });

  test("tidies a worktree whose folder is already gone", () => {
    const { checkout, path, remove } = setUp("ab12cd34");
    rmSync(path, { recursive: true });
    expect(remove()).toBe("removed");
    expect(branches(checkout)).toEqual(["main"]);
  });
});
