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
 * automation_key-ветка (легальный обход для headless-автоматов) СОЗНАТЕЛЬНО не
 * реализована в этой версии: пре-чек потребителей не нашёл автоматов, зовущих
 * инструменты отправки напрямую (YAGNI). Единственный вход доверия — `user_reply`.
 */

import { createHash, randomUUID } from "node:crypto";

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
  /**
   * «Этот план реально ушёл в Telegram с кнопками» — ставится РОВНО в одном
   * месте (`requireConsent`'s фаза плана, сразу после успешного `notifyPlan`)
   * и больше НИКОГДА. Решение «нужна ли кнопка» принимается по СОСТОЯНИЮ
   * ПЛАНА, а не по текущему значению `TG_APPROVAL_ENABLED`: выключение
   * настройки между планом и исполнением не должно растворять требование
   * кнопки. См. `tgButtonOnly` ниже.
   */
  tgNotified?: boolean;
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

  /**
   * Помечает манифест как «план ушёл в Telegram с кнопками» (`tg_notified`).
   * Вызывается РОВНО из одного места — фазы плана `requireConsent`, сразу
   * после того, как `tg.notifyPlan` вернул успех. Никогда не снимается.
   */
  markTgNotified(id: string, server: string): Promise<void>;

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
   * «Умеет ли сервер исполнить план ЭТОГО инструмента сам, по нажатию кнопки»
   * — второе (и единственное кроме `tg_notified`) условие button-only режима.
   * Это правило ПО СВОЙСТВУ, а не список имён тулов: как только у тула
   * появляется авто-исполнитель, он автоматически становится button-only, а
   * если исполнитель забыли — просто остаётся открыт обычный текстовый путь
   * (мягкая деградация вместо «исполнить невозможно вообще»).
   *
   * DI тем же приёмом, что `store`/`tg`: `consent.ts` НЕ импортирует
   * `autoExecute.ts` (иначе цикл импортов), реализацию инжектирует вызывающий
   * инструмент — `(tool) => getAutoExecutor(tool) !== undefined`.
   * Не передан ⇒ button-only никогда не включается.
   */
  hasAutoExecutor?: (tool: string) => boolean;
}

/** Размеченный union исхода. Отказы — здесь, НЕ через throw. */
export type ConsentDecision<T = unknown> =
  | { kind: "planned"; manifestId: string; preview: string }
  | { kind: "confirmed"; manifestId: string; payload: T; auditId: string }
  | { kind: "refused"; result: string };

/**
 * Докстринг параметра `user_reply` — ДОСЛОВНО по смыслу из ТЗ A.3 / gate.md §3.3.
 * Инструмент (A3) обязан навесить эту строку на zod-параметр `user_reply`.
 */
