#!/usr/bin/env node
/**
 * automation_key METHOD catalog (`docs/TZ_automation_key_method_catalog.md`).
 * Covers the backend-only test plan (sections 1-4 of that TZ; docs-mcp is not
 * the hub, so sections 5-7 don't apply here):
 *
 *   1. `listGatedTools()` — real run against the actual production server:
 *      every one of the 5 known gated docs tools is returned, and at least
 *      one NON-gated tool (`list_accounts`, registered by
 *      `registerAccountTools`, no `automation_key` in its schema) is NOT.
 *   2. `GET /automation-key-catalog` — live HTTP call against a real,
 *      listening `startHttpServer()` instance, no auth header sent.
 *   3. `scopeCovers` — new cases: exact `service:tool` match, prefix-sharing
 *      methods do NOT cross-match, bare `service` still covers every method
 *      (backward compat), `all` covers everything, empty/null scope fails
 *      closed.
 *   4. `checkAutomationKey(key, tool)` discrimination — a valid key scoped to
 *      ONE method passes that method and refuses (falls through silently)
 *      for a different gated method of the same service. Exercised through
 *      `requireConsent()` with a DI stub built on the REAL exported
 *      `scopeCovers` (not a reimplementation) over a fake in-memory window
 *      list — this repo has no live Postgres to hit `tg_automation_windows`
 *      through, same limitation `scripts/test-automation-key.mjs` already
 *      works around with DI mocks throughout.
 *   5. Regression — a bare `scope="docs"` window (issued before this change)
 *      keeps covering ANY method of docs-mcp, no DB migration involved.
 *
 * Usage: node scripts/test-gated-tools-catalog.mjs  (after `npm run build`)
 */
import { listGatedTools } from "../dist/gated_tools_catalog.js";
import { scopeCovers, checkAutomationKey, AUTOMATION_SERVICE } from "../dist/automation_key.js";
import { requireConsent, sha256 } from "../dist/consent.js";
import { startHttpServer } from "../dist/http.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

const KNOWN_GATED_TOOLS = [
  "docs_create",
  "docs_append_text",
  "docs_insert_text",
  "docs_replace_text",
  "docs_raw_batch_update",
];

// ── [1] listGatedTools(): real run, gated in / non-gated out ───────────────
console.log("\n[1] listGatedTools() — реальный прогон против собранного сервера docs-mcp");
{
  const tools = await listGatedTools();
  const names = tools.map((t) => t.name).sort();
  check(
    "все 5 известных гейтированных тулов присутствуют",
    KNOWN_GATED_TOOLS.every((n) => names.includes(n)),
    JSON.stringify(names),
  );
  check("ровно 5 записей (нет лишних/дублей)", tools.length === 5, JSON.stringify(names));
  check(
    "list_accounts (НЕ гейтирован — нет automation_key в схеме) отсутствует в каталоге",
    !names.includes("list_accounts"),
    JSON.stringify(names),
  );
  check(
    "у каждой записи есть непустое name и description-строка (может быть пустой, но это string)",
    tools.every((t) => typeof t.name === "string" && t.name.length > 0 && typeof t.description === "string"),
  );
  check(
    "описания обрезаны до разумной длины для UI (<=160 символов)",
    tools.every((t) => t.description.length <= 160),
    JSON.stringify(tools.map((t) => t.description.length)),
  );
}

// ── [2] GET /automation-key-catalog — live HTTP, no auth ───────────────────
console.log("\n[2] GET /automation-key-catalog — живой HTTP-вызов, без авторизации");
{
  const port = 34980;
  await startHttpServer({
    transport: "http",
    port,
    requireAuth: false,
    users: [],
    onboarding: { enabled: false },
  });
  const resp = await fetch(`http://127.0.0.1:${port}/automation-key-catalog`);
  check("статус 200 без единого заголовка авторизации", resp.status === 200, String(resp.status));
  const body = await resp.json();
  check("service === AUTOMATION_SERVICE ('docs')", body.service === AUTOMATION_SERVICE, JSON.stringify(body.service));
  const names = (body.tools ?? []).map((t) => t.name).sort();
  check(
    "тело содержит те же 5 ожидаемых имён методов, что и tool: \"...\" в requireConsent-вызовах docs.ts",
    JSON.stringify(names) === JSON.stringify([...KNOWN_GATED_TOOLS].sort()),
    JSON.stringify(names),
  );
}

