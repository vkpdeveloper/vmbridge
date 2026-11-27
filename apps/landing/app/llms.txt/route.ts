import { faq, github, install } from "@/lib/data";
import { site } from "@/lib/site";

// Built once at build time from the same data as the pages, so it cannot drift from them.
export const dynamic = "force-static";

const blob = `${github}/blob/main`;

// Follows https://llmstxt.org: a title, a one-paragraph summary, free text without headings, then lists of links.
const text = `# VM Bridge

> ${faq[0].answer} It runs on macOS and Linux.

Install on macOS or Linux:

\`\`\`sh
${install}
\`\`\`

This installs one \`vmbridge\` file in \`~/.local/bin\`. Run \`vmbridge\`, choose a dashboard password, open \`/dashboard\` on one of the addresses it prints, add a provider, connect GitHub, sign in your agents and create a pairing link for T3 Code. Current version: ${site.version}.

${faq
  .slice(1)
  .map(({ question, answer }) => `**${question}** ${answer}`)
  .join("\n\n")}

## Docs

- [Docs](${site.url}/docs): install, setup, pairing T3 Code, OpenCode (\`vb opencode\`), how requests flow, sleep and wake, providers, agent sign-ins, environment variables, skills, AGENTS.md, Tailscale, data and security, troubleshooting
- [FAQ](${site.url}/faq): the questions answered above, on one page
- [Providers](${blob}/docs/PROVIDERS.md): sizes, sleep behaviour, safety nets and measured times for each provider
- [README](${github}#readme): install and commands
- [Releases](${github}/releases): binaries for macOS and Linux with checksums

## Optional

- [T3 protocol notes](${blob}/docs/T3-PROTOCOL.md): how VM Bridge speaks T3 Code's protocol
- [Source code](${github}): TypeScript on Bun, MIT license
`;

export function GET() {
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
