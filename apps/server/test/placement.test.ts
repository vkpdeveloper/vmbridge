import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Fleet } from "../src/fleet.ts";
import { busyNotice, choose, type VmLoad } from "../src/placement.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";

function setup() {
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  settings.set("providers", ["boxd", "railway"]);
  settings.set("defaultProvider", "boxd");
  settings.set("vmSize", "medium");
  const fleet = new Fleet(new Store(db, testEncryption), settings, new Secrets(db, testEncryption), { record: () => {} } as unknown as Traffic, {} as never, {} as never, openSocket);
  return { settings, fleet };
}

describe("where a new VM goes", () => {
  test("a repository rule picks the provider and size, matching any spelling of the repository", () => {
    const { settings, fleet } = setup();
    settings.set("repoRules", [{ repo: "Acme/API", provider: "railway", size: "large" }]);
    expect(fleet.placement("https://github.com/acme/api.git")).toEqual({ provider: "railway", size: "large" });
    expect(fleet.placement("https://github.com/acme/web.git")).toEqual({ provider: "boxd", size: "medium" });
  });

  test("an unset rule field, or a provider removed since, falls back to the defaults", () => {
    const { settings, fleet } = setup();
    settings.set("repoRules", [{ repo: "acme/api", provider: "railway", size: null }]);
    settings.set("providers", ["boxd"]);
    expect(fleet.placement("https://github.com/acme/api.git")).toEqual({ provider: "boxd", size: "medium" });
  });

  test("without a size setting, each provider's default applies, the closest it has to 2 vCPU and 8 GB", () => {
    const { settings, fleet } = setup();
    settings.set("vmSize", null);
    settings.set("providers", ["boxd", "boat"]);
    expect(fleet.placement("https://github.com/acme/api.git")).toEqual({ provider: "boxd", size: "medium" });
    settings.set("defaultProvider", "boat");
    expect(fleet.placement("https://github.com/acme/api.git")).toEqual({ provider: "boat", size: "small" });
  });

  test("a VM can only be created on an added provider", async () => {
    const { fleet } = setup();
    await expect(fleet.create({ provider: "daytona" })).rejects.toThrow("Add Daytona in Accounts first.");
  });
});

describe("which VM a new thread goes to", () => {
  const gb = 1024 ** 3;
  const vm = (vmId: string, load: Partial<VmLoad> = {}): VmLoad => ({ vmId, awake: true, turns: 0, vcpus: 2, memory: null, disk: null, ...load });

  test("the least loaded awake VM with room, under 2 live turns per vCPU", () => {
    expect(choose([vm("a", { turns: 3 }), vm("b", { turns: 1 })], true)).toMatchObject({ kind: "use", load: { vmId: "b" }, room: true });
    expect(choose([vm("a", { turns: 3 })], true)).toMatchObject({ kind: "use", load: { vmId: "a" }, room: true });
  });

  test("a VM short on memory or disk has no room, however few its turns", () => {
    const full = vm("a", { memory: { used: 6.5 * gb, total: 8 * gb } });
    const cramped = vm("a", { disk: { used: 48 * gb, total: 50 * gb } });
    expect(choose([full], true)).toEqual({ kind: "create" });
    expect(choose([cramped], true)).toEqual({ kind: "create" });
  });

  test("a sleeping VM with room comes before a new one", () => {
    expect(choose([vm("a", { turns: 4 }), vm("b", { awake: false })], true)).toMatchObject({ kind: "use", load: { vmId: "b" }, room: true });
  });

  test("with no room and no new VM allowed, the least loaded awake VM takes it without room", () => {
    const choice = choose([vm("a", { turns: 6 }), vm("b", { turns: 4 }), vm("c", { awake: false, disk: { used: 49 * gb, total: 50 * gb } })], false);
    expect(choice).toMatchObject({ kind: "use", load: { vmId: "b" }, room: false });
    expect(choose([], false)).toBeNull();
  });

  test("the notice says why the VM is busy", () => {
    expect(busyNotice(vm("a", { turns: 4 }))).toBe("This VM is running 4 threads on 2 vCPUs, so this one may be slow.");
    expect(busyNotice(vm("a", { turns: 2, vcpus: 1 }))).toBe("This VM is running 2 threads on 1 vCPU, so this one may be slow.");
    expect(busyNotice(vm("a", { memory: { used: 7 * gb, total: 8 * gb } }))).toBe("This VM is using 88% of its memory, so this one may be slow.");
  });
});

describe("upgrading a database from one VM per project", () => {
  test("each project's VM becomes its primary, checkout and all", () => {
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-migration-"));
    try {
      const path = join(dir, "main.db");
      // Back to the schema before project_vms, tracked by user_version, with a project on a VM as that version stored it.
      const old = openDatabase(path);
      old.exec("DROP TABLE opencode_worktrees; ALTER TABLE vms DROP COLUMN opencode_password; ALTER TABLE projects DROP COLUMN opencode_password; DROP TABLE project_icons; DROP TABLE vm_file_lists; DROP TABLE project_vms; DROP TABLE base_snapshots; DROP TABLE retired_snapshots; DROP TABLE errors; DROP TABLE vm_usage; DROP TABLE snapshot_usage; DROP TABLE vm_events; DROP TABLE turns; DROP TABLE agent_profiles; DROP TABLE instructions; DROP TABLE watch_links; DROP TABLE attachment_chunks; DROP TABLE attachment_uploads; DROP TABLE file_trees; ALTER TABLE clients DROP COLUMN last_connected_at; DROP TABLE projection_parts; ALTER TABLE projections DROP COLUMN stamp; DROP TABLE migrations; PRAGMA user_version = 5;");
      old.run("INSERT INTO vms (id, provider, name, size, state, created_at) VALUES ('vm1', 'boxd', 'vm1', 'medium', 'sleeping', 0)");
      old.run("INSERT INTO projects (id, url, title, vm_id, checkout_path, created_at) VALUES ('p1', 'https://github.com/acme/app.git', 'app', 'vm1', '/workspace/app', 0)");
      old.run("INSERT INTO projects (id, url, title, created_at) VALUES ('p2', 'https://github.com/acme/web.git', 'web', 1)");
      old.close();

      const db = openDatabase(path);
      const store = new Store(db, testEncryption);
      expect(store.project("p1")?.vms).toEqual([{ vmId: "vm1", checkoutPath: "/workspace/app" }]);
      expect(store.project("p2")?.vms).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
