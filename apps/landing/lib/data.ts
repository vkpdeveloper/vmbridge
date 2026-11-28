export type ProviderId = "boxd" | "instabox" | "daytona" | "boat" | "railway" | "e2b" | "freestyle" | "superserve" | "kubi";

export interface Provider {
  id: ProviderId;
  name: string;
  logo: string;
  /** Tile behind the logo, matching the dashboard. */
  tile: string;
  inset: string;
  /** Accent used in the 3D scene and charts. */
  color: string;
  sleep: string;
  wake: string;
  sizes: [string, string, string];
  reach: string;
  safetyNet: string;
  /** Measured on fresh VMs in live runs. Missing when not measured yet. */
  measured?: { ready: string; wakeSeconds: [number, number]; browseMs: number };
}

export const providers: Provider[] = [
  {
    id: "boxd",
    name: "boxd",
    logo: "/providers/boxd.svg",
    tile: "#000",
    inset: "24%",
    color: "#f4f4f5",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["1 vCPU, 4 GB", "2 vCPU, 8 GB", "4 vCPU, 16 GB"],
    reach: "Public proxy",
    safetyNet: "Suspends after 60 min idle",
    measured: { ready: "22 to 24 s", wakeSeconds: [6, 11], browseMs: 160 },
  },
  {
    id: "instabox",
    name: "Instabox",
    logo: "/providers/instabox.svg",
    tile: "#000",
    inset: "0%",
    color: "#38bdf8",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["2 vCPU, 4 GB", "4 vCPU, 8 GB", "8 vCPU, 16 GB"],
    reach: "Published port",
    safetyNet: "Suspends after 30 min idle",
    measured: { ready: "22 s", wakeSeconds: [10.5, 10.5], browseMs: 229 },
  },
  {
    id: "daytona",
    name: "Daytona",
    logo: "/providers/daytona.png",
    tile: "#000",
    inset: "0%",
    color: "#3ecf8e",
    sleep: "Stop, files kept",
    wake: "Start",
    sizes: ["1 vCPU, 1 GB", "2 vCPU, 4 GB", "4 vCPU, 8 GB"],
    reach: "Private preview with a token header",
    safetyNet: "Stops after 60 min without traffic",
    measured: { ready: "16 to 19 s", wakeSeconds: [10, 11], browseMs: 156 },
  },
  {
    id: "boat",
    name: "Boat",
    logo: "/providers/boat.svg",
    tile: "#fff",
    inset: "18%",
    color: "#5b7cfa",
    sleep: "Stop, disk kept",
    wake: "Resume",
    sizes: ["2 vCPU, 4 GB", "4 vCPU, 8 GB", "8 vCPU, 16 GB"],
    reach: "Preview host with a cookie",
    safetyNet: "Stops 12 h after start",
  },
  {
    id: "railway",
    name: "Railway",
    logo: "/providers/railway.svg",
    tile: "#13111c",
    inset: "20%",
    color: "#a78bfa",
    sleep: "Checkpoint, then remove",
    wake: "New VM from the checkpoint",
    sizes: ["1 vCPU, 2 GB", "2 vCPU, 4 GB", "4 vCPU, 8 GB"],
    reach: "Public domain",
    safetyNet: "None",
    measured: { ready: "57 s", wakeSeconds: [45, 45], browseMs: 211 },
  },
  {
    id: "e2b",
    name: "E2B",
    logo: "/providers/e2b.png",
    tile: "#000",
    inset: "0%",
    color: "#ff8800",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["2 vCPU, 2 GB", "4 vCPU, 4 GB", "8 vCPU, 8 GB"],
    reach: "Public URL",
    safetyNet: "Pauses 60 min after start, pushed back while agents work",
    measured: { ready: "95 s", wakeSeconds: [16, 16], browseMs: 278 },
  },
  {
    id: "freestyle",
    name: "Freestyle",
    logo: "/providers/freestyle.png",
    tile: "#fff",
    inset: "18%",
    color: "#f472b6",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["4 vCPU, 8 GB", "4 vCPU, 8 GB", "4 vCPU, 8 GB"],
    reach: "Public domain",
    safetyNet: "Pauses after 60 min without traffic",
    measured: { ready: "60 to 61 s", wakeSeconds: [8, 8], browseMs: 218 },
  },
  {
    id: "superserve",
    name: "Superserve",
    logo: "/providers/superserve.svg",
    tile: "#141414",
    inset: "0%",
    color: "#b2fab4",
    sleep: "Pause, memory kept",
    wake: "Resume",
    sizes: ["2 vCPU, 4 GB", "2 vCPU, 4 GB", "2 vCPU, 4 GB"],
    reach: "Private preview with a token header",
    safetyNet: "Pauses after 12 h awake",
    measured: { ready: "55 s", wakeSeconds: [16, 16], browseMs: 320 },
  },
  {
    id: "kubi",
    name: "Kubi",
    logo: "/providers/kubi.svg",
    tile: "#000",
    inset: "18%",
    color: "#4ca464",
    sleep: "Stop, disk kept",
    wake: "Start (a reboot)",
    sizes: ["4 vCPU, 8 GB", "4 vCPU, 8 GB", "4 vCPU, 8 GB"],
    reach: "Private port with a token header",
    safetyNet: "None",
  },
];

