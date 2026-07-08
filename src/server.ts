import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./config.js";
import { buildUserClients, registerAccountTools } from "./accounts.js";
import { registerDocsTools } from "./tools/docs.js";

export function buildMcpServer(user: User): McpServer {
  const clients = buildUserClients(user);
  const accountsHint = clients.multi
    ? `Multiple Google accounts available: ${clients.names.join(", ")} (default: ${clients.defaultName}). Pass \`account\` to select.`
    : `One Google account ("${clients.defaultName}") is configured.`;

  const server = new McpServer(
    { name: "docs-mcp", version: "1.0.0" },
    { instructions: "Tools to read and edit Google Docs. Use docs_list to find documents, then read or edit by id. " + accountsHint },
  );
  registerAccountTools(server, clients);
  registerDocsTools(server, clients);
  return server;
}
