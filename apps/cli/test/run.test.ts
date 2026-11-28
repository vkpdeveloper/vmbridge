import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStopHandler } from "../src/index.ts";

const cli = join(import.meta.dir, "../src/index.ts");
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Starts `vmbridge run` on `port` in `dir`, not in a terminal, and resolves once it says it is running. */
async function launch(port: number, env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", cli, "run", "--host", "127.0.0.1", "--port", String(port)], {
    // HOME too, so nothing reads this machine's skills or instructions files.
    env: { PATH: process.env.PATH ?? "", HOME: dir, VMBRIDGE_HOME: join(dir, "data"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk);
    if (output.includes("Press Ctrl+C") || output.includes("No dashboard password yet")) break;
  }
  return { child, output };
}

async function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop();
  return port;
}

/** Runs `vmbridge run` on a free port with a new data folder until it says it is running, then stops it. */
async function run(env: Record<string, string> = {}, prepare = (_data: string) => {}) {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-cli-"));
  prepare(join(dir, "data"));
  const port = await freePort();
  const { child, output } = await launch(port, env);
  const auth = (await (await fetch(`http://127.0.0.1:${port}/admin/api/auth`)).json()) as { hasPassword: boolean };
  child.kill("SIGTERM");
  await child.exited;
  return { output, hasPassword: auth.hasPassword };
}

/** Pairs a device as T3 does and opens its RPC socket. Resolves with the socket once it is open. */
async function connectDevice(base: string, password: string) {
  const json = { "content-type": "application/json", origin: base };
  const login = await fetch(`${base}/admin/api/login`, { method: "POST", headers: json, body: JSON.stringify({ key: password }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const pairing = await fetch(`${base}/admin/api/pairing`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "test" }) });
  const { urls } = (await pairing.json()) as { urls: { url: string }[] };
  const exchange = await fetch(`${base}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: new URL(urls[0]!.url).hash.replace("#token=", ""),
    }),
  });
  const { access_token: access } = (await exchange.json()) as { access_token: string };
  const ticket = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${access}` } });
  const { ticket: value } = (await ticket.json()) as { ticket: string };
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(value)}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return socket;
}

test("starts without a password, and keeps the setup code out of output that is not a terminal", async () => {
  const { output, hasPassword } = await run();
  expect(hasPassword).toBe(false);
  expect(output).toContain("is running");
  expect(output).toContain("No dashboard password yet");
  expect(output).not.toContain("#code=");
}, 30_000);

test("still takes the password from VMBRIDGE_PASSWORD", async () => {
  const { output, hasPassword } = await run({ VMBRIDGE_PASSWORD: "from the environment" });
  expect(hasPassword).toBe(true);
  expect(output).toContain("Open the dashboard");
}, 30_000);

test("makes a log an older service left readable private", async () => {
  let log = "";
  await run({}, (data) => {
    mkdirSync(data, { mode: 0o755 });
    log = join(data, "vmbridge.log");
    writeFileSync(log, "", { mode: 0o644 });
  });
  expect(statSync(log).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
}, 30_000);

test("a new start takes over a running VM Bridge, whose devices are told it is restarting", async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-cli-"));
  const port = await freePort();
  const env = { VMBRIDGE_PASSWORD: "takeover password" };
  const first = await launch(port, env);
  const socket = await connectDevice(`http://127.0.0.1:${port}`, env.VMBRIDGE_PASSWORD);
  const closed = new Promise<CloseEvent>((resolve) => (socket.onclose = resolve));

  const second = await launch(port, env);
  expect(second.output).toContain(`Stopping the VM Bridge already running (process ${first.child.pid})`);
  expect(second.output).toContain("is running");
  const event = await closed;
  expect(event.code).toBe(1012);
  expect(event.reason).toBe("VM Bridge is restarting");
  expect(await first.child.exited).toBe(0);
  expect(readFileSync(join(dir, "data", "vmbridge.pid"), "utf8")).toBe(String(second.child.pid));
  expect((await fetch(`http://127.0.0.1:${port}/admin/api/auth`)).ok).toBe(true);

  second.child.kill("SIGTERM");
  expect(await second.child.exited).toBe(0);
  expect(existsSync(join(dir, "data", "vmbridge.pid"))).toBe(false);
}, 30_000);

test("duplicate SIGTERM, SIGHUP, or restart signals let graceful shutdown finish while a second Ctrl+C aborts", async () => {
  let finishStop!: () => void;
  const stopCalls: boolean[] = [];
  let cleaned = 0;
  const exits: number[] = [];
  const shutdown = createStopHandler({
    stopServer: ({ restarting }) => {
      stopCalls.push(restarting);
      return new Promise<void>((resolve) => (finishStop = resolve));
    },
    cleanupPid: () => {
      cleaned += 1;
    },
    exit: (code) => exits.push(code),
    stopTimeoutMs: 5_000,
    restartTimeoutMs: 5_000,
  });

  const first = shutdown.onSignal("SIGTERM");
  expect(shutdown.isStopping()).toBe(true);
  await shutdown.onSignal("SIGTERM");
  await shutdown.onSignal("SIGHUP");
  await shutdown.onSignal("SIGUSR2");
  expect(exits).toEqual([]);
  expect(stopCalls).toEqual([false]);

  finishStop();
  await first;
  expect(cleaned).toBe(1);
  expect(exits).toEqual([0]);

  let finishInterrupt!: () => void;
  let interruptCleaned = 0;
  const interruptExits: number[] = [];
  const interrupt = createStopHandler({
    stopServer: () => new Promise<void>((resolve) => (finishInterrupt = resolve)),
    cleanupPid: () => {
      interruptCleaned += 1;
    },
    exit: (code) => interruptExits.push(code),
    stopTimeoutMs: 5_000,
    restartTimeoutMs: 5_000,
  });

  const pending = interrupt.onSignal("SIGINT");
  await interrupt.onSignal("SIGINT");
  expect(interruptExits).toEqual([1]);
  finishInterrupt();
  await pending;
  expect(interruptCleaned).toBe(0);
  expect(interruptExits).toEqual([1]);
});

