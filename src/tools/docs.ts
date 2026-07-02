/**
 * Google Docs tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { docs_v1 } from "googleapis";
import { ok, guard } from "../util.js";
import { accountField, type UserClients } from "../accounts.js";

/** Flattens a Docs document body into plain text. */
export function documentToPlainText(doc: docs_v1.Schema$Document): string {
  const out: string[] = [];
  const content = doc.body?.content ?? [];
  for (const el of content) {
    const para = el.paragraph;
    if (para?.elements) {
      for (const pe of para.elements) {
        const t = pe.textRun?.content;
        if (t) out.push(t);
      }
    }
    const table = el.table;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        const cells = (row.tableCells ?? []).map((cell) => {
          const parts: string[] = [];
          for (const cc of cell.content ?? []) {
            for (const pe of cc.paragraph?.elements ?? []) {
              if (pe.textRun?.content) parts.push(pe.textRun.content.trim());
            }
          }
          return parts.join(" ");
        });
        out.push(cells.join("\t") + "\n");
      }
    }
  }
  return out.join("");
}

/** Returns the end index of the document body (where appended text should go). */
function documentEndIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content ?? [];
  let end = 1;
  for (const el of content) {
    if (typeof el.endIndex === "number") end = el.endIndex;
  }
  // The very last newline of the body is not a valid insertion location;
  // insert just before it.
  return Math.max(1, end - 1);
}

export function registerDocsTools(server: McpServer, clients: UserClients) {
  const account = accountField(clients);

  server.registerTool(
    "docs_list",
    {
      title: "List documents",
      description:
        "List Google Docs the account can access. Optionally filter by a name substring.",
      inputSchema: {
        account,
        nameContains: z.string().optional(),
        maxResults: z.number().int().min(1).max(200).default(50).optional(),
      },
    },
    guard(async ({ account, nameContains, maxResults }) => {
      const g = clients.resolve(account);
      const qParts = [
        "mimeType='application/vnd.google-apps.document'",
        "trashed=false",
      ];
      if (nameContains) {
        qParts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
      }
      const res = await g.drive.files.list({
        q: qParts.join(" and "),
        pageSize: maxResults ?? 50,
        fields: "files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
      });
      const files = res.data.files ?? [];
      return ok({
        summary: `📋 ${files.length} document(s)${nameContains ? ` matching "${nameContains}"` : ""} on account "${account ?? "default"}"`,
        files,
      });
    }),
  );

  server.registerTool(
    "docs_read",
    {
      title: "Read documents",
      description:
        "Read one or more Google Docs as plain text. Returns results for each documentId.",
      inputSchema: {
        account,
        documentIds: z.array(z.string()).min(1),
      },
    },
    guard(async ({ account, documentIds }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        documentIds.map(async (documentId) => {
          try {
            const res = await g.docs.documents.get({ documentId });
            const text = documentToPlainText(res.data);
            return {
              documentId,
              title: res.data.title ?? null,
              text,
              characterCount: text.length,
            };
          } catch (err: unknown) {
            return {
              documentId,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return ok({
        summary: `📖 Read ${documentIds.length} document(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "docs_create",
    {
      title: "Create documents",
      description:
        "Create one or more new Google Docs, optionally with initial text. Returns results for each.",
      inputSchema: {
        account,
        documents: z
          .array(
            z.object({
              title: z.string(),
              initialText: z.string().optional().describe("Optional initial body text."),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, documents }) => {
      const g = clients.resolve(account);
      const results = await Promise.all(
        documents.map(async (doc) => {
          try {
            const created = await g.docs.documents.create({
              requestBody: { title: doc.title },
            });
            const documentId = created.data.documentId!;
            if (doc.initialText) {
              await g.docs.documents.batchUpdate({
                documentId,
                requestBody: {
                  requests: [
                    { insertText: { location: { index: 1 }, text: doc.initialText } },
                  ],
                },
              });
            }
            return {
              documentId,
              title: created.data.title ?? doc.title,
              documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
            };
          } catch (err: unknown) {
            return {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return ok({
        summary: `📄 Created ${documents.length} document(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "docs_append_text",
    {
      title: "Append text",
      description: "Append text to the end of one or more documents.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              text: z.string(),
              ensureNewline: z
                .boolean()
                .optional()
                .describe("Prepend a newline if document doesn't end with one."),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{ documentId: string; addedLength?: number; error?: string }> = [];
      for (const item of items) {
        const { documentId, text, ensureNewline } = item;
        try {
          const doc = await g.docs.documents.get({ documentId });
          let insertText = text;
          if (ensureNewline) {
            const current = documentToPlainText(doc.data);
            if (current.length > 0 && !current.endsWith("\n")) {
              insertText = "\n" + text;
            }
          }
          const index = documentEndIndex(doc.data);
          await g.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [{ insertText: { location: { index }, text: insertText } }],
            },
          });
          results.push({ documentId, addedLength: insertText.length });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return ok({
        summary: `📝 Appended to ${items.length} document(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "docs_insert_text",
    {
      title: "Insert text at index",
      description:
        "Insert text at a specific character index in one or more documents (1 = very start of the body). Sequential per document.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              text: z.string(),
              index: z.number().int().min(1),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{ documentId: string; error?: string }> = [];
      for (const item of items) {
        const { documentId, text, index } = item;
        try {
          await g.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [{ insertText: { location: { index }, text } }],
            },
          });
          results.push({ documentId });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return ok({
        summary: `📝 Inserted text into ${items.length} document(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "docs_replace_text",
    {
      title: "Replace all text",
      description:
        "Find and replace all occurrences of a string in one or more documents. Sequential per document.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              find: z.string(),
              replace: z.string(),
              matchCase: z.boolean().default(false).optional(),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{
        documentId: string;
        occurrencesChanged?: number;
        error?: string;
      }> = [];
      for (const item of items) {
        const { documentId, find, replace, matchCase } = item;
        try {
          const res = await g.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [
                {
                  replaceAllText: {
                    containsText: { text: find, matchCase: matchCase ?? false },
                    replaceText: replace,
                  },
                },
              ],
            },
          });
          const occurrencesChanged =
            res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
          results.push({ documentId, occurrencesChanged });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return ok({
        summary: `🔄 Replace operations on ${items.length} document(s)`,
        results,
      });
    }),
  );

  server.registerTool(
    "docs_raw_batch_update",
    {
      title: "Raw Docs batchUpdate (advanced)",
      description:
        "Send raw Docs API batchUpdate `requests` to one or more documents (styling, tables, images, etc.). Sequential per document. Use only when other tools are not enough.",
      inputSchema: {
        account,
        items: z
          .array(
            z.object({
              documentId: z.string(),
              requests: z.array(z.record(z.string(), z.any())),
            }),
          )
          .min(1),
      },
    },
    guard(async ({ account, items }) => {
      const g = clients.resolve(account);
      const results: Array<{
        documentId: string;
        replies?: unknown;
        error?: string;
      }> = [];
      for (const item of items) {
        const { documentId, requests } = item;
        try {
          const res = await g.docs.documents.batchUpdate({
            documentId,
            requestBody: { requests: requests as object[] },
          });
          results.push({ documentId, replies: res.data.replies });
        } catch (err: unknown) {
          results.push({
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return ok({
        summary: `⚙️ Raw batchUpdate applied to ${items.length} document(s)`,
        results,
      });
    }),
  );
}
