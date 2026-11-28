import { connectSandbox, SandboxError } from "@opencoredev/sandbox-sdk";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";
import { sleep } from "../runtime.ts";
import { notFound, sdkDriver } from "./sdk.ts";
import { required, type Box, type ProviderDefinition } from "./types.ts";

interface DaytonaSandbox {
  id: string;
  state: string;
  errorReason?: string | null;
}

/** Daytona's built-in container snapshots, sized so no resize is needed after create. */
const snapshots = { small: "daytona-small", medium: "daytona-medium", large: "daytona-large" } as const;

/** Daytona stops a sandbox after this many minutes without preview or toolbox traffic, in case VM Bridge is down. */
const autoStopMinutes = 60;

const failed = new Set(["error", "build_failed", "destroyed", "destroying"]);
const gone = new Set(["destroyed", "destroying"]);
const settling = new Set(["stopping", "archiving"]);

function isConflict(error: unknown): boolean {
  if (!(error instanceof SandboxError)) return false;
  const { cause } = error;
  if (typeof cause === "object" && cause !== null && "status" in cause) {
    return cause.status === 409;
  }
  if (typeof cause === "string" && cause.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(cause);
      return typeof parsed === "object" && parsed !== null && "status" in parsed && parsed.status === 409;
    } catch {
      return false;
    }
  }
  return false;
}