test("SIGTERM followed by SIGINT waits until a second SIGINT before forcing exit", async () => {
  let finishStop!: () => void;
  let cleaned = 0;
  const exits: number[] = [];
  const shutdown = createStopHandler({
    stopServer: () => new Promise<void>((resolve) => (finishStop = resolve)),
    cleanupPid: () => {
      cleaned += 1;
    },
    exit: (code) => exits.push(code),
    stopTimeoutMs: 5_000,
    restartTimeoutMs: 5_000,
  });

  const pending = shutdown.onSignal("SIGTERM");
  await shutdown.onSignal("SIGINT");
  expect(exits).toEqual([]);

  await shutdown.onSignal("SIGINT");
  expect(exits).toEqual([1]);

  finishStop();
  await pending;
  expect(cleaned).toBe(0);
  expect(exits).toEqual([1]);
});

test("startup failure teardown ignores SIGUSR2 while pending and preserves failure exit even if cleanupPid throws", async () => {
  let finishStop!: () => void;
  const stopCalls: boolean[] = [];
  let cleanupAttempts = 0;
  const exits: number[] = [];
  const shutdown = createStopHandler({
    stopServer: ({ restarting }) => {
      stopCalls.push(restarting);
      return new Promise<void>((resolve) => (finishStop = resolve));
    },
    cleanupPid: () => {
      cleanupAttempts += 1;
      throw new Error("EACCES");
    },
    exit: (code) => exits.push(code),
    stopTimeoutMs: 5_000,
    restartTimeoutMs: 5_000,
  });

  const pending = shutdown.stopOnError();
  expect(shutdown.isStopping()).toBe(true);
  await shutdown.onSignal("SIGUSR2");
  expect(stopCalls).toEqual([false]);
  expect(exits).toEqual([]);

  finishStop();
  await pending;
  expect(stopCalls).toEqual([false]);
  expect(cleanupAttempts).toBe(1);
  expect(exits).toEqual([1]);
});

test("forces exit when stopServer hangs past the shutdown deadline", async () => {
  let releaseStop!: () => void;
  let cleaned = 0;
  let timeouts = 0;
  const exits: number[] = [];
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExited = resolve));
  const shutdown = createStopHandler({
    stopServer: () => new Promise<void>((resolve) => (releaseStop = resolve)),
    cleanupPid: () => {
      cleaned += 1;
    },
    exit: (code) => {
      exits.push(code);
      resolveExited();
    },
    onTimeout: () => {
      timeouts += 1;
    },
    stopTimeoutMs: 15,
    restartTimeoutMs: 15,
  });

  const pending = shutdown.onSignal("SIGTERM");
  await exited;
  expect(timeouts).toBe(1);
  expect(exits).toEqual([1]);

  releaseStop();
  await pending;
  expect(cleaned).toBe(0);
  expect(exits).toEqual([1]);
});

test("keeps the event loop alive until shutdown deadline expires in a standalone process", async () => {
  const script = `
    import { createStopHandler } from ${JSON.stringify(cli)};
    const h = createStopHandler({
      stopServer: () => new Promise(() => {}),
      cleanupPid() {},
      stopTimeoutMs: 40,
      onTimeout() {},
    });
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR2"]) process.on(s, () => void h.onSignal(s));
    void h.stopOnError();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
});

test("a SIGTERM during startup network discovery still exits cleanly and removes the pid file", async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-cli-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const tailscalePidFile = join(dir, "tailscale.pid");
  const fakeTailscale = join(binDir, "tailscale");
  writeFileSync(fakeTailscale, `#!/bin/sh\necho $$ > "${tailscalePidFile}"\nsleep 3\nexit 1\n`);
  chmodSync(fakeTailscale, 0o755);

  const port = await freePort();
  const child = Bun.spawn([process.execPath, cli, "run", "--host", "127.0.0.1", "--port", String(port)], {
    env: { PATH: `${binDir}:${process.env.PATH ?? ""}`, HOME: dir, VMBRIDGE_HOME: join(dir, "data") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pidPath = join(dir, "data", "vmbridge.pid");
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidPath) || !existsSync(tailscalePidFile)) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for startup network discovery.");
      await Bun.sleep(20);
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
    const stdout = await new Response(child.stdout).text();
    expect(stdout).not.toContain("is running.");
  } finally {
    if (existsSync(tailscalePidFile)) {
      const pid = Number(readFileSync(tailscalePidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}, 30_000);