export const github = "https://github.com/vkpdeveloper/vmbridge";
/** Cloudflare's deploy flow for this repository; docs/cloudflare.md walks through it. */
export const deployToCloudflare = `https://deploy.workers.cloudflare.com/?url=${github}`;
export const install = `curl -fsSL https://raw.githubusercontent.com/vkpdeveloper/vmbridge/main/install.sh | sh`;

export const commands = [
  { command: "vmbridge", args: "[run] [--host 0.0.0.0] [--port 3774]", does: "Start in this terminal" },
  { command: "vmbridge stop", args: "", does: "Stop, including the background service" },
  { command: "vmbridge service install", args: "[--host] [--port]", does: "Run in the background at login (launchd or systemd)" },
  { command: "vmbridge service uninstall", args: "", does: "Remove the background service" },
  { command: "vmbridge password", args: "", does: "Set a new dashboard password" },
];

/** The agent CLIs VM Bridge installs on every VM. */
export const agents = [
  { id: "codex", name: "Codex", logo: "/agents/codex.svg" },
  { id: "claude", name: "Claude", logo: "/agents/claude.svg" },
] as const;
export type Agent = (typeof agents)[number];

/** Real terminal output beside each step, index-matched to copy.steps.items. */
export const stepLogs: string[][] = [
  ["$ vmbridge", "VM Bridge 1.1.17 is running.", "  This machine         http://127.0.0.1:3774/dashboard"],
  ["Provider boxd connected", "Size: 2 vCPU, 8 GB", "Sleep after 5 idle minutes"],
  ['Pairing link "MacBook" created', "MacBook paired", "iPhone paired"],
  ["Creating a VM for Hello-World", "Installing T3, Codex and Claude", "vm-df9bca ready on boxd", "Cloned Hello-World"],
];

/**
 * What each command in `commands` really prints, index-matched. Every output line is copied from
 * apps/cli/src/index.ts and apps/cli/src/service.ts, on macOS with home /Users/you.
 */
export const cliScripts: string[][] = [
  [
    "$ vmbridge",
    "VM Bridge 1.1.17 is running.",
    "",
    "  This machine         http://127.0.0.1:3774/dashboard",
    "  Local network (en0)  http://192.168.1.20:3774/dashboard",
    "  Tailscale IP         http://100.101.102.103:3774/dashboard",
    "  Tailscale name       http://your-mac.your-tailnet.ts.net:3774/dashboard",
    "",
    "  Turn on Tailscale HTTPS in the dashboard settings for an https:// address.",
    "",
    "Open the dashboard to set up providers and pair devices. Press Ctrl+C to stop.",
  ],
  [
    "$ vmbridge stop",
    "VM Bridge stopped.",
    "The background service starts again at next login, or now with `vmbridge service install`.",
  ],
  ["$ vmbridge service install", "VM Bridge now runs in the background on port 3774. Logs: /Users/you/.vmbridge/vmbridge.log"],
  ["$ vmbridge service uninstall", "Background service removed."],
  [
    "$ vmbridge password",
    "Choose a dashboard password (at least 8 characters): ********",
    "Type it again: ********",
    "Password saved.",
  ],
];

/** The hero terminal plays the full `vmbridge` startup output. */
export const heroScript = cliScripts[0];

/** Bridge-side calls answer in about a millisecond. */
export const bridgeLatency = "1 ms";

const measuredMs = providers.flatMap((p) => (p.measured ? [p.measured.browseMs] : []));

/** Round trip bounds across the measured providers: "156 to 229 ms". */
export const vmLatency = `${Math.min(...measuredMs)} to ${Math.max(...measuredMs)} ms`;

export interface Route {
  /** Real RPC names from apps/server/src/gateway/rpc.ts. */
  call: string;
  target: string;
  time: string;
  kind: "bridge" | "vm";
}

/** A short request log showing what the bridge answers itself and what goes to a VM. */
export const routes: Route[] = [
  { call: "server.getConfig", target: "bridge", time: "1 ms", kind: "bridge" },
  { call: "orchestration.getThreadProjection", target: "bridge, saved copy", time: "< 1 ms", kind: "bridge" },
  { call: "filesystem.browse", target: "vm-df9bca", time: "160 ms", kind: "vm" },
  { call: "orchestration.dispatchCommand", target: "vm-df9bca", time: "streaming", kind: "vm" },
];

