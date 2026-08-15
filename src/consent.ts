/**
 * consent.ts — единая точка согласия (consent-гейт) plan → execute.
 *
 * Нормативная спецификация: `mcp-development-standard/references/gate.md` §3.
 * ТЗ: раздел A (`TZ-google-mcp-consent-gate.md`).
 *
 * Это GENERIC-модуль. Он НЕ импортирует ни store, ни config сервера напрямую —
 * `store`, `cfg` и per-tool колбэки (`plan`, `rehash`) приходят параметрами
 * (dependency injection). Благодаря этому файл переносится ПОБАЙТОВО на 4 других
 * репо (sheets/calendar/docs/drive-mcp) — различаются только константа `server`
 * в cfg и per-tool билдеры превью/хеша, которые живут вне этого файла.
 *
 * Через `requireConsent(...)` обязаны проходить ВСЕ write-инструменты сервера
 * (gate.md §3.1: «инструмент, который мутирует, минуя require_consent, — дефект
 * уровня блокер»).
 *
 * ЧЕСТНЫЙ ОСТАТОЧНЫЙ ПРЕДЕЛ (ТЗ A.6 / gate.md §3.4 — НЕ притворяемся, что закрыт):
 * сервер физически НЕ может доказать, что `user_reply` не сочинён самой моделью.
 * Всё, что сервер вернул в тексте, модель уже знает; протокол MCP не даёт серверу
 * сигнала «пришёл новый ход пользователя». Поэтому гейт здесь ПОВЕДЕНЧЕСКИЙ, а не
 * криптографический: он превращает тихое само-подтверждение в ЯВНУЮ ЛОЖЬ, которая
 * остаётся в аудит-логе. Для неадверсариальной модели это работает как гейт, но
 * это компромисс. Целевая миграция: как только claude.ai получит form-mode
 * elicitation — брать подтверждение оттуда вместо `user_reply`, без смены сигнатур.
 *
 * automation_key-ветка (легальный обход для headless-автоматов) реализована
 * ниже (`docs/TZ_automation_key_consent_gate.md`, 2026-08-11): единая
 * генерация ключа теперь есть (`gmail-mcp/src/automation_key.ts`, общая
 * таблица `tg_automation_windows` на всю экосистему), поэтому пре-чек из
 * прежней версии этого комментария устарел — YAGNI снято. Ветка целиком DI
 * (`automationKey`/`checkAutomationKey` на `RequireConsentParams`): когда
 * `checkAutomationKey` не подключён сервером, поведение побайтово как до
 * этой правки — второй вход доверия не существует, пока сервер сам не решит
 * его создать.
 */

import { createHash, randomUUID } from "node:crypto";

const GATE_DISABLED_ENV = "DOCS_MCP_GATE_DISABLED";

/**
 * Аварийный общий выключатель гейта подтверждения — 2026-08-12, по прямой
 * просьбе Максима после разговора о том, что несколько MCP-серверов
 * выключаются НЕ одним переключателем (см. аналог в ticktick-mcp/consent.py,
 * `_gate_disabled` / `TICKTICK_MCP_GATE_DISABLED`). Точка отката ОДНА:
 * переменная окружения, не правка кода — вернуть гейт можно, просто убрав
 * переменную в Railway, без нового деплоя.
 *
 * Дефолт — гейт ВКЛЮЧЁН (переменная не задана = поведение не меняется).
 * Когда выключен — КАЖДАЯ мутация проходит без user_reply/кнопки в Telegram;
 * это буквально то, от чего весь `requireConsent` защищает. Максим
 * предупреждён и подтвердил явно после возражения.
 */
