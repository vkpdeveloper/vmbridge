"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";

/* A pretend zsh session running the real VM Bridge CLI. Every vmbridge string below is copied from apps/cli. */

const version = "1.1.14";
const defaultPort = 3774;
const home = "/Users/you";
const dataDir = `${home}/.vmbridge`;
const servicePid = 48213;

const help = `VM Bridge ${version}

Usage:
  vmbridge [run] [--host 0.0.0.0] [--port ${defaultPort}]   Start VM Bridge in this terminal
  vmbridge stop                                     Stop VM Bridge, including the background service
  vmbridge service install [--host] [--port]        Run VM Bridge in the background at login
  vmbridge service uninstall                        Remove the background service
  vmbridge password                                 Set a new dashboard password

The password can also come from VMBRIDGE_PASSWORD. Data lives in ${dataDir}.`;

/** Directories relative to home. Names without an entry here are files. */
const tree: Record<string, string[]> = {
  "": ["Desktop", "Documents", "Downloads", "vmbridge"],
  Desktop: [],
  Documents: [],
  Downloads: [],
  vmbridge: ["README.md", "apps", "bun.lock", "dist", "docs", "package.json", "packages"],
  "vmbridge/apps": ["cli", "landing", "server", "web"],
  "vmbridge/apps/cli": [],
  "vmbridge/apps/landing": [],
  "vmbridge/apps/server": [],
  "vmbridge/apps/web": [],
  "vmbridge/dist": ["vmbridge"],
  "vmbridge/docs": ["PROVIDERS.md", "TASKS.md"],
  "vmbridge/packages": ["contracts"],
  "vmbridge/packages/contracts": [],
};

const commands = ["cd", "clear", "echo", "exit", "help", "ls", "pwd", "vmbridge", "which", "whoami"];

const shellHelp = `Try one of these:
  vmbridge                    Start VM Bridge
  vmbridge --help             Every command
  vmbridge service install    Keep it running in the background
  clear                       Clear the screen`;

const goodbye = `
Saving session...
...copying shared history...
...saving history...truncating history files...
...completed.

[Process completed]`;

function lastLogin() {
  const date = new Date(Date.now() - 42 * 60_000);
  const part = (options: Intl.DateTimeFormatOptions) => date.toLocaleString("en-US", options);
  const time = date.toLocaleTimeString("en-GB", { hour12: false });
  return `Last login: ${part({ weekday: "short" })} ${part({ month: "short" })} ${date.getDate()} ${time} on ttys002`;
}

function addresses(host: string, port: number) {
  const list: [string, string][] = [["This machine", `http://127.0.0.1:${port}`]];
  if (host === "0.0.0.0" || host === "::") {
    list.push(
      ["Local network (en0)", `http://192.168.1.20:${port}`],
      ["Tailscale IP", `http://100.101.102.103:${port}`],
      ["Tailscale name", `http://your-mac.your-tailnet.ts.net:${port}`],
    );
  }
  return list.map(([label, url]) => `  ${label.padEnd(20)} ${url}/dashboard`);
}

