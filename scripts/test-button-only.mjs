#!/usr/bin/env node
/**
 * BUTTON-ONLY: исполнение только кнопкой (порт защиты из Python-эталона
 * ticktick-mcp, PR #17, merge 467018e).
 *
 * Суть: если Telegram-слой включён И план РЕАЛЬНО ушёл кнопкой, текстовое
 * подтверждение для этого плана закрывается СОВСЕМ. Модель физически не может
 * исполнить операцию — только человек нажатием. Дыра «модель сочиняет
 * согласие за человека» не уменьшается затыканием формулировок, а ИСЧЕЗАЕТ:
 * способа исполнить такую операцию текстом больше нет.
 *
 * Всё offline: in-memory ConsentStore + фейковый TgApprovalGate со счётчиками
 * вызовов. Ни БД, ни сети, ни живых Google API.
 *
 * Запуск: node scripts/test-button-only.mjs
 */
import { requireConsent, tgButtonOnly, sha256 } from "../src/consent.ts";
import { registeredAutoExecuteTools, getAutoExecutor } from "../dist/autoExecute.js";
import { registerDocsTools } from "../dist/tools/docs.js";
import { registerAccountTools } from "../dist/accounts.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

// ── харнесс: часы, стор, фейковый ТГ-гейт ──────────────────────────────────

const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;
const cfg = { server: "docs", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now };

const PAYLOAD = { account: "work", items: [{ documentId: "DOC1", find: "2025", replace: "2026" }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "### 📤 План: Замена текста — 1", batchSize: 1 });
const rehash = (p) => sha256(p);

function makeStore() {
  const manifests = new Map();
  const audits = [];
  return {
    manifests,
    audits,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null, tgNotified: false });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
      if (clock.t >= r.expiresAt) return null;
      r.status = "DONE";
      r.consumedAt = clock.t;
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
    // Зеркалит store.ts's `markTgNotified` (UPDATE … SET tg_notified = TRUE).
    async markTgNotified(id, server) {
      const r = manifests.get(id);
      if (r && r.server === server) r.tgNotified = true;
    },
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome() {},
  };
}

/** Фейковый TgApprovalGate со счётчиками: `enabled` можно менять НА ЛЕТУ,
 * чтобы проверить, что решение принимается по состоянию плана, а не по
 * текущему значению настройки. */
function makeGate({ enabled = true, sendOk = true, approval = "pending" } = {}) {
  const calls = { enabledFor: 0, notifyPlan: 0, checkApproval: 0 };
  const state = { enabled, sendOk, approval };
  return {
    calls,
    state,
    enabledFor(_tool) {
      calls.enabledFor++;
      return state.enabled;
    },
    async notifyPlan() {
      calls.notifyPlan++;
      return state.sendOk ? { ok: true } : { ok: false, error: "chat not found" };
    },
    async checkApproval() {
      calls.checkApproval++;
      return state.approval;
    },
  };
}

const HAS_EXEC = () => true; // «у тула есть авто-исполнитель»
const NO_EXEC = () => false; // «нечем исполнить по нажатию»

async function buildPlan({ gate, hasAutoExecutor, store = makeStore() } = {}) {
  clock.t = 1_700_000_000_000;
  const dec = await requireConsent({
    tool: "docs_replace_text", accountLabel: "work", plan, rehash, store, cfg,
    ...(gate ? { tg: gate } : {}),
    ...(hasAutoExecutor ? { hasAutoExecutor } : {}),
  });
  return { store, dec, id: dec.manifestId };
}

async function exec({ store, id, gate, hasAutoExecutor, userReply = "да" }) {
  clock.t += 3_000;
  return requireConsent({
    tool: "docs_replace_text", accountLabel: "work", manifestId: id, userReply, plan, rehash, store, cfg,
    ...(gate ? { tg: gate } : {}),
    ...(hasAutoExecutor ? { hasAutoExecutor } : {}),
  });
}

// ═══ [1] Юнит самой формулы ════════════════════════════════════════════════
console.log("\n[1] формула tgButtonOnly: обе половины обязательны");
check("нет метки tg_notified → false", tgButtonOnly({ tool: "docs_replace_text", tgNotified: false }, HAS_EXEC) === false);
check("метка есть, но исполнителя нет → false", tgButtonOnly({ tool: "docs_replace_text", tgNotified: true }, NO_EXEC) === false);
check("метка есть + исполнитель есть → true", tgButtonOnly({ tool: "docs_replace_text", tgNotified: true }, HAS_EXEC) === true);
check("hasAutoExecutor не передан вовсе → false", tgButtonOnly({ tool: "docs_replace_text", tgNotified: true }, undefined) === false);
check("манифеста нет (null) → false", tgButtonOnly(null, HAS_EXEC) === false);

