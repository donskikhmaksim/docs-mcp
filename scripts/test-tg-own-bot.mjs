#!/usr/bin/env node
/**
 * Тест «свой бот на сервер» (`TG_BOT_TOKEN_OVERRIDE`, задача владельца:
 * дать КАЖДОМУ из 6 MCP-серверов свой отдельный Telegram-бот/токен вместо
 * одного общего, с ПОЛНОЙ обратной совместимостью через один флаг). Затрагивает
 * три файла:
 *
 *  - `src/config.ts`      :: `loadTgApprovalConfig()` — `botToken` берёт
 *                             TG_BOT_TOKEN_OVERRIDE поверх TG_BOT_TOKEN;
 *                             новое поле `ownBot: boolean`.
 *  - `src/http.ts`        :: route-gate `/tg/webhook` — пускает запрос, если
 *                             `webhookOwner ИЛИ ownBot` (было — только `webhookOwner`).
 *  - `src/tg_approval.ts` :: `registerWebhook` — тот же `webhookOwner ИЛИ ownBot`
 *                             гейт на вызов `setWebhook`; `handleWebhook` —
 *                             при `ownBot=true` консюмит решение через
 *                             SERVER-SCOPED `store.consumeTgDecision(id, cfg.server, …)`
 *                             вместо общего `consumeTgDecisionAnyServer(id, …)`.
 *
 * Секции A/B/C — офлайн, в этом же процессе (`loadTgApprovalConfig` читает
 * `process.env` заново при каждом вызове, так что можно дёргать её многократно
 * с разными env в одном процессе; `handleWebhook`/`registerWebhook` берут
 * `TgApprovalConfig` параметром, а не модульным синглтоном). Секция D — как в
 * `test-tg-webhook-gate.mjs`: `tgApprovalConfig` в `src/server.ts` вычисляется
 * ОДИН раз при импорте из `process.env`, поэтому route-level гейт `/tg/webhook`
 * проверяется через отдельные child-процессы (`node` этого же файла с разным env).
 *
 * ВАЖНО: worker-ветка (ниже, `TG_TEST_WORKER`) обрабатывается В САМОМ НАЧАЛЕ
 * исполнения, до секций A/B/C — иначе их побочные эффекты (свои MockAgent на
 * глобальном dispatcher'е, мутации process.env через withEnv) засоряли бы
 * worker-процесс раздела D, который поднимает настоящий HTTP-сервер и должен
 * получить ЧИСТЫЙ вывод (последняя строка stdout — JSON-результат).
 *
 * КАЖДАЯ секция несёт control-кейс с `TG_BOT_TOKEN_OVERRIDE` не заданным —
 * это и есть доказательство обратной совместимости: без флага поведение
 * побитово то же, что было до этой задачи (совпадает с уже существующими
 * `test-tg-approval.mjs`/`test-tg-webhook-gate.mjs`, которые тоже должны
 * остаться зелёными).
 *
 * Запуск: node scripts/test-tg-own-bot.mjs   (после `npm run build` — секция D
 * запускает `dist/http.js`, byte-for-byte как test-tg-webhook-gate.mjs).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);

// ═══════════════════ worker mode: одна попытка запроса, JSON на stdout ═══════
async function runWorker() {
  const scenario = process.env.TG_TEST_WORKER;
  const port = Number(process.env.TG_TEST_PORT);
  const botToken = process.env.TG_BOT_TOKEN_OVERRIDE || process.env.TG_BOT_TOKEN;

  const { MockAgent, setGlobalDispatcher } = await import("undici");
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  let setWebhookCalls = 0;
  agent
    .get("https://api.telegram.org")
    .intercept({ path: `/bot${botToken}/setWebhook`, method: "POST" })
    .reply(() => {
      setWebhookCalls++;
      return { statusCode: 200, data: { ok: true, result: true }, headers: { "content-type": "application/json" } };
    })
    .persist();

  const loggedErrors = [];
  const origConsoleError = console.error;
  console.error = (...args) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const { startHttpServer } = await import(new URL("../dist/http.js", import.meta.url));

  const fakeAccount = {
    name: "default",
    auth: { mode: "oauth", clientId: "test-cid", clientSecret: "test-secret", refreshToken: "test-refresh" },
  };
  await startHttpServer({
    transport: "http",
    port,
    requireAuth: false,
    users: [{ name: "default", accounts: [fakeAccount], defaultAccount: "default" }],
    onboarding: { enabled: false },
  });

  const res = await fetch(`http://127.0.0.1:${port}/tg/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "wh-secret-xyz",
    },
    body: JSON.stringify({
      callback_query: {
        id: "cbq-ownbot-test",
        from: { id: 555 },
        data: "a:fake-manifest-id-ownbot-test",
        message: { message_id: 1, chat: { id: 555 } },
      },
    }),
  });

  console.error = origConsoleError;

  const handlerErrorLines = loggedErrors.filter((l) => l.includes("TG approval webhook error:"));
  const reachedStoreNotInitialised = handlerErrorLines.some((l) => l.includes("Store not initialised"));

  process.stdout.write(
    JSON.stringify({ scenario, status: res.status, handlerErrorLineCount: handlerErrorLines.length, reachedStoreNotInitialised, setWebhookCalls }) + "\n",
  );
  process.exit(0);
}

// Развилка — САМОЕ ПЕРВОЕ, что выполняется. Worker никогда не доходит до
// секций A/B/C/orchestrator ниже (runWorker завершает процесс сама).
if (process.env.TG_TEST_WORKER) {
  await runWorker();
}

// ═══════════════════════ orchestrator mode (секции A/B/C/D) ══════════════════

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

// Полный набор ENV, который `loadTgApprovalConfig(enabled=true)` требует
// не бросить (см. её loud fail-fast check в config.ts).
const REQUIRED_ENV = {
  TG_APPROVAL_ENABLED: "true",
  TG_OWNER_CHAT_ID: "555",
  TG_APPROVAL_WEBHOOK_SECRET: "wh-secret-xyz",
  PUBLIC_BASE_URL: "https://example.test",
};

function withEnv(vars, fn) {
  const keys = [...Object.keys(REQUIRED_ENV), ...Object.keys(vars), "TG_BOT_TOKEN", "TG_BOT_TOKEN_OVERRIDE", "TG_WEBHOOK_OWNER"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, REQUIRED_ENV, vars);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ═══════════════════════ [A] config.ts :: loadTgApprovalConfig ═══════════════
console.log("\n[A] loadTgApprovalConfig: botToken/ownBot по TG_BOT_TOKEN_OVERRIDE");
{
  const { loadTgApprovalConfig } = await import("../src/config.ts");

  // [A1] control — флаг НЕ задан: побитово старое поведение (backward-compat).
  withEnv({ TG_BOT_TOKEN: "shared-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("docs");
    check("[A1] botToken = TG_BOT_TOKEN (флаг не задан)", cfg.botToken === "shared-bot-token", cfg.botToken);
    check("[A1] ownBot = false (флаг не задан)", cfg.ownBot === false, cfg.ownBot);
  });

  // [A2] override задан ВМЕСТЕ с общим TG_BOT_TOKEN → override побеждает.
  withEnv({ TG_BOT_TOKEN: "shared-bot-token", TG_BOT_TOKEN_OVERRIDE: "docs-own-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("docs");
    check("[A2] botToken = TG_BOT_TOKEN_OVERRIDE, не TG_BOT_TOKEN", cfg.botToken === "docs-own-bot-token", cfg.botToken);
    check("[A2] ownBot = true", cfg.ownBot === true, cfg.ownBot);
  });

  // [A3] override задан БЕЗ общего TG_BOT_TOKEN — работает самостоятельно.
  withEnv({ TG_BOT_TOKEN_OVERRIDE: "docs-own-bot-token" }, () => {
    const cfg = loadTgApprovalConfig("docs");
    check("[A3] botToken = TG_BOT_TOKEN_OVERRIDE (общий TG_BOT_TOKEN не задан)", cfg.botToken === "docs-own-bot-token", cfg.botToken);
    check("[A3] ownBot = true", cfg.ownBot === true, cfg.ownBot);
  });

  // [A4] отказ (fail-fast), если ENABLED=true и НИ ОДИН токен не задан —
  // TG_BOT_TOKEN_OVERRIDE не создаёт новый обходной путь мимо этой проверки.
  withEnv({}, () => {
    let threw = false;
    try {
      loadTgApprovalConfig("docs");
    } catch (err) {
      threw = /TG_BOT_TOKEN/.test(err instanceof Error ? err.message : String(err));
    }
    check("[A4] без обоих токенов — loadTgApprovalConfig бросает (fail-fast не ослаблен)", threw);
  });
}

// ═════════════════ [B] tg_approval.ts :: handleWebhook consume-scope ═════════
console.log("\n[B] handleWebhook: server-scoped consume при ownBot=true");
{
  const { handleWebhook } = await import("../src/tg_approval.ts");
  const { MockAgent, setGlobalDispatcher } = await import("undici");

  // In-memory TgApprovalStore — тот же атомарный контракт, что store.ts
  // (скопировано из test-tg-approval.mjs's makeTgStore для консистентности).
  function makeTgStore() {
    const approvals = new Map();
    return {
      approvals,
      async createTgApproval(input) {
        approvals.set(input.manifestId, { ...input, status: "PENDING", decidedAt: null });
      },
      async getTgApproval(manifestId, server) {
        const r = approvals.get(manifestId);
        if (!r || r.server !== server) return null;
        return { ...r };
      },
      async consumeTgDecision(manifestId, server, status) {
        const r = approvals.get(manifestId);
        if (!r || r.server !== server || r.status !== "PENDING") return null;
        if (Date.now() >= r.expiresAt) return null;
        r.status = status;
        r.decidedAt = Date.now();
        return { ...r };
      },
      async consumeTgDecisionAnyServer(manifestId, status) {
        const r = approvals.get(manifestId);
        if (!r || r.status !== "PENDING") return null;
        if (Date.now() >= r.expiresAt) return null;
        r.status = status;
        r.decidedAt = Date.now();
        return { ...r };
      },
    };
  }

  function tgCfg(overrides = {}) {
    return {
      enabled: true,
      botToken: "TESTTOKEN",
      ownerChatId: "555",
      webhookSecret: "wh-secret-xyz",
      publicBaseUrl: "https://example.test",
      server: "docs",
      toolsAllowlist: null,
      ttlMs: 3_600_000,
      webhookOwner: false,
      ownBot: false,
      ...overrides,
    };
  }

  const mkUpdate = (manifestId, decision, messageId) => ({
    callback_query: {
      id: `cbq-${manifestId}`,
      from: { id: 555 },
      data: `${decision === "APPROVED" ? "a" : "r"}:${manifestId}`,
      message: { message_id: messageId, chat: { id: "555" } },
    },
  });

  // Мокаем сеть — handleWebhook дергает answerCallbackQuery/editMessageReplyMarkup.
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const pool = agent.get("https://api.telegram.org");
  pool
    .intercept({ path: () => true, method: "POST" })
    .reply(200, { ok: true, result: true })
    .persist();

  // [B1] control: ownBot=false (default/backward-compat) + approval ЧУЖОГО
  // сервера ("calendar") → консюмится через consumeTgDecisionAnyServer, как раньше.
  {
    const store = makeTgStore();
    await store.createTgApproval({
      manifestId: "m-b1", server: "calendar", chatId: "555", messageId: 1,
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    });
    await handleWebhook(tgCfg({ ownBot: false, server: "docs" }), store, mkUpdate("m-b1", "APPROVED", 1));
    check(
      "[B1] ownBot=false: чужая (calendar) approval-строка ВСЁ РАВНО консюмится (старое поведение не сломано)",
      store.approvals.get("m-b1").status === "APPROVED",
      JSON.stringify(store.approvals.get("m-b1")),
    );
  }

  // [B2] ownBot=true + approval СВОЕГО сервера ("docs") → консюмится (happy path).
  {
    const store = makeTgStore();
    await store.createTgApproval({
      manifestId: "m-b2", server: "docs", chatId: "555", messageId: 2,
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    });
    await handleWebhook(tgCfg({ ownBot: true, server: "docs" }), store, mkUpdate("m-b2", "APPROVED", 2));
    check(
      "[B2] ownBot=true: approval СВОЕГО сервера консюмится",
      store.approvals.get("m-b2").status === "APPROVED",
      JSON.stringify(store.approvals.get("m-b2")),
    );
  }

  // [B3] ключевое доказательство: ownBot=true + approval ЧУЖОГО сервера
  // ("calendar") → НЕ консюмится (остаётся PENDING) — доказывает, что вызван
  // именно server-scoped consumeTgDecision(id, cfg.server, …), а не AnyServer.
  {
    const store = makeTgStore();
    await store.createTgApproval({
      manifestId: "m-b3", server: "calendar", chatId: "555", messageId: 3,
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    });
    await handleWebhook(tgCfg({ ownBot: true, server: "docs" }), store, mkUpdate("m-b3", "APPROVED", 3));
    check(
      "[B3] ownBot=true: чужая (calendar) approval-строка НЕ консюмится — осталась PENDING (server-scoped consume)",
      store.approvals.get("m-b3").status === "PENDING",
      JSON.stringify(store.approvals.get("m-b3")),
    );
  }

  // [B4] ownBot=true, REJECTED-ветка тем же способом (своя строка).
  {
    const store = makeTgStore();
    await store.createTgApproval({
      manifestId: "m-b4", server: "docs", chatId: "555", messageId: 4,
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    });
    await handleWebhook(tgCfg({ ownBot: true, server: "docs" }), store, mkUpdate("m-b4", "REJECTED", 4));
    check("[B4] ownBot=true: REJECTED своей строки тоже консюмится", store.approvals.get("m-b4").status === "REJECTED");
  }
}

// ═══════════════════ [C] tg_approval.ts :: registerWebhook gate ═════════════
console.log("\n[C] registerWebhook: ownBot=true регистрирует вебхук БЕЗ TG_WEBHOOK_OWNER");
{
  const { registerWebhook } = await import("../src/tg_approval.ts");
  const { MockAgent, setGlobalDispatcher } = await import("undici");

  function freshMock() {
    const calls = [];
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://api.telegram.org")
      .intercept({ path: "/botTESTTOKEN/setWebhook", method: "POST" })
      .reply(() => {
        calls.push(1);
        return { statusCode: 200, data: { ok: true, result: true }, headers: { "content-type": "application/json" } };
      })
      .persist();
    return calls;
  }

  function tgCfg(overrides = {}) {
    return {
      enabled: true,
      botToken: "TESTTOKEN",
      ownerChatId: "555",
      webhookSecret: "wh-secret-xyz",
      publicBaseUrl: "https://example.test",
      server: "docs",
      toolsAllowlist: null,
      ttlMs: 3_600_000,
      webhookOwner: false,
      ownBot: false,
      ...overrides,
    };
  }

  // [C1] control: ownBot=false, webhookOwner=false (default) → setWebhook НЕ вызывается.
  {
    const calls = freshMock();
    await registerWebhook(tgCfg({ ownBot: false, webhookOwner: false }));
    check("[C1] ownBot=false + webhookOwner=false → setWebhook НЕ вызван (backward-compat)", calls.length === 0, calls.length);
  }

  // [C2] ownBot=true, webhookOwner НЕ задан (false) → setWebhook ВСЁ РАВНО вызывается.
  {
    const calls = freshMock();
    await registerWebhook(tgCfg({ ownBot: true, webhookOwner: false }));
    check("[C2] ownBot=true + webhookOwner=false → setWebhook ВЫЗВАН (свой бот не требует TG_WEBHOOK_OWNER)", calls.length === 1, calls.length);
  }

  // [C3] контроль регресса: webhookOwner=true (общий-бот путь) по-прежнему работает как раньше.
  {
    const calls = freshMock();
    await registerWebhook(tgCfg({ ownBot: false, webhookOwner: true }));
    check("[C3] ownBot=false + webhookOwner=true → setWebhook вызван (общий путь не сломан)", calls.length === 1, calls.length);
  }
}

// ═══════════ [D] http.ts :: route-level gate /tg/webhook (child processes) ═══
// tgApprovalConfig в src/server.ts — модульный синглтон, вычисленный один раз
// из process.env при импорте (см. test-tg-webhook-gate.mjs's doc-comment для
// того же паттерна и того же обоснования) — поэтому каждый сценарий здесь
// получает свой собственный `node`-процесс (worker-ветка в начале файла).
console.log("\n[D] /tg/webhook route gate: TG_BOT_TOKEN_OVERRIDE пускает запрос без TG_WEBHOOK_OWNER");

function spawnScenario(scenario, port, envOverrides) {
  const result = spawnSync(process.execPath, [THIS_FILE], {
    encoding: "utf8",
    env: {
      ...process.env,
      TG_TEST_WORKER: scenario,
      TG_TEST_PORT: String(port),
      TG_APPROVAL_ENABLED: "true",
      TG_BOT_TOKEN: "SHAREDTOKEN",
      TG_OWNER_CHAT_ID: "555",
      TG_APPROVAL_WEBHOOK_SECRET: "wh-secret-xyz",
      PUBLIC_BASE_URL: "https://example.test",
      DATABASE_URL: "",
      TG_WEBHOOK_OWNER: "", // очищено по умолчанию, переопределяется ниже при надобности
      TG_BOT_TOKEN_OVERRIDE: "",
      ...envOverrides,
    },
    timeout: 15_000,
  });
  if (result.status !== 0) {
    console.error(`worker[${scenario}] exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return null;
  }
  const lastLine = result.stdout.trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(lastLine);
  } catch {
    console.error(`worker[${scenario}] did not print JSON. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return null;
  }
}

// [D1] control: TG_BOT_TOKEN_OVERRIDE НЕ задан, TG_WEBHOOK_OWNER не задан
// → 404, handler не вызывается — байт-в-байт старое поведение (то же самое,
// что уже проверяет test-tg-webhook-gate.mjs[a], повторено здесь как часть
// самодостаточного набора own-bot-тестов).
console.log("\n[D1] control: без TG_BOT_TOKEN_OVERRIDE и без TG_WEBHOOK_OWNER → 404 (backward-compat)");
{
  const r = spawnScenario("d1-no-override", 34980, {});
  check("worker завершился и вернул результат", !!r, "worker crashed or printed no JSON");
  if (r) {
    check("статус 404", r.status === 404, r.status);
    check("handleWebhook НЕ вызывался", r.handlerErrorLineCount === 0, r.handlerErrorLineCount);
    check("setWebhook при старте не вызывался", r.setWebhookCalls === 0, r.setWebhookCalls);
  }
}

// [D2] ключевой кейс: TG_BOT_TOKEN_OVERRIDE задан, TG_WEBHOOK_OWNER НЕ задан
// → 200, handler ВЫЗЫВАЕТСЯ («свой вебхук отвечает независимо от webhookOwner»).
console.log("\n[D2] TG_BOT_TOKEN_OVERRIDE задан, TG_WEBHOOK_OWNER не задан → 200, handler вызывается");
{
  const r = spawnScenario("d2-override-no-owner", 34981, { TG_BOT_TOKEN_OVERRIDE: "docs-own-bot-token" });
  check("worker завершился и вернул результат", !!r, "worker crashed or printed no JSON");
  if (r) {
    check("статус 200 (свой бот пускает запрос без TG_WEBHOOK_OWNER)", r.status === 200, r.status);
    check(
      "handleWebhook РЕАЛЬНО вызывался ровно один раз",
      r.handlerErrorLineCount === 1 && r.reachedStoreNotInitialised,
      JSON.stringify(r),
    );
    check("registerWebhook тоже вызвал setWebhook (свой бот регистрирует свой webhook)", r.setWebhookCalls === 1, r.setWebhookCalls);
  }
}

// [D3] TG_BOT_TOKEN_OVERRIDE задан И TG_WEBHOOK_OWNER=true — не должно ломаться
// (оба условия true через ||, результат тот же: 200).
console.log("\n[D3] TG_BOT_TOKEN_OVERRIDE задан И TG_WEBHOOK_OWNER=true → тоже 200 (оба условия не конфликтуют)");
{
  const r = spawnScenario("d3-override-and-owner", 34982, { TG_BOT_TOKEN_OVERRIDE: "docs-own-bot-token", TG_WEBHOOK_OWNER: "true" });
  check("worker завершился и вернул результат", !!r, "worker crashed or printed no JSON");
  if (r) {
    check("статус 200", r.status === 200, r.status);
    check("handleWebhook вызывался", r.handlerErrorLineCount === 1 && r.reachedStoreNotInitialised, JSON.stringify(r));
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
