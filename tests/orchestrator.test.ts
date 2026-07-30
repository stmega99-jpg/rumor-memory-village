import { describe, expect, it, vi } from "vitest";
import { runWalkingSkeleton } from "../lib/walking-skeleton/orchestrator";
import {
  WALKING_SKELETON_PROBE_KEY,
  WALKING_SKELETON_WORLD_ID,
} from "../lib/walking-skeleton/constants";
import type { ProbeRow } from "../lib/walking-skeleton/types";

const row: ProbeRow = {
  worldId: WALKING_SKELETON_WORLD_ID,
  probeKey: WALKING_SKELETON_PROBE_KEY,
  messageJa: "北の井戸の水は、夜だけ青く光るらしい。",
  messageEn:
    "They say the water in the north well glows blue only at night.",
  pregeneratedLineJa: "北の井戸の水、夜だけ青く光るって聞いたよ。",
  pregeneratedModelId: "amazon.nova-lite-v1:0",
  pregeneratedPromptVersion: "initial-bedrock-connectivity-smoke-v1",
  groundingSha256:
    "6f9c351be8d7b2a119954fc160b55bf2162841423be3da7efb7f590dfeb01bf2",
  pregeneratedAt: "2026-07-30T03:00:00Z",
  seededAt: "2026-07-30T00:00:00Z",
};

describe("runWalkingSkeleton", () => {
  it("uses the MCP row to ground a Bedrock response", async () => {
    const generateLine = vi.fn(async (input: ProbeRow) => {
      expect(input).toEqual(row);
      return "北の井戸は夜になると青く光るそうだよ。";
    });

    const result = await runWalkingSkeleton({
      readProbe: async () => row,
      generateLine,
      createRequestId: () => "request-1",
      useLiveBedrock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("bedrock");
    expect(result.npcLineJa).toContain("北の井戸");
    expect(result.path.map((stage) => stage.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(generateLine).toHaveBeenCalledOnce();
  });

  it("uses only the permitted deterministic fallback for Bedrock failure", async () => {
    const result = await runWalkingSkeleton({
      readProbe: async () => row,
      generateLine: async () => {
        throw new Error("model unavailable");
      },
      createRequestId: () => "request-2",
      useLiveBedrock: true,
    });

    expect(result.mode).toBe("fallback");
    expect(result.npcLineJa).toContain(row.messageJa);
    expect(result.path.at(-1)?.status).toBe("degraded");
  });

  it("fails closed when Managed MCP cannot read memory", async () => {
    const generateLine = vi.fn();

    await expect(
      runWalkingSkeleton({
        readProbe: async () => {
          throw new Error("mcp unavailable");
        },
        generateLine,
        createRequestId: () => "request-3",
        useLiveBedrock: true,
      }),
    ).rejects.toThrow("mcp unavailable");

    expect(generateLine).not.toHaveBeenCalled();
  });

  it("reuses the pre-generated Bedrock line without a live model call", async () => {
    const generateLine = vi.fn();

    const result = await runWalkingSkeleton({
      readProbe: async () => row,
      generateLine,
      createRequestId: () => "request-4",
      useLiveBedrock: false,
    });

    expect(result.mode).toBe("pregenerated");
    expect(result.npcLineJa).toBe(row.pregeneratedLineJa);
    expect(result.path.at(-1)?.status).toBe("ok");
    expect(generateLine).not.toHaveBeenCalled();
  });
});
