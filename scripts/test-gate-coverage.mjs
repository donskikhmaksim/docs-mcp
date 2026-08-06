#!/usr/bin/env node
/**
 * Reflexive gate-coverage test (ported from gmail-mcp's
 * scripts/test-gate-coverage.mjs / sheets-mcp's scripts/test-gate-coverage.mjs
 * — mcp-development-standard `references/development-pipeline.md`, T2
 * checklist item 4).
 *
 * Does NOT hand-pick which tools to exercise. It lists the tools from the
 * REAL registered MCP registry (`client.listTools()`, i.e. what a model
 * actually sees) and, for every tool classified as a write (no
 * `readOnlyHint: true` — the exact rule the task specifies), checks it
 * against an explicit allowlist:
 *
 *  - every entry in `GATED_TOOLS` gets a real BEHAVIOURAL check: calling it
 *    WITHOUT manifest_id/user_reply must not reach ANY mutating fake API
 *    call, and the response must look like a plan, not a success header;
 *  - everything else that is a write MUST be named in
 *    `UNGATED_WRITE_ALLOWLIST` below, with a one-line reason.
 *
 * Per Maksim's standing decision (2026-08-04, "гейт у ВСЕХ write, без
 * исключений") this repo's UNGATED_WRITE_ALLOWLIST is EMPTY — every write
 * tool in docs-mcp/tools/docs.ts is gated. A new write tool landing here
 * without going through requireConsent breaks CI instead of shipping
 * silently ungated.
 *
 * ⚠️ ЭТА ПОСЛЕДНЯЯ ФРАЗА БЫЛА ЛОЖЬЮ ДО 2026-08-06. В .github/workflows лежали
 * только guide.yml и sync-upstream.yml — `npm test` в CI не запускался ВООБЩЕ,
 * то есть эта проверка ничего не «ломала», она падала разве что на чьём-то
 * ноутбуке. Исправлено добавлением .github/workflows/test.yml (npm ci →
 * typecheck → npm test на push в main и на каждый pull_request); теперь
 * утверждение соответствует действительности.
 *
 * Usage: node scripts/test-gate-coverage.mjs
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

// Empty by design — Maksim's decision: gate ALL write tools, no exceptions.
const UNGATED_WRITE_ALLOWLIST = {};

/** Every gated write tool, with args that reach its plan phase, which
 * counter must stay at 0 after a plan-only call, and the expected
 * destructiveHint (irreversible — docs_replace_text/docs_raw_batch_update —
 * vs additive/reversible — everything else). */
const GATED_TOOLS = {
  docs_create: {
    args: { documents: [{ title: "New doc" }] },
    counterKey: "documentsCreate",
    destructive: false,
  },
  docs_append_text: {
    args: { items: [{ documentId: "D1", text: "hello" }] },
    counterKey: "batchUpdate",
    destructive: false,
  },
  docs_insert_text: {
    args: { items: [{ documentId: "D1", text: "hi", index: 1 }] },
    counterKey: "batchUpdate",
    destructive: false,
  },
  docs_replace_text: {
    args: { items: [{ documentId: "D1", find: "foo", replace: "bar" }] },
    counterKey: "batchUpdate",
    destructive: true,
  },
  docs_raw_batch_update: {
    args: { items: [{ documentId: "D1", requests: [{ insertText: { location: { index: 1 }, text: "x" } }] }] },
    counterKey: "batchUpdate",
    destructive: true,
  },
};

// ── fakes ─────────────────────────────────────────────────────────────────

function makeConsentStore() {
  const manifests = new Map();
  return {
    manifests,
    async createManifest(input) {
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
    },
    async getManifest(id, server) {
      const r = manifests.get(id);
      return r && r.server === server ? { ...r } : null;
    },
    async consumeManifest() {
      return null; // this test never confirms — only the plan phase is exercised
    },
    async invalidateManifest() {},
    // Контракт ConsentStore (2026-08-06): метка «план ушёл кнопкой».
    async markTgNotified() {},
    async appendConsentAudit() {},
    async updateConsentAuditOutcome() {},
  };
}
const CONSENT_CFG = { server: "docs", consentTtlMs: 3_600_000, minConsentGapMs: 2_000, sendBatchMax: 10 };

function makeCounters() {
  return { documentsCreate: 0, batchUpdate: 0 };
}

/** Fake Docs body with a bit of plain text, so `documentToPlainText` and the
 * binding snapshot readers have something realistic to chew on. */
function fakeDocBody(text) {
  return { content: [{ endIndex: text.length + 2, paragraph: { elements: [{ textRun: { content: text + "\n" } }] } }] };
}

