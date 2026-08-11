#!/usr/bin/env node
/**
 * automation_key branch of the consent gate (`docs/TZ_automation_key_consent_gate.md`).
 * Two parts, same convention as the rest of this repo's test scripts:
 *
 *   [0-6] offline unit tests of `requireConsent`'s automation_key branch —
 *         same fake in-memory store/clock harness as scripts/test-consent.mjs
 *         (ported byte-for-byte for the harness bits), imports `../src/consent.ts`
 *         directly (Node ≥ 22.18 loads .ts without a build step).
 *   [7]   one live tool (`docs_create`) proving the bypass works end-to-end at
 *         the INSTRUMENT level, not just inside consent.ts in isolation —
 *         imports `../dist/tools/docs.js`, so `npm run build` must have run
 *         first (same requirement as scripts/test-docs-gate.mjs).
 *
 * Covers the 8-point test plan from docs/TZ_automation_key_consent_gate.md:
 *   1. checkAutomationKey undefined → regression (byte-identical to before).
 *   2. Valid key → confirmed on the FIRST call, no manifest_id/user_reply.
 *   3. Invalid key → silent fallthrough to the normal plan path (NOT an error).
 *   4. rehash mismatch on the automation path → refused, not silent execution.
 *   5. batch > sendBatchMax on the automation path → same refusal as normal.
 *   6. audit entry on automation-execute carries actor:"automation" +
 *      checks.automationKey with the channel label.
 *   7. a real tool (docs_create) accepts automation_key and bypasses via mock DI.
 *   8. full `npm test` green — checked by the test runner itself, not here.
 *
 * Usage: node scripts/test-automation-key.mjs
 */
import { requireConsent, canonicalJson, sha256 } from "../src/consent.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDocsTools } from "../dist/tools/docs.js";
import { registerAccountTools } from "../dist/accounts.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// ── same fake store/clock harness as scripts/test-consent.mjs ──────────────

const clock = { t: 1_700_000_000_000 };
const now = () => clock.t;

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
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
}

const cfg = { server: "docs", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10, now };

const PAYLOAD = { account: "work", items: [{ documentId: "DOC1", find: "2025", replace: "2026" }] };
const OBJHASH = sha256(PAYLOAD);
const plan = () => ({
  payload: PAYLOAD,
  objectHash: OBJHASH,
  preview: "### 📤 План: Замена текста — 1\n\n- **«DOC1»**: «2025» → «2026»",
  batchSize: 1,
});
const rehash = (payload) => sha256(payload);

const OK_DI = async (key) => (key === "good-key" ? { ok: true, channel: "window:1700000000000" } : { ok: false });

// ── [0] undefined checkAutomationKey → byte-identical regression ───────────
console.log("\n[0] checkAutomationKey не задан — regress: automationKey игнорируется, обычный план как раньше");
{
  const store = makeStore();
  const dec = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    automationKey: "good-key", // present, but no checkAutomationKey wired
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=planned (automation_key без DI ничего не меняет)", dec.kind === "planned", JSON.stringify(dec).slice(0, 80));
  check("манифест создан обычным путём", store.manifests.size === 1);
  check("аудит НЕ несёт actor=automation", !store.audits.some((a) => a.actor === "automation"));
}

// ── [1] full test-consent.mjs regression suite still covers the rest ───────
console.log("\n[1] (регресс существующего набора покрывается npm run test:consent отдельно — здесь не дублируется)");

// ── [2] valid key → confirmed on the FIRST call ─────────────────────────────
console.log("\n[2] валидный automation_key → confirmed с первого вызова, без manifest_id/user_reply");
{
  const store = makeStore();
  const dec = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    automationKey: "good-key",
    checkAutomationKey: OK_DI,
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=confirmed", dec.kind === "confirmed", JSON.stringify(dec).slice(0, 100));
  check("manifestId пуст (манифест не создавался)", dec.kind === "confirmed" && dec.manifestId === "");
  check("payload — из построенного плана", dec.kind === "confirmed" && canonicalJson(dec.payload) === canonicalJson(PAYLOAD));
  check("auditId возвращён", dec.kind === "confirmed" && typeof dec.auditId === "string");
  check("НИКАКОГО манифеста в store", store.manifests.size === 0);
}

// ── [3] invalid key → silent fallthrough, NOT an error ──────────────────────
console.log("\n[3] невалидный/неизвестный automation_key → тихий fallthrough на обычный план, НЕ ошибка");
{
  const store = makeStore();
  const dec = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    automationKey: "bad-key",
    checkAutomationKey: OK_DI,
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=planned (не refused, не throw)", dec.kind === "planned", JSON.stringify(dec).slice(0, 100));
  check("превью не намекает на automation_key вообще", !dec.preview.toLowerCase().includes("automation"));
  check("манифест создан как в обычном плане", store.manifests.size === 1);
  check("аудит-мутация в фазе плана не пишется (как и в обычном пути)", store.audits.length === 0);
}

// ── [4] rehash mismatch on automation path → refused, not silent execution ──
console.log("\n[4] automation-путь: rehash разошёлся с objectHash плана → 🛑 отказ, НЕ тихое исполнение");
{
  const store = makeStore();
  const changedRehash = () => sha256({ changed: true });
  const dec = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    automationKey: "good-key",
    checkAutomationKey: OK_DI,
    plan,
    rehash: changedRehash,
    store,
    cfg,
  });
  check("kind=refused", dec.kind === "refused", JSON.stringify(dec).slice(0, 100));
  check("сообщение про «изменилось»", dec.result.includes("изменилось"), dec.result?.slice(0, 80));
  check("🛑 в заголовке", dec.result.includes("🛑"));
  check("НИЧЕГО не исполнено — манифестов нет, аудит несёт refused+automation", store.manifests.size === 0);
  check("аудит: outcome=refused, actor=automation", store.audits.at(-1)?.outcome === "refused" && store.audits.at(-1)?.actor === "automation");
  check("аудит: checks.automationKey несёт канал", store.audits.at(-1)?.checks?.automationKey === "window:1700000000000");
}