export const USER_REPLY_DOC =
  "Скопируй сюда ДОСЛОВНО последнее сообщение пользователя, которым он " +
  "подтвердил. Не сочиняй и не пересказывай. Если пользователь ещё не ответил " +
  "— не вызывай этот инструмент.";

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
//
// СТРОГИЙ ПРОТОКОЛ (2026-08-06, порт защиты из Python-эталона ticktick-mcp
// PR #15). До этой правки согласие определялось через `.some()`: «хотя бы один
// знакомый утвердительный токен где угодно во фразе». Это fail-open — «ок,
// кроме последней» / «да, но третий пропусти» классифицировались как ЧИСТОЕ
// согласие, и план исполнялся ЦЕЛИКОМ, включая явно исключённое.
//
// Принцип перевёрнут: согласием считается только ответ, ВЕСЬ состоящий из
// понятных сервером элементов. Формула (см. `classifyReply` внизу):
//   core непуст И core.length <= CONSENT_MAX_TOKENS И
//   хотя бы один токен из AFFIRMATIVE И каждый токен из (AFFIRMATIVE ∪ FILLER).
// Один незнакомый токен ⇒ НЕ согласие, вердикт `ambiguous`, отказ с просьбой
// ответить одним словом. Сервер СОЗНАТЕЛЬНО не угадывает, какое подмножество
// плана имелось в виду — угадав неверно, он сделает не то, что просили.
//
// ⚠️ JS-СПЕЦИФИКА, из-за которой механический перенос Python-регулярок молча
// ломается: в JavaScript `\b` определён через `\w = [A-Za-z0-9_]`, кириллица
// туда НЕ входит, и флаг `u` этого не меняет — `/\bкроме\b/.test("ок, кроме
// последней")` === false, тогда как английский `/\bexcept\b/` работает. Тесты
// на английских фразах при этом остаются зелёными → ложное ощущение успеха.
// Поэтому все словесные границы вокруг кириллицы здесь собираются через
// lookaround `LB`/`RB` ниже, а НЕ через `\b`. То же с `\w`: в JS он ASCII-only,
// поэтому «слово» — это `[\p{L}\p{N}_]` c флагом `u`.
//
// ЧТО СОХРАНЕНО ИЗ ПРЕЖНЕЙ TS-ЛОГИКИ (она в этом месте УМНЕЕ Python-эталона).
// Отрицание НЕЛЬЗЯ ловить «где-то в строке есть частица не/not»: так
// «отправляй, не тяни» ложно инвалидировало живой манифест, а «not sure»
// проходило как согласие. Частицы (не/not) дают отрицание ТОЛЬКО в
// конструкции «частица + голова» (`hasParticleNegation`): «не отправляй» /
// «not sure» / «не надо». Голая частица без головы — НЕ отрицание: план
// остаётся жив, вердикт `ambiguous` (безопасный переспрос).

/** Левая граница слова, работающая для кириллицы (в отличие от `\b`). */
const LB = "(?<![\\p{L}\\p{N}_])";
/** Правая граница слова, работающая для кириллицы. */
const RB = "(?![\\p{L}\\p{N}_])";
/** «Буква слова» — JS-`\w` ASCII-only и для русских суффиксов не годится. */
const W = "[\\p{L}\\p{N}_]";

const AFFIRMATION_TOKENS = new Set([
  // RU
  "да", "ага", "угу", "ок", "окей", "окай", "океюшки", "давай", "давайте",
  "подтверждаю", "подтверждаешь", "подтверждено", "отправляй", "отправь",
  "отправляем", "шли", "удаляй", "удали", "го", "погнали", "поехали", "плюс",
  "ясно", "жми", "валяй", "конечно", "точно", "хорошо", "договорились",
  "принято", "согласен", "согласна", "согласны", "действуй", "действуйте",
  "вперёд", "вперед", "верно", "правильно", "именно", "утверждаю", "одобряю",
  "одобрено", "безусловно", "однозначно", "продолжай", "продолжаем",
  "запускай", "стартуй", "стартуем", "выполняй", "применяй", "применить",
  "применяем", "делай", "сливай", "слей", "создавай", "создай", "обновляй",
  "обнови", "отметь", "отмечай", "перемещай", "перемести", "восстанавливай",
  "восстанови", "завершай", "заверши", "архивируй", "ставь", "поставь",
  "сделай", "сделайте", "сделаем",
  // docs-специфичные глаголы действия (аналог «удаляй» в ticktick-эталоне):
  // это ровно те слова, которыми Максим подтверждает правку документа.
  "заменяй", "замени", "вставляй", "вставь", "добавляй", "добавь", "допиши",
  "дописывай", "пиши", "правь", "поправь",
  // «+» / «+1» — реальные однознаковые подтверждения. Токенизатор их НЕ
  // срезает (см. `consentTokens`), поэтому они лежат прямо в словаре.
  "+", "+1",
  // EN
  "yes", "yep", "yeah", "yup", "ok", "okay", "k", "confirm", "confirmed",
  "go", "send", "sure", "approve", "approved", "proceed", "aye", "yea",
  "agreed", "right", "correct", "exactly", "absolutely", "definitely",
  "affirmative", "alright", "fine", "deal", "certainly", "do", "accept",
  "accepted", "good",
]);

