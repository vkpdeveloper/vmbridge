import { useEffect, useState } from "react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon, LinkSquare02Icon, Plug01Icon, Robot01Icon } from "@hugeicons/core-free-icons";
import { agentKinds, boatOutcomes, type AgentAuthMethod, type AgentKind, type AgentProfile, type ClaudeLogin, type CodexLogin, type GitHubAccount, type Overview, type ProviderField, type ProviderId, type ProviderInfo, type SelectOption } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { ago, api, elapsed, useTick } from "./api.ts";
import { AgentLogo, ProviderLogo } from "./brand.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Page, Section, type Tab } from "./Page.tsx";
import { Private } from "./Private.tsx";

type AccountsTab = "provider" | "github" | "agents";

const sleepModes = { pause: "Pauses: memory and disk kept", stop: "Stops: disk kept", checkpoint: "Checkpoints: disk kept, new sandbox on wake" };


export function Accounts({ overview }: { overview: Overview }) {
  const tabs: Tab<AccountsTab>[] = [
    { id: "provider", label: "Providers", icon: Plug01Icon, attention: !overview.setup.provider },
    { id: "github", label: "GitHub", icon: GithubIcon, attention: !overview.setup.github },
    { id: "agents", label: "Agent sign-in", icon: Robot01Icon, attention: !overview.setup.agents },
  ];
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(tabs.map((entry) => entry.id)).withDefault(overview.setup.provider ? "agents" : "provider"));
  return (
    <Page title="Accounts" tabs={tabs} tab={tab} onTab={setTab}>
      {tab === "provider" && <Providers overview={overview} />}
      {tab === "github" && <GitHub account={overview.github} />}
      {tab === "agents" && <Agents profiles={overview.agents} />}
    </Page>
  );
}

export function ProviderStatus({ provider }: { provider: ProviderInfo }) {
  const { setup } = provider;
  if (provider.added && setup.state === "building") return <SettingUp startedAt={setup.startedAt} />;
  if (provider.added && setup.state === "failed") return "Setup failed";
  if (provider.problem) return <span className="text-destructive">Needs attention</span>;
  if (provider.isDefault) return "Default";
  if (provider.added) return "Added";
  return provider.configured ? "Ready" : "Not set up";
}

/** Ticks once a second while shown. */
function SettingUp({ startedAt }: { startedAt: number }) {
  const now = useTick(1000);
  return <>Setting up, {elapsed(startedAt, now)}</>;
}

/** The base snapshot new VMs start from: shown once a provider is added, while it builds and after. */
function ProviderSetup({ provider, busy, onRetry }: { provider: ProviderInfo; busy: boolean; onRetry: () => void }) {
  const { setup } = provider;
  const dot = (color: string) => <span className={`size-2 shrink-0 rounded-full ${color}`} />;
  if (setup.state === "building") {
    return (
      <p className="flex items-center gap-2 text-sm text-primary">
        {dot("bg-primary")}
        <SettingUp startedAt={setup.startedAt} />
      </p>
    );
  }
  if (setup.state === "ready") {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        {dot("bg-success")}
        Ready
      </p>
    );
  }
  if (setup.state !== "failed") return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <p className="flex items-start gap-2 text-destructive">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive" />
          <span className="min-w-0 break-words">Setup failed: {setup.reason}</span>
        </p>
        <p className="text-muted-foreground">New VMs here start the slower way until it works.</p>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Every provider, and the chosen one's settings. `bare` leaves out the list's heading, for onboarding's own. */
