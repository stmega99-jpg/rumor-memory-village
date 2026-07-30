/**
 * The Managed MCP read path.
 *
 * This is how a villager searches their own memory. It is deliberately the only
 * way: there is a direct SQL connection in this codebase and it is never used
 * to answer a recall, because a fallback would turn a broken dependency into an
 * invisible one. If MCP is down, recall fails and says so.
 *
 * Credentials are passed in rather than read from module scope, so the same
 * client serves a request handler, a script and a test.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
} from "@modelcontextprotocol/client";

export const DEFAULT_MCP_URL = "https://cockroachlabs.cloud/mcp";

/** Managed MCP cancels a query at 20 seconds; stop just inside that. */
const CALL_TIMEOUT_MS = 18_000;
const CONNECT_TIMEOUT_MS = 20_000;

export class McpUnavailableError extends Error {
  constructor(readonly detail: string) {
    super("The Managed MCP read path is unavailable.");
    this.name = "McpUnavailableError";
  }
}

export interface McpCredentials {
  apiKey: string;
  clusterId: string;
  endpoint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pull the rows out of a tool result.
 *
 * The payload arrives as JSON inside a text content block, so a malformed
 * response and an empty one look similar from a distance. Anything unexpected
 * raises rather than resolving to an empty list -- silently returning "no
 * memories" would read, downstream, as a villager who has forgotten everything.
 */
export function parseRows(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || result.isError === true) {
    throw new McpUnavailableError("tool reported an error");
  }

  const content = result.content;
  if (!Array.isArray(content)) {
    throw new McpUnavailableError("no content in tool result");
  }

  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  )?.text;

  if (text === undefined) {
    throw new McpUnavailableError("no text payload in tool result");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new McpUnavailableError("tool result was not valid JSON");
  }

  if (!isRecord(payload) || !Array.isArray(payload.rows)) {
    throw new McpUnavailableError("tool result carried no rows array");
  }

  return payload.rows.filter(isRecord);
}

/**
 * Run one SELECT through Managed MCP and return its rows.
 *
 * A fresh session per call. The alternative -- holding a connection open across
 * requests -- would need reconnection handling for a saving of a few hundred
 * milliseconds on an interaction a human is driving.
 */
export async function runSelectQuery(
  sql: string,
  database: string,
  credentials: McpCredentials,
): Promise<Record<string, unknown>[]> {
  const authProvider: AuthProvider = {
    token: async () => credentials.apiKey,
  };

  const transport = new StreamableHTTPClientTransport(
    new URL(credentials.endpoint ?? DEFAULT_MCP_URL),
    {
      authProvider,
      requestInit: {
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        headers: { "mcp-cluster-id": credentials.clusterId },
      },
    },
  );

  const client = new Client({
    name: "rumor-memory-village",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "select_query", arguments: { database, query: sql } },
      { timeout: CALL_TIMEOUT_MS },
    );
    return parseRows(result);
  } catch (error) {
    if (error instanceof McpUnavailableError) throw error;
    throw new McpUnavailableError(
      error instanceof Error ? error.message : "unknown transport failure",
    );
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