/** Наречия образа действия: «ок, только быстрее» — это согласие, а не оговорка.
 * Именно они гасят caveat-маркер «только» (см. `CONSENT_CAVEAT_RE`). */
const CONSENT_MANNER_WORDS = [
  "быстрее", "побыстрее", "быстро", "скорее", "поскорее", "аккуратно",
  "аккуратнее", "осторожно", "осторожнее", "внимательно", "внимательнее",
  "тихо", "медленно", "спокойно", "пожалуйста", "давай", "давайте",
];

/** Служебные слова, которые сами по себе ничего не подтверждают, но и не
 * мешают: согласие = ≥1 AFFIRMATIVE + всё остальное отсюда.
 *
 * «ладно» — СОЗНАТЕЛЬНОЕ отличие от Python-эталона (решение Максима,
 * 2026-08-06): в эталоне слова нет ни в одном словаре, поэтому там и «ладно»,
 * и «ладно, давай» → ambiguous. Здесь «ладно» лежит в FILLER, а НЕ в
 * AFFIRMATIVE: односложное «ладно» согласием не считается (нет ни одного
 * утвердительного токена), а «ладно, давай» — считается. */
const CONSENT_FILLER_WORDS = new Set([
  ...CONSENT_MANNER_WORDS,
  "ладно",
  "только", "ну", "же", "уж", "уже", "тогда", "сразу", "сейчас", "спасибо",
  "плиз", "please", "thanks", "thank", "you", "now", "ahead", "it", "sounds",
  "lets", "for", "away",
  "удаление", "создание", "изменение", "обновление", "перемещение",
  "завершение", "слияние", "восстановление", "замена", "замену", "вставка",
  "вставку", "добавление",
]);

/** Устойчивые обороты → одно каноническое слово. Схлопывание применяется
 * ТОЛЬКО на финальном шаге проверки согласия, НЕ раньше: отрицание, оговорка
 * и неуверенность обязаны видеть исходный текст. */
const CONSENT_SET_PHRASES: Array<[RegExp, string]> = [
  [new RegExp(LB + "вс[её]\\s+(?:верно|правильно|так)" + RB, "giu"), "верно"],
  [new RegExp(LB + "так\\s+точно" + RB, "giu"), "точно"],
  [new RegExp(LB + "без\\s+(?:проблем|вопросов|базара|разговоров|сомнений)" + RB, "giu"), "ок"],
  [new RegExp(LB + "(?:go|move)\\s+ahead" + RB, "giu"), "go"],
  [new RegExp(LB + "of\\s+course" + RB, "giu"), "конечно"],
];

/** Верхний предел длины «понятного целиком» ответа. Девять «да» подряд — уже
 * не человеческое подтверждение, а что-то сгенерированное. */
const CONSENT_MAX_TOKENS = 8;

// Частицы-отрицания: САМИ ПО СЕБЕ не решают. Отрицание — только «частица + голова».
const NEGATION_PARTICLES = new Set(["не", "not"]);

// «Головы», которые после частицы дают отказ, но сами утверждением НЕ являются
// (иначе одиночное «надо»/«нужно» ложно читалось бы как «да»). «не надо»,
// «не нужно», «не буду» → отказ; голое «надо» → ambiguous (безопасный переспрос).
const NEGATED_HEADS = new Set([
  "надо", "нужно", "стоит", "буду", "будем", "хочу", "хочется",
]);

// Самостоятельные негации: отрицание в любой позиции токена, инвалидируют план.
const STANDALONE_NEGATIONS = new Set([
  // RU
  "нет", "неа", "нельзя", "стоп", "отмена", "отмени", "отменить", "отставить",
  "отбой", "погоди", "подожди", "стой",
  // EN
  "no", "nope", "nah", "stop", "cancel", "abort", "dont", "wait", "nvm", "negative",
]);

