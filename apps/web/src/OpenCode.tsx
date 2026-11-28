import { useEffect, useRef, useState } from "react";
import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import type { OpenCodeConnection, ProjectInfo, VmOpenCodeSession } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { copyText } from "@/lib/clipboard";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { AgentLogo } from "./brand.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { SessionStatus } from "./SessionStatus.tsx";

/**
 * The terminal command that connects to an address, for PowerShell on Windows. OpenCode refuses a password in the URL
 * and reads it from OPENCODE_PASSWORD.
 */
const connectCommand = (url: string, password: string) =>
  /Windows/.test(navigator.userAgent)
    ? `$env:OPENCODE_PASSWORD='${password}'; opencode --server ${url}`
    : `OPENCODE_PASSWORD='${password}' opencode --server ${url}`;

/** A project's OpenCode address and password, fetched as the dialog opens. The first open makes the password. */
export function ConnectOpenCode({ project }: { project: ProjectInfo }) {
  const [connection, setConnection] = useState<OpenCodeConnection | null>(null);
  const [open, setOpen] = useState(false);
  const action = useAction();
  // A read the server answers while a new password is being made may carry the old one, so it is shown only when no
  // renewal started or ran during it.
  const renewals = useRef({ started: 0, running: 0 });
  const load = (renew: boolean) => {
    const counts = renewals.current;
    const startedBefore = counts.started;
    const overlapped = counts.running > 0;
    if (renew) {
      counts.started++;
      counts.running++;
    }
    void action.run(async () => {
      try {
        const next = await api<OpenCodeConnection>(`/projects/${project.id}/opencode`, { body: { renew } });
        if (renew ? counts.started === startedBefore + 1 : !overlapped && counts.started === startedBefore) setConnection(next);
      } finally {
        if (renew) counts.running--;
      }
    });
  };
  const pairing = connection?.pairing;
  // A pairing code works for ten minutes, so an open dialog swaps in a new one before it ends.
  useEffect(() => {
    if (!open || !pairing) return;
    const timer = setTimeout(() => load(false), (pairing.expiresInSeconds - 15) * 1000);
    return () => clearTimeout(timer);
  }, [open, pairing]);
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load(false);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Connect OpenCode
        </Button>
      </DialogTrigger>
      {/* One column that never grows past the dialog, so long addresses truncate. With every address and the QR code it can be taller than a phone, so it scrolls. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-1 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect OpenCode</DialogTitle>
          <DialogDescription>
            In OpenCode, connect to a server with this address and password, or copy the terminal command. {project.title}'s VM wakes on the first request.
          </DialogDescription>
        </DialogHeader>
        {connection && (
          <ItemGroup className="gap-2">
            {connection.urls.map((url) => (
              <Item key={url.url} variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle>{url.label}</ItemTitle>
                  <ItemDescription className="truncate font-mono text-xs">{url.url}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <CopyButton value={connectCommand(url.url, connection.password)} label="Copy command" icon={CommandLineIcon} />
                  <CopyButton value={url.url} label="Copy address" />
                </ItemActions>
              </Item>
            ))}
            <Item variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>Password</ItemTitle>
                <ItemDescription className="font-mono text-xs">{"•".repeat(16)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <CopyButton value={connection.password} label="Copy password" />
              </ItemActions>
            </Item>
            {connection.pairing && (
              <Item variant="outline" size="sm">
                <div className="shrink-0 rounded-md bg-white p-2">
                  {/* The same JSON `opencode pair` puts in its QR code. */}
                  <QRCodeSVG value={JSON.stringify({ code: connection.pairing.code, urls: connection.pairing.urls })} size={128} />
                </div>
                <ItemContent className="min-w-0">
                  <ItemTitle>Scan with your phone</ItemTitle>
                  <ItemDescription className="line-clamp-none">In OpenCode, connect to a server and scan this code. It works once.</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </ItemGroup>
        )}
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled={action.busy || !connection} onClick={() => load(true)}>
            New password
          </Button>
          {action.error && <p className="text-xs text-destructive">{action.error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An AI provider's logo from models.dev, which has one for each provider OpenCode lists and draws it in the text color,
 * so it is inverted on the dark dashboard. Offline, or when models.dev has none, the provider's first letter stands in.
 */
function ProviderMark({ provider }: { provider: { id: string; name: string } }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="grid size-4 shrink-0 place-items-center text-[11px] font-semibold text-muted-foreground">{provider.name.slice(0, 1).toUpperCase()}</span>;
  return (
    <img
      src={`https://models.dev/logos/${encodeURIComponent(provider.id)}.svg`}
      alt=""
      referrerPolicy="no-referrer"
      className="size-4 shrink-0 object-contain dark:invert"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** A VM's OpenCode session. Clicking it copies the command that opens its worktree again, when it has one. */
export function OpenCodeSessionItem({ session }: { session: VmOpenCodeSession }) {
  const { resumeCommand, provider } = session;
  const row = (
    <>
      <ItemMedia className="self-start pt-0.5" title="OpenCode">
        <AgentLogo agent="opencode" className="size-5" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full justify-between">
          <span className="truncate">{session.title}</span>
          <SessionStatus activity={session.activity} />
        </ItemTitle>
        {(provider || session.model) && (
          <ItemDescription className="flex min-w-0 items-center gap-1.5 text-xs">
            {provider && <ProviderMark provider={provider} />}
            <span className="truncate">{[provider?.name, session.model].filter(Boolean).join(" · ")}</span>
          </ItemDescription>
        )}
        <ItemDescription className="truncate text-xs">{[session.repository, session.branch].filter(Boolean).join(" · ")}</ItemDescription>
      </ItemContent>
    </>
  );
  if (!resumeCommand) return <Item variant="outline" size="sm">{row}</Item>;
  return (
    <Item asChild variant="outline" size="sm">
      <button
        type="button"
        className="cursor-pointer text-left hover:bg-muted"
        title={resumeCommand}
        onClick={async (event) => {
          if (await copyText(resumeCommand, event.currentTarget)) toast.success("Copied.");
          else toast.error("Copy failed.");
        }}
      >
        {row}
      </button>
    </Item>
  );
}
