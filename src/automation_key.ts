/**
 * automation_key.ts — READ-ONLY check against the shared `tg_automation_windows`
 * table (`docs/TZ_automation_key_consent_gate.md`). Generation of the key
 * lives ONLY in gmail-mcp (`gmail-mcp/src/automation_key.ts` — единая
 * генерация на всю экосистему: gmail/calendar/drive/sheets/docs/ticktick).
 * This module never writes a row — it only answers "does the presented key
 * open automation_key-gated execution for docs-mcp right now".
 *
 * DI contract consumed by `consent.ts`'s `checkAutomationKey?: (key) =>
 * Promise<{ ok, channel? }>` on `RequireConsentParams`. Wired into every
 * gated tool's `requireConsent()` call from `server.ts`, the same way
 * `consentStoreAdapter`/`tgApprovalGate` are wired there.
 *
 * Ported logic (not code — different language) from ticktick-mcp's
 * `automation_key.py`'s `_scope_covers_me`/`find_window`/`_digest_matches`:
 * same fail-closed scope rule, same constant-time hash compare, same "read
 * ALL active rows across the whole shared table, filter by scope in
 * application code" shape (the table isn't filtered by any `server` column
 * in SQL — it's genuinely multi-service).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { storeReady, listActiveAutomationWindows } from "./store.js";

/** This server's canonical name in `tg_automation_windows.scope`
 * (`docs/TZ_automation_key_hub.md`'s canonical list: gmail/calendar/drive/
 * sheets/docs/ticktick). NOT a tool argument — same $self convention as
 * `ConsentConfig.server`. */
const SELF_SERVICE = "docs";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests. Both operands are already
 * ASCII hex (sha256 output / a column read from Postgres), so comparing the
 * raw bytes via `Buffer.from(x, "hex")` is safe — unlike comparing the
 * PROVIDED key itself byte-for-byte, which would leak timing on arbitrary
 * (possibly non-ASCII) attacker input. Mismatched lengths (or an empty
 * digest — malformed row) → false, never throws. */
function digestMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** `scope` covers "docs" iff it's literally "all", or "docs" is one of its
 * comma-separated tokens — exact token match, NOT a substring ("docsx" must
 * NOT match "docs"). Empty/NULL scope (a pre-migration row that never got
 * backfilled) is treated as NOT covering — fail-closed: a silent false
 * match is worse than an honest refusal here. */
function scopeCoversMe(scope: string | null): boolean {
  if (!scope) return false;
  const s = scope.trim();
  if (s === "all") return true;
  return s
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(SELF_SERVICE);
}

export interface AutomationKeyCheck {
  ok: boolean;
  /** `window:<createdAt>` — which active window matched (epoch-ms of its
   * creation), so the consent audit can tell WHICH window opened the door
   * when several are active at once (mirrors gmail/ticktick-mcp's
   * `_automation_key_channel`). Present only when `ok` is true. */
  channel?: string;
}

/**
 * Checks `provided` against every currently-active `tg_automation_windows`
 * row whose scope covers "docs". No static `AUTOMATION_KEY` channel here —
 * docs-mcp doesn't define one today (see `config.ts`; only gmail-mcp does at
 * the time of writing, `docs/TZ_automation_key_consent_gate.md` §"Что менять
 * — сервер" п.1 — "если нет, просто не будет канала static"). If one is
 * added later, wire it in here the same way ticktick-mcp's `matches_static`
 * does, checked BEFORE the window loop (cheap, no DB round trip).
 *
 * Never throws: an unconfigured store (`storeReady()` false) or an empty
 * `provided` both resolve to `{ ok: false }`, same fail-closed/silent
 * discipline as everywhere else in this file — this function's caller
 * (`consent.ts`'s automation_key branch) is documented to treat `ok: false`
 * as a silent fallthrough, never a visible error.
 */
export async function checkAutomationKey(provided: string): Promise<AutomationKeyCheck> {
  if (!provided || !storeReady()) return { ok: false };
  const providedHash = sha256Hex(provided);
  const windows = await listActiveAutomationWindows(Date.now());
  for (const w of windows) {
    if (!scopeCoversMe(w.scope)) continue;
    if (digestMatches(w.tokenHash, providedHash)) {
      return { ok: true, channel: `window:${w.createdAt}` };
    }
  }
  return { ok: false };
}
