#!/usr/bin/env node
/**
 * Offline unit-тест backend-роутов веб-хаба подтверждений
 * (docs/TZ_consent_web_hub.md, часть 2 — `GET /pending-consents` и
 * `POST /pending-consents/decide`). Тестирует ЧИСТЫЕ, DI'd функции
 * `handlePendingConsentsList`/`handlePendingConsentsDecide` из `src/http.ts`
 * (тот же приём, что уже применён к `selectLegacyOrOnboardingUser`) — с
 * фейковыми стором/executor'ом, без реального Postgres/Express/сети.
 *
 * Авторизация (`X-Consent-Hub-Secret`, 404 fail-closed) — часть Express-
 * маршрутизации (`consentHubGuard` в http.ts), не экспортирована отдельно;
 * покрыта здесь на уровне логики константного сравнения (импортирована из
 * dist/logRedaction-подобного паттерна — сверяем саму функцию сравнения
 * тем же приёмом, что и dashboard-секрет, уже протестированный в
 * scripts/test-log-redaction.mjs). guard-часть (404 при отсутствии/неверном
 * секрете) — тест ниже [7]/[8] проверяет её напрямую через `timingSafeEqual`-
 * совместимую логику, воспроизведённую 1:1 с `secretMatches` в http.ts.
 *
 * Покрывает тестовый план ТЗ, пункты 7-11 (применимые к одному сервису):
 *  7. без секрета / с неверным секретом — 404.
 *  8. CONSENT_HUB_SECRET не задан — 404 на обоих роутах.
 *  9. decide confirm — реально исполняет; повторный decide — already_decided,
 *     второй мутации нет.
 *  10. decide reject с комментарием — invalidated, комментарий в userReply.
 *  11. (аналог агрегатора для одного сервиса) — listPendingConsents,
 *      бросающий исключение → 500, не падение процесса.
 *
 * Запуск: node scripts/test-pending-consents.mjs
 */
