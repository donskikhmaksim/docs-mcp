/**
 * Google Docs tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { docs_v1 } from "googleapis";
import { ok, fail, guard, safeText, mapWithLimit } from "../util.js";
import { accountField, type UserClients } from "../accounts.js";
import type { GoogleClients } from "../google.js";
import {
  requireConsent,
  sha256,
  formatLaTime,
  USER_REPLY_DOC,
  type ConsentStore,
  type ConsentConfig,
} from "../consent.js";

/** One row of the shared consent_audit log, as read by `docs_consent_audit`.
 * Mirrors store.ts's `ConsentAuditRow` structurally — same "don't import
 * store.ts directly, context provides adapters" convention as elsewhere;
 * `server.ts` wires the real implementation in. */
interface ConsentAuditRow {
  id: string;
  ts: number;
  tool: string;
  accountLabel: string;
  manifestId?: string | null;
  objectHash?: string | null;
  userReply: string;
  outcome: string;
  refusalReason?: string | null;
  actor: string;
  postVerifyResult: string | null;
  error: string | null;
  preSnapshot: unknown;
}

interface ConsentAuditFilters {
  server: string;
  since?: number;
  until?: number;
  accountLabel?: string;
  tool?: string;
  outcome?: string;
}

/** Read-only access to the consent-gate audit log — "разбор инцидента без
 * ssh" (limits-audit.md §11). Separate from `ConsentStore` above: this is
 * neither the plan nor the execute gate, just a read path over the same
 * consent_audit table the gate already writes to. */
interface AuditStore {
  listConsentAudit(filters: ConsentAuditFilters, limit?: number, offset?: number): Promise<ConsentAuditRow[]>;
  countConsentAudit(filters: ConsentAuditFilters): Promise<number>;
}

/** Context threaded into `registerDocsTools` carrying the consent-gate wiring
 * (ported from gmail-mcp's `GmailSnoozeContext` / sheets-mcp's
 * `SheetsConsentContext`). */
export interface DocsConsentContext {
  /** Consent-gate storage. null exactly when Postgres isn't configured —
   * every gated write tool below refuses outright when this is null
   * (gate.md §3.5: no durable manifest storage means no gate, and that must
   * never become a silent bypass). */
  consentStore: ConsentStore | null;
  /** Gate knobs (TTL / anti-doublet gap / batch cap), always present even
   * when consentStore is null so a refusal message can still be built
   * without a crash. Real value comes from `consentServerConfig` in
   * server.ts (env-driven). */
  consentCfg: ConsentConfig;
  /** Read-only access to the consent_audit log. null exactly when Postgres
   * isn't configured (same honest-degradation rule as `consentStore`). */
  auditStore: AuditStore | null;
}

/** Fallback gate config for callers that don't wire a real one (offline unit
 * tests exercising other tools). Mirrors config.ts's `loadConsentGateConfig()`
 * defaults; production always gets the real env-driven config from server.ts. */
const DEFAULT_CONSENT_CFG: ConsentConfig = {
  server: "docs",
  consentTtlMs: 3_600_000,
  minConsentGapMs: 2_000,
  sendBatchMax: 10,
};

const DEFAULT_CONSENT_CTX: DocsConsentContext = {
  consentStore: null,
  consentCfg: DEFAULT_CONSENT_CFG,
  auditStore: null,
};

/** Flattens a Docs document body into plain text. */
export function documentToPlainText(doc: docs_v1.Schema$Document): string {
  const out: string[] = [];
  const content = doc.body?.content ?? [];
  for (const el of content) {
    const para = el.paragraph;
    if (para?.elements) {
      for (const pe of para.elements) {
        const t = pe.textRun?.content;
        if (t) out.push(t);
      }
    }
    const table = el.table;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        const cells = (row.tableCells ?? []).map((cell) => {
          const parts: string[] = [];
          for (const cc of cell.content ?? []) {
            for (const pe of cc.paragraph?.elements ?? []) {
              if (pe.textRun?.content) parts.push(pe.textRun.content.trim());
            }
          }
          return parts.join(" ");
        });
        out.push(cells.join("\t") + "\n");
      }
    }
  }
  return out.join("");
}

/** Returns the end index of the document body (where appended text should go). */
function documentEndIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content ?? [];
  let end = 1;
  for (const el of content) {
    if (typeof el.endIndex === "number") end = el.endIndex;
  }
  // The very last newline of the body is not a valid insertion location;
  // insert just before it.
  return Math.max(1, end - 1);
}

// ── Consent-gate machinery (mcp-development-standard/references/gate.md) ───
// Ported from gmail-mcp's tools/gmail.ts / sheets-mcp's tools/sheets.ts: the
// same requireConsent/plan→execute wiring, one §5.3 report renderer, and REAL
// (non-tautological) rehash for every gated write below — each rehash
// re-reads the LIVE target document (title / revisionId / full plain text) at
// execute time, never `sha256(payload)` in disguise, except for docs_create
// which has no live object to bind against yet (same documented degenerate
// case as gmail_send / sheets_create).

