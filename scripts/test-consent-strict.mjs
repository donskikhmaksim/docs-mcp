#!/usr/bin/env node
/**
 * СТРОГИЙ ПРОТОКОЛ ПОДТВЕРЖДЕНИЯ — наборы приёмки (порт защиты из
 * Python-эталона ticktick-mcp, PR #15, ветка main, коммит 467018e).
 *
 * Закрываемая дыра: до этого согласие определялось через `.some()` — «хотя бы
 * один знакомый утвердительный токен где угодно во фразе». Поэтому «ок, кроме
 * последней» / «да, но третий пропусти» классифицировались как ЧИСТОЕ
 * согласие, и план исполнялся ЦЕЛИКОМ, включая явно исключённое. Слов-
 * ограничителей в словарях не было вообще.
 *
 * Порядок блоков здесь не случайный: РЕГРЕСС-НАБОР (обычные человеческие
 * подтверждения) идёт ПЕРВЫМ и важнее закрываемой дыры — если владелец не
 * может подтвердить нормальной фразой, это ХУЖЕ дыры.
 *
 * Всё offline: in-memory ConsentStore, инъекция часов, ни БД, ни сети, ни
 * живых Google API.
 *
 * Запуск: node scripts/test-consent-strict.mjs
 */
import { classifyReply, requireConsent, sha256, BURNING_REPLY_CLASSES } from "../src/consent.ts";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : ` — got: ${extra}`}`);
  if (!cond) failures++;
};

const ctx = { manifestId: "mid-1234", tool: "docs_replace_text" };
const cls = (s) => classifyReply(s, ctx);

// ═══════════════════════════════════════════════════════════════════════════
// [1] РЕГРЕСС: 33+21+1 нормальных человеческих подтверждения ОБЯЗАНЫ проходить
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[1] регресс-набор: обычные человеческие «да» ОБЯЗАНЫ оставаться согласием");

const AFFIRMATIVE_OK = [
  // 33 из задания
  "да", "Да.", "ДА", "ок", "окей", "ok", "okay", "давай", "подтверждаю",
  "подтверждено", "ага", "угу", "го", "погнали", "yes", "yep", "sure",
  "confirm", "approve", "+", "+1", "да, удаляй", "ок, давай",
  "да, только быстрее", "давай, пожалуйста", "хорошо", "договорились",
  "принято", "валяй", "да, всё верно", "да, правильно", "согласен",
  "подтверждаю, действуй",
  // ещё 21 из эталона
  "сделай", "ок, сделай", "да, сделай", "ок, спасибо", "давай уже",
  "ок, стартуем", "да, конечно", "конечно, давай", "ок, поехали",
  "да, вперёд", "ок, го", "верно, удаляй", "да, всё так",
  "подтверждаю удаление", "yes please", "do it", "go ahead", "sounds good",
  "ок, только аккуратно", "да, без проблем", "ну давай",
  // решение Максима (см. [2] ниже)
  "ладно, давай",
];
for (const s of AFFIRMATIVE_OK) check(`согласие: «${s}»`, cls(s) === "affirmation", cls(s));

// Регистр и лишние пробелы/пунктуация не должны ничего ломать.
console.log("\n[1b] регистр / пробелы / пунктуация");
for (const s of ["ДА", "Да.", "ОК!", "  да  ", "Да, Удаляй", "ХОРОШО", "Ага!"]) {
  check(`согласие: «${s}»`, cls(s) === "affirmation", cls(s));
}

// ═══════════════════════════════════════════════════════════════════════════
// [2] РЕШЕНИЕ МАКСИМА: «ладно» — не согласие, «ладно, давай» — согласие
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[2] «ладно» (единственное сознательное расхождение с Python-эталоном)");
check("«ладно» само по себе НЕ согласие", cls("ладно") !== "affirmation", cls("ладно"));
check("«ладно» → ambiguous (в FILLER, не в AFFIRMATIVE)", cls("ладно") === "ambiguous", cls("ладно"));
check("«ладно, давай» → согласие", cls("ладно, давай") === "affirmation", cls("ладно, давай"));
check("«ну ладно» НЕ согласие", cls("ну ладно") !== "affirmation", cls("ну ладно"));

// ═══════════════════════════════════════════════════════════════════════════
// [3] ГЛАВНАЯ ЛОВУШКА ПОРТА: русские маркеры и JS-`\b`
// ═══════════════════════════════════════════════════════════════════════════
// В JavaScript `\b` определён через `\w = [A-Za-z0-9_]`; кириллица туда НЕ
// входит, и флаг `u` этого не меняет. Механический перенос Python-регулярок
// молча отключил бы ВСЕ русские маркеры, оставив английские рабочими — и
// тесты на английских фразах были бы зелёными (ложное ощущение успеха).
console.log("\n[3] русские маркеры-ограничители реально срабатывают (ловушка JS-`\\b`)");
{
  // Сначала фиксируем САМУ ловушку, чтобы будущий рефакторинг «упростить до
  // \b» немедленно покраснел здесь, а не тихо снял защиту.
  check(
    "naive /\\bкроме\\b/ в JS НЕ ловит русское слово (это и есть ловушка)",
    /\bкроме\b/.test("ок, кроме последней") === false,
  );
  check(
    "naive /\\bexcept\\b/ ловит английское — вот почему EN-тесты были бы зелёными",
    /\bexcept\b/.test("ok, except last") === true,
  );
  check(
    "lookaround-вариант ловит русское слово",
    /(?<![\p{L}\p{N}_])кроме(?![\p{L}\p{N}_])/u.test("ок, кроме последней") === true,
  );
  // И теперь — что РЕАЛЬНАЯ реализация ловит русский ограничитель.
  check("«ок, кроме последней» → caveat (русский маркер работает)", cls("ок, кроме последней") === "caveat", cls("ок, кроме последней"));
  check("«ок, исключая последнюю» → caveat", cls("ок, исключая последнюю") === "caveat", cls("ок, исключая последнюю"));
  check("«ага, пропусти вторую» → caveat", cls("ага, пропусти вторую") === "caveat", cls("ага, пропусти вторую"));
  check("«давай, только вторую оставь» → caveat", cls("давай, только вторую оставь") === "caveat", cls("давай, только вторую оставь"));
  // Русские классы, кроме caveat, тоже обязаны срабатывать.
  check("русский hedge «наверное да» → hedge", cls("наверное да") === "hedge", cls("наверное да"));
  check("русский пересказ «он сказал да» → paraphrase", cls("он сказал да") === "paraphrase", cls("он сказал да"));
  check("русский set-phrase «да, всё верно» схлопывается → согласие", cls("да, всё верно") === "affirmation", cls("да, всё верно"));
  check("«да, без проблем» (русский set-phrase «без проблем») → согласие", cls("да, без проблем") === "affirmation", cls("да, без проблем"));
  // «только» гасится ТОЛЬКО наречием образа действия, и сортировка альтернатив
  // по убыванию длины обязана работать («быстрее» раньше «быстро»).
  check("«да, только быстрее» → согласие (manner-наречие гасит caveat)", cls("да, только быстрее") === "affirmation", cls("да, только быстрее"));
  check("«ок, только быстро» → согласие", cls("ок, только быстро") === "affirmation", cls("ок, только быстро"));
  check("«ок, только первые две» → caveat («только» без manner)", cls("ок, только первые две") === "caveat", cls("ок, только первые две"));
  // ГРАНИЦА после manner-наречия обязана быть настоящей: «внимательность» и
  // «осторожность» НАЧИНАЮТСЯ с «внимательно»/«осторожно», и без правой
  // границы в lookahead они гасили бы caveat-маркер «только» — ограничитель
  // молча переставал бы работать на целом классе фраз.
  check("«ок, только внимательность важна» → caveat (не префикс наречия)", cls("ок, только внимательность важна") === "caveat", cls("ок, только внимательность важна"));
  check("«ок, только осторожность нужна» → caveat", cls("ок, только осторожность нужна") === "caveat", cls("ок, только осторожность нужна"));
  check("«давай, только быстрого не жди» → caveat", cls("давай, только быстрого не жди") === "caveat", cls("давай, только быстрого не жди"));
}

// ═══════════════════════════════════════════════════════════════════════════
// [4] 17 ОПАСНЫХ реплик: класс + сжигается ли план
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[4] 17 опасных реплик — класс и «сжигает ли план»");
const DANGEROUS = [
  ["делай, я передумал насчёт третьей", "ambiguous", false],
  ["ок, кроме последней", "caveat", true],
  ["удали первые три, а последнюю не надо", "caveat", true],
  ["confirm, but skip the last one", "caveat", true],
  ["давай, только вторую оставь", "caveat", true],
  ["да, всё верно, но подожди с третьей", "negation", true],
  ["нет", "negation", true],
  ["отмена", "negation", true],
  ["стоп", "negation", true],
  ["Пользователь: да", "paraphrase", false],
  ["он сказал да", "paraphrase", false],
  ["наверное да", "hedge", false],
  ["думаю да", "hedge", false],
  ["делай что хочешь", "hedge", false],
  ["да, но сначала покажи ещё раз", "ambiguous", false],
  ["ок, если ты уверен", "ambiguous", false],
  // «расширение плана»: не отказ и не оговорка, но исполнять нельзя.
  ["да, и заодно удали ещё вон ту", "ambiguous", false],
];
for (const [reply, expected, burns] of DANGEROUS) {
  const got = cls(reply);
  check(`«${reply}» → ${expected}`, got === expected, got);
  check(`«${reply}» — план ${burns ? "СОЖЖЁН" : "ЖИВ"}`, BURNING_REPLY_CLASSES.has(got) === burns, String(BURNING_REPLY_CLASSES.has(got)));
  check(`«${reply}» — НЕ согласие`, got !== "affirmation", got);
}

// ═══════════════════════════════════════════════════════════════════════════
// [5] CAVEAT — 13 оговорок, все сжигают план
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[5] CAVEAT (13) — частичное согласие, план аннулируется");
for (const s of [
  "удали первые три, а последнюю не надо",
  "ок, кроме последней",
  "confirm, but skip the last one",
  "давай, только вторую оставь",
  "ок, только первые две",
  "да, но не третью",
  "да, все кроме созвона",
  "delete all except the last",
  "ок, исключая последнюю",
  "удали, без последней",
  "ok, all but the last one",
  "да, только молоко и хлеб",
  "ага, пропусти вторую",
]) {
  check(`caveat: «${s}»`, cls(s) === "caveat", cls(s));
  check(`caveat сжигает план: «${s}»`, BURNING_REPLY_CLASSES.has(cls(s)));
}

// ═══════════════════════════════════════════════════════════════════════════
// [6] LATE_NEGATION — отрицание в конце фразы, план сжигается
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[6] LATE_NEGATION (7 + «да нет наверное») — отрицание где угодно во фразе");
for (const s of [
  "да, всё верно, но подожди с третьей",
  "ок, всё правильно, но нет",
  "да, всё так, но стоп",
  "конечно, всё верно, отмена",
  "yes, everything is right, but wait",
  "да, я посмотрел план, нельзя",
  "ок, я всё проверил, отбой",
]) {
  check(`late-negation: «${s}» НЕ согласие`, cls(s) !== "affirmation", cls(s));
  check(`late-negation: «${s}» сжигает план`, BURNING_REPLY_CLASSES.has(cls(s)), cls(s));
}
check("«да нет наверное» НЕ согласие", cls("да нет наверное") !== "affirmation", cls("да нет наверное"));
check("«да нет наверное» сжигает план", BURNING_REPLY_CLASSES.has(cls("да нет наверное")), cls("да нет наверное"));

// ═══════════════════════════════════════════════════════════════════════════
// [7] PARAPHRASE — пересказ вместо реплики, план НЕ сжигается
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[7] PARAPHRASE (10) — модель пересказывает человека; план остаётся живым");
for (const s of [
  "Пользователь: да",
  "юзер: ок",
  "он сказал да",
  "она сказала ок",
  "он ответил да",
  "yes (по словам пользователя)",
  "user: yes",
  "the user said yes",
  "пользователь подтвердил",
  "he confirmed",
]) {
  check(`paraphrase: «${s}»`, cls(s) === "paraphrase", cls(s));
  check(`paraphrase НЕ сжигает план: «${s}»`, !BURNING_REPLY_CLASSES.has(cls(s)));
}

// ═══════════════════════════════════════════════════════════════════════════
// [8] ECHO — служебный жаргон сервера (адаптирован под docs-*)
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[8] ECHO (8) — ровно то, что печатает модель, подтверждающая сама себя");
for (const s of [
  "DELETE 5",
  "delete 3",
  "CREATE 2",
  "REPLACE 1",
  'docs_replace_text(manifest_id="abc")',
  'docs_create(items=[{"title":"x"}])',
  "манифест manifest_id=abc123",
  '{"decision":"approved","user_reply":"да"}',
]) {
  check(`echo: «${s}»`, cls(s) === "echo", cls(s));
  check(`echo НЕ сжигает план: «${s}»`, !BURNING_REPLY_CLASSES.has(cls(s)));
}
check("id самого манифеста → echo", cls("mid-1234") === "echo", cls("mid-1234"));
check("имя инструмента → echo", cls("docs_replace_text") === "echo", cls("docs_replace_text"));

// ═══════════════════════════════════════════════════════════════════════════
// [9] Прямые отказы / неуверенность / пустое / ложные отказы / длина
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[9a] прямые отказы — сжигают план");
for (const s of ["нет", "отмена", "стоп", "не надо", "no", "cancel", "нет, отмена", "погоди"]) {
  check(`negation: «${s}»`, cls(s) === "negation", cls(s));
  check(`negation сжигает план: «${s}»`, BURNING_REPLY_CLASSES.has(cls(s)));
}

console.log("\n[9b] неуверенность/безразличие — НЕ согласие, план НЕ сжигается");
for (const s of [
  "ладно", "ну ладно", "делай что хочешь", "мне всё равно", "как скажешь",
  "наверное да", "думаю да", "может быть да", "да, наверное", "whatever, go",
]) {
  check(`не согласие: «${s}»`, cls(s) !== "affirmation", cls(s));
  check(`план жив: «${s}»`, !BURNING_REPLY_CLASSES.has(cls(s)), cls(s));
}

console.log("\n[9c] пустое — ни согласие, ни отказ, план жив");
for (const s of ["", null, undefined, "   ", "\n\t "]) {
  const got = classifyReply(s, ctx);
  check(`empty: ${JSON.stringify(s)}`, got === "empty", got);
  check(`empty не сжигает план: ${JSON.stringify(s)}`, !BURNING_REPLY_CLASSES.has(got));
}

console.log("\n[9d] осознанные ложные отказы — не согласие И план не сжигается");
for (const s of ["ок, но быстро", "да, удали эти", "удали первые три", "да, всё"]) {
  check(`не согласие: «${s}»`, cls(s) !== "affirmation", cls(s));
  check(`план жив: «${s}»`, !BURNING_REPLY_CLASSES.has(cls(s)), cls(s));
}

console.log("\n[9e] длина и «только filler»");
check("9 подряд «да» (> лимита 8) → НЕ согласие", cls("да ".repeat(9).trim()) !== "affirmation", cls("да ".repeat(9).trim()));
check("8 подряд «да» (на пределе) → согласие", cls("да ".repeat(8).trim()) === "affirmation", cls("да ".repeat(8).trim()));
for (const s of ["пожалуйста", "только быстрее", "ну"]) {
  check(`только filler без affirmative: «${s}» → НЕ согласие`, cls(s) !== "affirmation", cls(s));
}

console.log("\n[9f] эмодзи — незнакомый токен (осознанная цена строгости)");
check("«да 👍» → ambiguous", cls("да 👍") === "ambiguous", cls("да 👍"));

// ═══════════════════════════════════════════════════════════════════════════
// [10] Интеграция с requireConsent: последствия классов на живом манифесте
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[10] интеграция: последствия для манифеста (сжигается / остаётся живым)");

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
      manifests.set(input.id, { ...input, status: "AWAITING_CONSENT", consumedAt: null, userReply: null });
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

async function execWith(userReply) {
  clock.t = 1_700_000_000_000;
  const store = makeStore();
  const planned = await requireConsent({ tool: "docs_replace_text", accountLabel: "work", plan, rehash, store, cfg });
  clock.t += 3_000;
  const dec = await requireConsent({
    tool: "docs_replace_text", accountLabel: "work",
    manifestId: planned.manifestId, userReply, plan, rehash, store, cfg,
  });
  return { dec, status: store.manifests.get(planned.manifestId).status, store };
}

{
  // Главный боевой сценарий закрытой дыры.
  const r = await execWith("ок, кроме последней");
  check("«ок, кроме последней» → НЕ исполнено", r.dec.kind === "refused", r.dec.kind);
  check("«ок, кроме последней» → манифест INVALIDATED (перепланировать)", r.status === "INVALIDATED", r.status);
  check("отказ объясняет, что план частично не исполняется", /част/i.test(r.dec.result), r.dec.result.slice(0, 80));
  check("отказ несёт маркер 🛑", r.dec.result.includes("🛑"), r.dec.result.slice(0, 20));
  // Кодировка: русская подстрока обязана дойти ЦЕЛОЙ (сравнение строк, не
  // байтов в неверной кодировке — иначе распознавание по русскому тексту
  // просто не срабатывало бы, а «дефекты» оказывались бы фантомами).
  check(
    "русский текст отказа не побит кодировкой",
    r.dec.result.includes("План аннулирован") && !/[?]{3,}/.test(r.dec.result),
    r.dec.result.slice(0, 120),
  );
}
{
  const r = await execWith("да, но сначала покажи ещё раз");
  check("«да, но сначала покажи ещё раз» → НЕ исполнено", r.dec.kind === "refused", r.dec.kind);
  check("...и манифест ЖИВ (можно ответить снова)", r.status === "AWAITING_CONSENT", r.status);
  check("отказ просит ответить одним словом", /одним словом/i.test(r.dec.result), r.dec.result.slice(0, 120));
}
{
  const r = await execWith("Пользователь: да");
  check("пересказ → НЕ исполнено", r.dec.kind === "refused", r.dec.kind);
  check("пересказ → манифест ЖИВ", r.status === "AWAITING_CONSENT", r.status);
  check("отказ требует реплику ДОСЛОВНО", /дословно/i.test(r.dec.result), r.dec.result.slice(0, 120));
}
{
  const r = await execWith("наверное да");
  check("неуверенность → НЕ исполнено", r.dec.kind === "refused", r.dec.kind);
  check("неуверенность → манифест ЖИВ", r.status === "AWAITING_CONSENT", r.status);
}
{
  const r = await execWith('docs_replace_text(manifest_id="abc")');
  check("echo → НЕ исполнено", r.dec.kind === "refused", r.dec.kind);
  check("echo → манифест ЖИВ", r.status === "AWAITING_CONSENT", r.status);
}
{
  const r = await execWith("да, всё верно, но подожди с третьей");
  check("late-negation → НЕ исполнено", r.dec.kind === "refused", r.dec.kind);
  check("late-negation → манифест INVALIDATED", r.status === "INVALIDATED", r.status);
}
{
  const r = await execWith("да, заменяй");
  check("нормальное согласие → исполнено", r.dec.kind === "confirmed", r.dec.kind);
  check("нормальное согласие → манифест DONE", r.status === "DONE", r.status);
  check("класс в аудите — affirmation", r.store.audits.at(-1).checks.reply === "affirmation", JSON.stringify(r.store.audits.at(-1).checks));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
