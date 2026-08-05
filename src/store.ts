import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";

let pool: pg.Pool | null = null;
let encKey = "";

export function initStore(databaseUrl: string, tokenEncKey: string): void {
  pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  encKey = tokenEncKey;
}

function getPool(): pg.Pool {
  if (!pool) throw new Error("Store not initialised");
  return pool;
}

/** True when a database is configured — otherwise callers fall back to
 * honest degradation (the consent gate refuses outright rather than mutate
 * unconfirmed; gate.md §3.5). Ported from gmail-mcp's store.ts. */
export function storeReady(): boolean {
  return !!pool;
}

export async function ensureSchema(): Promise<void> {
  const p = getPool();
  // Legacy single-account table (one row, id=1). Kept only so existing
  // deployments can migrate their row into google_accounts below.
  await p.query(`
    CREATE TABLE IF NOT EXISTS google_account (
      id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      email       TEXT NOT NULL,
      ref_enc     TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Multi-account: the owner of this instance can link several Google accounts
  // (personal / work / ...), each selected per tool-call via the `account` arg.
  await p.query(`
    CREATE TABLE IF NOT EXISTS google_accounts (
      email       TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      ref_enc     TEXT NOT NULL,
      is_default  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // One-time migration: fold a legacy single account into the new table.
  await p.query(`
    INSERT INTO google_accounts (email, label, ref_enc, is_default)
    SELECT email, 'default', ref_enc, TRUE FROM google_account
    WHERE NOT EXISTS (SELECT 1 FROM google_accounts)
    ON CONFLICT (email) DO NOTHING
  `);
  // MCP OAuth: dynamically registered clients (Claude, etc).
  await p.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id           TEXT PRIMARY KEY,
      client_secret       TEXT,
      metadata             JSONB NOT NULL,
      issued_at            BIGINT NOT NULL,
      secret_expires_at    BIGINT NOT NULL DEFAULT 0
    )
  `);
  // MCP OAuth: authorization requests waiting on the Google redirect round-trip.
  // `mode` is 'mcp' for the Claude connect flow (mint an MCP code afterwards) or
  // 'dashboard' for the add-another-account flow (just store the account).
  await p.query(`
    CREATE TABLE IF NOT EXISTS oauth_pending (
      nonce         TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      redirect_uri  TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes        TEXT NOT NULL,
      state         TEXT,
      resource      TEXT,
      mode          TEXT NOT NULL DEFAULT 'mcp',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Older deployments created oauth_pending without `mode`; add it if missing.
  await p.query(`ALTER TABLE oauth_pending ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'mcp'`);
  // MCP OAuth: issued authorization codes (single use, short-lived).
  await p.query(`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code          TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      redirect_uri  TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes        TEXT NOT NULL,
      resource      TEXT,
      used          BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at    BIGINT NOT NULL
    )
  `);
  // MCP OAuth: issued access/refresh tokens.
  await p.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      access_token   TEXT PRIMARY KEY,
      refresh_token  TEXT UNIQUE NOT NULL,
      client_id      TEXT NOT NULL,
      scopes         TEXT NOT NULL,
      resource       TEXT,
      expires_at     BIGINT NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ---- Consent gate (ported from gmail-mcp packages A1/A2/A3, mcp-development
  // -standard/references/gate.md §3). ONE physical Postgres is shared by all 5
  // MCP servers (gmail/sheets/calendar/docs/drive) — `server` isolates rows
  // per server ($self, never a tool argument). DDL is FROZEN byte-identical
  // to gmail-mcp's ensureSchema() (plan §0.4/[R:изоляция-5]): any future DDL
  // change here must be applied to all 5 `ensureSchema()` copies in the same
  // pass, or `CREATE TABLE IF NOT EXISTS` silently lets them drift apart.
  //
  // Times are epoch-milliseconds (BIGINT), not TIMESTAMPTZ — consent.ts's
  // `ConsentManifestRow`/`ConsentAuditEntry` types declare plain `number`
  // fields (it injects a fake `now()` for offline unit tests, which only
  // works cleanly against numbers), same convention as oauth_codes.expires_at.
  await p.query(`
    CREATE TABLE IF NOT EXISTS consent_manifests (
      id            TEXT PRIMARY KEY,
      server        TEXT NOT NULL,
      tool          TEXT NOT NULL,
      account_label TEXT NOT NULL,
      payload       JSONB NOT NULL,
      object_hash   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'AWAITING_CONSENT',
      created_at    BIGINT NOT NULL,
      expires_at    BIGINT NOT NULL,
      consumed_at   BIGINT,
      user_reply    TEXT
    )
  `);
  await p.query(
    `CREATE INDEX IF NOT EXISTS consent_manifests_cleanup_idx ON consent_manifests (server, status, expires_at)`,
  );
  // Append-only audit trail. Written in two phases (plan §0.4/[R:полнота-3]):
  // appendConsentAudit() at the gate DECISION (confirmed/refused/invalidated),
  // then updateConsentAuditOutcome() fills in what the MUTATION actually did
  // (post-verify, error) — called by whichever package wires the gate into a
  // real tool, after it has actually mutated. pre_snapshot/post_verify_result/
  // error stay NULL until something populates them.
  await p.query(`
    CREATE TABLE IF NOT EXISTS consent_audit (
      id                 TEXT PRIMARY KEY,
      ts                 BIGINT NOT NULL,
      server             TEXT NOT NULL,
      tool               TEXT NOT NULL,
      account_label      TEXT NOT NULL,
      manifest_id        TEXT,
      object_hash        TEXT,
      user_reply         TEXT NOT NULL,
      checks             JSONB NOT NULL,
      outcome            TEXT NOT NULL,
      refusal_reason     TEXT,
      actor              TEXT NOT NULL DEFAULT 'human',
      pre_snapshot       JSONB,
      post_verify_result TEXT,
      error              TEXT
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS consent_audit_server_ts_idx ON consent_audit (server, ts DESC)`);
}

// ---- Google accounts (multi-account, one owner per instance) ----

export interface GoogleAccount {
  email: string;
  label: string;
  isDefault: boolean;
  refreshToken: string;
}

export interface GoogleAccountMeta {
  email: string;
  label: string;
  isDefault: boolean;
}

/** Derive a starting label from an email (local-part), deduped against existing labels. */
function deriveLabel(email: string, taken: Set<string>): string {
  const base = (email.split("@")[0] || "account").replace(/[^a-zA-Z0-9._-]/g, "") || "account";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}${i}`;
    if (!taken.has(cand)) return cand;
  }
}

/**
 * Link (or re-link) a Google account for this instance. Keyed by verified email:
 * re-authorizing the same account refreshes its token and keeps its label. The
 * first account ever added becomes the default.
 */
export async function addGoogleAccount(email: string, refreshToken: string): Promise<GoogleAccountMeta> {
  const p = getPool();
  const enc = encrypt(refreshToken, encKey);
  const existing = await p.query(`SELECT label, is_default FROM google_accounts WHERE email = $1`, [email]);
  if (existing.rows.length) {
    await p.query(`UPDATE google_accounts SET ref_enc = $2, updated_at = NOW() WHERE email = $1`, [email, enc]);
    return { email, label: existing.rows[0].label, isDefault: existing.rows[0].is_default };
  }
  const all = await p.query(`SELECT label FROM google_accounts`);
  const taken = new Set<string>(all.rows.map((r) => r.label));
  const label = deriveLabel(email, taken);
  const isDefault = all.rows.length === 0;
  await p.query(
    `INSERT INTO google_accounts (email, label, ref_enc, is_default) VALUES ($1, $2, $3, $4)`,
    [email, label, enc, isDefault],
  );
  return { email, label, isDefault };
}

/** All accounts (metadata only — no secrets), default first then by creation. */
export async function listGoogleAccounts(): Promise<GoogleAccountMeta[]> {
  if (!pool) return [];
  const p = getPool();
  const res = await p.query(
    `SELECT email, label, is_default FROM google_accounts ORDER BY is_default DESC, created_at ASC`,
  );
  return res.rows.map((r) => ({ email: r.email, label: r.label, isDefault: r.is_default }));
}

/** All accounts including decrypted refresh tokens — for building Google clients. */
export async function getGoogleAccounts(): Promise<GoogleAccount[]> {
  if (!pool) return [];
  const p = getPool();
  const res = await p.query(
    `SELECT email, label, is_default, ref_enc FROM google_accounts ORDER BY is_default DESC, created_at ASC`,
  );
  return res.rows.map((r) => ({
    email: r.email,
    label: r.label,
    isDefault: r.is_default,
    refreshToken: decrypt(r.ref_enc, encKey),
  }));
}

/** The stored refresh token for one email, or undefined when not linked yet. */
export async function getRefreshTokenByEmail(email: string): Promise<string | undefined> {
  if (!pool) return undefined;
  const p = getPool();
  const res = await p.query(`SELECT ref_enc FROM google_accounts WHERE email = $1`, [email]);
  if (!res.rows.length) return undefined;
  return decrypt(res.rows[0].ref_enc, encKey);
}

/** Remove an account. If it was the default, promote the oldest remaining one. */
export async function removeGoogleAccount(email: string): Promise<boolean> {
  const p = getPool();
  const del = await p.query(`DELETE FROM google_accounts WHERE email = $1 RETURNING is_default`, [email]);
  if (!del.rows.length) return false;
  if (del.rows[0].is_default) {
    await p.query(
      `UPDATE google_accounts SET is_default = TRUE
       WHERE email = (SELECT email FROM google_accounts ORDER BY created_at ASC LIMIT 1)`,
    );
  }
  return true;
}

/** Make `email` the sole default. */
export async function setDefaultAccount(email: string): Promise<boolean> {
  const p = getPool();
  const hit = await p.query(`SELECT 1 FROM google_accounts WHERE email = $1`, [email]);
  if (!hit.rows.length) return false;
  await p.query(`UPDATE google_accounts SET is_default = (email = $1)`, [email]);
  return true;
}

/** Rename an account's label (must stay unique). */
export async function renameAccount(email: string, label: string): Promise<boolean> {
  const p = getPool();
  const clean = label.trim().replace(/[^a-zA-Z0-9._-]/g, "");
  if (!clean) return false;
  const clash = await p.query(`SELECT 1 FROM google_accounts WHERE label = $1 AND email <> $2`, [clean, email]);
  if (clash.rows.length) return false;
  const res = await p.query(`UPDATE google_accounts SET label = $2, updated_at = NOW() WHERE email = $1`, [email, clean]);
  return (res.rowCount ?? 0) > 0;
}

// ---- OAuth clients (RFC 7591 dynamic client registration) ----

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
  [key: string]: unknown;
}

export async function saveClient(client: StoredClient): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO oauth_clients (client_id, client_secret, metadata, issued_at, secret_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_id) DO UPDATE SET client_secret = $2, metadata = $3, issued_at = $4, secret_expires_at = $5`,
    [client.client_id, client.client_secret ?? null, JSON.stringify(client), client.client_id_issued_at, client.client_secret_expires_at],
  );
}

export async function getClient(clientId: string): Promise<StoredClient | undefined> {
  const p = getPool();
  const res = await p.query(`SELECT metadata FROM oauth_clients WHERE client_id = $1`, [clientId]);
  if (!res.rows.length) return undefined;
  return res.rows[0].metadata as StoredClient;
}

// ---- Pending authorization (waiting on Google redirect) ----

export type PendingMode = "mcp" | "dashboard";

export interface PendingAuth {
  nonce: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  mode: PendingMode;
}

export async function savePendingAuth(p1: PendingAuth): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO oauth_pending (nonce, client_id, redirect_uri, code_challenge, scopes, state, resource, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p1.nonce, p1.clientId, p1.redirectUri, p1.codeChallenge, p1.scopes.join(" "), p1.state ?? null, p1.resource ?? null, p1.mode],
  );
}

