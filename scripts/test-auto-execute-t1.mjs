#!/usr/bin/env node
/**
 * Happy-path coverage for the T1 auto-execute package on docs-mcp (Максим,
 * 2026-08-05: «нажал кнопку — должно сразу исполниться на бэке») — extends
 * `test-auto-execute.mjs` (which only covers `tryAutoExecute`'s own
 * binding/one-shot/TTL guards against a hand-picked fake) with ONE check
 * per registered docs_* auto-executor: `getAutoExecutor(tool)` exists and
 * its `execute()` actually calls the right Docs API and returns a
 * non-empty human-readable report — the same text the model would have
 * seen from the normal (non-auto) tool call. Ported from gmail-mcp's
 * scripts/test-auto-execute-t1.mjs, fake API swapped for Google Docs.
 *
 * Fully offline: fake GoogleClients (`g`) over a mutable in-memory document
 * store, same style as test-docs-gate.mjs's fake world. No real network, no
 * real DB.
 *
 * Usage: node scripts/test-auto-execute-t1.mjs (needs `npm run build` first
 * — imports the COMPILED dist/, same convention as test-docs-gate.mjs).
 */
import { getAutoExecutor } from "../dist/autoExecute.js";
// Side-effect import: registers every docs_* auto-executor at module load.
import "../dist/tools/docs.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

/** Fresh fake Docs world (mutable documentId -> {title, text, revisionId})
 * + call recorder, one per test so calls from one tool never leak into
 * another tool's assertions. */
function makeFakeG(seed = {}) {
  const docs = new Map(
    Object.entries(seed).length
      ? Object.entries(seed)
      : [["D1", { title: "My Doc", text: "old content\n", revisionId: "rev-1" }]],
  );
  const calls = { create: [], batchUpdate: [], get: [] };
  let nextRev = 2;
  let nextId = 100;
  const fakeBody = (t) => ({ content: [{ endIndex: t.length + 2, paragraph: { elements: [{ textRun: { content: t } }] } }] });

  const g = {
    docs: {
      documents: {
        get: async ({ documentId }) => {
          calls.get.push({ documentId });
          const d = docs.get(documentId);
          if (!d) throw new Error("not found");
          return { data: { documentId, title: d.title, revisionId: d.revisionId, body: fakeBody(d.text) } };
        },
        create: async ({ requestBody }) => {
          calls.create.push({ requestBody });
          const documentId = "NEW" + nextId++;
          const title = requestBody.title;
          docs.set(documentId, { title, text: "", revisionId: "rev-" + nextRev++ });
          return { data: { documentId, title } };
        },
        batchUpdate: async ({ documentId, requestBody }) => {
          calls.batchUpdate.push({ documentId, requestBody });
          const d = docs.get(documentId);
          if (!d) throw new Error("not found");
          const replies = [];
          for (const req of requestBody.requests) {
            if (req.insertText) {
              const text = req.insertText.text;
              // Simplified: always append (index handling not needed for these checks).
              d.text = d.text + text;
              replies.push({});
            } else if (req.replaceAllText) {
              const { text: find } = req.replaceAllText.containsText;
              const replaceText = req.replaceAllText.replaceText;
              const occurrences = d.text.split(find).length - 1;
              d.text = d.text.split(find).join(replaceText);
              replies.push({ replaceAllText: { occurrencesChanged: occurrences } });
            } else {
              // Raw/unknown request kind (docs_raw_batch_update) — no-op on
              // the fake text, just record that it went through.
              replies.push({});
            }
          }
          d.revisionId = "rev-" + nextRev++;
          return { data: { replies } };
        },
      },
    },
  };
  return { g, calls, docs };
}

function makeConsentStore() {
  const outcomes = [];
  return {
    outcomes,
    createManifest: async () => {},
    getManifest: async () => null,
    consumeManifest: async () => null,
    invalidateManifest: async () => {},
    appendConsentAudit: async () => {},
    updateConsentAuditOutcome: async (auditId, outcome) => { outcomes.push({ auditId, ...outcome }); },
  };
}

