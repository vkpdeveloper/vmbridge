import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorktreeProgram, fixWorktreeLinks, listWorktreesProgram, removeWorktreeProgram, worktreePath } from "../src/vm/opencode.ts";
import { quote } from "../src/vm/runtime.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Hub } from "../src/gateway/hub.ts";
import { openCodeLauncher, syncWorktrees } from "../src/gateway/opencode-launch.ts";
import { Traffic } from "../src/traffic.ts";
import { Store } from "../src/store.ts";
import { testEncryption } from "./key.ts";

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

/** As on a Boat VM that resumed while git made the worktree: its `.git` file names a folder that is gone later. */
const breakLink = (path: string, name: string) => writeFileSync(join(path, ".git"), `gitdir: /var/lib/ascii-lazy/retired/workspace/app/.git/worktrees/${name}\n`);

describe("finding vmbridge opencode worktrees", () => {
  test("points a new worktree's link at the checkout by the path it was given", () => {
    const { checkout, path } = setUp("ab12cd34");
    sh(fixWorktreeLinks(quote(checkout), quote(path)));
    expect(readFileSync(join(path, ".git"), "utf8")).toBe(`gitdir: ${checkout}/.git/worktrees/ab12cd34\n`);
  });

  test("opens, lists and removes a worktree whose link names a folder that is gone", () => {
    const { checkout, path } = setUp("ab12cd34");
    breakLink(path, "ab12cd34");
    expect(sh(findWorktreeProgram(checkout, "ab12cd34")).trim()).toBe("opencode/ab12cd34");
    breakLink(path, "ab12cd34");
    expect(sh(listWorktreesProgram(checkout))).toMatch(/^ab12cd34\topencode\/ab12cd34\t\d+\n$/);
    breakLink(path, "ab12cd34");
    expect(sh(removeWorktreeProgram(checkout, "ab12cd34"))).toBe("removed");
  });

  test("lists every worktree git can open, and finds nothing for one that is gone", () => {
    const { checkout } = setUp("ab12cd34");
    sh(`git worktree add --quiet -b opencode/ef56ab78 ${worktreePath(checkout, "ef56ab78")} origin/main`, checkout);
    mkdirSync(worktreePath(checkout, "notgit00"));
    const names = sh(listWorktreesProgram(checkout)).trim().split("\n").map((line) => line.split("\t")[0]);
    expect(names.sort()).toEqual(["ab12cd34", "ef56ab78"]);
    expect(sh(findWorktreeProgram(checkout, "99999999"))).toBe("");
  });
});

describe("the resume list", () => {
  test("lists every worktree on an awake VM, drops ones gone from it, and leaves a sleeping VM's as noted", async () => {
    const store = new Store(openDatabase(":memory:"), testEncryption);
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    for (const id of ["awake", "asleep"]) {
      store.insertVm({ id, provider: "boat", name: id, size: "small", state: "ready", createdAt: 0 });
      store.addProjectVm("p1", id);
      store.setCheckout("p1", id, "/workspace/app");
    }
    const old = Date.now() - 60_000;
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "awake", name: "kept0001", branch: "opencode/kept0001", base: "main" }, old);
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "awake", name: "gone0001", branch: "opencode/gone0001", base: "main" }, old);
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "asleep", name: "slept001", branch: "opencode/slept001", base: "main" }, old);
    const onVm = [
      { name: "kept0001", branch: "fix/login", changedAt: old },
      { name: "found001", branch: "opencode/found001", changedAt: 1_000 },
    ];
    const fleet = { worktreesOn: async (vmId: string) => (vmId === "awake" ? onVm : null) } as unknown as Hub["fleet"];
    await syncWorktrees(store, { fleet }, "p1");
    const rows = store.openCodeWorktrees("p1").map(({ name, vmId, branch, lastUsedAt }) => ({ name, vmId, branch, lastUsedAt }));
    expect(rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "found001", vmId: "awake", branch: "opencode/found001", lastUsedAt: 1_000 },
      { name: "kept0001", vmId: "awake", branch: "fix/login", lastUsedAt: old },
      { name: "slept001", vmId: "asleep", branch: "opencode/slept001", lastUsedAt: old },
    ]);
  });
});

describe("closing vmbridge opencode", () => {
  test("answers before the VM removes the worktree, then forgets it once removed", async () => {
    const db = openDatabase(":memory:");
    const store = new Store(db, testEncryption);
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.insertVm({ id: "vm1", provider: "boat", name: "vm1", size: "small", state: "ready", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    store.addOpenCodeWorktree({ projectId: "p1", vmId: "vm1", name: "ab12cd34", branch: "opencode/ab12cd34", base: "main" });
    const removal = Promise.withResolvers<{ removed: boolean }>();
    const fleet = { removeWorktree: () => removal.promise } as unknown as Hub["fleet"];
    const handle = openCodeLauncher({ store, hub: { fleet } as Hub, clones: {} as never, traffic: new Traffic(db), hasKey: () => true, githubToken: () => undefined });
    const body = JSON.stringify({ projectId: "p1", vmId: "vm1", name: "ab12cd34" });
    const response = await handle(new Request("http://bridge.test/api/vmbridge/opencode", { method: "DELETE", body }));
    expect(response.status).toBe(202);
    expect(store.openCodeWorktrees("p1")).toHaveLength(1);
    removal.resolve({ removed: true });
    await Bun.sleep(0);
    expect(store.openCodeWorktrees("p1")).toEqual([]);
  });
});
