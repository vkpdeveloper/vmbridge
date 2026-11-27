// `vmbridge opencode`: from a local repository to OpenCode running in a fresh worktree on one of its project's VMs.
import type { OpenCodeLaunchEvent } from "@vmbridge/contracts";
import { newToken } from "../auth/tokens.ts";
import { message } from "../fleet.ts";
import type { Store } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import { NoOpenCodeKey } from "../vm/opencode.ts";
import type { Clones } from "./clones.ts";
import type { Hub } from "./hub.ts";
import { openCodePrefix } from "./opencode.ts";

/** A branch as the clone flow takes one. */
const branchName = (branch: string) => /^[\w./-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..");

type Deps = { store: Store; hub: Hub; clones: Clones; traffic: Traffic; hasKey: () => boolean };

/**
 * `/api/vmbridge/opencode`. POST starts OpenCode in a new worktree (see `launch`). DELETE, sent when the terminal app
 * closes, removes that worktree unless it holds work.
 */
export function openCodeLauncher(deps: Deps) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "POST") return launch(deps, request);
    if (request.method === "DELETE") return finish(deps, request);
    return new Response("Method Not Allowed", { status: 405 });
  };
}

/**
 * Finds or adds the project for `remote`, places it on a VM as a new thread would be, makes a worktree there and starts
 * OpenCode. With `resume`, it opens that worktree again instead. The answer is a stream of JSON lines, one per step, so
 * the terminal shows each as it happens. The last line has the OpenCode address under this server and its password, or
 * the error.
 */
async function launch({ store, hub, clones, traffic, hasKey }: Deps, request: Request) {
  const body = (await request.json().catch(() => null)) as { remote?: unknown; branch?: unknown; resume?: unknown } | null;
  const remote = typeof body?.remote === "string" ? body.remote : "";
  const branch = typeof body?.branch === "string" && branchName(body.branch) ? body.branch : null;
  const resume = typeof body?.resume === "string" ? body.resume : null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: OpenCodeLaunchEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The terminal went away. The steps already running finish, and the worktree stays for next time.
        }
      };
      const step = (text: string) => send({ step: text });
      const detail = (text: string) => send({ detail: text });
      const started = performance.now();
      let vmId: string | undefined;
      try {
        if (!hasKey()) throw new NoOpenCodeKey();
        const project = clones.add(remote);
        let password = store.openCodePassword(project.id);
        if (!password) {
          password = newToken();
          store.setOpenCodePassword(project.id, password);
        }
        let worktree: { name: string; path: string; branch: string; base: string | null };
        if (resume) {
          step(`Finding the worktree ${resume}`);
          const found = await hub.fleet.findWorktree(project.id, resume, step, detail);
          vmId = found.vmId;
          worktree = { ...found, name: resume, base: null };
        } else {
          step(`Finding a VM for ${project.title}`);
          const placement = await hub.placeOpenCode(project.id, step, detail);
          vmId = placement.vmId;
          if (placement.notice) send({ notice: placement.notice });
          step("Making a worktree");
          worktree = await hub.fleet.worktree(vmId, project.id, branch);
        }
        step("Starting OpenCode");
        await hub.fleet.opencode(vmId, detail);
        traffic.record({ kind: "system", operation: `OpenCode worktree for ${project.title}`, vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
        send({
          ready: {
            path: `${openCodePrefix}${project.id}/w/${vmId}/${worktree.name}`,
            password,
            projectId: project.id,
            project: project.title,
            vmId,
            vm: store.vm(vmId)?.name ?? vmId,
            name: worktree.name,
            directory: worktree.path,
            branch: worktree.branch,
            base: worktree.base,
          },
        });
      } catch (error) {
        traffic.record({ kind: "system", operation: `OpenCode worktree: ${message(error)}`, vmId, status: "error" });
        send({ error: message(error) });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/** Removes a worktree `launch` made. Answers `{ removed }`: false when it holds work, or an agent may be using it. */
async function finish({ store, hub, traffic }: Deps, request: Request) {
  const body = (await request.json().catch(() => null)) as { projectId?: unknown; vmId?: unknown; name?: unknown } | null;
  const { projectId, vmId, name } = body ?? {};
  if (typeof projectId !== "string" || typeof vmId !== "string" || typeof name !== "string" || !store.project(projectId)) {
    return Response.json({ error: "No such worktree." }, { status: 404 });
  }
  try {
    const removed = await hub.fleet.removeWorktree(vmId, projectId, name);
    traffic.record({ kind: "system", operation: `OpenCode worktree ${name} ${removed ? "removed" : "kept"}`, vmId, status: "ok" });
    return Response.json({ removed });
  } catch (error) {
    traffic.record({ kind: "system", operation: `Removing OpenCode worktree ${name}: ${message(error)}`, vmId, status: "error" });
    return Response.json({ removed: false });
  }
}