export function Providers({ overview, bare }: { overview: Overview; bare?: boolean }) {
  const [list, setList] = useState<ProviderInfo[]>([]);
  const [chosen, setChosen] = useState<ProviderId | null>(overview.defaultProvider);
  const load = useAction();
  // Adding, removing or changing the default on one provider changes the others' status too.
  const added = overview.providers.map((provider) => provider.id).join();
  useEffect(() => {
    void load.run(async () => {
      const providers = await api<ProviderInfo[]>("/providers");
      setList(providers);
      setChosen((current) => current ?? providers[0]?.id ?? null);
    });
  }, [added, overview.defaultProvider]);
  // The list loads once per change of providers, while each added provider's setup comes live with the overview.
  const live = list.map((entry) => {
    const added = overview.providers.find((candidate) => candidate.id === entry.id);
    return added ? { ...entry, setup: added.setup, problem: added.problem } : entry;
  });
  // Back from connecting Boat: the server says how it went in the address.
  useEffect(() => {
    const url = new URL(location.href);
    const outcome = url.searchParams.get("boat");
    if (outcome === null) return;
    url.searchParams.delete("boat");
    history.replaceState(history.state, "", url);
    setChosen("boat");
    // Only the words the dashboard knows: anyone can make a link with `?boat=` in it.
    if (outcome === "connected") toast.success(boatOutcomes.connected);
    else if (Object.hasOwn(boatOutcomes, outcome)) toast.error(boatOutcomes[outcome as keyof typeof boatOutcomes]);
  }, []);
  const provider = live.find((entry) => entry.id === chosen);
  const replace = (next: ProviderInfo) => setList((current) => current.map((entry) => (entry.id === next.id ? next : entry)));

  const picker = (
    <>
      <RadioGroup value={chosen ?? ""} onValueChange={(value) => setChosen(value as ProviderId)} className="grid gap-2 sm:grid-cols-2">
        {live.map((entry) => (
          <FieldLabel key={entry.id} htmlFor={`provider-${entry.id}`}>
            <Field orientation="horizontal" className="items-center">
              <ProviderLogo id={entry.id} className="size-9 rounded-lg" />
              <FieldContent>
                <FieldTitle>{entry.label}</FieldTitle>
                <FieldDescription>
                  <ProviderStatus provider={entry} />
                </FieldDescription>
              </FieldContent>
              <RadioGroupItem value={entry.id} id={`provider-${entry.id}`} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      {load.error && <FieldError>{load.error}</FieldError>}
    </>
  );

  return (
    <>
      {bare ? <div className="flex flex-col gap-5">{picker}</div> : <Section title="Providers">{picker}</Section>}
      {provider && <ProviderForm key={provider.id} provider={provider} onSaved={replace} />}
    </>
  );
}

const defaultOption = "__default";

function ProviderForm({ provider, onSaved }: { provider: ProviderInfo; onSaved: (provider: ProviderInfo) => void }) {
  const [values, setValues] = useState<Record<string, string>>(provider.values);
  const [options, setOptions] = useState<Record<string, SelectOption[]>>({});
  const save = useAction();

  const changes = () => Object.fromEntries(provider.fields.flatMap((field) => (values[field.key] === undefined ? [] : [[field.key, values[field.key]!]])));

  const loadOptions = (field: string) =>
    save.run(async () => {
      onSaved(await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: changes() } }));
      const loaded = await api<SelectOption[]>(`/providers/${provider.id}/options?field=${field}`);
      setOptions((current) => ({ ...current, [field]: loaded }));
    });

  const submit = (add: boolean) =>
    save.run(async () => {
      let next = await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: changes() } });
      if (add) next = await api<ProviderInfo>(`/providers/${provider.id}/add`, { body: {} });
      else await api(`/providers/${provider.id}/verify`, { body: {} });
      onSaved(next);
      setValues(next.values);
      toast.success(add ? `${provider.label} added.` : `${provider.label} settings saved and checked.`);
    });

  const clear = (field: ProviderField) =>
    save.run(async () => {
      onSaved(await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: { [field.key]: null } } }));
      toast.success(`${field.label} removed.`);
    });

  const makeDefault = () =>
    save.run(async () => {
      onSaved(await api<ProviderInfo>(`/providers/${provider.id}/default`, { body: {} }));
      toast.success(`New VMs now go to ${provider.label}.`);
    });

  const connect = () =>
    save.run(async () => {
      const { url } = await api<{ url: string }>(`/providers/${provider.id}/connect`, { body: { back: `${location.pathname}${location.search}` } });
      location.assign(url);
    });

  const disconnect = () =>
    save.run(async () => {
      const { provider: next, revoked } = await api<{ provider: ProviderInfo; revoked: boolean }>(`/providers/${provider.id}/disconnect`, { body: {} });
      onSaved(next);
      if (revoked) toast.success(`${provider.label} disconnected.`);
      else toast.warning(`${provider.label} is disconnected here, but ${provider.label} could not be reached to end the access. Remove VM Bridge in your ${provider.label} account settings.`);
    });

  // Signed in, the key's fields are not needed. Saved values stay, and are used again after a disconnect.
  const connected = provider.signIn?.connected === true;
  const fields = provider.fields.filter((field) => !(connected && field.keyOnly));

  const retry = () =>
    save.run(async () => {
      onSaved(await api<ProviderInfo>(`/providers/${provider.id}/setup`, { body: {} }));
    });

  const remove = () =>
    save.run(async () => {
      onSaved(await api<ProviderInfo>(`/providers/${provider.id}`, { method: "DELETE" }));
      toast.success(`${provider.label} removed. Its VMs keep running.`);
    });

  return (
    <Section title={`${provider.label} settings`}>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(!provider.added);
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{sleepModes[provider.features.sleep]}</Badge>
        </div>
        {provider.added && <ProviderSetup provider={provider} busy={save.busy} onRetry={() => void retry()} />}
        {provider.problem && <p className="break-words text-sm text-destructive">{provider.problem}</p>}
        <FieldGroup>
          {provider.signIn && (
            <Field>
              <FieldLabel>Account</FieldLabel>
              {connected ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm">{provider.signIn.account ? <Private>{provider.signIn.account}</Private> : "Connected"}</p>
                  <Button type="button" variant="outline" size="lg" className="px-4" disabled={save.busy} onClick={() => void disconnect()}>
                    Disconnect
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="lg" className="h-9 self-start px-4" disabled={save.busy} onClick={() => void connect()}>
                  Connect {provider.label}
                </Button>
              )}
            </Field>
          )}
          {fields.map((field) => {
            const id = `field-${provider.id}-${field.key}`;
            if (field.kind === "select") {
              // Fixed choices need no Load, and the first stands for an unset value.
              const fixed = field.options;
              const choices = fixed ?? options[field.key] ?? [];
              const current = values[field.key] || (fixed?.[0]?.value ?? defaultOption);
              return (
                <Field key={field.key}>
                  <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                  <div className="flex gap-2">
                    <Select value={current} onValueChange={(value) => setValues({ ...values, [field.key]: value === defaultOption ? "" : value })}>
                      <SelectTrigger id={id} className="flex-1 data-[size=default]:h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {!fixed && <SelectItem value={defaultOption}>{field.required ? "Choose one" : "Default"}</SelectItem>}
                        {current !== defaultOption && !choices.some((choice) => choice.value === current) && <SelectItem value={current}>{current}</SelectItem>}
                        {choices.map((choice) => (
                          <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                            {choice.detail && <span className="text-muted-foreground">({choice.detail})</span>}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!fixed && (
                      <Button type="button" variant="outline" size="lg" className="px-4" disabled={save.busy} onClick={() => void loadOptions(field.key)}>
                        Load
                      </Button>
                    )}
                  </div>
                  {field.help && <FieldDescription>{field.help}</FieldDescription>}
                </Field>
              );
            }
            const isSet = provider.secretsSet.includes(field.key);
            return (
              <Field key={field.key}>
                <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={id}
                    className="h-9 flex-1"
                    type={field.kind === "secret" ? "password" : "text"}
                    autoComplete="off"
                    placeholder={field.kind === "secret" && isSet ? "Saved. Type to replace it." : field.placeholder}
                    value={values[field.key] ?? ""}
                    onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  />
                  {field.kind === "secret" && isSet && !field.required && (
                    <Button type="button" variant="outline" size="lg" className="px-4" disabled={save.busy} onClick={() => void clear(field)}>
                      Remove
                    </Button>
                  )}
                </div>
                {field.help && <FieldDescription>{field.help}</FieldDescription>}
              </Field>
            );
          })}
        </FieldGroup>
        {save.error && <FieldError>{save.error}</FieldError>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="lg" className="h-9 px-4" disabled={save.busy}>
            {provider.added ? "Save" : `Add ${provider.label}`}
          </Button>
          {!provider.added && (
            <Button type="button" variant="outline" size="lg" className="h-9 px-4" disabled={save.busy} onClick={() => void submit(false)}>
              Save and check
            </Button>
          )}
          {provider.added && !provider.isDefault && (
            <Button type="button" variant="outline" size="lg" className="h-9 px-4" disabled={save.busy} onClick={() => void makeDefault()}>
              Make default
            </Button>
          )}
          {provider.added && (
            <Button type="button" variant="ghost" size="lg" className="h-9 px-4 text-destructive" disabled={save.busy} onClick={() => void remove()}>
              Remove
            </Button>
          )}
          <Button asChild variant="link" className="ml-auto text-muted-foreground">
            <a href={provider.website} target="_blank" rel="noreferrer">
              {new URL(provider.website).host}
            </a>
          </Button>
        </div>
      </form>
    </Section>
  );
}

function GitHub({ account }: { account: GitHubAccount | null }) {
  const [token, setToken] = useState("");
  const action = useAction();
  const now = Date.now();
  const expiresSoon = account?.expiresAt != null && account.expiresAt - now < 7 * 24 * 60 * 60_000;
  return (
    <Section title="GitHub">
      {account && (
        <>
          <Item variant="outline">
            <ItemMedia>
              <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{account.name ?? account.login}</ItemTitle>
              <ItemDescription>@{account.login}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" disabled={action.busy} onClick={() => void action.run(() => api("/github/check", { body: {} }))}>
                Check again
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={action.busy}
                onClick={() =>
                  void action
                    .run(() => api("/github", { method: "DELETE" }))
                    .then((ok) => ok && toast.success("GitHub disconnected. Sleeping VMs drop the token when they wake. Revoke it on GitHub too."))
                }
              >
                Disconnect
              </Button>
            </ItemActions>
          </Item>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Commits as</dt>
            <dd className="truncate font-mono text-xs leading-5">
              {account.name ?? account.login} &lt;<Private>{account.email}</Private>&gt;
            </dd>
            <dt className="text-muted-foreground">Token</dt>
            <dd>{account.scopes === null ? "Fine-grained" : `Classic${account.scopes.length ? `: ${account.scopes.join(", ")}` : ", no scopes"}`}</dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd className={expiresSoon ? "text-warning" : undefined}>{account.expiresAt ? dateFormat.format(account.expiresAt) : "Never"}</dd>
            <dt className="text-muted-foreground">Checked</dt>
            <dd>{ago(account.checkedAt, now)}</dd>
          </dl>
        </>
      )}
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/github", { method: "PUT", body: { token } })).then((ok) => {
            if (!ok) return;
            setToken("");
            toast.success("GitHub connected. VMs get it as soon as nothing is running on them.");
          });
        }}
      >
        <Field data-invalid={Boolean(action.error)}>
          <FieldLabel htmlFor="github-token">{account ? "Replace token" : "Personal access token"}</FieldLabel>
          <Input id="github-token" className="h-9" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_..." />
          <FieldDescription>{githubTokenHint}</FieldDescription>
          {action.error && <FieldError>{action.error}</FieldError>}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" className="h-9 px-4" disabled={action.busy || !token.trim()}>
            {account ? "Replace" : "Connect"}
          </Button>
          <Button asChild variant="outline" size="lg" className="h-9 px-4">
            <a href={githubTokenUrl} target="_blank" rel="noreferrer">
              Create a token on GitHub
              <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" strokeWidth={1.75} />
            </a>
          </Button>
        </div>
      </form>
    </Section>
  );
}

