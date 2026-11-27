# T3 protocol findings

T3's protocol assumes one client talks to one long-lived server on one machine, so most of VM Bridge's gateway code exists to make many sleeping servers look like one. No outright T3 bug was confirmed; below are 12 limitations ordered by how much bridge code or risk they cause, each with a change to T3 that would remove the workaround.

Checked against the T3 Code source at commit `a4eadbcdce` (2026-11-21). VMs run the npm `t3` release VM Bridge pins or resolves, which can differ from that commit. T3 paths below are relative to the T3 Code repository; VM Bridge paths are relative to this one.

## Findings

### 1. The shell stream sends a "snapshot" that is not a snapshot

Limitation. Caused real data loss in VM Bridge.

**What T3 does.** After the first shell snapshot, and at the start of every resume, `orchestration.subscribeShell` sends a second item with `kind: "snapshot"` whose `threads` and `archivedThreads` are always empty. It only refreshes project repository details. The one thing that marks it is the optional `resolvedRepositoryIdentityRoots` field. See `loadProjectMetadataSnapshot` in `apps/server/src/ws.ts:1164`, the resume path around `apps/server/src/ws.ts:1374`, and the stream item schema in `packages/contracts/src/orchestrationV2.ts:2442`. T3's own client only treats a snapshot as complete when that field is absent (`packages/client-runtime/src/state/shell.ts:381`).

**Why it matters.** Any consumer that trusts `kind` drops every thread. VM Bridge did exactly that: each VM wake emptied that VM's threads in the sidebar until one of them changed (commit `c9d1e4d`).

**What VM Bridge does.** `Hub.applyShell` checks for `resolvedRepositoryIdentityRoots` and copies only `repositoryIdentity` from matching projects (`apps/server/src/gateway/hub.ts:158`).

**Suggested change.** Give it its own kind, for example `kind: "projects.enriched"` with just the projects, so `snapshot` always means the full shell.

### 2. Sequence numbers belong to one server and carry no identity

Limitation.

**What T3 does.** `snapshotSequence`, the `sequence` on stream items, and the `afterSequence` resume cursor are one counter per server database (`latestApplicationSequence` in `apps/server/src/orchestration-v2/EventStore.ts:71`). Resume compares the cursor to that counter and replays from it (`apps/server/src/ws.ts:1039` for threads, `apps/server/src/ws.ts:1374` for the shell). Nothing in the cursor says which server or database issued it. A cursor above the server's high-water mark falls back to a snapshot; a cursor from a different server that happens to be lower is replayed as if it were valid.

**Why it matters.** A bridge that merges several servers cannot pass a client's cursor through, and cannot offer resume at all. Every reconnect costs full snapshots. The same gap would hit T3 if a client ever reused a cursor against a restored or replaced database with a lower but non-zero sequence.

**What VM Bridge does.** It keeps its own fleet-wide shell counter (`Hub.bump`, `apps/server/src/gateway/hub.ts:113`), always answers shell subscriptions with a full snapshot (`apps/server/src/gateway/rpc.ts:91`), and strips `afterSequence` before forwarding `orchestration.subscribeThread` (`apps/server/src/gateway/rpc.ts:436`).

**Suggested change.** Make cursors opaque and scoped, for example `{ epoch, sequence }` where `epoch` is a per-database ID, and answer a cursor with a foreign epoch with a snapshot (or `snapshot-required`).

### 3. Absolute host paths are part of the protocol

Limitation.

**What T3 does.** Projects, threads, VCS calls and file calls identify things by absolute paths on the server's machine: `workspaceRoot`, `worktreePath`, `cwd`, and the path list `resolvedRepositoryIdentityRoots`. `filesystem.getMetadata` says so directly: "Absolute host paths, including ~/" (`packages/contracts/src/filesystem.ts:9`). `vcs.listRefs` and `vcs.refreshStatus` take only a `cwd` (`packages/contracts/src/git.ts:111`, `packages/contracts/src/git.ts:147`). The compact wire options (`compactIds`, `compactTurnItems`, `dedupeBodies` in `packages/contracts/src/environmentHttp.ts:743`, and the ID table in `packages/contracts/src/orchestrationV2IdTable.ts:95`) move values into side tables.

