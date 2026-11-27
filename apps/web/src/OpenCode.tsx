import { useEffect, useRef, useState } from "react";
import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { QRCodeSVG } from "qrcode.react";
import type { OpenCodeConnection, ProjectInfo } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";

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
      <DialogContent className="sm:max-w-lg">
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
