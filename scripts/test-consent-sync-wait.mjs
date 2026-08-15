#!/usr/bin/env node
/**
 * Offline unit-тест гибридного короткого ожидания в `requireConsent`
 * (`src/consent.ts`, docs/TZ_consent_web_hub.md, часть 1). Фейковый
 * in-memory ConsentStore + управляемые часы/`sleep` (ни БД, ни реального
 * `setTimeout`) — тем же приёмом, что и `scripts/test-consent.mjs`.
 *
 * Покрывает тестовый план ТЗ, пункты 1-6:
 *  1. syncWaitMs=0 — побайтовая совместимость.
 *  2. Подтверждено в окне (мок-стор меняет статус на 2-й итерации) — confirmed
 *     с первого вызова, БЕЗ превью.
 *  3. Отклонено в окне — refused, мутации нет.
 *  4. Никто ничего не сделал за окно — обычное planned; последующий обычный
 *     execute-вызов (manifest_id+user_reply) по-прежнему работает (регресс).
 *  5. Binding-чек срабатывает и на sync-пути.
 *  6. automation_key + sync одновременно — automation_key исполняет СРАЗУ, ни
 *     одной итерации опроса не происходит.
 *
 * Запуск: node scripts/test-consent-sync-wait.mjs
 */
import { requireConsent, sha256 } from "../src/consent.ts";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// ── управляемые часы + sleep, который двигает те же часы вместо реального ожидания
function makeClock(start = 1_700_000_000_000) {
  const clock = { t: start };
  const now = () => clock.t;
  const sleep = async (ms) => {
    clock.t += ms;
  };
  return { clock, now, sleep };
}

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
      if (!r || r.server !== server) return null;
      return { ...r };
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server) return null;
      if (r.status !== "AWAITING_CONSENT") return null;
      r.status = "DONE";
      r.consumedAt = Date.now();
      r.userReply = userReply;
      return { ...r };
    },
    async invalidateManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (r && r.server === server && r.status === "AWAITING_CONSENT") {
        r.status = "INVALIDATED";
        r.userReply = userReply;
      }
    },
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
    // Опциональный метод контракта (consent.ts) — им sync-wait достаёт
    // ФАКТИЧЕСКИЙ результат чужого исполнения (пруф post-verify), чтобы
    // отчёт модели не был голым «исполнено где-то там».
    async getExecutionAudit(manifestId, server) {
      const a = [...audits]
        .reverse()
        .find(
          (x) =>
            x.manifestId === manifestId &&
            x.server === server &&
            (x.outcome === "confirmed" || x.outcome === "failed"),
        );
      return a ? { id: a.id, outcome: a.outcome, postVerifyResult: a.postVerify ?? null, error: a.error ?? null, actor: a.actor ?? null } : null;
    },
  };
}

/** Симуляция того, что делает веб-хаб (`POST /pending-consents/decide`):
 * атомарно консьюмит манифест, пишет аудит-строку исполнения и дописывает в
 * неё пруф post-verify — ровно как `tryAutoExecute` + per-tool `execute`. */
async function simulateWebHubExecute(store, id, { postVerify = null, error = null } = {}) {
  await store.consumeManifest(id, "docs", "[веб-хаб: подтверждено]");
  const auditId = "audit-" + id.slice(0, 8);
  await store.appendConsentAudit({
    id: auditId,
    ts: 1,
    server: "docs",
    tool: "docs_replace_text",
    accountLabel: "work",
    manifestId: id,
    objectHash: OBJHASH,
    userReply: "[веб-хаб: подтверждено]",
    checks: { source: "web_hub" },
    outcome: error ? "failed" : "confirmed",
    actor: "web",
  });
  await store.updateConsentAuditOutcome(auditId, { postVerify, error, outcome: error ? "failed" : "confirmed" });
  return auditId;
}