type PostVerifyOutcome = "ok" | "warn" | "mismatch";
interface VerifyLine {
  outcome: PostVerifyOutcome;
  line: string;
}

/** Now, formatted for America/Los_Angeles. */
function nowInLA(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }) + " America/Los_Angeles";
}

/** Worst outcome across a batch, for choosing the summary status header. */
function worstOutcome(results: Array<{ outcome: PostVerifyOutcome }>): PostVerifyOutcome {
  if (results.some((r) => r.outcome === "mismatch")) return "mismatch";
  if (results.some((r) => r.outcome === "warn")) return "warn";
  return "ok";
}

/** One §5.3 renderer for the whole file (output-format.md §7.1 p.5: "an
 * instrument hand-rolling its own status string is a defect"). */
function renderVerifyReport(title: string, subtitle: string, results: VerifyLine[]): string {
  const okN = results.filter((r) => r.outcome === "ok").length;
  const warnN = results.filter((r) => r.outcome === "warn").length;
  const mmN = results.filter((r) => r.outcome === "mismatch").length;
  const body = results.map((r) => r.line).join("\n");
  return (
    `### 🧾 ${title}\n` +
    `_${nowInLA()} · ${subtitle}_\n\n` +
    `${body}\n\n` +
    `**Итог: ✅ ${okN} подтверждено, ⚠️ ${warnN} не проверено, ❌ ${mmN} расхождение.**\n` +
    `_[агенту: перепечатай этот отчёт пользователю ДОСЛОВНО — это серверная проверка, не заменяй пересказом]_`
  );
}

/**
 * Aggregates a gated batch mutation's per-item results with REAL independent
 * post-verify reads: every item without an execute-time `error` gets a fresh
 * `verify` read, the response header reflects the WORST outcome (never
 * smoothed to ✅ on a ❌ — §5.3), and the audit row's phase-2 outcome is
 * filled in via `updateConsentAuditOutcome` so `docs_consent_audit` shows
 * what actually happened, not just that the human said yes.
 */
async function buildMutationResult<T extends { error?: string }>(opts: {
  results: T[];
  total: number;
  verb: string;
  summaryIcon: string;
  verify: (item: T) => Promise<VerifyLine>;
  reportTitle: string;
  reportSubtitle: string;
  consentStore?: ConsentStore;
  auditId?: string;
  preSnapshot?: unknown;
}): Promise<ReturnType<typeof ok>> {
  const { results, total, verb, summaryIcon, verify, reportTitle, reportSubtitle, consentStore, auditId, preSnapshot } = opts;
  const succeeded = results.filter((r) => !r.error);
  const pv = await mapWithLimit(succeeded, (r) => verify(r));
  const okN = succeeded.length;
  const failN = total - okN;
  const worst = worstOutcome(pv);
  let icon = summaryIcon;
  let tail = "";
  if (worst === "mismatch") {
    icon = "❌";
    tail = " — РАСХОЖДЕНИЕ при проверке, см. отчёт";
  } else if (worst === "warn" || failN > 0) {
    icon = "⚠️";
    if (failN > 0) tail = ` (${failN} с ошибкой)`;
  }
  if (consentStore && auditId) {
    const errs = results
      .filter((r): r is T & { error: string } => !!r.error)
      .map((r) => r.error)
      .join("; ");
    await consentStore
      .updateConsentAuditOutcome(auditId, {
        outcome: okN > 0 ? "confirmed" : "failed",
        postVerify:
          `${icon} ${verb} ${okN}/${total}${tail}` + (pv.length ? ` · post-verify: ${pv.map((p) => p.line).join("; ")}` : ""),
        error: errs || null,
        ...(preSnapshot !== undefined ? { preSnapshot } : {}),
      })
      .catch((e) => {
        console.error("[consent audit] updateConsentAuditOutcome failed:", e instanceof Error ? e.message : String(e));
      });
  }
  return ok({
    summary: `${icon} ${verb} ${okN}/${total}${tail}`,
    results,
    ...(pv.length ? { verification: renderVerifyReport(reportTitle, reportSubtitle, pv) } : {}),
  });
}

/** Live snapshot of a document — title, revisionId and full plain text — or
 * null if it's unreadable (deleted/no access). Used both to build the
 * pre-write preview/pre-snapshot at plan time AND to re-read the SAME
 * document at rehash/post-verify time — the identical function on both sides
 * is what makes the binding a real drift check, not a tautology
 * (mcp-development-standard/references/gate.md §3.3(2)). */
async function liveDocumentSnapshot(
  g: GoogleClients,
  documentId: string,
): Promise<{ title: string | null; revisionId: string | null; text: string | null } | null> {
  try {
    const res = await g.docs.documents.get({ documentId });
    return {
      title: res.data.title ?? null,
      revisionId: res.data.revisionId ?? null,
      text: documentToPlainText(res.data),
    };
  } catch {
    return null; // deleted / no access — treated as unreadable, not a hard crash
  }
}

/** Binding snapshot shared by append/insert/raw_batch_update: re-reads the
 * live document (title/revisionId/text) for every item in a batch. */
