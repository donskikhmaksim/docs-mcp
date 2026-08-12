import express, { type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Account, Config, User } from "./config.js";
import { loadConsentHubSecret } from "./config.js";
import { buildMcpServer, tgApprovalConfig, tgApprovalStoreAdapter, consentStoreAdapter, consentServerConfig } from "./server.js";
import { GoogleFederatedProvider } from "./oauthProvider.js";
import {
  getGoogleAccounts,
  listGoogleAccounts,
  removeGoogleAccount,
  setDefaultAccount,
  renameAccount,
  listApprovedUnexecuted,
  listPendingConsents,
  rejectManifest,
  type ConsentManifestRow,
} from "./store.js";
import { renderDashboard } from "./dashboard.js";
import { logDashboardLocation } from "./logRedaction.js";
import { buildUserClients } from "./accounts.js";
import { handleWebhook, registerWebhook, reportAutoExecutionResult, secretTokenMatches } from "./tg_approval.js";
import { tryAutoExecute } from "./consent.js";
import { getAutoExecutor, type AutoExecutorCtx } from "./autoExecute.js";
import { listGatedTools } from "./gated_tools_catalog.js";
import { AUTOMATION_SERVICE } from "./automation_key.js";
import { safeText } from "./util.js";

const JSONRPC_UNAUTHORIZED = {
  jsonrpc: "2.0" as const,
  error: { code: -32001, message: "Unauthorized" },
  id: null,
};

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractLegacyToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1]) return match[1];
  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey;
  const q = req.query?.key ?? req.query?.token;
  if (typeof q === "string") return q;
  return "";
}

function resolveLegacyUser(req: Request, config: Config): User | null {
  const provided = extractLegacyToken(req);
  if (!provided) return null;
  for (const user of config.users) {
    if (user.token && tokensEqual(provided, user.token)) return user;
  }
  return null;
}

/**
 * Chooses which User to serve a static-token (legacy MCP_AUTH_TOKEN) request
 * with, when onboarding is enabled: prefer live Postgres-backed accounts,
 * falling back to the env-configured `legacyUser` only when onboarding has
 * nothing linked yet (or is disabled). Pulled out of handleMcp as a pure,
 * Express-free function so it is unit-testable without a running server or a
 * real database — see scripts/test-credential-source.mjs.
 */
export async function selectLegacyOrOnboardingUser(
  legacyUser: User,
  onboardingEnabled: boolean,
  fetchOnboardingUser: () => Promise<User | null>,
): Promise<User | null> {
  if (!onboardingEnabled) return legacyUser;
  const onboardingUser = await fetchOnboardingUser();
  return onboardingUser ?? (legacyUser.accounts.length ? legacyUser : null);
}

/** Builds the User from ALL Google accounts linked to this instance via onboarding. */
export async function userFromGoogleAccounts(config: Config): Promise<User | null> {
  const accounts = await getGoogleAccounts();
  if (!accounts.length) return null;
  const clientId = config.onboarding.googleClientId!;
  const clientSecret = config.onboarding.googleClientSecret!;
  const mapped: Account[] = accounts.map((a) => ({
    name: a.label,
    auth: { mode: "oauth", clientId, clientSecret, refreshToken: a.refreshToken },
  }));
  const def = accounts.find((a) => a.isDefault) ?? accounts[0];
  return {
    name: def.email,
    accounts: mapped,
    defaultAccount: def.label,
  };
}

/** Constant-time compare for the dashboard path secret. Reused below for the
 * consent web-hub's own secret (same discipline — see `CONSENT_HUB_SECRET`). */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Consent web-hub backend (docs/TZ_consent_web_hub.md, часть 2) ---------
//
// `loadConsentHubSecret()` is called fresh on every request (cheap — just an
// env read, same env var CONSENT_HUB_SECRET a deployer sets once), NOT cached
// at module scope like `tgApprovalConfig`: this keeps the guard trivially
// testable with `process.env.CONSENT_HUB_SECRET` toggled between calls (see
// scripts/test-pending-consents.mjs), without needing a process restart to
// pick up a changed value either. `undefined` ⇒ both routes below 404
// unconditionally (fail-closed, checked FIRST in the guard, before even
// looking at the header).

