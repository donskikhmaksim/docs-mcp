/**
 * gated_tools_catalog.ts — auto-discovers every automation_key-gated tool
 * this server registers, so the hub UI (gmail-mcp's mini-app, per
 * `docs/TZ_automation_key_method_catalog.md`) can offer per-method
 * `scope="docs:<tool>"` windows without ANYONE hand-maintaining a list.
 *
 * "Gated" ⟺ the tool's JSON schema (as returned by the MCP protocol's
 * `tools/list`) carries an `automation_key` property — every tool that goes
 * through `requireConsent()` is already REQUIRED to expose that Zod
 * parameter (`docs/TZ_automation_key_consent_gate.md`), so this definition is
 * exact, not a heuristic.
 *
 * Discovery method (mandated by the TZ, §"Разведка"): `InMemoryTransport.
 * createLinkedPair()` + a real `Client.listTools()` call — the SDK's own
 * public, protocol-guaranteed way to ask a server what it has, used by the
 * SDK's own test suite (and already by `scripts/test-automation-key.mjs`
 * [7] in this repo). Deliberately NOT reading McpServer's private
 * `_registeredTools` field — that's an implementation detail, not a
 * contract, and would silently break on an SDK upgrade. `InMemoryTransport`
 * IS available in the installed SDK version, so no fallback was needed.
 *
 * This module builds its OWN throwaway `McpServer` for the call, rather than
 * introspecting the live production server object. Two reasons:
 *   1. `buildMcpServer(user)` (server.ts) needs a real, OAuth-linked `User`
 *      — there is no such thing for an unauthenticated catalog request.
 *   2. An `McpServer` can only be `connect()`ed to one transport at a time;
 *      the live server per HTTP request is already bound to its own
 *      `StreamableHTTPServerTransport` (http.ts), so reusing it here would
 *      fight that binding.
 * This is safe because the SET OF TOOLS docs-mcp registers does NOT depend
 * on which Google accounts/user are wired in — `registerDocsTools` always
 * registers the same fixed 8 tools regardless of `UserClients` content (only
 * per-parameter DESCRIPTION TEXT, e.g. the `account` field's doc string,
 * varies with `clients.multi`/`clients.names` — irrelevant to "does this
 * tool exist and is it gated"). So the catalog below reflects the tool set
 * for docs-mcp as a whole, not any particular user, and a single synthetic
 * stub account is enough to satisfy `registerDocsTools`'s parameter shape.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAccountTools, type UserClients } from "./accounts.js";
import { registerDocsTools } from "./tools/docs.js";

/** One entry of the catalog served at `GET /automation-key-catalog`. */
export interface GatedToolInfo {
  name: string;
  description: string;
}

/** Descriptions on the gated docs tools run a few hundred characters (full
 * plan/execute usage instructions) — too long for a UI checkbox list. Cut to
 * a UI-reasonable length; the full description remains available from the
 * tool's own `tools/list` response for anything that actually needs it. */
const MAX_DESCRIPTION_LEN = 160;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/**
 * Synthetic, single-account `UserClients` used ONLY to satisfy
 * `registerDocsTools`'s parameter shape while building the throwaway
 * catalog server below. `resolve()` throws if ever called — the catalog
 * server's tools are never actually invoked, only enumerated via
 * `tools/list`, so this should be unreachable; the throw is a tripwire in
 * case that assumption is ever violated.
 */
function catalogClients(): UserClients {
  return {
    names: ["catalog"],
    defaultName: "catalog",
    multi: false,
    resolve() {
      throw new Error(
        "gated_tools_catalog: resolve() called — the catalog server's tools " +
          "must only ever be enumerated (tools/list), never executed.",
      );
    },
    baseGmailQuery: () => "",
  };
}

/**
 * Builds a throwaway server carrying every tool docs-mcp registers, asks it
 * (via the real MCP protocol, in-memory) which tools exist, and returns only
 * the ones whose input schema exposes `automation_key` — i.e. the ones that
 * go through `requireConsent()`. Closes both ends of the transport pair
 * before returning so nothing leaks past this call.
 */
export async function listGatedTools(): Promise<GatedToolInfo[]> {
  const server = new McpServer({ name: "docs-mcp-catalog", version: "0" });
  registerAccountTools(server, catalogClients());
  registerDocsTools(server, catalogClients());

  const client = new Client({ name: "docs-mcp-gated-tools-catalog", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools
      .filter((t) => {
        const props = t.inputSchema?.properties;
        return !!props && Object.prototype.hasOwnProperty.call(props, "automation_key");
      })
      .map((t) => ({
        name: t.name,
        description: truncate(t.description ?? "", MAX_DESCRIPTION_LEN),
      }));
  } finally {
    await client.close();
    await server.close();
  }
}
