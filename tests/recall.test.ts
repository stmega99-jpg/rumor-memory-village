import { describe, expect, it } from "vitest";

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

  it("attributes a heard memory to its informant", () => {
    const heard = memory({ memoryId: "b", sourceActorId: "gen" });
    expect(computeRoots([heard]).get("b")).toBe("gen");
  });

  it("follows a chain back through memories it can see", () => {
    const first = memory({ memoryId: "root", witnessedDirectly: true, sourceActorId: null });
    const relayed = memory({ memoryId: "relay", sourceMemoryId: "root" });
    expect(computeRoots([first, relayed]).get("relay")).toBe("root");
  });

  it("does not hang on a cyclic chain", () => {
    const a = memory({ memoryId: "a", sourceMemoryId: "b" });
    const b = memory({ memoryId: "b", sourceMemoryId: "a" });
    expect(() => computeRoots([a, b])).not.toThrow();
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
        [memory({ memoryId: "m1", sourceActorId: "gen" }), 0.9],
        [memory({ memoryId: "m2", sourceActorId: "tatsu" }), 0.9],
      ]),
      options,
    );

    expect(groups[0].support.corroborationCount).toBe(1);
    expect(groups[0].support.repeatCount).toBe(0);
    expect(groups[0].sourceRoots.sort()).toEqual(["gen", "tatsu"]);
  });

  it("counts one informant twice as repetition, not corroboration", () => {
    const groups = aggregate(
      candidates([
        [memory({ memoryId: "m1", sourceActorId: "gen" }), 0.9],
        [memory({ memoryId: "m2", sourceActorId: "gen" }), 0.9],
      ]),
      options,
    );

    expect(groups[0].support.corroborationCount).toBe(0);
    expect(groups[0].support.repeatCount).toBe(1);
    expect(groups[0].sourceRoots).toEqual(["gen"]);
  });

  it("does not let a relayed copy pose as an independent witness", () => {
    // Miyo heard it from Gen, then heard Gen's own account again second-hand.
    const original = memory({
      memoryId: "root",
      witnessedDirectly: true,
      sourceActorId: null,
    });
    const relay = memory({ memoryId: "relay", sourceMemoryId: "root" });

    const groups = aggregate(candidates([[original, 0.9], [relay, 0.9]]), options);
    expect(groups[0].support.corroborationCount).toBe(0);
    expect(groups[0].support.repeatCount).toBe(1);
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
    expect(fetchWidth(1)).toBeGreaterThanOrEqual(24);
  });
});