export async function takePendingAuth(nonce: string): Promise<PendingAuth | null> {
  const p = getPool();
  const res = await p.query(`DELETE FROM oauth_pending WHERE nonce = $1 RETURNING *`, [nonce]);
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    nonce: row.nonce,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: row.scopes.split(" ").filter(Boolean),
    state: row.state ?? undefined,
    resource: row.resource ?? undefined,
    mode: (row.mode as PendingMode) ?? "mcp",
  };
}

// ---- Authorization codes ----

export interface IssuedCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;

export async function issueCode(args: Omit<IssuedCode, "code">): Promise<string> {
  const p = getPool();
  const code = randomBytes(32).toString("base64url");
  await p.query(
    `INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [code, args.clientId, args.redirectUri, args.codeChallenge, args.scopes.join(" "), args.resource ?? null, Date.now() + CODE_TTL_MS],
  );
  return code;
}

/** Consumes a code (marks used); returns null if missing, already used, or expired. */
export async function consumeCode(code: string): Promise<IssuedCode | null> {
  const p = getPool();
  const res = await p.query(
    `UPDATE oauth_codes SET used = TRUE WHERE code = $1 AND used = FALSE AND expires_at > $2 RETURNING *`,
    [code, Date.now()],
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: row.scopes.split(" ").filter(Boolean),
    resource: row.resource ?? undefined,
  };
}

export async function peekCodeChallenge(code: string): Promise<string | null> {
  const p = getPool();
  const res = await p.query(`SELECT code_challenge FROM oauth_codes WHERE code = $1 AND used = FALSE`, [code]);
  return res.rows[0]?.code_challenge ?? null;
}

// ---- Access/refresh tokens ----

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // seconds since epoch
}

const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour

export async function issueTokens(clientId: string, scopes: string[], resource?: string): Promise<IssuedTokens> {
  const p = getPool();
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC;
  await p.query(
    `INSERT INTO oauth_tokens (access_token, refresh_token, client_id, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [accessToken, refreshToken, clientId, scopes.join(" "), resource ?? null, expiresAt],
  );
  return { accessToken, refreshToken, clientId, scopes, resource, expiresAt };
}

export async function findByAccessToken(accessToken: string): Promise<IssuedTokens | null> {
  const p = getPool();
  const res = await p.query(`SELECT * FROM oauth_tokens WHERE access_token = $1`, [accessToken]);
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter(Boolean),
    resource: row.resource ?? undefined,
    expiresAt: Number(row.expires_at),
  };
}

