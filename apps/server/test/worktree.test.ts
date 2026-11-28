import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devRelayHeaders, devRelayScript, findWorktreeProgram, fixWorktreeLinks, listWorktreesProgram, readWorktreeState, removeWorktreeProgram, worktreePath, worktreeStateProgram } from "../src/vm/opencode.ts";
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

  test("stays while its own branch has commits that are not pushed, after an agent switched away from it", () => {
    const { checkout, path, commit, remove } = setUp("ab12cd34");
    commit("work");
    sh("git switch --quiet -c fix/other origin/main", path);
    expect(remove()).toBe("kept fix/other");
    expect(branches(checkout)).toContain("opencode/ab12cd34");
  });

  test("tidies a worktree whose folder is already gone", () => {
    const { checkout, path, remove } = setUp("ab12cd34");
    rmSync(path, { recursive: true });
    expect(remove()).toBe("removed");
    expect(branches(checkout)).toEqual(["main"]);
  });

  test("keeps the branch of a worktree whose folder is gone while it has commits that are not pushed", () => {
    const { checkout, path, commit, remove } = setUp("ab12cd34");
    commit("work");
    rmSync(path, { recursive: true });
    expect(remove()).toBe("removed");
    expect(branches(checkout)).toContain("opencode/ab12cd34");
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

describe("the sidebar's look at a worktree", () => {
  test("reads its branch and how far it is from origin's copy of its base, and nothing once it is gone", () => {
    const { checkout, commit, remove } = setUp("ab12cd34");
    commit("one");
    commit("two");
    sh("git -c user.name=t -c user.email=t@t commit --quiet --allow-empty -m theirs && git push --quiet origin main", checkout);
    const look = () => readWorktreeState(sh(worktreeStateProgram(checkout, "ab12cd34", "main", false)));
    expect(look()).toEqual({ branch: "opencode/ab12cd34", sync: { base: "main", ahead: 2, behind: 1 }, ports: [] });
    sh("git reset --quiet --hard origin/main", worktreePath(checkout, "ab12cd34"));
    expect(look()?.sync).toEqual({ base: "main", ahead: 0, behind: 0 });
    remove();
    expect(look()).toBeNull();
  });

  test("lists each port a program in the worktree listens on once, in order", () => {
    const output = "branch\tfix/login\nport\t5173\nport\t3000\nport\t5173\n";
    expect(readWorktreeState(output)?.ports).toEqual([3000, 5173]);
  });
});

describe("relaying a dev server on its VM", () => {
  test("answers only with the VM's password, reaches the named port as localhost, and passes WebSockets", async () => {
    const seen: { host: string | null; forwarded: string | null; relayHeaders: boolean }[] = [];
    const dev = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        seen.push({
          host: request.headers.get("host"),
          forwarded: request.headers.get("x-forwarded-host"),
          relayHeaders: request.headers.has(devRelayHeaders.port) || request.headers.has(devRelayHeaders.password),
        });
        if (server.upgrade(request)) return;
        return new Response("page");
      },
      websocket: { message: (socket, message) => void socket.send(`echo ${message}`) },
    });
    const dir = mkdtempSync(join(tmpdir(), "vmb-relay-"));
    dirs.push(dir);
    const [passwordFile, file] = [join(dir, "password"), join(dir, "relay")];
    writeFileSync(passwordFile, "secret");
    const relay = Bun.spawn(["node", "-e", devRelayScript, "0", passwordFile, file], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      let port = "";
      for (let tries = 0; !port && tries < 100; tries++) {
        await Bun.sleep(50);
        port = (await Bun.file(file).exists()) ? (await Bun.file(file).text()).split("\t")[1]! : "";
      }
      const ask = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/`, { headers: { host: "box-4797.provider.dev", "x-forwarded-host": "box-4797.provider.dev", ...headers } });
      expect((await ask({ [devRelayHeaders.port]: String(dev.port) })).status).toBe(403);
      expect((await ask({ [devRelayHeaders.port]: String(dev.port), [devRelayHeaders.password]: "wrong" })).status).toBe(403);
      expect((await ask({ [devRelayHeaders.password]: "secret" })).status).toBe(403);
      expect(seen).toEqual([]);

      const allowed = { [devRelayHeaders.port]: String(dev.port), [devRelayHeaders.password]: "secret" };
      const page = await ask(allowed);
      expect(await page.text()).toBe("page");
      expect(seen[0]).toEqual({ host: `localhost:${dev.port}`, forwarded: null, relayHeaders: false });

      const refused = new WebSocket(`ws://127.0.0.1:${port}/hmr`);
      expect(await new Promise((resolve) => (refused.onerror = () => resolve("refused")))).toBe("refused");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`, { headers: allowed });
      const answer = await new Promise<string>((resolve, reject) => {
        socket.onopen = () => socket.send("hi");
        socket.onmessage = (event) => resolve(String(event.data));
        socket.onerror = () => reject(new Error("The relayed socket failed."));
      });
      socket.close();
      expect(answer).toBe("echo hi");
      expect(seen[1]).toEqual({ host: `localhost:${dev.port}`, forwarded: null, relayHeaders: false });
    } finally {
      relay.kill();
      dev.stop(true);
    }
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
