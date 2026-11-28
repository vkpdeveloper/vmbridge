import { deflateRawSync } from "node:zlib";
import { connectSandbox } from "@opencoredev/sandbox-sdk";
import { boat } from "@opencoredev/sandbox-sdk/boat";
import type { SelectOption } from "@vmbridge/contracts";
import { sleep } from "../runtime.ts";
import { notFound, sdkDriver } from "./sdk.ts";
import { required, type Box, type ProviderDefinition, type ProviderState } from "./types.ts";

interface BoatEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
}

interface BoatSavedSnapshot {
  status: "saving" | "ready" | "failed";
  error?: string;
}

interface BoatSandbox {
  id: string;
  name?: string | null;
  state: string;
}

const machines = { small: "small", medium: "default", large: "large" } as const;
const running = new Set(["ready", "idle", "running"]);
const settling = new Set(["stopping", "archiving", "securing", "provisioning", "starting", "resuming", "queued"]);
const failed = new Set(["error", "failed", "deleted"]);

/** Boat stops a VM this long after it starts. VM Bridge sleeps idle VMs much sooner; this caps cost if it is down. */
const ttlSeconds = 12 * 60 * 60;

/**
 * The SDK keeps Boat metadata in the VM name. Writing the same encoding lets `connectSandbox`
 * attach to VMs VM Bridge creates through Boat's API directly.
 */
function sdkName(key: string, labels: Record<string, string>) {
  const name = "sandbox-sdk:1:" + deflateRawSync(JSON.stringify([key, labels])).toString("base64url");
  if (name.length > 120) throw new Error("VM labels are too long for a Boat VM name.");
  return name;
}

