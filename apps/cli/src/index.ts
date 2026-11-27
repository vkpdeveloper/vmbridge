#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compiled, dashboardKey, dataDir, defaultPort, start, version } from "@vmbridge/server";
import { pidFile, restartSignal, runningPid, stopProcess } from "./process.ts";
import { protectLog, service, serviceAddresses } from "./service.ts";
import { login, openCode } from "./opencode.ts";
import { update, updateFromDashboard } from "./update.ts";

const help = `VM Bridge ${version}

Usage:
  vmbridge [run] [--host <address>] [--port ${defaultPort}]   Start VM Bridge in this terminal
  vmbridge stop                                        Stop VM Bridge, including the background service
  vmbridge update [--check]                            Install the latest release and restart VM Bridge
  vmbridge service install [--host] [--port]           Run VM Bridge in the background at login
  vmbridge service uninstall                           Remove the background service
  vmbridge password                                    Set a new dashboard password
  vmbridge opencode [--branch <name>]                  Open OpenCode on a VM, in a new worktree of this repository
  vmbridge login <pairing link>                        Sign this terminal in to VM Bridge on another machine

\`vb\` is a short name for \`vmbridge\`.

VM Bridge listens on this machine and on Tailscale. Turn on the local network in Settings > Addresses,
or pass --host (or set VMBRIDGE_HOST) to listen on one address only: --host 0.0.0.0 is every network.
The password can also come from VMBRIDGE_PASSWORD. Data lives in ${dataDir()}.
Saved secrets are encrypted with the key in ${join(dataDir(), "encryption.key")}, or VMBRIDGE_ENCRYPTION_KEY (base64) when set.`;

/** How long a stop may take before VM Bridge exits anyway: a full stop puts idle VMs to sleep first, for up to 15 seconds. */
const stopDeadlineMs = 30_000;
const restartDeadlineMs = 10_000;

/** Reads a line without echoing it. */
async function readSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            return resolve(value);
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            return reject(new Error("Cancelled."));
          }
          if (char === "\u007f") value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\n");
  }
}

async function chooseKey(): Promise<string> {
  for (;;) {
    const key = await readSecret("Choose a dashboard password (at least 8 characters): ");
    if (key.length < 8) {
      console.log("Too short.");
      continue;
    }
    if ((await readSecret("Type it again: ")) === key) return key;
    console.log("The passwords did not match.");
  }
}

/**
 * Makes sure a dashboard password exists, from VMBRIDGE_PASSWORD or typed here. With `ask` false it only takes the
 * variable, leaving the password to the dashboard's onboarding.
 */
async function ensureKey({ force = false, ask = true } = {}) {
  const keys = dashboardKey();
  // Opening the password store makes the encryption key on a new install, so the server will not report it.
  if (keys.encryptionKey.created) keyNotice(keys.encryptionKey.location);
  try {
    if (keys.isSet() && !force) return;
    const fromEnv = process.env.VMBRIDGE_PASSWORD;
    if (fromEnv && !force) return await keys.set(fromEnv);
    if (!ask) return;
    if (!process.stdin.isTTY) {
      throw new Error("Set a dashboard password first: run `vmbridge password` in a terminal, or set VMBRIDGE_PASSWORD.");
    }
    await keys.set(await chooseKey());
    console.log("Password saved.");
  } finally {
    keys.close();
  }
}

function keyNotice(location: string) {
  console.log(`\nSaved provider keys, sign-ins and environment variables are encrypted with a new key in ${location}.`);
  console.log("Back it up. Without it, they have to be entered again.");
}

function serverOptions(values: { host?: string; port?: string }) {
  const port = values.port === undefined ? defaultPort : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be a port number.");
  const host = values.host || process.env.VMBRIDGE_HOST || undefined;
  return { host, port };
}