// ═══ [2] Метка ставится РОВНО при успешной отправке ════════════════════════
console.log("\n[2] tg_notified ставится только при успешной отправке кнопок");
{
  const gate = makeGate({ sendOk: true });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  check("после успешного notifyPlan манифест помечен", store.manifests.get(id).tgNotified === true);
  check("notifyPlan действительно вызывался", gate.calls.notifyPlan === 1, String(gate.calls.notifyPlan));
}
{
  const gate = makeGate({ sendOk: false });
  const { store, dec } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  check("отправка упала → refused (fail-closed)", dec.kind === "refused", dec.kind);
  const row = [...store.manifests.values()][0];
  check("отправка упала → манифест НЕ помечен", row.tgNotified !== true, String(row.tgNotified));
  check("отправка упала → манифест INVALIDATED, не остался живым", row.status === "INVALIDATED", row.status);
  check("текст говорит, что действие НЕ выполнено", /не выполнено/i.test(dec.result), dec.result.slice(0, 80));
}
{
  const gate = makeGate({ enabled: false });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  check("слой выключен → метка не ставится НИКОГДА", store.manifests.get(id).tgNotified !== true);
  check("слой выключен → notifyPlan не вызывался", gate.calls.notifyPlan === 0);
}

// ═══ [3] Приписка к плану честно описывает, что будет дальше ═══════════════
console.log("\n[3] приписка к плану: кнопка вместо «ответьте да»");
{
  const gate = makeGate();
  const { dec } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  check("есть авто-исполнитель → приписка обещает автоисполнение", /выполнится автоматически/i.test(dec.preview), dec.preview);
  check("...и прямо говорит, что текстовое «да» не принимается", /текстовое «да» для этого плана не принимается/i.test(dec.preview), dec.preview);
  check("...и НЕ просит ответить «да» здесь", !/ответьте «да»/i.test(dec.preview), dec.preview);
}
{
  const gate = makeGate();
  const { dec } = await buildPlan({ gate, hasAutoExecutor: NO_EXEC });
  check("нет авто-исполнителя → приписка честно просит ПОВТОРИТЬ вызов", /повторите вызов инструмента/i.test(dec.preview), dec.preview);
  check("...и НЕ обещает автоисполнение", !/выполнится автоматически/i.test(dec.preview), dec.preview);
}

// ═══ [4] PENDING: текстовый путь закрыт, что бы модель ни написала ═════════
console.log("\n[4] PENDING → текстовое «да» не исполняет ничего, план жив");
{
  const gate = makeGate({ approval: "pending" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC });
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("манифест ЖИВ (ждём нажатия)", store.manifests.get(id).status === "AWAITING_CONSENT", store.manifests.get(id).status);
  check("в ответе есть «кнопк»", /кнопк/i.test(dec.result), dec.result.slice(0, 100));
  check("в ответе есть «Telegram»", /Telegram/.test(dec.result), dec.result.slice(0, 100));
  check("в ответе есть «отключено»", /отключено/i.test(dec.result), dec.result.slice(0, 160));
  check("русский текст цел (не побит кодировкой)", /что бы пользователь ни написал в чате/.test(dec.result), dec.result.slice(0, 200));
}

console.log("\n[4b] СУТЬ ФИКСА: содержание реплики больше не влияет НИ НА ЧТО");
{
  const replies = ["да", "давай, подтверждаю", "ага, делай", "ок, я всё проверил, подтверждаю"];
  const results = [];
  for (const reply of replies) {
    const gate = makeGate({ approval: "pending" });
    const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
    const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC, userReply: reply });
    results.push({ reply, kind: dec.kind, result: dec.result, status: store.manifests.get(id).status });
  }
  check("все реплики → refused", results.every((r) => r.kind === "refused"), JSON.stringify(results.map((r) => r.kind)));
  check("все реплики → ОДИН И ТОТ ЖЕ текст отказа", new Set(results.map((r) => r.result)).size === 1, JSON.stringify(results.map((r) => r.result.slice(0, 40))));
  check("все реплики → план остался жив", results.every((r) => r.status === "AWAITING_CONSENT"), JSON.stringify(results.map((r) => r.status)));
  // Пустая реплика идёт другим маршрутом (пара manifest_id/user_reply
  // неполная — вызывающий перепутал фазу), но тоже НИЧЕГО не исполняет.
  const gate = makeGate({ approval: "pending" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const decEmpty = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC, userReply: "" });
  check("пустая реплика → refused (половина пары), ничего не исполнено", decEmpty.kind === "refused", decEmpty.kind);
  check("пустая реплика → план жив", store.manifests.get(id).status === "AWAITING_CONSENT");
}