/** Реплики, которые целиком (вся строка) означают отказ. Проверяются ДО
 * caveat НАМЕРЕННО: иначе «не надо» уехало бы в оговорку. */
const NEGATION_PHRASES = new Set([
  "не надо", "не нужно", "do not", "not now", "hold on", "no dont", "not yet",
  "don't",
]);

/** Оговорка/частичное согласие: «ок, кроме последней», «давай, только вторую
 * оставь», «confirm, but skip the last one». Сервер не умеет исполнять план
 * частично, поэтому такой ответ — не согласие, а команда перепланировать. */
const CONSENT_MANNER_ALT = [...CONSENT_MANNER_WORDS]
  // Сортировка по УБЫВАНИЮ длины обязательна: иначе «быстро» примерится
  // раньше «быстрее» и «только быстрее» ошибочно станет оговоркой.
  .sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1))
  .join("|");

const CONSENT_CAVEAT_RE = new RegExp(
  LB +
    "(?:" +
    `кроме|исключая|исключи${W}*|за\\s+исключением|` +
    "но\\s+не|а\\s+не|" +
    "не\\s+(?:надо|нужно|трогай|трогая|удаляй|удали|включай|бери|берём|берем|стоит)|" +
    `оставь${W}*|оставить|оставим|оставляем|оставляя|` +
    `пропусти${W}*|пропустить|пропустим|пропуская|` +
    `только(?!\\s+(?:${CONSENT_MANNER_ALT})${RB})|` +
    `без\\s+(?!проблем|вопросов|базара|разговоров|сомнений|задержек|проволочек|лишних)${W}+|` +
    "except|excluding|exclude|apart\\s+from|other\\s+than|but\\s+not|" +
    "all\\s+but|everything\\s+but|skip" +
    ")" +
    RB,
  "iu",
);

/** Пересказ вместо реплики: «Пользователь: да», «он сказал да», «the user said
 * yes». Это не голос человека, а модель, рассказывающая о человеке. */
const CONSENT_PARAPHRASE_RE = new RegExp(
  "^(?:пользователь|юзер|человек|владелец|хозяин|user|the\\s+user)\\s*[:—-]|" +
    "^(?:пользователь|юзер|человек|владелец|он|она|user)\\s+" +
    `(?:сказал|сказала|ответил|ответила|подтвердил|подтвердила|говорит|пишет|написал|написала)${RB}|` +
    `^(?:the\\s+user|he|she|they)\\s+(?:said|says|replied|confirmed|approved)${RB}|` +
    `${LB}(?:по|согласно)\\s+словам\\s+(?:пользователя|юзера|человека|владельца)${RB}|` +
    `${LB}со\\s+слов\\s+(?:пользователя|юзера|человека|владельца)${RB}|` +
    `${LB}as\\s+(?:the\\s+)?user\\s+said${RB}|${LB}according\\s+to\\s+the\\s+user${RB}`,
  "iu",
);

/** Неуверенность/безразличие: «наверное да», «делай что хочешь», «whatever».
 * Для необратимой операции этого мало — переспрашиваем, план не трогаем. */
const CONSENT_HEDGE_RE = new RegExp(
  LB +
    "(?:наверн(?:ое|о)|возможно|может\\s+быть|думаю|кажется|вроде(?:\\s+бы)?|" +
    `не\\s+уверен${W}*|сомневаюсь|` +
    `как\\s+(?:хочешь|хотите|знаешь|знаете|сам${W}*)|` +
    "что\\s+(?:хочешь|хотите)|вс[её]\\s+равно|пофиг|" +
    "maybe|probably|i\\s+guess|i\\s+think|whatever|up\\s+to\\s+you|not\\s+sure|dunno" +
    ")" +
    RB,
  "iu",
);

/** Служебный жаргон самого сервера в роли «согласия» — ровно то, что печатает
 * модель, подтверждающая сама себя. Имена тулов адаптированы под docs-mcp. */