/**
 * Questions people ask, shown on the home page and repeated in its structured data and llms.txt.
 * Each answer stands alone when quoted. Text in backticks is code.
 */
export const faq = [
  {
    question: "What is VM Bridge?",
    answer:
      "VM Bridge is a free, open source server that runs T3 Code agents on cloud VMs. You pair T3 Code with it once, and it gives each project its own VM (and more when the project gets busy), puts idle VMs to sleep and wakes them when you send a message.",
  },
  {
    question: "Does VM Bridge work with T3 Code?",
    answer:
      "Yes. VM Bridge is built for T3 Code and needs no changes to the app. You add it in T3 Code as a remote environment with a pairing link, and T3 Code sees it as one T3 server.",
  },
  {
    question: "Which cloud providers does VM Bridge support?",
    answer:
      "VM Bridge supports boxd, Instabox, Daytona, Boat, Railway, E2B, Freestyle, Superserve and Kubi. You can add several at once, pick a default for new VMs, and send a repository to a given provider.",
  },
  {
    question: "Which coding agents can I use?",
    answer:
      "Codex, Claude Code and OpenCode. VM Bridge installs them on each VM and signs them in with the accounts and keys you add in the dashboard.",
  },
  {
    question: "Can I set environment variables on the VMs?",
    answer:
      "Yes. Add them once in the dashboard and every VM gets them, for the agents, the commands they run and shells on the VM. A VM applies a change once nothing runs on it, or when it wakes, so a running turn is never cut off. Values are stored as secrets and never shown again.",
  },
  {
    question: "Can agents on the VMs use skills?",
    answer:
      "Yes. Install agent skills from skills.sh, or pick ones already on the machine that runs VM Bridge, and every VM gets them for Claude Code and Codex. Awake VMs get them right away without a restart, sleeping VMs get them when they wake, and edits to a local skill follow on their own. Switch on Sync all and every skill on that machine goes, including new ones.",
  },
  {
    question: "Do my CLAUDE.md and AGENTS.md reach the VMs?",
    answer:
      "If you want them to. The AGENTS.md tab of the Skills page lists the global files for Claude Code, Codex and OpenCode found on the machine that runs VM Bridge. Switch one on and every VM gets it where that agent reads it, and edits follow on their own. A file a VM already had is left alone.",
  },
  {
    question: "How much does VM Bridge cost?",
    answer:
      "VM Bridge is free and open source under the MIT license. You pay your cloud provider for the VMs, and idle VMs go to sleep so they stop using compute.",
  },
  {
    question: "Does VM Bridge run on Windows?",
    answer:
      "No. VM Bridge runs on macOS and Linux. T3 Code on your other devices connects to it over your local network, Tailscale or Cloudflare Tunnel.",
  },
  {
    question: "What happens when I run many threads in one project?",
    answer:
      "Each new thread goes to one of the project's VMs that has room: fewer than 2 running turns per vCPU, under 80% of its memory used and 3 GB of disk free. When none has room, VM Bridge adds another VM like the first, up to 4 per project, and puts the thread there. If the provider refuses, the thread runs on the least loaded VM and says it may be slow. Running threads never move, and extra VMs sleep when idle like any other.",
  },
  {
    question: "How do sleep and wake work?",
    answer:
      "A VM goes to sleep after it has been idle for a set time, 5 minutes by default, with no agent turn running. When you send a message in one of its threads, VM Bridge wakes the VM and then delivers the message. Waking takes about 6 to 21 seconds on most providers and about a minute on Railway.",
  },
  {
    question: "Where are my data and keys stored?",
    answer:
      "On the machine that runs VM Bridge, in `~/.vmbridge`, readable only by your user. Provider keys, the GitHub token and agent sign-ins stay there, and the dashboard never shows a saved secret again.",
  },
  {
    question: "How do I install VM Bridge?",
    answer: `On macOS or Linux, run \`${install}\`. Then run \`vmbridge\` and open the setup link it prints to choose a password, add a provider and sign in your agents. Pair T3 Code from the dashboard.`,
  },
];

/**
 * The five questions shown on the home page, picked from `faq` by text so they
 * cannot drift from the full list on /faq. Throws at module load if a question
 * is renamed or dropped from `faq`.
 */
export const featuredFaq = [
  "What is VM Bridge?",
  "Which cloud providers does VM Bridge support?",
  "How much does VM Bridge cost?",
  "How do sleep and wake work?",
  "Where are my data and keys stored?",
].map((question) => {
  const entry = faq.find((item) => item.question === question);
  if (!entry) throw new Error(`featuredFaq: no faq entry for "${question}"`);
  return entry;
});