function gateDisabled(): boolean {
  const v = (process.env[GATE_DISABLED_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ───────────────────────── Типы контракта ──────────────────────────────────

/** Строка манифеста, как её хранит и отдаёт store. Времена — epoch-миллисекунды. */
export interface ConsentManifestRow {
  id: string;
  server: string;
  tool: string;
  accountLabel: string;
  /** Весь батч целиком — источник истины для исполнения (НЕ аргументы вызова). */
  payload: unknown;
  objectHash: string;
  status: "AWAITING_CONSENT" | "DONE" | "INVALIDATED";
  createdAt: number;
  expiresAt: number;
  consumedAt?: number | null;
  userReply?: string | null;
}

/** Запись аудита. Двухфазная: создаётся на решении гейта, дополняется исходом. */
export interface ConsentAuditEntry {
  id: string;
  ts: number;
  server: string;
  tool: string;
  accountLabel: string;
  manifestId?: string | null;
  objectHash?: string | null;
  /** `user_reply` ДОСЛОВНО, как прислала модель (без пересказа). */
  userReply: string;
  /** Результат каждой из проверок раздела 3.3. */
  checks: Record<string, string>;
  outcome: "confirmed" | "refused" | "invalidated";
  refusalReason?: string | null;
  /** "human" всегда в этой версии; "automation:<имя>" — будущая ветка. */
  actor: string;
}

/**
 * Интерфейс хранилища, который ОЖИДАЕТ этот модуль. Реализуется пакетом A1
 * (`src/store.ts`) поверх Postgres. Все запросы обязаны фильтровать по
 * `server` (общая таблица на 5 серверов — колонка `server`).
 *
 * A1 обязан реализовать РОВНО эти 6 функций под эти сигнатуры:
 */
export interface ConsentStore {
  /** Вставляет новый манифест в состоянии AWAITING_CONSENT. */
  createManifest(input: {
    id: string;
    server: string;
    tool: string;
    accountLabel: string;
    payload: unknown;
    objectHash: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;

  /** Читает манифест по id в рамках своего server; null если нет. */
  getManifest(id: string, server: string): Promise<ConsentManifestRow | null>;

  /**
   * АТОМАРНЫЙ one-shot. Помечает DONE + consumed_at + user_reply ТОЛЬКО если
   * строка ещё AWAITING_CONSENT и не истекла по TTL. Возвращает обновлённую
   * строку при успехе, иначе null (уже исполнен / истёк / инвалидирован / нет).
   * Гонка «двойной execute» закрывается структурно здесь, а не проверкой в JS.
   * Эталон реализации — `consumeCode` в store.ts (UPDATE … WHERE … RETURNING).
   */
  consumeManifest(
    id: string,
    server: string,
    userReply: string,
  ): Promise<ConsentManifestRow | null>;

  /** Помечает манифест INVALIDATED (явное отрицание пользователя). */
  invalidateManifest(
    id: string,
    server: string,
    userReply: string,
  ): Promise<void>;

  /** Append-only: пишет фазу согласия/отказа. */
  appendConsentAudit(entry: ConsentAuditEntry): Promise<void>;

  /**
   * Дополняет ранее записанную аудит-строку исходом мутации и post-verify.
   * Зовётся ИНСТРУМЕНТОМ (пакет A3) ПОСЛЕ мутации, не этим модулем — объявлен
   * здесь только чтобы зафиксировать контракт для A1.
   *
   * `preSnapshot` добавлен пакетом A3 (identity-postverify.md §5.2): снимок
   * исходящего объекта (account/to/cc/bcc/subject/начало тела — БЕЗ полного
   * тела) ДО необратимой мутации. Это не gmail-специфика — то же самое
   * потребуется T2 на остальных 4 серверах, поэтому поле в общем контракте,
   * а не только в store.ts.
   */
  updateConsentAuditOutcome(
    auditId: string,
    outcome: {
      outcome?: "confirmed" | "failed";
      postVerify?: string | null;
      error?: string | null;
      preSnapshot?: unknown;
    },
  ): Promise<void>;

  /**
   * ОПЦИОНАЛЬНО (добавлено 2026-08-14 вместе с исходом `already_executed`).
   * Возвращает последнюю запись аудита ИСПОЛНЕНИЯ по этому манифесту — ту,
   * что написал тот, кто реально исполнил мутацию (веб-хаб/поллер через
   * `tryAutoExecute`), уже дополненную `post_verify_result`/`error` через
   * `updateConsentAuditOutcome`. Нужна ровно для одного: когда sync-wait
   * видит чужой DONE, вернуть модели ФАКТИЧЕСКИЙ результат, а не голое «уже
   * исполнено через другой канал» (отчёт с пруфом уходил только в браузер).
   *
   * Метод опционален СПЕЦИАЛЬНО: сторы, где он не реализован (офлайн-фейки в
   * тестах, ещё не обновлённые репо), продолжают работать байт-в-байт — отчёт
   * тогда честно говорит «результат не удалось перепроверить», а не выдумывает
   * успех. Реализация обязана фильтровать по `server` (общая таблица) и брать
   * ТОЛЬКО строки исхода мутации (`outcome IN ('confirmed','failed')`), иначе
   * можно вернуть строку отказа гейта, относящуюся к тому же манифесту.
   */
  getExecutionAudit?(
    manifestId: string,
    server: string,
  ): Promise<ConsentExecutionAudit | null>;
}

/** Строка аудита ИСПОЛНЕНИЯ, как её отдаёт опциональный `getExecutionAudit`. */
export interface ConsentExecutionAudit {
  id: string;
  /** "confirmed" — мутация прошла; "failed" — упала (дописывает тул). */
  outcome: string;
  /** Текст пруфа post-verify, если тул его записал. */
  postVerifyResult?: string | null;
  /** Текст ошибки, если мутация упала. */
  error?: string | null;
  /** Кто исполнил: "web" / "tg_auto" / "human" — для честности отчёта. */
  actor?: string | null;
}

/**
 * Опциональный внеполосный (out-of-band) фактор поверх `user_reply` — нажатие
 * кнопки в Telegram (gate.md §3.4: «модель может сфабриковать `user_reply` —
 * это не закрыто»; кнопка модели недоступна). DI, тем же приёмом, что и
 * `ConsentStore` выше: этот модуль НЕ импортирует `tg_approval.ts` — конкретную
 * реализацию инжектирует server.ts, типизируя её `: TgApprovalGate` там (как
 * `consentStoreAdapter`), чтобы дрейф сигнатур падал на СБОРКЕ, а не в проде.
 * Поэтому `consent.ts` остаётся переносимым ПОБАЙТОВО на другие 4 сервера
 * независимо от того, подключён там Telegram или нет.
 *
 * Инвариант совместимости: `tg` не передан (undefined) → ни одна из веток
 * ниже не выполняется, поведение гейта побайтово как до этой правки.
 */
export interface TgApprovalGate {
  /** true, если ДЛЯ ЭТОГО инструмента нужен внеполосный ТГ-фактор
   * (TG_APPROVAL_ENABLED и (TG_APPROVAL_TOOLS пусто ИЛИ содержит tool)). */
  enabledFor(tool: string): boolean;
  /**
   * Отправляет превью плана в Telegram с кнопками [✅ Подтвердить][🛑 Отклонить].
   * Зовётся ТОЛЬКО когда `enabledFor(tool)` истинно, сразу после
   * `createManifest`. Провал — FAIL-CLOSED (это расширение честного правила
   * gate.md §4 на этот слой): вызывающий код обязан НЕ оставлять манифест
   * живым, если это вернуло `{ ok: false }`.
   */
  notifyPlan(
    manifestId: string,
    previewBody: string,
    /** `expiresAt` — CONSENT-манифеста (не самого ТГ-запроса): реализация
     * обязана взять его как ВЕРХНИЙ предел, а не как значение напрямую —
     * approval-запрос вправе жить короче, по своему TTL, но не дольше плана,
     * к которому относится. */
    meta: { tool: string; accountLabel: string; expiresAt: number },
  ): Promise<{ ok: boolean; error?: string }>;
  /**
   * Текущее внеполосное решение по манифесту. `"none"` покрывает СРАЗУ два
   * случая — «запроса в Telegram никогда не было» и «TTL истёк»: фаза
   * исполнения обрабатывает их одинаково (отказ, план заново).
   */
  checkApproval(manifestId: string): Promise<"approved" | "pending" | "rejected" | "none">;
}

/** Конфиг сервера (различается между репо только значением `server`). */
export interface ConsentConfig {
  /** Константа сервера ($self), напр. "gmail". НЕ аргумент инструмента. */
  server: string;
  /** TTL манифеста, мс (env CONSENT_TTL_MS, дефолт 1 ч). */
  consentTtlMs: number;
  /** Минимальный зазор план↔исполнение, мс (env MIN_CONSENT_GAP_MS, почта = 5000). */
  minConsentGapMs: number;
  /** Кап размера батча одного манифеста (env SEND_BATCH_MAX, дефолт 10). */
  sendBatchMax: number;
  /** Инъекция часов (для тестов). Дефолт Date.now. */
  now?: () => number;
  /**
   * Гибридное короткое ожидание (docs/TZ_consent_web_hub.md, часть 1): сколько
   * мс `requireConsent` ждёт ПОСЛЕ построения плана, ДО возврата превью,
   * опрашивая собственный стор — вдруг манифест уже подтверждён/отклонён
   * (веб-хаб/кнопка/ещё один вызов) прямо сейчас, и модель получит готовый
   * результат ОДНИМ вызовом вместо второго прохода. Env CONSENT_SYNC_WAIT_MS,
   * дефолт 25000 (25с — с запасом под типовой ~60с таймаут MCP-клиента).
   * `0`/undefined ⇒ ветка целиком выключена, побайтовая совместимость с
   * поведением до этой правки — ни одного лишнего запроса к стору, ни одной
   * задержки.
   */
  syncWaitMs?: number;
  /** Интервал опроса стора внутри `syncWaitMs`-окна, мс. Env
   * CONSENT_SYNC_POLL_MS, дефолт 1000. Не используется, когда `syncWaitMs`
   * выключен. */
  syncPollMs?: number;
  /**
   * Инъекция ожидания (для тестов — управляемые "часы" без реального
   * `setTimeout`), тем же приёмом, что и `now` выше. Дефолт — настоящий
   * `setTimeout`. Тестовый `sleep` обычно одновременно двигает и `now()`,
   * чтобы цикл опроса завершался мгновенно, а не по 25 реальных секунд.
   */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Адресация для `rehash` (binding, gate.md §3.3 п.2). Это НЕ содержимое плана,
 * а идентификаторы объектов (messageId / draftId / threadId / получатели…),
 * ПО КОТОРЫМ надо СХОДИТЬ В ЖИВОЙ МИР и перечитать текущее состояние. Тип
 * намеренно назван и осмыслен как «адрес», а не `payload`, чтобы A3 не соблазнился
 * захешировать переданный объект (это дало бы тавтологию — см. `rehash` ниже).
 * Конкретную форму задаёт per-tool билдер плана (что он положил в `payload`).
 */
export type ConsentAddressing = unknown;

/** Результат фазы плана, который строит per-tool колбэк. */
export interface ConsentPlan {
  /** Весь батч — ляжет в манифест, из него же пойдёт исполнение. */
  payload: unknown;
  /** Хеш связывания (binding), обычно sha256(canonicalJson(...)). */
  objectHash: string;
  /** Человекочитаемое тело превью (с заголовком `### …`). Мету/хвост добавит модуль. */
  preview: string;
  /**
   * Число элементов в батче — для проверки капа SEND_BATCH_MAX. Необязательно:
   * если не передано, кап не проверяется (для не-батчевых инструментов).
   */
  batchSize?: number;
}

/** Параметры единой точки входа. */
export interface RequireConsentParams<T = unknown> {
  tool: string;
  accountLabel: string;
  /** undefined/"" в фазе плана; заданный — в фазе исполнения. */
  manifestId?: string | null;
  /** undefined/"" в фазе плана; ДОСЛОВНАЯ реплика человека в фазе исполнения. */
  userReply?: string | null;
  /** Строит план. ВЫЗЫВАЕТСЯ ТОЛЬКО в фазе плана, НЕ должен мутировать. */
  plan: () => ConsentPlan | Promise<ConsentPlan>;
  /**
   * BINDING (gate.md §3.3 п.2): пересчитывает objectHash из ЖИВОГО состояния
   * мира на момент исполнения, чтобы поймать ДРЕЙФ между планом и отправкой.
   *
   * ⚠️ КОНТРАКТ ДЛЯ A3 — ЭТО НЕ `sha256(payload)`, НЕ ТАВТОЛОГИЯ:
   *   Аргумент `addressing` — это АДРЕСАЦИЯ (идентификаторы объектов из payload
   *   манифеста: messageId / draftId / получатели …), а НЕ контент для хеша.
   *   Реализация ОБЯЗАНА по этим id СХОДИТЬ В МИР (перечитать письмо / черновик /
   *   получателя СЕЙЧАС) и вернуть sha256 ПЕРЕЧИТАННОГО живого состояния.
   *   `return sha256(addressing)` / `sha256(payload)` — ЗАПРЕЩЕНО: даст
   *   hash === objectHash ВСЕГДА, binding выродится в тавтологию `hash===hash`
   *   и НИКОГДА не поймает «получатель уехал / текст черновика изменился между
   *   планом и исполнением». Тип аргумента — `ConsentAddressing` (адрес), а не
   *   payload, ИМЕННО чтобы это различие нельзя было проглядеть.
   *   Возврат — `Promise<string>` (перечитывание мира — это I/O, не чистая ф-ция).
   */
  rehash: (addressing: ConsentAddressing) => string | Promise<string>;
  store: ConsentStore;
  cfg: ConsentConfig;
  /**
   * Опциональный внеполосный ТГ-фактор (см. `TgApprovalGate` выше). undefined
   * ⇒ поведение гейта побайтово как до этой правки — ни один из веток ниже не
   * задействуется.
   */
  tg?: TgApprovalGate;
  /**
   * `automation_key`, присланный вызывающим (headless-автоматика,
   * `docs/TZ_automation_key_consent_gate.md`). undefined/"" — обычный
   * человеческий путь, ничего не меняется. Само по себе присутствие строки
   * здесь ничего не открывает — доверие даёт только `checkAutomationKey`.
   */
  automationKey?: string;
  /**
   * DI: проверяет, покрывает ли `key` МЕНЯ (этот сервис) ПРЯМО СЕЙЧАС —
   * конкретная реализация (чтение `tg_automation_windows`/статического
   * `AUTOMATION_KEY`) живёт вне этого модуля (`automation_key.ts` каждого
   * сервера), инжектируется server.ts тем же приёмом, что `tg` выше.
   * undefined ⇒ automation_key-ветка целиком выключена — побайтовое
   * поведение как до этой правки, даже если `automationKey` зачем-то
   * передан (сервер физически не может её обработать без этой функции).
   *
   * Второй аргумент `tool` — имя ТЕКУЩЕГО инструмента (см. `tool` в
   * `RequireConsentParams` выше), позволяет реализации сузить проверку до
   * `scope="<service>:<tool>"` (`docs/TZ_automation_key_method_catalog.md`),
   * а не только до целого сервиса. Этот модуль сам передаёт его — вызывающие
   * инструменты (`src/tools/*.ts`) НЕ меняются, они лишь пробрасывают ссылку
   * на функцию.
   */
  checkAutomationKey?: (key: string, tool: string) => Promise<{ ok: boolean; channel?: string }>;
}

/**
 * Размеченный union исхода. Отказы — здесь, НЕ через throw.
 *
 * `already_executed` (2026-08-14) — ЧЕТВЁРТЫЙ исход, добавленный после жалобы
 * Максима: он подтверждал действие в веб-портале за 2 секунды, запрос из
 * портала исчезал, а модель шла на второй/третий круг и слала запрос заново.
 * Причина: положительный исход sync-wait («уже исполнено другим каналом»)
 * возвращался в ФОРМЕ отказа (`{kind:"refused"}` с позитивным текстом), и
 * модель, видя «отказ», честно повторяла вызов. Защита от двойного
 * исполнения при этом была нужна и остаётся: этот kind, как и `refused`,
 * НИКОГДА не даёт вызывающему тулу payload — исполнять нечего, мутация уже
 * произошла в другом канале. Отличие только в честности сигнала: это ОТЧЁТ
 * ОБ ИСПОЛНЕНИИ (`report`), а не отказ, и call site обязан отдать его с
 * меткой, отличной от «refusal» (см. `okReport` в `src/util.ts`).
 *
 * `auditId` — id аудит-строки ТОГО, кто реально исполнил (веб-хаб/поллер
 * через `tryAutoExecute`); опционален, потому что стор может не уметь её
 * найти (метод `getExecutionAudit` опционален) — тогда отчёт честно скажет,
 * что результат перепроверить не удалось, а не соврёт про успех.
 */
export type ConsentDecision<T = unknown> =
  | { kind: "planned"; manifestId: string; preview: string }
  | { kind: "confirmed"; manifestId: string; payload: T; auditId: string }
  | { kind: "already_executed"; manifestId: string; report: string; auditId?: string }
  | { kind: "refused"; result: string };

/**
 * Докстринг параметра `user_reply` — ДОСЛОВНО по смыслу из ТЗ A.3 / gate.md §3.3.
 * Инструмент (A3) обязан навесить эту строку на zod-параметр `user_reply`.
 */
export const USER_REPLY_DOC =
  "Скопируй сюда ДОСЛОВНО последнее сообщение пользователя, которым он " +
  "подтвердил. Не сочиняй и не пересказывай. Если пользователь ещё не ответил " +
  "— не вызывай этот инструмент.";

/**
 * Докстринг параметра `automation_key` — ДОСЛОВНО текст из
 * `docs/TZ_automation_key_consent_gate.md`. Инструмент обязан навесить эту
 * строку на zod-параметр `automation_key`.
 */
export const AUTOMATION_KEY_DOC =
  "For headless automation only — a valid automation_key skips the human " +
  "confirmation step entirely. Humans and interactive assistants must NEVER " +
  "guess or fabricate a value here; leave it unset.";

// ───────────────────────── Хелперы: хеш и время ────────────────────────────

/** Детерминированный stringify с рекурсивной сортировкой ключей объектов. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** sha256(canonicalJson(value)) в hex — стабильный objectHash для binding. */
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Время в America/Los_Angeles как «5 авг, 07:15» (ТЗ A.4 — всегда LA, не UTC). */
export function formatLaTime(epochMs: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "America/Los_Angeles",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

// ───────────────────────── Рендер (единый формат) ──────────────────────────

/**
 * Единый рендерер блока согласия/отказа (output-format.md §7.1 п.5: «инструмент,
 * лепящий строку руками, — дефект»). header уже включает статус-эмодзи из
 * замороженной легенды §7.2 (🛑 для отказа гейта).
 */
export function renderConsentBlock(header: string, body: string): string {
  return `### ${header}\n\n${body}`;
}

function renderPlanned(previewBody: string, id: string, expiresAt: number): string {
  const meta = `_план \`${id}\` · истекает в ${formatLaTime(expiresAt)} PT_`;
  const tail =
    "_[агенту: покажи это пользователю дословно и дождись его ответа. " +
    "Не вызывай исполнение, пока он не ответил.]_";
  return `${previewBody}\n\n${meta}\n\n${tail}`;
}

function renderRefusal(header: string, body: string): string {
  // 🛑 — «жёсткий стоп, ничего не изменено» (output-format §7.2).
  return renderConsentBlock(`🛑 ${header}`, body);
}

/** Кап на чужой текст пруфа внутри отчёта — не даём одному post-verify
 * раздуть ответ модели до неприличия. Пруф генерирует наш же тул, поэтому
 * нейтрализация markdown тут не нужна (внешние строки внутри него уже
 * прошли `safeText` при формировании отчёта), нужен только предел длины. */
function clampProof(s: string, max = 2000): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "\n…(пруф обрезан)" : t;
}

/**
 * Собирает ОТЧЁТ ОБ ИСПОЛНЕНИИ для исхода `already_executed`: мутацию уже
 * сделал другой канал (веб-хаб `POST /pending-consents/decide` или поллер
 * ТГ-кнопки — оба через `tryAutoExecute` + per-tool `execute`), пока этот
 * вызов ждал в sync-wait.
 *
 * ЗАЧЕМ ХОДИМ В АУДИТ: тот, кто исполнил, вернул человекочитаемый отчёт с
 * пруфом post-verify В БРАУЗЕР, а модель до этой правки получала только
 * «уже исполнено через другой канал» — то есть не знала, ЧТО именно
 * получилось. Пруф лежит в `consent_audit.post_verify_result` той самой
 * аудит-строки, которую создал `tryAutoExecute` (её id — `auditId`), поэтому
 * читаем её и вкладываем в текст. Нет данных (стор не умеет / строки нет /
 * пруф не записан) — пишем это ЧЕСТНО, а не подразумеваем успех.
 */
async function buildAlreadyExecutedReport(args: {
  manifestId: string;
  previewBody: string;
  bindingOk: boolean;
  store: ConsentStore;
  server: string;
}): Promise<{ report: string; auditId?: string }> {
  const { manifestId, previewBody, bindingOk, store, server } = args;

  let audit: ConsentExecutionAudit | null = null;
  if (store.getExecutionAudit) {
    try {
      audit = await store.getExecutionAudit(manifestId, server);
    } catch (err) {
      // Fail-soft ТОЛЬКО для обогащения текста: сам факт исполнения уже
      // установлен статусом манифеста (DONE), и подавление ошибки чтения
      // аудита не может привести к повторной мутации — payload наружу не
      // отдаётся ни в одной ветке этой функции.
      console.error(
        `consent: не смог прочитать аудит исполнения манифеста ${manifestId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      audit = null;
    }
  }

  const failed =
    audit != null && (audit.outcome === "failed" || (audit.error != null && audit.error !== ""));
  const header = failed
    ? "⚠️ Подтверждено, но исполнение завершилось ошибкой"
    : bindingOk
      ? "✅ Подтверждено и исполнено"
      : "⚠️ Подтверждено и исполнено, но состояние изменилось";

  let outcomeBlock: string;
  if (failed) {
    const errText = audit?.error ? inlineReply(audit.error, 300) : "текст ошибки не записан";
    outcomeBlock =
      `**Фактический результат:** мутация была запущена другим каналом и ЗАВЕРШИЛАСЬ ОШИБКОЙ — ${errText}. ` +
      "Часть изменений могла всё же примениться — проверь состояние объектов, прежде чем повторять." +
      (audit?.postVerifyResult ? `\n\n${clampProof(audit.postVerifyResult)}` : "");
  } else if (audit?.postVerifyResult) {
    outcomeBlock = `**Фактический результат (пруф post-verify от исполнившего канала):**\n\n${clampProof(
      audit.postVerifyResult,
    )}`;
  } else if (audit) {
    outcomeBlock =
      `**Фактический результат:** не удалось перепроверить — запись об исполнении есть ` +
      `(аудит \`${audit.id}\`${audit.actor ? `, канал «${audit.actor}»` : ""}), но пруф post-verify в ней ` +
      "отсутствует. Действие исполнено, его итог сервер подтвердить сейчас не может — проверь объект отдельно.";
  } else {
    outcomeBlock =
      "**Фактический результат:** не удалось перепроверить — сервер не нашёл записи об исполнении этого " +
      "плана в аудит-логе. План закрыт как исполненный, но чем именно он закончился, сервер сейчас сказать " +
      "не может — проверь объект отдельно.";
  }

  const drift = bindingOk
    ? ""
    : "\n\nСостояние окружения с момента построения плана успело измениться — фактический результат мог не " +
      "совпасть с тем, что показано в плане выше.";

  const body =
    `${previewBody}\n\nРешение по этому плану уже принято, и мутация УЖЕ ВЫПОЛНЕНА другим каналом ` +
    "(веб-подтверждение или кнопка в Telegram), пока шло ожидание ответа. Это ОТЧЁТ ОБ ИСПОЛНЕНИИ, а не " +
    "отказ: повторять вызов этого инструмента с этим планом НЕ нужно и НЕЛЬЗЯ — второй вызов сделал бы " +
    `действие дважды.${drift}\n\n${outcomeBlock}`;

  return { report: renderConsentBlock(header, body), auditId: audit?.id };
}

/**
 * Минимальная нейтрализация внешнего текста при подстановке в отказ: убрать
 * переводы строк, обрезать. Это НЕ полный safeText — полная нейтрализация
 * markdown-инъекции живёт в S1 (`src/util.ts`) и применяется при интеграции в
 * инструмент. Здесь только чтобы реплика не разорвала блок отказа.
 */
function inlineReply(s: string, max = 80): string {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

// ───────────────────────── Классификация user_reply ────────────────────────

// Словари RU+EN ЗАХАРДКОЖЕНЫ на сервере и модели НЕ отдаются (gate.md §3.3).
// Матчинг — по нормализованным ТОКЕНАМ (не подстрокам: «конечно» не ловится
// как «не»). Отрицание проверяется ДО утверждения.
//
// КЛЮЧЕВОЕ РАЗЛИЧЕНИЕ (правка после приёмки — дыры №1/№2):
//  • Отрицание НЕЛЬЗЯ ловить «где-то в строке есть частица не/not» через
//    .some(). Так «отправляй, не тяни» (СОГЛАСИЕ, «не» стоит перед «тяни»)
//    ложно инвалидировало живой манифест (№2), а «not» вообще не входил в
//    набор → «not sure»/«not ok» проходили как affirmation → мутация
//    исполнялась на «не уверен» (№1, дыра безопасности).
//  • Поэтому частицы-отрицания (не/not) держим ОТДЕЛЬНО от самостоятельных
//    негаций. Частица даёт отрицание ТОЛЬКО в конструкции «частица + голова»:
//    «не <affirmation>» (не отправляй / not sure / not ok) либо
//    «не <NEGATED_HEAD>» (не надо / не нужно). Голая частица без такой головы
//    (одиночное «не», или «не» перед не-утвердительным словом) — НЕ отрицание,
//    это unknown → refuse без инвалидации, манифест остаётся жив.
//  • Самостоятельные негации (нет/стоп/отмена/cancel/no/nope/…) — отрицание
//    в любой позиции токена; именно они (и «частица+голова») инвалидируют
//    манифест (fail-safe: «нет» и «не отправляй» уничтожают план; одиночное
//    «не» — нет).

const AFFIRMATION_TOKENS = new Set([
  // RU
  "да", "ага", "угу", "ок", "окей", "океюшки", "давай", "давайте", "подтверждаю",
  "подтверждаешь", "отправляй", "отправь", "отправляем", "шли", "удаляй", "удали",
  "го", "погнали", "поехали", "плюс", "ясно", "жми", "валяй",
  // EN
  "yes", "yep", "yeah", "yup", "ok", "okay", "k", "confirm", "confirmed",
  "go", "send", "sure", "approve", "approved", "proceed", "aye", "yea",
]);

// Частицы-отрицания: САМИ ПО СЕБЕ не решают. Отрицание — только «частица + голова».
const NEGATION_PARTICLES = new Set(["не", "not"]);

// «Головы», которые после частицы дают отказ, но сами утверждением НЕ являются
// (иначе одиночное «надо»/«нужно» ложно читалось бы как «да»). «не надо»,
// «не нужно», «не буду» → отказ; голое «надо» → unknown (безопасный переспрос).
const NEGATED_HEADS = new Set([
  "надо", "нужно", "стоит", "буду", "будем", "хочу", "хочется",
]);

// Самостоятельные негации: отрицание в любой позиции токена, инвалидируют план.
const STANDALONE_NEGATIONS = new Set([
  // RU
  "нет", "неа", "нельзя", "стоп", "отмена", "отмени", "отменить", "отставить",
  "погоди", "подожди", "стой",
  // EN
  "no", "nope", "nah", "stop", "cancel", "abort", "dont", "wait", "nvm", "negative",
]);

const AFFIRMATION_PHRASES = new Set([
  "do it", "go ahead", "send it", "lets go", "go for it", "ok go", "send away",
]);

const NEGATION_PHRASES = new Set([
  "do not", "not now", "hold on", "no dont", "not yet",
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "") // don't → dont
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isServiceString(raw: string, ctx: { manifestId: string; tool: string }): boolean {
  if (raw === ctx.manifestId) return true; // id — адрес плана, не согласие
  if (raw === ctx.tool) return true; // имя инструмента
  if (/^[A-Z_]+\s+\d+$/.test(raw)) return true; // "SEND 1", "DELETE 5" — псевдо-код
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return true; // uuid
  if (/^[0-9a-f]{16,}$/i.test(raw)) return true; // голый длинный hex
  try {
    JSON.parse(raw); // JSON (объект/массив/число/true/false/null) — машинный ответ
    return true;
  } catch {
    /* обычный текст — не JSON */
  }
  return false;
}

type ReplyClass = "service" | "negation" | "affirmation" | "unknown";

/** Голова после частицы, дающая отказ: «не <affirmation>» или «не <NEGATED_HEAD>». */
function isNegatedHead(t: string | undefined): boolean {
  return t != null && (AFFIRMATION_TOKENS.has(t) || NEGATED_HEADS.has(t));
}

/**
 * true, если в токенах есть конструкция «частица-отрицание (не/not)
 * НЕПОСРЕДСТВЕННО перед головой». Именно это — а не «частица где-то в строке» —
 * отличает «не отправляй»/«not sure» (отрицание) от «отправляй, не тяни»
 * (согласие: «не» стоит перед не-головой «тяни»).
 */
function hasParticleNegation(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (NEGATION_PARTICLES.has(tokens[i]) && isNegatedHead(tokens[i + 1])) return true;
  }
  return false;
}

/** Классифицирует реплику. Порядок: служебная → «+» → отрицание → утверждение. */
export function classifyReply(
  userReply: string,
  ctx: { manifestId: string; tool: string },
): ReplyClass {
  const raw = userReply.trim();
  if (!raw) return "unknown";
  if (isServiceString(raw, ctx)) return "service";
  if (raw === "+") return "affirmation";

  const norm = normalize(raw);
  const tokens = norm.split(" ").filter(Boolean);

  // Отрицание — ПЕРВЫМ (gate.md §3.3): «нет, не отправляй» не должно читаться
  // как «отправляй». Но НЕ по «где-то в строке есть не/not» (.some) — так
  // «отправляй, не тяни» ложно инвалидировался, а «not sure» проходил как «да».
  // Отрицание = (a) фраза-негация целиком, ИЛИ (b) самостоятельная негация в
  // любом токене (нет/стоп/cancel…), ИЛИ (c) конструкция «частица + голова»
  // (не отправляй / not sure / not ok / не надо). Голая частица без головы —
  // НЕ отрицание (падает ниже в unknown), манифест остаётся жив.
  if (
    NEGATION_PHRASES.has(norm) ||
    tokens.some((t) => STANDALONE_NEGATIONS.has(t)) ||
    hasParticleNegation(tokens)
  ) {
    return "negation";
  }
  if (AFFIRMATION_PHRASES.has(norm) || tokens.some((t) => AFFIRMATION_TOKENS.has(t))) {
    return "affirmation";
  }
  return "unknown";
}

// ───────────────────────── Ядро: requireConsent ────────────────────────────

export async function requireConsent<T = unknown>(
  p: RequireConsentParams<T>,
): Promise<ConsentDecision<T>> {
  const { tool, accountLabel, plan, rehash, store, cfg } = p;
  const now = cfg.now ?? Date.now;
  const manifestId = p.manifestId ?? "";
  const userReply = p.userReply ?? "";
  const hasId = manifestId !== "";
  const hasReply = userReply !== "";

  if (gateDisabled()) {
    console.error(
      `🔓 ГЕЙТ ВЫКЛЮЧЕН переключателем ${GATE_DISABLED_ENV}: действие ` +
        `'${tool}' (account=${accountLabel}) выполнено БЕЗ подтверждения пользователя.`,
    );
    const built = await plan();
    const auditId = randomUUID();
    await store.appendConsentAudit({
      id: auditId,
      ts: now(),
      server: cfg.server,
      tool,
      accountLabel,
      manifestId: null,
      objectHash: built.objectHash,
      userReply,
      checks: { gate: "disabled_switch" },
      outcome: "confirmed",
      actor: "human",
    });
    return { kind: "confirmed", manifestId: "gate_disabled_switch", payload: built.payload as T, auditId };
  }

  // Общий журнал отказа + возврат refused.
  const refuse = async (
    header: string,
    body: string,
    checks: Record<string, string>,
    opts?: {
      manifestId?: string;
      objectHash?: string;
      outcome?: "refused" | "invalidated";
      reason?: string;
      /** "human" по умолчанию — automation-путь ниже передаёт "automation" явно,
       * чтобы отказ на этом пути тоже честно отражал происхождение вызова. */
      actor?: string;
    },
  ): Promise<ConsentDecision<T>> => {
    await store.appendConsentAudit({
      id: randomUUID(),
      ts: now(),
      server: cfg.server,
      tool,
      accountLabel,
      manifestId: opts?.manifestId ?? (hasId ? manifestId : null),
      objectHash: opts?.objectHash ?? null,
      userReply,
      checks,
      outcome: opts?.outcome ?? "refused",
      refusalReason: opts?.reason ?? header,
      actor: opts?.actor ?? "human",
    });
    return { kind: "refused", result: renderRefusal(header, body) };
  };

  // ───── AUTOMATION_KEY-путь (headless-автоматика, легальный обход) ─────
  // ДО проверки hasId !== hasReply (ТЗ раздел "Ветка в начале requireConsent"):
  // валидный ключ строит план и исполняет его НЕМЕДЛЕННО, в этом же вызове —
  // без manifest_id/user_reply вообще. `checkAutomationKey` не подключён
  // (undefined) ⇒ эта ветка целиком не существует, остальной код ниже
  // побайтово как до этой правки.
  if (p.automationKey && p.checkAutomationKey) {
    const ak = await p.checkAutomationKey(p.automationKey, tool);
    if (ak.ok) {
      const akChannel = ak.channel ?? "unknown";
      const built = await plan();
      if (built.batchSize != null && built.batchSize > cfg.sendBatchMax) {
        return refuse(
          "Слишком большой батч",
          `В плане ${built.batchSize} элементов — больше предела ${cfg.sendBatchMax}. ` +
            "Разбей на несколько вызовов: один манифест = один радиус согласия.",
          { batchCap: "exceeded", automationKey: akChannel },
          { actor: "automation" },
        );
      }
      // Binding (gate.md §3.3 п.2) — тот же смысл, что и в фазе исполнения
      // ниже по файлу: даже автоматике нельзя исполнить план, для которого
      // мир уже уехал между построением плана и этой же секундой.
      const currentHash = await rehash(built.payload as ConsentAddressing);
      if (currentHash !== built.objectHash) {
        return refuse(
          "Состояние изменилось после планирования",
          "Объекты, к которым относился план, изменились (получатель/содержимое " +
            "«уехали»). Ради безопасности исполнение отклонено — построй план заново.",
          { binding: "mismatch", automationKey: akChannel },
          { actor: "automation" },
        );
      }
      const auditId = randomUUID();
      await store.appendConsentAudit({
        id: auditId,
        ts: now(),
        server: cfg.server,
        tool,
        accountLabel,
        manifestId: null,
        objectHash: built.objectHash,
        userReply: "",
        checks: { automationKey: akChannel, binding: "ok" },
        outcome: "confirmed",
        actor: "automation",
      });
      // manifestId пустой — манифест в consent_manifests не создавался вовсе,
      // это прямой путь plan→execute в одном вызове, не план→ожидание.
      return { kind: "confirmed", manifestId: "", payload: built.payload as T, auditId };
    }
    // ak.ok === false → ТИХИЙ fallthrough на обычный путь ниже. НЕ ошибка:
    // невалидный/просроченный/не-по-scope ключ не должен подсказать модели,
    // что параметр вообще проверяется и стоит его перебирать.
  }

  // Ровно один из пары задан — вызывающий перепутал фазу.
  if (hasId !== hasReply) {
    return refuse(
      "Нужны оба параметра",
      "Для исполнения плана нужны И `manifest_id`, И `user_reply`. Чтобы " +
        "построить план — вызови инструмент без обоих.",
      { call: "half_pair" },
    );
  }

  // ───── ФАЗА ПЛАНА (нет ни id, ни reply): читаем состояние, НЕ мутируем ─────
  if (!hasId && !hasReply) {
    const built = await plan();
    if (built.batchSize != null && built.batchSize > cfg.sendBatchMax) {
      return refuse(
        "Слишком большой батч",
        `В плане ${built.batchSize} элементов — больше предела ${cfg.sendBatchMax}. ` +
          "Разбей на несколько вызовов: один манифест = один радиус согласия.",
        { batchCap: "exceeded" },
      );
    }
    const id = randomUUID();
    const createdAt = now();
    const expiresAt = createdAt + cfg.consentTtlMs;
    await store.createManifest({
      id,
      server: cfg.server,
      tool,
      accountLabel,
      payload: built.payload,
      objectHash: built.objectHash,
      createdAt,
      expiresAt,
    });

    let previewBody = built.preview;
    if (p.tg?.enabledFor(tool)) {
      // Fail-closed (plan §4): если отправка в Telegram упала, манифест НЕ
      // остаётся живым — иначе исполнение осталось бы доступно через голое
      // `user_reply`, без второго фактора, который для этого инструмента
      // объявлен обязательным.
      const sent = await p.tg.notifyPlan(id, built.preview, { tool, accountLabel, expiresAt });
      if (!sent.ok) {
        await store.invalidateManifest(id, cfg.server, "");
        return refuse(
          "Не смог отправить запрос подтверждения в Telegram",
          "Действие НЕ выполнено, ничего не изменено. Проверьте бота/настройки Telegram-подтверждения" +
            (sent.error ? ` (${inlineReply(sent.error)}).` : " и попробуйте снова."),
          { tg: "send_failed" },
          { manifestId: id, outcome: "invalidated", reason: "tg_send_failed" },
        );
      }
      previewBody =
        `${built.preview}\n\n_⏳ Запрос на подтверждение отправлен в Telegram — подтвердите кнопкой в ` +
        `боте, затем ответьте «да» здесь._`;
    }

    // ───── Гибридное короткое ожидание (docs/TZ_consent_web_hub.md, часть 1) ─────
    // `syncWaitMs` не задан/0 ⇒ ветка целиком не существует — ни одного
    // лишнего обращения к стору, ни одной задержки, побайтовая совместимость.
    if (cfg.syncWaitMs && cfg.syncWaitMs > 0) {
      const sleep = cfg.sleep ?? defaultSleep;
      const pollMs = cfg.syncPollMs && cfg.syncPollMs > 0 ? cfg.syncPollMs : 1000;
      const deadline = now() + cfg.syncWaitMs;
      while (now() < deadline) {
        await sleep(pollMs);
        // ТОЛЬКО чтение собственного стора — никаких новых внешних
        // вызовов/HTTP из этого модуля (дисциплина ТЗ, часть 1).
        const row = await store.getManifest(id, cfg.server);
        if (!row || row.status === "AWAITING_CONSENT") continue; // ещё не решено — ждём дальше

        if (row.status === "INVALIDATED") {
          // Отклонено вне полосы (веб-хаб/кнопка) в течение окна — тот же
          // текст отказа, что и на обычном пути негации.
          return refuse(
            "Отменено пользователем",
            "Пользователь отклонил план (веб-хаб/Telegram) во время ожидания. План отменён, " +
              "ничего не выполнено. Чтобы повторить — построй план заново.",
            { syncWait: "invalidated" },
            { manifestId: id, objectHash: row.objectHash, outcome: "invalidated", reason: "sync_wait_invalidated" },
          );
        }

        // row.status === "DONE" — манифест уже подтверждён и consumed вне
        // полосы (веб-хаб /pending-consents/decide — тот же атомарный
        // consumeManifest, что и у авто-исполнения по кнопке в Telegram).
        //
        // ЗАЩИТА ОТ ДВОЙНОГО ИСПОЛНЕНИЯ (не менять!): здесь НИКОГДА не
        // возвращается {kind:"confirmed"} — это заставило бы вызывающий тул
        // исполнить мутацию ВТОРОЙ раз поверх уже исполненной веб-хабом. Эта
        // ветка ТОЛЬКО ЧИТАЕТ и не отдаёт payload наружу.
        //
        // ИСПРАВЛЕНО 2026-08-14: раньше положительный исход возвращался в
        // ФОРМЕ отказа ({kind:"refused"} с позитивным текстом внутри) — тул
        // отдавал его модели как отказ, и модель добросовестно шла на второй
        // круг «запроси подтверждение снова» (жалоба Максима: подтвердил в
        // портале за 2 секунды, а Claude всё равно спрашивает опять).
        // Теперь это отдельный честный исход `already_executed`: та же
        // защита (payload не отдаётся), но модели говорят правду — действие
        // ВЫПОЛНЕНО, вот отчёт.
        //
        // Аудит-запись за это исполнение уже написал ТОТ, кто реально
        // исполнил (веб-хаб через tryAutoExecute) — новую здесь не пишем,
        // чтобы не задваивать аудит-лог; её только ЧИТАЕМ, чтобы вложить в
        // отчёт фактический результат (post-verify), а не голое «исполнено».
        const currentHash = await rehash(row.payload as ConsentAddressing);
        const bindingOk = currentHash === row.objectHash;
        const built2 = await buildAlreadyExecutedReport({
          manifestId: id,
          previewBody,
          bindingOk,
          store,
          server: cfg.server,
        });
        return {
          kind: "already_executed",
          manifestId: id,
          report: built2.report,
          auditId: built2.auditId,
        };
      }
      // Дедлайн истёк, манифест всё ещё AWAITING_CONSENT — не ошибка, ничего
      // не потеряно: падаем на обычное превью ниже, как и раньше.
    }

    return { kind: "planned", manifestId: id, preview: renderPlanned(previewBody, id, expiresAt) };
  }

  // ───── ФАЗА ИСПОЛНЕНИЯ (оба заданы) ─────
  const checks: Record<string, string> = {};

  // (1) Манифест существует, наш server, тот же tool/account, ещё AWAITING.
  const row = await store.getManifest(manifestId, cfg.server);
  if (
    !row ||
    row.tool !== tool ||
    row.accountLabel !== accountLabel ||
    row.status !== "AWAITING_CONSENT"
  ) {
    checks.manifest = row ? "mismatch_or_closed" : "missing";
    return refuse(
      "План не найден или истёк",
      "Не нашёл активный план для этого действия. Построй план заново — вызови " +
        "инструмент без `manifest_id` и без `user_reply`.",
      checks,
    );
  }
  checks.manifest = "ok";

  // (2) Анти-дуплет — ПЕРВОЙ, манифест НЕ трогаем (иначе «план+execute в одном
  //     ходе» сожжёт план отрицанием/consume раньше, чем человек ответит).
  if (now() - row.createdAt < cfg.minConsentGapMs) {
    checks.antiDoublet = "too_fast";
    return refuse(
      "Слишком быстро — похоже на подтверждение без человека",
      "Между показом плана и исполнением прошло меньше " +
        `${Math.round(cfg.minConsentGapMs / 1000)} с. Покажи план пользователю, ` +
        "дождись его ответа и вызови снова. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  checks.antiDoublet = "ok";

  // (3) Утвердительность user_reply. Служебная → отказ (манифест жив);
  //     отрицание → инвалидация + отказ; ни да ни нет → отказ (манифест жив).
  const cls = classifyReply(userReply, { manifestId, tool });
  checks.reply = cls;
  if (cls === "service") {
    return refuse(
      "Это не ответ человека",
      "`user_reply` выглядит как служебная строка (id / JSON / псевдо-код), а " +
        "не реплика пользователя. Скопируй ДОСЛОВНО то, что написал человек.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "negation") {
    await store.invalidateManifest(manifestId, cfg.server, userReply);
    return refuse(
      "Отменено пользователем",
      `Пользователь ответил отказом («${inlineReply(userReply)}»). План отменён, ` +
        "ничего не отправлено. Чтобы повторить — построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "negation" },
    );
  }
  if (cls === "unknown") {
    return refuse(
      "Не понял ответ",
      `Не распознал в «${inlineReply(userReply)}» ни «да», ни «нет». Уточни у ` +
        "пользователя и вызови снова. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  // cls === "affirmation" → идём дальше.

  // (3.5) Внеполосный ТГ-фактор (опционально, ВЫКЛ по умолчанию — plan §1.6).
  // Встаёт ПОСЛЕ дешёвой/семантической проверки user_reply, ПЕРЕД дорогим
  // binding+consume: не тратим rehash впустую, пока кнопка не нажата. Когда
  // `tg` не передан или `enabledFor(tool)` ложно — этот блок не выполняется,
  // поведение ниже побайтово как до этой правки.
  if (p.tg?.enabledFor(tool)) {
    const approval = await p.tg.checkApproval(manifestId);
    checks.tgApproval = approval;
    if (approval === "pending") {
      return refuse(
        "Жду подтверждения в Telegram",
        "⏳ Подтвердите кнопкой в боте, затем повторите. План ещё активен.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
    if (approval === "rejected") {
      await store.invalidateManifest(manifestId, cfg.server, userReply);
      return refuse(
        "Отклонено в Telegram",
        "🛑 Действие отклонено кнопкой в Telegram. План отменён, ничего не отправлено. Чтобы " +
          "повторить — построй план заново.",
        checks,
        { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "tg_rejected" },
      );
    }
    if (approval === "none") {
      return refuse(
        "Запрос подтверждения истёк",
        "Запрос подтверждения в Telegram не найден или истёк по TTL. Построй план заново.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
    // approval === "approved" → идём дальше.
  }

  // (4) Binding: пересчитанный хеш ЖИВОГО состояния == сохранённому при плане.
  //     row.payload здесь передаётся rehash как АДРЕСАЦИЯ (источник id для
  //     перечитывания), а НЕ как контент для хеша — см. контракт `rehash` выше.
  //     rehash обязан сходить в мир; если он вернёт sha256(row.payload), эта
  //     проверка выродится в тавтологию и дрейф состояния не поймается.
  const currentHash = await rehash(row.payload);
  if (currentHash !== row.objectHash) {
    checks.binding = "mismatch";
    return refuse(
      "Состояние изменилось после планирования",
      "Объекты, к которым относился план, изменились (получатель/содержимое " +
        "«уехали»). Ради безопасности исполнение отклонено — построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  checks.binding = "ok";

  // (5) Одноразовость + TTL — АТОМАРНЫМ consumeManifest (гонка закрыта в БД).
  const consumed = await store.consumeManifest(manifestId, cfg.server, userReply);
  if (!consumed) {
    checks.oneShot = "consumed_or_expired";
    return refuse(
      "План не найден, истёк или уже исполнен",
      "Этот план уже был исполнен, инвалидирован или истёк по TTL за время " +
        "проверок. Построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  checks.oneShot = "ok";

  // (6) Журналирование факта согласия (фаза 1). Исход мутации + post-verify
  //     допишет инструмент через updateConsentAuditOutcome(auditId, …).
  const auditId = randomUUID();
  await store.appendConsentAudit({
    id: auditId,
    ts: now(),
    server: cfg.server,
    tool,
    accountLabel,
    manifestId,
    objectHash: row.objectHash,
    userReply,
    checks,
    outcome: "confirmed",
    actor: "human",
  });

  // payload берём ИЗ манифеста (не из аргументов вызова) — ТЗ 0.3 / A.1.
  return { kind: "confirmed", manifestId, payload: consumed.payload as T, auditId };
}

// ───────────────────────── Авто-исполнение по кнопке ────────────────────────

/**
 * Максим, ночь на 2026-08-05: «нажал кнопку — должно сразу исполниться на
 * бэке, не ждать, что модель ещё раз вызовет инструмент». До этой функции
 * кнопка в Telegram только переключала флаг в `tg_approvals` — реальная
 * мутация происходила ТОЛЬКО когда модель САМА второй раз звала инструмент
 * с `user_reply`; если пользователь ничего не писал в чат после нажатия —
 * действие могло не наступить никогда.
 *
 * Эта функция закрывает разрыв: сервер сам, фоновым поллером (см. per-server
 * `autoExecutePoller.ts`), находит манифесты AWAITING_CONSENT с уже
 * APPROVED-строкой в `tg_approvals` и атомарно исполняет их — БЕЗ участия
 * модели вообще. Та же дисциплина, что у execute-фазы `requireConsent`:
 * binding (rehash) + одноразовость (`consumeManifest`) + аудит-лог — только
 * шаги (3) и (3.5) (классификация `user_reply`, включая negative/affirmative)
 * пропущены, потому что кнопка в Telegram УЖЕ есть окончательное согласие
 * человека для этого инструмента (`tg.enabledFor(tool)` было истинно в
 * момент постройки плана — иначе строка в `tg_approvals` не появилась бы).
 *
 * ВАЖНО (два независимых режима — прямое требование Максима): эта функция
 * вызывается ТОЛЬКО фоновым поллером для манифестов, у которых
 * `tg.enabledFor(tool)` было истинно на момент плана. Обычный путь через
 * `requireConsent()` (чат-«да», без TG) НЕ меняется НИ НА БИТ — это отдельная
 * функция, а не альтернативная ветка внутри `requireConsent`, чтобы не
 * рисковать регрессией старого поведения.
 *
 * Возвращает null (не бросает), если манифест уже неактуален (гонка с чем-то
 * ещё, TTL истёк, дрейф состояния) — вызывающий поллер просто пропускает и
 * логирует, это не ошибка.
 */
export interface AutoExecuteResult<T = unknown> {
  manifestId: string;
  tool: string;
  accountLabel: string;
  payload: T;
  auditId: string;
}

/** Метка вместо `user_reply` человека — честно отражает происхождение
 * (кнопка, не текст), видна в аудит-логе. НЕ выглядит как утвердительное
 * слово специально — если этот текст случайно попадёт куда-то ещё
 * (например по ошибке будет передан в `requireConsent` напрямую), он не
 * должен пройти обычную классификацию `classifyReply` как настоящее «да». */
export const TG_AUTO_REPLY_MARKER = "[авто: подтверждено кнопкой в Telegram]";

/**
 * `ctx` (5-й аргумент, генерик `C`) — контекст, нужный тем rehash-функциям,
 * которые реально сходят за живым состоянием (gmail_reply/forward/labels/…),
 * а не вырождены в `sha256(addressing)` (gmail_send/create_draft/…) — им
 * нужен живой клиент Gmail на аккаунт, а его нет в самом `addressing`
 * (только `account`-метка). Поллер (`http.ts`'s `runAutoExecutePoller`)
 * строит этот ctx один раз на тик и передаёт его же в `executor.execute`
 * (см. `autoExecute.ts`'s `AutoExecutorCtx`) — здесь тип оставлен генериком
 * `unknown` по умолчанию, чтобы `consent.ts` не импортировал `autoExecute.ts`
 * (циклический импорт: `autoExecute.ts` уже импортирует типы отсюда).
 * Опционален — старые вызовы (4 аргумента, offline-тесты с rehash без
 * ctx-параметра) продолжают работать байт-в-байт.
 */
export async function tryAutoExecute<T = unknown, C = unknown>(
  candidate: { manifestId: string; tool: string; accountLabel: string },
  rehash: (addressing: ConsentAddressing, ctx: C) => string | Promise<string>,
  store: ConsentStore,
  cfg: ConsentConfig,
  ctx?: C,
): Promise<AutoExecuteResult<T> | null> {
  const now = cfg.now ?? Date.now;

  const row = await store.getManifest(candidate.manifestId, cfg.server);
  if (
    !row ||
    row.tool !== candidate.tool ||
    row.accountLabel !== candidate.accountLabel ||
    row.status !== "AWAITING_CONSENT"
  ) {
    return null;
  }

  // Binding — та же проверка, что в requireConsent (4): живой мир не уехал
  // между планом и нажатием кнопки.
  const currentHash = await rehash(row.payload, ctx as C);
  if (currentHash !== row.objectHash) {
    return null;
  }

  // Одноразовость — тот же атомарный consumeManifest, что и у обычного пути.
  const consumed = await store.consumeManifest(candidate.manifestId, cfg.server, TG_AUTO_REPLY_MARKER);
  if (!consumed) return null;

  const auditId = randomUUID();
  await store.appendConsentAudit({
    id: auditId,
    ts: now(),
    server: cfg.server,
    tool: candidate.tool,
    accountLabel: candidate.accountLabel,
    manifestId: candidate.manifestId,
    objectHash: row.objectHash,
    userReply: TG_AUTO_REPLY_MARKER,
    checks: { tgApproval: "approved", binding: "ok", oneShot: "ok" },
    outcome: "confirmed",
    // "tg_auto" — честно отличается от "human": подтверждение кнопкой, не
    // текстовой репликой в чате. Тип поля — `string` (см. интерфейс выше),
    // менять его не нужно.
    actor: "tg_auto",
  });

  return {
    manifestId: candidate.manifestId,
    tool: candidate.tool,
    accountLabel: candidate.accountLabel,
    payload: consumed.payload as T,
    auditId,
  };
}