/**
 * GitHub's fine-grained token form, with what VMs need already chosen: contents to clone and push, pull requests for
 * `gh pr create`. GitHub cannot preselect repository access, so the hint asks for it.
 */
export const githubTokenUrl = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({ name: "VM Bridge", contents: "write", pull_requests: "write" })}`;
export const githubTokenHint = "Choose All repositories. Contents and pull requests come set to read and write.";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export const agentNames: Record<AgentKind, string> = { codex: "Codex", claude: "Claude", opencode: "OpenCode" };
const methodNames: Record<AgentAuthMethod, string> = {
  chatgpt: "ChatGPT sign-in",
  "setup-token": "Claude account",
  "auth-token": "Auth token",
  "api-key": "API key",
};
const savedToast = "Saved. VMs get it as soon as nothing is running on them.";

function Agents({ profiles }: { profiles: AgentProfile[] }) {
  return agentKinds.map((agent) => <AgentSection key={agent} agent={agent} profiles={profiles.filter((profile) => profile.agent === agent)} />);
}

/** `collapsed` keeps the sign-in form closed until asked for, for onboarding where signing in is optional. */
export function AgentSection({ agent, profiles, collapsed }: { agent: AgentKind; profiles: AgentProfile[]; collapsed?: boolean }) {
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const open = adding || (!collapsed && profiles.length === 0);
  const done = () => setAdding(false);
  const cancel = collapsed || profiles.length ? done : undefined;
  return (
    <Section
      title={agentNames[agent]}
      icon={<AgentLogo agent={agent} className="size-7" />}
      actions={
        !open && (
          <Button variant="outline" size="lg" className="h-9" onClick={() => setAdding(true)}>
            {profiles.length ? "Add sign-in" : "Sign in"}
          </Button>
        )
      }
    >
      {profiles.map((profile) => (
        <Item key={profile.id} variant="outline">
          <ItemContent>
            <ItemTitle>{profile.name}</ItemTitle>
            <ItemDescription className={profile.error ? "text-destructive" : undefined}>
              {profile.error ?? (
                <>
                  {methodNames[profile.method]}
                  {profile.detail && (
                    <>
                      , <Private>{profile.detail}</Private>
                    </>
                  )}
                </>
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {profile.inUse ? (
              <Badge variant="secondary">In use</Badge>
            ) : (
              <Button variant="outline" size="sm" disabled={action.busy} onClick={() => void action.run(() => api(`/agents/${profile.id}/use`, { body: {} }))}>
                Use
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={action.busy}
              onClick={() =>
                void action
                  .run(() => api(`/agents/${profile.id}`, { method: "DELETE" }))
                  .then((ok) => ok && toast.success(`${profile.name} removed. Sleeping VMs drop it when they wake. Revoke it at its source too.`))
              }
            >
              Remove
            </Button>
          </ItemActions>
        </Item>
      ))}
      {action.error && <FieldError>{action.error}</FieldError>}
      {open && (
        <div className="animate-in duration-300 fade-in slide-in-from-top-1 motion-reduce:animate-none">
          {agent === "codex" && <CodexForm onDone={done} onCancel={cancel} />}
          {agent === "claude" && <ClaudeForm onDone={done} onCancel={cancel} />}
          {agent === "opencode" && <OpenCodeForm onDone={done} onCancel={cancel} />}
        </div>
      )}
    </Section>
  );
}

interface FormProps {
  onDone: () => void;
  onCancel?: () => void;
}

function NameField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input id={id} className="h-9" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Personal" autoComplete="off" />
    </Field>
  );
}

function FormButtons({ busy, disabled, label, onCancel }: { busy: boolean; disabled?: boolean; label: string; onCancel?: () => void }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" size="lg" className="h-9 px-4" disabled={busy || disabled}>
        {label}
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" size="lg" className="h-9" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

function CodexForm({ onDone, onCancel }: FormProps) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState<CodexLogin | null>(null);
  const action = useAction();

  // The server finishes the sign-in on its own once the code is approved; this only watches it.
  useEffect(() => {
    if (login?.status !== "pending") return;
    const timer = setInterval(() => {
      void api<CodexLogin>(`/codex-login/${login.id}`).then(
        (next) => {
          if (next.status === "pending") return;
          setLogin(null);
          if (next.status === "done") {
            toast.success(savedToast);
            onDone();
          } else action.setError(next.error ?? "The sign-in failed.");
        },
        (error: unknown) => {
          setLogin(null);
          action.setError(error instanceof Error ? error.message : String(error));
        },
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [login?.id, login?.status]);

  if (login) {
    return (
      <Item variant="muted" className="flex-col items-stretch gap-4 sm:flex-row sm:items-center">
        <ItemContent>
          <ItemDescription>Open the link, sign in to ChatGPT, and enter this code.</ItemDescription>
          <div className="flex items-center gap-1">
            <span className="font-mono text-2xl font-semibold tracking-widest">{login.userCode}</span>
            <CopyButton value={login.userCode} label="Copy code" />
          </div>
        </ItemContent>
        <ItemActions>
          <Button asChild size="lg" className="h-9">
            <a href={login.verificationUrl} target="_blank" rel="noreferrer">
              Open {new URL(login.verificationUrl).host}
              <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" strokeWidth={1.75} />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="h-9"
            onClick={() => {
              void api(`/codex-login/${login.id}`, { method: "DELETE" }).catch(() => {});
              setLogin(null);
            }}
          >
            Cancel
          </Button>
        </ItemActions>
      </Item>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => setLogin(await api<CodexLogin>("/codex-login", { body: { name: name.trim() } })));
      }}
    >
      <NameField id="codex-name" value={name} onChange={setName} />
      {action.error && <FieldError>{action.error}</FieldError>}
      <FormButtons busy={action.busy} label="Sign in with ChatGPT" onCancel={onCancel} />
    </form>
  );
}

function ClaudeForm({ onDone, onCancel }: FormProps) {
  const [method, setMethod] = useState<"sign-in" | "auth-token">("sign-in");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [code, setCode] = useState("");
  const action = useAction();
  const methods = [
    { id: "sign-in", title: "Claude account", description: "Sign in on claude.ai" },
    { id: "auth-token", title: "Auth token", description: "For a proxy or an Anthropic-compatible API" },
  ] as const;
  const saved = (ok: boolean) => {
    if (!ok) return;
    toast.success(savedToast);
    onDone();
  };

  if (login) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void action
            .run(async () => {
              try {
                await api(`/claude-login/${login.id}`, { body: { code: code.trim(), name: name.trim() } });
              } catch (error) {
                // The server ends a sign-in once Claude sees its code, so the next try starts fresh.
                setLogin(null);
                setCode("");
                throw error;
              }
            })
            .then(saved);
        }}
      >
        <Field data-invalid={Boolean(action.error)}>
          <FieldLabel htmlFor="claude-code">Code from Claude</FieldLabel>
          <Input id="claude-code" className="h-9" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} />
          <FieldDescription>Approve on claude.ai, then paste the code it shows.</FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="lg" className="h-9 px-4">
            <a href={login.url} target="_blank" rel="noreferrer">
              Open claude.ai
              <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" strokeWidth={1.75} />
            </a>
          </Button>
          <Button type="submit" size="lg" className="h-9 px-4" disabled={action.busy || !code.trim()}>
            Check and save
          </Button>
          <Button type="button" variant="ghost" size="lg" className="h-9" onClick={() => setLogin(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (method === "sign-in") {
          // Opened here, inside the click, so browsers don't block the tab.
          const tab = window.open("", "_blank");
          void action.run(async () => {
            try {
              const next = await api<ClaudeLogin>("/claude-login", { body: {} });
              if (tab) tab.location.href = next.url;
              setLogin(next);
            } catch (error) {
              tab?.close();
              throw error;
            }
          });
          return;
        }
        const body = { agent: "claude", method, name: name.trim(), token, baseUrl: baseUrl.trim() || null };
        void action.run(() => api("/agents", { body })).then(saved);
      }}
    >
      <RadioGroup value={method} onValueChange={(value) => setMethod(value as typeof method)} className="grid gap-2 sm:grid-cols-2">
        {methods.map((entry) => (
          <FieldLabel key={entry.id} htmlFor={`claude-${entry.id}`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{entry.title}</FieldTitle>
                <FieldDescription>{entry.description}</FieldDescription>
              </FieldContent>
              <RadioGroupItem value={entry.id} id={`claude-${entry.id}`} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      <FieldGroup>
        <NameField id="claude-name" value={name} onChange={setName} />
        {method === "auth-token" && (
          <>
            <Field data-invalid={Boolean(action.error)}>
              <FieldLabel htmlFor="claude-token">ANTHROPIC_AUTH_TOKEN</FieldLabel>
              <Input id="claude-token" className="h-9" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="claude-base-url">ANTHROPIC_BASE_URL</FieldLabel>
              <Input id="claude-base-url" className="h-9" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.anthropic.com" autoComplete="off" />
            </Field>
          </>
        )}
      </FieldGroup>
      {action.error && <FieldError>{action.error}</FieldError>}
      <FormButtons
        busy={action.busy}
        disabled={method === "auth-token" && !token.trim()}
        label={method === "sign-in" ? "Sign in with Claude" : "Check and save"}
        onCancel={onCancel}
      />
    </form>
  );
}

function OpenCodeForm({ onDone, onCancel }: FormProps) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const action = useAction();
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(() => api("/agents", { body: { agent: "opencode", method: "api-key", name: name.trim(), token } })).then((ok) => {
          if (!ok) return;
          toast.success(savedToast);
          onDone();
        });
      }}
    >
      <FieldGroup>
        <NameField id="opencode-name" value={name} onChange={setName} />
        <Field data-invalid={Boolean(action.error)}>
          <FieldLabel htmlFor="opencode-key">API key</FieldLabel>
          <Input id="opencode-key" className="h-9" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
        </Field>
      </FieldGroup>
      {action.error && <FieldError>{action.error}</FieldError>}
      <FormButtons busy={action.busy} disabled={!token.trim()} label="Check and save" onCancel={onCancel} />
    </form>
  );
}
