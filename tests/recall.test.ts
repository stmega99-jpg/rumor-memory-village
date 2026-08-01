import { describe, expect, it } from "vitest";

import { MCP_SAFE_RECALL_LIMIT } from "../lib/memory/queries";
import { aggregate, computeRoots, fetchWidth, type Candidate } from "../lib/memory/recall";
import type { MemoryRow } from "../lib/memory/scoring";

const T0 = new Date("2026-06-01T00:00:00Z");

function memory(overrides: Partial<MemoryRow> & { memoryId: string }): MemoryRow {
  return {
    ownerNpcId: "miyo",
    claimId: "stole",
    sourceType: "heard",
    sourceActorId: "gen",
    sourceMemoryId: null,
    provenanceRootMemoryId:
      overrides.provenanceRootMemoryId ?? overrides.memoryId,
    sourceForgottenAt: null,
    witnessedDirectly: false,
    confidenceAtAcq: 0.7,
    importance: 0.3,
    emotionalWeight: 0,
    emotionType: "neutral",
    acquiredAt: T0,
    lastRecalledAt: null,
    surfaceJa: "",
    ...overrides,
  } as MemoryRow;
}

const options = {
  simulatedAt: new Date("2026-06-10T00:00:00Z"),
  trustOf: (actorId: string | null) =>
    actorId === "gen" ? 0.85 : actorId === "tatsu" ? 0.6 : 0.3,
};

function candidates(list: Array<[MemoryRow, number]>): Candidate[] {
  return list.map(([memoryRow, similarity]) => ({ memory: memoryRow, similarity }));
}

describe("source roots", () => {
  it("treats a witnessed memory as its own origin", () => {
    const witnessed = memory({
      memoryId: "a",
      witnessedDirectly: true,
      sourceActorId: null,
    });
    expect(computeRoots([witnessed]).get("a")).toBe("a");
  });

  it("uses the persisted origin rather than the immediate informant", () => {
    const heard = memory({
      memoryId: "b",
      sourceActorId: "gen",
      provenanceRootMemoryId: "first-witness-memory",
    });
    expect(computeRoots([heard]).get("b")).toBe("first-witness-memory");
  });

  it("keeps a cross-owner root even when the parent memory was not fetched", () => {
    const relayed = memory({
      memoryId: "relay",
      sourceActorId: "miyo",
      sourceMemoryId: "memory-owned-by-miyo",
      provenanceRootMemoryId: "gen-first-hand",
    });
    expect(computeRoots([relayed]).get("relay")).toBe("gen-first-hand");
  });

  it("does not infer roots from a candidate-set source chain", () => {
    const a = memory({ memoryId: "a", provenanceRootMemoryId: "origin-a" });
    const b = memory({
      memoryId: "b",
      sourceMemoryId: "a",
      provenanceRootMemoryId: "origin-b",
    });
    expect(computeRoots([a, b]).get("b")).toBe("origin-b");
  });
});

describe("aggregation", () => {
  it("collapses duplicate memories of one claim into a single group", () => {
    const groups = aggregate(
      candidates([
        [memory({ memoryId: "m1" }), 0.9],
        [memory({ memoryId: "m2" }), 0.88],
        [memory({ memoryId: "m3" }), 0.87],
      ]),
      options,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it("counts two informants as corroboration, not repetition", () => {
    const groups = aggregate(
      candidates([
        [memory({ memoryId: "m1", sourceActorId: "gen", provenanceRootMemoryId: "root-gen" }), 0.9],
        [memory({ memoryId: "m2", sourceActorId: "tatsu", provenanceRootMemoryId: "root-tatsu" }), 0.9],
      ]),
      options,
    );

    expect(groups[0].support.corroborationCount).toBe(2);
    expect(groups[0].support.repeatCount).toBe(0);
    expect(groups[0].sourceRoots.sort()).toEqual(["root-gen", "root-tatsu"]);
  });

  it("counts one informant twice as repetition, not corroboration", () => {
    const groups = aggregate(
      candidates([
        [memory({ memoryId: "m1", sourceActorId: "gen", provenanceRootMemoryId: "root-gen" }), 0.9],
        [memory({ memoryId: "m2", sourceActorId: "gen", provenanceRootMemoryId: "root-gen" }), 0.9],
      ]),
      options,
    );

    expect(groups[0].support.corroborationCount).toBe(1);
    expect(groups[0].support.repeatCount).toBe(2);
    expect(groups[0].sourceRoots).toEqual(["root-gen"]);
  });

  it("does not let two immediate informants launder one origin into corroboration", () => {
    const viaMiyo = memory({
      memoryId: "via-miyo",
      sourceActorId: "miyo",
      sourceMemoryId: "miyo-copy",
      provenanceRootMemoryId: "gen-first-hand",
    });
    const viaTatsu = memory({
      memoryId: "via-tatsu",
      sourceActorId: "tatsu",
      sourceMemoryId: "tatsu-copy",
      provenanceRootMemoryId: "gen-first-hand",
    });

    const groups = aggregate(
      candidates([[viaMiyo, 0.9], [viaTatsu, 0.9]]),
      options,
    );
    expect(groups[0].support.corroborationCount).toBe(1);
    expect(groups[0].support.repeatCount).toBe(2);
  });

  it("picks the strongest memory of a claim as the one spoken from", () => {
    const weak = memory({ memoryId: "weak", sourceActorId: "sue", confidenceAtAcq: 0.4 });
    const strong = memory({ memoryId: "strong", sourceActorId: "gen", confidenceAtAcq: 0.9 });

    const groups = aggregate(candidates([[weak, 0.9], [strong, 0.9]]), options);
    expect(groups[0].representative.memoryId).toBe("strong");
  });

  it("ranks a corroborated claim above an equally similar lone one", () => {
    const groups = aggregate(
      candidates([
        [memory({ memoryId: "a1", claimId: "backed", sourceActorId: "gen" }), 0.8],
        [memory({ memoryId: "a2", claimId: "backed", sourceActorId: "tatsu" }), 0.8],
        [memory({ memoryId: "b1", claimId: "lonely", sourceActorId: "gen" }), 0.8],
      ]),
      options,
    );

    expect(groups[0].claimId).toBe("backed");
  });

  it("orders groups by their representative score", () => {
    const groups = aggregate(
      candidates([
        [memory({ memoryId: "far", claimId: "far" }), 0.1],
        [memory({ memoryId: "near", claimId: "near" }), 0.95],
      ]),
      options,
    );

    expect(groups.map((g) => g.claimId)).toEqual(["near", "far"]);
  });

  it("over-fetches, because vector search is approximate at the tail", () => {
    expect(fetchWidth(3)).toBeGreaterThan(3);
    expect(fetchWidth(1)).toBeGreaterThanOrEqual(12);
  });

  it("never asks for more rows than an MCP response can carry", () => {
    for (const desired of [1, 3, 5, 20, 100]) {
      expect(fetchWidth(desired)).toBeLessThanOrEqual(MCP_SAFE_RECALL_LIMIT);
    }
  });
});
