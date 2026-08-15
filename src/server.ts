import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { loadConsentGateConfig, loadTgApprovalConfig } from "./config.js";
import { buildUserClients, registerAccountTools } from "./accounts.js";
import { registerDocsTools, type DocsConsentContext } from "./tools/docs.js";
import type { ConsentStore, ConsentConfig } from "./consent.js";
// NOTE (deviation from the gmail-mcp source this was ported from): gmail-mcp's
// own consent.ts already declares a `TgApprovalGate` interface (added there
// alongside the `tg?: TgApprovalGate` field on `RequireConsentParams` — see
// that file's doc-comment on why it's duplicated rather than imported from
// this module). docs-mcp's consent.ts does NOT have that field/type yet (this
// port was explicitly told not to touch consent.ts — see the port's task
// notes). tg_approval.ts exports its own structurally-identical copy of
// `TgApprovalGate` for exactly this DI reason, so importing it from there
// works today; once consent.ts gains its own `tg?: TgApprovalGate` field
// (a follow-up requiring Maksim's sign-off), this import can switch back to
// "./consent.js" to match gmail-mcp exactly.
import type { TgApprovalStore, TgApprovalGate } from "./tg_approval.js";
import { createTgApprovalGate } from "./tg_approval.js";
import { checkAutomationKey } from "./automation_key.js";
import {
  storeReady,
  createManifest,
  getManifest,
  consumeManifest,
  invalidateManifest,
  appendConsentAudit,
  updateConsentAuditOutcome,
  getExecutionAudit,
  listConsentAudit,
  countConsentAudit,
  createTgApproval,
  getTgApproval,
  consumeTgDecision,
  consumeTgDecisionAnyServer,
} from "./store.js";

/**
 * store.ts's consent-gate functions (ported from gmail-mcp package A1), typed
 * against consent.ts's `ConsentStore` here — signature-for-signature by
 * construction, but the `: ConsentStore` annotation means a drift fails THIS
 * build, not the tool file's.
 */
export const consentStoreAdapter: ConsentStore = {
  createManifest,
  getManifest,
  consumeManifest,
  invalidateManifest,
  appendConsentAudit,
  updateConsentAuditOutcome,
  // Опциональный метод контракта (consent.ts): позволяет sync-wait'у вложить
  // в отчёт `already_executed` фактический пруф post-verify того канала,
  // который реально исполнил план. Без него отчёт остался бы честным, но
  // пустым («результат не удалось перепроверить»).
  getExecutionAudit,
};

/**
 * Read-only adapter for `docs_consent_audit` — separate from
 * `consentStoreAdapter` above (the plan/execute gate contract) since this is
 * a different, purely-reading surface: "разбор инцидента без ssh"
 * (limits-audit.md §11).
 */
export const auditStoreAdapter = { listConsentAudit, countConsentAudit };

/** This server's identity ($self = "docs") in the shared consent_manifests/
 * consent_audit tables, plus the gate's TTL/anti-doublet/batch-cap knobs —
 * env-driven, see `loadConsentGateConfig` in config.ts. `now` is left unset
 * here (real `Date.now`); consent.ts's `now` injection exists for OFFLINE
 * UNIT TESTS only. */
const consentGateEnv = loadConsentGateConfig();
export const consentServerConfig: ConsentConfig = {
  server: consentGateEnv.server,
  consentTtlMs: consentGateEnv.consentTtlMs,
  minConsentGapMs: consentGateEnv.minConsentGapMs,
  sendBatchMax: consentGateEnv.sendBatchMax,
  syncWaitMs: consentGateEnv.syncWaitMs,
  syncPollMs: consentGateEnv.syncPollMs,
};

/**
 * Optional Telegram-approval layer (plan-tg-approval.md). Loaded once at
 * module scope, same as `consentGateEnv`/`consentServerConfig` above — this
 * throws loudly at process start if TG_APPROVAL_ENABLED=true but misconfigured
 * (package P0), rather than silently degrading. Exported so http.ts can mount
 * `/tg/webhook` and call `registerWebhook()` at startup without re-deriving it.
 */
export const tgApprovalConfig = loadTgApprovalConfig(consentGateEnv.server);

/** store.ts's tg_approvals functions (package P1), typed against
 * tg_approval.ts's `TgApprovalStore` here — signature-for-signature by
 * construction, same discipline as `consentStoreAdapter` above. */
export const tgApprovalStoreAdapter: TgApprovalStore = {
  createTgApproval,
  getTgApproval,
  consumeTgDecision,
  consumeTgDecisionAnyServer,
};

/**
 * The gate object wired into every gated tool's `requireConsent({ tg })`.
 * Always constructed (even when TG_APPROVAL_ENABLED=false) so call sites never
 * branch on its presence — `enabledFor()` is simply false for every tool in
 * that case, which is the whole compatibility invariant (plan §0): a fork
 * without a configured Telegram bot behaves byte-for-byte as before this
 * feature existed, because this gate never calls into `tgApprovalStoreAdapter`
 * unless `enabledFor(tool)` says so, and that itself is always false when
 * disabled — regardless of whether Postgres is configured at all.
 *
 * NOT YET actually threaded into `requireConsent()` calls in tools/docs.ts —
 * consent.ts here doesn't accept a `tg` param yet (see the import note atop
 * this file). `consentCtx.tg` below carries it as far as the context object;
 * the last wiring step is deliberately left undone pending that consent.ts
 * change.
 */
export const tgApprovalGate: TgApprovalGate = createTgApprovalGate(tgApprovalConfig, tgApprovalStoreAdapter);

export function buildMcpServer(user: User): McpServer {
  const clients = buildUserClients(user);
  const accountsHint = clients.multi
    ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
    : `One Google account ("${clients.defaultName}") is configured.`;

  const server = new McpServer(
    { name: "docs-mcp", version: "1.0.0" },
    { instructions: "Tools to read and edit Google Docs. Use docs_list to find documents, then read or edit by id. " + accountsHint },
  );
  // Honest degradation (gate.md §3.5): `consentStore`/`auditStore` are null
  // exactly when Postgres isn't configured — without it there's nowhere to
  // persist a manifest, so the gated write tools refuse outright rather than
  // mutate unconfirmed.
  const consentCtx: DocsConsentContext = {
    consentStore: storeReady() ? consentStoreAdapter : null,
    consentCfg: consentServerConfig,
    auditStore: storeReady() ? auditStoreAdapter : null,
    tg: tgApprovalGate,
    // automation_key (docs/TZ_automation_key_consent_gate.md): undefined
    // exactly when Postgres isn't configured, same honest-degradation
    // convention as consentStore/auditStore above — checkAutomationKey.js
    // itself already no-ops safely without a store, but keeping the branch
    // absent (not just returning false) matches consent.ts's documented
    // invariant that undefined fully disables the automation_key path.
    checkAutomationKey: storeReady() ? checkAutomationKey : undefined,
  };
  registerAccountTools(server, clients);
  registerDocsTools(server, clients, consentCtx);
  return server;
}
