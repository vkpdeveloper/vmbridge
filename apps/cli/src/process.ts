import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { childEnv, dataDir } from "@vmbridge/server";

export const pidFile = () => join(dataDir(), "vmbridge.pid");

/** Asks a running VM Bridge to stop quickly because another one starts right after it (see `start().stop`). */
export const restartSignal = "SIGUSR2";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the process is VM Bridge: the release binary, or Bun running it from source. A pid file left by a VM Bridge
 * that was killed can name a process that got the same pid later, which must not be signalled.
 */
function isVmBridge(pid: number) {
  const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], { env: childEnv() }).stdout.toString().trim();
  return /^(vmbridge|vb|bun)/.test(basename(command));
}

/**
 * Another live VM Bridge process from the pid file. A file naming this process
 * does not count: `bun --watch` restarts in place and keeps the pid, so `run` sees its own.
 */
export function runningPid(): number | null {
  if (!existsSync(pidFile())) return null;
  const pid = Number(readFileSync(pidFile(), "utf8"));
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  return alive(pid) && isVmBridge(pid) ? pid : null;
}

async function exited(pid: number, ms: number) {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

/**
 * Sends `signal` and waits up to `waitMs` for the process to exit, then kills it. VM Bridge gives itself a deadline
 * too, so the kill is for an older version or one stuck past it. Returns false when the process had to be killed.
 */
export async function stopProcess(pid: number, signal: NodeJS.Signals, waitMs: number): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return true;
  }
  if (await exited(pid, waitMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await exited(pid, 5_000);
  return false;
}
