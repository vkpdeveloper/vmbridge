import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checksumFor, childEnv, compiled, dataDir, isNewer, latestVersion, releaseRepo, version } from "@vmbridge/server";
import { pidFile, restartSignal, runningPid, stopProcess } from "./process.ts";
import { service } from "./service.ts";

/** The release file for this machine, named as install.sh names it. */
function releaseFile() {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("VM Bridge updates itself on macOS and Linux only.");
  let arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new Error(`There is no VM Bridge release for this CPU (${process.arch}).`);
  // An x64 install under Rosetta on Apple silicon moves to the native build, as install.sh picks it.
  const translated = process.platform === "darwin" && Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"], { env: childEnv() }).stdout.toString().trim() === "1";
  if (translated) arch = "arm64";
  return `vmbridge-${process.platform}-${arch}`;
}

const maxChecksumsBytes = 1 * 1024 * 1024;
const maxBinaryBytes = 512 * 1024 * 1024;

async function download(url: string) {
  const response = await fetch(url, { headers: { "user-agent": "vmbridge" }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`Downloading ${url} failed (${response.status}). Nothing was changed.`);
  return response;
}

/** Reads a response body up to `maxBytes`, cancelling the stream instead of buffering an unbounded download. */
export async function readBoundedBytes(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const tooLarge = () => new Error(`${label} is larger than expected (over ${maxBytes} bytes). Nothing was changed.`);
  const header = response.headers.get("content-length");
  if (header !== null && /^\d+$/.test(header.trim()) && Number(header.trim()) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Checks the build attestation with the GitHub CLI when it is installed and signed in. Without it the checksum is the check. */
function verifyAttestation(file: string) {
  const gh = Bun.which("gh");
  if (!gh || Bun.spawnSync([gh, "auth", "status"], { env: childEnv() }).exitCode !== 0) return;
  const result = Bun.spawnSync([gh, "attestation", "verify", file, "--repo", releaseRepo], { env: childEnv() });
  if (result.exitCode !== 0) {
    const reason = result.stderr.toString().trim().split("\n").at(-1) || "no details";
    throw new Error(`The download's build attestation did not verify (${reason}). Nothing was changed.`);
  }
  console.log("Build attestation verified.");
}

/** Throws unless SHA256SUMS lists `file` with the SHA-256 of `bytes`. */
export function verifyChecksum(bytes: Uint8Array, sums: string, file: string) {
  const expected = checksumFor(sums, file);
  if (!expected) throw new Error(`The release has no checksum for ${file}. Nothing was changed.`);
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error("The download does not match its checksum. Nothing was changed.");
  }
}

async function restart(latest: string) {
  const pid = runningPid();
  if (!pid) return console.log("VM Bridge is not running. Start it with `vmbridge`.");
  if (pid !== (await service.pid())) {
    return console.log(`VM Bridge is still running in a terminal (process ${pid}). Run \`vmbridge\` again to restart it with ${latest}.`);
  }
  // The service exits cleanly on this signal, so its manager leaves it stopped until it is started again here.
  await stopProcess(pid, restartSignal, 15_000);
  await service.start();
  for (let i = 0; i < 300; i++) {
    const next = runningPid();
    if (next && next !== pid) return console.log(`VM Bridge restarted with ${latest}.`);
    await Bun.sleep(100);
  }
  console.log(`The background service did not start again. See ${pidFile()} and the service log.`);
}

export async function update({ check }: { check: boolean }) {
  if (!compiled) {
    return console.log(`VM Bridge ${version} runs from source here (with Bun), so it does not update itself. Pull the repository to update.`);
  }
  const latest = await latestVersion();
  if (!isNewer(latest, version)) return console.log(`VM Bridge ${version} is up to date.`);
  if (check) return console.log(`VM Bridge ${latest} is available (this is ${version}). Install it with \`vmbridge update\`.`);

  const file = releaseFile();
  const base = `https://github.com/${releaseRepo}/releases/download/v${latest}`;
  console.log(`Downloading VM Bridge ${latest} for ${file.replace("vmbridge-", "")}...`);
  const sumsBytes = await readBoundedBytes(await download(`${base}/SHA256SUMS`), maxChecksumsBytes, "SHA256SUMS");
  const sums = new TextDecoder().decode(sumsBytes);
  const bytes = await readBoundedBytes(await download(`${base}/${file}`), maxBinaryBytes, file);
  verifyChecksum(bytes, sums, file);

  // Beside the installed file, so the rename that replaces it is atomic: a running VM Bridge keeps the old file open.
  const target = realpathSync(process.execPath);
  const next = join(dirname(target), `.vmbridge-update-${process.pid}`);
  try {
    writeFileSync(next, bytes, { mode: 0o755 });
    verifyAttestation(next);
    const reported = Bun.spawnSync([next, "--version"], { env: childEnv() }).stdout.toString().trim();
    if (reported !== latest) throw new Error("The downloaded VM Bridge does not run on this machine. Nothing was changed.");
    renameSync(next, target);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw new Error(`VM Bridge can't write to ${dirname(target)}. Nothing was changed.`);
    }
    throw error;
  } finally {
    rmSync(next, { force: true });
  }
  console.log(`Updated VM Bridge from ${version} to ${latest}.`);
  await restart(latest);
}

/**
 * The dashboard's Update button, in the background service: runs `vmbridge update` outside the service, since the
 * update stops the service and starts it again on the new release. Rejects with the update's last line when it fails;
 * when it works, this process is stopped first.
 */
export async function updateFromDashboard() {
  const log = join(dataDir(), "update.log");
  writeFileSync(log, "", { mode: 0o600 });
  const code = await service.detached([process.execPath, "update"], log);
  const last = readFileSync(log, "utf8").trim().split("\n").at(-1);
  throw new Error(last || (code === 0 ? "The update finished, but VM Bridge did not restart." : "The update failed."));
}