const PAYLOAD = { account: "work", items: [{ documentId: "DOC1", find: "2025", replace: "2026" }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({
  payload: PAYLOAD,
  objectHash: OBJHASH,
  preview: "### 📤 План: Замена текста — 1\n\n- **«DOC1»**: «2025» → «2026»",
  batchSize: 1,
});
const rehashOk = (payload) => sha256(payload);

function baseCfg(clock, extra = {}) {
  return {
    server: "docs",
    consentTtlMs: 3_600_000,
    minConsentGapMs: 2_000,
    sendBatchMax: 10,
    now: () => clock.t,
    ...extra,
  };
}

// ── [1] syncWaitMs=0 (или не задан) — побайтовая совместимость ──────────────
console.log("\n[1] syncWaitMs=0 — поведение как без фичи, ни одного sleep не вызвано");
{
  const { clock, sleep } = makeClock();
  let sleepCalls = 0;
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 0, syncPollMs: 1000, sleep: async (ms) => { sleepCalls++; await sleep(ms); } });
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=planned", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("ни одного sleep (ветка не существует)", sleepCalls === 0);
  check("манифест создан и всё ещё AWAITING_CONSENT", store.manifests.get(dec.manifestId)?.status === "AWAITING_CONSENT");
}

// ── [2] подтверждено в окне (мок-стор меняет статус на 2-й итерации) ────────
console.log("\n[2] подтверждено «человеком» в середине окна — готовый положительный ответ с первого вызова, БЕЗ превью, БЕЗ повторного исполнения");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000, sleep });
  let ticks = 0;
  const sleepAndMaybeConfirm = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      // Симулируем внешнее подтверждение И исполнение (веб-хаб) РОВНО на 2-й
      // итерации опроса — тот же путь, что `POST /pending-consents/decide`
      // (consumeManifest + реальная мутация уже произошли ТАМ, синхронно).
      const id = [...store.manifests.keys()][0];
      await simulateWebHubExecute(store, id, {
        postVerify: "### 🧾 Независимая проверка замены текста\n\n- ✅ «DOC1»: 3 замены «2025» → «2026»",
      });
    }
  };
  cfg.sleep = sleepAndMaybeConfirm;
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  // ЗАЩИТА ОТ ДВОЙНОГО ИСПОЛНЕНИЯ (не менять): наблюдение чужого DONE НЕ
  // может вернуть kind=confirmed — тул тогда исполнил бы мутацию ВТОРОЙ раз
  // поверх уже исполненной веб-хабом. Но и `refused` (как было до
  // 2026-08-14) — ложь: модель видела «отказ» и повторяла вызов по кругу.
  // Правильный контракт — отдельный исход `already_executed`: payload наружу
  // НЕ отдаётся, а модели говорится правда «сделано, вот результат».
  check("kind=already_executed (не refused и не confirmed)", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("payload НЕ отдан наружу (тул физически не может исполнить повторно)", dec.payload === undefined);
  check("тул получил ответ С ПЕРВОГО вызова (одна инвокация requireConsent)", ticks === 2, `ticks=${ticks}`);
  check("текст сообщает, что уже подтверждено и исполнено", dec.report.includes("одтвержд") && dec.report.includes("ВЫПОЛНЕНА"), dec.report.slice(0, 160));
  check("текст прямо запрещает повторный вызов", dec.report.includes("повторять вызов") || dec.report.includes("НЕ нужно"), dec.report.slice(0, 300));
  check("ФАКТИЧЕСКИЙ результат (пруф post-verify) донесён до модели", dec.report.includes("Независимая проверка замены текста") && dec.report.includes("3 замены"), dec.report.slice(-300));
  check("auditId исполнившего канала возвращён", typeof dec.auditId === "string" && dec.auditId.startsWith("audit-"), String(dec.auditId));
  check("манифест реально DONE (исполнил веб-хаб, не requireConsent)", store.manifests.get([...store.manifests.keys()][0]).status === "DONE");
}

// ── [2a] то же, но стор НЕ умеет отдать аудит — честное «не перепроверил» ───
console.log("\n[2a] чужой DONE, но пруфа исполнения достать неоткуда — отчёт честно говорит, что результат не перепроверен (и НЕ выдумывает успех)");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  delete store.getExecutionAudit; // стор старого образца / метод не реализован
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000 });
  let ticks = 0;
  cfg.sleep = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) await store.consumeManifest([...store.manifests.keys()][0], "docs", "[веб-хаб: подтверждено]");
  };
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("честно сказано, что результат не удалось перепроверить", dec.report.includes("не удалось перепроверить"), dec.report.slice(-300));
  check("auditId отсутствует (нечего вернуть)", dec.auditId === undefined);
}

