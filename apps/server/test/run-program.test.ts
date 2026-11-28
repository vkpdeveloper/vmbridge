import { expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import type { Box } from "../src/providers/index.ts";
import { runProgram } from "../src/vm/runtime.ts";

test("on Daytona a program goes up as a private file, never in a command line, and is gone once it runs", async () => {
  const commands: string[] = [];
  const written: string[] = [];
  // Runs here, as the VM would: files land on this machine's disk and commands in a real bash.
  const box = {
    provider: "daytona",
    files: {
      write: async (path: string, text: string, options: { mode: number }) => {
        writeFileSync(path, text);
        chmodSync(path, options.mode);
        written.push(path);
      },
    },
    run: async (command: string, options: { stdin?: string } = {}) => {
      commands.push(command);
      expect(options.stdin).toBeUndefined();
      const result = Bun.spawnSync(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
      return { ok: result.success, exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
  } as unknown as Box;

  expect(await runProgram(box, "secret=sk_very_secret\necho ${#secret}", "Test")).toBe("14\n");
  expect(commands.join("\n")).not.toContain("sk_very_secret");
  expect(existsSync(written[0]!)).toBe(false);
});
