// A section in OpenCode's sidebar naming where a `vmbridge opencode` session runs: the repository, the branch its
// worktree is on now and how far it is from its base, that branch's pull request with its checks and review, the VM and
// whether it sleeps, and links to dev servers started in the worktree. It is an OpenCode 2 terminal plugin, which
// `vmbridge opencode` passes to the app it starts, so the user's own OpenCode setup is left as it is.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@vmbridge/server";

export interface SidebarOptions {
  repository: string;
  /** The repository's page, which clicking its name opens, when it is on GitHub. */
  repositoryUrl: string | null;
  vm: string;
  /** Where VM Bridge answers the worktree's status, under the session's OpenCode address. Dev servers are next to it. */
  status: string;
}

/**
 * The plugin, written out for OpenCode to load. What it shows comes from VM Bridge, asked with the password the app
 * already signs in with: at the start, when the session's state changes and every minute, so a switch an agent made, a
 * pull request opened later and a VM that fell asleep show up. Without the options `vmbridge opencode` passes it draws
 * nothing. It is JavaScript in a string, with no backticks or interpolation, so it is written out as it reads here.
 */
const plugin = `import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"

const opener = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler"] : ["xdg-open"]

function openUrl(url) {
  try {
    Bun.spawn([...opener, url], { stdio: ["ignore", "ignore", "ignore"] })
  } catch {}
}

/** A line that opens url when clicked, brighter under the mouse. */
function Link(props) {
  const [hovered, setHovered] = createSignal(false)
  return (
    <box onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)} onMouseUp={() => openUrl(props.url)}>
      <text fg={hovered() ? props.theme.text.base : props.theme.text.muted}>{props.children}</text>
    </box>
  )
}

const feedback = (theme, kind) => (kind ? theme.text.feedback[kind].base : theme.text.muted)
const stateColor = { open: "success", merged: "info", closed: "error" }
const checksColor = { passing: "success", failing: "error", running: "warning" }
const reviewColor = { approved: "success", "changes requested": "error", "review required": "warning" }

function syncText(sync) {
  if (!sync.ahead && !sync.behind) return "Up to date with " + sync.base
  if (!sync.behind) return sync.ahead + " ahead of " + sync.base
  if (!sync.ahead) return sync.behind + " behind " + sync.base
  return sync.ahead + " ahead, " + sync.behind + " behind " + sync.base
}

const vmNote = { sleeping: "Asleep, a prompt wakes it", starting: "Waking up", provisioning: "Waking up" }

/**
 * Dev servers on the VM, each served on this computer through VM Bridge, which holds the provider's credentials for
 * the port. Each gets its own local port, the VM's when it is free, so the app's own paths and its live reload work.
 */
const [served, setServed] = createSignal({})
const forwarders = new Map()

function serve(target, port) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const url = new URL(request.url)
      const to = new URL(target + url.pathname + url.search)
      to.searchParams.set("auth_token", token)
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = request.headers.get("sec-websocket-protocol")
        const chosen = protocols?.split(",")[0].trim()
        to.protocol = to.protocol === "https:" ? "wss:" : "ws:"
        const upgraded = server.upgrade(request, { data: { to: to.toString(), protocols }, headers: chosen ? { "sec-websocket-protocol": chosen } : {} })
        return upgraded ? undefined : new Response("Send a WebSocket upgrade.", { status: 400 })
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body
      return fetch(to, { method: request.method, headers, body, duplex: "half", redirect: "manual" })
        .catch(() => new Response("VM Bridge did not answer.", { status: 502 }))
    },
    websocket: {
      open(socket) {
        const upstream = new WebSocket(socket.data.to, { headers: socket.data.protocols ? { "x-vmbridge-protocols": socket.data.protocols } : {} })
        upstream.binaryType = "arraybuffer"
        socket.data.upstream = upstream
        socket.data.early = []
        upstream.addEventListener("open", () => {
          for (const message of socket.data.early.splice(0)) upstream.send(message)
        })
        upstream.addEventListener("message", (event) => socket.send(event.data))
        upstream.addEventListener("close", (event) => socket.close(event.code === 1000 || (event.code >= 3000 && event.code < 5000) ? event.code : 1011))
        upstream.addEventListener("error", () => socket.close(1011))
      },
      message(socket, message) {
        const upstream = socket.data.upstream
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message)
        else socket.data.early.push(message)
      },
      close(socket) {
        socket.data.upstream?.close()
      },
    },
  })
}

function forward(base, ports) {
  const wanted = new Set(ports)
  for (const [port, server] of forwarders) {
    if (wanted.has(port)) continue
    server.stop(true)
    forwarders.delete(port)
  }
  for (const port of wanted) {
    if (forwarders.has(port)) continue
    const target = base + "/vmbridge/port/" + port
    let server
    try {
      server = serve(target, port)
    } catch {
      try {
        server = serve(target, 0)
      } catch {
        continue
      }
    }
    forwarders.set(port, server)
  }
  setServed(Object.fromEntries([...forwarders].map(([port, server]) => [port, server.port])))
}

const token = btoa("opencode:" + (process.env.OPENCODE_PASSWORD ?? ""))

function Section(props) {
  const { context, options } = props
  const theme = context.theme
  // OpenCode's own idea of the branch, until VM Bridge answers with what git on the VM says.
  const openCodeBranch = createMemo(() => {
    const location = context.data.session.get(props.sessionID)?.location ?? context.location
    return location ? context.data.location.vcs.info(location)?.branch.current : undefined
  })
  const sessionStatus = createMemo(() => context.data.session.status(props.sessionID)?.type)
  const [status, setStatus] = createSignal(null)
  const branch = () => status()?.branch ?? openCodeBranch()
  const pullRequest = () => status()?.pullRequest ?? null
  const base = options.status.slice(0, -"/vmbridge/status".length)
  let timer
  const look = async () => {
    try {
      const response = await fetch(options.status, { headers: { authorization: "Basic " + token }, signal: AbortSignal.timeout(40_000) })
      if (response.ok) {
        const answer = await response.json()
        setStatus(answer)
        forward(base, answer.ports ?? [])
      }
    } catch {}
    clearTimeout(timer)
    // A waking VM is worth another look soon. Otherwise the minute's look catches what turns did not.
    timer = setTimeout(() => void look(), vmNote[status()?.vm] === "Waking up" ? 5_000 : 60_000)
  }
  // An agent switches branches and starts dev servers during a turn, and a prompt wakes a sleeping VM, so each change
  // of the session's state is worth a look, as is a branch change OpenCode noticed. This also looks once at the start.
  createEffect(on(sessionStatus, (now, before) => {
    if (before !== undefined && now !== before) void look()
  }))
  createEffect(on(openCodeBranch, () => void look()))
  onCleanup(() => clearTimeout(timer))

  const reviewParts = () => {
    const pull = pullRequest()
    return pull ? [pull.checks && { text: "checks " + pull.checks, kind: checksColor[pull.checks] }, pull.review && { text: pull.review, kind: reviewColor[pull.review] }].filter(Boolean) : []
  }

  return (
    <box>
      <text fg={theme.text.base}><b>VM Bridge</b></text>
      {options.repositoryUrl
        ? <Link theme={theme} url={options.repositoryUrl}>{options.repository}</Link>
        : <text fg={theme.text.muted}>{options.repository}</text>}
      <Show when={branch()}>
        <text fg={theme.text.muted}>⎇ {branch()}</text>
      </Show>
      <Show when={status()?.sync}>
        <text fg={theme.text.muted}>{syncText(status().sync)}</text>
      </Show>
      <Show when={pullRequest()}>
        <Link theme={theme} url={pullRequest().url}>
          PR #{pullRequest().number} <span fg={feedback(theme, stateColor[pullRequest().state])}>{pullRequest().state}</span>
        </Link>
        <Show when={reviewParts().length > 0}>
          <Link theme={theme} url={pullRequest().url + "/checks"}>
            <For each={reviewParts()}>
              {(part, index) => <span fg={feedback(theme, part.kind)}>{(index() ? ", " : "") + part.text}</span>}
            </For>
          </Link>
        </Show>
      </Show>
      <text fg={theme.text.muted}>{options.vm}</text>
      <Show when={vmNote[status()?.vm]}>
        <text fg={theme.text.feedback.warning.base}>{vmNote[status()?.vm]}</text>
      </Show>
      <For each={(status()?.ports ?? []).filter((port) => served()[port])}>
        {(port) => <Link theme={theme} url={"http://localhost:" + served()[port]}>localhost:{served()[port]}</Link>}
      </For>
    </box>
  )
}

export default Plugin.define({
  id: "vmbridge.sidebar",
  setup(context) {
    const options = context.options
    if (typeof options.repository !== "string" || typeof options.vm !== "string" || typeof options.status !== "string") return
    context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => <Section context={context} options={options} sessionID={props.sessionID} />,
    })
  },
})
`;

/** The plugins in the user's own `cli.json`, where OpenCode 2 keeps its terminal plugins. */
function ownPlugins(): unknown[] {
  const folder = process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  try {
    const config = Bun.JSONC.parse(readFileSync(join(folder, "cli.json"), "utf8")) as { plugins?: unknown } | null;
    return Array.isArray(config?.plugins) ? config.plugins : [];
  } catch {
    return [];
  }
}

/**
 * The value for `OPENCODE_CLI_CONFIG_CONTENT`, which OpenCode lays over `cli.json`. A list given there replaces the
 * file's, so the user's own plugins come first in it, then this one.
 */
export function sidebarConfig(options: SidebarOptions) {
  const folder = join(dataDir(), "opencode-sidebar");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tui.tsx"), plugin);
  return JSON.stringify({ plugins: [...ownPlugins(), { package: folder, options }] });
}