// ── [2b] чужое исполнение УПАЛО — отчёт не притворяется успехом ─────────────
console.log("\n[2b] чужой канал исполнил с ОШИБКОЙ — отчёт помечен ⚠️ и называет ошибку, а не рапортует успех");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000 });
  let ticks = 0;
  cfg.sleep = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      await simulateWebHubExecute(store, [...store.manifests.keys()][0], { error: "Google API 403: insufficient permissions" });
    }
  };
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("заголовок ⚠️, а не ✅", dec.report.includes("⚠️") && !dec.report.includes("✅"), dec.report.slice(0, 120));
  check("текст ошибки донесён до модели", dec.report.includes("403"), dec.report.slice(-300));
}

// ── [2c] добор пруфа: аудит уже есть (confirmed), но пруф допишется ПОЗЖЕ ───
console.log("\n[2c] добор пруфа: строка аудита появляется сразу, но post_verify_result дописывается позже (execute ещё выполняется) — buildAlreadyExecutedReport дожидается, не сдаётся на первой попытке");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  let getExecAuditCalls = 0;
  store.getExecutionAudit = async () => {
    getExecAuditCalls++;
    if (getExecAuditCalls < 3) {
      // Строка УЖЕ есть (тот, кто исполнил, успел appendConsentAudit), но
      // пруф ещё не дописан — ровно та гонка, которую добор должен закрыть:
      // updateConsentAuditOutcome с постVerify придёт чуть позже execute.
      return { id: "audit-late", outcome: "confirmed", postVerifyResult: null, error: null, actor: "web" };
    }
    return {
      id: "audit-late",
      outcome: "confirmed",
      postVerifyResult: "### 🧾 Независимая проверка\n\n- ✅ «DOC1»: готово",
      error: null,
      actor: "web",
    };
  };
  let ticks = 0;
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000 });
  cfg.sleep = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      const id = [...store.manifests.keys()][0];
      await store.consumeManifest(id, "docs", "[веб-хаб: подтверждено]");
    }
  };
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("добор реально попытался БОЛЬШЕ одного раза (getExecutionAudit)", getExecAuditCalls >= 3, `calls=${getExecAuditCalls}`);
  check("итоговый отчёт содержит дождавшийся пруф, а не «не удалось перепроверить»", dec.report.includes("Независимая проверка") && dec.report.includes("готово"), dec.report.slice(-300));
  check("заголовок ✅ (пруф найден, binding в порядке)", dec.report.includes("✅"));
}

// ── [2d] добор пруфа: пруф так и не появился — бюджет попыток конечен ───────
console.log("\n[2d] добор пруфа: пруф НИКОГДА не появляется — попыток не больше бюджета (6), отчёт честно говорит «не удалось перепроверить»");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  let getExecAuditCalls = 0;
  store.getExecutionAudit = async () => {
    getExecAuditCalls++;
    return { id: "audit-stuck", outcome: "confirmed", postVerifyResult: null, error: null, actor: "web" };
  };
  let ticks = 0;
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000 });
  cfg.sleep = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      const id = [...store.manifests.keys()][0];
      await store.consumeManifest(id, "docs", "[веб-хаб: подтверждено]");
    }
  };
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("добор остановился в пределах бюджета (≤6 попыток), а не завис", getExecAuditCalls <= 6, `calls=${getExecAuditCalls}`);
  check("добор реально пытался больше одного раза", getExecAuditCalls > 1, `calls=${getExecAuditCalls}`);
  check("честно сказано, что не удалось перепроверить (аудит есть, пруфа нет)", dec.report.includes("отсутствует") || dec.report.includes("не может"), dec.report.slice(-300));
}

// ── [2e] текст ошибки чужого исполнения содержит URL с query — вырезается ───
console.log("\n[2e] чужое исполнение упало с ошибкой, содержащей URL с query (presigned-ссылка/токен) — в отчёте query вырезан, host+path остались");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000 });
  let ticks = 0;
  cfg.sleep = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      await simulateWebHubExecute(store, [...store.manifests.keys()][0], {
        error:
          "Google API 403 at https://storage.googleapis.com/bucket/file?X-Goog-Signature=SECRETTOKEN123&X-Goog-Expires=900",
      });
    }
  };
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=already_executed", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check(
    "query-параметры (включая секретный токен) вырезаны из ответа модели",
    !dec.report.includes("SECRETTOKEN123") && !dec.report.includes("X-Goog-Signature"),
    dec.report.slice(-400),
  );
  check("host+path остались (диагностика не потеряна полностью)", dec.report.includes("storage.googleapis.com/bucket/file"), dec.report.slice(-400));
}

