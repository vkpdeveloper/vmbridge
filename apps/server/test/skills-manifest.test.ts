import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Box } from "../src/providers/index.ts";
import { Skills } from "../src/skills.ts";
import { syncSkills, type SkillFile } from "../src/vm/skills.ts";
import { testEncryption } from "./key.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const file = (path: string, text: string): SkillFile => ({ path, data: Buffer.from(text).toString("base64") });

function fakeVm() {
  const home = mkdtempSync(join(tmpdir(), "vmbridge-skills-manifest-"));
  temps.push(home);
  const root = join(home, ".vmbridge");
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, XDG_CONFIG_HOME: "" };
  const local = (path: string) => join(root, basename(path));
  const box = {
    files: {
      read: async (path: string) => readFileSync(local(path), "utf8"),
      write: async (files: Record<string, string>) => {
        for (const [path, text] of Object.entries(files)) writeFileSync(local(path), text);
      },
    },
    run: async () => {
      const result = Bun.spawnSync(["bun", join(root, "skills.mjs"), root], { env });
      return { ok: result.exitCode === 0, exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
    },
  } as unknown as Box;
  return { home, root, claudeSkills: join(claude, "skills"), box };
}

describe("VM skills manifest recovery", () => {
  test("recovers fresh on damaged, non-object, array, or fingerprint-only skills.json and writes 0600 atomically", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    skills.installUpload("notes", [file("SKILL.md", "---\nname: notes\n---\n")]);
    const state = skills.state();
    const cases = [
      "",
      "{bad",
      "{}",
      "[]",
      "null",
      JSON.stringify({ skills: [] }),
      JSON.stringify({ fingerprint: state.fingerprint, skills: [] }),
      JSON.stringify({ fingerprint: state.fingerprint }),
      JSON.stringify({ fingerprint: state.fingerprint, skills: {} }),
      JSON.stringify({ fingerprint: state.fingerprint, skills: { notes: "wrong-hash" } }),
    ];

    for (const broken of cases) {
      const { root, claudeSkills, box } = fakeVm();
      writeFileSync(join(root, "skills.json"), broken, { mode: 0o644 });
      // A pre-existing world-readable temp file must not relax the new manifest's permissions.
      writeFileSync(join(root, "skills.json.vmbridge-new"), "stale", { mode: 0o644 });

      expect(await syncSkills(box, state, (name) => skills.files(name))).toBe(true);
      expect(readFileSync(join(claudeSkills, "notes", "SKILL.md"), "utf8")).toContain("name: notes");
      expect(JSON.parse(readFileSync(join(root, "skills.json"), "utf8")).fingerprint).toBe(state.fingerprint);
      expect(statSync(join(root, "skills.json")).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, "skills.json.vmbridge-new"))).toBe(false);
    }
  });

  test("ignores unsafe skill names in a damaged manifest instead of deleting outside the skills store", async () => {
    const { home, root, claudeSkills, box } = fakeVm();
    const precious = join(home, "precious");
    mkdirSync(precious, { recursive: true });
    writeFileSync(join(precious, "keep.txt"), "safe");
    writeFileSync(join(root, "skills.json"), JSON.stringify({ skills: { "../../precious": "h", "..": "h", "": "h", "./notes": "h" } }));

    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    skills.installUpload("notes", [file("SKILL.md", "---\nname: notes\n---\n")]);

    expect(await syncSkills(box, skills.state(), (name) => skills.files(name))).toBe(true);
    expect(readFileSync(join(precious, "keep.txt"), "utf8")).toBe("safe");
    expect(readFileSync(join(claudeSkills, "notes", "SKILL.md"), "utf8")).toContain("name: notes");
  });
});
