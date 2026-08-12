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
  };
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
console.log("\n[2] подтверждено «человеком» в середине окна — confirmed с первого вызова, БЕЗ превью, мутация произошла");
{
  const { clock, sleep } = makeClock();
  const store = makeStore();
  const cfg = baseCfg(clock, { syncWaitMs: 25_000, syncPollMs: 1_000, sleep });
  let ticks = 0;
  const sleepAndMaybeConfirm = async (ms) => {
    ticks++;
    await sleep(ms);
    if (ticks === 2) {
      // Симулируем внешнее подтверждение (веб-хаб) РОВНО на 2-й итерации опроса —
      // атомарный consumeManifest, тем же приёмом, что и `POST /pending-consents/decide`.
      const id = [...store.manifests.keys()][0];
      await store.consumeManifest(id, "docs", "[веб-хаб: подтверждено]");
    }
  };
  cfg.sleep = sleepAndMaybeConfirm;
  const dec = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash: rehashOk, store, cfg });
  check("kind=confirmed", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 100));
  check("тул вернул confirmed С ПЕРВОГО вызова (одна инвокация requireConsent)", ticks === 2, `ticks=${ticks}`);
  check("НЕТ превью в решении (kind!=planned, нет поля preview)", dec.kind === "confirmed" && dec.preview === undefined);
  check("payload взят из манифеста", JSON.stringify(dec.payload) === JSON.stringify(PAYLOAD));
  check("auditId присвоен", typeof dec.auditId === "string" && dec.auditId.length > 0);
  check("аудит содержит запись confirmed с syncWait=observed_done", store.audits.some((a) => a.outcome === "confirmed" && a.checks.syncWait === "observed_done"));
  // "мутация реально произошла" — здесь проверяем на уровне контракта: вызывающий
  // тул (docs.ts) обязан исполнить payload из `confirmed`-решения; сама мутация
  // — интеграционный сценарий, см. scripts/test-docs-gate.mjs [4] ниже по духу
  // (в этом файле — offline-тест ЯДРА, без реального Google API).
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
  check("kind=refused (состояние изменилось)", dec.kind === "refused", JSON.stringify(dec).slice(0, 100));
  check("текст отказа называет причину", dec.result.includes("изменилось"), dec.result.slice(0, 80));
  check("аудит зафиксировал binding=mismatch на sync-пути", store.audits.some((a) => a.checks.syncWait === "observed_done" && a.checks.binding === "mismatch"));
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