export async function findByRefreshToken(refreshToken: string): Promise<IssuedTokens | null> {
  const p = getPool();
  const res = await p.query(`SELECT * FROM oauth_tokens WHERE refresh_token = $1`, [refreshToken]);
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter(Boolean),
    resource: row.resource ?? undefined,
    expiresAt: Number(row.expires_at),
  };
}

/** Rotates: deletes the old row, caller inserts a new one via issueTokens. */
export async function deleteTokenByRefresh(refreshToken: string): Promise<void> {
  const p = getPool();
  await p.query(`DELETE FROM oauth_tokens WHERE refresh_token = $1`, [refreshToken]);
}

export async function deleteTokenByAccess(accessToken: string): Promise<void> {
  const p = getPool();
  await p.query(`DELETE FROM oauth_tokens WHERE access_token = $1`, [accessToken]);
}

// ---- Consent gate: manifests + audit (ported from gmail-mcp package A1) ----
// SIGNATURE (checked below via a typed annotation in server.ts) — this file
// does not import consent.ts (store.ts stays a leaf module; consent.ts is the
// generic, portable one). `server` is always the caller's own constant
// ($self, "docs") — every query filters on it so the 5 servers sharing this
// Postgres can never see each other's manifests/audit rows.

export interface ConsentManifestRow {
  id: string;
  server: string;
  tool: string;
  accountLabel: string;
  payload: unknown;
  objectHash: string;
  status: "AWAITING_CONSENT" | "DONE" | "INVALIDATED";
  createdAt: number;
  expiresAt: number;
  consumedAt?: number | null;
  userReply?: string | null;
}

