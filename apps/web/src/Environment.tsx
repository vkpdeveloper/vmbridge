import { useRef, useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Cancel01Icon, Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { Overview } from "@vmbridge/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAction } from "@/hooks/use-action";
import { parseEnvPaste } from "@/lib/env-paste";
import { api } from "./api.ts";
import { Section } from "./Page.tsx";

/** A pasted variable waiting to be saved. */
interface Draft {
  name: string;
  value: string;
}

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

/** Environment variables every VM gets. Values are write-only: the server never sends them back. */
export function Environment({ overview }: { overview: Overview }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const valueInput = useRef<HTMLTextAreaElement>(null);
  const action = useAction();
  const key = name.trim();
  const exists = overview.env.includes(key);
  const pending = overview.vms.filter((vm) => vm.updatePending).length;

  const remove = (target: string) =>
    void action.run(() => api(`/env/${encodeURIComponent(target)}`, { method: "DELETE" })).then((ok) => ok && toast.success(`${target} removed. If it was a secret, revoke it at its source too.`));

  // Pasting `.env` text turns each `NAME=value` line into a draft to review before saving.
  const pasteMany = (event: ClipboardEvent, field: "name" | "value") => {
    const paste = parseEnvPaste(event.clipboardData.getData("text/plain"));
    if (!paste) return;
    // A single `X=y` pasted as a value is more likely the value itself, so the value field only takes clear lists.
    if (field === "value" && (value !== "" || paste.badLines.length > 0 || paste.assignments < 2)) return;
    event.preventDefault();
    if (paste.invalidNames.length > 0) toast.warning(`Skipped ${paste.invalidNames.join(", ")}. Names use letters, digits and underscores, not starting with a digit.`);
    if (paste.badLines.length > 0) toast.warning(`Skipped ${paste.badLines.length === 1 ? "line" : "lines"} ${paste.badLines.join(", ")}: not NAME=value.`);
    if (paste.vars.size === 0) return;
    setDrafts([...paste.vars].map(([name, value]) => ({ name, value })));
    setName("");
    setValue("");
  };

  // One request, so VMs update once. If the server refuses one, nothing is saved and the drafts stay for review.
  const saveDrafts = () =>
    void action
      .run(() => api("/env", { method: "PUT", body: { vars: Object.fromEntries(drafts.map((draft) => [draft.name, draft.value])) } }))
      .then((ok) => {
        if (!ok) return;
        toast.success(`${plural(drafts.length, "variable")} saved. VMs get them as soon as nothing is running on them.`);
        setDrafts([]);
      });

  return (
    <Section title="Environment variables" actions={overview.env.length > 0 && <Badge variant="secondary">{overview.env.length}</Badge>}>
      <div className="flex flex-col gap-3">
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {overview.env.map((entry) => (
            <div key={entry} className="flex items-center gap-3 py-2 pr-2 pl-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{entry}</code>
              <span className="text-sm tracking-widest text-faint select-none">••••••</span>
              <div className="flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Change ${entry}`}
                      className="text-muted-foreground"
                      disabled={action.busy || drafts.length > 0}
                      onClick={() => {
                        setName(entry);
                        setValue("");
                        valueInput.current?.focus();
                      }}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.75} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Change</TooltipContent>
                </Tooltip>
                <AlertDialog>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${entry}`}
                          className="text-muted-foreground hover:text-destructive"
                          disabled={action.busy}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
                        </Button>
                      </AlertDialogTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Remove</TooltipContent>
                  </Tooltip>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {entry}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        It comes off every VM once nothing is running on it. If it was a secret, revoke it at its source too.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => remove(entry)}>
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
          {drafts.length > 0 ? (
            <div className="divide-y bg-muted/30">
              {drafts.map((draft) => (
                <div key={draft.name} className="flex items-center gap-3 py-2 pr-2 pl-3.5">
                  <div className="min-w-0 flex-1">
                    {/* Wrapped, not cut off: pasted names often share a long prefix, and the end is what tells them apart. */}
                    <code className="block font-mono text-sm break-all">{draft.name}</code>
                  </div>
                  {overview.env.includes(draft.name) && <Badge variant="outline">Replaces</Badge>}
                  <span className="text-sm tracking-widest text-faint select-none">••••••</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Leave out ${draft.name}`}
                        className="text-muted-foreground"
                        disabled={action.busy}
                        onClick={() => setDrafts((current) => current.filter((entry) => entry.name !== draft.name))}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Leave out</TooltipContent>
                  </Tooltip>
                </div>
              ))}
              <div className="flex justify-end gap-2 p-3">
                <Button variant="ghost" size="sm" className="h-8" disabled={action.busy} onClick={() => setDrafts([])}>
                  Cancel
                </Button>
                <Button size="sm" className="h-8 px-3" disabled={action.busy} onClick={saveDrafts}>
                  Save {plural(drafts.length, "variable")}
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-col gap-2 bg-muted/30 p-3 sm:flex-row sm:items-start"
              // The fields stay read-only while a save is pending, so clearing them after it cannot drop a newer draft.
              onSubmit={(event) => {
                event.preventDefault();
                if (!key || (exists && value.length === 0)) return;
                void action.run(() => api(`/env/${encodeURIComponent(key)}`, { method: "PUT", body: { value } })).then((ok) => {
                  if (!ok) return;
                  toast.success(`${key} saved. VMs get it as soon as nothing is running on them.`);
                  setName("");
                  setValue("");
                });
              }}
            >
              <Input
                aria-label="Name"
                placeholder="NAME"
                className="h-8 font-mono sm:w-52"
                autoComplete="off"
                spellCheck={false}
                value={name}
                readOnly={action.busy}
                onChange={(event) => setName(event.target.value)}
                onPaste={(event) => pasteMany(event, "name")}
              />
              <Textarea
                ref={valueInput}
                aria-label="Value"
                placeholder={exists ? "New value" : "Value"}
                rows={1}
                className="min-h-8 flex-1 resize-none py-1.5 font-mono"
                autoComplete="off"
                spellCheck={false}
                value={value}
                readOnly={action.busy}
                onChange={(event) => setValue(event.target.value)}
                onPaste={(event) => pasteMany(event, "value")}
              />
              <Button type="submit" size="sm" className="h-8 px-3" disabled={action.busy || !key || (exists && value.length === 0)}>
                {!exists && <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />}
                {exists ? "Save" : "Add"}
              </Button>
            </form>
          )}
        </div>
        {action.error && <FieldError>{action.error}</FieldError>}
        <p className="text-[13px] text-muted-foreground">
          Agents and shells on every VM get these. A VM applies changes once nothing runs on it, or when it wakes.
          {pending > 0 && ` Not applied yet on ${pending} ${pending === 1 ? "VM" : "VMs"}.`}
        </p>
      </div>
    </Section>
  );
}