**Why it matters.** Two VMs both clone into `/workspace/...`, so their paths collide. A bridge must rewrite every path in both directions, and must decide what is a path from the field name. The compact encodings hide values from that rewrite, so the bridge has to turn them off and pay for larger payloads.

**What VM Bridge does.** It shows clients one virtual machine (`/projects/<id>/<name>` and `/vms/<vmId>/...`) and rewrites any string under a key that looks like a path (`isPathKey` and `translate` in `apps/server/src/gateway/paths.ts:10` and `apps/server/src/gateway/paths.ts:25`). It turns off compact IDs, compact turn items, deduped bodies, bounded snapshots and deferred work on thread streams (`apps/server/src/gateway/rpc.ts:428`) and removes the compact query flags from HTTP thread reads (`apps/server/src/gateway/http.ts:179`). Guessing by key name is unsafe where keys are free-form: the `values` of a `secrets.answerRequest` are keyed by the agent's own field names, so VM Bridge sends answers to agents' cards to the thread's VM without any rewrite or payload-wide routing (`Rpc.answerCard` in `apps/server/src/gateway/rpc.ts`).

**Suggested change.** Let requests address files by `projectId` (or `threadId`) plus a relative path, and return paths relative to the project root alongside the absolute ones. At minimum, mark path fields in the schema so tools do not have to guess from key names.

### 4. Many requests do not say which thread or project they belong to

Limitation.

**What T3 does.** Some calls carry a `threadId` or `projectId`, others only a `cwd`, a list of `paths`, or a `runId`. Examples: `VcsStatusInput` and `VcsListRefsInput` (`packages/contracts/src/git.ts:111`, `packages/contracts/src/git.ts:147`) and `FilesystemGetMetadataInput`, whose `paths` can point into different projects (`packages/contracts/src/filesystem.ts:8`).

**Why it matters.** For one server this is fine. For a bridge, every request must be routed to the VM that owns it, so routing has to be reverse engineered from payload contents, including a scan of every cached shell to find which VM owns a `runId`.

**What VM Bridge does.** `Hub.targets` walks the whole payload looking for thread IDs, project IDs, path-like keys and run IDs (`apps/server/src/gateway/hub.ts:515`); `Hub.route` refuses requests that name zero or several VMs (`apps/server/src/gateway/hub.ts:549`). `filesystem.getMetadata` is split into one call per path (`apps/server/src/gateway/rpc.ts:281`).

**Suggested change.** Include `projectId` or `threadId` on every request that acts on a project or thread, even when the server could work it out from a path.

### 5. Command retries are only safe on the same server, and launch IDs can be minted server-side

Limitation.

