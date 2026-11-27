// `vmbridge opencode`: from a local repository to OpenCode running in a fresh worktree on one of its project's VMs.
import type { OpenCodeLaunchEvent, OpenCodeWorktrees } from "@vmbridge/contracts";
import { newToken } from "../auth/tokens.ts";
import { message } from "../fleet.ts";
import { fetchPullRequest } from "../github.ts";
import type { Store } from "../store.ts";
import type { Traffic } from "../traffic.ts";
import { NoOpenCodeKey } from "../vm/opencode.ts";
import type { Clones } from "./clones.ts";
import type { Hub } from "./hub.ts";
import { githubName } from "./repos.ts";
import { openCodePrefix } from "./opencode.ts";

/** A branch as the clone flow takes one. */
const branchName = (branch: string) => /^[\w./-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..");

type Deps = { store: Store; hub: Hub; clones: Clones; traffic: Traffic; hasKey: () => boolean; githubToken: () => string | undefined };

/**
 * `/api/vmbridge/opencode`. POST starts OpenCode in a new worktree, or one made before (see `launch`). DELETE, sent when
 * the terminal app closes, removes that worktree unless it holds work. GET lists a repository's worktrees.
 */
export function openCodeLauncher(deps: Deps) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET") return await list(deps, request);
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
        let sessionId: string | null = null;
        if (resume) {
          // Where VM Bridge noted it, so only that VM wakes. Worktrees from before it noted them are looked for.
          const noted = store.openCodeWorktrees(project.id).find((row) => row.name === resume);
          step(`Opening ${noted?.branch ?? resume}`);
          const found = await hub.fleet.findWorktree(project.id, resume, step, detail, noted?.vmId).catch((error: unknown) => {
            if (noted) store.removeOpenCodeWorktree(project.id, resume);
            throw error;
          });
          vmId = found.vmId;
          worktree = { ...found, name: resume, base: noted?.base ?? null };
          sessionId = noted?.sessionId ?? null;
          if (noted) {
            store.touchOpenCodeWorktree(project.id, resume);
            store.setOpenCodeWorktreeBranch(project.id, resume, found.branch);
          } else store.addOpenCodeWorktree({ projectId: project.id, vmId, name: resume, branch: found.branch, base: null });
        } else {
          step(`Finding a VM for ${project.title}`);
          const placement = await hub.placeOpenCode(project.id, step, detail);
          vmId = placement.vmId;
          if (placement.notice) send({ notice: placement.notice });
          step("Making a worktree");
          worktree = await hub.fleet.worktree(vmId, project.id, branch);
          store.addOpenCodeWorktree({ projectId: project.id, vmId, ...worktree });
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
            sessionId,
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

/**
 * Removes a worktree `launch` made. Answers `{ removed, branch }`: removed is false when it holds work, or an agent may be
 * using it, and branch is the one a kept worktree is on when its VM said.
 */
async function finish({ store, hub, traffic }: Deps, request: Request) {
  const body = (await request.json().catch(() => null)) as { projectId?: unknown; vmId?: unknown; name?: unknown } | null;
  const { projectId, vmId, name } = body ?? {};
  if (typeof projectId !== "string" || typeof vmId !== "string" || typeof name !== "string" || !store.project(projectId)) {
    return Response.json({ error: "No such worktree." }, { status: 404 });
  }
  try {
    const { removed, branch } = await hub.fleet.removeWorktree(vmId, projectId, name);
    if (removed) store.removeOpenCodeWorktree(projectId, name);
    else {
      store.touchOpenCodeWorktree(projectId, name);
      if (branch) store.setOpenCodeWorktreeBranch(projectId, name, branch);
    }
    traffic.record({ kind: "system", operation: `OpenCode worktree ${name} ${removed ? "removed" : "kept"}`, vmId, status: "ok" });
    return Response.json({ removed, branch: branch ?? null });
  } catch (error) {
    traffic.record({ kind: "system", operation: `Removing OpenCode worktree ${name}: ${message(error)}`, vmId, status: "error" });
    return Response.json({ removed: false });
  }
}

/**
 * The worktrees of the repository at `?remote=` that are still on its VMs, from what VM Bridge noted, waking none. Each
 * comes with its branch's pull request when the repository is on GitHub.
 */
async function list({ store, clones, githubToken }: Deps, request: Request) {
  const remote = new URL(request.url).searchParams.get("remote") ?? "";
  let project: ReturnType<Clones["find"]> = null;
  try {
    project = clones.find(remote);
  } catch {
    // Not a remote VM Bridge can clone, so it has no project.
  }
  const github = project ? githubName(project.url) : undefined;
  const token = githubToken();
  const answer: OpenCodeWorktrees = {
    project: project?.title ?? null,
    worktrees: await Promise.all((project ? store.openCodeWorktrees(project.id) : []).map(async (row) => {
      const vm = store.vm(row.vmId);
      return {
        name: row.name,
        branch: row.branch,
        base: row.base,
        vm: vm?.name ?? row.vmId,
        asleep: vm?.state !== "ready" && vm?.state !== "busy",
        pullRequest: github && row.branch !== "HEAD" ? await fetchPullRequest(github, row.branch, token) : null,
        lastPrompt: row.lastPrompt,
        createdAt: new Date(row.createdAt).toISOString(),
        lastUsedAt: new Date(row.lastUsedAt).toISOString(),
      };
    })),
  };
  return Response.json(answer);
}