async function docBindingSnapshot<T extends { documentId: string }>(g: GoogleClients, items: T[]) {
  return mapWithLimit(items, async (it) => ({
    documentId: it.documentId,
    snap: await liveDocumentSnapshot(g, it.documentId),
  }));
}

/** Post-verify: document exists and its title matches (identity confirmation
 * for docs_create). */
async function postVerifyDocCreated(
  g: GoogleClients,
  documentId: string,
  expectedTitle: string,
  label: string,
): Promise<VerifyLine> {
  const snap = await liveDocumentSnapshot(g, documentId);
  const lbl = safeText(label) || "(документ)";
  if (snap === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить документ ${safeText(documentId)}` };
  }
  if (snap.title !== null && snap.title !== expectedTitle) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — название документа отличается: живое «${safeText(snap.title)}»` };
  }
  return { outcome: "ok", line: `- ✅ **«${safeText(snap.title) || lbl}»** — документ создан` };
}

/** Post-verify: re-reads a document and confirms its live plain text now
 * contains `expectedSubstring` (used for append/insert — exact index/tail
 * matching isn't meaningful once the doc may have shifted, but substring
 * presence is a real, non-tautological check). A SEPARATE fresh read — never
 * reuses the mutation call's own response as proof (§5.1 p.1). */
async function postVerifyDocContains(
  g: GoogleClients,
  documentId: string,
  expectedSubstring: string,
  fallbackLabel: string,
): Promise<VerifyLine> {
  const snap = await liveDocumentSnapshot(g, documentId);
  const lbl = safeText(snap?.title ?? fallbackLabel) || "(документ)";
  if (snap === null || snap.text === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить` };
  }
  if (!snap.text.includes(expectedSubstring)) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — живое содержимое не содержит записанный текст` };
  }
  return { outcome: "ok", line: `- ✅ **«${lbl}»** — текст присутствует в живом документе` };
}

/** Every occurrence of `find` in `text` (literal substring, respecting
 * `matchCase`), with a short surrounding context excerpt. Used IDENTICALLY at
 * plan time (to build the preview + pre-snapshot of "заменяемые фрагменты")
 * and at rehash/post-verify time (to detect drift) — the shared function is
 * what makes the binding real, not `sha256(payload)`. */
function findTextMatches(
  text: string,
  find: string,
  matchCase: boolean,
  contextRadius = 30,
): Array<{ index: number; context: string }> {
  if (!find) return [];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  const out: Array<{ index: number; context: string }> = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    const start = Math.max(0, i - contextRadius);
    const end = Math.min(text.length, i + find.length + contextRadius);
    out.push({ index: i, context: text.slice(start, end) });
    from = i + Math.max(needle.length, 1);
  }
  return out;
}

/** Binding snapshot for docs_replace_text: live title/revisionId PLUS every
 * matching fragment — this is the "заменяемые фрагменты" pre-snapshot
 * (identity-postverify.md §5.2) as well as the rehash input. */
async function replaceBindingSnapshot(
  g: GoogleClients,
  items: Array<{ documentId: string; find: string; matchCase?: boolean }>,
) {
  return mapWithLimit(items, async (it) => {
    const snap = await liveDocumentSnapshot(g, it.documentId);
    const matches = snap?.text != null ? findTextMatches(snap.text, it.find, it.matchCase ?? false) : [];
    return { documentId: it.documentId, title: snap?.title ?? null, revisionId: snap?.revisionId ?? null, matches };
  });
}

/** Post-verify for docs_replace_text: re-reads the document and confirms
 * `find` no longer occurs (Docs `replaceAllText` replaces every occurrence,
 * same semantics as Sheets FindReplace). `find === replace` is the one
 * documented no-op edge case (never resolves to "gone", so it's never
 * flagged as a mismatch). */
async function postVerifyReplaceApplied(
  g: GoogleClients,
  documentId: string,
  find: string,
  replace: string,
  matchCase: boolean,
): Promise<VerifyLine> {
  const snap = await liveDocumentSnapshot(g, documentId);
  const lbl = safeText(snap?.title ?? documentId) || "(документ)";
  if (snap === null || snap.text === null) {
    return { outcome: "warn", line: `- ⚠️ **«${lbl}»** — не удалось перепроверить` };
  }
  const stillThere = findTextMatches(snap.text, find, matchCase).length > 0;
  if (stillThere && find !== replace) {
    return { outcome: "mismatch", line: `- ❌ **«${lbl}»** — «${safeText(find, 60)}» всё ещё встречается в живом документе` };
  }
  return { outcome: "ok", line: `- ✅ **«${lbl}»** — замена применена, «${safeText(find, 60)}» больше не встречается` };
}

/** Post-verify for docs_raw_batch_update: content-level verification of an
 * ARBITRARY batchUpdate request is not generically possible (honest limit,
 * STANDARD §15.1 Q20 — must be named up front, always ⚠️). This only confirms
 * the document is still reachable after the call. */