// ── [5] batch cap exceeded on automation path → same refusal as normal path ─
console.log("\n[5] automation-путь: батч > sendBatchMax → тот же отказ, что и на обычном пути");
{
  const store = makeStore();
  const bigPlan = () => ({ payload: PAYLOAD, objectHash: OBJHASH, preview: "p", batchSize: 11 });
  const decAuto = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    automationKey: "good-key",
    checkAutomationKey: OK_DI,
    plan: bigPlan,
    rehash,
    store,
    cfg,
  });
  const decHuman = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    plan: bigPlan,
    rehash,
    store: makeStore(),
    cfg,
  });
  check("automation-путь: kind=refused", decAuto.kind === "refused");
  check("тот же текст отказа, что у человеческого пути", decAuto.result === decHuman.result, `auto=${decAuto.result?.slice(0, 60)} human=${decHuman.result?.slice(0, 60)}`);
  check("манифест НЕ создан", store.manifests.size === 0);
  check("аудит: actor=automation, checks.batchCap=exceeded", store.audits.at(-1)?.actor === "automation" && store.audits.at(-1)?.checks?.batchCap === "exceeded");
}

// ── [6] audit on successful automation-execute: actor + channel label ──────
console.log("\n[6] аудит успешного automation-исполнения несёт actor:'automation' и checks.automationKey с меткой канала");
{
  const store = makeStore();
  const dec = await requireConsent({
    tool: "docs_replace_text",
    accountLabel: "work",
    automationKey: "good-key",
    checkAutomationKey: OK_DI,
    plan,
    rehash,
    store,
    cfg,
  });
  check("kind=confirmed", dec.kind === "confirmed");
  const audit = store.audits.find((a) => a.id === dec.auditId);
  check("аудит-строка найдена", !!audit);
  check("actor === 'automation'", audit?.actor === "automation", audit?.actor);
  check("outcome === 'confirmed'", audit?.outcome === "confirmed");
  check("checks.automationKey несёт метку канала (window:<created_at>)", audit?.checks?.automationKey === "window:1700000000000", audit?.checks?.automationKey);
  check("checks.binding === 'ok'", audit?.checks?.binding === "ok");
  check("userReply пуст (не человек отвечал)", audit?.userReply === "");
}

// ── [7] live tool: docs_create принимает automation_key и реально его прокидывает ─
console.log("\n[7] живой инструмент docs_create: принимает automation_key в схеме, полный обход через мок-DI");
{
  const documents = new Map();
  let nextId = 1;
  const clients = {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      docs: {
        documents: {
          create: async ({ requestBody }) => {
            const documentId = "NEW" + nextId++;
            documents.set(documentId, { title: requestBody?.title ?? "Untitled" });
            return { data: { documentId, title: documents.get(documentId).title } };
          },
        },
      },
      drive: { files: { list: async () => ({ data: { files: [] } }) } },
    }),
    baseGmailQuery: () => "",
  };

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
      r.status = "DONE";
      r.userReply = userReply;
      return { ...r };
    },
    async invalidateManifest() {},
    async appendConsentAudit(entry) {
      audits.push({ ...entry });
    },
    async updateConsentAuditOutcome(auditId, outcome) {
      const a = audits.find((x) => x.id === auditId);
      if (a) Object.assign(a, outcome);
    },
  };
  const consentCtx = {
    consentStore,
    consentCfg: { server: "docs", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10 },
    auditStore: null,
    checkAutomationKey: async (key) => (key === "live-good-key" ? { ok: true, channel: "window:42" } : { ok: false }),
  };

  const server = new McpServer({ name: "docs-automation-key-e2e", version: "0" });
  registerAccountTools(server, clients);
  registerDocsTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);

  const tools = (await cli.listTools()).tools;
  const createTool = tools.find((t) => t.name === "docs_create");
  check("docs_create schema exposes automation_key", "automation_key" in (createTool?.inputSchema?.properties ?? {}), JSON.stringify(Object.keys(createTool?.inputSchema?.properties ?? {})));

  // Wrong key → silent fallthrough to a normal plan, nothing created yet.
  const badResp = await cli.callTool({ name: "docs_create", arguments: { documents: [{ title: "Doc A" }], automation_key: "wrong-key" } });
  const badText = badResp.content[0].text;
  check("неверный automation_key на живом инструменте → план, не ошибка", badText.includes("### 📤 План"), badText.slice(0, 60));
  check("ничего не создано неверным ключом", documents.size === 0);

  // Right key → the document is created on the FIRST call, no manifest_id/user_reply.
  const manifestsBefore = manifests.size; // the wrong-key call above created one plan manifest
  const goodResp = await cli.callTool({ name: "docs_create", arguments: { documents: [{ title: "Doc B" }], automation_key: "live-good-key" } });
  const goodText = goodResp.content[0].text;
  check("верный automation_key на живом инструменте → создано с первого вызова", documents.size === 1, `documents=${documents.size}`);
  check("ответ не выглядит как план ожидания", !goodText.includes("[агенту:"), goodText.slice(0, 200));
  check("манифест в consent_manifests НЕ создан ДОПОЛНИТЕЛЬНО для automation-пути", manifests.size === manifestsBefore, `before=${manifestsBefore} after=${manifests.size}`);
  check("аудит несёт actor=automation для этого вызова", audits.some((a) => a.actor === "automation" && a.tool === "docs_create"), JSON.stringify(audits.map((a) => ({ tool: a.tool, actor: a.actor }))));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
