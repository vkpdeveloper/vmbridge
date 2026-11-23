import { ArrowDown01Icon, ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { Footer, Nav } from "@/components/Chrome";
import { ProviderLogo } from "@/components/brand";
import { Command, CopyButton } from "@/components/CopyButton";
import { type DocsGroup, DocsNav } from "@/components/DocsNav";
import { Topology } from "@/components/Topology";
import { copy } from "@/lib/copy";
import { commands, github, install, providers } from "@/lib/data";
import { openGraph, site } from "@/lib/site";
import { innerPad, primaryButton, railShell, secondaryButton } from "@/lib/styles";

const title = "VM Bridge docs: install, providers, sleep and wake";
const description =
  "Install VM Bridge on macOS or Linux, add a cloud provider and pair T3 Code. How VMs sleep and wake, where your data lives, and fixes for common problems.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/docs" },
  openGraph: { ...openGraph, url: "/docs", title, description },
};

const groups: DocsGroup[] = [
  {
    label: "Start",
    sections: [
      { id: "overview", title: "Overview" },
      { id: "install", title: "Install" },
      { id: "run", title: "Run" },
      { id: "setup", title: "Set up the dashboard" },
      { id: "pair", title: "Pair T3 Code" },
    ],
  },
  {
    label: "How it works",
    sections: [
      { id: "flow", title: "How a request flows" },
      { id: "sleep", title: "Sleep and wake" },
      { id: "providers", title: "Providers" },
    ],
  },
  {
    label: "Agents",
    sections: [
      { id: "sign-in", title: "Agent sign-ins and GitHub" },
      { id: "env", title: "Environment variables" },
      { id: "skills", title: "Skills" },
      { id: "instructions", title: "AGENTS.md" },
    ],
  },
  {
    label: "Network",
    sections: [
      { id: "network", title: "Addresses and Tailscale" },
      { id: "cloudflare", title: "Cloudflare Tunnel" },
    ],
  },
  {
    label: "Security",
    sections: [
      { id: "security", title: "Data and security" },
      { id: "encryption", title: "Encryption" },
    ],
  },
  {
    label: "Help",
    sections: [
      { id: "troubleshooting", title: "Troubleshooting" },
      { id: "develop", title: "Develop" },
    ],
  },
];

const numbers = new Map(groups.flatMap((g) => g.sections).map((s, i) => [s.id, String(i + 1).padStart(2, "0")]));

/**
 * One docs section on the plane, separated from the next by a hairline that spans
 * the content column. From xl the number and heading stick on the left while the
 * text runs on the right, the same split as the landing sections.
 */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className={`scroll-mt-14 ${innerPad} py-12 lg:py-14 xl:grid xl:grid-cols-[minmax(0,15rem)_minmax(0,46rem)] xl:items-start xl:gap-x-12`}>
      <div className="xl:sticky xl:top-24">
        <div className="font-mono text-[13px] text-primary">{numbers.get(id)}</div>
        <h2 className="title mt-3 xl:text-[1.75rem]">
          <a href={`#${id}`} className="transition-colors duration-150 hover:text-foreground/80">
            {title}
          </a>
        </h2>
      </div>
      <div className="mt-6 min-w-0 space-y-4 leading-7 text-pretty text-muted-foreground xl:mt-1 [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>;
}