export const daytonaProvider: ProviderDefinition = {
  id: "daytona",
  label: "Daytona",
  website: "https://daytona.io",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "dtn_..." }],
  features: {
    // Container sandboxes cannot pause. Stop keeps the filesystem and clears memory.
    sleep: "stop",
    keepsDisk: true,
    keepsMemory: false,
    // Daytona secrets only swap API keys into outbound HTTPS headers. There are no agent sign-ins or GitHub link.
  },
  sizes: { small: "1 vCPU, 1 GB", medium: "2 vCPU, 4 GB", large: "4 vCPU, 8 GB" },
  defaultSize: "medium",

  open(config) {
    const provider = daytona({ apiKey: required(config, "apiKey", "Daytona API key") });
    const { api } = provider;
    const base = sdkDriver({ id: "daytona", provider, sleep: "pause" });
    const connect = (sandboxId: string): Promise<Box> => connectSandbox(provider, sandboxId, { recoverSecrets: false });

    const get = (sandboxId: string) => api.request<DaytonaSandbox>("GET", "/sandbox/{sandboxId}", { params: { sandboxId } });

    async function waitFor(sandboxId: string, done: (state: string) => boolean, timeoutMs: number): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sandbox = await get(sandboxId);
        if (done(sandbox.state)) return sandbox.state;
        if (failed.has(sandbox.state)) throw new Error(`Daytona sandbox ${sandboxId} is ${sandbox.state}: ${sandbox.errorReason ?? "no reason given"}.`);
        await sleep(250);
      }
      throw new Error(`Daytona sandbox ${sandboxId} did not settle within ${Math.round(timeoutMs / 1000)} seconds.`);
    }

    // Daytona finds a snapshot by name but deletes it only by id.
    async function deleteSnapshot(name: string) {
      try {
        const { id } = await api.request<{ id: string }>("GET", "/snapshots/{name}", { params: { name } });
        await api.request("DELETE", "/snapshots/{id}", { params: { id } });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }

    async function destroy(sandboxId: string) {
      const remove = () => api.request("DELETE", "/sandbox/{sandboxId}", { params: { sandboxId } });
      const readState = async (): Promise<string | undefined> => {
        try {
          return (await get(sandboxId)).state;
        } catch (readError) {
          if (notFound(readError)) return undefined;
          throw readError;
        }
      };

      try {
        await remove();
      } catch (error) {
        if (notFound(error)) return;
        if (!isConflict(error)) throw error;
        // Daytona answers 409 while a stop or delete is already in progress, such as a delete right after sleep.
        const state = await readState();
        if (state === undefined || gone.has(state)) return;
        if (!settling.has(state)) throw error;
        let next: string;
        try {
          next = await waitFor(sandboxId, (current) => !settling.has(current), 3 * 60_000);
        } catch (waitError) {
          if (notFound(waitError)) return;
          throw waitError;
        }
        if (gone.has(next)) return;
        try {
          await remove();
        } catch (retryError) {
          if (notFound(retryError)) return;
          if (!isConflict(retryError)) throw retryError;
          // Another delete may have started right after the sandbox finished stopping.
          const after = await readState();
          if (after === undefined || gone.has(after)) return;
          throw retryError;
        }
      }
    }

    return {
      ...base,

      // The SDK sends `target: "us"` unless told otherwise, which fails for orgs without that region, and it
      // resizes non-default sizes with a stop, resize and start. Creating through the API leaves out the
      // target (Daytona uses the org's default region) and picks a snapshot of the right size.
      async create(input, from) {
        const sandbox = await api.request<DaytonaSandbox>("POST", "/sandbox", {
          body: {
            snapshot: from ?? snapshots[input.size],
            // The SDK's label encoding, so `connectSandbox` and `listSandboxes` treat it as its own.
            labels: { ...input.labels, "sandbox-sdk": "1", "sandbox-sdk-key": input.key },
            public: false,
            autoStopInterval: autoStopMinutes,
          },
          timeoutMs: 90_000,
        });
        try {
          if (sandbox.state !== "started") await waitFor(sandbox.id, (state) => state === "started", 3 * 60_000);
          return await connect(sandbox.id);
        } catch (error) {
          await destroy(sandbox.id).catch(() => undefined);
          throw error;
        }
      },

      // A base snapshot keeps the sandbox's disk and size. Daytona makes cold snapshots of container sandboxes from a
      // stopped one, and a snapshot can start sandboxes once it is active.
      async snapshot(box) {
        const name = `vmbridge-base-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
        await api.request("POST", "/sandbox/{sandboxId}/stop", { params: { sandboxId: box.id } });
        await waitFor(box.id, (state) => state === "stopped", 3 * 60_000);
        try {
          // Inside the try: Daytona may start the snapshot even when this request fails.
          await api.request("POST", "/sandbox/{sandboxId}/snapshot", { params: { sandboxId: box.id }, body: { name } });
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            const { state } = await api.request<{ state: string }>("GET", "/snapshots/{name}", { params: { name } });
            if (state === "active") return name;
            if (failed.has(state)) throw new Error(`Daytona could not save the snapshot: it is ${state}.`);
            await sleep(2000);
          }
          throw new Error("Daytona did not finish the snapshot within 15 minutes.");
        } catch (error) {
          await deleteSnapshot(name).catch(() => undefined);
          throw error;
        }
      },

      deleteCheckpoint: deleteSnapshot,

      async sleep(box) {
        await api.request("POST", "/sandbox/{sandboxId}/stop", { params: { sandboxId: box.id } });
        return {};
      },

      async wake(vm) {
        let { state } = await get(vm.sandboxId);
        // Daytona refuses a start while the sandbox is still stopping.
        if (settling.has(state)) {
          await waitFor(vm.sandboxId, (next) => !settling.has(next), 3 * 60_000);
          ({ state } = await get(vm.sandboxId));
        }
        // An archived sandbox restores its filesystem from object storage on start, which is slower.
        if (state === "stopped" || state === "archived") {
          await api.request("POST", "/sandbox/{sandboxId}/start", { params: { sandboxId: vm.sandboxId }, timeoutMs: 60_000 });
        }
        await waitFor(vm.sandboxId, (next) => next === "started", 5 * 60_000);
        return connect(vm.sandboxId);
      },

      // VM Bridge's idle sweep reads the T3 shell through the preview, and preview traffic resets Daytona's auto-stop.
      async keepAlive() {},

      destroy,
    };
  },
};
