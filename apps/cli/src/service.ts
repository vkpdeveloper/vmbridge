import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv, compiled, dataDir } from "@vmbridge/server";

const label = "dev.vmbridge";

/** The background service's output on macOS (Linux uses the journal). It can hold provider errors and addresses, so only the owner reads it. */
export const logPath = () => join(dataDir(), "vmbridge.log");

/** launchd appends to the log with whatever mode it already has, and makes a new one world-readable. */
export function protectLog() {
  if (existsSync(logPath())) chmodSync(logPath(), 0o600);
}

/** The address lines of the last start in the service's log, as `run` printed them, such as "  This machine  http://...". */
export function serviceAddresses(log: string) {
  const started = log.lastIndexOf(" is running.\n");
  if (started === -1) return [];
  const lines = log.slice(started).split("\n").slice(1);
  const addresses = [];
  for (const line of lines.slice(lines[0] === "" ? 1 : 0)) {
    if (!/^ {2}\S.* https?:\/\/\S+$/.test(line)) break;
    addresses.push(line);
  }
  return addresses;
}

interface ServiceOptions {
  host?: string;
  port: number;
}

/** The command that runs VM Bridge: the compiled binary itself, or Bun with this script in development. */
function command(options: ServiceOptions) {
  return [process.execPath, ...(compiled ? [] : [Bun.main]), "run", ...(options.host ? ["--host", options.host] : []), "--port", String(options.port)];
}

/** Variables the service needs: a PATH that finds git and tailscale, and the data directory if it was moved. */
function environment() {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.VMBRIDGE_HOME ? { VMBRIDGE_HOME: process.env.VMBRIDGE_HOME } : {}),
  };
}

/** What a command run outside the service needs: VM Bridge's own update finds the data directory with it. */
const detachedEnv = () => childEnv(process.env.VMBRIDGE_HOME ? { VMBRIDGE_HOME: process.env.VMBRIDGE_HOME } : {});

async function exec(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv() });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, stdout, stderr: stderr.trim() };
}

async function must(args: string[]) {
  const result = await exec(args);
  if (!result.ok) throw new Error(`${args.slice(0, 2).join(" ")} failed: ${result.stderr || "no details"}`);
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** macOS: a per-user LaunchAgent, started at login and restarted if it crashes. */
const launchd = {
  plist: () => join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  domain: () => `gui/${process.getuid?.()}`,

  async install(options: ServiceOptions) {
    const log = logPath();
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(log, "", { flag: "a", mode: 0o600 });
    protectLog();
    const strings = (values: string[]) => values.map((value) => `      <string>${xml(value)}</string>`).join("\n");
    const env = Object.entries(environment())
      .map(([key, value]) => `      <key>${key}</key>\n      <string>${xml(value)}</string>`)
      .join("\n");
    write(
      this.plist(),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${strings(command(options))}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
  </dict>
</plist>
`,
    );
    await exec(["launchctl", "bootout", `${this.domain()}/${label}`]);
    for (let i = 0; i < 20 && (await exec(["launchctl", "print", `${this.domain()}/${label}`])).ok; i++) await Bun.sleep(100);
    await must(["launchctl", "bootstrap", this.domain(), this.plist()]);
  },

  async stop() {
    if (!existsSync(this.plist())) return false;
    return (await exec(["launchctl", "bootout", `${this.domain()}/${label}`])).ok;
  },

  /** The running service's process, or null when it is not loaded or not running. */
  async pid() {
    if (!existsSync(this.plist())) return null;
    const result = await exec(["launchctl", "print", `${this.domain()}/${label}`]);
    const pid = Number(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]);
    return result.ok && pid > 0 ? pid : null;
  },

  /** Starts the loaded service again after it exited on its own, as it does for an update. */
  async start() {
    await must(["launchctl", "kickstart", `${this.domain()}/${label}`]);
  },

  /**
   * Runs `args` with its output appended to `log`, and resolves with its exit code. It runs in its own process group,
   * which launchd leaves running when the service exits, so it can stop and start the service.
   */
  detached(args: string[], log: string) {
    const out = openSync(log, "a", 0o600);
    const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: ["ignore", out, out], env: detachedEnv() });
    closeSync(out);
    return new Promise<number>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 1));
    });
  },

  async uninstall() {
    await this.stop();
    rmSync(this.plist(), { force: true });
  },

  /** Where to read the service's output. */
  logLocation: () => logPath(),

  async output() {
    return existsSync(logPath()) ? readFileSync(logPath(), "utf8") : "";
  },
};

const systemdQuote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/** Linux: a systemd user unit. Without lingering it runs only while the user is logged in. */
const systemd = {
  unit: () => join(homedir(), ".config", "systemd", "user", "vmbridge.service"),

  async install(options: ServiceOptions) {
    const env = Object.entries(environment())
      .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
      .join("\n");
    write(
      this.unit(),
      `[Unit]
Description=VM Bridge
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command(options).map(systemdQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`,
    );
    await must(["systemctl", "--user", "daemon-reload"]);
    await must(["systemctl", "--user", "enable", "vmbridge.service"]);
    await must(["systemctl", "--user", "restart", "vmbridge.service"]);
    console.log("To keep it running after you log out: loginctl enable-linger $USER");
  },

  async stop() {
    if (!existsSync(this.unit())) return false;
    if (!(await exec(["systemctl", "--user", "is-active", "--quiet", "vmbridge.service"])).ok) return false;
    await must(["systemctl", "--user", "stop", "vmbridge.service"]);
    return true;
  },

  async pid() {
    if (!existsSync(this.unit())) return null;
    const result = await exec(["systemctl", "--user", "show", "--property", "MainPID", "--value", "vmbridge.service"]);
    const pid = Number(result.stdout.trim());
    return result.ok && pid > 0 ? pid : null;
  },

  async start() {
    await must(["systemctl", "--user", "start", "vmbridge.service"]);
  },

  /**
   * Runs `args` with its output appended to `log`, and resolves with its exit code. It runs as its own transient unit:
   * systemd stops everything in the service's unit when it exits, which would end a plain child halfway.
   */
  async detached(args: string[], log: string) {
    const env = Object.entries(detachedEnv()).map(([key, value]) => `--setenv=${key}=${value}`);
    const output = [`--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`];
    const child = Bun.spawn(["systemd-run", "--user", "--collect", "--quiet", "--wait", ...output, ...env, "--", ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: childEnv(),
    });
    return await child.exited;
  },

  async uninstall() {
    if (!existsSync(this.unit())) return;
    await exec(["systemctl", "--user", "disable", "--now", "vmbridge.service"]);
    rmSync(this.unit(), { force: true });
    await exec(["systemctl", "--user", "daemon-reload"]);
  },

  /** systemd keeps the service's output in the journal, not in a file. */
  logLocation: () => "journalctl --user -u vmbridge",

  async output() {
    return (await exec(["journalctl", "--user", "--unit", "vmbridge.service", "--output", "cat", "--lines", "200", "--no-pager"])).stdout;
  },
};

const unsupported = {
  install: async (_: ServiceOptions) => {
    throw new Error("Background services work on macOS and Linux.");
  },
  stop: async () => false,
  pid: async (): Promise<number | null> => null,
  start: async () => {},
  detached: async (_: string[], __: string) => 1,
  uninstall: async () => {},
  logLocation: () => "",
  output: async () => "",
};

export const service = process.platform === "darwin" ? launchd : process.platform === "linux" ? systemd : unsupported;