/** Guards both `/pending-consents*` routes: missing secret configuration OR a
 * missing/wrong `X-Consent-Hub-Secret` header both 404 — NOT 401/403, so an
 * unauthenticated caller can't tell "wrong secret" from "route doesn't
 * exist" (same reasoning as `/tg/webhook`'s TG_WEBHOOK_OWNER gate above, and
 * literally required by docs/TZ_consent_web_hub.md's test plan §7/§8). */
function consentHubGuard(req: Request, res: Response): boolean {
  const secret = loadConsentHubSecret();
  if (!secret) {
    res.status(404).end();
    return false;
  }
  const provided = req.header("x-consent-hub-secret") ?? "";
  if (!provided || !secretMatches(provided, secret)) {
    res.status(404).end();
    return false;
  }
  return true;
}

/** One item of `GET /pending-consents`'s response — shape mandated by
 * docs/TZ_consent_web_hub.md §"Backend" точка 1. */
interface PendingConsentItem {
  manifestId: string;
  tool: string;
  title: string;
  summary: string;
  preview: string;
  createdAt: number;
  expiresAt: number;
  accountLabel: string;
}

/** Human-friendly tool title — mirrors each tool's `title` in
 * `registerTool(...)` (tools/docs.ts), duplicated here ONLY as a display
 * label (not re-implementing gate logic) since http.ts must not import
 * tools/docs.ts (that file registers live MCP tools against a real
 * `UserClients`, which this route doesn't have). */
const TOOL_TITLES: Record<string, string> = {
  docs_create: "Создание документов",
  docs_append_text: "Добавление текста",
  docs_insert_text: "Вставка текста",
  docs_replace_text: "Замена текста",
  docs_raw_batch_update: "Batch-запрос (raw)",
};

/**
 * Строит `title`/`summary`/`preview` для одного pending-манифеста из его
 * `payload` — НЕ из отдельных колонок БД (`consent_manifests` не хранит
 * рендер превью, который был показан модели/в Telegram — только структуру
 * батча + `objectHash`, см. store.ts's `ensureSchema()`). Это ЧЕСТНОЕ
 * применение ТЗ §"Backend" точка 1 ("если в сторе нет отдельных полей —
 * выведи их из превью") к тому, что реально есть в этой схеме: вместо
 * хранимого текста превью здесь пересобирается ЭКВИВАЛЕНТНОЕ по смыслу
 * человекочитаемое описание НАПРЯМУЮ из `payload` (без похода в живой Google
 * Docs — это read-only список для веб-хаба, а не re-plan). Явно отмечено в
 * отчёте (docs-mcp не хранит preview-текст в манифесте — не мигрируем схему
 * ради этого, см. ТЗ "Что НЕ трогать").
 */
function describePendingConsent(row: ConsentManifestRow): PendingConsentItem {
  const title = TOOL_TITLES[row.tool] ?? row.tool;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  let summary = "";
  let previewLines: string[] = [];
  try {
    if (row.tool === "docs_create") {
      const documents = (payload.documents as Array<{ title?: string }>) ?? [];
      summary = `${documents.length} документ(ов): ${documents.map((d) => safeText(d.title, 40)).join(", ")}`;
      previewLines = documents.map((d) => `- «${safeText(d.title, 120)}»`);
    } else if (row.tool === "docs_append_text") {
      const items = (payload.items as Array<{ documentId?: string; text?: string }>) ?? [];
      summary = `${items.length} документ(ов), добавление текста`;
      previewLines = items.map((it) => `- ${safeText(it.documentId, 40)}: +«${safeText(it.text, 150)}»`);
    } else if (row.tool === "docs_insert_text") {
      const items = (payload.items as Array<{ documentId?: string; text?: string; index?: number }>) ?? [];
      summary = `${items.length} документ(ов), вставка текста`;
      previewLines = items.map(
        (it) => `- ${safeText(it.documentId, 40)} @${it.index ?? "?"}: «${safeText(it.text, 150)}»`,
      );
    } else if (row.tool === "docs_replace_text") {
      const items = (payload.items as Array<{ documentId?: string; find?: string; replace?: string }>) ?? [];
      summary = `${items.length} документ(ов), замена текста`;
      previewLines = items.map(
        (it) => `- ${safeText(it.documentId, 40)}: «${safeText(it.find, 60)}» → «${safeText(it.replace, 60)}»`,
      );
    } else if (row.tool === "docs_raw_batch_update") {
      const items = (payload.items as Array<{ documentId?: string; requests?: unknown[] }>) ?? [];
      summary = `${items.length} документ(ов), произвольный batchUpdate`;
      previewLines = items.map((it) => `- ${safeText(it.documentId, 40)}: ${(it.requests ?? []).length} запрос(ов)`);
    } else {
      summary = "Ожидает подтверждения";
      previewLines = [JSON.stringify(payload).slice(0, 300)];
    }
  } catch {
    summary = "Ожидает подтверждения (не удалось разобрать payload)";
  }
  const accountLabel = typeof payload.account === "string" ? payload.account : row.accountLabel;
  return {
    manifestId: row.id,
    tool: row.tool,
    title,
    summary,
    preview: `### ${title}\n\n${previewLines.join("\n") || summary}`,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    accountLabel,
  };
}

