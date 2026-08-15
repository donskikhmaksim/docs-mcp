/**
 * autoExecute.ts — реестр «ядер исполнения» гейтованных тулов, вызываемых
 * фоновым поллером НАПРЯМУЮ (в обход MCP-транспорта и модели вообще) — см.
 * consent.ts's `tryAutoExecute` doc-comment (Максим, 2026-08-05: «нажал
 * кнопку — сразу исполнилось на бэке»).
 *
 * КРИТИЧНО ПРО БЕЗОПАСНОСТЬ: этот реестр НИКОГДА не выставляется как
 * MCP-параметр инструмента (никакого `auto_confirmed: true` в схеме) — модель
 * не может вызвать `execute` отсюда никаким аргументом. Единственный
 * вызывающий — поллер сервера (`http.ts`'s `runAutoExecutePoller`), который
 * САМ находит кандидатов через `store.listApprovedUnexecuted()` (Postgres,
 * не аргумент вызова) и вызывает `tryAutoExecute()` (не пропускает binding/
 * one-shot, только классификацию текстовой реплики — TG-кнопка уже была
 * единственным доказанным согласием для этого тула).
 *
 * Регистрация — на уровне МОДУЛЯ (при импорте), не внутри `registerXTools()`
 * (та функция вызывается ПОВТОРНО на каждый MCP-запрос — реестр не должен
 * зависеть от того, приходил ли уже хоть один запрос).
 */

import type { UserClients } from "./accounts.js";
import type { ConsentStore, ConsentAddressing } from "./consent.js";
import { stripUrlQuery } from "./consent.js";

export interface AutoExecutorCtx {
  clients: UserClients;
  consentStore: ConsentStore;
  /** `user.token` для онбордингового multi-tenant (обычно `null` в
   * self-host-однопользовательском случае) — тот же смысл, что у
   * `GmailSnoozeContext.userToken` в `tools/gmail.ts`. Прокинут сюда, чтобы
   * тулы, которые персистят через юзер-scoped строки store.ts (snooze/
   * scheduled_send), тоже могли авто-исполняться поллером — иначе им негде
   * взять этот токен вне обычного per-request пути. */
  userToken: string | null;
}

/** `ctx` — второй параметр, нужен ТОЛЬКО rehash-функциям с настоящим
 * биндингом (сходят за живым состоянием в Gmail через `ctx.clients.resolve
 * (account)`, `account` берётся из самого `addressing`) — вырожденные
 * `(addressing) => sha256(addressing)` (gmail_send и т.п.) его просто
 * игнорируют, TS это разрешает (функция с меньшим числом параметров
 * подходит под тип с большим). */
export type RehashFn = (addressing: ConsentAddressing, ctx: AutoExecutorCtx) => string | Promise<string>;
/** Возвращает ГОТОВЫЙ человекочитаемый текст отчёта — то же самое, что тул
 * вернул бы модели в чат при обычном (не-авто) исполнении, включая ссылку/
 * артефакт, если тул её производит (см. `_extractText` в http.ts). */
export type ExecuteFn = (payload: unknown, auditId: string, ctx: AutoExecutorCtx) => Promise<string>;

export interface AutoExecutorEntry {
  rehash: RehashFn;
  execute: ExecuteFn;
}

const registry = new Map<string, AutoExecutorEntry>();

export function registerAutoExecutor(tool: string, entry: AutoExecutorEntry): void {
  if (registry.has(tool)) {
    // Может случиться при hot-reload в dev — в проде импорт модуля происходит
    // ровно один раз, так что молчаливая перезапись здесь безобиднее, чем
    // падение, но лог всё равно печатаем, чтобы не потерять сигнал о баге.
    console.error(`autoExecute: tool "${tool}" уже зарегистрирован — перезаписываю`);
  }
  registry.set(tool, entry);
}

export function getAutoExecutor(tool: string): AutoExecutorEntry | undefined {
  return registry.get(tool);
}

export function registeredAutoExecuteTools(): string[] {
  return [...registry.keys()];
}

/**
 * Исполняет `executor.execute` и ГАРАНТИРОВАННО фиксирует провал в
 * аудит-строке ЛЮБЫМ путём отказа — включая брошенное исключение, а не
 * только явный `outcome:"failed"`, который сам тул пишет ТОЛЬКО если успел
 * дойти до своего собственного `buildMutationResult`/эквивалента (пакет A3).
 * Без этой обёртки исключение, брошенное РАНЬШЕ той точки (сетевая ошибка на
 * первом же API-вызове, необработанное исключение внутри `execute` до сборки
 * отчёта), пролетает мимо `updateConsentAuditOutcome`, и аудит-строка,
 * которую `tryAutoExecute` уже записал как `outcome:"confirmed"` (ДО всякого
 * пруфа — см. её doc-comment в consent.ts), так и остаётся "confirmed" —
 * ложный ✅, который потом читает `buildAlreadyExecutedReport`.
 *
 * Вызывающие (`http.ts`'s `handlePendingConsentsDecide`/`runAutoExecutePoller`)
 * обязаны звать `execute` ТОЛЬКО через эту обёртку, никогда напрямую через
 * `executor.execute(...)`.
 *
 * `err` пробрасывается дальше НЕ модифицированным — обёртка только
 * гарантирует побочный эффект (аудит), решение, что показать пользователю/
 * модели по этому исключению, остаётся за вызывающим кодом (который уже
 * обязан не пересказывать `err.message` дословно наружу — security-checklist
 * §6 — поэтому текст, уходящий в САМ аудит, тоже прогнан через
 * `stripUrlQuery`, defense-in-depth: аудит не «лог» в смысле checklist, но
 * тот же принцип «меньше сырых секретов на диске» уместен и здесь).
 */
export async function runAutoExecutorSafely(
  executor: AutoExecutorEntry,
  payload: unknown,
  auditId: string,
  ctx: AutoExecutorCtx,
  updateConsentAuditOutcome: ConsentStore["updateConsentAuditOutcome"],
): Promise<string> {
  try {
    return await executor.execute(payload, auditId, ctx);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    try {
      await updateConsentAuditOutcome(auditId, { outcome: "failed", error: stripUrlQuery(raw) });
    } catch (auditErr) {
      // Не удалось даже это дописать — не глотаем, но и не заменяем ей
      // оригинальное исключение мутации (то, что реально важно вызывающему).
      console.error(
        `autoExecute: не смог записать outcome:"failed" в аудит ${auditId}: ` +
          (auditErr instanceof Error ? auditErr.message : String(auditErr)),
      );
    }
    throw err;
  }
}
