import type { Sql } from "./sql.ts";

// Append only. Entry N (from 1) runs once, in its own transaction, and is then recorded in the migrations table.
export const migrations = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE pairing_links (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  );

  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE vms (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    sandbox_id TEXT,
    name TEXT NOT NULL,
    size TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    endpoint TEXT,
    t3_token TEXT,
    t3_version TEXT,
    checkpoint TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    last_connected_at INTEGER,
    last_slept_at INTEGER
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    branch TEXT,
    title TEXT NOT NULL,
    vm_id TEXT REFERENCES vms(id) ON DELETE SET NULL,
    checkout_path TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE
  );

  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    thread_id TEXT
  );

  CREATE TABLE vm_snapshots (
    vm_id TEXT PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
    shell TEXT,
    config TEXT,
    scheduled_tasks TEXT
  );

  CREATE TABLE projections (
    thread_id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    updated_at TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE clones (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE held_commands (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // One active provider became a list of added providers with a default.
  `
  INSERT INTO settings (key, value) SELECT 'providers', json_array(json(value)) FROM settings WHERE key = 'activeProvider' AND value != 'null';
  INSERT INTO settings (key, value) SELECT 'defaultProvider', value FROM settings WHERE key = 'activeProvider';
  DELETE FROM settings WHERE key = 'activeProvider';
  `,
  `ALTER TABLE vms ADD COLUMN t3_credentials TEXT;`,
  `
  CREATE TABLE skills (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    description TEXT,
    hash TEXT NOT NULL,
    files TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE vms ADD COLUMN skills TEXT;
  `,
  // A project can live on several VMs. The first one added is its primary. The old projects.vm_id and
  // projects.checkout_path columns stay behind unused: SQLite cannot drop a column a foreign key uses.
  `
  CREATE TABLE project_vms (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    checkout_path TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, vm_id)
  );
  INSERT INTO project_vms (project_id, vm_id, checkout_path, added_at)
    SELECT id, vm_id, checkout_path, created_at FROM projects WHERE vm_id IS NOT NULL;
  UPDATE projects SET vm_id = NULL, checkout_path = NULL;
  `,
  // The local branches each of a project's VMs had when last read, for while it sleeps.
  `ALTER TABLE project_vms ADD COLUMN branches TEXT;`,
  // The snapshot new VMs of each provider and size start from (see vm/bases.ts), the VM building the next one, and
  // replaced snapshots still to delete.
  `
  CREATE TABLE base_snapshots (
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    snapshot TEXT,
    stamp TEXT,
    created_at INTEGER,
    builder TEXT,
    PRIMARY KEY (provider, size)
  );
  CREATE TABLE retired_snapshots (
    provider TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (provider, snapshot)
  );
  `,
  // The latest background failures (see traffic.ts), kept across restarts. `resolved` is set once the same operation
  // works again for the same VM or provider.
  `
  CREATE TABLE errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    operation TEXT NOT NULL,
    reason TEXT,
    vm_id TEXT,
    provider TEXT,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  `,
  // Usage for cost estimates (see usage.ts). No foreign keys: the history outlives the VMs and snapshots.
  `
  CREATE TABLE vm_usage (
    id INTEGER PRIMARY KEY,
    vm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    state TEXT NOT NULL,
    repos TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    open INTEGER NOT NULL
  );
  CREATE INDEX vm_usage_time ON vm_usage (ended_at, started_at);
  CREATE TABLE snapshot_usage (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    size TEXT,
    vm_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    open INTEGER NOT NULL
  );
  CREATE INDEX snapshot_usage_time ON snapshot_usage (ended_at, started_at);
  `,
  // VM lifecycle and agent turns for analytics (see analytics.ts). No foreign keys, like usage. Turns hold no
  // message content: only which thread, run, repository, agent and model.
  `
  CREATE TABLE vm_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    vm_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    size TEXT NOT NULL,
    kind TEXT NOT NULL,
    duration_ms INTEGER
  );
  CREATE INDEX vm_events_at ON vm_events (at);
  CREATE TABLE turns (
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    vm_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    repo TEXT,
    agent TEXT,
    model TEXT,
    PRIMARY KEY (thread_id, run_id)
  );
  CREATE INDEX turns_at ON turns (at);
  `,
  // Agent sign-ins, which used to be files under `<data dir>/auths` (see bun/auth-files.ts). Both values are sealed
  // with the contexts the files used, `auths/<id>/profile.json` and `auths/<id>/auth.json`, so they move unchanged.
  `
  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    codex_auth TEXT
  );
  `,
  // Sign-in fingerprints were plain SHA-256 hashes, which a copy of the database could check guessed secrets
  // against. Now they are keyed (see `credentialsFingerprint`): a VM with an old one counts as behind on sign-ins, so
  // it restarts T3 with the current ones, as after any sign-in change.
  `UPDATE vms SET t3_credentials = 'unkeyed' WHERE t3_credentials IS NOT NULL;`,
  // AGENTS.md and CLAUDE.md pasted in the dashboard, sealed with the context `instructions:<name>`.
  `
  CREATE TABLE instructions (
    name TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // A link to watch a VM's screen live (see watch/links.ts), one per VM. The token is sealed with the context
  // `watch:<vmId>`, so VM Bridge can give it to the VM again, and looked up by its hash. A row without a token is a
  // link the user turned off, which VM Bridge then does not make again.
  `
  CREATE TABLE watch_links (
    vm_id TEXT PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE,
    token TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  // Files a T3 client uploaded for a message not sent yet (see gateway/attachments.ts). The bytes are in 1 MB chunks,
  // under Durable Object SQL's 2 MB limit, and are dropped once the thread's VM has them. No foreign key to vms: a
  // row outlives a deleted VM only until it expires.
  `
  CREATE TABLE attachment_uploads (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    client_id TEXT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state TEXT NOT NULL,
    vm_id TEXT,
    vm_attachment_id TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE attachment_chunks (
    upload_id TEXT NOT NULL REFERENCES attachment_uploads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (upload_id, seq)
  );
  `,
  // Each project's files on GitHub at the refs searched while its VM slept (see gateway/files.ts), one path per line,
  // split over rows to stay under Durable Object SQL's 2 MB value limit.
  `
  CREATE TABLE file_trees (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    seq INTEGER NOT NULL,
    paths TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, ref, seq)
  );
  `,
  // When each device's RPC WebSocket was last open, so the dashboard can say how long one has been away.
  `ALTER TABLE clients ADD COLUMN last_connected_at INTEGER;`,
  // A saved thread is now its whole history, which can pass Durable Object SQL's 2 MB value limit: `projections.data`
  // holds its first part and `projection_parts` the rest, in order. `stamp` is the thread's shell row as it was when
  // the copy was taken (see `threadStamp`), so a sleeping VM's changed threads can be told from unchanged ones.
  `
  ALTER TABLE projections ADD COLUMN stamp TEXT;
  CREATE TABLE projection_parts (
    thread_id TEXT NOT NULL REFERENCES projections(thread_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
  );
  `,
  // The files each checkout and worktree on a VM had as it went to sleep, untracked and unpushed ones too (see
  // gateway/files.ts), keyed by the path on the VM and split over rows like file_trees.
  `
  CREATE TABLE vm_file_lists (
    project_id TEXT NOT NULL,
    vm_id TEXT NOT NULL,
    path TEXT NOT NULL,
    seq INTEGER NOT NULL,
    paths TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    PRIMARY KEY (vm_id, path, seq),
    FOREIGN KEY (project_id, vm_id) REFERENCES project_vms(project_id, vm_id) ON DELETE CASCADE
  );
  `,
  // The logo T3 finds in each project's repository, kept from when a VM holding it was last awake (see gateway/icons.ts).
  `
  CREATE TABLE project_icons (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL,
    revision TEXT NOT NULL,
    name TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX project_icons_revision ON project_icons (revision);
  `,
  // Passwords, both encrypted, for OpenCode (see gateway/opencode.ts): the one each VM's own server takes, and the one a
  // project's OpenCode clients give VM Bridge.
  `
  ALTER TABLE vms ADD COLUMN opencode_password TEXT;
  ALTER TABLE projects ADD COLUMN opencode_password TEXT;
  `,
  // The worktrees `vmbridge opencode` made and has not removed, so `vmbridge opencode resume` can list them without
  // waking a VM (see gateway/opencode-launch.ts). The gateway notes each one's last use and OpenCode session.
  `
  CREATE TABLE opencode_worktrees (
    project_id TEXT NOT NULL,
    vm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    branch TEXT NOT NULL,
    base TEXT,
    session_id TEXT,
    last_prompt TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, name),
    FOREIGN KEY (project_id, vm_id) REFERENCES project_vms(project_id, vm_id) ON DELETE CASCADE
  );
  `,
];

/**
 * Brings the schema up to date. `legacyVersion` is the `PRAGMA user_version` older versions tracked migrations with:
 * on the first start with a migrations table, the ones it counts are recorded as done instead of run again.
 */
export function migrate(db: Sql, legacyVersion = 0) {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = () => db.one<{ version: number | null }>("SELECT MAX(version) AS version FROM migrations")?.version ?? 0;
  if (done() === 0 && legacyVersion > 0) {
    db.transaction(() => {
      for (let version = 1; version <= Math.min(legacyVersion, migrations.length); version++) {
        db.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", version, Date.now());
      }
    });
  }
  for (let next = done(); next < migrations.length; next++) {
    db.transaction(() => {
      db.exec(migrations[next]!);
      db.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", next + 1, Date.now());
    });
  }
}
