import { describe, expect, it } from "vitest";
import {
  WALKING_SKELETON_PROBE_KEY,
  WALKING_SKELETON_QUERY,
  WALKING_SKELETON_WORLD_ID,
} from "../lib/walking-skeleton/constants";

describe("Managed MCP query contract", () => {
  it("is fixed, world-scoped, read-only, and explicitly bounded", () => {
    expect(WALKING_SKELETON_QUERY).toContain(WALKING_SKELETON_WORLD_ID);
    expect(WALKING_SKELETON_QUERY).toContain(WALKING_SKELETON_PROBE_KEY);
    expect(WALKING_SKELETON_QUERY).toContain(
      "public.mcp_walking_skeleton_probe_demo",
    );
    expect(WALKING_SKELETON_QUERY).not.toMatch(/truth_value/i);
    expect(WALKING_SKELETON_QUERY).toMatch(/^SELECT/i);
    expect(WALKING_SKELETON_QUERY).toMatch(/LIMIT 1$/i);
    expect(WALKING_SKELETON_QUERY).not.toMatch(
      /\b(INSERT|UPDATE|UPSERT|DELETE|DROP|ALTER|TRUNCATE)\b/i,
    );
    expect(WALKING_SKELETON_QUERY.length).toBeLessThan(16_384);
  });
});