export const boatProvider: ProviderDefinition = {
  id: "boat",
  label: "Boat",
  website: "https://boat.dev",
  fields: [
    { key: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "boat_..." },
    {
      key: "environment",
      label: "Environment",
      kind: "select",
      required: false,
      help: "The Boat environment new VMs start in.",
    },
  ],
  features: {
    sleep: "stop",
    keepsDisk: true,
    keepsMemory: false,
  },
  sizes: { small: "2 vCPU, 4 GB", medium: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB" },
  defaultSize: "small",

  open(config) {
    const apiKey = required(config, "apiKey", "Boat API key");
    const provider = boat({ apiKey, ttlSeconds });
    const { api } = provider;
    const base = sdkDriver({ id: "boat", provider, sleep: "pause" });

    const get = async (sandboxId: string) =>
      (await api.request<{ sandbox: BoatSandbox }>("GET", "/sandboxes/{sandboxId}", { params: { sandboxId } }))
        .sandbox;

    const environments = async () =>
      (await api.request<{ environments: BoatEnvironment[] }>("GET", "/environments")).environments;

    async function waitRunning(sandboxId: string) {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const { state } = await get(sandboxId);
        if (running.has(state)) return;
        if (failed.has(state)) throw new Error(`Boat VM ${sandboxId} is ${state}.`);
        await sleep(1000);
      }
      throw new Error(`Boat VM ${sandboxId} did not start within 5 minutes.`);
    }

    const connect = (sandboxId: string): Promise<Box> => connectSandbox(provider, sandboxId, { recoverSecrets: false });

    async function deleteSaved(name: string) {
      try {
        await api.request("DELETE", "/saved-snapshots/{name}", { params: { name } });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }

    async function destroy(sandboxId: string) {
      try {
        await api.request("DELETE", "/sandboxes/{sandboxId}", {
          params: { sandboxId },
          headers: { "X-Ascii-Confirm-Delete": sandboxId },
        });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }

    return {
      ...base,

      async verify() {
        await environments();
      },

      async options(field): Promise<SelectOption[]> {
        if (field !== "environment") return [];
        return (await environments()).map((environment) => ({
          value: environment.name,
          label: environment.isDefault ? `${environment.name} (default)` : environment.name,
        }));
      },

      // The SDK creates Boat VMs with `noEnv: true`, which drops the environment, so VM Bridge
      // creates them through Boat's API and attaches with the SDK. A VM from a saved snapshot gets the
      // snapshot's machine type, and `noEnv: false` keeps it from inheriting the snapshot VM's environment choice.
      async create(input, from) {
        const environment = config.values.environment || undefined;
        const { sandbox } = await api.request<{ sandbox: BoatSandbox }>("POST", "/sandboxes", {
          // Apart from the key of a plain create, which follows when a create from a snapshot fails.
          headers: { "Idempotency-Key": from ? `${input.key}-base` : input.key },
          body: {
            ttlSeconds,
            ...(from ? { from, noEnv: false } : { type: machines[input.size] }),
            ...(environment ? { environment, noEnv: false } : {}),
          },
          timeoutMs: 90_000,
        });
        try {
          await api.request("PATCH", "/sandboxes/{sandboxId}", {
            params: { sandboxId: sandbox.id },
            body: { name: sdkName(input.key, input.labels) },
          });
          await waitRunning(sandbox.id);
          return await connect(sandbox.id);
        } catch (error) {
          await destroy(sandbox.id).catch(() => undefined);
          throw error;
        }
      },

      connect,

      // The SDK has no Boat snapshots. Boat keeps saved snapshots until deleted. A plan includes at least 10; past that each
      // one is billed to the wallet, and a save with an empty wallet fails with credit_required.
      async snapshot(box) {
        const name = `vmbridge-base-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
        try {
          // Inside the try: Boat may save the snapshot even when this request times out.
          await api.request("POST", "/saved-snapshots", { body: { sandboxId: box.id, name }, timeoutMs: 90_000 });
          const deadline = Date.now() + 10 * 60_000;
          while (Date.now() < deadline) {
            const { snapshot } = await api.request<{ snapshot: BoatSavedSnapshot }>("GET", "/saved-snapshots/{name}", { params: { name } });
            if (snapshot.status === "ready") return name;
            if (snapshot.status === "failed") throw new Error(`Boat could not save the snapshot: ${snapshot.error ?? "no reason given"}.`);
            await sleep(2000);
          }
          throw new Error("Boat did not finish the snapshot within 10 minutes.");
        } catch (error) {
          await deleteSaved(name).catch(() => undefined);
          throw error;
        }
      },

      deleteCheckpoint: deleteSaved,

      async states(labels) {
        const states = await base.states(labels);
        // The SDK reports Boat's transitional states as stopped. Keep them apart so a waking VM is not slept again.
        for (const [id, state] of states) {
          if (state !== "stopped") continue;
          let native: string;
          try {
            ({ state: native } = await get(id));
          } catch (error) {
            if (notFound(error)) {
              states.delete(id);
              continue;
            }
            throw error;
          }
          if (native === "deleted") states.delete(id);
          else if (running.has(native) || settling.has(native)) states.set(id, "running" satisfies ProviderState);
        }
        return states;
      },

      async sleep(box) {
        await api.request("POST", "/sandboxes/{sandboxId}/stop", { params: { sandboxId: box.id }, body: {} });
        return {};
      },

      async wake(vm) {
        const deadline = Date.now() + 3 * 60_000;
        let { state } = await get(vm.sandboxId);
        // A stop must finish before Boat accepts a resume.
        while (["stopping", "archiving", "securing"].includes(state) && Date.now() < deadline) {
          await sleep(1000);
          ({ state } = await get(vm.sandboxId));
        }
        if (!running.has(state) && !settling.has(state)) {
          await api.request("POST", "/sandboxes/{sandboxId}/resume", {
            params: { sandboxId: vm.sandboxId },
            body: { ttlSeconds },
          });
        }
        await waitRunning(vm.sandboxId);
        return connect(vm.sandboxId);
      },

      async keepAlive(box) {
        // Boat's auto-stop timer counts from start. Push it back while agents work.
        await api.request("PATCH", "/sandboxes/{sandboxId}", { params: { sandboxId: box.id }, body: { ttlSeconds } });
      },

      destroy,
    };
  },
};