export interface ConsentAuditEntry {
  id: string;
  ts: number;
  server: string;
  tool: string;
  accountLabel: string;
  manifestId?: string | null;
  objectHash?: string | null;
  userReply: string;
  checks: Record<string, string>;
  outcome: "confirmed" | "refused" | "invalidated";
  refusalReason?: string | null;
  actor: string;
}

function rowToManifest(row: {
  id: string;
  server: string;
  tool: string;
  account_label: string;
  payload: unknown;
  object_hash: string;
  status: string;
  created_at: string | number;
  expires_at: string | number;
  consumed_at: string | number | null;
  user_reply: string | null;
}): ConsentManifestRow {
  return {
    id: row.id,
    server: row.server,
    tool: row.tool,
    accountLabel: row.account_label,
    payload: row.payload,
    objectHash: row.object_hash,
    status: row.status as ConsentManifestRow["status"],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    userReply: row.user_reply,
  };
}

/** Inserts a new manifest in AWAITING_CONSENT. Opportunistically sweeps this
 * server's own expired-but-still-AWAITING rows first (same pattern as
 * download_tokens above) — nothing waits on the sweep, it just keeps the
 * shared table from growing unboundedly across all 5 servers. */
export async function createManifest(input: {
  id: string;
  server: string;
  tool: string;
  accountLabel: string;
  payload: unknown;
  objectHash: string;
  createdAt: number;
  expiresAt: number;
}): Promise<void> {
  const p = getPool();
  await p.query(
    `DELETE FROM consent_manifests WHERE server = $1 AND status = 'AWAITING_CONSENT' AND expires_at < $2`,
    [input.server, Date.now()],
  );
  await p.query(
    `INSERT INTO consent_manifests
       (id, server, tool, account_label, payload, object_hash, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'AWAITING_CONSENT', $7, $8)`,
    [
      input.id,
      input.server,
      input.tool,
      input.accountLabel,
      JSON.stringify(input.payload),
      input.objectHash,
      input.createdAt,
      input.expiresAt,
    ],
  );
}

