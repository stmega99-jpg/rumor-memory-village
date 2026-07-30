import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWalkingSkeletonRequest } from "../lib/walking-skeleton/http";
import {
  McpReadError,
  readWalkingSkeletonProbe,
} from "../lib/walking-skeleton/mcp";
import { runWalkingSkeleton } from "../lib/walking-skeleton/orchestrator";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Managed MCP production boundary", () => {
  it("returns 503, never calls Bedrock, and does not fall back to SQL for an invalid key", async () => {
    let authorizationHeader: string | undefined;
    const unauthorizedServer = createServer((request, response) => {
      authorizationHeader = request.headers.authorization;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
    });

    await new Promise<void>((resolve, reject) => {
      unauthorizedServer.once("error", reject);
      unauthorizedServer.listen(0, "127.0.0.1", resolve);
    });

    const address = unauthorizedServer.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const generateLine = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await handleWalkingSkeletonRequest(() =>
        runWalkingSkeleton({
          readProbe: () =>
            readWalkingSkeletonProbe({
              endpoint,
              loadSecrets: async () => ({
                cockroachMcpApiKey: "CCDB1_intentionally_invalid_test_key",
                cockroachClusterId:
                  "dcd3153f-e8af-4509-a796-b4f160170270",
              }),
            }),
          generateLine,
          createRequestId: () => "integration-request",
          useLiveBedrock: true,
        }),
      );
      const body = (await response.json()) as {
        ok: boolean;
        stage: string;
        error: string;
      };

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(body).toEqual({
        ok: false,
        contractVersion: "walking-skeleton.v1",
        requestId: expect.any(String),
        stage: "managed-mcp",
        error: "The memory read path is temporarily unavailable.",
      });
      expect(authorizationHeader).toBe(
        "Bearer CCDB1_intentionally_invalid_test_key",
      );
      expect(generateLine).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        unauthorizedServer.close((error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
  });

  it("normalizes an unreachable endpoint to McpReadError", async () => {
    await expect(
      readWalkingSkeletonProbe({
        endpoint: "http://127.0.0.1:1/mcp",
        loadSecrets: async () => ({
          cockroachMcpApiKey: "CCDB1_intentionally_invalid_test_key",
          cockroachClusterId:
            "dcd3153f-e8af-4509-a796-b4f160170270",
        }),
      }),
    ).rejects.toBeInstanceOf(McpReadError);
  });
});
