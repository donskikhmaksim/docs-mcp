#!/usr/bin/env node
/**
 * Offline unit-тест `runAutoExecutorSafely` (`src/autoExecute.ts`) —
 * гарантированная фиксация провала мутации в аудит-строке ЛЮБЫМ путём отказа
 * `executor.execute`, включая брошенное исключение, а не только явный
 * отрицательный результат.
 *
 * ПОЧЕМУ ЭТА ОБЁРТКА НУЖНА (найдено независимой ревизией): `tryAutoExecute`
 * (consent.ts) пишет аудит-строку с `outcome:"confirmed"` СИНХРОННО с
 * `consumeManifest`, ДО того как `executor.execute` реально запустился —
 * см. её doc-comment. Если `execute` бросает исключение (не просто
 * возвращает ошибку внутри собственного отчёта), а вызывающий код
 * (`http.ts`'s `handlePendingConsentsDecide`/`runAutoExecutePoller`) звал бы
 * `executor.execute` НАПРЯМУЮ, аудит-строка так и осталась бы
 * `outcome:"confirmed"` без пруфа — ложный ✅, который потом читает
 * `buildAlreadyExecutedReport`. `runAutoExecutorSafely` — единственная точка,
 * через которую оба вызывающих обязаны звать `execute`.
 *
 * Запуск: node scripts/test-run-auto-executor-safely.mjs (нужен предварительный
 * `npm run build` — импортирует СКОМПИЛИРОВАННЫЙ dist/, тот же приём, что
 * test-auto-execute-t1.mjs: autoExecute.ts импортирует consent.js по
 * NodeNext-конвенции (`./consent.js` → `./consent.ts` резолвит только tsc/
 * tsx, голый `node` без loader-хука это не переписывает).
 */
import { runAutoExecutorSafely } from "../dist/autoExecute.js";
import { stripUrlQuery } from "../dist/consent.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
};

function makeUpdateOutcome() {
  const calls = [];
  const fn = async (auditId, outcome) => {
    calls.push({ auditId, ...outcome });
  };
  return { fn, calls };
}

console.log("\n[1] happy path — execute отработал, updateConsentAuditOutcome НЕ вызывается (тул сам пишет свой исход)");
{
  const { fn, calls } = makeUpdateOutcome();
  const executor = { rehash: async () => "h", execute: async (payload, auditId) => `отчёт для ${auditId}` };
  const text = await runAutoExecutorSafely(executor, { a: 1 }, "audit-1", {}, fn);
  check("вернул текст отчёта тула как есть", text === "отчёт для audit-1", text);
  check("updateConsentAuditOutcome НЕ вызван (нет провала — тул сам отвечает за свой аудит)", calls.length === 0, JSON.stringify(calls));
}

console.log("\n[2] execute БРОСАЕТ исключение → outcome:\"failed\" гарантированно записан, исключение пробрасывается дальше");
{
  const { fn, calls } = makeUpdateOutcome();
  const boom = new Error("ECONNRESET: upstream unreachable");
  const executor = { rehash: async () => "h", execute: async () => { throw boom; } };
  let thrown = null;
  try {
    await runAutoExecutorSafely(executor, { a: 1 }, "audit-2", {}, fn);
  } catch (e) {
    thrown = e;
  }
  check("исключение пробрасывается дальше (вызывающий код узнаёт о провале)", thrown === boom);
  check("updateConsentAuditOutcome вызван РОВНО один раз", calls.length === 1, JSON.stringify(calls));
  check("outcome:\"failed\"", calls[0]?.outcome === "failed", JSON.stringify(calls[0]));
  check("auditId совпадает с переданным", calls[0]?.auditId === "audit-2");
  check("текст ошибки записан", calls[0]?.error?.includes("ECONNRESET"), calls[0]?.error);
}

console.log("\n[3] execute бросает исключение с URL+query в тексте → query вырезан ДО записи в аудит (defense-in-depth)");
{
  const { fn, calls } = makeUpdateOutcome();
  const boom = new Error("403 at https://storage.googleapis.com/bucket/f?X-Goog-Signature=SECRET777&Expires=1");
  const executor = { rehash: async () => "h", execute: async () => { throw boom; } };
  await runAutoExecutorSafely(executor, {}, "audit-3", {}, fn).catch(() => {});
  check("токен из query НЕ попал в аудит", !calls[0]?.error?.includes("SECRET777"), calls[0]?.error);
  check("host+path остались", calls[0]?.error?.includes("storage.googleapis.com/bucket/f"), calls[0]?.error);
}

console.log("\n[4] и execute, И запись в аудит падают → исходное исключение мутации не теряется (не заменяется ошибкой аудита)");
{
  const boom = new Error("mutation failed");
  const auditBoom = new Error("db down");
  const executor = { rehash: async () => "h", execute: async () => { throw boom; } };
  const failingUpdate = async () => { throw auditBoom; };
  let thrown = null;
  try {
    await runAutoExecutorSafely(executor, {}, "audit-4", {}, failingUpdate);
  } catch (e) {
    thrown = e;
  }
  check("пробрасывается ИСХОДНОЕ исключение мутации, не ошибка записи аудита", thrown === boom, String(thrown));
}

console.log("\n[5] stripUrlQuery — юнит: вырезает query у http(s) URL, не трогает остальной текст");
{
  check(
    "вырезает query, оставляет host+path",
    stripUrlQuery("see https://x.example.com/a/b?token=SECRET&x=1 for details") ===
      "see https://x.example.com/a/b for details",
  );
  check("текст без URL не меняется", stripUrlQuery("plain error, no links here") === "plain error, no links here");
  check("несколько URL в одной строке — оба очищены", !stripUrlQuery("https://a.com/x?t=1 and https://b.com/y?t=2").includes("t=1") && !stripUrlQuery("https://a.com/x?t=1 and https://b.com/y?t=2").includes("t=2"));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