/** Reads a manifest scoped to `server`; null if missing OR belongs to another server. */
export async function getManifest(id: string, server: string): Promise<ConsentManifestRow | null> {
  const p = getPool();
  const res = await p.query(`SELECT * FROM consent_manifests WHERE id = $1 AND server = $2`, [id, server]);
  if (!res.rows.length) return null;
  return rowToManifest(res.rows[0]);
}

/**
 * Atomic one-shot consume — the proof against the double-execute race, same
 * shape as `consumeCode` above: a single `UPDATE … WHERE … RETURNING` closes
 * the race in the database, not in JS. Succeeds only if the row is still
 * AWAITING_CONSENT, belongs to `server`, AND has not expired (checked against
 * the SAME `now` value used to stamp `consumed_at`, so there's no window
 * between the compare and the write). Returns null on any miss (unknown id,
 * wrong server, already DONE/INVALIDATED, or expired) — the caller
 * (consent.ts) treats every one of those the same way: refuse.
 */
export async function consumeManifest(
  id: string,
  server: string,
  userReply: string,
): Promise<ConsentManifestRow | null> {
  const p = getPool();
  const now = Date.now();
  const res = await p.query(
    `UPDATE consent_manifests
        SET status = 'DONE', consumed_at = $4, user_reply = $3
      WHERE id = $1 AND server = $2 AND status = 'AWAITING_CONSENT' AND expires_at > $4
      RETURNING *`,
    [id, server, userReply, now],
  );
  if (!res.rows.length) return null;
  return rowToManifest(res.rows[0]);
}

/** Marks a manifest INVALIDATED (explicit user negation). No-op if it's not
 * currently AWAITING_CONSENT for this server (already consumed/expired/invalidated). */
export async function invalidateManifest(id: string, server: string, userReply: string): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE consent_manifests SET status = 'INVALIDATED', user_reply = $3
      WHERE id = $1 AND server = $2 AND status = 'AWAITING_CONSENT'`,
    [id, server, userReply],
  );
}

/** Append-only: one row per gate decision (confirmed/refused/invalidated). */
export async function appendConsentAudit(entry: ConsentAuditEntry): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO consent_audit
       (id, ts, server, tool, account_label, manifest_id, object_hash, user_reply, checks, outcome, refusal_reason, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      entry.id,
      entry.ts,
      entry.server,
      entry.tool,
      entry.accountLabel,
      entry.manifestId ?? null,
      entry.objectHash ?? null,
      entry.userReply,
      JSON.stringify(entry.checks),
      entry.outcome,
      entry.refusalReason ?? null,
      entry.actor,
    ],
  );
}

/**
 * Phase 2 of the audit row: fills in what the MUTATION actually did, called by
 * whichever package wires the gate into a real tool AFTER it has written/
 * cleared/whatever — never by consent.ts itself. Matches `ConsentStore`'s
 * 2-argument contract exactly; `preSnapshot` is an EXTRA optional field beyond
 * that contract. It's additive and optional, so passing it or not both
 * satisfy `ConsentStore` structurally.
 */
export async function updateConsentAuditOutcome(
  auditId: string,
  outcome: {
    outcome?: "confirmed" | "failed";
    postVerify?: string | null;
    error?: string | null;
    preSnapshot?: unknown;
  },
): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE consent_audit SET
       outcome = COALESCE($2, outcome),
       post_verify_result = COALESCE($3, post_verify_result),
       error = COALESCE($4, error),
       pre_snapshot = COALESCE($5, pre_snapshot)
     WHERE id = $1`,
    [
      auditId,
      outcome.outcome ?? null,
      outcome.postVerify ?? null,
      outcome.error ?? null,
      outcome.preSnapshot !== undefined ? JSON.stringify(outcome.preSnapshot) : null,
    ],
  );
}