**What T3 does.** `orchestration.launchThread` requires a `commandId` but `threadId` is optional (`packages/contracts/src/orchestrationV2.ts:3988`). The server deduplicates retries through command receipts in its own database and allocates a thread ID when none was sent (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:1278`).

**Why it matters.** A bridge has to choose a VM before T3 sees the command, and may create a VM to do it. If a retry landed on a different VM, that VM's receipts would not know the command and would start a second thread. The bridge also needs the thread ID before forwarding so later requests can be routed, which means it cannot let T3 mint it.

**What VM Bridge does.** `Hub.prepare` stores each `commandId` with a hash of the request, the chosen VM and the thread ID in one insert, rejects a reused ID with different content, and mints the thread ID itself when the client did not send one (`apps/server/src/gateway/hub.ts:576`, minting at `apps/server/src/gateway/hub.ts:597`; concurrency fix in commit `e23282c`).

**Suggested change.** Have clients always send `threadId` on launch, and document that `commandId` deduplication is per server.

### 6. There is no way to say "this environment is waking up"

Limitation.

**What T3 does.** The protocol has no state for an environment that is reachable but whose work is not ready yet. Reads either answer or fail. A generic failure arrives as an Effect "Die" defect, and T3's client does not retry a stream that ends that way: it parks the stream until the next session or fails it (`packages/client-runtime/src/rpc/client.ts:456`). Setup progress (`WorktreeSetupSnapshot`, `packages/contracts/src/worktreeSetup.ts:43`) only exists once a server is working on the thread.

**Why it matters.** A VM that sleeps after idling, or takes a minute to create and clone, has no honest way to tell the client what is happening. Without help, opening a sleeping thread would fail and stay failed.

**What VM Bridge does.** It caches each thread's projection and serves it while the VM sleeps, over both RPC and HTTP (`apps/server/src/gateway/rpc.ts:418`, `apps/server/src/gateway/http.ts:163`). It injects a synthetic `system_notice` turn item into the cached projection of every thread on a VM from the moment any wake of it starts, early or message-driven, until it connects (`Hub.showWake` and `Hub.sleepingProjection`, `apps/server/src/gateway/hub.ts:1109`; `Fleet` emits `waking` and `wakeFailed`). T3 renders it as a work row with the info icon (`TimelineWorkEntryRow.logic.ts:161`), the only per-thread status line an unchanged client shows: its banners are for agent status and thread errors. Every client streaming the thread gets a fresh snapshot with it. It reads "Waking the boxd VM, about 5 s", from the median of the provider's last five recorded wakes, or with no number when there are none; a reconnect to a VM that kept running says "Reconnecting". A failed wake turns the same row into an error ("Could not wake the boxd VM: ...") until the next wake starts. It reports VM placement through fake worktree setup snapshots with a single `checkout` stage, then offsets the VM's own snapshot sequence so T3's "newer sequence wins" rule keeps working (`apps/server/src/gateway/rpc.ts:378`, `Hub.reportSetup` at `apps/server/src/gateway/hub.ts:625`; T3's rule is in `packages/client-runtime/src/worktreeSetup.ts:10`).

A wake takes seconds, so VM Bridge starts one in the background as soon as a client shows the user is about to work in a sleeping VM's thread, and answers the call that showed it as fast as before (`Hub.prewake`, `apps/server/src/gateway/hub.ts:1078`). Four calls start it. Opening a thread: `thread.visit` with `opened: true`, which T3's web client sends as the user opens a thread while its window is visible and focused, at most once per thread every 10 minutes (`claimThreadOpen`, `packages/client-runtime/src/state/threadSearch.ts:37`); the visits it repeats while the thread stays open carry no `opened` and wake nothing. Typing: `server.refreshProviders` with a `cwd`, sent on a key typed in a composer when the workspace's agent snapshot is more than 5 minutes old, as it is on a VM that slept after its idle minutes (`apps/web/src/components/chat/ChatComposer.tsx:1822`, `packages/client-runtime/src/providerSkills.ts:188`); one without a `cwd`, as from the model picker, wakes nothing. Searching files with "@" in a composer: `projects.searchEntries` with the workspace `cwd` (`apps/web/src/state/queries.ts:307`), answered as before while the VM wakes, from the repository's cached file list on GitHub or else with the VM-asleep error. Attaching a file: `attachments.createUploadUrl` names no thread (`packages/contracts/src/assets.ts:110`), so VM Bridge wakes the VM of the thread that the same device session last sent a `thread.visit` for, if any (`Rpc.visitedThreads`, `apps/server/src/gateway/rpc.ts:99`): T3 only sends visits while the user is looking at the thread. None wakes a VM that is awake, already waking or failed, the VM of an archived thread, or anything for a thread no VM holds yet. The early wake holds no lease: connecting marks the VM active, so if no message follows, the idle sweep puts it back to sleep after the usual idle minutes. A message sent while it runs shares the same wake (`Fleet.ensure`).

**Suggested change.** An environment status stream item (for example `starting`, `ready`, `unavailable` with a message) and a typed, retryable error for "not ready yet", so streams retry instead of parking.

### 7. Sidebar state lives with the agent's server

Limitation.

**What T3 does.** Settle, unsettle, auto-settle, snooze, unsnooze, pin, unpin, archive and unarchive are orchestration commands checked and applied by the same server that runs the agent (`dispatchThreadMutation`, `apps/server/src/orchestration-v2/Orchestrator.ts:4465`). `thread.auto-settle` is rejected if the thread changed after `snapshotAt` or has an explicit override (`packages/contracts/src/orchestrationV2.ts:3406`, `apps/server/src/orchestration-v2/Orchestrator.ts:16051`). So are the commands that only change how a thread looks or which settings its next turn uses: opening a thread (`thread.visit`, `dispatchThreadVisit`), `thread.mark-unread`, renaming (`thread.metadata.update` with a `title`), the access, interaction mode and model pickers (`thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.model-selection.set`) and `thread.delete` (at `v0.1.12`: `apps/server/src/orchestration-v2/Orchestrator.ts:4206`, `:4458` and `:16086`; `packages/contracts/src/orchestrationV2.ts:3388` and `:3481`). T3's web client opens a thread with `thread.visit`, and sends the access and interaction mode it picked as their own commands just before a message, waiting for each and stopping at a failure (`persistThreadSettingsForNextTurn`, `apps/web/src/components/ChatView.tsx:2197`). Before it deletes a thread, it detaches each of the thread's agent sessions with `provider-session.detach` and waits for that too (`apps/web/src/hooks/useThreadActions.ts:613`, `stopThreadSession` in `packages/client-runtime/src/operations/commands.ts:1102`). The client that sends one moves the thread at once and keeps that until the server's shell reaches the sequence the dispatch answered with; every other client waits for the server's shell to change.

**Why it matters.** Filing a thread is a client concern, but it requires the execution machine. For a bridge that means waking a VM, or failing, just to flip a sidebar flag or record that a thread was opened, and waiting for a round trip to a remote VM even when it is awake. A thread whose VM was deleted can never be archived.

**What VM Bridge does.** It answers these commands itself and applies them to its merged shell at once, whether the VM is awake or asleep, then sends them to the VM in the background, one at a time and in order: right away when the VM is connected, at its next connect when it is not. None of them waits for a VM to wake, and only opening a thread starts waking one, in the background (finding 6) (`isHeldCommand`, `apps/server/src/gateway/held.ts:35`, `Hub.holdCommand` and `Hub.replayHeld` at `apps/server/src/gateway/hub.ts:343` and `apps/server/src/gateway/hub.ts:365`). A metadata update is held only when it does nothing but rename, and a delete only when it is not `onlyIfUnused`, which T3 checks against messages VM Bridge cannot see; the others go to the VM as before. A `provider-session.detach` for a thread whose VM is not connected is held the same way, so deleting a thread on a sleeping VM does not wake it for the detach before it; a connected VM gets a detach straight away, as any stop (`Rpc.detachesAway`, `apps/server/src/gateway/rpc.ts:841`). It keeps each VM's shell as the VM reported it and lays the commands the VM has not shown yet over it (`Hub.overlay`, `apps/server/src/gateway/hub.ts:426`); a held delete hides the thread and its side chats. A command T3 rejects is dropped, so the thread shows the VM's real state again, and a refused delete brings the thread back. One T3 accepts stays laid over until the VM's shell reaches the sequence T3 answered with, so the VM's echo does not make the thread flicker (`Hub.dropShown`, `apps/server/src/gateway/hub.ts:412`). The answer carries VM Bridge's own shell sequence, the one its clients follow, not the VM's. A lost answer keeps the command for the next try. Any other command that changes something, a message above all, waits until the VM has been sent what VM Bridge holds for it, so it reaches T3 after them as it would have without VM Bridge; a message whose thread had a held setting refused, in that replay or an earlier background one, fails instead of running with the old one. A refusal counts until that thread's next message, which it fails, or until a newer change to the same setting is accepted (`Hub.afterHeld`, `apps/server/src/gateway/hub.ts:403`, called from `Rpc.forward`). A delete leaves VM Bridge's own records for the thread (its VM, cached projection) as they are, as a delete sent straight to the VM always has. `applyHeldCommand` mirrors T3's reducer, including the auto-settle rule, the commands T3 refuses for an archived thread, visits that do not move the read mark forward, mark unread without a finished run, empty titles, and moving a running thread to another agent, so it must be kept in step with T3 by hand. Refusals that depend on state only the VM has, such as background work a mode change would end, show as the thread going back once the VM refuses. The open counts T3 keeps for search ranking show once the VM reports them.

**Suggested change.** Export the thread filing reducer from `@t3tools/contracts` (or a shared package) so other implementations reuse it instead of copying it, and treat archive of an already archived thread as a no-op rather than an error.

### 8. Server config mixes one machine's details with environment settings

Limitation.

**What T3 does.** `ServerConfig` (`packages/contracts/src/server.ts:703`) carries machine details (`cwd`, `hostname`, `homeDirectory`, `keybindingsConfigPath`, `directEndpoints`), the provider list, the full settings object (including secret provider and text generator settings), and feature flags, all in one value. Some flags exist both here and in the environment descriptor's capabilities (`shellThreadFamilies` and `shellOlderSettled`, `packages/contracts/src/server.ts:731` and `packages/contracts/src/environment.ts:215`).

**Why it matters.** A bridge must take one VM's config, then remove or replace the parts that describe that VM or its credentials, and set each flag to what the bridge itself supports. Every new config field is a new decision, and a missed one can leak a VM's details to the client.

**What VM Bridge does.** `Hub.config` copies the first VM's config, replaces `environment`, `auth`, `providers` and `providerInstances`, empties `secretProviders`, `usageLimitSources` and `textGenerators`, deletes `directEndpoints`, and sets `shellResumeCompletionMarker`, `shellThreadFamilies`, `shellOlderSettled` and `threadSnapshotPagination` itself (`apps/server/src/gateway/hub.ts:312`). It also lays its own saved state over the copy: keyboard shortcuts saved from T3 (`apps/server/src/gateway/keybindings.ts`) over the VM's defaults, and the settings in `fleetSettingKeys` (`apps/server/src/gateway/fleet-settings.ts`), which it also sets on every VM. That is what lets it grant `settings:write`: one scope covers every settings write, so the gateway refuses the settings it can't save by name rather than leaving all of them read-only.

**Suggested change.** Split config into environment-level settings and capabilities versus host details, and keep each capability flag in one place.

### 9. The protocol version does not describe the wire

Limitation.

**What T3 does.** `orchestrationProtocolVersion` is a single integer checked by exact match, on the descriptor and on the `/ws` query string (`packages/contracts/src/environment.ts:13`, `apps/server/src/ws.ts:799`, `packages/client-runtime/src/connection/compatibility.ts:13`). It has stayed at 2 while the wire kept changing through optional fields ("Older servers omit it", `packages/contracts/src/orchestrationV2.ts:4015`) and dozens of capability flags (`ServerConfig` in `packages/contracts/src/server.ts:726` onward, `ExecutionEnvironmentCapabilities` in `packages/contracts/src/environment.ts:86`).

**Why it matters.** Matching the version number says little about whether a bridge and a client agree. A bridge has to track T3 releases one by one and test each.

**What VM Bridge does.** It requires version 2 from clients and from each VM, refusing a VM that reports anything else (`apps/server/src/gateway/http.ts:96`, `apps/server/src/gateway/hub.ts:121`), and pins or resolves the exact npm `t3` version it installs (`resolveT3Version`, `apps/server/src/vm/runtime.ts:158`).

**Suggested change.** Publish a changelog of wire changes per release, and consider a minor version alongside the integer so a peer can say which optional features it speaks.

### 10. Which RPCs read and which change state is not in the contract

Limitation.

**What T3 does.** The full method-to-scope map, which tells reads (`orchestration:read`) from changes (`orchestration:operate`), lives in the server: `RPC_REQUIRED_SCOPES` in `apps/server/src/auth/RpcAuthorization.ts:44`. The contracts package exports only a subset, `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts:19`).

**Why it matters.** A bridge must decide per request whether it may wake a VM (a change) or should answer from cache (a read). Without the map it guesses.

**What VM Bridge does.** It guesses from method names with regular expressions (`forwardable` and `mutation` in `apps/server/src/gateway/rpc.ts:48` and `apps/server/src/gateway/rpc.ts:49`). A new T3 method that changes state but does not match the pattern would be treated as a read.

**Suggested change.** Move the full scope map into `@t3tools/contracts`, next to the RPC definitions.

### 11. Each RPC has its own error shape

Limitation.

**What T3 does.** Failures are tagged errors with method-specific required fields, for example `OrchestrationV2DispatchCommandError` needs `commandId` and `commandType`, and `OrchestrationV2ThreadLaunchError` needs `commandId` and `projectId` (`packages/contracts/src/orchestrationV2.ts:4291`, `packages/contracts/src/orchestrationV2.ts:4319`). There is no shared "this request failed, here is why" error, so anything else becomes a defect (see finding 6).

**Why it matters.** For an error the bridge produces itself (no VM capacity, provider down), it has to build the right tagged error for each method or fall back to a defect the client handles worse.

**What VM Bridge does.** `Rpc.fail` hand-builds the tagged error for launch, dispatch, provider update and scheduled task calls, and sends a defect for the rest (`apps/server/src/gateway/rpc.ts:169`). Other handlers build `FilesystemBrowseError`, `GitCommandError`, `SourceControlRepositoryError` and `ServerSettingsError` the same way.

**Suggested change.** A common error type every RPC accepts, with a code, a message and an optional retry hint.

### 12. The wire format is Effect RPC's internal JSON

Limitation. Caused a connection outage in VM Bridge.

**What T3 does.** The socket speaks Effect RPC's JSON framing as-is. Request IDs come from a numeric counter in the client and replies are matched by value, so a reply with `"1"` does not match request `1` (effect 4.1.3 `rpc/RpcClient.ts:208` and `rpc/RpcClient.ts:262`). Streams wait for an `Ack` after each `Chunk` before sending the next (`rpc/RpcClient.ts:570`). None of this is documented by T3.

**Why it matters.** Any non-Effect peer has to rediscover these rules. VM Bridge replied with string IDs, and newer T3 clients never saw their first config snapshot and timed out during connection setup (commit `bfa2401`).

**What VM Bridge does.** It echoes request IDs with the type they arrived with (`apps/server/src/gateway/rpc.ts:21`) and sends an `Ack` for every chunk it receives from a VM (`apps/server/src/vm/backend.ts:132`).

**Suggested change.** Document the framing T3 depends on (frame tags, ID matching, Ack and Interrupt) in the contracts package, or pin it with a small conformance test peers can run.

## Checked and not reported

- **Stale `server-runtime.json` blocking startup.** VM Bridge's start script deletes a runtime record whose PID is dead or reused (`apps/server/src/vm/runtime.ts:141`). Current T3 uses an ownership lock and only applies the PID check to records without an `ownerId`, with a start-time check for reused PIDs (`apps/server/src/serverOwnership.ts:244`). Not a current T3 issue; the workaround may still matter for older npm releases.
- **T3 not re-checking agent versions after a wake.** VM Bridge calls `server.refreshProviders` on every VM connect (`apps/server/src/gateway/hub.ts:154`, commit `1f9aa88`). I could not confirm from T3's source which agents it re-checks on its own, so this is left out.

## What VM Bridge relies on

A T3 change to any of these would break VM Bridge.

- **Discovery and auth:** `GET /.well-known/t3/environment` (`orchestrationProtocolVersion`, `serverVersion`); `t3 auth session issue --base-dir --ttl --label --token-only` to mint VM Bridge's session on each VM; `POST /api/auth/websocket-ticket/rpc`; `/ws?orchestrationProtocol=2&wsTicket=...`; the `x-t3-orchestration-protocol: 2` header; the token exchange grant and token type URNs at `/oauth/token`; the `/api/auth/session` response shape.
- **Wire framing:** Effect RPC JSON frames `Request`, `Chunk`, `Exit`, `Ack`, `Interrupt`, `Ping` and `Pong`; request IDs echoed with their original type; one `Ack` per chunk; a `void` success encoded as `value: null` (clients reject an `Exit` with no `value` key).
- **Routing fields:** `threadId`, `parentThreadId`, `sourceThreadId`, `projectId`, `runId`, `commandId`, and path fields recognised by name (`cwd`, `path`, `paths`, `root`, and names ending in `Path`, `Root`, `Directory` or `Dir`).
- **Shell:** `orchestration.subscribeShell` item kinds (`snapshot`, `project.updated`, `project.removed`, `thread.updated`, `thread.removed`, `synchronized`), `location: "archive"`, `snapshotSequence`, the `resolvedRepositoryIdentityRoots` enrichment marker, and `GET /api/orchestration/shell`.
- **Threads:** `orchestration.subscribeThread` with its `accept*` opt-out flags and `snapshot` and `event` items; `orchestration.getThreadProjection`; the HTTP thread routes (`/api/orchestration/threads/:id`, `/bounded`, `/history`, `/transcript`) and their `compactIds`, `compactTurnItems` and `dedupeBodies` query flags.
- **Idle detection:** thread fields `activeRunId`, `pendingRuntimeRequest`, `status` and `activityRunStatus` with the values `preparing`, `queued`, `starting`, `running`, `waiting` and `pending`.
- **Commands:** `orchestration.dispatchCommand` with `thread.settle`, `thread.auto-settle`, `thread.unsettle`, `thread.snooze`, `thread.unsnooze`, `thread.pin`, `thread.unpin`, `thread.archive`, `thread.unarchive`, `thread.visit`, `thread.mark-unread`, `thread.metadata.update` (renames), `thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.model-selection.set` and `thread.delete`, and their reducer rules; `provider-session.detach`, which the web client sends before a delete; the shell fields they change (`lastVisitedAt`, `latestRunCompletedAt`, `title`, `runtimeMode`, `interactionMode`, `providerInstanceId`, `modelSelection`, `lineage.sideChat`); `orchestration.launchThread` with `workspaceStrategy` types `root` and `worktree`.
- **Config and agents:** `server.getConfig`; `subscribeServerConfig` events `snapshot` and `providerStatuses` with the `providerCatalogsOnDemand`, `providerCatalogDigests` and `providerStatusDeltas` opt-outs; provider `versionAdvisory` (`status: "behind_latest"`, `canUpdate`, `updateCommand`); `server.refreshProviders`; `server.updateProvider`.
- **Thread search:** `orchestration.searchThreads` input `query` and `limit` (50 when absent), result `matches` with `threadId`, `source`, `quality` and `messageCreatedAt`, ranked as T3 ranks them (quality, then user messages, then newest), and the `OrchestrationSearchThreadsError` tag. VM Bridge asks every awake VM and merges.
- **Pull requests:** `pullRequests.*` calls routed by `projectId` or `projectIds`; the `pullRequests.list` result (`viewers`, `providers` with `host`, `projectCount`, `projectIds`, `configured` and `detail`, `entries` with `updatedAt`, `errors` with `projectId`, `projectTitle` and `message`, `truncated` and `nextCursors`), merged across VMs; `pullRequests.subscribeRefreshes` and `pullRequests.subscribeLinkedThreadRefreshes` as streams of increasing numbers.
- **Diffs and source control:** the `review.getDiffPreview` result (`cwd`, `generatedAt`, `sources`), answered with no sources for a project with no awake checkout; a non-blank `installHint` in `server.discoverSourceControl`; the `subscribeDiscoveredLocalServers` item shape (`servers`, `scannedAt`).
- **Agents' browser tabs:** the `preview:operate` scope and the descriptor's `capabilities.serverBrowser`, without which clients show no tabs; `subscribePreviewEvents` events and their `threadId`; `preview.list` (answered at once with no tabs for a draft thread or a sleeping VM), `preview.open`, `preview.resize`, `preview.adjust`, `preview.close` and `preview.reportProfiles`, with `preview.open` also used to reopen tabs a restarted server lost; `POST /api/auth/websocket-ticket/media`; `/api/preview-stream/ws` with its `threadId`, `tabId`, `maxWidth`, `maxHeight`, `quality` and `interactive` parameters, and close code 4404 for a tab that is gone.
- **Attachments:** `attachments.createUploadUrl` (no thread in the request, so VM Bridge takes the upload itself), `attachments.delete`, `POST /api/attachments/upload/:token` with the exact byte count, and T3's pending ID form `pending-<uuid>[-<ext>]`, which VM Bridge replaces with the VM's own pending ID in any command that names it; stored attachment IDs that start with the thread ID made safe (`toSafeThreadAttachmentSegment`), which is how an attachment finds its VM; the descriptor's `attachmentUploads`, `questionAttachments` and `fileAttachments.maxUploadBytes`.
- **Secret requests:** `secrets.answerRequest` with `threadId`, `turnItemId` and an `answer` of type `save` (`secret`, or `values` by field name), `decline` or `reference`, answered with `null`; the `SecretRequestError` tag with the reasons `not_found` and `agent_stopped`, which VM Bridge sends itself for a thread no VM holds and for a sleeping VM's thread. T3 refuses an answer for a run that has ended with `agent_stopped`, and a VM only sleeps once its runs have ended, so answering never wakes a VM. VM Bridge never stores, records or logs the answer; its traffic log keeps the method name, VM and status only. Reference answers name a secret provider on the VM's own server, which VM Bridge hides from clients (finding 8), so clients only send typed answers.
- **Feedback cards:** `agentFeedback.answerRequest` with `threadId`, `turnItemId`, an `answer` of `send` or `decline` and an optional `includeConversation`, answered with `null`; the `AgentFeedbackRequestError` tag with the reason `not_found`, which VM Bridge sends itself for a thread no VM holds. It goes through `Rpc.answerCard` like a secret answer. Unlike a secret request, T3 keeps a feedback card answerable after its run ends and after a restart, so answering one for a sleeping VM's thread wakes that VM. VM Bridge records the method name, VM and status only. A VM's T3 only shows these cards when its own `agentFeedback.mode` is not `off`, its default; VM Bridge does not offer that setting to clients.
- **Assets:** `assets.createUrl` and its `relativeUrl` form `/api/assets/<token>/<name>`, which VM Bridge serves as `/api/assets/<vmId>.<token>/<name>` and relays to that VM with the `range` header; the `AssetAttachmentNotFoundError` tag, which tells a client to upload again; T3's `sandbox` content security policy on HTML it serves, which VM Bridge adds where a VM leaves it out.
- **Other streams and snapshots:** `scheduledTasks.subscribe`; the `WorktreeSetupSnapshot` and project clone snapshot shapes, including their `sequence` fields.
- **Errors:** the tagged error names and fields VM Bridge builds itself (finding 11).
- **Startup:** the `pid` field in `userdata/server-runtime.json` under the T3 base directory.
