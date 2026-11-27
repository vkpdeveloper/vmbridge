/**
 * Every sentence on the landing page. Components read from here and hold no text of their own.
 * Facts such as commands, provider names and timings live in data.ts.
 * The limit after each slot is the longest it may be, in characters.
 */
export const copy = {
  meta: {
    /** 60 */
    title: "VM Bridge: T3 Code agents on cloud VMs",
    /** 160 */
    description:
      "Pair an unchanged T3 Code client once. VM Bridge runs one cloud VM per project, sleeps idle VMs, and wakes them when you send a message.",
  },

  nav: { how: "Setup", providers: "Providers", docs: "Docs", github: "GitHub" },

  hero: {
    /** 48. One line on desktop, two on a phone. */
    title: "Every T3 Code project gets its own cloud VM",
    /** 150. What it does and why it matters, in one or two sentences. */
    body: "Pair an unchanged T3 Code client once. VM Bridge creates VMs on your provider, sleeps them when idle, and wakes them when you send a message.",
    /** 20 */
    cloudflare: "Deploy to Cloudflare",
    /** 40. Sits under the diagram, which visitors can click. */
    hint: "Click a VM to sleep or wake it",
  },

  /** The button that copies lib/prompt.ts, beside every install command. 30 each. */
  agentPrompt: { copy: "Copy prompt for your agent", copied: "Copied, paste it in" },

  /** Labels on the diagram of devices, VM Bridge and VMs. 16 each. */
  diagram: {
    devices: "Devices",
    bridge: "VM Bridge",
    vms: "Cloud VMs",
    online: "Online",
    asleep: "Asleep",
    waking: "Waking",
  },

  /** Four steps from install to a running project: number, title and body. */
  steps: {
    /** 40 */
    title: "Setup takes four steps",
    /** 140 */
    body: "Run one executable on macOS or Linux. After the first command, all configuration happens in the browser.",
    /** Each title 24, each body 150. */
    items: [
      {
        title: "Run VM Bridge",
        body: "First run asks for a dashboard password. VM Bridge stores state in ~/.vmbridge, listens on port 3774, and serves /dashboard.",
      },
      {
        title: "Choose a provider",
        body: "Add a key for boxd, Instabox, Daytona and five more. Then connect GitHub, add agent sign-ins, and set the VM size and idle timeout.",
      },
      {
        title: "Pair T3 Code",
        body: "Create a single-use pairing link under Settings, Devices and paste it into T3 Code as a remote environment. Each device gets its own token.",
      },
      {
        title: "Open a project",
        body: "VM Bridge creates a VM for the repository, installs Node, T3, Codex, Claude Code, and OpenCode, starts the T3 server, and clones the project.",
      },
    ],
  },

  /** The life of one VM, drawn as a timeline with four states. */
  lifecycle: {
    /** 40 */
    title: "Awake only when in use",
    /** 160 */
    body: "VM Bridge tracks open clients, running turns, and pending approvals. When a VM sits idle, it saves the threads and puts the VM to sleep.",
    /** Each name 10, each body 110. */
    states: [
      { name: "Online", body: "The VM is running and connected to VM Bridge. Agents handle turns and stream replies back to T3 Code." },
      { name: "Idle", body: "No device is active and no turn, approval, or automation is waiting. The 5-minute default timer starts." },
      { name: "Asleep", body: "VM Bridge saves each thread and pauses, stops, or checkpoints the VM. Threads stay readable in T3 Code." },
      { name: "Waking", body: "Send a message and VM Bridge brings the VM back with your files intact, then delivers the message." },
    ],
  },

  /**
   * A small copy of a T3 Code thread beside the lifecycle states. The visitor presses Send, the sleeping VM wakes,
   * the agent replies, and after a few idle seconds the VM sleeps again. Exchanges are used in order, then repeat.
   */
  demo: {
    /** 8 */
    send: "Send",
    /** 40. Shown in the thread while the VM wakes. The VM name follows it. */
    waking: "Waking",
    /** 50. Shown in the thread once the VM is asleep again. */
    asleep: "The VM is asleep. Showing the saved copy.",
    /** Each message 50, each reply 130. An ordinary coding request and the agent's plain report of what it did. */
    exchanges: [
      {
        message: "Add rate limiting to the login route",
        reply: "Limited POST /login to 10 requests a minute per IP in src/routes/login.ts. Added 3 tests, and the auth suite passes.",
      },
      {
        message: "Split the invoice parser out of billing.ts",
        reply: "Moved parseInvoice and its helpers to src/invoice-parser.ts and updated 6 imports. Typecheck and all 24 billing tests pass.",
      },
      {
        message: "Why is the orders query slow?",
        reply: "getOrderSummary in src/db/orders.ts filters by created_at, which has no index, so it scans the whole orders table.",
      },
    ],
  },

  /** A short request log showing which calls the bridge answers itself and which go to a VM. */
  routing: {
    /** 40 */
    title: "One connection, routed per project",
    /** 170 */
    body: "To T3 Code, VM Bridge looks like a single T3 server. It keeps one connection to each awake VM, routes calls by project or thread, and answers local reads itself.",
    /** Column headings, 12 each. */
    columns: { call: "Request", target: "Answered by", time: "Time" },
    /** Each 90. One line under the log per kind of request. */
    notes: {
      bridge: "Config, the project list, and sleeping threads come from VM Bridge in about 1 ms.",
      vm: "Messages, file browsing, and Git status go to the project's VM, about 160 to 320 ms away.",
    },
  },

  /** The nine providers on a ring around the bridge mark. */
  providers: {
    /** 40 */
    title: "Nine supported sandbox providers",
    /** 150 */
    body: "Use your own accounts and API keys, and add several providers at once.",
  },

  /** Screenshots of the dashboard behind four tabs. */
  dashboard: {
    /** 40 */
    title: "A web dashboard behind one password",
    /** 150 */
    body: "Inspect VMs, request logs, and devices at /dashboard. The API never returns saved secrets, and logs never store message text or tokens.",
    /** Each label 10, each caption 90. */
    tabs: {
      canvas: { label: "Canvas", caption: "Paired devices, VM Bridge, and each VM with its status, size, and request rate." },
      logs: { label: "Logs", caption: "Filterable stream of every call, its source, and how long it took." },
      setup: { label: "Setup", caption: "Pick the active provider, replace its API key, and manage GitHub and agent sign-ins." },
      devices: { label: "Devices", caption: "Create 15-minute pairing links, see connected devices, and remove any device." },
    },
  },

  /** The command reference: a static list beside one live terminal. */
  cli: {
    /** 40 */
    title: "Five commands",
    /** 150 */
    body: "Run VM Bridge in a terminal or as a login service via launchd or systemd. It listens on 0.0.0.0 by default for LAN and Tailscale access.",
  },

  install: {
    /** 40 */
    title: "One executable for macOS and Linux",
    /** 110 */
    body: "One command puts the server, dashboard, and CLI in ~/.local/bin. Run it again to update.",
    /** 20 */
    docs: "Read the docs",
  },

  /** The questions, opening in place. Answers live in data.faq so structured data and llms.txt share them. */
  docs: {
    eyebrow: "Docs",
    /** 30 */
    title: "How VM Bridge works",
    /** 160 */
    body: "Install it, add a provider and pair T3 Code. Then how requests reach a VM, when VMs sleep and wake, and where your keys and data live.",
    faq: "Read the FAQ",
    issue: "Open an issue",
    stuck: "Still stuck?",
    stuckBody: "The FAQ answers the common questions. Anything else, open an issue on GitHub.",
  },
  /** The docs section on connecting OpenCode, which reads every line from here. */
  opencode: {
    /** 30 */
    title: "Use with OpenCode",
    /** 200 */
    body: "OpenCode connects to VM Bridge like any OpenCode server. Each project gets its own address and password, and its agents run on the project's VM.",
    /** The steps, in order. */
    steps: [
      "Add an OpenCode API key in Accounts. OpenCode on the VMs uses its models.",
      "Open a VM on the dashboard and choose Connect OpenCode next to its repository.",
      "In the OpenCode app, choose Connect to a server and paste the address and password.",
    ],
    /** 80. Before the terminal command. */
    terminal: "In a terminal, put the password in OPENCODE_PASSWORD and run:",
    /** With an example of the address the dashboard shows. */
    command: "opencode --server https://bridge.example.com/opencode/<project>",
    notes: [
      "The first request wakes the VM. If OpenCode gives up while it wakes, connect again.",
      "Agents keep running after OpenCode closes. The VM sleeps once no OpenCode agent is running and nothing has used it for the idle time.",
      "New password, in the same dialog, signs out every OpenCode client of that project.",
      "OpenCode uses only the OpenCode key. Codex and Claude sign-ins stay with T3 Code.",
    ],
  },
  faq: {
    /** 40 */
    title: "Questions",
    /** 30. The link under the home FAQ title to the full list; {n} is faq.length. */
    all: "All {n} questions",
  },

  /** The fixed status line: the page's own sleep state, like a VM's. {n} is the countdown. */
  status: {
    /** 10 */
    awake: "awake",
    /** 30 */
    idle: "idle, sleeping in {n}s",
    /** 30 */
    asleep: "asleep. move to wake",
    /** 10 */
    waking: "waking",
    /** 30 */
    hint: "type sleep in the terminal",
  },

  /** The live terminal's interactive parts. */
  terminal: {
    /** 12. Shown in the terminal strip once it can be typed in. */
    hint: "try: help",
    /** 30. Accessible name of the prompt input. */
    label: "Type a command",
    /** 30 */
    sleeping: "putting the page to sleep",
    /** 10 */
    awake: "awake",
    /** 40. {cmd} is the unknown first word. */
    notFound: "zsh: command not found: {cmd}",
    /** Command help lines: the command, then a two-to-four word description. */
    help: [
      ["vmbridge", "start the bridge"],
      ["vmbridge stop", "stop the bridge"],
      ["vmbridge service install", "run at login"],
      ["vmbridge service uninstall", "drop service"],
      ["vmbridge password", "new dashboard password"],
      ["help", "list commands"],
      ["sleep", "put page to sleep"],
      ["wake", "wake the page"],
      ["clear", "clear the terminal"],
    ],
  },

  footer: {
    /** 60 */
    line: "VM Bridge runs T3 Code agents on cloud VMs.",
    /** 20. Before " · v{site.version}". */
    license: "MIT license",
    /** The two link-column labels. */
    site: "Site",
    project: "Project",
    /** Link texts in the two columns. */
    links: {
      setup: "Setup",
      sleepWake: "Sleep and wake",
      providers: "Providers",
      dashboard: "Dashboard",
      commands: "Commands",
      faq: "FAQ",
      docs: "Docs",
      install: "Install",
      github: "GitHub",
      releases: "Releases",
      license: "License",
    },
  },
} as const;
