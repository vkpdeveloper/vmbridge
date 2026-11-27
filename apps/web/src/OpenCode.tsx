import { useState } from "react";
import type { OpenCodeConnection, ProjectInfo } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";

/** A project's OpenCode address and password, fetched as the dialog opens. The first open makes the password. */
export function ConnectOpenCode({ project }: { project: ProjectInfo }) {
  const [connection, setConnection] = useState<OpenCodeConnection | null>(null);
  const action = useAction();
  const load = (renew: boolean) => void action.run(async () => setConnection(await api<OpenCodeConnection>(`/projects/${project.id}/opencode`, { body: { renew } })));
  return (
    <Dialog onOpenChange={(open) => open && load(false)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Connect OpenCode
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect OpenCode</DialogTitle>
          <DialogDescription>
            In OpenCode, connect to a server with this address and password. {project.title}'s VM wakes on the first request.
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
