import "server-only";

import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import {
  COCKROACH_DATABASE,
  COCKROACH_MCP_URL,
  WALKING_SKELETON_QUERY,
} from "./constants";
import {
  getRuntimeSecrets,
  type RuntimeSecrets,
} from "./config";
import { parseSelectQueryResult } from "./mcp-parser";
import type { ProbeRow } from "./types";

export class McpReadError extends Error {
  constructor() {
    super("The Managed MCP read path is unavailable.");
    this.name = "McpReadError";
  }
}

let selectQueryContractVerified = false;

export interface McpReadOptions {
  endpoint?: string;
  loadSecrets?: () => Promise<RuntimeSecrets>;
}

function verifySelectQueryContract(toolList: unknown): void {
  if (
    typeof toolList !== "object" ||
    toolList === null ||
    !Array.isArray((toolList as { tools?: unknown }).tools)
  ) {
    throw new McpReadError();
  }

  const tools = (toolList as { tools: unknown[] }).tools;
  const selectQuery = tools.find(
    (tool) =>
      typeof tool === "object" &&
      tool !== null &&
      (tool as { name?: unknown }).name === "select_query",
  ) as { inputSchema?: unknown } | undefined;

  if (
    !selectQuery ||
    typeof selectQuery.inputSchema !== "object" ||
    selectQuery.inputSchema === null
  ) {
    throw new McpReadError();
  }

  const properties = (
    selectQuery.inputSchema as {
      properties?: Record<string, unknown>;
    }
  ).properties;

  if (!properties?.database || !properties.query) {
    throw new McpReadError();
  }

  selectQueryContractVerified = true;
}

export async function readWalkingSkeletonProbe(
  options: McpReadOptions = {},
): Promise<ProbeRow> {
  const secrets = await (options.loadSecrets ?? getRuntimeSecrets)();
  const authProvider: AuthProvider = {
    token: async () => secrets.cockroachMcpApiKey,
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(options.endpoint ?? COCKROACH_MCP_URL),
    {
      authProvider,
      requestInit: {
        signal: AbortSignal.timeout(20_000),
        headers: {
          "mcp-cluster-id": secrets.cockroachClusterId,
        },
      },
    },
  );
  const client = new Client({
    name: "rumor-memory-village",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);

    if (!selectQueryContractVerified) {
      verifySelectQueryContract(await client.listTools());
    }

    const result = await client.callTool(
      {
        name: "select_query",
        arguments: {
          database: COCKROACH_DATABASE,
          query: WALKING_SKELETON_QUERY,
        },
      },
      { timeout: 18_000 },
    );

    return parseSelectQueryResult(result);
  } catch (error) {
    if (error instanceof McpReadError) {
      throw error;
    }
    throw new McpReadError();
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