function makeCtx(g) {
  return {
    clients: { resolve: () => g },
    consentStore: makeConsentStore(),
    userToken: null,
  };
}

async function runHappyPath(tool, payload, seed, assertFn) {
  console.log(`\n[${tool}] happy path`);
  const executor = getAutoExecutor(tool);
  check("зарегистрирован в реестре (getAutoExecutor не undefined)", !!executor, `getAutoExecutor("${tool}") вернул undefined`);
  if (!executor) return;
  const { g, calls, docs } = makeFakeG(seed);
  const ctx = makeCtx(g);
  let text;
  let threw = null;
  try {
    text = await executor.execute(payload, "audit-" + tool, ctx);
  } catch (e) {
    threw = e;
  }
  check("execute() не упал", !threw, threw ? String(threw) : "");
  if (threw) return;
  check("вернул непустую строку (текст отчёта)", typeof text === "string" && text.length > 0, JSON.stringify(text));
  assertFn(calls, text, docs);
}

// ---- docs_create --------------------------------------------------------
await runHappyPath(
  "docs_create",
  { account: "work", documents: [{ title: "Q4 план", initialText: "старт" }] },
  {},
  (calls, text) => {
    check("documents.create вызван с правильным title", calls.create.length === 1 && calls.create[0].requestBody.title === "Q4 план");
    check("initialText вставлен через batchUpdate", calls.batchUpdate.length === 1);
    check("текст отчёта содержит ссылку на документ (documentUrl) — главный кейс фичи", text.includes("docs.google.com/document/d/"), text);
  },
);

// ---- docs_append_text -----------------------------------------------------
await runHappyPath(
  "docs_append_text",
  { account: "work", items: [{ documentId: "D1", text: "добавленный текст" }] },
  { D1: { title: "My Doc", text: "old content\n", revisionId: "rev-1" } },
  (calls, text, docs) => {
    check("batchUpdate вызван для добавления", calls.batchUpdate.some((c) => c.documentId === "D1"));
    check("текст реально добавлен в живой документ", docs.get("D1").text.includes("добавленный текст"));
    check("текст отчёта упоминает 'Appended'", text.includes("Appended"), text);
  },
);

// ---- docs_insert_text -------------------------------------------------------
await runHappyPath(
  "docs_insert_text",
  { account: "work", items: [{ documentId: "D1", text: "вставленный текст", index: 1 }] },
  { D1: { title: "My Doc", text: "old content\n", revisionId: "rev-1" } },
  (calls, text, docs) => {
    check("batchUpdate вызван для вставки", calls.batchUpdate.some((c) => c.documentId === "D1"));
    check("текст реально вставлен в живой документ", docs.get("D1").text.includes("вставленный текст"));
    check("текст отчёта упоминает 'Inserted'", text.includes("Inserted"), text);
  },
);

// ---- docs_replace_text -------------------------------------------------------
await runHappyPath(
  "docs_replace_text",
  { account: "work", items: [{ documentId: "D1", find: "old", replace: "new", matchCase: false }] },
  { D1: { title: "My Doc", text: "old content\n", revisionId: "rev-1" } },
  (calls, text, docs) => {
    check("batchUpdate вызван с replaceAllText", calls.batchUpdate.some((c) => c.requestBody.requests[0].replaceAllText));
    check("замена реально применена в живом документе", docs.get("D1").text.includes("new content"));
    check("текст отчёта упоминает 'Replaced'", text.includes("Replaced"), text);
  },
);

// ---- docs_raw_batch_update ---------------------------------------------------
await runHappyPath(
  "docs_raw_batch_update",
  { account: "work", items: [{ documentId: "D1", requests: [{ updateTextStyle: { textStyle: { bold: true } } }] }] },
  { D1: { title: "My Doc", text: "old content\n", revisionId: "rev-1" } },
  (calls, text) => {
    check("batchUpdate вызван с произвольным запросом", calls.batchUpdate.some((c) => c.documentId === "D1"));
    check("текст отчёта упоминает 'Applied'", text.includes("Applied"), text);
  },
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