// ═══ [5] APPROVED: отказать текстовому пути, но НЕ гасить манифест ═════════
console.log("\n[5] APPROVED, поллер ещё не добрался → отказ, но манифест НЕ погашен");
{
  const gate = makeGate({ approval: "approved" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC });
  check("kind=refused (исполняет сервер сам)", dec.kind === "refused", dec.kind);
  check("текст: уже подтверждено кнопкой", /подтверждено кнопкой/i.test(dec.result), dec.result.slice(0, 120));
  check("КРИТИЧНО: манифест НЕ погашен (иначе поллер не исполнит)", store.manifests.get(id).status === "AWAITING_CONSENT", store.manifests.get(id).status);

  // Обратная сторона: после этого отказа фоновый путь реально исполняет план.
  const consumed = await store.consumeManifest(id, cfg.server, "[авто: подтверждено кнопкой в Telegram]");
  check("фоновый исполнитель находит план и consume проходит", !!consumed, String(consumed));
  check("после фонового исполнения манифест DONE", store.manifests.get(id).status === "DONE");

  // Идемпотентность: повторный текстовый вызов после исполнения — внятный отказ.
  const again = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC });
  check("повторный вызов после исполнения → refused", again.kind === "refused", again.kind);
  check("...и внятно объясняет, что плана уже нет", /не найден|истёк|исполнен/i.test(again.result), again.result.slice(0, 120));
}

// ═══ [6] REJECTED / none ═══════════════════════════════════════════════════
console.log("\n[6] REJECTED → план сожжён; none → построить план заново");
{
  const gate = makeGate({ approval: "rejected" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC });
  check("kind=refused", dec.kind === "refused", dec.kind);
  check("манифест INVALIDATED (сожжён)", store.manifests.get(id).status === "INVALIDATED", store.manifests.get(id).status);
  check("текст: отклонено в Telegram", /отклонено/i.test(dec.result), dec.result.slice(0, 100));
}
{
  const gate = makeGate({ approval: "none" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC });
  check("none → refused", dec.kind === "refused", dec.kind);
  check("none → просит построить план заново", /заново/i.test(dec.result), dec.result.slice(0, 120));
}

// ═══ [7] Решение по СОСТОЯНИЮ ПЛАНА, а не по текущей настройке ═════════════
console.log("\n[7] выключение TG_APPROVAL между планом и исполнением НЕ снимает требование кнопки");
{
  const gate = makeGate({ approval: "approved" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  check("план ушёл кнопкой (метка стоит)", store.manifests.get(id).tgNotified === true);
  // ...а теперь слой «выключили» (env поменяли, процесс перезапустили и т.п.)
  gate.state.enabled = false;
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC });
  check("текстовый путь ВСЁ РАВНО закрыт", dec.kind === "refused", dec.kind);
  check("...именно по button-only, а не по чему-то ещё", /подтверждено кнопкой/i.test(dec.result), dec.result.slice(0, 120));
  check("...манифест НЕ погашен", store.manifests.get(id).status === "AWAITING_CONSENT", store.manifests.get(id).status);
}
{
  // Зеркально: план БЕЗ метки (строился при выключенном слое), слой включили
  // потом — button-only не активируется, но старый двухфакторный путь просит
  // кнопку по текущей настройке (fail-closed, как было до этой правки).
  const offGate = makeGate({ enabled: false });
  const { store, id } = await buildPlan({ gate: offGate, hasAutoExecutor: HAS_EXEC });
  check("метки нет", store.manifests.get(id).tgNotified !== true);
  const onGate = makeGate({ enabled: true, approval: "none" });
  const dec = await exec({ store, id, gate: onGate, hasAutoExecutor: HAS_EXEC });
  check("непомеченный план + включённый слой → отказ (строки одобрения нет)", dec.kind === "refused", dec.kind);
}

// ═══ [8] Выключенный Telegram-слой = всё как раньше ════════════════════════
console.log("\n[8] Telegram выключен → обычный текстовый путь работает как раньше");
{
  const gate = makeGate({ enabled: false });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC, userReply: "да" });
  check("текстовое «да» ИСПОЛНЯЕТ", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 140));
  check("манифест DONE", store.manifests.get(id).status === "DONE");
  check("checkApproval не вызывался НИ РАЗУ", gate.calls.checkApproval === 0, String(gate.calls.checkApproval));
}
{
  const gate = makeGate({ enabled: false });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC, userReply: "нет, отмена" });
  check("«нет, отмена» → refused", dec.kind === "refused", dec.kind);
  check("«нет, отмена» → манифест INVALIDATED", store.manifests.get(id).status === "INVALIDATED", store.manifests.get(id).status);
  check("checkApproval не вызывался НИ РАЗУ", gate.calls.checkApproval === 0, String(gate.calls.checkApproval));
}
{
  // Совсем без tg (форк без Telegram) — поведение прежнее.
  const { store, id } = await buildPlan({ hasAutoExecutor: HAS_EXEC });
  check("без tg метка не ставится", store.manifests.get(id).tgNotified !== true);
  const dec = await exec({ store, id, hasAutoExecutor: HAS_EXEC, userReply: "да" });
  check("без tg текстовое «да» исполняет", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 120));
}