async function run(options: { host?: string; port: number }) {
  const existing = runningPid();
  // The background service is left running: taken over, it would exit for good, and VM Bridge would stop with this
  // terminal. launchd and systemd only start it again after a crash.
  if (existing && existing === (await service.pid())) return backgroundNotice(existing);
  // Otherwise the newest start wins, so an old VM Bridge that is slow to exit, or stuck, never keeps serving old code.
  if (existing) {
    console.log(`Stopping the VM Bridge already running (process ${existing}).`);
    await stopProcess(existing, restartSignal, restartDeadlineMs + 5_000);
  }
  await ensureKey({ ask: false });
  // The dashboard installs updates only for the background service, which the update starts again. A terminal's VM
  // Bridge would end with nothing to start it, so its dashboard shows `vmbridge update` instead.
  const asService = compiled && (await service.pid()) === process.pid;
  const server = await start({ ...options, ...(asService ? { installUpdate: updateFromDashboard } : {}) });
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), String(process.pid));
  // A service installed by an older version left its log readable by everyone.
  protectLog();

  await server.tunnelReady();
  const network = await server.network();
  const { cloudflare } = network;
  // Whoever has the setup code can choose the password, so it only goes to a terminal, never to a service's log file.
  const setupCode = process.stdout.isTTY ? server.setupCode : null;
  const page = setupCode ? `/dashboard/onboarding#code=${setupCode}` : "/dashboard";
  console.log(`VM Bridge ${version} is running.\n`);
  for (const address of network.addresses) console.log(`  ${address.label.padEnd(20)} ${address.url}${page}`);
  if (!network.localNetwork.enabled && !network.localNetwork.fixed) {
    console.log("\n  Devices on your local network can't connect. Turn it on in Settings > Addresses, or start with --host 0.0.0.0.");
  } else if (network.localNetwork.enabled && network.localNetwork.fixed) {
    console.log("\n  Devices on your local network can connect, over plain HTTP (set by --host).");
  }
  if (network.tailscale.running && !network.tailscale.httpsUrl) console.log("\n  Turn on Tailscale HTTPS in the dashboard settings for an https:// address.");
  if (cloudflare.installed && !cloudflare.enabled) console.log("\n  Cloudflare Tunnel is available: turn it on in Settings > Addresses.");
  else if (cloudflare.state === "failed") console.log(`\n  Cloudflare Tunnel did not start: ${cloudflare.error}`);
  else if (cloudflare.enabled && !cloudflare.url) console.log("\n  Cloudflare Tunnel is getting its address ready. It shows in Settings > Addresses once it works.");
  else if (cloudflare.mode === "quick" && cloudflare.url) console.log("\n  The Cloudflare Tunnel address changes every time VM Bridge restarts.");
  if (setupCode) console.log("\nOpen a link to choose your password and finish setup. Press Ctrl+C to stop.");
  else if (server.setupCode) console.log("\nNo dashboard password yet. Set one with `vmbridge password`, or start `vmbridge run` in a terminal for a setup link.");
  else console.log("\nOpen the dashboard to set up providers and pair devices. Press Ctrl+C to stop.");
  if (server.encryptionKey.created) keyNotice(server.encryptionKey.location);

  let stopping = false;
  const stop = async (restarting: boolean) => {
    // A second Ctrl+C, or a stop that runs past its deadline, ends the process without finishing.
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => {
      console.error("VM Bridge took too long to stop, so it exited without finishing.");
      process.exit(1);
    }, restarting ? restartDeadlineMs : stopDeadlineMs).unref();
    await server.stop({ restarting }).catch(() => {});
    if (!runningPid()) rmSync(pidFile(), { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => stop(false));
  process.on("SIGTERM", () => stop(false));
  // Closing the terminal window. Without this, VM Bridge would end without stopping cloudflared.
  process.on("SIGHUP", () => stop(false));
  process.on(restartSignal, () => stop(true));
}

async function backgroundNotice(pid: number) {
  console.log(`VM Bridge is already running in the background (process ${pid}), and keeps running after this terminal closes.\n`);
  const addresses = serviceAddresses(await service.output());
  for (const address of addresses) console.log(address);
  if (addresses.length) console.log("");
  console.log("To run it in this terminal instead, stop the background service first with `vmbridge stop`.");
}

async function stop() {
  const stoppedService = await service.stop();
  const pid = runningPid();
  if (pid && !(await stopProcess(pid, "SIGTERM", stopDeadlineMs + 5_000))) console.log(`VM Bridge (process ${pid}) did not stop in time and was killed.`);
  if (!pid && !stoppedService) return console.log("VM Bridge is not running.");
  console.log("VM Bridge stopped.");
  if (stoppedService) console.log("The background service starts again at next login, or now with `vmbridge service install`.");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      check: { type: "boolean" },
      branch: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command = "run", subcommand] = positionals;
  if (values.help) return console.log(help);
  if (values.version) return console.log(version);

  switch (command) {
    case "run":
      return run(serverOptions(values));
    case "stop":
      return stop();
    case "update":
      return update({ check: values.check === true });
    case "password":
      return ensureKey({ force: true });
    case "opencode":
      return openCode({ branch: values.branch });
    case "login":
      return login(subcommand);
    case "service":
      if (subcommand === "install") {
        await ensureKey();
        const options = serverOptions(values);
        const existing = runningPid();
        const servicePid = await service.pid();
        if (existing && existing !== servicePid) {
          throw new Error(`VM Bridge is already running in a terminal (process ${existing}). Stop it first.`);
        }
        // Ask the running service to exit for a restart so devices stay connected with 1012 and idle VMs stay awake.
        if (servicePid) await stopProcess(servicePid, restartSignal, restartDeadlineMs + 5_000);
        await service.install(options);
        return console.log(`VM Bridge now runs in the background on port ${options.port}. Logs: ${service.logLocation()}`);
      }
      if (subcommand === "uninstall") {
        await service.uninstall();
        return console.log("Background service removed.");
      }
      throw new Error("Use `vmbridge service install` or `vmbridge service uninstall`.");
    default:
      console.log(help);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

