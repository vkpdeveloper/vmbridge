import { Boxd, NotFoundError, type Proxy } from "@boxd-sh/sdk";
import { Boxd as BoxdWeb } from "@boxd-sh/sdk/web";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { boxd } from "@opencoredev/sandbox-sdk/boxd";
import { freestyle } from "@opencoredev/sandbox-sdk/freestyle";
import { instabox } from "@opencoredev/sandbox-sdk/instabox";
import { railway } from "@opencoredev/sandbox-sdk/railway";
import { superserve } from "@opencoredev/sandbox-sdk/superserve";
import type { ProviderId } from "@vmbridge/contracts";
import { Sandbox } from "railway";
import { boatProvider } from "./boat.ts";
import { boxdWeb, useBoxdWeb } from "./boxd-web.ts";
import { daytonaProvider } from "./daytona.ts";
import { e2bProvider } from "./e2b.ts";
import { kubiProvider } from "./kubi.ts";
import { notFound, retryNotFound, sdkDriver } from "./sdk.ts";
import { required, type Box, type ProviderDefinition } from "./types.ts";

export type { Box, Driver, ProviderDefinition, ProviderState, ScreenStream } from "./types.ts";

const minutes = (count: number) => count * 60_000;

async function ignoreNotFound(request: Promise<unknown>) {
  try {
    await request;
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

// boxd suspends on its own after this long without traffic, in case VM Bridge is down.
const boxdIdleTimeoutMs = minutes(60);

interface BoxdProxies {
  list(machine: string): Promise<Pick<Proxy, "name" | "domain">[]>;
  create(machine: string, name: string, port: number): Promise<unknown>;
}

/**
 * A route to `port` beside the machine's default one, which T3 holds: boxd's own preview would point the default route
 * at `port`. It is made once and stays with the machine, as pausing keeps it.
 */
async function boxdRoute(proxies: BoxdProxies, machine: string, port: number) {
  const name = `port-${port}`;
  const find = async () => (await proxies.list(machine)).find((proxy) => proxy.name === name);
  let route = await find();
  if (!route) {
    await proxies.create(machine, name, port);
    route = await find();
  }
  if (!route) throw new Error(`boxd made no route to port ${port}.`);
  return { url: `https://${route.domain}` };
}

/** boxd over grpc-js, through the SDK's boxd adapter. The default on Bun. */
function boxdGrpcDriver(apiKey: string) {
  const provider = boxd({ apiKey });
  const driver = sdkDriver({
    id: "boxd",
    provider,
    sleep: "pause",
    create: { idleTimeoutMs: boxdIdleTimeoutMs },
    // Listing would otherwise skip sleeping machines, and reading their labels wakes them.
    listSleeping: async () => (await provider.listSleeping()).map(({ id, state }) => ({ id, state })),
    // The SDK has no snapshot delete for boxd, so this uses boxd's own client.
    async deleteCheckpoint(name) {
      const client = new Boxd({ apiKey });
      try {
        await client.snapshots.delete(name);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      } finally {
        await client.close();
      }
    },
  });
  return {
    ...driver,
    async preview(box: Box, port: number) {
      const client = new Boxd({ apiKey });
      try {
        return await boxdRoute(client.machines.proxies, box.id, port);
      } finally {
        await client.close();
      }
    },
  };
}

/** boxd over gRPC-web, for Workers. Its provider deletes snapshots itself. */
function boxdWebDriver(apiKey: string) {
  const client = new BoxdWeb({ apiKey, timeout: 30_000, maxRetries: 0 });
  const provider = boxdWeb(client, { apiKey });
  const driver = sdkDriver({
    id: "boxd",
    provider,
    sleep: "pause",
    create: { idleTimeoutMs: boxdIdleTimeoutMs },
    listSleeping: provider.listSleeping,
  });
  return { ...driver, preview: (box: Box, port: number) => boxdRoute(client.machines.proxies, box.id, port) };
}

const boxdProvider: ProviderDefinition = {
  id: "boxd",
  label: "boxd",
  website: "https://boxd.sh",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  sizes: { small: "1 vCPU, 4 GB", medium: "2 vCPU, 8 GB", large: "4 vCPU, 16 GB" },
  defaultSize: "medium",
  open(config) {
    const apiKey = required(config, "apiKey", "boxd API key");
    const driver = useBoxdWeb() ? boxdWebDriver(apiKey) : boxdGrpcDriver(apiKey);
    return { ...driver, create: (input, from) => retryNotFound(() => driver.create(input, from)) };
  },
};

const instaboxProvider: ProviderDefinition = {
  id: "instabox",
  label: "Instabox",
  website: "https://instabox.sh",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  sizes: { small: "2 vCPU, 4 GB", medium: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB" },
  // The free plan allows only 4 vCPU, 8 GB and refuses any other size.
  defaultSize: "medium",
  open(config) {
    const driver = sdkDriver({
      id: "instabox",
      provider: instabox({ apiKey: required(config, "apiKey", "Instabox API key") }),
      sleep: "pause",
      // Instabox allows 5 to 30 minutes. Use the longest as a safety net behind VM Bridge's own sleep.
      create: { idleTimeoutMs: minutes(30) },
    });
    return {
      ...driver,
      create: (input, from) =>
        driver.create(input, from).catch((error: unknown) => {
          throw instaboxError(error);
        }),
    };
  },
};

/**
 * Instabox answers 429 `quota_exceeded` when the plan has no machine to spare: the free plan allows one, and a
 * suspended machine counts. The SDK words every limit the same vague way, so this one says what to do. It stays a
 * `quota` error, which VM Bridge handles as a full plan.
 */
export function instaboxError(error: unknown) {
  const planFull = error instanceof SandboxError && error.code === "quota" && String(error.cause).includes('"providerCode":"quota_exceeded"');
  if (!planFull) return error;
  return new SandboxError("Your Instabox plan's machine limit is reached. Delete a machine or upgrade the plan.", {
    code: "quota",
    provider: "instabox",
    cause: error,
  });
}

const railwayResources = {
  small: { cpu: 1, memoryGB: 2 },
  medium: { cpu: 2, memoryGB: 4 },
  large: { cpu: 4, memoryGB: 8 },
} as const;

const railwayProvider: ProviderDefinition = {
  id: "railway",
  label: "Railway",
  website: "https://railway.com",
  fields: [
    { key: "token", label: "API token", kind: "secret", required: true },
    {
      key: "environmentId",
      label: "Environment ID",
      kind: "text",
      required: true,
      help: "The Railway environment that holds the sandboxes.",
    },
  ],
  features: {
    sleep: "checkpoint",
    keepsDisk: true,
    keepsMemory: false,
  },
  sizes: { small: "1 vCPU, 2 GB", medium: "2 vCPU, 4 GB", large: "4 vCPU, 8 GB" },
  defaultSize: "medium",
  open(config) {
    // Railway has no pause, and its idle timeout destroys the VM, so VM Bridge never sets one.
    // Sleep is a checkpoint followed by destroy, and waking restores the checkpoint.
    const auth = {
      token: required(config, "token", "Railway API token"),
      environmentId: required(config, "environmentId", "Railway environment ID"),
    };
    return sdkDriver({
      id: "railway",
      provider: railway(auth),
      // Railway sets CPU and memory per client, not per create.
      sized: (size) => railway({ ...auth, resources: railwayResources[size] }),
      sleep: "checkpoint",
      // Railway keeps checkpoints until deleted, and deletes them by ID, not by the key the SDK returns.
      async deleteCheckpoint(key) {
        // Railway would call the global fetch as a method of its config, which Workers refuses.
        const options = { ...auth, fetch: fetch.bind(globalThis) };
        const checkpoint = (await Sandbox.checkpoints(options)).find((entry) => entry.key === key);
        if (checkpoint) await Sandbox.deleteCheckpoint(checkpoint.id, options);
      },
    });
  },
};

const freestyleProvider: ProviderDefinition = {
  id: "freestyle",
  label: "Freestyle",
  website: "https://freestyle.sh",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  // The base snapshot fixes the machine. Freestyle can only grow a VM, never shrink it.
  sizes: { small: "4 vCPU, 8 GB", medium: "4 vCPU, 8 GB", large: "4 vCPU, 8 GB" },
  defaultSize: "medium",
  open(config) {
    const provider = freestyle({
      apiKey: required(config, "apiKey", "Freestyle API key"),
      // The SDK's 30 s default cut off a delete of a VM that had just run T3 and an agent. Freestyle finished it anyway.
      requestTimeoutMs: 2 * 60_000,
    });
    return sdkDriver({
      id: "freestyle",
      provider,
      sleep: "pause",
      // Freestyle pauses a VM after this long without network traffic, in case VM Bridge is down.
      create: { idleTimeoutMs: minutes(60) },
      // The SDK has no snapshot delete for Freestyle.
      deleteCheckpoint: (snapshotId) => ignoreNotFound(provider.api.request("DELETE", `/v5/snapshots/${encodeURIComponent(snapshotId)}`)),
    });
  },
};

const superserveProvider: ProviderDefinition = {
  id: "superserve",
  label: "Superserve",
  website: "https://superserve.ai",
  fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "ss_live_..." }],
  features: {
    sleep: "pause",
    keepsDisk: true,
    keepsMemory: true,
  },
  // Every Superserve template has the same machine.
  sizes: { small: "2 vCPU, 4 GB", medium: "2 vCPU, 4 GB", large: "2 vCPU, 4 GB" },
  defaultSize: "medium",
  open(config) {
    const provider = superserve({
      apiKey: required(config, "apiKey", "Superserve API key"),
      // The SDK needs Python in the VM, which the default node-22 template lacks. VM Bridge installs Node itself.
      template: "superserve/python-3.11",
      // Superserve has no idle timer, only a cap on time awake. It pauses a VM awake this long, in case VM Bridge is down.
      autoPauseMs: minutes(12 * 60),
    });
    return sdkDriver({
      id: "superserve",
      provider,
      sleep: "pause",
      // The SDK has no snapshot delete for Superserve.
      deleteCheckpoint: (snapshotId) => ignoreNotFound(provider.api.request("DELETE", `/snapshots/${encodeURIComponent(snapshotId)}`)),
    });
  },
};

export const providers: Record<ProviderId, ProviderDefinition> = {
  boat: boatProvider,
  boxd: boxdProvider,
  daytona: daytonaProvider,
  e2b: e2bProvider,
  freestyle: freestyleProvider,
  instabox: instaboxProvider,
  kubi: kubiProvider,
  railway: railwayProvider,
  superserve: superserveProvider,
};

/** Whether VMs on this provider have a screen to watch (see watch/). */
export const hasScreen = (provider: ProviderId) => providers[provider].screen === true;
