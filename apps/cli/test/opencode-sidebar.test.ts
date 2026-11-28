import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidebarConfig } from "../src/opencode-sidebar.ts";

const saved = { home: process.env.VMBRIDGE_HOME, config: process.env.OPENCODE_CONFIG_DIR };
let dir = "";
afterEach(() => {
  for (const [name, value] of [["VMBRIDGE_HOME", saved.home], ["OPENCODE_CONFIG_DIR", saved.config]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("OpenCode gets the user's own terminal plugins and then the sidebar, as the list it is given replaces theirs", () => {
  dir = mkdtempSync(join(tmpdir(), "vmb-sidebar-"));
  process.env.VMBRIDGE_HOME = join(dir, "vmbridge");
  process.env.OPENCODE_CONFIG_DIR = join(dir, "opencode");
  mkdirSync(process.env.OPENCODE_CONFIG_DIR);
  writeFileSync(join(process.env.OPENCODE_CONFIG_DIR, "cli.json"), `{\n  // theirs\n  "plugins": ["opencode.example", { "package": "./status" }],\n}\n`);

  const options = { repository: "medzimi", vm: "vm-b593d5 (Boat)" };
  const folder = join(dir, "vmbridge", "opencode-sidebar");
  expect(JSON.parse(sidebarConfig(options))).toEqual({ plugins: ["opencode.example", { package: "./status" }, { package: folder, options }] });
  expect(existsSync(join(folder, "tui.tsx"))).toBe(true);

  rmSync(join(process.env.OPENCODE_CONFIG_DIR, "cli.json"));
  expect(JSON.parse(sidebarConfig(options))).toEqual({ plugins: [{ package: folder, options }] });
});