const CONSENT_ECHO_ARTIFACT_RE =
  /^(?:delete|create|append|insert|replace|update|batch)\s*\d+$|manifest_id|docs_\w+\s*\(|execute_\w+\s*\(|plan_\w+\s*\(|^\{[\s\S]*\}$/i;

/** Нормализация: trim → срезать `.!?,;:` с ОБОИХ КРАЁВ всей строки →
 * схлопнуть пробелы → lower. Пунктуация ВНУТРИ строки СОХРАНЯЕТСЯ — регулярки
 * выше обязаны видеть запятую и двоеточие («Пользователь: да»). */
function normalizeConsentReply(reply: string | null | undefined): string {
  return (reply ?? "")
    .trim()
    .replace(/^[.!?,;:]+|[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Токенизация: split по пробелам, с каждого токена срезать `.,!?;:` с обоих
 * краёв, апострофы убрать (don't → dont), пустые выбросить. `+` и `+1` НЕ
 * срезаются — это самостоятельные подтверждения. */
function consentTokens(norm: string): string[] {
  return norm
    .split(/\s+/)
    .map((t) => t.replace(/^[.,!?;:]+|[.,!?;:]+$/g, "").replace(/['’`]/g, ""))
    .filter(Boolean);
}

/** Схлопывание устойчивых оборотов — ТОЛЬКО на финальном шаге согласия. */
function collapseConsentSetPhrases(norm: string): string {
  let out = norm;
  for (const [rx, repl] of CONSENT_SET_PHRASES) out = out.replace(rx, repl);
  return out;
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

export type ReplyClass =
  | "empty"
  | "echo"
  | "paraphrase"
  | "negation"
  | "caveat"
  | "hedge"
  | "affirmation"
  | "ambiguous";

/**
 * Классы отказа, ПОСЛЕ которых план АННУЛИРУЕТСЯ (сжигается) и нужно
 * перепланировать. Всё остальное (empty/echo/paraphrase/hedge/ambiguous)
 * оставляет план ЖИВЫМ: наказывать человека перепланированием за КРИВОЕ
 * ОФОРМЛЕНИЕ ответа моделью — неправильно.
 */
export const BURNING_REPLY_CLASSES: ReadonlySet<ReplyClass> = new Set<ReplyClass>([
  "negation",
  "caveat",
]);

/** Голова после частицы, дающая отказ: «не <affirmation>» или «не <NEGATED_HEAD>». */
function isNegatedHead(t: string | undefined): boolean {
  return t != null && (AFFIRMATION_TOKENS.has(t) || NEGATED_HEADS.has(t));
}

/**
 * true, если в токенах есть конструкция «частица-отрицание (не/not)
 * НЕПОСРЕДСТВЕННО перед головой». Именно это — а не «частица где-то в строке» —
 * отличает «не отправляй»/«not sure» (отрицание) от «отправляй, не тяни»
 * (не отрицание: «не» стоит перед не-головой «тяни»).
 */
function hasParticleNegation(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (NEGATION_PARTICLES.has(tokens[i]) && isNegatedHead(tokens[i + 1])) return true;
  }
  return false;
}

/**
 * Классифицирует реплику. ПОРЯДОК ПРОВЕРОК СТРОГО ТАКОЙ, менять нельзя:
 * пусто → echo → пересказ → отрицание-целиком-строкой → оговорка →
 * отрицание-по-токенам → неуверенность → согласие (строгая формула) →
 * ambiguous.
 *
 * Отдельно про «отрицание целиком строкой ДО оговорки»: иначе «не надо»
 * уехало бы в caveat (там есть маркер `не надо`) вместо честного отказа.
 */
export function classifyReply(
  userReply: string,
  ctx: { manifestId: string; tool: string },
): ReplyClass {
  const raw = (userReply ?? "").trim();
  const norm = normalizeConsentReply(userReply);
  if (!norm) return "empty";
  if (isServiceString(raw, ctx) || CONSENT_ECHO_ARTIFACT_RE.test(norm)) return "echo";
  if (CONSENT_PARAPHRASE_RE.test(norm)) return "paraphrase";
  if (NEGATION_PHRASES.has(norm) || STANDALONE_NEGATIONS.has(norm)) return "negation";
  if (CONSENT_CAVEAT_RE.test(norm)) return "caveat";

  const tokens = consentTokens(norm);
  if (tokens.some((t) => STANDALONE_NEGATIONS.has(t)) || hasParticleNegation(tokens)) {
    return "negation";
  }
  if (CONSENT_HEDGE_RE.test(norm)) return "hedge";

  // Строгая формула согласия: ответ должен быть понятен ЦЕЛИКОМ.
  const core = consentTokens(collapseConsentSetPhrases(norm));
  if (
    core.length > 0 &&
    core.length <= CONSENT_MAX_TOKENS &&
    core.some((t) => AFFIRMATION_TOKENS.has(t)) &&
    core.every((t) => AFFIRMATION_TOKENS.has(t) || CONSENT_FILLER_WORDS.has(t))
  ) {
    return "affirmation";
  }
  return "ambiguous";
}

// ───────────────────── Button-only: текстовый путь закрыт ───────────────────

/**
 * Закрыт ли для ЭТОГО плана текстовый путь исполнения (порт защиты из
 * Python-эталона ticktick-mcp PR #17, merge 467018e).
 *
 * Максим, 2026-08-06: если план реально ушёл кнопкой и сервер умеет исполнить
 * его сам по нажатию — текстовому подтверждению здесь просто нечего делать.
 * Сервер физически НЕ может отличить сочинённое моделью «да» от реальной
 * реплики человека (он видит только строку), поэтому дыра «модель
 * подтверждает сама себя» не уменьшается затыканием формулировок, а
 * ИСЧЕЗАЕТ: способа исполнить такую операцию текстом больше не существует.
 *
 * ДВА условия, оба обязательны:
 *  1. `manifest.tgNotified` — план реально ушёл в Telegram. Метку ставит
 *     ТОЛЬКО фаза плана и только при УСПЕШНОЙ отправке сообщения с кнопками.
 *     Решение принимается по СОСТОЯНИЮ ПЛАНА; текущее значение
 *     `TG_APPROVAL_ENABLED` здесь не читается ВООБЩЕ — иначе выключение
 *     переменной между планом и исполнением снимало бы требование кнопки.
 *  2. У плана есть чем исполниться по нажатию (`hasAutoExecutor(tool)`).
 *     Без этого условия закрытие текстового пути означало бы, что операцию
 *     нельзя выполнить НИКАК. Правило ПО СВОЙСТВУ, а не список исключений:
 *     список пережил бы свою причину, свойство самоустраняется.
 *
 * При выключенном Telegram-слое метка не ставится никогда → всегда false →
 * обычный текстовый путь работает как раньше.
 */
export function tgButtonOnly(
  manifest: Pick<ConsentManifestRow, "tool" | "tgNotified"> | null | undefined,
  hasAutoExecutor?: (tool: string) => boolean,
): boolean {
  if (!manifest?.tgNotified) return false;
  if (!hasAutoExecutor) return false;
  return hasAutoExecutor(manifest.tool);
}

const TG_BUTTON_ONLY_PENDING_BODY =
  "⏳ Этот план подтверждается ТОЛЬКО кнопкой в Telegram — текстовое " +
  "подтверждение для него отключено, что бы пользователь ни написал в чате. " +
  "Нажмите ✅ в боте: операция выполнится сама, отчёт придёт в то же сообщение " +
  "с кнопками. Повторно вызывать этот инструмент НЕ нужно — просто скажи " +
  "пользователю, что ждёшь его нажатия. План активен.";

const TG_BUTTON_ONLY_APPROVED_BODY =
  "✅ Уже подтверждено кнопкой в Telegram — сервер исполняет эту операцию САМ " +
  "(фоновый поллер, обычно в течение ~10 секунд). Ничего повторять не надо и " +
  "этот инструмент больше звать не надо: результат будет вписан в то же " +
  "сообщение Telegram, где были кнопки.";

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

  // Общий журнал отказа + возврат refused.
  const refuse = async (
    header: string,
    body: string,
    checks: Record<string, string>,
    opts?: { manifestId?: string; objectHash?: string; outcome?: "refused" | "invalidated"; reason?: string },
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
      actor: "human",
    });
    return { kind: "refused", result: renderRefusal(header, body) };
  };

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
      // УСПЕШНО отправлено → помечаем САМ МАНИФЕСТ. Это единственное место, где
      // ставится `tg_notified`: с этого момента факт «план ушёл кнопкой»
      // хранится в состоянии плана, а не выводится заново на фазе исполнения
      // из текущего значения настройки (см. `tgButtonOnly`).
      await store.markTgNotified(id, cfg.server);
      // Приписка честно отражает, что произойдёт ДАЛЬШЕ. Прежний текст просил
      // «затем ответьте „да" здесь» — ровно то действие, которое для планов с
      // авто-исполнителем теперь отвергается.
      previewBody = p.hasAutoExecutor?.(tool)
        ? `${built.preview}\n\n_⏳ Запрос на подтверждение отправлен в Telegram. Подтвердите кнопкой ✅ в ` +
          `боте — операция выполнится автоматически, отчёт придёт в то же сообщение. Повторно вызывать ` +
          `этот инструмент НЕ нужно, текстовое «да» для этого плана не принимается._`
        : `${built.preview}\n\n_⏳ Запрос на подтверждение отправлен в Telegram. Подтвердите кнопкой ✅ в ` +
          `боте — этот план сервер сам не исполняет, после нажатия повторите вызов инструмента._`;
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

  // (3) Утвердительность user_reply — СТРОГИЙ протокол (см. `classifyReply`).
  //     Два класса отказа сжигают план (negation/caveat — человек явно сказал
  //     «нет» или «да, но не всё»), остальные оставляют его живым: наказывать
  //     перепланированием за КРИВОЕ ОФОРМЛЕНИЕ ответа моделью — неправильно.
  const cls = classifyReply(userReply, { manifestId, tool });
  checks.reply = cls;

  // (3a) Классы, сжигающие план — ДО button-only (эталон: «нет» в чате гасит
  //      план, не дожидаясь кнопки).
  if (cls === "negation") {
    await store.invalidateManifest(manifestId, cfg.server, userReply);
    return refuse(
      "Отменено пользователем",
      `В ответе («${inlineReply(userReply)}») есть отрицание — где бы оно ни стояло во фразе, ` +
        "это не согласие. План отменён, ничего не отправлено. Чтобы повторить — построй план заново.",
      checks,
      { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "negation" },
    );
  }
  if (cls === "caveat") {
    await store.invalidateManifest(manifestId, cfg.server, userReply);
    return refuse(
      "Частичное согласие — так нельзя",
      `Пользователь согласился с оговоркой («${inlineReply(userReply)}»): часть плана он исключил. ` +
        "Сервер НЕ умеет исполнять план частично и СОЗНАТЕЛЬНО не угадывает, какое подмножество " +
        "имелось в виду. План аннулирован — построй план ЗАНОВО, ровно из того, что нужно оставить.",
      checks,
      { manifestId, objectHash: row.objectHash, outcome: "invalidated", reason: "caveat" },
    );
  }

  // (3b) BUTTON-ONLY: для плана, который ушёл кнопкой и умеет исполниться сам,
  //      текстовый путь ЗАКРЫТ ЦЕЛИКОМ — содержание реплики больше ни на что
  //      не влияет. Стоит ДО проверки утвердительности намеренно: требовать
  //      «пришли дословное да» было бы враньём — модель пошла бы добывать
  //      текст, который всё равно ничего не откроет.
  if (tgButtonOnly(row, p.hasAutoExecutor)) {
    const approval = await p.tg!.checkApproval(manifestId);
    checks.tgButtonOnly = approval;
    if (approval === "approved") {
      // Кнопка нажата, фоновый поллер ещё не добрался. КРИТИЧНО: манифест НЕ
      // гасим — иначе поллер найдёт его погашенным и операция не произойдёт
      // ВООБЩЕ.
      return refuse("Уже подтверждено кнопкой", TG_BUTTON_ONLY_APPROVED_BODY, checks, {
        manifestId,
        objectHash: row.objectHash,
      });
    }
    if (approval === "rejected") {
      await store.invalidateManifest(manifestId, cfg.server, userReply);
      return refuse(
        "Отклонено в Telegram",
        "Действие отклонено кнопкой в Telegram. План отменён, ничего не сделано. " +
          "Чтобы повторить — построй план заново.",
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
    return refuse("Подтверждается только кнопкой", TG_BUTTON_ONLY_PENDING_BODY, checks, {
      manifestId,
      objectHash: row.objectHash,
    });
  }

  // (3c) Отказы, оставляющие план живым.
  if (cls === "echo") {
    return refuse(
      "Это не ответ человека",
      "`user_reply` повторяет служебный жаргон сервера (manifest_id / имя инструмента / JSON / " +
        "псевдо-код) — ровно то, что печатает модель, подтверждающая сама себя. Скопируй ДОСЛОВНО " +
        "то, что написал человек. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "paraphrase") {
    return refuse(
      "Это пересказ, а не реплика человека",
      `«${inlineReply(userReply)}» — рассказ О пользователе, а не его слова. Нужна реплика человека ` +
        "ДОСЛОВНО, без «пользователь сказал». План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "hedge") {
    return refuse(
      "Неуверенный ответ — для необратимой операции мало",
      `«${inlineReply(userReply)}» — это неуверенность или безразличие, а не согласие. Переспроси ` +
        "пользователя и вызови снова. План ещё активен.",
      checks,
      { manifestId, objectHash: row.objectHash },
    );
  }
  if (cls === "empty" || cls === "ambiguous") {
    return refuse(
      "Не понял ответ",
      `Не распознал в «${inlineReply(userReply)}» однозначного согласия. Сервер СОЗНАТЕЛЬНО не ` +
        "угадывает, что имелось в виду: угадав неверно, он сделает не то, что просили. Попроси " +
        "пользователя ответить одним словом — «да» или «нет» — и вызови снова. План ещё активен.",
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
  //
  // ДВА независимых основания требовать кнопку:
  //  (а) манифест ПОМЕЧЕН `tgNotified` — план ЭТОЙ операции реально ушёл
  //      кнопкой. Приоритетное, жёсткое основание: не зависит от текущего
  //      значения настройки (её могли выключить между планом и исполнением);
  //  (б) старое основание `enabledFor(tool)` — для планов, построенных до
  //      появления метки, и для случая, когда слой включили после плана.
  // Сюда доходят только планы БЕЗ авто-исполнителя: у остальных текстовый
  // путь закрыт целиком блоком (3b) выше.
  const tgRequired = row.tgNotified === true || p.tg?.enabledFor(tool) === true;
  if (tgRequired) {
    if (!p.tg) {
      // Метка стоит, а проверить кнопку нечем (слой не инжектирован) —
      // fail-closed: отказ, план жив.
      checks.tgApproval = "gate_missing";
      return refuse(
        "Нужна кнопка в Telegram, но слой подтверждения недоступен",
        "Этот план был отправлен на подтверждение кнопкой, но Telegram-слой сейчас не подключён к " +
          "серверу — проверить нажатие нечем. Действие НЕ выполнено. План ещё активен.",
        checks,
        { manifestId, objectHash: row.objectHash },
      );
    }
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
