// A section in OpenCode's sidebar naming where a `vmbridge opencode` session runs: the repository, the branch its
// worktree is on now, and the VM. It is an OpenCode 2 terminal plugin, which `vmbridge opencode` passes to the app it
// starts, so the user's own OpenCode setup is left as it is.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@vmbridge/server";

/**
 * The plugin, written out for OpenCode to load. The branch comes from OpenCode's own git info for the session's folder,
 * so it follows an agent that switches branches. Without the options `vmbridge opencode` passes it draws nothing.
 */
const plugin = `import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "vmbridge.sidebar",
  setup(context) {
    const { repository, vm } = context.options
    if (typeof repository !== "string" || typeof vm !== "string") return
    context.ui.slot({
      prepend: "sidebar.content",
      render: ({ sessionID }) => {
        const branch = () => {
          const location = context.data.session.get(sessionID)?.location ?? context.location
          return location ? context.data.location.vcs.info(location)?.branch.current : undefined
        }
        return (
          <box>
            <text fg={context.theme.text.base}><b>VM Bridge</b></text>
            <text fg={context.theme.text.muted}>{repository}</text>
            {branch() ? <text fg={context.theme.text.muted}>⎇ {branch()}</text> : null}
            <text fg={context.theme.text.muted}>{vm}</text>
          </box>
        )
      },
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
export function sidebarConfig(options: { repository: string; vm: string }) {
  const folder = join(dataDir(), "opencode-sidebar");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tui.tsx"), plugin);
  return JSON.stringify({ plugins: [...ownPlugins(), { package: folder, options }] });
}