// ── [3] scopeCovers — новые кейсы ───────────────────────────────────────────
console.log("\n[3] scopeCovers(scope, service, tool) — точное сравнение токенов");
{
  check("bare service покрывает ЛЮБОЙ метод (обратная совместимость)", scopeCovers("docs", "docs", "docs_create") === true);
  check("bare service покрывает ДРУГОЙ метод того же сервиса тоже", scopeCovers("docs", "docs", "docs_append_text") === true);
  check("all покрывает всё", scopeCovers("all", "docs", "anything_at_all") === true);
  check("service:tool матчит точно этот метод", scopeCovers("docs:docs_create", "docs", "docs_create") === true);
  check(
    "service:tool НЕ матчит другой метод того же сервиса",
    scopeCovers("docs:docs_create", "docs", "docs_append_text") === false,
  );
  check(
    "НЕ матчит общий префикс без разделителя (docs:docs_create vs docs:docs_create_extra)",
    scopeCovers("docs:docs_create", "docs", "docs_create_extra") === false,
  );
  check(
    "и наоборот — узкий токен не расширяется на префикс в другую сторону",
    scopeCovers("docs:docs_create_extra", "docs", "docs_create") === false,
  );
  check("другой сервис в scope не матчит текущий (google-docs !== docs)", scopeCovers("google-docs", "docs", "docs_create") === false);
  check("пустой/NULL scope — fail-closed", scopeCovers("", "docs", "docs_create") === false && scopeCovers(null, "docs", "docs_create") === false);
  check(
    "смешанный CSV: один токен весь сервис, другой — чужой метод — матчит по любому подходящему токену",
    scopeCovers("gmail:gmail_send,docs", "docs", "docs_replace_text") === true,
  );
}

// ── [4] checkAutomationKey(key, tool) сигнатура не падает без DB (honest degradation) ──
console.log("\n[4] checkAutomationKey(key, tool) — новая сигнатура, без Postgres тихо возвращает ok:false");
{
  const res = await checkAutomationKey("some-key", "docs_create");
  check("ok:false без падения (нет сконфигурированного store в этом тестовом процессе)", res.ok === false, JSON.stringify(res));
}

// ── [5] discrimination end-to-end через requireConsent, реальный scopeCovers ─
console.log("\n[5] discrimination: ключ со scope на ОДИН метод пропускает именно его и НЕ пропускает другой гейтированный метод того же сервиса");
{
  const FAKE_WINDOWS = [
    { token: "method-key", scope: "docs:docs_create", createdAt: 1 },
    { token: "service-key", scope: "docs", createdAt: 2 }, // старое bare-service окно — регресс
  ];
  const fakeCheckAutomationKey = async (key, tool) => {
    for (const w of FAKE_WINDOWS) {
      if (!scopeCovers(w.scope, AUTOMATION_SERVICE, tool)) continue;
      if (w.token === key) return { ok: true, channel: `window:${w.createdAt}` };
    }
    return { ok: false };
  };

  const clock = { t: 1_700_000_000_000 };
  const cfg = { server: "docs", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now: () => clock.t };
  const PAYLOAD = { account: "work", items: [{ documentId: "DOC1" }] };
  const OBJHASH = sha256(PAYLOAD);
  const plan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "### 📤 План", batchSize: 1 });
  const rehash = () => OBJHASH;

  function makeStore() {
    const manifests = new Map();
    const audits = [];
    return {
      manifests,
      audits,
      async createManifest(input) {
        manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
      },
      async getManifest(id, server) {
        const r = manifests.get(id);
        return r && r.server === server ? { ...r } : null;
      },
      async consumeManifest() {
        return null;
      },
      async invalidateManifest() {},
      async appendConsentAudit(entry) {
        audits.push({ ...entry });
      },
      async updateConsentAuditOutcome() {},
    };
  }

  // 5a. method-scoped key on docs_create → confirmed, first call.
  {
    const store = makeStore();
    const dec = await requireConsent({
      tool: "docs_create",
      accountLabel: "work",
      automationKey: "method-key",
      checkAutomationKey: fakeCheckAutomationKey,
      plan,
      rehash,
      store,
      cfg,
    });
    check("docs_create с method-key на docs:docs_create → confirmed", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 100));
  }

  // 5b. SAME key on a DIFFERENT gated method of the same service → falls through (planned, not confirmed).
  {
    const store = makeStore();
    const dec = await requireConsent({
      tool: "docs_append_text",
      accountLabel: "work",
      automationKey: "method-key",
      checkAutomationKey: fakeCheckAutomationKey,
      plan,
      rehash,
      store,
      cfg,
    });
    check(
      "тот же method-key на docs_append_text → НЕ confirmed (падает на обычный план)",
      dec.kind === "planned",
      JSON.stringify(dec).slice(0, 100),
    );
  }

  // 5 regression. bare service-key still covers ANY method — the pre-existing window keeps working untouched.
  {
    const storeA = makeStore();
    const decA = await requireConsent({
      tool: "docs_create",
      accountLabel: "work",
      automationKey: "service-key",
      checkAutomationKey: fakeCheckAutomationKey,
      plan,
      rehash,
      store: storeA,
      cfg,
    });
    check("регресс: bare-service окно всё ещё пропускает docs_create", decA.kind === "confirmed", JSON.stringify(decA).slice(0, 100));

    const storeB = makeStore();
    const decB = await requireConsent({
      tool: "docs_append_text",
      accountLabel: "work",
      automationKey: "service-key",
      checkAutomationKey: fakeCheckAutomationKey,
      plan,
      rehash,
      store: storeB,
      cfg,
    });
    check("регресс: то же bare-service окно пропускает и docs_append_text (любой метод)", decB.kind === "confirmed", JSON.stringify(decB).slice(0, 100));
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
