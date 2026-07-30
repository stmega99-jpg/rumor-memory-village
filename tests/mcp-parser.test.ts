import { describe, expect, it } from "vitest";
import { parseSelectQueryResult } from "../lib/walking-skeleton/mcp-parser";
import {
  WALKING_SKELETON_PROBE_KEY,
  WALKING_SKELETON_WORLD_ID,
} from "../lib/walking-skeleton/constants";

function resultWithRow(overrides: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          rows: [
            {
              world_id: WALKING_SKELETON_WORLD_ID,
              probe_key: WALKING_SKELETON_PROBE_KEY,
              message_ja: "井戸の噂",
              message_en: "A well rumor",
              pregenerated_line_ja: "井戸は夜に青く光るって。",
              pregenerated_model_id: "amazon.nova-lite-v1:0",
              pregenerated_prompt_version:
                "initial-bedrock-connectivity-smoke-v1",
              grounding_sha256:
                "6f9c351be8d7b2a119954fc160b55bf2162841423be3da7efb7f590dfeb01bf2",
              pregenerated_at: "2026-07-30T03:00:00Z",
              seeded_at: "2026-07-30T00:00:00Z",
              ...overrides,
            },
          ],
        }),
      },
    ],
  };
}

describe("parseSelectQueryResult", () => {
  it("parses exactly one fixed-world probe row", () => {
    expect(parseSelectQueryResult(resultWithRow())).toMatchObject({
      worldId: WALKING_SKELETON_WORLD_ID,
      probeKey: WALKING_SKELETON_PROBE_KEY,
    });
  });

  it("rejects data from a different world", () => {
    expect(() =>
      parseSelectQueryResult(
        resultWithRow({ world_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }),
      ),
    ).toThrow("outside the fixed demo scope");
  });

  it("rejects malformed or multi-row MCP responses", () => {
    expect(() => parseSelectQueryResult({ content: [] })).toThrow();
    expect(() =>
      parseSelectQueryResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({ rows: [{}, {}] }),
          },
        ],
      }),
    ).toThrow("exactly one");
  });

  it("rejects an MCP tool-level error without exposing its content", () => {
    expect(() =>
      parseSelectQueryResult({
        isError: true,
        content: [{ type: "text", text: "invalid bearer token: secret" }],
      }),
    ).toThrow("Managed MCP returned an error result");
  });
});