// ── [3] отклонено в окне — refused, мутации нет ──────────────────────────────
console.log("\n[3] отклонено «человеком» в окне (веб-хаб reject) — refused, манифест INVALIDATED, мутации нет");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  let ticks = 0;
  const sleepAndMaybeReject = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      const id = [...store.manifests.keys()][0];
      await store.invalidateManifest(id, "docs", "[веб-хаб: отклонено]");
    }
  };
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000, sleep: sleepAndMaybeReject });
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=refused", dec.kind === "refused", JSON.stringify(dec).slice(0, 100));
  check("текст отказа — «Отменено»", dec.result.includes("Отменено"), dec.result.slice(0, 60));
  const id = [...store.manifests.keys()][0];
  check("манифест INVALIDATED (не DONE — мутации не было)", store.manifests.get(id).status === "INVALIDATED");
}

// ── [4] никто не решил за окно — planned как обычно; регресс обычного execute ─
console.log("\n[4] дедлайн истёк, манифест всё ещё AWAITING — обычное planned; последующий execute по-прежнему работает");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 3_000, syncPollMs: 1_000, sleep });
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=planned (таймаут, никто не решил)", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("манифест всё ещё AWAITING_CONSENT", store.manifests.get(dec.manifestId)?.status === "AWAITING_CONSENT");
  check("превью несёт id плана (то же самое, что вернулось бы без фичи)", dec.preview.includes(dec.manifestId));

  // Регресс: обычный второй вызов с manifest_id+user_reply по-прежнему исполняет.
  clock.t += 3_000; // проходит анти-дуплет gap
  const dec2 = await requireConsent({
    tool: "docs_replace_text", accountLabel: "work", manifestId: dec.manifestId, userReply: "да, заменяй",
    plan, rehash: rehashOk, store, cfg,
  });
  check("обычный execute-вызов (без sync-wait, т.к. уже есть manifestId/userReply) → confirmed", dec2.kind === "confirmed", JSON.stringify(dec2).slice(0, 80));
  check("манифест теперь DONE", store.manifests.get(dec.manifestId).status === "DONE");
}

// ── [5] binding-чек срабатывает и на sync-пути ───────────────────────────────
console.log("\n[5] sync-путь: rehash не совпал (дрейф состояния) → refused, манифест НЕ считается тихо исполненным");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  let ticks = 0;
  const sleepAndMaybeConfirm = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      const id = [...store.manifests.keys()][0];
      await store.consumeManifest(id, "docs", "[веб-хаб: подтверждено]");
    }
  };
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000, sleep: sleepAndMaybeConfirm });
  const changedRehash = () => sha256({ changed: true }); // "документ изменился между планом и подтверждением"
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: changedRehash, store, cfg });
  // Мутацию уже сделал чужой канал — «отказать» тут не от чего (действие
  // произошло), но и молчать о дрейфе нельзя: отчёт помечается ⚠️.
  check("kind=already_executed (действие уже случилось, повторять нечего)", dec.kind === "already_executed", JSON.stringify(dec).slice(0, 120));
  check("payload НЕ отдан (двойного исполнения не будет)", dec.payload === undefined);
  check("отчёт помечен ⚠️ и называет дрейф состояния", dec.report.includes("⚠️") && dec.report.includes("изменил"), dec.report.slice(0, 200));
}

// ── [6] automation_key + sync одновременно — automation_key исполняет СРАЗУ ──
console.log("\n[6] automation_key валиден + syncWaitMs включён — исполняет немедленно, БЕЗ единой итерации опроса");
{
  const { clock, sleep } = makeClock();
  let sleepCalls = 0;
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000, sleep: async (ms) => { sleepCalls++; await sleep(ms); } });
  const checkAutomationKey = async () => ({ ok: true, channel: "gmail:automation" });
  const dec = await requireConsent({
    tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg,
    automationKey: "valid-key", checkAutomationKey,
  });
  check("kind=confirmed (через automation_key, не через sync-wait)", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 80));
  check("manifestId пустой (automation_key — прямой plan→execute, манифест не создавался)", dec.manifestId === "");
  check("НИ ОДНОЙ итерации опроса не произошло (automation_key проверяется раньше)", sleepCalls === 0, `sleepCalls=${sleepCalls}`);
  check("в сторе манифестов нет вообще", store.manifests.size === 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
