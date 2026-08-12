/**
 * automation_key.ts — READ-ONLY check against the shared `tg_automation_windows`
 * table (`docs/TZ_automation_key_consent_gate.md`). Generation of the key
 * lives ONLY in gmail-mcp (`gmail-mcp/src/automation_key.ts` — единая
 * генерация на всю экосистему: gmail/calendar/drive/sheets/docs/ticktick).
 * This module never writes a row — it only answers "does the presented key
 * open automation_key-gated execution for docs-mcp right now".
 *
 * DI contract consumed by `consent.ts`'s `checkAutomationKey?: (key, tool) =>
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
 *
 * `scopeCovers` (`docs/TZ_automation_key_method_catalog.md`) extends the old
 * whole-service-only comparison to also accept `<service>:<tool>` tokens, so
 * a `tg_automation_windows` row can grant a single method (e.g. `docs:
 * docs_create`) instead of the entire service — without any DB migration:
 * old bare-service rows keep covering every method exactly as before.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { storeReady, listActiveAutomationWindows } from "./store.js";

/** This server's canonical name in `tg_automation_windows.scope`
 * (`docs/TZ_automation_key_hub.md`'s canonical list: gmail/calendar/drive/
 * sheets/docs/ticktick). NOT a tool argument — same $self convention as
 * `ConsentConfig.server`. Exported so `gated_tools_catalog.ts` and `http.ts`
 * can stamp the same canonical name onto the `/automation-key-catalog`
 * response without duplicating the literal string. */
export const AUTOMATION_SERVICE = "docs";

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

/**
 * `scope` covers `<service>` (whole-service, old behaviour) iff it's
 * literally "all", or `service` is one of its comma-separated tokens.
 * `scope` covers a SPECIFIC method (`docs/TZ_automation_key_method_catalog.md`)
 * iff one of its tokens is exactly `${service}:${tool}`.
 *
 * Exact token match (`===`) throughout — NOT a substring/`startsWith`: a
 * bare-service token must not match a method of a differently-prefixed
 * service ("google-sheets" must not match "sheets"), and a method token must
 * not match another method that merely shares a prefix
 * ("docs:docs_create" must not match "docs:docs_create_extra").
 *
 * Empty/NULL scope (a pre-migration row that never got backfilled) is
 * treated as NOT covering — fail-closed: a silent false match is worse than
 * an honest refusal here.
 *
 * Backward compatibility: an already-issued bare-service token
 * (`scope="docs"` or `scope="docs,gmail"`) keeps covering EVERY method of
 * that service, exactly as before this function gained the `tool` parameter
 * — no DB migration needed, this is purely a comparison-logic change.
 */
export function scopeCovers(scope: string | null, service: string, tool: string): boolean {
  if (!scope) return false;
  const s = scope.trim();
  if (s === "all") return true;
  const tokens = s
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return tokens.some((t) => t === service || t === `${service}:${tool}`);
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
 * row whose scope covers "docs" — either the whole service or specifically
 * `tool` (`docs/TZ_automation_key_method_catalog.md`). No static
 * `AUTOMATION_KEY` channel here — docs-mcp doesn't define one today (see
 * `config.ts`; only gmail-mcp does at the time of writing,
 * `docs/TZ_automation_key_consent_gate.md` §"Что менять — сервер" п.1 —
 * "если нет, просто не будет канала static"). If one is added later, wire it
 * in here the same way ticktick-mcp's `matches_static` does, checked BEFORE
 * the window loop (cheap, no DB round trip).
 *
 * Never throws: an unconfigured store (`storeReady()` false) or an empty
 * `provided` both resolve to `{ ok: false }`, same fail-closed/silent
 * discipline as everywhere else in this file — this function's caller
 * (`consent.ts`'s automation_key branch) is documented to treat `ok: false`
 * as a silent fallthrough, never a visible error.
 */
export async function checkAutomationKey(provided: string, tool: string): Promise<AutomationKeyCheck> {
  if (!provided || !storeReady()) return { ok: false };
  const providedHash = sha256Hex(provided);
  const windows = await listActiveAutomationWindows(Date.now());
  for (const w of windows) {
    if (!scopeCovers(w.scope, AUTOMATION_SERVICE, tool)) continue;
    if (digestMatches(w.tokenHash, providedHash)) {
      return { ok: true, channel: `window:${w.createdAt}` };
    }
  }
  return { ok: false };
}