async function postVerifyRawBatchApplied(g: GoogleClients, documentId: string): Promise<VerifyLine> {
  const snap = await liveDocumentSnapshot(g, documentId);
  if (snap === null) {
    return { outcome: "warn", line: `- ⚠️ **(${safeText(documentId)})** — документ недоступен после применения` };
  }
  return {
    outcome: "warn",
    line: `- ⚠️ **«${safeText(snap.title ?? documentId)}»** — запрос применён без ошибки; произвольный batchUpdate нельзя обобщённо перепроверить по содержимому (честный предел, см. GUIDE.md)`,
  };
}

export function registerDocsTools(server: McpServer, clients: UserClients, ctx: DocsConsentContext = DEFAULT_CONSENT_CTX) {
  const account = accountField(clients);

  // ── docs_list ────────────────────────────────────────────────────────────
  server.registerTool(
    "docs_list",
    {
      title: "List documents",
      description:
        "List Google Docs the account can access. Optionally filter by a name substring.",
      inputSchema: {
        account,
        nameContains: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).default(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, nameContains, maxResults }) => {
      const g = clients.resolve(account);
      const qParts = [
        "mimeType='application/vnd.google-apps.document'",
        "trashed=false",
      ];
      if (nameContains) {
        qParts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
      }
      const res = await g.drive.files.list({
        q: qParts.join(" and "),
        pageSize: maxResults ?? 50,
        fields: "files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
      });
      const files = res.data.files ?? [];
      return ok({
        summary: `📋 ${files.length} document(s)${nameContains ? ` matching "${nameContains}"` : ""} on account "${account ?? "default"}"`,
        files,
      });
    }),
  );

  // ── docs_read ────────────────────────────────────────────────────────────
  server.registerTool(
    "docs_read",
    {
      title: "Read documents",
      description:
        "Read one or more Google Docs as plain text. Returns results for each documentId.",
      inputSchema: {
        account,
        documentIds: z.array(z.string()).min(1),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, documentIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        documentIds.map(async (documentId) => {
          try {
            const res = await g.docs.documents.get({ documentId });
            const text = documentToPlainText(res.data);
            return {
              documentId,
              title: res.data.title ?? null,
              text,
              characterCount: text.length,
            };
          } catch (err: unknown) {
            return {
              documentId,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return ok({
        summary: `📖 Read ${documentIds.length} document(s)`,
        results,
      });
    }),
  );

  // ── docs_create ──────────────────────────────────────────────────────────
  interface CreateDocItem {
    title: string;
    initialText?: string;
  }
  interface CreatePayload {
    account: string;
    documents: CreateDocItem[];
  }

  server.registerTool(
    "docs_create",
    {
      title: "Create documents",
      description:
        "Create one or more new Google Docs, optionally with initial text. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `documents`) " +
        "to build a plan and return a preview — nothing is created yet. Show the preview to the user verbatim and " +
        "wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM `user_reply` to " +
        "actually create.",
      inputSchema: {
        account,
        documents: z
          .array(
            z.object({
              title: z.string(),
              initialText: z.string().optional().describe("Optional initial body text."),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, documents, manifest_id, user_reply }) => {
      const { consentStore, consentCfg } = ctx;
      if (!consentStore) {
        return fail(
          "Создание недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<CreatePayload>({
        tool: "docs_create",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        plan: () => {
          if (!documents || !documents.length) {
            throw new Error("Нужен непустой `documents`, чтобы построить план создания.");
          }
          const payload: CreatePayload = { account: accountName, documents };
          const lines = documents.map(
            (d) => `- **«${safeText(d.title, 120)}»**${d.initialText ? ` — текст: ${safeText(d.initialText, 150)}` : ""}`,
          );
          const preview = `### 📤 План: Создание документов — ${documents.length}\n\n${lines.join("\n")}`;
          // Degenerate binding (documented exception, same as gmail_send in
          // gmail-mcp/src/tools/gmail.ts / sheets_create in sheets-mcp): a
          // document that doesn't exist yet has no live object to re-read
          // against — the only protection is that payload comes FROM the
          // manifest, not the execute call's arguments (see consent.ts's
          // contract comment on `rehash`).
          return { payload, objectHash: sha256(payload), preview, batchSize: documents.length };
        },
        rehash: (addressing) => sha256(addressing),
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      const results = await Promise.all(
        payload.documents.map(async ({ title, initialText }) => {
          try {
            const created = await g.docs.documents.create({
              requestBody: { title },
            });
            const documentId = created.data.documentId!;
            if (initialText) {
              await g.docs.documents.batchUpdate({
                documentId,
                requestBody: {
                  requests: [{ insertText: { location: { index: 1 }, text: initialText } }],
                },
              });
            }
            return {
              documentId,
              title: created.data.title ?? title,
              documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
            };
          } catch (err: unknown) {
            return {
              documentId: "",
              title,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      return buildMutationResult({
        results,
        total: payload.documents.length,
        verb: "Created",
        summaryIcon: "📄",
        verify: (r) => postVerifyDocCreated(g, r.documentId, r.title, r.title),
        reportTitle: "Независимая проверка создания",
        reportSubtitle: "запрошено ⇄ живое состояние Google Docs",
        consentStore,
        auditId,
      });
    }),
  );

  // ── docs_append_text ─────────────────────────────────────────────────────
  interface AppendItem {
    documentId: string;
    text: string;
    ensureNewline?: boolean;
  }
  interface AppendPayload {
    account: string;
    items: AppendItem[];
  }

  server.registerTool(
    "docs_append_text",
    {
      title: "Append text",
      description:
        "Append text to the end of one or more documents. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) to " +
        "build a plan and return a preview — nothing is appended yet. Show the preview to the user verbatim and " +
        "wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM `user_reply` to " +
        "actually append.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              text: z.string(),
              ensureNewline: z
                .boolean()
                .optional()
                .describe("Prepend a newline if document doesn't end with one."),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items, manifest_id, user_reply }) => {
      const { consentStore, consentCfg } = ctx;
      if (!consentStore) {
        return fail(
          "Добавление текста недоступно: не настроено хранилище согласия (DATABASE_URL). Без него сервер не " +
            "может провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<AppendPayload>({
        tool: "docs_append_text",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план добавления текста.");
          }
          const snapshot = await docBindingSnapshot(g, items);
          const payload: AppendPayload = { account: accountName, items };
          const lines = items.map(
            (it, i) =>
              `- **«${safeText(snapshot[i].snap?.title ?? it.documentId, 60)}»** +${it.text.length} симв. — ${safeText(it.text, 150)}`,
          );
          const preview = `### 📤 План: Добавление текста — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({
            account: accountName,
            items: snapshot.map((s) => ({
              documentId: s.documentId,
              title: s.snap?.title ?? null,
              revisionId: s.snap?.revisionId ?? null,
              text: s.snap?.text ?? null,
            })),
          });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as AppendPayload;
          const snapshot = await docBindingSnapshot(g, a.items);
          return sha256({
            account: a.account,
            items: snapshot.map((s) => ({
              documentId: s.documentId,
              title: s.snap?.title ?? null,
              revisionId: s.snap?.revisionId ?? null,
              text: s.snap?.text ?? null,
            })),
          });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      const results: Array<{ documentId: string; addedLength?: number; error?: string }> = [];
      for (const item of payload.items) {
        const { documentId, text, ensureNewline } = item;
        try {
          const doc = await g.docs.documents.get({ documentId });
          let insertText = text;
          if (ensureNewline) {
            const current = documentToPlainText(doc.data);
            if (current.length > 0 && !current.endsWith("\n")) {
              insertText = "\n" + text;
            }
          }
          const index = documentEndIndex(doc.data);
          await g.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [{ insertText: { location: { index }, text: insertText } }],
            },
          });
          results.push({ documentId, addedLength: insertText.length });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return buildMutationResult({
        results,
        total: payload.items.length,
        verb: "Appended",
        summaryIcon: "📝",
        verify: (r) => postVerifyDocContains(g, r.documentId, payload.items.find((it) => it.documentId === r.documentId)?.text ?? "", r.documentId),
        reportTitle: "Независимая проверка добавления текста",
        reportSubtitle: "запрошено ⇄ живое содержимое Google Docs",
        consentStore,
        auditId,
      });
    }),
  );

  // ── docs_insert_text ─────────────────────────────────────────────────────
  interface InsertItem {
    documentId: string;
    text: string;
    index: number;
  }
  interface InsertPayload {
    account: string;
    items: InsertItem[];
  }

  server.registerTool(
    "docs_insert_text",
    {
      title: "Insert text at index",
      description:
        "Insert text at a specific character index in one or more documents (1 = very start of the body). " +
        "Two-mode consent-gated tool (mcp-development-standard/references/gate.md): call WITHOUT " +
        "`manifest_id`/`user_reply` (with `items`) to build a plan and return a preview — nothing is inserted " +
        "yet. Show the preview to the user verbatim and wait for their reply. Call again with the returned " +
        "`manifest_id` and the user's VERBATIM `user_reply` to actually insert.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              text: z.string(),
              index: z.number().int().min(1),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, items, manifest_id, user_reply }) => {
      const { consentStore, consentCfg } = ctx;
      if (!consentStore) {
        return fail(
          "Вставка текста недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<InsertPayload>({
        tool: "docs_insert_text",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план вставки текста.");
          }
          const snapshot = await docBindingSnapshot(g, items);
          const payload: InsertPayload = { account: accountName, items };
          const lines = items.map(
            (it, i) =>
              `- **«${safeText(snapshot[i].snap?.title ?? it.documentId, 60)}»** индекс ${it.index}: ${safeText(it.text, 150)}`,
          );
          const preview = `### 📤 План: Вставка текста — ${items.length}\n\n${lines.join("\n")}`;
          const objectHash = sha256({
            account: accountName,
            items: snapshot.map((s) => ({
              documentId: s.documentId,
              title: s.snap?.title ?? null,
              revisionId: s.snap?.revisionId ?? null,
              text: s.snap?.text ?? null,
            })),
          });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as InsertPayload;
          const snapshot = await docBindingSnapshot(g, a.items);
          return sha256({
            account: a.account,
            items: snapshot.map((s) => ({
              documentId: s.documentId,
              title: s.snap?.title ?? null,
              revisionId: s.snap?.revisionId ?? null,
              text: s.snap?.text ?? null,
            })),
          });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      const results: Array<{ documentId: string; error?: string }> = [];
      for (const item of payload.items) {
        const { documentId, text, index } = item;
        try {
          await g.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [{ insertText: { location: { index }, text } }],
            },
          });
          results.push({ documentId });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return buildMutationResult({
        results,
        total: payload.items.length,
        verb: "Inserted",
        summaryIcon: "📝",
        verify: (r) => postVerifyDocContains(g, r.documentId, payload.items.find((it) => it.documentId === r.documentId)?.text ?? "", r.documentId),
        reportTitle: "Независимая проверка вставки текста",
        reportSubtitle: "запрошено ⇄ живое содержимое Google Docs",
        consentStore,
        auditId,
      });
    }),
  );

  // ── docs_replace_text ────────────────────────────────────────────────────
  interface ReplaceItem {
    documentId: string;
    find: string;
    replace: string;
    matchCase?: boolean;
  }
  interface ReplacePayload {
    account: string;
    items: ReplaceItem[];
  }

  server.registerTool(
    "docs_replace_text",
    {
      title: "Replace all text",
      description:
        "Find and replace all occurrences of a string in one or more documents. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) — " +
        "this ONLY reads matching fragments, it changes nothing. Show the returned preview (listing every " +
        "matched fragment that would change) to the user verbatim and wait for their reply. Call again with the " +
        "returned `manifest_id` and the user's VERBATIM `user_reply` to actually replace.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              find: z.string(),
              replace: z.string(),
              matchCase: z.boolean().default(false).optional(),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply }) => {
      const { consentStore, consentCfg } = ctx;
      if (!consentStore) {
        return fail(
          "Замена недоступна: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<ReplacePayload>({
        tool: "docs_replace_text",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужен непустой `items`, чтобы построить план замены.");
          }
          const snapshot = await replaceBindingSnapshot(g, items);
          const payload: ReplacePayload = { account: accountName, items };
          const lines = items.map((it, i) => {
            const s = snapshot[i];
            const mLines = s.matches
              .slice(0, 10)
              .map((m) => `«${safeText(m.context, 80)}»`)
              .join("; ");
            return (
              `- **«${safeText(s.title ?? it.documentId, 60)}»**: «${safeText(it.find, 60)}» → «${safeText(it.replace, 60)}» — ` +
              `${s.matches.length} совпадение(й)${mLines ? `: ${mLines}${s.matches.length > 10 ? "…" : ""}` : ""}`
            );
          });
          const preview =
            `### 📤 План: Замена текста — ${items.length}\n\n${lines.join("\n")}` +
            (snapshot.every((s) => s.matches.length === 0) ? "\n\n_совпадений не найдено — заменять нечего_" : "");
          const objectHash = sha256({
            account: accountName,
            items: snapshot.map(({ documentId, title, revisionId, matches }) => ({ documentId, title, revisionId, matches })),
          });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as ReplacePayload;
          const snapshot = await replaceBindingSnapshot(g, a.items);
          return sha256({
            account: a.account,
            items: snapshot.map(({ documentId, title, revisionId, matches }) => ({ documentId, title, revisionId, matches })),
          });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      // Pre-snapshot of the fragments about to be overwritten — captured FRESH
      // right before the mutation (identity-postverify.md §5.2: replace_text is
      // irreversible content-loss, so this is the only manual-recovery path).
      const preSnapshot = await replaceBindingSnapshot(g, payload.items);
      const results: Array<{
        documentId: string;
        occurrencesChanged?: number;
        error?: string;
      }> = [];
      for (const item of payload.items) {
        const { documentId, find, replace, matchCase } = item;
        try {
          const res = await g.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [
                {
                  replaceAllText: {
                    containsText: { text: find, matchCase: matchCase ?? false },
                    replaceText: replace,
                  },
                },
              ],
            },
          });
          const occurrencesChanged =
            res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
          results.push({ documentId, occurrencesChanged });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return buildMutationResult({
        results,
        total: payload.items.length,
        verb: "Replaced",
        summaryIcon: "🔄",
        verify: (r) => {
          const it = payload.items.find((x) => x.documentId === r.documentId)!;
          return postVerifyReplaceApplied(g, r.documentId, it.find, it.replace, it.matchCase ?? false);
        },
        reportTitle: "Независимая проверка замены",
        reportSubtitle: "запрошено ⇄ живое содержимое Google Docs",
        consentStore,
        auditId,
        preSnapshot,
      });
    }),
  );

  // ── docs_raw_batch_update ────────────────────────────────────────────────
  // Most dangerous write tool in this file (arbitrary Docs API requests).
  // Binding is necessarily weaker than the content-based tools above:
  // `requests` is an opaque bag of API operations (style, tables, images,
  // structural deletes…) with no generic "current state" to diff against.
  // What CAN be bound for real is the document's own identity — title,
  // revisionId AND full plain text, all re-read live at both plan and
  // execute time — which catches "wrong/renamed/deleted/concurrently-edited
  // document" drift; `requests` itself rides along from the manifest
  // unmodified (same as gmail_send's message body: protected by "payload
  // comes from the manifest, not the execute call's arguments", not by
  // content-diffing). Post-verify is honestly ALWAYS ⚠️ on success (STANDARD
  // §15.1 Q20: an operation where generic post-verify is technically
  // impossible must be named up front) — see postVerifyRawBatchApplied above
  // and GUIDE.md.
  interface RawBatchItem {
    documentId: string;
    requests: object[];
  }
  interface RawBatchPayload {
    account: string;
    items: RawBatchItem[];
  }

  server.registerTool(
    "docs_raw_batch_update",
    {
      title: "Raw Docs batchUpdate (advanced)",
      description:
        "Send raw Docs API batchUpdate `requests` to one or more documents (styling, tables, images, etc.). Use " +
        "only when other tools are not enough. Two-mode consent-gated tool " +
        "(mcp-development-standard/references/gate.md): call WITHOUT `manifest_id`/`user_reply` (with `items`) " +
        "to build a plan and return a preview — nothing is applied yet. Show the preview to the user verbatim and " +
        "wait for their reply. Call again with the returned `manifest_id` and the user's VERBATIM `user_reply` to " +
        "actually apply. Post-verify for this tool is always ⚠️ — arbitrary requests have no generically " +
        "checkable target state (honest limit, see GUIDE.md).",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              requests: z.array(z.record(z.string(), z.any())),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Required to build a plan (first call, no manifest_id/user_reply). Ignored on the execute call — " +
              "the approved batch is read back from the manifest.",
          ),
        manifest_id: z
          .string()
          .optional()
          .describe("Id of a plan built by a previous no-argument call. Pass together with `user_reply` to execute it."),
        user_reply: z.string().optional().describe(USER_REPLY_DOC),
      },
      annotations: { destructiveHint: true },
    },
    guard(async ({ account, items, manifest_id, user_reply }) => {
      const { consentStore, consentCfg } = ctx;
      if (!consentStore) {
        return fail(
          "Raw batchUpdate недоступен: не настроено хранилище согласия (DATABASE_URL). Без него сервер не может " +
            "провести это действие через гейт подтверждения — обратитесь к администратору сервера.",
        );
      }
      const g = clients.resolve(account);
      const accountName = account ?? clients.defaultName;

      const decision = await requireConsent<RawBatchPayload>({
        tool: "docs_raw_batch_update",
        accountLabel: accountName,
        manifestId: manifest_id,
        userReply: user_reply,
        store: consentStore,
        cfg: consentCfg,
        plan: async () => {
          if (!items || !items.length) {
            throw new Error("Нужны непустой `items`, чтобы построить план.");
          }
          const snapshot = await docBindingSnapshot(g, items);
          const payload: RawBatchPayload = { account: accountName, items: items as RawBatchItem[] };
          const lines = items.map((it, i) => {
            const kinds = (it.requests as object[]).map((r) => Object.keys(r)[0] ?? "?").join(", ");
            return (
              `- **«${safeText(snapshot[i].snap?.title ?? it.documentId, 80)}»** — ${it.requests.length} request(s): ` +
              `${safeText(kinds, 150)}`
            );
          });
          const preview =
            `### 📤 План: Raw batchUpdate — ${items.length} документ(ов)\n\n${lines.join("\n")}\n\n` +
            `⚠️ произвольный batchUpdate — сервер не может обобщённо показать точное содержимое изменений, только их тип и число`;
          const objectHash = sha256({
            account: accountName,
            items: snapshot.map((s) => ({
              documentId: s.documentId,
              title: s.snap?.title ?? null,
              revisionId: s.snap?.revisionId ?? null,
              text: s.snap?.text ?? null,
            })),
            requests: payload.items.map((it) => it.requests),
          });
          return { payload, objectHash, preview, batchSize: items.length };
        },
        rehash: async (addressing) => {
          const a = addressing as RawBatchPayload;
          const snapshot = await docBindingSnapshot(g, a.items);
          return sha256({
            account: a.account,
            items: snapshot.map((s) => ({
              documentId: s.documentId,
              title: s.snap?.title ?? null,
              revisionId: s.snap?.revisionId ?? null,
              text: s.snap?.text ?? null,
            })),
            requests: a.items.map((it) => it.requests),
          });
        },
      });

      if (decision.kind === "planned") return ok(decision.preview);
      if (decision.kind === "refused") return ok(decision.result);

      const { payload, auditId } = decision;
      const results: Array<{
        documentId: string;
        replies?: unknown;
        error?: string;
      }> = [];
      for (const item of payload.items) {
        const { documentId, requests } = item;
        try {
          const res = await g.docs.documents.batchUpdate({
            documentId,
            requestBody: { requests: requests as object[] },
          });
          results.push({ documentId, replies: res.data.replies });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return buildMutationResult({
        results,
        total: payload.items.length,
        verb: "Applied",
        summaryIcon: "⚙️",
        verify: (r) => postVerifyRawBatchApplied(g, r.documentId),
        reportTitle: "Независимая проверка raw batchUpdate",
        reportSubtitle: "запрошено ⇄ доступность документа (содержимое не проверяется — честный предел)",
        consentStore,
        auditId,
      });
    }),
  );

  // ── docs_consent_audit ───────────────────────────────────────────────────
  // "Разбор инцидента без ssh" (limits-audit.md §11) — ported from gmail-mcp's
  // gmail_consent_audit / sheets-mcp's sheets_consent_audit. Read-only path
  // over the same consent_audit table the gate writes to; answers "what did
  // the consent gate actually decide" and "did it block anything today"
  // without reading server logs.

  server.registerTool(
    "docs_consent_audit",
    {
      title: "Read the consent-gate audit log",
      description:
        "Read-only log of every decision the consent gate has made for the gated docs_* write tools " +
        "(docs_create/docs_append_text/docs_insert_text/docs_replace_text/docs_raw_batch_update): plan built, " +
        "confirmed, refused, or invalidated, plus — once the mutation actually ran — its outcome and post-verify " +
        "result. This is how to answer \"what actually happened to that document\" or \"did the gate block " +
        "anything today\" without reading server logs. Filter by `since`/`until` (ISO 8601), `account`, `tool`, " +
        "or `outcome` (confirmed/refused/invalidated/failed — a manifest that's only been planned and never " +
        "answered has no audit row yet, nothing to show). Results are newest first, capped at 100 per page " +
        "(default 20); use `offset` to page through older rows. External text (the verbatim user_reply and the " +
        "outbound pre-snapshot) is shown neutralised, never as live markdown.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe("Filter to one account label. Omit to show all accounts, not just the default."),
        since: z.string().optional().describe("ISO 8601 datetime — only rows at or after this time."),
        until: z.string().optional().describe("ISO 8601 datetime — only rows at or before this time."),
        tool: z
          .string()
          .optional()
          .describe("Filter to one tool name, e.g. 'docs_replace_text'. Omit to show every gated tool."),
        outcome: z
          .enum(["confirmed", "refused", "invalidated", "failed"])
          .optional()
          .describe("Filter to one outcome. Omit to show all."),
        limit: z.number().int().min(1).max(100).default(20).optional().describe("Max rows to return (1-100, default 20)."),
        offset: z.number().int().min(0).default(0).optional().describe("Skip this many newest-first rows — for paging past the first `limit`."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, since, until, tool, outcome, limit, offset }) => {
      const { auditStore, consentCfg } = ctx;
      if (!auditStore) {
        return ok({
          summary: "Audit log unavailable — DATABASE_URL is not configured, so nothing has been recorded.",
          results: [],
        });
      }
      const parseWhen = (label: string, s?: string): number | undefined => {
        if (!s) return undefined;
        const t = Date.parse(s);
        if (Number.isNaN(t)) throw new Error(`Cannot parse ${label}="${s}". Use ISO 8601, e.g. 2026-08-04T00:00:00-07:00.`);
        return t;
      };
      const filters = {
        server: consentCfg.server,
        since: parseWhen("since", since),
        until: parseWhen("until", until),
        accountLabel: account?.trim() || undefined,
        tool: tool?.trim() || undefined,
        outcome,
      };
      const cap = limit ?? 20;
      const off = offset ?? 0;
      const [rows, total] = await Promise.all([
        auditStore.listConsentAudit(filters, cap, off),
        auditStore.countConsentAudit(filters),
      ]);

      const outcomeIcon = (o: string): string =>
        o === "confirmed" ? "✅" : o === "failed" ? "❌" : o === "refused" || o === "invalidated" ? "🛑" : "•";

      const header = "| Время (PT) | Инструмент | Аккаунт | Actor | Исход | user_reply | post-verify | Детали |";
      const sep = "|---|---|---|---|---|---|---|---|";
      const lines = rows.map((r) => {
        const details = r.error
          ? `ошибка: ${safeText(r.error, 80)}`
          : r.preSnapshot
            ? `снимок: ${safeText(JSON.stringify(r.preSnapshot), 100)}`
            : "—";
        return (
          `| ${formatLaTime(r.ts)} | ${r.tool} | ${r.accountLabel} | ${r.actor} | ` +
          `${outcomeIcon(r.outcome)} ${r.outcome} | ${safeText(r.userReply, 60) || "—"} | ` +
          `${safeText(r.postVerifyResult ?? "", 60) || "—"} | ${details} |`
        );
      });

      const shownNote =
        total > off + rows.length
          ? `Показано ${rows.length} из ${total} (записи ${off + 1}–${off + rows.length}); ` +
            `есть ещё — вызовите снова с offset=${off + rows.length}.`
          : `Показано ${rows.length} из ${total}.`;

      const body = rows.length ? [header, sep, ...lines].join("\n") : "Нет записей, подходящих под фильтры.";

      return ok(`### 🧾 Журнал согласий\n\n${shownNote}\n\n${body}`);
    }),
  );
}
