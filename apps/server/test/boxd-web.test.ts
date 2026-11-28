import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthenticationError, ConflictError, MachineFileNotFoundError, NotFoundError, type Machine } from "@boxd-sh/sdk/web";
import { connectSandbox, SandboxError } from "@opencoredev/sandbox-sdk";
import type { ExecInput, OutputChunk } from "@opencoredev/sandbox-sdk/provider";
import { boxdWeb, boxdWebError, useBoxdWeb, type BoxdWebClient } from "../src/providers/boxd-web.ts";
import { sdkDriver } from "../src/providers/sdk.ts";

type FakeMachine = { id: string; name: string; status: Machine["status"]; createdAt: Date | null };
type Exec = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * A fake of the parts of `@boxd-sh/sdk/web` the provider uses. Files live in memory unless `local` is set, in
 * which case uploads, downloads and commands use this machine's own filesystem and shell.
 */
function fakeBoxd(options: { local?: boolean } = {}) {
  const machines = new Map<string, FakeMachine>();
  const files = new Map<string, Uint8Array>();
  const snapshots = new Map<string, "pending" | "ready">();
  const calls: { method: string; args: unknown[] }[] = [];
  const commands: string[] = [];
  let next = 0;

  const record = (method: string, ...args: unknown[]) => void calls.push({ method, args });
  const machine = (id: string) => {
    const found = machines.get(id);
    if (!found) throw new NotFoundError(`machine ${id} not found`, 5);
    return found;
  };

  // dash where there is one: it is `sh` on Debian and Ubuntu guests, and stricter than macOS's bash-based `sh`.
  const shell = Bun.which("dash") ?? "sh";
  const local: Exec = async (command) => {
    const child = Bun.spawn([shell, "-c", command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  // Records metadata the way the guest would, so list and connect can read it back.
  const inMemory: Exec = async (command) => {
    const written = /printf %s '(.*)' > \/var\/lib\/sandbox-sdk\/metadata\.json$/.exec(command);
    if (written) {
      const id = [...machines.values()].at(-1)?.id ?? "";
      files.set(`${id}:/var/lib/sandbox-sdk/metadata.json`, new TextEncoder().encode(written[1]));
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const run = options.local ? local : inMemory;

  const client: BoxdWebClient = {
    machines: {
      async create(params) {
        record("create", params);
        const created = { id: `vm-${++next}`, name: params.name ?? "", status: "starting" as const, createdAt: new Date(1_000) };
        machines.set(created.id, created);
        return created;
      },
      async get(id) {
        return machine(id);
      },
      async list() {
        return [...machines.values()];
      },
      async delete(id) {
        record("delete", id);
        machine(id);
        machines.delete(id);
      },
      async waitUntilReady(id) {
        machine(id).status = "running";
        return machine(id);
      },
      async exec(id, params) {
        machine(id);
        commands.push(params.command);
        return run(params.command);
      },
      async pause(id) {
        record("pause", id);
        machine(id).status = "suspended";
      },
      async resume(id) {
        record("resume", id);
        machine(id).status = "running";
      },
      async setBotProtection(id, mode) {
        record("setBotProtection", id, mode);
      },
      files: {
        async upload(id, path, data) {
          record("upload", id, path, new TextDecoder().decode(data));
          if (options.local) {
            if (!existsSync(dirname(path))) throw new MachineFileNotFoundError("open: no such file or directory", 5, path);
            await Bun.write(path, data);
          } else {
            files.set(`${id}:${path}`, data);
          }
          return data.length;
        },
        async download(id, path) {
          const data = options.local ? await Bun.file(path).bytes() : files.get(`${id}:${path}`);
          if (!data) throw new MachineFileNotFoundError("open: no such file or directory", 5, path);
          return data;
        },
      },
      proxies: {
        async list(id) {
          return [{ domain: `${machine(id).name}.boxd.test`, isDefault: true }];
        },
        async setPort(id, port) {
          record("setPort", id, port);
        },
      },
    },
    snapshots: {
      async create(id, name) {
        record("snapshot", id, name);
        snapshots.set(name, "pending");
      },
      async get(name) {
        // Ready on the second look, as a real capture takes a moment.
        const status = snapshots.get(name);
        if (!status) throw new NotFoundError(`snapshot ${name} not found`, 5);
        snapshots.set(name, "ready");
        return { status: status === "ready" ? "ready" : "pending" };
      },
      async delete(name) {
        record("deleteSnapshot", name);
        if (!snapshots.delete(name)) throw new NotFoundError(`snapshot ${name} not found`, 5);
      },
    },
  };
  return { client, machines, calls, commands };
}

const apiKey = "bxd_test_secret";

describe("commands over gRPC-web", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "boxd-web-")));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  async function localBox() {
    const fake = fakeBoxd({ local: true });
    fake.machines.set("vm-1", { id: "vm-1", name: "sbxsdk-local", status: "running", createdAt: null });
    return { ...fake, provider: boxdWeb(fake.client, { apiKey }) };
  }

  const exec = (overrides: Partial<ExecInput>) => {
    const chunks: OutputChunk[] = [];
    const input: ExecInput = { command: "true", cwd, env: {}, timeoutMs: 10_000, onChunk: (chunk) => chunks.push(chunk), ...overrides };
    return { input, chunks };
  };

  test("stdin is uploaded, read by the command, then removed", async () => {
    const { provider, calls } = await localBox();
    // What prepareVm sends: a bash program on stdin.
    const { input, chunks } = exec({
      command: "bash -s",
      env: { GREETING: "it's hi" },
      stdin: `set -euo pipefail\nmain() {\necho "$GREETING from $(pwd)"\necho warning >&2\nexit 3\n}\nmain </dev/null\n`,
    });
    expect(await provider.exec("vm-1", input)).toEqual({ exitCode: 3, timedOut: false });
    expect(chunks).toEqual([
      { stream: "stdout", text: `it's hi from ${cwd}\n` },
      { stream: "stderr", text: "warning\n" },
    ]);
    const upload = calls.find((call) => call.method === "upload");
    expect(String(upload?.args[1])).toStartWith("/tmp/.sandbox-sdk/stdin/");
    expect(existsSync(String(upload?.args[1]))).toBe(false);
  });

  test("stdin waits in a folder only the VM's user can read, and is removed when the command never starts", async () => {
    const { provider, client, calls } = await localBox();
    const run = client.machines.exec;
    client.machines.exec = async (id, params) => {
      if (params.command.includes("vmbridge-exec-")) throw new Error("connection reset");
      return run(id, params);
    };
    const { input } = exec({ command: "bash -s", stdin: "echo secret\n" });
    await expect(provider.exec("vm-1", input)).rejects.toThrow();
    const path = String(calls.find((call) => call.method === "upload")?.args[1]);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(existsSync(path)).toBe(false);
  });

  test("a command without stdin reads nothing", async () => {
    const { provider, calls } = await localBox();
    const { input, chunks } = exec({ command: "cat; echo done" });
    expect(await provider.exec("vm-1", input)).toEqual({ exitCode: 0, timedOut: false });
    expect(chunks).toEqual([{ stream: "stdout", text: "done\n" }]);
    expect(calls.some((call) => call.method === "upload")).toBe(false);
  });

  test("a missing working directory fails the command, not the call", async () => {
    const { provider } = await localBox();
    const { input } = exec({ cwd: join(cwd, "missing") });
    expect((await provider.exec("vm-1", input)).exitCode).toBe(2);
  });

  test.skipIf(!Bun.which("timeout"))("a command past its timeout is stopped and reported as timed out", async () => {
    const { provider } = await localBox();
    const started = Date.now();
    const { input } = exec({ command: "sleep 30", timeoutMs: 300 });
    expect(await provider.exec("vm-1", input)).toEqual({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test.skipIf(!Bun.which("timeout") || !Bun.which("pgrep"))("an aborted command is killed with its children", async () => {
    const { provider } = await localBox();
    const marker = `sleep 31.${process.pid}`;
    const { input } = exec({ command: `${marker} & wait`, timeoutMs: 60_000, signal: AbortSignal.timeout(300) });
    expect(await provider.exec("vm-1", input)).toEqual({ exitCode: null, timedOut: true });
    const left = Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
    expect(left).toBe("");
  });

  test("aborting during stdin upload cleans up the uploaded file without launching the command", async () => {
    const { client, commands } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    const { id } = await provider.create({ key: "abort-stdin", labels: {} });
    const controller = new AbortController();
    const originalUpload = client.machines.files.upload;
    let uploadedPath = "";
    client.machines.files.upload = async (machineId, path, data) => {
      uploadedPath = path;
      controller.abort();
      return originalUpload(machineId, path, data);
    };
    const { input } = exec({ command: "echo should-not-run", stdin: "secret\n", signal: controller.signal });
    expect(await provider.exec(id, input)).toEqual({ exitCode: null, timedOut: true });
    expect(commands.some((command) => command.includes("should-not-run"))).toBe(false);
    expect(commands).toContain(`rm -f -- '${uploadedPath}'`);

    // If the upload itself fails after the signal aborted, exec still reports timeout and cleans up.
    const failedController = new AbortController();
    let failedPath = "";
    client.machines.files.upload = async (_machineId, path) => {
      failedPath = path;
      failedController.abort();
      throw new Error("upload interrupted");
    };
    const { input: failedInput } = exec({ command: "echo should-not-run-2", stdin: "secret\n", signal: failedController.signal });
    expect(await provider.exec(id, failedInput)).toEqual({ exitCode: null, timedOut: true });
    expect(commands.some((command) => command.includes("should-not-run-2"))).toBe(false);
    expect(commands).toContain(`rm -f -- '${failedPath}'`);
  });
});

describe("the provider maps boxd calls", () => {
  test("create names the machine for the SDK, sizes it, and records the key and labels", async () => {
    const { client, calls, commands } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    const info = await provider.create({ key: "vm-key", size: "large", labels: { vmbridge: "test" }, idleTimeoutMs: 3_600_000 });
    expect(info).toMatchObject({ id: "vm-1", key: "vm-key", labels: { vmbridge: "test" }, state: "running" });
    const create = calls.find((call) => call.method === "create")?.args[0];
    expect(create).toMatchObject({ isolated: true, config: { vcpu: 4, autoSuspendTimeout: 3600, autoDestroyTimeout: 0 } });
    expect(String((create as { name: string }).name)).toStartWith("sbxsdk-");
    expect(commands[0]).toContain('"key":"vm-key"');

    // Restoring a snapshot passes no size, as the snapshot fixes it.
    await provider.create({ key: "vm-key-2", labels: {}, from: "sbxsdk-snap" });
    expect(calls.filter((call) => call.method === "create")[1]?.args[0]).toMatchObject({ fromSnapshot: "sbxsdk-snap", config: { autoSuspendTimeout: 0 } });
  });

  test("a create that fails after boxd made the machine deletes it", async () => {
    const { client, calls, machines } = fakeBoxd();
    client.machines.exec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const provider = boxdWeb(client, { apiKey });
    await expect(provider.create({ key: "k", labels: {} })).rejects.toMatchObject({ code: "provider" });
    expect(calls.some((call) => call.method === "delete")).toBe(true);
    expect(machines.size).toBe(0);
  });

  test("list reads awake SDK machines' labels and leaves sleeping ones to listSleeping", async () => {
    const { client, machines } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    await provider.create({ key: "a", labels: { vmbridge: "bridge-1" } });
    await provider.create({ key: "b", labels: { vmbridge: "other" } });
    await provider.create({ key: "c", labels: { vmbridge: "bridge-1" } });
    machines.set("not-sdk", { id: "not-sdk", name: "my-box", status: "running", createdAt: null });
    await provider.pause?.("vm-3");

    expect((await provider.list({ vmbridge: "bridge-1" })).map((info) => info.key)).toEqual(["a"]);
    expect(await provider.listSleeping()).toEqual([{ id: "vm-3", state: "paused" }]);
    expect(await provider.connect("vm-3")).toMatchObject({ key: "c", state: "paused" });
    await expect(provider.connect("not-sdk")).rejects.toMatchObject({ code: "not_found" });
  });

  test("malformed metadata on one machine is skipped by list and find while connect reports a provider error", async () => {
    const { client, machines } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    await provider.create({ key: "healthy", labels: { vmbridge: "bridge-1" } });
    await provider.create({ key: "sleeping-healthy", labels: { vmbridge: "bridge-1" } });
    await provider.pause?.("vm-2");
    machines.set("corrupt-json", { id: "corrupt-json", name: "sbxsdk-corrupt", status: "running", createdAt: null });
    machines.set("corrupt-labels-array", { id: "corrupt-labels-array", name: "sbxsdk-array", status: "running", createdAt: null });
    machines.set("corrupt-label-value", { id: "corrupt-label-value", name: "sbxsdk-num", status: "running", createdAt: null });
    machines.set("corrupt-sleeping", { id: "corrupt-sleeping", name: "sbxsdk-sleep-bad", status: "suspended", createdAt: null });
    const put = (id: string, body: string) =>
      client.machines.files.upload(id, "/var/lib/sandbox-sdk/metadata.json", new TextEncoder().encode(body));
    await put("corrupt-json", "{truncated");
    await put("corrupt-labels-array", JSON.stringify({ labels: [], createdAt: 1 }));
    await put("corrupt-label-value", JSON.stringify({ labels: { vmbridge: "bridge-1", owner: 42 }, createdAt: 1 }));
    await put("corrupt-sleeping", "{truncated");

    expect((await provider.list({})).map((info) => info.key)).toEqual(["healthy"]);
    expect((await provider.list({ vmbridge: "bridge-1" })).map((info) => info.key)).toEqual(["healthy"]);
    expect((await provider.find("healthy"))?.id).toBe("vm-1");
    expect((await provider.find("sleeping-healthy"))?.id).toBe("vm-2");
    expect(await provider.find("missing-key")).toBeUndefined();
    await expect(provider.connect("corrupt-json")).rejects.toMatchObject({ code: "provider" });
    await expect(provider.connect("corrupt-labels-array")).rejects.toMatchObject({ code: "provider" });
    await expect(provider.connect("corrupt-label-value")).rejects.toMatchObject({ code: "provider" });
    await expect(provider.connect("corrupt-sleeping")).rejects.toMatchObject({ code: "provider" });
  });

  test("snapshots wait until ready, and deleting one already gone is fine", async () => {
    const { client } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    const { id } = await provider.create({ key: "a", labels: {} });
    const snapshot = await provider.snapshot!(id);
    expect(snapshot.id).toStartWith("sbxsdk-");
    expect(await provider.deleteSnapshot!(snapshot.id)).toBe(true);
    expect(await provider.deleteSnapshot!(snapshot.id)).toBe(false);
  });

  test("a preview points boxd's default proxy at the port and turns bot protection off", async () => {
    const { client, calls } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    const { id } = await provider.create({ key: "a", labels: {} });
    expect((await provider.previewUrl(id, 3773)).url).toMatch(/^https:\/\/sbxsdk-.*\.boxd\.test$/);
    expect(calls.filter((call) => call.method === "setPort" || call.method === "setBotProtection").map((call) => call.args)).toEqual([
      [id, 3773],
      [id, "off"],
    ]);
  });

  test("boxd errors become the SDK's codes, without the API key", () => {
    expect(boxdWebError(new NotFoundError("machine gone", 5), apiKey).code).toBe("not_found");
    // VM Bridge's wake retries a resume boxd refuses while the machine is still pausing.
    expect(boxdWebError(new ConflictError("machine is suspending", 9), apiKey).code).toBe("invalid_argument");
    const auth = boxdWebError(new AuthenticationError(`invalid key ${apiKey}`, 16), apiKey);
    expect(auth.code).toBe("auth");
    expect(auth.message).not.toContain(apiKey);
    expect(boxdWebError(new MachineFileNotFoundError("no such file or directory", 5), apiKey).code).toBe("file_not_found");
  });
});

describe("VM Bridge's driver on the gRPC-web provider", () => {
  test("creates, runs with stdin, sleeps, wakes and lists through the SDK's handle", async () => {
    const { client, calls, commands } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    const driver = sdkDriver({ id: "boxd", provider, sleep: "pause", listSleeping: provider.listSleeping });

    const box = await driver.create({ key: "vm-a", size: "medium", labels: { vmbridge: "b1" }, ports: [3773] });
    expect(box.id).toBe("vm-1");
    expect(calls.find((call) => call.method === "create")?.args[0]).toMatchObject({ config: { vcpu: 2 } });

    await box.run("bash -s", { stdin: "echo hi\n", timeoutMs: 5_000 });
    const upload = calls.findLast((call) => call.method === "upload");
    expect(upload?.args[2]).toBe("echo hi\n");
    expect(commands.at(-1)).toContain(`< '${String(upload?.args[1])}'`);

    expect(await driver.sleep(box)).toEqual({});
    expect(await driver.states({ vmbridge: "b1" })).toEqual(new Map([["vm-1", "paused"]]));
    const woken = await driver.wake({ key: "vm-a", size: "medium", labels: {}, ports: [], sandboxId: "vm-1", checkpoint: null });
    expect(woken.id).toBe("vm-1");
    expect(calls.map((call) => call.method)).toContain("resume");
    expect(await driver.states({ vmbridge: "b1" })).toEqual(new Map([["vm-1", "running"]]));

    await driver.destroy("vm-1");
    await driver.destroy("vm-1");
    expect(await driver.list({ vmbridge: "b1" })).toEqual([]);
  });

  test("connecting to a VM the other boxd driver made reads the same metadata", async () => {
    const { client, machines } = fakeBoxd();
    const provider = boxdWeb(client, { apiKey });
    await provider.create({ key: "made-by-either", labels: { vmbridge: "b1" } });
    const box = await connectSandbox(provider, "vm-1", { recoverSecrets: false });
    expect(box.id).toBe("vm-1");
    expect(machines.get("vm-1")?.name).toStartWith("sbxsdk-");
  });
});

test("Bun keeps the grpc-js boxd driver unless VMBRIDGE_BOXD_WEB=1", () => {
  const saved = process.env.VMBRIDGE_BOXD_WEB;
  try {
    delete process.env.VMBRIDGE_BOXD_WEB;
    expect(useBoxdWeb()).toBe(false);
    process.env.VMBRIDGE_BOXD_WEB = "1";
    expect(useBoxdWeb()).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.VMBRIDGE_BOXD_WEB;
    else process.env.VMBRIDGE_BOXD_WEB = saved;
  }
});

test("SandboxError stays a SandboxError", () => {
  const error = new SandboxError("x", { code: "quota", provider: "boxd" });
  expect(boxdWebError(error, apiKey)).toBe(error);
});