/**
 * Собирает `AutoExecutorCtx` из текущей конфигурации — общий кусок,
 * вынесенный из `runAutoExecutePoller` (Максим, 2026-08-05) так, чтобы им же
 * мог пользоваться `/pending-consents/decide` (docs/TZ_consent_web_hub.md,
 * часть 2 — `decide confirm` обязана исполнять РОВНО тем же путём, что и
 * нажатие кнопки в Telegram, `tryAutoExecute`+per-tool `execute`, а не
 * дублировать сборку `ctx`). `null`, если пользователя вообще нет
 * (honest degradation — как и в самом поллере).
 */
async function buildAutoExecuteCtx(config: Config): Promise<AutoExecutorCtx | null> {
  const user = (await userFromGoogleAccounts(config)) ?? config.users[0] ?? null;
  if (!user) return null;
  const clients = buildUserClients(user);
  return { clients, consentStore: consentStoreAdapter, userToken: user.token ?? null };
}

/** Small HTTP-shaped result — `{status, body}` — returned by the pure
 * pending-consents handlers below, so the Express route wiring is a
 * one-liner and the actual logic is testable without Express/a real DB. */
interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** Dependencies `handlePendingConsentsList`/`handlePendingConsentsDecide`
 * need — DI'd (same convention as `consent.ts`'s own `ConsentStore`/`tg`
 * params) so tests can substitute fakes instead of the real store.ts/
 * autoExecute.ts singletons. `now`/`makeId` are injectable for deterministic
 * tests (mirrors `consent.ts`'s own `cfg.now` convention). */
export interface PendingConsentsDeps {
  listPendingConsents: (server: string, nowMs: number) => Promise<ConsentManifestRow[]>;
  getManifest: (id: string, server: string) => Promise<ConsentManifestRow | null>;
  rejectManifest: (id: string, server: string, userReply: string) => Promise<ConsentManifestRow | null>;
  appendConsentAudit: (entry: Parameters<typeof consentStoreAdapter.appendConsentAudit>[0]) => Promise<void>;
  getAutoExecutor: (tool: string) => ReturnType<typeof getAutoExecutor>;
  tryAutoExecute: typeof tryAutoExecute;
  buildCtx: (config: Config) => Promise<AutoExecutorCtx | null>;
  server: string;
  now: () => number;
  makeId: () => string;
}

/** Real, production dependency bundle — thin route handlers above pass this
 * (plus the real `config`) straight through. */
const pendingConsentsDeps: PendingConsentsDeps = {
  listPendingConsents,
  getManifest: consentStoreAdapter.getManifest,
  rejectManifest,
  appendConsentAudit: consentStoreAdapter.appendConsentAudit,
  getAutoExecutor,
  tryAutoExecute,
  buildCtx: buildAutoExecuteCtx,
  server: consentServerConfig.server,
  now: Date.now,
  makeId: randomUUID,
};

/** `GET /pending-consents` — list this server's own AWAITING_CONSENT,
 * not-expired manifests (docs/TZ_consent_web_hub.md §"Backend" точка 1). */
export async function handlePendingConsentsList(deps: PendingConsentsDeps, server: string): Promise<HttpResult> {
  try {
    const rows = await deps.listPendingConsents(server, deps.now());
    return { status: 200, body: { service: server, items: rows.map(describePendingConsent) } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/** `POST /pending-consents/decide` — confirm re-uses `tryAutoExecute` +
 * per-tool `execute` from `autoExecute.ts`'s registry (the SAME path a
 * Telegram button confirms through, docs/TZ_consent_web_hub.md §"Backend"
 * точка 2 — no separate binding/consume/audit copy). Reject is atomic
 * (`rejectManifest`, store.ts) + its own audit entry, actor="web" so the
 * audit log honestly distinguishes it from a chat reply ("human") or a
 * Telegram button (`TG_AUTO_REPLY_MARKER`/"tg_auto"). Never 500 on the 4
 * predictable causes (not_found/already_decided/binding_mismatch/expired) —
 * only for genuinely unexpected server errors. */
export async function handlePendingConsentsDecide(
  deps: PendingConsentsDeps,
  config: Config,
  params: { manifestId: string; decision: unknown; comment: string },
): Promise<HttpResult> {
  const { manifestId, decision, comment } = params;
  if (!manifestId || (decision !== "confirm" && decision !== "reject")) {
    return { status: 400, body: { error: "bad_request" } };
  }

  const row = await deps.getManifest(manifestId, deps.server);
  if (!row) return { status: 404, body: { error: "not_found" } };
  if (row.status !== "AWAITING_CONSENT") return { status: 409, body: { error: "already_decided" } };
  if (row.expiresAt <= deps.now()) return { status: 410, body: { error: "expired" } };

  if (decision === "reject") {
    const userReply = comment ? `[веб-хаб: отклонено] ${comment}` : "[веб-хаб: отклонено без комментария]";
    const rejected = await deps.rejectManifest(manifestId, deps.server, userReply);
    if (!rejected) return { status: 409, body: { error: "already_decided" } };
    await deps.appendConsentAudit({
      id: deps.makeId(),
      ts: deps.now(),
      server: deps.server,
      tool: row.tool,
      accountLabel: row.accountLabel,
      manifestId,
      objectHash: row.objectHash,
      userReply,
      checks: { source: "web_hub" },
      outcome: "invalidated",
      refusalReason: "web_hub_reject",
      actor: "web",
    });
    return { status: 200, body: { ok: true, outcome: "refused" } };
  }

  // decision === "confirm"
  const executor = deps.getAutoExecutor(row.tool);
  if (!executor) return { status: 500, body: { error: "no_executor" } };
  const ctx = await deps.buildCtx(config);
  if (!ctx) return { status: 500, body: { error: "no_account" } };
  const result = await deps.tryAutoExecute(
    { manifestId, tool: row.tool, accountLabel: row.accountLabel },
    executor.rehash,
    consentStoreAdapter,
    consentServerConfig,
    ctx,
  );
  if (!result) {
    // Атомарная гонка consumeManifest проиграна (дрейф состояния/уже
    // исполнено между чтением строки выше и этой попыткой) — единственный
    // из 4 машиночитаемых кодов, который сюда честно подходит.
    return { status: 409, body: { error: "binding_mismatch" } };
  }
  const reportText = await executor.execute(result.payload, result.auditId, ctx);
  return { status: 200, body: { ok: true, outcome: "confirmed", result: reportText } };
}

/**
 * Фоновый поллер авто-исполнения по кнопке (Максим, 2026-08-05 — см.
 * `consent.ts`'s `tryAutoExecute` doc-comment). Раз в тик находит манифесты
 * этого сервера, у которых уже APPROVED-строка в `tg_approvals`, но которые
 * ещё не были исполнены моделью, и исполняет их напрямую через
 * `autoExecute.ts`'s per-tool `execute` — без единого вызова MCP-инструмента.
 *
 * В ОТЛИЧИЕ от `runApprovalSweep` (тот работает ТОЛЬКО на владельце
 * вебхука) — этот поллер работает НА КАЖДОМ сервере, включая этот, без
 * гейта по `webhookOwner`: исполнение полностью децентрализовано, сервер
 * следит только за СВОИМИ манифестами (`consent_manifests.server` = свой
 * server) — никакой межпроцессной связи с другими серверами не нужно,
 * кнопка уже централизованно решается общим вебхуком (см. `handleWebhook`),
 * а этот поллер просто видит результат в общем Postgres.
 *
 * Два независимых режима гейта (Максим подтвердил явно) остаются нетронуты:
 * если `TG_APPROVAL_ENABLED=false` (или тул не в allowlist) — сюда манифест
 * вообще не попадёт (нет строки в tg_approvals), обычный чат-«да»-путь через
 * `requireConsent()` работает побайтово как раньше.
 */
async function runAutoExecutePoller(config: Config): Promise<void> {
  const candidates = await listApprovedUnexecuted(consentServerConfig.server, Date.now());
  if (!candidates.length) return;

  const ctx = await buildAutoExecuteCtx(config);
  if (!ctx) {
    console.error("TG auto-execute: нет доступного пользователя — пропускаю тик поллера");
    return;
  }
  // Один ctx на весь тик — тот же объект уходит и в rehash (для тулов с
  // настоящим биндингом, которым нужен живой `g`), и в execute, см.
  // `autoExecute.ts`'s `AutoExecutorCtx` doc-comment.
  for (const c of candidates) {
    const executor = getAutoExecutor(c.tool);
    if (!executor) {
      // Инструмент ещё не переведён на новый паттерн (см. autoExecute.ts) —
      // манифест останется PENDING/APPROVED и будет исполнен, как только
      // модель сама позовёт execute (старый путь), либо когда этот тул
      // получит свой executor. НЕ ошибка, просто ещё не покрыто.
      continue;
    }
    try {
      const result = await tryAutoExecute(
        { manifestId: c.manifestId, tool: c.tool, accountLabel: c.accountLabel },
        executor.rehash,
        consentStoreAdapter,
        consentServerConfig,
        ctx,
      );
      if (!result) continue; // гонка/дрейф/истёк — тихо пропускаем, это не ошибка
      const reportText = await executor.execute(result.payload, result.auditId, ctx);
      await reportAutoExecutionResult(tgApprovalConfig, c.chatId, c.messageId, reportText);
    } catch (err) {
      console.error(`TG auto-execute: ошибка при исполнении ${c.tool}/${c.manifestId}:`, err);
      // НЕ помечаем как исполненное при ошибке ДО tryAutoExecute — если он
      // успел вызвать consumeManifest (манифест одноразовый), повторной
      // попытки уже не будет; отчёт об ошибке всё равно стоит попытаться
      // отправить, чтобы Максим не остался с зависшими кнопками в боте.
      await reportAutoExecutionResult(
        tgApprovalConfig, c.chatId, c.messageId,
        `🛑 Ошибка при автоисполнении «${c.tool}»: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    }
  }
}

export async function startHttpServer(config: Config): Promise<void> {
  const app = express();
  // Railway (and most PaaS) terminate TLS behind a reverse proxy; trust its
  // X-Forwarded-For so express-rate-limit (used by the SDK's auth handlers)
  // keys correctly per real client IP instead of the proxy's.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "10mb" }));
  // Dashboard forms POST application/x-www-form-urlencoded.
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.json({ status: "ok", endpoint: "/mcp" });
  });
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // ---- automation_key method catalog (docs/TZ_automation_key_method_catalog.md) ----
  // No auth: the LIST of gated method NAMES isn't sensitive data (same
  // principle as `tools/list` itself, which is reachable by anyone who
  // completes MCP auth anyway — here there isn't even that gate, because
  // tool names carry nothing secret). Consumed by gmail-mcp's hub mini-app
  // to render a per-method checkbox tree instead of only per-service.
  app.get("/automation-key-catalog", async (_req: Request, res: Response) => {
    try {
      const tools = await listGatedTools();
      res.json({ service: AUTOMATION_SERVICE, tools });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Consent web-hub backend (docs/TZ_consent_web_hub.md, часть 2) ----
  // ТОЛЬКО backend-роуты ЭТОГО сервиса (docs) — сама страница-хаб и
  // агрегатор четырёх соседей живут в gmail-mcp, не здесь (см. ТЗ). Route
  // handlers here are thin — the actual decision logic is in
  // `handlePendingConsentsList`/`handlePendingConsentsDecide` below, pulled
  // out Express-free (same reasoning as `selectLegacyOrOnboardingUser` above)
  // so it's unit-testable with fake stores, without a live Postgres.
  app.get("/pending-consents", async (req: Request, res: Response) => {
    if (!consentHubGuard(req, res)) return;
    const result = await handlePendingConsentsList(pendingConsentsDeps, consentServerConfig.server);
    res.status(result.status).json(result.body);
  });

  app.post("/pending-consents/decide", async (req: Request, res: Response) => {
    if (!consentHubGuard(req, res)) return;
    const result = await handlePendingConsentsDecide(pendingConsentsDeps, config, {
      manifestId: typeof req.body?.manifestId === "string" ? req.body.manifestId : "",
      decision: req.body?.decision,
      comment: typeof req.body?.comment === "string" ? req.body.comment : "",
    });
    res.status(result.status).json(result.body);
  });

  // ---- Optional Telegram-approval webhook (plan-tg-approval.md) ----
  // Deliberately OUTSIDE the normal /mcp auth -- Telegram itself calls this,
  // not an MCP client. Protected by the secret_token Telegram echoes back on
  // every request (set via registerWebhook's setWebhook call below), checked
  // constant-time. Mounted unconditionally (cheap route, no-op body) so
  // toggling TG_APPROVAL_ENABLED never needs a redeploy of routing -- when
  // disabled, tgApprovalConfig.webhookSecret is "" and secretTokenMatches
  // rejects every request (empty expected secret never matches).
  app.post("/tg/webhook", async (req: Request, res: Response) => {
    // Route-level gate on TG_WEBHOOK_OWNER -- checked FIRST, before reading
    // the secret header or the body. Defense-in-depth alongside
    // registerWebhook's own self-guard (tg_approval.ts): since
    // consumeTgDecisionAnyServer made webhook consume server-agnostic across
    // all 6 MCP servers that will eventually share one Telegram bot token
    // (gmail/sheets/calendar/docs/drive-mcp + ticktick-mcp), a
    // TG_APPROVAL_WEBHOOK_SECRET leak on ANY single one of them would
    // otherwise let an attacker decide approvals for every other server too
    // -- including gmail_send, the most dangerous one. A server that isn't
    // the designated owner must never process this route at all, even with a
    // technically-correct secret, and must never depend on whoever ports this
    // file to the other 5 repos remembering to not mount the route --
    // 404 (not 401) so a non-owner server doesn't even reveal the route exists.
    //
    // `ownBot` (TG_BOT_TOKEN_OVERRIDE, config.ts) is the escape hatch from the
    // shared-bot model above: a server with its OWN dedicated bot token always
    // owns its own webhook -- there is no shared registration to race against,
    // so `webhookOwner` is irrelevant for it. Full backward compatibility: with
    // TG_BOT_TOKEN_OVERRIDE unset, `ownBot` is false and this condition reduces
    // to the original `!tgApprovalConfig.webhookOwner` check, byte-for-byte.
    if (!tgApprovalConfig.webhookOwner && !tgApprovalConfig.ownBot) {
      res.status(404).end();
      return;
    }
    const provided = req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!secretTokenMatches(provided, tgApprovalConfig.webhookSecret)) {
      res.status(401).end();
      return;
    }
    try {
      await handleWebhook(tgApprovalConfig, tgApprovalStoreAdapter, req.body);
    } catch (err) {
      console.error("TG approval webhook error:", err);
    }
    // Always 200 -- Telegram retries on non-2xx, and every failure mode here
    // (wrong from.id, replay, unknown callback_data) is intentionally a no-op,
    // not an error Telegram should retry.
    res.status(200).end();
  });

  let provider: GoogleFederatedProvider | null = null;

  if (config.onboarding.enabled) {
    const baseUrl = config.onboarding.publicBaseUrl!;
    provider = new GoogleFederatedProvider({
      googleClientId: config.onboarding.googleClientId!,
      googleClientSecret: config.onboarding.googleClientSecret!,
      baseUrl,
      relayUrl: config.onboarding.relayUrl,
      relaySecret: config.onboarding.relaySecret,
      ownerEmails: config.onboarding.ownerEmails,
    });

    const issuerUrl = new URL(baseUrl);
    const resourceServerUrl = new URL(`${baseUrl}/mcp`);

    app.use(mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl,
      scopesSupported: ["sheets", "drive", "docs", "gmail", "calendar"],
    }));

    // Google (via the relay) redirects here after the user grants consent.
    app.get("/oauth/google/callback", async (req: Request, res: Response) => {
      const { code, state, error } = req.query as Record<string, string>;
      if (error) {
        res.status(400).send(`Google returned an error: ${error}. <a href="javascript:history.back()">Go back</a>`);
        return;
      }
      if (!code || !state) {
        res.status(400).send("Missing code or state.");
        return;
      }
      try {
        const result = await provider!.handleGoogleCallback(code, state);
        res.redirect(result.redirectUrl);
      } catch (err) {
        console.error("Google callback error:", err);
        res.status(400).send((err as Error).message);
      }
    });

    // ---- Account-management dashboard (guarded by an unguessable path secret) ----
    const dashSecret = config.onboarding.dashboardSecret;
    if (dashSecret) {
      const base = `/dashboard/${dashSecret}`;
      const guard = (req: Request, res: Response): boolean => {
        if (secretMatches(String(req.params.secret ?? ""), dashSecret)) return true;
        res.status(403).send("Forbidden");
        return false;
      };

      app.get("/dashboard/:secret", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        const accounts = await listGoogleAccounts();
        const msg = typeof req.query.msg === "string" ? req.query.msg : undefined;
        res.type("html").send(renderDashboard(base, accounts, msg));
      });

      // Start "add another account" — bounce to Google via the relay.
      app.get("/dashboard/:secret/add", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        try {
          const url = await provider!.startAddAccount(baseUrl);
          res.redirect(url);
        } catch (err) {
          console.error("add-account error:", err);
          res.status(400).send((err as Error).message);
        }
      });

      app.post("/dashboard/:secret/remove", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        await removeGoogleAccount(String(req.body?.email ?? ""));
        res.redirect(`${base}?msg=removed`);
      });

      app.post("/dashboard/:secret/default", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        await setDefaultAccount(String(req.body?.email ?? ""));
        res.redirect(`${base}?msg=default`);
      });

      app.post("/dashboard/:secret/rename", async (req: Request, res: Response) => {
        if (!guard(req, res)) return;
        const ok = await renameAccount(String(req.body?.email ?? ""), String(req.body?.label ?? ""));
        res.redirect(`${base}?msg=${ok ? "renamed" : "rename_failed"}`);
      });

      // #119: НЕ печатать сам секрет — он же пароль от дашборда, а логи
      // Railway видит каждый, у кого есть доступ к проекту.
      logDashboardLocation(baseUrl, base, dashSecret);
    }

    console.error(`Native MCP OAuth enabled — clients connect and authorize directly at ${baseUrl}/mcp`);
  }

  const bearerMiddleware = provider
    ? requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${config.onboarding.publicBaseUrl}/mcp`)),
      })
    : null;

  const handleMcp = async (req: Request, res: Response) => {
    let user: User | null = null;

    if (req.auth) {
      // Bearer token validated by requireBearerAuth; resolve the linked Google accounts.
      user = await userFromGoogleAccounts(config);
    } else if (!config.requireAuth) {
      user = config.users[0] ?? null;
    } else {
      const legacyUser = resolveLegacyUser(req, config);
      user = legacyUser
        ? await selectLegacyOrOnboardingUser(legacyUser, config.onboarding.enabled, () =>
            userFromGoogleAccounts(config),
          )
        : null;
    }

    if (!user) {
      res.status(401).json(JSONRPC_UNAUTHORIZED);
      return;
    }
    const server = buildMcpServer(user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  if (bearerMiddleware) {
    // Legacy ?key=/x-api-key links (from before native OAuth) keep working by
    // resolving directly against the static env-configured users. Everything
    // else — including requests with NO Authorization header at all — goes
    // through requireBearerAuth, so first-contact discovery requests get a
    // proper 401 + WWW-Authenticate pointing at the protected-resource metadata.
    app.post("/mcp", (req, res, next) => {
      if (resolveLegacyUser(req, config)) return next();
      return bearerMiddleware(req, res, next);
    }, handleMcp);
  } else {
    app.post("/mcp", handleMcp);
  }

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  if (tgApprovalConfig.enabled) {
    await registerWebhook(tgApprovalConfig);

    // Авто-исполнение — отдельный, более частый цикл (отзывчивость важнее
    // для UX: нажал кнопку, ждёшь секунды, а не минуты). Работает на КАЖДОМ
    // сервере без гейта webhookOwner — см. runAutoExecutePoller's doc-comment.
    const AUTO_EXECUTE_INTERVAL_MS = 10 * 1000;
    setInterval(() => {
      runAutoExecutePoller(config).catch((err) =>
        console.error("TG auto-execute poller: unhandled error", err),
      );
    }, AUTO_EXECUTE_INTERVAL_MS).unref();
  }

  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.error(`MCP listening on :${config.port}  auth=${config.requireAuth ? "on" : "OFF"}  instance=${randomUUID().slice(0, 8)}`);
      if (!config.requireAuth && !config.onboarding.enabled) console.error("WARNING: no MCP_AUTH_TOKEN — endpoint is PUBLIC");
      resolve();
    });
  });
}