function buildClients(counters) {
  return {
    names: ["work"],
    defaultName: "work",
    multi: false,
    resolve: () => ({
      docs: {
        documents: {
          get: async ({ documentId }) => ({
            data: { documentId, title: "Existing document", revisionId: "rev1", body: fakeDocBody("Existing content") },
          }),
          create: async ({ requestBody }) => {
            counters.documentsCreate++;
            const documentId = "NEW" + counters.documentsCreate;
            return { data: { documentId, title: requestBody?.title } };
          },
          batchUpdate: async () => {
            counters.batchUpdate++;
            return { data: { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] } };
          },
        },
      },
      drive: {
        files: { list: async () => ({ data: { files: [] } }) },
      },
    }),
    baseGmailQuery: () => "",
  };
}

async function harness() {
  const counters = makeCounters();
  const clients = buildClients(counters);
  const consentStore = makeConsentStore();
  const consentCtx = { consentStore, consentCfg: CONSENT_CFG, auditStore: null };
  const server = new McpServer({ name: "gate-coverage", version: "0" });
  registerAccountTools(server, clients);
  registerDocsTools(server, clients, consentCtx);
  const cli = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), cli.connect(a)]);
  return { cli, counters };
}

// ═══ enumerate the REAL registry, classify, and cross-check ═════════════════

console.log("\n[1] enumerate registered tools from the real MCP registry (client.listTools())");
const { cli, counters } = await harness();
const tools = (await cli.listTools()).tools;
check("registry is non-empty (sanity)", tools.length > 5, String(tools.length));

const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true);
const reads = tools.filter((t) => t.annotations?.readOnlyHint === true);
console.log(`   ${tools.length} tool(s) total: ${reads.length} read-only, ${writes.length} write`);

console.log("\n[2] every write tool is EITHER in GATED_TOOLS OR in the explicit (empty) allowlist");
const unexpected = [];
for (const t of writes) {
  const gated = t.name in GATED_TOOLS;
  const allowlisted = t.name in UNGATED_WRITE_ALLOWLIST;
  check(`${t.name} — gated or allowlisted`, gated || allowlisted, `neither (new ungated write tool!)`);
  if (!gated && !allowlisted) unexpected.push(t.name);
}
check("no unexpected ungated write tools slipped in", unexpected.length === 0, unexpected.join(", "));
check("no write tool is missing from GATED_TOOLS (count sanity)", writes.length === Object.keys(GATED_TOOLS).length, `writes=${writes.length} GATED_TOOLS=${Object.keys(GATED_TOOLS).length}`);

console.log("\n[3] every GATED_TOOLS entry is actually registered as a write (schema sanity)");
for (const [name, spec] of Object.entries(GATED_TOOLS)) {
  const t = tools.find((x) => x.name === name);
  check(`${name} is registered`, !!t, "not found in registry");
  check(`${name} is classified as write (no readOnlyHint)`, t && t.annotations?.readOnlyHint !== true, JSON.stringify(t?.annotations));
  check(`${name} carries destructiveHint: ${spec.destructive}`, t?.annotations?.destructiveHint === spec.destructive, JSON.stringify(t?.annotations));
  const props = t?.inputSchema?.properties ?? {};
  check(`${name} schema exposes manifest_id`, "manifest_id" in props, JSON.stringify(Object.keys(props)));
  check(`${name} schema exposes user_reply`, "user_reply" in props, JSON.stringify(Object.keys(props)));
}

console.log("\n[4] behavioural proof: calling each gated tool WITHOUT manifest_id/user_reply never mutates");
for (const [name, spec] of Object.entries(GATED_TOOLS)) {
  const before = counters[spec.counterKey];
  const resp = await cli.callTool({ name, arguments: spec.args });
  const body = text(resp);
  check(`${name} plan call: mutation counter (${spec.counterKey}) unchanged`, counters[spec.counterKey] === before, String(counters[spec.counterKey]));
  check(`${name} plan call: response is a plan, not a success/failure header`, body.includes("### 📤 План"), body.slice(0, 60));
  check(`${name} plan call: no ✅/📝/❌ success-style header`, !/^[✅📝❌]/.test(body), body.slice(0, 10));
}

console.log("\n[5] read tools genuinely carry readOnlyHint (spot-check, not exhaustive)");
for (const name of ["docs_list", "docs_read", "docs_consent_audit", "list_accounts"]) {
  const t = tools.find((x) => x.name === name);
  check(`${name} readOnlyHint: true`, t?.annotations?.readOnlyHint === true, JSON.stringify(t?.annotations));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