export interface ConsentAuditFilters {
  server: string;
  since?: number;
  until?: number;
  accountLabel?: string;
  tool?: string;
  outcome?: string;
}

export interface ConsentAuditRow extends ConsentAuditEntry {
  postVerifyResult: string | null;
  error: string | null;
  preSnapshot: unknown;
}

/** Shared WHERE-clause builder for `listConsentAudit`/`countConsentAudit`, so
 * the two can never drift apart on which rows they mean by "matching the
 * filters" (a `total` from one query and rows from a different filter set
 * would be a worse lie than no total at all). */
function buildAuditWhere(filters: ConsentAuditFilters): { where: string; params: unknown[] } {
  const conds: string[] = [`server = $1`];
  const params: unknown[] = [filters.server];
  if (filters.since != null) {
    params.push(filters.since);
    conds.push(`ts >= $${params.length}`);
  }
  if (filters.until != null) {
    params.push(filters.until);
    conds.push(`ts <= $${params.length}`);
  }
  if (filters.accountLabel) {
    params.push(filters.accountLabel);
    conds.push(`account_label = $${params.length}`);
  }
  if (filters.tool) {
    params.push(filters.tool);
    conds.push(`tool = $${params.length}`);
  }
  if (filters.outcome) {
    params.push(filters.outcome);
    conds.push(`outcome = $${params.length}`);
  }
  return { where: conds.join(" AND "), params };
}

/** Read path for the `docs_consent_audit` tool — "разбор инцидента без ssh"
 * (limits-audit.md §11). `server` is required and always the caller's own
 * constant; `limit` is capped to 100 regardless of what's asked (limits-audit
 * §10.1), default 20. `offset` powers pagination through older rows (§10.1
 * "показано N из M" — never a silent truncation); newest first. */
export async function listConsentAudit(
  filters: ConsentAuditFilters,
  limit = 20,
  offset = 0,
): Promise<ConsentAuditRow[]> {
  const p = getPool();
  const cap = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const off = Math.max(Math.trunc(offset) || 0, 0);
  const { where, params } = buildAuditWhere(filters);
  params.push(cap);
  const limitIdx = params.length;
  params.push(off);
  const offsetIdx = params.length;
  const res = await p.query(
    `SELECT * FROM consent_audit WHERE ${where} ORDER BY ts DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return res.rows.map((row) => ({
    id: row.id,
    ts: Number(row.ts),
    server: row.server,
    tool: row.tool,
    accountLabel: row.account_label,
    manifestId: row.manifest_id ?? null,
    objectHash: row.object_hash ?? null,
    userReply: row.user_reply,
    checks: row.checks ?? {},
    outcome: row.outcome,
    refusalReason: row.refusal_reason ?? null,
    actor: row.actor,
    postVerifyResult: row.post_verify_result ?? null,
    error: row.error ?? null,
    preSnapshot: row.pre_snapshot ?? null,
  }));
}

/** Total rows matching `filters` (ignoring limit/offset) — lets `docs_consent_audit`
 * say "shown 20 of 143" honestly (limits-audit.md §10.1: silent truncation is
 * never allowed) and tell the caller whether another page exists. */
export async function countConsentAudit(filters: ConsentAuditFilters): Promise<number> {
  const p = getPool();
  const { where, params } = buildAuditWhere(filters);
  const res = await p.query(`SELECT COUNT(*)::int AS n FROM consent_audit WHERE ${where}`, params);
  return res.rows[0]?.n ?? 0;
}

export { randomUUID };