import { timingSafeEqual } from "node:crypto";
import { handlePendingConsentsList, handlePendingConsentsDecide, startHttpServer } from "../dist/http.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// ── [7]/[8] guard: тот же constant-time compare, что в http.ts's consentHubGuard ─
// (воспроизведено 1:1 — сам guard не экспортирован, т.к. читает req/res
// Express-объекты; сравниваем логику напрямую, как и остальные offline-тесты
// этого репо тестируют чистые функции, а не HTTP-транспорт).
function secretMatches(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function consentHubGuardLogic(configuredSecret, providedHeader) {
  if (!configuredSecret) return 404; // [8] секрет не задан
  if (!providedHeader || !secretMatches(providedHeader, configuredSecret)) return 404; // [7]
  return 200;
}

console.log("\n[7] без секрета / с неверным секретом → 404 (не 401/403)");
{
  check("нет заголовка → 404", consentHubGuardLogic("real-secret", "") === 404);
  check("неверный секрет → 404", consentHubGuardLogic("real-secret", "wrong") === 404);
  check("верный секрет → проходит (200)", consentHubGuardLogic("real-secret", "real-secret") === 200);
}

console.log("\n[8] CONSENT_HUB_SECRET не задан → 404 на обоих роутах (fail-closed)");
{
  check("не задан, заголовок пуст → 404", consentHubGuardLogic(undefined, "") === 404);
  check("не задан, ДАЖЕ с каким-то заголовком → 404 (не открытый доступ)", consentHubGuardLogic(undefined, "anything") === 404);
}

// ── фейковый стор + executor для [9]/[10]/[11] ───────────────────────────────
function makeManifest(overrides = {}) {
  return {
    id: "m1",
    server: "docs",
    tool: "docs_create",
    accountLabel: "work",
    payload: { account: "work", documents: [{ title: "Q4 план" }] },
    objectHash: "hash1",
    status: "AWAITING_CONSENT",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
    consumedAt: null,
    userReply: null,
    ...overrides,
  };
}

function makeDeps(manifest, { executed = { count: 0 }, audits = [], executeImpl } = {}) {
  const manifests = new Map(manifest ? [[manifest.id, { ...manifest }]] : []);
  return {
    deps: {
      listPendingConsents: async (server, nowMs) =>
        [...manifests.values()].filter((r) => r.server === server && r.status === "AWAITING_CONSENT" && r.expiresAt > nowMs),
      getManifest: async (id, server) => {
        const r = manifests.get(id);
        return r && r.server === server ? { ...r } : null;
      },
      rejectManifest: async (id, server, userReply) => {
        const r = manifests.get(id);
        if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
        r.status = "INVALIDATED";
        r.userReply = userReply;
        return { ...r };
      },
      appendConsentAudit: async (entry) => {
        audits.push(entry);
      },
      getAutoExecutor: (tool) =>
        tool === "docs_create"
          ? {
              rehash: async (addressing) => "hash1", // "мир не изменился"
              execute:
                executeImpl ??
                (async (payload, auditId) => {
                  executed.count++;
                  return `### 📄 Создано 1/1\n\n- ✅ **«${payload.documents[0].title}»** — https://docs.google.com/x`;
                }),
            }
          : undefined,
      tryAutoExecute: async (candidate, rehash, store, cfg, ctx) => {
        const r = manifests.get(candidate.manifestId);
        if (!r || r.status !== "AWAITING_CONSENT") return null;
        const currentHash = await rehash(r.payload, ctx);
        if (currentHash !== r.objectHash) return null;
        r.status = "DONE";
        r.consumedAt = Date.now();
        return { manifestId: r.id, tool: r.tool, accountLabel: r.accountLabel, payload: r.payload, auditId: "audit-1" };
      },
      buildCtx: async () => ({ clients: {}, consentStore: {}, userToken: null }),
      // Мок реального `consentStoreAdapter.updateConsentAuditOutcome` — то, что
      // должна вызвать `runAutoExecutorSafely` (autoExecute.ts), КОГДА
      // `executor.execute` бросает исключение (задача: гарантированный
      // outcome:"failed" даже на брошенном исключении, не только на явном
      // отрицательном результате). Пишет в тот же `audits`, что и
      // `appendConsentAudit`, чтобы тест мог проверить итоговое состояние
      // строки одним массивом.
      updateConsentAuditOutcome: async (auditId, outcome) => {
        const a = audits.find((x) => x.id === auditId);
        if (a) Object.assign(a, outcome);
        else audits.push({ id: auditId, ...outcome });
      },
      server: "docs",
      now: () => 1_700_000_000_500,
      makeId: () => "audit-web-1",
    },
    manifests,
    executed,
    audits,
  };
}

console.log("\n[9] decide confirm — реально исполняет (мутация произошла); повторный decide → already_decided, второй мутации нет");
{
  const { deps, manifests, executed } = makeDeps(makeManifest());
  const first = await handlePendingConsentsDecide(deps, {}, { manifestId: "m1", decision: "confirm", comment: "" });
  check("первый decide → 200 confirmed", first.status === 200 && first.body.outcome === "confirmed", JSON.stringify(first));
  check("result — человекочитаемый текст исполнения", typeof first.body.result === "string" && first.body.result.includes("Создано"), first.body.result);
  check("мутация произошла РОВНО один раз", executed.count === 1);
  check("манифест теперь DONE", manifests.get("m1").status === "DONE");

  const second = await handlePendingConsentsDecide(deps, {}, { manifestId: "m1", decision: "confirm", comment: "" });
  check("повторный decide → 409 already_decided", second.status === 409 && second.body.error === "already_decided", JSON.stringify(second));
  check("второй мутации НЕТ", executed.count === 1);
}

console.log("\n[10] decide reject с комментарием — invalidated, комментарий записан как userReply в аудит");
{
  const { deps, manifests, audits } = makeDeps(makeManifest({ id: "m2" }));
  const dec = await handlePendingConsentsDecide(deps, {}, { manifestId: "m2", decision: "reject", comment: "не тот документ" });
  check("200, outcome=refused", dec.status === 200 && dec.body.outcome === "refused", JSON.stringify(dec));
  check("манифест INVALIDATED", manifests.get("m2").status === "INVALIDATED");
  check("комментарий попал в userReply манифеста", manifests.get("m2").userReply.includes("не тот документ"));
  check("аудит-запись написана (actor=web, outcome=invalidated)", audits.some((a) => a.actor === "web" && a.outcome === "invalidated" && a.userReply.includes("не тот документ")), JSON.stringify(audits));

  // Повторный reject на тот же манифест — тоже already_decided (атомарность).
  const second = await handlePendingConsentsDecide(deps, {}, { manifestId: "m2", decision: "reject", comment: "ещё раз" });
  check("повторный reject → 409 already_decided", second.status === 409 && second.body.error === "already_decided");
}

console.log("\n[12] decide confirm — executor.execute БРОСАЕТ исключение → аудит получает outcome:\"failed\" (не остаётся \"confirmed\" без пруфа), HTTP-ответ НЕ ok:true/confirmed, текст ошибки не пересказан наружу дословно");
{
  const audits = [];
  const boom = new Error("Google API 403 at https://storage.googleapis.com/bucket/f?X-Goog-Signature=SECRETTOKEN123");
  const { deps, manifests } = makeDeps(makeManifest({ id: "m6" }), {
    audits,
    executeImpl: async () => {
      throw boom;
    },
  });
  const dec = await handlePendingConsentsDecide(deps, {}, { manifestId: "m6", decision: "confirm", comment: "" });
  check("НЕ 200/confirmed — исполнение упало", !(dec.status === 200 && dec.body.outcome === "confirmed"), JSON.stringify(dec));
  check("HTTP-ответ не содержит текст исключения дословно (никакого SECRETTOKEN123)", !JSON.stringify(dec.body).includes("SECRETTOKEN123"), JSON.stringify(dec));
  check("манифест всё равно DONE (consumeManifest — атомарный one-shot, произошёл ДО execute)", manifests.get("m6").status === "DONE");
  const auditRow = audits.find((a) => a.id === "audit-1");
  check("аудит-строка получила outcome:\"failed\" (гарантированно, несмотря на исключение)", !!auditRow && auditRow.outcome === "failed", JSON.stringify(auditRow));
  check("текст ошибки в аудите есть, но query/токен из URL вырезаны", !!auditRow?.error && auditRow.error.includes("403") && !auditRow.error.includes("SECRETTOKEN123"), auditRow?.error);
}

console.log("\n[доп.] not_found / expired — честные машиночитаемые коды, не 500");
{
  const { deps } = makeDeps(makeManifest({ id: "m3" }));
  const notFound = await handlePendingConsentsDecide(deps, {}, { manifestId: "nope", decision: "confirm", comment: "" });
  check("неизвестный manifestId → 404 not_found", notFound.status === 404 && notFound.body.error === "not_found", JSON.stringify(notFound));

  const { deps: deps2 } = makeDeps(makeManifest({ id: "m4", expiresAt: 1_700_000_000_000 - 1_000 }));
  const expired = await handlePendingConsentsDecide(deps2, {}, { manifestId: "m4", decision: "confirm", comment: "" });
  check("истёкший манифест → 410 expired", expired.status === 410 && expired.body.error === "expired", JSON.stringify(expired));

  const badReq = await handlePendingConsentsDecide(deps, {}, { manifestId: "m3", decision: "maybe", comment: "" });
  check("неизвестный decision → 400 bad_request", badReq.status === 400 && badReq.body.error === "bad_request");
}

console.log("\n[11] GET /pending-consents — список; сбой стора → 500, не падение процесса");
{
  const manifest = makeManifest({ id: "m5" });
  const { deps } = makeDeps(manifest);
  const list = await handlePendingConsentsList(deps, "docs");
  check("200, service=docs", list.status === 200 && list.body.service === "docs");
  check("один элемент, поля title/summary/preview заполнены", list.body.items.length === 1 && list.body.items[0].title && list.body.items[0].summary && list.body.items[0].preview, JSON.stringify(list.body.items));
  check("manifestId в ответе", list.body.items[0].manifestId === "m5");

  const brokenDeps = { ...deps, listPendingConsents: async () => { throw new Error("db down"); } };
  const broken = await handlePendingConsentsList(brokenDeps, "docs");
  check("сбой стора → 500 с error, а не throw наружу", broken.status === 500 && typeof broken.body.error === "string", JSON.stringify(broken));
}

// ── [7]/[8] реальный HTTP через настоящий startHttpServer (не только логика) ─
console.log("\n[7b]/[8b] реальный HTTP: GET /pending-consents без секрета/с неверным секретом/не задан → 404");
{
  const port = 34972;
  const config = {
    transport: "http",
    port,
    requireAuth: false,
    users: [{ name: "default", token: undefined, accounts: [], defaultAccount: "default" }],
    onboarding: { enabled: false },
  };

  delete process.env.CONSENT_HUB_SECRET;
  await startHttpServer(config);
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/pending-consents`);
    check("[8] CONSENT_HUB_SECRET не задан → 404", r1.status === 404, r1.status);

    process.env.CONSENT_HUB_SECRET = "real-hub-secret-fake-do-not-use";
    const r2 = await fetch(`http://127.0.0.1:${port}/pending-consents`);
    check("[7] секрет задан, заголовок отсутствует → 404", r2.status === 404, r2.status);

    const r3 = await fetch(`http://127.0.0.1:${port}/pending-consents`, {
      headers: { "x-consent-hub-secret": "wrong-secret" },
    });
    check("[7] неверный секрет → 404", r3.status === 404, r3.status);

    const r4 = await fetch(`http://127.0.0.1:${port}/pending-consents/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifestId: "x", decision: "confirm" }),
    });
    check("[7] decide-роут — тот же guard, тоже 404 без секрета", r4.status === 404, r4.status);
  } finally {
    delete process.env.CONSENT_HUB_SECRET;
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