function Block({ children }: { children: string }) {
  return (
    <div className="relative rounded-md bg-card">
      {/* Long lines wrap rather than scroll sideways; the copy button still copies the exact text. */}
      <pre className="p-4 pr-12 font-mono text-[13px] leading-6 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{children}</pre>
      <CopyButton text={children} className="absolute top-2 right-2" />
    </div>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden className="mt-[13px] h-px w-2.5 shrink-0 bg-white/30" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * From sm a plain table. Below sm each row stacks into a block, the first cell as its
 * title and every other cell under its column name, so a phone never scrolls sideways.
 * The wrapper still scrolls as a quiet fallback if a wide row ever outgrows the column.
 */
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="scrollbar-quiet overflow-x-auto rounded-md border border-white/10">
      <table className="w-full text-left text-sm max-sm:block sm:min-w-[560px]">
        <thead className="bg-card max-sm:hidden">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="px-4 py-2.5 font-mono text-[12px] font-normal text-faint">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10 max-sm:block">
          {rows.map((row, i) => (
            <tr key={i} className="max-sm:block max-sm:px-4 max-sm:py-3">
              {row.map((cell, j) => (
                <td
                  key={j}
                  data-label={head[j]}
                  className={`px-4 py-2.5 align-top max-sm:block max-sm:p-0 ${j === 0 ? "text-foreground" : "max-sm:mt-2 max-sm:before:block max-sm:before:font-mono max-sm:before:text-[12px] max-sm:before:text-faint max-sm:before:content-[attr(data-label)]"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Docs() {
  return (
    <>
      <Nav />
      <div className={railShell}>
        <header className={`${innerPad} py-14 lg:py-20 xl:grid xl:grid-cols-12 xl:items-end xl:gap-x-16`}>
          <div className="xl:col-span-6 motion-safe:animate-[rise_600ms_cubic-bezier(0.22,1,0.36,1)_backwards]">
            <div className="font-mono text-[13px] text-faint">
              {copy.docs.eyebrow} <span className="text-white/20">/</span> v{site.version}
            </div>
            <h1 className="display mt-4">{copy.docs.title}</h1>
            <p className="mt-4 max-w-[36rem] text-pretty text-[17px] text-muted-foreground">{copy.docs.body}</p>
          </div>
          <div className="mt-8 min-w-0 xl:col-span-6 xl:mt-0 motion-safe:animate-[rise_600ms_cubic-bezier(0.22,1,0.36,1)_80ms_backwards]">
            <Command text={install} />
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/faq" className={`${primaryButton} group`}>
                {copy.docs.faq}
                <HugeiconsIcon icon={ArrowRight01Icon} size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
              <a href={github} className={secondaryButton}>
                <HugeiconsIcon icon={GithubIcon} size={15} />
                {copy.nav.github}
              </a>
            </div>
          </div>
        </header>

        <div className="border-t border-white/10 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="hidden border-r border-white/10 lg:block">
            <div className="scrollbar-quiet sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-6 py-10">
              <DocsNav groups={groups} />
            </div>
          </aside>

          <main className="min-w-0 divide-y divide-white/10">
            <details className={`group/toc ${innerPad} py-4 lg:hidden`}>
              <summary className="flex cursor-pointer list-none items-center justify-between font-mono text-[13px] text-muted-foreground [&::-webkit-details-marker]:hidden">
                On this page
                <HugeiconsIcon icon={ArrowDown01Icon} size={15} className="transition-transform duration-150 group-open/toc:rotate-180" />
              </summary>
              <div className="pt-6 pb-2">
                <DocsNav groups={groups} />
              </div>
            </details>

            <Section id="overview" title="Overview">
              <p>
                VM Bridge runs <strong>T3 Code</strong> agents on cloud VMs. You pair an unchanged T3 Code app with VM Bridge once. After that, VM
                Bridge creates, wakes and sleeps VMs on your sandbox provider, and sends each project and thread to the right one.
              </p>
              <List
                items={[
                  "Each project has its own VMs. Projects never share a disk, a process list or a shell. A busy project gets more than one.",
                  "A VM sleeps after it has been idle for a set time, and wakes when you send a message.",
                  "Several providers at once: boxd, Instabox, Daytona, Boat, Railway, E2B, Freestyle and Superserve. Pick one per repository, or let new VMs use the default.",
                  "Everything is set up from a web dashboard behind one password: provider keys, GitHub, agent sign-ins and device pairing.",
                  "T3 Code needs no changes. To the app, VM Bridge looks like a single T3 server.",
                ]}
              />
            </Section>

            <Section id="install" title="Install">
              <p>
                VM Bridge runs on macOS and Linux. You need an account with one of the supported providers, and T3 Code on the devices you want to
                pair. One command installs the server, the dashboard and the command line, as one file in <Code>~/.local/bin</Code>:
              </p>
              <Block>{install}</Block>
              <p>
                Then run <Code>vmbridge</Code> and open the setup link it prints. Run the same command again to update.
              </p>
              <p>To build from source instead, with Bun 1.4.4 or newer:</p>
              <Block>{`git clone https://github.com/vkpdeveloper/vmbridge
cd vmbridge
bun install
bun run compile        # dist/vmbridge
./dist/vmbridge`}</Block>
            </Section>

            <Section id="run" title="Run">
              <Table
                head={["Command", "What it does"]}
                rows={commands.map((c) => [
                  <code key="c" className="font-mono text-[13px] sm:whitespace-nowrap">
                    {c.command}{" "}
                    {/* On phones the line wraps between options, never inside one at its hyphens. */}
                    {c.args.split(" [").map((arg, i) => (
                      <Fragment key={i}>
                        {i > 0 ? " " : null}
                        <span className="whitespace-nowrap text-faint">{i > 0 ? `[${arg}` : arg}</span>
                      </Fragment>
                    ))}
                  </code>,
                  c.does,
                ])}
              />
              <p>
                On first start, VM Bridge prints a one-time setup link for each address. It opens onboarding, where you choose a{" "}
                <strong>dashboard password</strong> of at least 8 characters. On a machine with no terminal, set <Code>VMBRIDGE_PASSWORD</Code> for the
                first start, or run <Code>vmbridge password</Code>.
              </p>
              <p>
                Data lives in <Code>~/.vmbridge</Code>. Set <Code>VMBRIDGE_HOME</Code> to move it. The background service uses launchd on macOS and
                systemd on Linux, and writes its log to <Code>~/.vmbridge/vmbridge.log</Code>.
              </p>
              <Command text="vmbridge service install --port 3774" />
            </Section>

            <Section id="setup" title="Set up the dashboard">
              <p>
                Open <Code>/dashboard</Code> on any address VM Bridge printed and log in with your password. Setup has three tabs.
              </p>
              <List
                items={[
                  <>
                    <strong>Providers.</strong> Add one or more providers and paste their keys. VM Bridge checks each key before saving it. The first one you add is the default.
                  </>,
                  <>
                    <strong>GitHub.</strong> A personal access token so agents can clone, push and open pull requests.
                  </>,
                  <>
                    <strong>Agent sign-in.</strong> Sign in to Codex with ChatGPT and to Claude with your Claude account, or add a token or an OpenCode key.
                  </>,
                ]}
              />
              <p>
                Under <strong>Settings</strong> you choose the VM size (by default the closest each provider has to 2 vCPU and 8 GB), how many
                idle minutes before a VM sleeps (5 by default), and the T3 version to install on VMs. Under <strong>Repositories</strong> you can send a repository to a given provider and VM size.
              </p>
            </Section>

            <Section id="pair" title="Pair T3 Code">
              <p>
                Under <strong>Devices</strong>, name the device and create a pairing link. In T3 Code, add a remote environment and paste the link.
              </p>
              <List
                items={[
                  "Each link works once and expires after 15 minutes.",
                  "Pairing swaps the link for a token that only that device holds. VM Bridge stores a hash of it.",
                  "Remove a device under Devices to sign it out right away.",
                ]}
              />
            </Section>

            <Section id="flow" title="How a request flows">
              <p>
                T3 Code keeps one connection to VM Bridge. VM Bridge keeps one connection to the T3 server on each awake VM, and routes each request
                by its project or thread.
              </p>
              <div className="not-prose my-6 border">
                <Topology stacked />
              </div>
              <List
                items={[
                  <>
                    <strong>Answered by the bridge.</strong> Config, the project list and threads on sleeping VMs come from VM Bridge in about 1 ms.
                  </>,
                  <>
                    <strong>Forwarded to a VM.</strong> Messages, file browsing and Git status go to the thread&apos;s VM, about 150 to 230 ms away
                    depending on the provider.
                  </>,
                  <>
                    <strong>New projects.</strong> Opening a repository creates a VM, installs Node, T3 and the agent CLIs, starts T3 and clones the
                    repository. A fresh VM is ready in 16 to 24 seconds, or about a minute on Railway.
                  </>,
                  <>
                    <strong>New threads.</strong> Each goes to one of its project&apos;s VMs with room: fewer than 2 running turns per vCPU, under 80%
                    of memory used and 3 GB of disk free. An awake VM comes first, then a sleeping one. With no room anywhere, VM Bridge adds a VM
                    like the project&apos;s first, up to 4. If the provider refuses, the thread runs on the least loaded VM and its setup says it may
                    be slow.
                  </>,
                  <>
                    <strong>Running threads stay put.</strong> A thread&apos;s worktree, branch and unpushed changes live on its VM, so it never moves.
                    Branch lists show branches from all of a project&apos;s VMs, and a new thread from a branch only one VM has starts on that VM.
                    Extra VMs sleep like any other and are never deleted on their own.
                  </>,
                ]}
              />
            </Section>

            <Section id="sleep" title="Sleep and wake">
              <p>
                A VM counts as idle when no device has used it and nothing is waiting on it: no running agent turn, queued work, pending approval
                or enabled automation. After the idle minutes you set, VM Bridge saves each thread on that VM and puts it to sleep. The threads stay
                readable in T3 Code while it sleeps.
              </p>
              <p>
                Send a message in a sleeping thread and T3 Code shows <Code>Waking the boxd VM...</Code> until the VM answers. Then the message goes
                through as usual.
              </p>
              <Table
                head={["Provider", "Sleep", "Wake", "Measured wake"]}
                rows={providers.map((p) => [
                  p.name,
                  p.sleep,
                  p.wake,
                  p.measured ? `${p.measured.wakeSeconds[0]}${p.measured.wakeSeconds[1] !== p.measured.wakeSeconds[0] ? ` to ${p.measured.wakeSeconds[1]}` : ""} s` : "Not measured yet",
                ])}
              />
              <p>
                Each provider also has its own idle or time limit as a safety net in case VM Bridge is offline. Railway has none, so VM Bridge never
                sets one there.
              </p>
            </Section>

            <Section id="providers" title="Providers">
              <div className="grid gap-2 sm:grid-cols-2">
                {providers.map((p) => (
                  <div key={p.id} className="flex items-start gap-3 rounded-md border bg-card p-3">
                    <ProviderLogo provider={p} className="size-9 rounded-md ring-white/10" />
                    <div className="min-w-0 text-sm">
                      <div className="font-medium text-foreground">{p.name}</div>
                      <div>{[...new Set(p.sizes)].join(" · ")}</div>
                      <div className="text-faint">Reached through: {p.reach}</div>
                    </div>
                  </div>
                ))}
              </div>
              <List
                items={[
                  <>
                    <strong>boxd</strong> wakes a paused VM on any traffic, so VM Bridge closes its connection before it pauses one.
                  </>,
                  <>
                    <strong>Daytona</strong> uses container sandboxes, which stop rather than pause. Files stay, and T3 starts fresh on wake.
                  </>,
                  <>
                    <strong>Boat</strong> VMs start in the Boat environment you choose.
                  </>,
                  <>
                    <strong>Railway</strong> has no pause. Sleep saves a checkpoint and removes the VM. Wake creates a new VM from it. Railway needs
                    an account or workspace API token and an environment ID.
                  </>,
                  <>
                    <strong>Instabox</strong> uses the agent-browser template.
                  </>,
                  <>
                    <strong>E2B</strong> fixes CPU and memory per template. VM Bridge builds one template per size in your account the first time
                    you use that size, which takes about 15 s.
                  </>,
                  <>
                    <strong>Freestyle</strong> and <strong>Superserve</strong> have one machine size, so small, medium and large are the same VM.
                  </>,
                ]}
              />
            </Section>

            <Section id="sign-in" title="Agent sign-ins and GitHub">
              <p>
                Agents and git sign in only with what you add in Setup, never with sign-ins from the VM provider. Each agent sign-in is a profile saved, encrypted, in{" "}
                <Code>~/.vmbridge/main.db</Code>. Each agent uses one profile at a time, and VMs get it when they start.
              </p>
              <Table
                head={["Sign-in", "Set on the VM as"]}
                rows={[
                  ["Codex, signed in with ChatGPT", "auth.json in a private CODEX_HOME"],
                  ["Claude account", <Code key="c">CLAUDE_CODE_OAUTH_TOKEN</Code>],
                  ["Claude auth token", <Code key="a">ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL</Code>],
                  ["OpenCode API key", <Code key="o">OPENCODE_API_KEY</Code>],
                  ["GitHub token", <Code key="g">GH_TOKEN, GITHUB_TOKEN</Code>],
                ]}
              />
              <p>
                Git on each VM signs in to GitHub with the token and commits as your GitHub account, using GitHub&apos;s private noreply email.
                SSH remotes such as <Code>git@github.com:you/app.git</Code> go over HTTPS with the token. The GitHub CLI, <Code>gh</Code>, is
                installed and signed in, so agents can open pull requests.
              </p>
              <p>
                VM Bridge refreshes the Codex sign-in before it expires and gives the new tokens to every awake VM, so VMs never sign each
                other out.
              </p>
              <p>
                Signing in with your Claude account makes the same one-year token as <Code>claude setup-token</Code>. Approve on claude.ai, then
                paste the code it shows into the dashboard.
              </p>
            </Section>

            <Section id="env" title="Environment variables">
              <p>
                Under <strong>Settings</strong>, <strong>Environment</strong> in the dashboard, add variables every VM gets. T3, the agents and the
                commands they run see them, and so do login and interactive shells on the VM, such as over SSH.
              </p>
              <List
                items={[
                  "An awake VM restarts T3 to apply a change as soon as nothing runs on it. A running turn finishes with the values it started with.",
                  "A sleeping or stopped VM applies it when it wakes, before T3 serves anything.",
                  "A new VM has them before T3 first starts.",
                  "VM cards show Update pending until a VM has the latest values.",
                ]}
              />
              <p>
                Values are kept with VM Bridge&apos;s other secrets and are never shown again: to change one, set it anew. On the VM they live in a
                file only the VM user can read. Names VM Bridge sets itself, or that would break shells, are refused: for example{" "}
                <Code>PATH</Code>, <Code>HOME</Code>, <Code>CLAUDE_CONFIG_DIR</Code>, <Code>CODEX_HOME</Code>, <Code>GH_TOKEN</Code> and anything
                starting with <Code>T3CODE_</Code> or <Code>VMBRIDGE_</Code>.
              </p>
            </Section>

            <Section id="skills" title="Skills">
              <p>
                Under <strong>Skills</strong> in the dashboard, press <strong>Add skill</strong> to install one from skills.sh, or use the{" "}
                <strong>This machine</strong> tab to install one found in{" "}
                <Code>~/.claude/skills</Code>, <Code>~/.agents/skills</Code> or <Code>~/.codex/skills</Code>. Every VM gets every installed skill:
              </p>
              <List
                items={[
                  "Awake VMs get it right away, even during an agent turn, without restarting T3 or the agents.",
                  "A sleeping or stopped VM gets it when it wakes, before T3 starts serving.",
                  "A new VM has every skill before T3 first starts.",
                  "Edits to a skill on this machine reach the VMs within a few seconds. A skills.sh skill changes only when you press Update.",
                  "Removing a skill takes it off every VM. Skills put on a VM some other way, and a skill with the same name already there, are left alone.",
                ]}
              />
              <p>
                Switch on <strong>Sync all</strong> to install every skill in those folders. New skills there follow within a few seconds, and one
                deleted here comes off the VMs. When two folders hold the same skill name, the first in the order above wins, and skills over 5 MB
                are skipped. Turning it off keeps what it installed until you remove it. skills.sh skills are not affected.
              </p>
              <Table
                head={["Agent", "Reads skills from"]}
                rows={[
                  ["Claude Code", <Code key="c">$CLAUDE_CONFIG_DIR/skills</Code>],
                  ["Codex", <Code key="x">~/.agents/skills</Code>],
                ]}
              />
              <p>
                Claude Code picks up new skills in a running session. Codex notices changes on its own; if a skill does not show, start a new
                thread. skills.sh skills download as text files.
              </p>
            </Section>

            <Section id="instructions" title="AGENTS.md">
              <p>
                The AGENTS.md tab of the Skills page lists each agent&apos;s global file found on this machine. Switch one on and every VM gets it, at
                the path that agent reads, on the same terms as skills: awake VMs right away, sleeping VMs before they serve anything on wake, new
                VMs at setup, and edits here within a few seconds.
              </p>
              <Table
                head={["Agent", "On this machine", "On each VM"]}
                rows={[
                  ["Claude Code", <Code key="c">~/.claude/CLAUDE.md</Code>, <Code key="cv">$CLAUDE_CONFIG_DIR/CLAUDE.md</Code>],
                  ["Codex", <Code key="x">~/.codex/AGENTS.md</Code>, <Code key="xv">$CODEX_HOME/AGENTS.md</Code>],
                  ["OpenCode", <Code key="o">~/.config/opencode/AGENTS.md</Code>, <Code key="ov">~/.config/opencode/AGENTS.md</Code>],
                ]}
              />
              <p>
                Only files that exist here are copied, so an agent without one gets none. Switching a file off, or deleting it here, takes it off
                the VMs. VM Bridge only replaces or removes a file it wrote: a file a VM already had, or one edited on the VM, is left alone. The
                files stay in memory on this machine and are never logged.
              </p>
            </Section>

            <Section id="network" title="Addresses and Tailscale">
              <p>
                VM Bridge listens on <Code>0.0.0.0</Code> by default, so phones and laptops on your network can reach it. Pass{" "}
                <Code>--host 127.0.0.1</Code> to keep it on this machine.
              </p>
              <Table
                head={["Address", "Example"]}
                rows={[
                  ["This machine", <Code key="1">http://127.0.0.1:3774</Code>],
                  ["Local network", <Code key="2">http://192.168.1.20:3774</Code>],
                  ["Tailscale IP", <Code key="3">http://100.101.102.103:3774</Code>],
                  ["Tailscale name", <Code key="4">http://mac-mini.tail.ts.net:3774</Code>],
                  ["Tailscale HTTPS", <Code key="5">https://mac-mini.tail.ts.net</Code>],
                  ["Cloudflare Tunnel", <Code key="6">https://bridge.example.com</Code>],
                ]}
              />
              <p>Turn on Tailscale HTTPS under Settings to reach VM Bridge from anywhere on your tailnet with a certificate.</p>
            </Section>

            <Section id="cloudflare" title="Cloudflare Tunnel">
              <p>
                Cloudflare Tunnel gives VM Bridge an HTTPS address on the public internet, so you can reach it from anywhere without opening a port.
                It runs through <Code>cloudflared</Code>, Cloudflare&apos;s free tool. Install it, and the switch shows up under{" "}
                <strong>Settings</strong>, <strong>Addresses</strong>:
              </p>
              <Block>{`brew install cloudflared`}</Block>
              <p>
                The tunnel is off until you turn it on, because anyone on the internet can then reach your login page. Your dashboard password,
                pairing links and the one-time setup link still protect everything behind it. Once it is on, its address appears with the others:
                in Settings, in the links <Code>vmbridge run</Code> prints and in pairing links.
              </p>
              <Table
                head={["Mode", "How to set it up", "Address"]}
                rows={[
                  ["Free address", "Leave the domain empty. No Cloudflare account needed.", "A random trycloudflare.com address that changes every time VM Bridge restarts"],
                  [
                    "Your own domain",
                    <>
                      Run <Code key="l">cloudflared tunnel login</Code> once, then type a hostname on a domain in your Cloudflare account.
                    </>,
                    "The hostname you typed",
                  ],
                  [
                    "Dashboard tunnel",
                    "Make a tunnel in the Cloudflare dashboard, paste its token and type the hostname you gave it there.",
                    "The hostname you typed",
                  ],
                ]}
              />
              <List
                items={[
                  <>
                    With your own domain, VM Bridge makes a tunnel named <Code>vmbridge-</Code> plus the first 8 characters of its ID, and adds the DNS
                    record for your hostname. It never replaces a record you already have.
                  </>,
                  <>
                    Its config and the tunnel&apos;s credentials live in <Code>~/.vmbridge/cloudflared</Code>. A dashboard tunnel&apos;s token is kept with
                    your other secrets.
                  </>,
                  <>
                    cloudflared connects to VM Bridge on a port of its own on this machine, picked the first time you turn the tunnel on and kept after
                    that. Settings shows it: point a dashboard tunnel&apos;s hostname at <Code>http://localhost:</Code> plus that port. If another app
                    takes the port, VM Bridge picks a new one, and you update the dashboard tunnel to match.
                  </>,
                  "Free addresses cannot stream live updates, so the dashboard refreshes every 5 seconds there. Your own domain and dashboard tunnels update live.",
                  "VM Bridge only believes the visitor address and HTTPS details Cloudflare adds when they arrive on the tunnel's port from this machine. Failed logins are counted per visitor, so one person cannot lock everyone out.",
                  "While it is on, the tunnel starts and stops with VM Bridge, including when you close its terminal. If cloudflared stops on its own, VM Bridge starts it again after a second, waiting longer after each failure, up to a minute. Its warnings and errors go to the VM Bridge log with tokens hidden.",
                ]}
              />
            </Section>

            <Section id="security" title="Data and security">
              <List
                items={[
                  <>
                    Everything is in <Code>~/.vmbridge/main.db</Code>, readable only by your user.
                  </>,
                  "The dashboard API never returns a saved secret. You can replace a key, not read it back.",
                  "Logs record which call went where and how long it took. They never hold message contents or tokens.",
                  "Each T3 server on a VM requires its own session token on every request, and only VM Bridge holds it. Public preview URLs show nothing without it.",
                  "Requests to VMs refuse redirects, so a token can never be sent to another site.",
                ]}
              />
            </Section>

            <Section id="encryption" title="Encryption">
              <p>
                VM Bridge encrypts everything sensitive it saves, by default, with AES-256-GCM and a key that only your install has.
              </p>
              <List
                items={[
                  <>
                    <strong>Encrypted:</strong> provider keys, the GitHub token, environment variables for VMs, each VM&apos;s T3 token, installed
                    skill files and agent sign-ins.
                  </>,
                  <>
                    <strong>Not encrypted:</strong> chat history, queued messages, logs and settings. They stay in files only your user can read.
                  </>,
                ]}
              />
              <p>
                On first start VM Bridge makes a random key and saves it in <Code>~/.vmbridge/encryption.key</Code>, readable only by your user. To
                use your own key, set <Code>VMBRIDGE_ENCRYPTION_KEY</Code> to 32 random bytes in base64. It takes the place of the file.
              </p>
              <Command text="openssl rand -base64 32" />
              <p>
                The key file sits next to your data, so a copy of the whole folder holds both. Keeping the key outside the folder, in{" "}
                <Code>VMBRIDGE_ENCRYPTION_KEY</Code>, is stronger.
              </p>
              <p>
                <strong>Back up the key</strong> somewhere apart from your data, such as a password manager: the contents of{" "}
                <Code>encryption.key</Code>, or the value you set. To restore it, put the file back or set the variable again.
              </p>
              <p>
                VM Bridge will not start with the wrong key or without its key, so it never overwrites what you saved. If the key is lost, no one
                can read those values again, you included: start with a new data folder and add your provider keys, agent sign-ins, environment
                variables and GitHub token again.
              </p>
              <p>
                Updating from a version without encryption encrypts your saved data on first start. After that, older versions can&apos;t read it,
                so don&apos;t go back to one.
              </p>
            </Section>

            <Section id="troubleshooting" title="Troubleshooting">
              <Table
                head={["What you see", "What to do"]}
                rows={[
                  ["An agent shows as signed out on a VM", "Add its sign-in under Setup, or in your provider's dashboard if it supplies them."],
                  ["The pairing link does not work", "Links work once and expire after 15 minutes. Create a new one."],
                  ["The T3 server on a VM did not answer", "The VM may be busy or the provider slow. Check the VM on the dashboard canvas, then retry."],
                  ["Waking takes longer than usual", "Stopped VMs (Daytona, Boat) start T3 cold, which adds a few seconds over a paused VM."],
                  ["You forgot the dashboard password", <>Run <Code key="k">vmbridge password</Code> on the machine to set a new one.</>],
                ]}
              />
            </Section>

            <Section id="develop" title="Develop">
              <Block>{`bun run dev        # server and dashboard, restarted on change
bun run check      # typecheck and tests`}</Block>
              <List
                items={[
                  <>
                    <Code>apps/server</Code>: the T3 gateway, the fleet of VMs, providers and the dashboard API.
                  </>,
                  <>
                    <Code>apps/web</Code>: the dashboard.
                  </>,
                  <>
                    <Code>apps/cli</Code>: the <Code>vmbridge</Code> command.
                  </>,
                  <>
                    <Code>apps/landing</Code>: this site.
                  </>,
                  <>
                    <Code>packages/contracts</Code>: types shared by the server and the dashboard.
                  </>,
                ]}
              />
            </Section>

            <section className={`${innerPad} py-12 lg:py-14 xl:grid xl:grid-cols-[minmax(0,15rem)_minmax(0,46rem)] xl:gap-x-12`}>
              <h2 className="title xl:text-[1.75rem]">{copy.docs.stuck}</h2>
              <div className="mt-4 xl:mt-1">
                <p className="text-pretty text-muted-foreground">{copy.docs.stuckBody}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Link href="/faq" className={`${primaryButton} group`}>
                    {copy.docs.faq}
                    <HugeiconsIcon icon={ArrowRight01Icon} size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
                  </Link>
                  <a href={`${github}/issues/new`} className={secondaryButton}>
                    <HugeiconsIcon icon={GithubIcon} size={15} />
                    {copy.docs.issue}
                  </a>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
      <Footer />
    </>
  );
}