// ═══ [9] Отрицание сжигает план даже в button-only режиме ═════════════════
console.log("\n[9] «нет» в чате гасит план, не дожидаясь кнопки (эталонное поведение)");
{
  const gate = makeGate({ approval: "pending" });
  const { store, id } = await buildPlan({ gate, hasAutoExecutor: HAS_EXEC });
  const dec = await exec({ store, id, gate, hasAutoExecutor: HAS_EXEC, userReply: "нет, отмена" });
  check("отрицание → refused", dec.kind === "refused", dec.kind);
  check("отрицание → манифест INVALIDATED даже при button-only", store.manifests.get(id).status === "INVALIDATED", store.manifests.get(id).status);
  check("checkApproval не понадобился (отрицание проверяется раньше)", gate.calls.checkApproval === 0, String(gate.calls.checkApproval));
}

// ═══ [10] ИНВЕНТАРИЗАЦИЯ: у каждого тула, чей план уходит кнопкой, ═════════
//          есть чем исполниться по нажатию
console.log("\n[10] инвентаризация: гейтованные write-тулы ⇄ реестр авто-исполнителей");
{
  // Источник истины — РЕАЛЬНЫЙ реестр сервера в процессе (то, что видит
  // модель), а не regex по исходнику: признак «инструмент защищён гейтом» —
  // наличие ОБОИХ параметров подтверждения в ОПУБЛИКОВАННОЙ схеме.
  const consentStore = makeStore();
  const clients = {
    names: ["work"], defaultName: "work", multi: false,
    resolve: () => ({ docs: { documents: {} }, drive: { files: {} } }),
    baseGmailQuery: () => "",
  };
  const server = new McpServer({ name: "button-only-inventory", version: "0" });
  registerAccountTools(server, clients);
  registerDocsTools(server, clients, { consentStore, consentCfg: cfg, auditStore: null });
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  const tools = (await cli.listTools()).tools;

  const gated = tools.filter((t) => {
    const props = t.inputSchema?.properties ?? {};
    return "manifest_id" in props && "user_reply" in props;
  });
  check("реестр непуст (санитарная проверка скана)", tools.length > 5, String(tools.length));
  // Нижняя граница — иначе сломанный отбор молча прошёл бы по пустому множеству.
  check("гейтованных write-тулов найдено >= 5", gated.length >= 5, String(gated.length));

  // Исключения — поимённо, с объяснением. Пусто: у docs-mcp все пять
  // гейтованных тулов имеют авто-исполнитель.
  const NO_AUTO_EXECUTOR_ALLOWLIST = {};
  for (const t of gated) {
    const allowed = t.name in NO_AUTO_EXECUTOR_ALLOWLIST;
    check(
      `${t.name}: есть авто-исполнитель (или назван в исключениях)`,
      getAutoExecutor(t.name) !== undefined || allowed,
      allowed ? "allowlisted" : "НЕТ исполнителя — план уйдёт кнопкой, а нажатие ничего не сделает",
    );
  }

  // Вторичная инвентаризация — «кто вообще регистрирует авто-исполнитель»:
  // рантайм-реестр, не regex. Скан исходника оставлен только как перекрёстная
  // сверка «регистрации в файле не разошлись с рантаймом».
  const registered = registeredAutoExecuteTools();
  check("рантайм-реестр авто-исполнителей непуст (>= 5)", registered.length >= 5, String(registered.length));
  const src = readFileSync(new URL("../src/tools/docs.ts", import.meta.url), "utf8");
  const inSource = [...src.matchAll(/registerAutoExecutor\(\s*"([^"]+)"/g)].map((m) => m[1]);
  check("скан исходника нашёл >= 5 регистраций", inSource.length >= 5, String(inSource.length));
  check(
    "рантайм-реестр и исходник совпадают",
    JSON.stringify([...registered].sort()) === JSON.stringify([...inSource].sort()),
    `runtime=${registered} source=${inSource}`,
  );
  await cli.close();
  await server.close();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
