#!/usr/bin/env node
/**
 * End-to-end gate behaviour on real docs-mcp tools (ported pattern from
 * gmail-mcp's scripts/test-a3-gate.mjs / sheets-mcp's
 * scripts/test-sheets-gate.mjs, condensed to the representative scenarios
 * mcp-development-standard T2 asks for: 2-3 full plan→confirm→mutate→
 * post-verify round trips, PLUS the binding-drift proof that rehash is real
 * (not `sha256(payload)` in disguise — gate.md §3.3(2)).
 *
 * Uses an in-memory fake Google Docs API with a MUTABLE document store, so
 * "someone edited the document between plan and execute" can be simulated by
 * mutating the fake store directly between two tool calls.
 *
 * Usage: node scripts/test-docs-gate.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDocsTools } from "../dist/tools/docs.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};
const text = (r) => r.content[0].text;

// ── fake Docs API with a real mutable backing store ─────────────────────────

function makeDocWorld() {
  // documentId -> { title, text, revisionId }
  const docs = new Map([["D1", { title: "My Doc", text: "old content\n", revisionId: "rev-1" }]]);
  return { docs };
}

function fakeBody(t) {
  return { content: [{ endIndex: t.length + 2, paragraph: { elements: [{ textRun: { content: t } }] } }] };
}

let nextRev = 2;
function bumpRev(d) {
  d.revisionId = "rev-" + nextRev++;
}

function buildClients(world) {
  return {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      docs: {
        documents: {
          get: async ({ documentId }) => {
            const d = world.docs.get(documentId);
            if (!d) throw new Error("not found");
            return { data: { documentId, title: d.title, revisionId: d.revisionId, body: fakeBody(d.text) } };
          },
          create: async ({ requestBody }) => {
            const documentId = "NEW" + nextRev;
            world.docs.set(documentId, { title: requestBody?.properties?.title ?? requestBody?.title ?? "Untitled", text: "", revisionId: "rev-" + nextRev });
            nextRev++;
            return { data: { documentId, title: world.docs.get(documentId).title } };
          },
          batchUpdate: async ({ documentId, requestBody }) => {
            const d = world.docs.get(documentId);
            if (!d) throw new Error("not found");
            const replies = [];
            for (const req of requestBody.requests) {
              if (req.insertText) {
                const idx = Math.max(0, (req.insertText.location?.index ?? 1) - 1);
                d.text = d.text.slice(0, idx) + req.insertText.text + d.text.slice(idx);
                replies.push({});
              } else if (req.replaceAllText) {
                const find = req.replaceAllText.containsText.text;
                const matchCase = req.replaceAllText.containsText.matchCase ?? false;
                const replaceText = req.replaceAllText.replaceText;
                const flags = matchCase ? "g" : "gi";
                const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
                const occurrences = (d.text.match(re) ?? []).length;
                d.text = d.text.replace(re, replaceText);
                replies.push({ replaceAllText: { occurrencesChanged: occurrences } });
              }
            }
            bumpRev(d);
            return { data: { replies } };
          },
        },
      },
      drive: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    baseGmailQuery: () => "",
  };
}

async function harness(world, cfgOverrides = {}) {
  const clients = buildClients(world);
  const manifests = new Map();
  const audits = [];
  const consentStore = {
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest(id, server, userReply) {
      const r = manifests.get(id);
      if (!r || r.server !== server || r.status !== "AWAITING_CONSENT") return null;
      if (Date.now() >= r.expiresAt) return null;
      r.status = "DONE";
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
    // Опциональный метод контракта consent.ts — из него sync-wait достаёт
    // пруф post-verify чужого исполнения для отчёта `already_executed`.
    async getExecutionAudit(manifestId, server) {
      const a = [...audits]
        .reverse()
        .find((x) => x.manifestId === manifestId && x.server === server && (x.outcome === "confirmed" || x.outcome === "failed"));
      return a ? { id: a.id, outcome: a.outcome, postVerifyResult: a.postVerify ?? null, error: a.error ?? null, actor: a.actor ?? null } : null;
    },
  };
  const consentCtx = {
    consentStore,
    consentCfg: { server: "docs", consentTtlMs: 3_600_000, minConsentGapMs: 0, sendBatchMax: 10, ...cfgOverrides },
    auditStore: null,
  };
  const server = new McpServer({ name: "docs-gate-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerDocsTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, manifests, world, consentStore };
}

function extractManifestId(planText) {
  const m = /план `([a-f0-9-]+)`/.exec(planText);
  return m?.[1];
}

// ── [1] happy path: docs_append_text plan → confirm → mutation → ✅ ─────────
console.log("\n[1] docs_append_text: full plan→confirm round trip, mutation lands, post-verify ✅");
{
  const world = makeDocWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "docs_append_text", arguments: { items: [{ documentId: "D1", text: "new line" }] } });
  const planBody = text(planResp);
  check("plan mentions the appended text", planBody.includes("new line"), planBody.slice(0, 200));
  check("world NOT mutated yet", !world.docs.get("D1").text.includes("new line"));
  const manifestId = extractManifestId(planBody);
  check("manifest id extracted from preview", !!manifestId, planBody.slice(0, 200));

  const execResp = await cli.callTool({ name: "docs_append_text", arguments: { manifest_id: manifestId, user_reply: "да, пиши" } });
  const execBody = text(execResp);
  // Баг #131: раньше этот текст был `JSON.stringify({summary, results, verification})`
  // — сырой JSON, а не человекочитаемый отчёт (и в частности утекал напрямую
  // в Telegram при авто-исполнении по кнопке, см. autoExecute.ts/tg_approval.ts).
  check("execute succeeds — summary shows 1/1, no error, по-русски", execBody.includes("### 📝 Добавлено 1/1"), execBody.slice(0, 60));
  check("НЕ сырой JSON", !execBody.trim().startsWith("{"), execBody.slice(0, 60));
  check("НЕ содержит служебную инструкцию для модели ('[агенту:')", !execBody.includes("[агенту:"), execBody);
  check("world IS mutated", world.docs.get("D1").text.includes("new line"));
  check("post-verify report attached with ✅", execBody.includes("Независимая проверка добавления текста") && execBody.includes("✅"));
}

// ── [2] binding drift: someone edits the doc between plan and execute ───────
console.log("\n[2] docs_insert_text: document edited between plan and execute → 🛑, NOT mutated (real rehash, not sha256(payload))");
{
  const world = makeDocWorld();
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "docs_insert_text", arguments: { items: [{ documentId: "D1", text: "INSERTED", index: 1 }] } });
  const manifestId = extractManifestId(text(planResp));

  // Simulate a concurrent edit landing between plan and execute.
  const d = world.docs.get("D1");
  d.text = "someone else's edit\n";
  bumpRev(d);

  const execResp = await cli.callTool({ name: "docs_insert_text", arguments: { manifest_id: manifestId, user_reply: "да" } });
  const execBody = text(execResp);
  check("refused with 🛑", execBody.includes("🛑"), execBody.slice(0, 60));
  check("refusal names state change", execBody.includes("изменилось"), execBody.slice(0, 200));
  check("the concurrent edit is UNTOUCHED (insert never happened)", world.docs.get("D1").text === "someone else's edit\n");
}

// ── [3] negation invalidates: docs_replace_text ──────────────────────────────
console.log("\n[3] docs_replace_text: user says 'нет' → 🛑 отменено, document untouched, manifest re-use fails");
{
  const world = makeDocWorld();
  world.docs.get("D1").text = "precious data here\n";
  const { cli } = await harness(world);
  const planResp = await cli.callTool({ name: "docs_replace_text", arguments: { items: [{ documentId: "D1", find: "precious", replace: "gone" }] } });
  const planBody = text(planResp);
  check("plan shows the matched fragment", planBody.includes("precious data here"), planBody.slice(0, 300));
  const manifestId = extractManifestId(planBody);

  const noResp = await cli.callTool({ name: "docs_replace_text", arguments: { manifest_id: manifestId, user_reply: "нет, стоп" } });
  check("negation → 🛑 Отменено", text(noResp).includes("Отменено"), text(noResp).slice(0, 80));
  check("data untouched after negation", world.docs.get("D1").text.includes("precious data here"));

  const retryResp = await cli.callTool({ name: "docs_replace_text", arguments: { manifest_id: manifestId, user_reply: "да" } });
  check("re-using an invalidated manifest still fails", text(retryResp).includes("🛑"), text(retryResp).slice(0, 60));
  check("data STILL untouched", world.docs.get("D1").text.includes("precious data here"));
}

// ── [4] гибридное короткое ожидание (docs/TZ_consent_web_hub.md, часть 1) ───
// End-to-end доказательство пункта 2 тестового плана — но по ИСПРАВЛЕННОМУ
// (безопасному) контракту: реальную мутацию исполняет тот канал, который
// РЕАЛЬНО подтвердил (веб-хаб, через tryAutoExecute — здесь симулируется
// напрямую мутацией world), а requireConsent, наблюдая чужой DONE, НИКОГДА
// не говорит вызывающему тулу «исполняй» — иначе мутация случилась бы
// ДВАЖДЫ. Раньше здесь стоял противоположный (небезопасный) тест-контракт —
// заменено намеренно, см. `src/consent.ts`, комментарий "ИСПРАВЛЕНО" рядом
// с обработкой row.status === "DONE".
console.log("\n[4] docs_append_text: подтверждено и исполнено «извне» в середине окна ожидания → ОДИН вызов тула, мутация НЕ дублируется");
{
  const world = makeDocWorld();
  let ticks = 0;
  const cfgOverrides = {
    syncWaitMs: 10_000,
    syncPollMs: 1_000,
    sleep: async (ms) => {
      ticks++;
      await new Promise((r) => setTimeout(r, 0)); // не ждём реальные 10с в тесте
      if (ticks === 2) {
        // Симулируем POST /pending-consents/decide, случившийся ПОКА этот же
        // вызов docs_append_text ещё ждёт. В реальности decide-роут САМ
        // выполняет мутацию через tryAutoExecute (не просто помечает
        // манифест DONE) — здесь это симулируется прямой мутацией world,
        // ТЕМ ЖЕ способом, каким реальный batchUpdate дописывает текст.
        const d = world.docs.get("D1");
        d.text = d.text + "confirmed via hub";
        bumpRev(d);
        const id = [...manifestsRef.keys()][0];
        await consentStoreRef.consumeManifest(id, "docs", "[веб-хаб: подтверждено]");
        // …и пишет свою аудит-строку с пруфом post-verify — как настоящий
        // `tryAutoExecute` + per-tool `execute` (именно её sync-wait читает,
        // чтобы донести до модели ФАКТИЧЕСКИЙ результат, а не голое
        // «исполнено через другой канал»).
        await consentStoreRef.appendConsentAudit({
          id: "audit-hub-1", ts: Date.now(), server: "docs", tool: "docs_append_text",
          accountLabel: "work", manifestId: id, objectHash: null,
          userReply: "[веб-хаб: подтверждено]", checks: { source: "web_hub" },
          outcome: "confirmed", actor: "web",
        });
        await consentStoreRef.updateConsentAuditOutcome("audit-hub-1", {
          outcome: "confirmed",
          postVerify: "### 🧾 Независимая проверка добавления текста\n\n- ✅ «My Doc»: текст на месте",
        });
      }
    },
  };
  // manifestsRef/consentStoreRef заполняются ниже, после harness() — сам
  // cfgOverrides.sleep читает их через замыкание (ссылки, не значения).
  let manifestsRef, consentStoreRef;
  const { cli, manifests, consentStore } = await harness(world, cfgOverrides);
  manifestsRef = manifests;
  consentStoreRef = consentStore;

  const planResp = await cli.callTool({ name: "docs_append_text", arguments: { items: [{ documentId: "D1", text: "confirmed via hub" }] } });
  const planBody = text(planResp);
  check("тул НЕ вернул собственный отчёт об исполнении (не «### 📝 Добавлено»)", !planBody.includes("### 📝 Добавлено"), planBody.slice(0, 80));
  check("текст сообщает, что уже подтверждено и исполнено через другой канал", planBody.includes("одтвержд") && planBody.includes("исполнен"), planBody.slice(0, 150));
  const occurrences = (world.docs.get("D1").text.match(/confirmed via hub/g) || []).length;
  check("мутация произошла РОВНО ОДИН раз (не задвоена вызывающим тулом)", occurrences === 1, `occurrences=${occurrences}`);
  check("ровно 2 итерации опроса (подтверждено на 2-й)", ticks === 2, `ticks=${ticks}`);
  // Главное в правке 2026-08-14: модель больше не получает положительный
  // исход в форме ОТКАЗА — иначе она видит «отказ» и шлёт запрос заново по
  // кругу (жалоба Максима).
  check("_meta.kind = 'execution-report' (НЕ 'refusal')", planResp._meta?.kind === "execution-report", JSON.stringify(planResp._meta));
  check("отчёт НЕ помечен 🛑 (это не отказ)", !planBody.includes("🛑"), planBody.slice(0, 120));
  check("ФАКТИЧЕСКИЙ результат (пруф post-verify исполнившего канала) донесён до модели", planBody.includes("Независимая проверка добавления текста"), planBody.slice(-300));
  check("модели прямо сказано не повторять вызов", planBody.includes("повторять вызов"), planBody.slice(-400));

  // Регресс на настоящий ОТКАЗ: он обязан остаться отказом с меткой "refusal".
  const refusedResp = await cli.callTool({ name: "docs_append_text", arguments: { manifest_id: "нет-такого", user_reply: "да" } });
  check("настоящий отказ по-прежнему помечен _meta.kind='refusal'", refusedResp._meta?.kind === "refusal", JSON.stringify(refusedResp._meta));
  check("настоящий отказ по-прежнему несёт 🛑", text(refusedResp).includes("🛑"), text(refusedResp).slice(0, 80));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