/** Resolves `target` against `cwd`, both relative to home. Null when it leaves home. */
function resolve(cwd: string, target: string): string | null {
  const parts = target === "~" || target.startsWith("~/") ? [] : cwd.split("/").filter(Boolean);
  for (const part of target.replace(/^~\/?/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Lays names out like `ls -C`: down each column first, as many columns as the terminal fits. */
function columns(names: string[], cols: number) {
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const rows = Math.ceil(names.length / Math.max(1, Math.floor((cols + 2) / width)));
  return Array.from({ length: rows }, (_, row) =>
    names
      .filter((_, i) => i % rows === row)
      .map((name) => name.padEnd(width))
      .join("")
      .trimEnd(),
  ).join("\n");
}

const commonPrefix = (words: string[]) => words.reduce((prefix, word) => {
  let i = 0;
  while (i < prefix.length && prefix[i] === word[i]) i++;
  return prefix.slice(0, i);
});

interface Prompt {
  cwd: string;
  ok: boolean;
}
interface Line {
  id: number;
  text: string;
  prompt?: Prompt;
}
/** prompt: zsh waits for a command. secret: a password prompt with echo off. running: VM Bridge in the foreground. busy: a command is working. */
type Mode = "prompt" | "secret" | "running" | "busy" | "closed";

interface View {
  lines: Line[];
  mode: Mode;
  question: string;
  input: string;
  caret: number;
  ok: boolean;
  cwd: string;
  completions: string[];
}

const maxLines = 400;
type Timer = ReturnType<typeof setTimeout>;

/** The session lives outside React so timers never read stale state. The component subscribes to `view`. */
class Shell {
  view: View = { lines: [{ id: 0, text: "" }], mode: "prompt", question: "", input: "", caret: 0, ok: true, cwd: "", completions: [] };
  instant = false;
  /** Terminal width in characters, measured by the component. */
  cols = 80;
  private listeners = new Set<() => void>();
  private nextId = 1;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = "";
  private keySet = false;
  private serviceRunning = false;
  private onSecret: ((value: string) => void) | null = null;
  /** True while a chip is driving the session, so key prompts get answered for the visitor. */
  private autoSecret = false;
  private jobs: Timer[] = [];
  private typing: Timer[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.view;

  private set(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private print(...texts: string[]) {
    const added = texts.flatMap((text) => text.split("\n")).map((text) => ({ id: this.nextId++, text }));
    this.set({ lines: [...this.view.lines, ...added].slice(-maxLines) });
  }

  private after(ms: number, run: () => void) {
    this.jobs.push(setTimeout(run, this.instant ? 0 : ms));
  }

  private finish(code: number) {
    this.autoSecret = false;
    this.set({ mode: "prompt", ok: code === 0 });
  }

  private fail(message: string, code = 1) {
    this.print(message);
    this.finish(code);
  }

  private stopTimers() {
    this.jobs.splice(0).forEach(clearTimeout);
    this.typing.splice(0).forEach(clearTimeout);
  }

  start() {
    this.stopTimers();
    this.onSecret = null;
    this.autoSecret = false;
    this.set({ lines: [{ id: this.nextId++, text: lastLogin() }], mode: "prompt", input: "", caret: 0, ok: true, cwd: "", completions: [] });
  }

  dispose() {
    this.stopTimers();
  }

  type(input: string, caret: number) {
    this.set({ input, caret, completions: [] });
  }

  moveCaret(caret: number) {
    if (caret !== this.view.caret) this.set({ caret });
  }

  /** Handles keys the input can't. Returns true when the browser default should be skipped. */
  key(key: string, ctrl: boolean, meta: boolean): boolean {
    this.typing.splice(0).forEach(clearTimeout);
    this.autoSecret = false;
    if (this.view.mode === "closed") {
      if (!meta) this.start();
      return !meta;
    }
    if (ctrl && key === "c") return this.interrupt(), true;
    if ((ctrl && key === "l") || (meta && key === "k")) return this.clear(), true;
    if (ctrl && key === "u") return this.type("", 0), true;
    if (key === "Enter") return this.submit(), true;
    if (key === "Tab") return this.complete(), true;
    if (key === "ArrowUp" || key === "ArrowDown") return this.recall(key === "ArrowUp" ? -1 : 1), true;
    return false;
  }

  private clear() {
    if (this.view.mode === "prompt") this.set({ lines: [], completions: [] });
  }

  private recall(step: number) {
    if (this.view.mode !== "prompt") return;
    const index = Math.min(Math.max(this.historyIndex + step, 0), this.history.length);
    if (index === this.historyIndex) return;
    if (this.historyIndex === this.history.length) this.draft = this.view.input;
    this.historyIndex = index;
    const input = index === this.history.length ? this.draft : this.history[index];
    this.type(input, input.length);
  }

  private complete() {
    const { mode, input, cwd } = this.view;
    if (mode !== "prompt") return;
    const words = input.split(" ");
    const word = words.at(-1) ?? "";
    let options: string[] = [];
    if (words.length === 1) options = commands;
    else if (words[0] === "vmbridge" && words.length === 2) options = word.startsWith("-") ? ["--help", "--host", "--port", "--version"] : ["password", "run", "service", "stop"];
    else if (words[0] === "vmbridge" && words[1] === "service" && words.length === 3) options = ["install", "uninstall"];
    else if (words[0] === "cd" || words[0] === "ls") {
      const slash = word.lastIndexOf("/");
      const base = resolve(cwd, word.slice(0, slash + 1) || ".");
      const entries = base === null ? [] : (tree[base] ?? []);
      options = entries.map((name) => word.slice(0, slash + 1) + name + (tree[base ? `${base}/${name}` : name] ? "/" : ""));
      if (words[0] === "cd") options = options.filter((name) => name.endsWith("/"));
    }
    const matches = options.filter((option) => option.startsWith(word));
    if (!matches.length) return;
    const head = words.slice(0, -1).concat("").join(" ");
    if (matches.length === 1) {
      const done = matches[0].endsWith("/") ? matches[0] : `${matches[0]} `;
      return this.type(head + done, (head + done).length);
    }
    const prefix = commonPrefix(matches);
    if (prefix.length > word.length) return this.type(head + prefix, (head + prefix).length);
    this.set({ completions: matches.map((match) => match.slice(match.lastIndexOf("/", match.length - 2) + 1)) });
  }

  interrupt() {
    const { mode, input, question, cwd, ok } = this.view;
    this.stopTimers();
    this.autoSecret = false;
    if (mode === "prompt") {
      this.set({ lines: [...this.view.lines, { id: this.nextId++, text: `${input}^C`, prompt: { cwd, ok } }], input: "", caret: 0, completions: [] });
    } else if (mode === "secret") {
      // The password prompt reads in raw mode, so ^C is not echoed. The CLI prints the error instead.
      this.onSecret = null;
      this.print(question, "Cancelled.");
      this.set({ input: "", caret: 0 });
      this.finish(1);
    } else if (mode === "running" || mode === "busy") {
      this.print(`${input}^C`);
      this.set({ input: "", caret: 0 });
      this.finish(mode === "running" ? 0 : 130);
    }
  }

  submit() {
    const { mode, input, question, cwd, ok } = this.view;
    if (mode === "busy") return; // Typeahead stays in the buffer, like a real terminal.
    if (mode === "running") {
      this.print(input);
      return this.set({ input: "", caret: 0 });
    }
    if (mode === "secret") {
      this.print(question);
      const answer = this.onSecret;
      this.onSecret = null;
      this.set({ mode: "busy", input: "", caret: 0 });
      return answer?.(input);
    }
    this.set({ lines: [...this.view.lines, { id: this.nextId++, text: input, prompt: { cwd, ok } }].slice(-maxLines), input: "", caret: 0, completions: [] });
    if (input.trim() && this.history.at(-1) !== input) this.history.push(input);
    this.historyIndex = this.history.length;
    this.draft = "";
    this.run(input.trim());
  }

  /** Types a command in for the visitor. Stops whatever is running first. */
  play(command: string) {
    this.stopTimers();
    const { mode } = this.view;
    if (mode === "closed") this.start();
    const wait = mode === "running" || mode === "busy" || mode === "secret" ? 450 : 0;
    if (wait) this.interrupt();
    if (this.view.input) this.type("", 0);
    let at = this.instant ? 0 : wait + 160;
    for (let i = 1; i <= command.length; i++) {
      if (!this.instant) at += 38 + Math.random() * 75 + (command[i - 1] === " " ? 70 : 0);
      this.typing.push(setTimeout(() => this.type(command.slice(0, i), i), at));
    }
    this.typing.push(
      setTimeout(() => {
        this.autoSecret = true;
        this.submit();
      }, this.instant ? 0 : at + 260),
    );
  }

  private ask(question: string, answer: (value: string) => void) {
    this.set({ mode: "secret", question });
    this.onSecret = answer;
    if (!this.autoSecret) return;
    // Nothing shows while a password is typed, so a pause stands in for typing it.
    this.typing.push(setTimeout(() => this.submit(), this.instant ? 0 : 900 + Math.random() * 400));
    this.set({ input: "correct-horse" });
  }

  private run(line: string) {
    if (!line) return this.finish(this.view.ok ? 0 : 1);
    const [name, ...args] = line.split(/\s+/);
    const { cwd } = this.view;
    switch (name) {
      case "vmbridge":
        return this.vmbridge(args);
      case "./dist/vmbridge":
      case "dist/vmbridge":
        if (cwd === "vmbridge") return this.vmbridge(args);
        return this.fail(`zsh: no such file or directory: ${name}`, 127);
      case "clear":
        this.set({ lines: [] });
        return this.finish(0);
      case "help":
        this.print(shellHelp);
        return this.finish(0);
      case "pwd":
        this.print(cwd ? `${home}/${cwd}` : home);
        return this.finish(0);
      case "whoami":
        this.print("you");
        return this.finish(0);
      case "echo":
        this.print(args.join(" ").replaceAll("$HOME", home).replaceAll("$USER", "you").replaceAll("$SHELL", "/bin/zsh").replace(/^["']|["']$/g, ""));
        return this.finish(0);
      case "which": {
        const target = args[0];
        if (target === "vmbridge") this.print("/usr/local/bin/vmbridge");
        else if (target && commands.includes(target)) this.print(`${target}: shell built-in command`);
        else return this.fail(`${target ?? ""} not found`);
        return this.finish(0);
      }
      case "ls": {
        const path = resolve(cwd, args.find((arg) => !arg.startsWith("-")) ?? ".");
        const entries = path === null ? undefined : tree[path];
        if (!entries) return this.fail(`ls: ${args[0]}: No such file or directory`);
        if (entries.length) this.print(columns(entries, this.cols));
        return this.finish(0);
      }
      case "cd": {
        const target = args[0] ?? "~";
        const path = resolve(cwd, target);
        if (path !== null && tree[path]) {
          this.set({ cwd: path });
          return this.finish(0);
        }
        const parent = path?.split("/").slice(0, -1).join("/") ?? "";
        const isFile = path !== null && tree[parent]?.includes(path.split("/").at(-1) ?? "");
        return this.fail(`cd: ${isFile ? "not a directory" : "no such file or directory"}: ${target}`);
      }
      case "exit":
      case "logout":
        this.print(goodbye);
        return this.set({ mode: "closed" });
      default:
        return this.fail(`zsh: command not found: ${name}`, 127);
    }
  }

  /** Mirrors main() in apps/cli/src/index.ts, including parseArgs errors. */
  private vmbridge(args: string[]) {
    const values: { host?: string; port?: string; help?: boolean; version?: boolean } = {};
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-h" || arg === "--help") values.help = true;
      else if (arg === "-v" || arg === "--version") values.version = true;
      else if (arg === "--host" || arg === "--port") {
        const value = args[++i];
        if (value === undefined) return this.fail(`Option '${arg} <value>' argument missing`);
        values[arg === "--host" ? "host" : "port"] = value;
      } else if (arg.startsWith("--host=")) values.host = arg.slice(7);
      else if (arg.startsWith("--port=")) values.port = arg.slice(7);
      else if (arg.startsWith("-")) {
        return this.fail(`Unknown option '${arg}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "${arg}"`);
      } else positionals.push(arg);
    }
    const [command = "run", subcommand] = positionals;
    if (values.help) return this.print(help), this.finish(0);
    if (values.version) return this.print(version), this.finish(0);

    const options = () => {
      const port = values.port === undefined ? defaultPort : Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
      return { host: values.host ?? "0.0.0.0", port };
    };
    const badPort = "--port must be a port number.";

    switch (command) {
      case "run": {
        const server = options();
        if (!server) return this.fail(badPort);
        if (this.serviceRunning) return this.fail(`VM Bridge is already running (process ${servicePid}). Stop it with \`vmbridge stop\`.`);
        return this.ensureKey(false, () => {
          this.set({ mode: "busy" });
          this.after(420, () => {
            this.print(
              `VM Bridge ${version} is running.`,
              "",
              ...addresses(server.host, server.port),
              "",
              "  Turn on Tailscale HTTPS in the dashboard settings for an https:// address.",
              "",
              "Open the dashboard to set up providers and pair devices. Press Ctrl+C to stop.",
            );
            this.autoSecret = false;
            this.set({ mode: "running" });
          });
        });
      }
      case "stop":
        if (!this.serviceRunning) return this.fail("VM Bridge is not running.", 0);
        this.set({ mode: "busy" });
        return this.after(650, () => {
          this.serviceRunning = false;
          this.print("VM Bridge stopped.", "The background service starts again at next login, or now with `vmbridge service install`.");
          this.finish(0);
        });
      case "password":
        return this.ensureKey(true, () => this.finish(0));
      case "service":
        if (subcommand === "install") {
          return this.ensureKey(false, () => {
            if (this.serviceRunning) return this.fail(`VM Bridge is already running in a terminal (process ${servicePid}). Stop it first.`);
            const server = options();
            if (!server) return this.fail(badPort);
            this.set({ mode: "busy" });
            this.after(800, () => {
              this.serviceRunning = true;
              this.print(`VM Bridge now runs in the background on port ${server.port}. Logs: ${dataDir}/vmbridge.log`);
              this.finish(0);
            });
          });
        }
        if (subcommand === "uninstall") {
          this.set({ mode: "busy" });
          return this.after(500, () => {
            this.serviceRunning = false;
            this.print("Background service removed.");
            this.finish(0);
          });
        }
        return this.fail("Use `vmbridge service install` or `vmbridge service uninstall`.");
      default:
        this.print(help);
        return this.finish(1);
    }
  }

  private ensureKey(force: boolean, then: () => void) {
    if (this.keySet && !force) return then();
    this.chooseKey(() => {
      this.keySet = true;
      this.print("Password saved.");
      then();
    });
  }

  private chooseKey(done: () => void) {
    this.ask("Choose a dashboard password (at least 8 characters): ", (key) => {
      if (key.length < 8) {
        this.print("Too short.");
        return this.chooseKey(done);
      }
      this.ask("Type it again: ", (again) => {
        if (again === key) return done();
        this.print("The passwords did not match.");
        this.chooseKey(done);
      });
    });
  }
}

/** oh-my-zsh's robbyrussell layout, in the site's colors. */
function PromptText({ cwd, ok }: Prompt) {
  const name = cwd ? cwd.split("/").at(-1) : "~";
  return (
    <>
      <span className={ok ? "text-success" : "text-[#ff6159]"}>➜</span>
      {"  "}
      <span className="text-primary">{name}</span>
      {cwd.startsWith("vmbridge") ? (
        <>
          {" "}
          <span className="text-faint">git:(</span>
          <span className="text-warning">main</span>
          <span className="text-faint">)</span>
        </>
      ) : null}{" "}
    </>
  );
}

function Cursor({ text, caret, focused }: { text: string; caret: number; focused: boolean }) {
  return (
    <>
      {text.slice(0, caret)}
      <span className={focused ? "bg-foreground text-black" : "shadow-[inset_0_0_0_1px_var(--faint)]"}>{text[caret] ?? " "}</span>
      {text.slice(caret + 1)}
    </>
  );
}

/** Output in muted gray, with addresses picked out. */
function Output({ text }: { text: string }) {
  return (
    <span className="text-muted-foreground">
      {text.split(/(https?:\/\/\S+)/).map((part, i) => (i % 2 ? <span key={i} className="text-foreground">{part}</span> : part))}
    </span>
  );
}

const chips = ["vmbridge", "vmbridge service install", "vmbridge stop", "vmbridge --help"];

export function Terminal() {
  const [shell] = useState(() => new Shell());
  const view = useSyncExternalStore(shell.subscribe, shell.getSnapshot, shell.getSnapshot);
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const section = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const inView = useInView(section, "-25% 0px");
  const played = useRef(false);
  const cell = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    shell.start();
    return () => shell.dispose();
  }, [shell]);

  useEffect(() => {
    shell.instant = reduced;
  }, [shell, reduced]);

  // ls and completion lists fit the visible width, like a real terminal.
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const width = (cell.current?.offsetWidth ?? 0) / 10;
      if (width) shell.cols = Math.floor((element.clientWidth - 32) / width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shell]);

  // The first time the section shows, run VM Bridge like a new user would.
  useEffect(() => {
    if (!inView || played.current) return;
    played.current = true;
    shell.play("vmbridge");
  }, [inView, shell]);

  // New output keeps the newest line in view, inside the terminal only.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [view]);

  const { lines, mode, question, input: text, caret, cwd, ok, completions } = view;
  const name = cwd ? cwd.split("/").at(-1) : "~";

  return (
    <section ref={section} className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-6">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Runs on your Mac or Linux box</h2>
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => shell.play(chip)}
                className="rounded-full border px-3 py-1 font-mono text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        <div
          className="relative min-w-0 overflow-hidden rounded-xl border bg-[#050505] shadow-[0_40px_120px_-30px_rgba(139,92,246,0.35)]"
          onClick={() => {
            if (!window.getSelection()?.toString()) input.current?.focus({ preventScroll: true });
          }}
        >
          <div className="relative flex h-9 items-center border-b bg-card px-3.5">
            <div className="flex gap-2">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
            <div
              className={`absolute inset-x-20 truncate text-center text-xs transition-colors ${focused ? "text-muted-foreground" : "text-faint"}`}
            >
              {name} ({mode === "running" ? "vmbridge" : "zsh"})
            </div>
          </div>

          <div
            ref={body}
            className="h-[340px] cursor-text overflow-x-hidden overflow-y-auto px-4 py-3 font-mono text-[12px] leading-5 text-foreground [scrollbar-width:none] sm:h-[420px] sm:text-[13px] [&::-webkit-scrollbar]:hidden"
          >
            <span ref={cell} aria-hidden className="invisible absolute whitespace-pre">
              0000000000
            </span>
            {lines.map((line) => (
              <div key={line.id} className="min-h-5 break-all whitespace-pre-wrap">
                {line.prompt ? (
                  <>
                    <PromptText {...line.prompt} />
                    {line.text}
                  </>
                ) : (
                  <Output text={line.text} />
                )}
              </div>
            ))}
            {mode === "closed" ? null : (
              <div className="min-h-5 break-all whitespace-pre-wrap">
                {mode === "prompt" ? <PromptText cwd={cwd} ok={ok} /> : null}
                {mode === "secret" ? <Output text={question} /> : null}
                <Cursor text={mode === "secret" ? "" : text} caret={mode === "secret" ? 0 : caret} focused={focused} />
              </div>
            )}
            {completions.length ? <div className="break-all whitespace-pre-wrap text-muted-foreground">{columns(completions, shell.cols)}</div> : null}
          </div>

          <input
            ref={input}
            value={text}
            aria-label="Terminal"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="pointer-events-none absolute top-0 left-0 size-px text-base opacity-0"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => shell.type(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onSelect={(event) => shell.moveCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (shell.key(event.key, event.ctrlKey, event.metaKey)) event.preventDefault();
            }}
          />
        </div>
      </div>
    </section>
  );
}
