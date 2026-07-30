import { describe, expect, it } from "vitest";

import {
  SCORING,
  arbitrate,
  claimSupport,
  decayedConfidence,
  effectiveAgeDays,
  recallScore,
  sourceTrust,
  type MemoryRow,
  type RecallContext,
  type SupportCounts,
} from "../lib/memory/scoring";

const DAY = 86_400_000;
const T0 = new Date("2026-06-01T00:00:00Z");

function at(days: number): Date {
  return new Date(T0.getTime() + days * DAY);
}

const NO_SUPPORT: SupportCounts = { corroborationCount: 0, repeatCount: 0 };

function memory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    memoryId: "m1",
    ownerNpcId: "miyo",
    claimId: "c1",
    sourceType: "heard",
    sourceActorId: "gen",
    sourceForgottenAt: null,
    witnessedDirectly: false,
    confidenceAtAcq: 0.8,
    importance: 0.2,
    emotionalWeight: 0.0,
    acquiredAt: T0,
    lastRecalledAt: null,
    surfaceJa: "",
    ...overrides,
  };
}

function context(overrides: Partial<RecallContext> = {}): RecallContext {
  return {
    simulatedAt: at(30),
    trustOf: (actorId) => (actorId === "gen" ? 0.85 : 0.3),
    supportOf: () => NO_SUPPORT,
    ...overrides,
  };
}

describe("decay", () => {
  it("decreases monotonically as simulated time advances", () => {
    const m = memory();
    const series = [0, 10, 30, 90, 180].map((days) =>
      decayedConfidence(m, NO_SUPPORT, at(days)),
    );

    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]).toBeLessThan(series[i - 1]);
    }
    expect(series[0]).toBeCloseTo(0.8, 5);
  });

  it("never removes a memory entirely", () => {
    const value = decayedConfidence(memory(), NO_SUPPORT, at(10_000));
    expect(value).toBeGreaterThan(0);
  });

  it("retains an important, emotionally charged memory far better", () => {
    const ordinary = memory({ importance: 0.05, emotionalWeight: 0.0 });
    const debt = memory({ importance: 0.9, emotionalWeight: 0.85 });

    const ordinaryLeft = decayedConfidence(ordinary, NO_SUPPORT, at(120));
    const debtLeft = decayedConfidence(debt, NO_SUPPORT, at(120));

    expect(debtLeft).toBeGreaterThan(ordinaryLeft * 2);
  });

  it("treats fear and gratitude alike, since only the magnitude resists decay", () => {
    const gratitude = memory({ emotionalWeight: 0.8 });
    const fear = memory({ emotionalWeight: -0.8 });

    expect(decayedConfidence(gratitude, NO_SUPPORT, at(90))).toBeCloseTo(
      decayedConfidence(fear, NO_SUPPORT, at(90)),
      10,
    );
  });

  it("counts independent corroboration for more than repetition from one mouth", () => {
    const m = memory();
    const corroborated = decayedConfidence(
      m,
      { corroborationCount: 2, repeatCount: 0 },
      at(60),
    );
    const repeated = decayedConfidence(
      m,
      { corroborationCount: 0, repeatCount: 2 },
      at(60),
    );
    const alone = decayedConfidence(m, NO_SUPPORT, at(60));

    expect(corroborated).toBeGreaterThan(repeated);
    expect(repeated).toBeGreaterThan(alone);
  });

  it("refreshes a memory that was actually recalled", () => {
    const untouched = memory();
    const retold = memory({ lastRecalledAt: at(25) });

    expect(effectiveAgeDays(retold, at(30))).toBeLessThan(
      effectiveAgeDays(untouched, at(30)),
    );
    expect(decayedConfidence(retold, NO_SUPPORT, at(30))).toBeGreaterThan(
      decayedConfidence(untouched, NO_SUPPORT, at(30)),
    );
  });
});

describe("source trust", () => {
  it("treats a directly witnessed memory as self-trusted", () => {
    const witnessed = memory({ witnessedDirectly: true, sourceActorId: null });
    expect(sourceTrust(witnessed, context())).toBe(SCORING.selfTrust);
  });

  it("falls back to generic wariness once the informant is forgotten", () => {
    const forgotten = memory({ sourceForgottenAt: at(10) });
    expect(sourceTrust(forgotten, context())).toBe(SCORING.forgottenSourceTrust);
    // Provenance itself is untouched: the audit trail still names the informant.
    expect(forgotten.sourceActorId).toBe("gen");
  });

  it("still knows the informant before forgetting takes effect", () => {
    const notYet = memory({ sourceForgottenAt: at(45) });
    expect(sourceTrust(notYet, context({ simulatedAt: at(30) }))).toBeCloseTo(0.85, 5);
  });
});

describe("recall ranking", () => {
  it("ranks a trusted informant above a distrusted one, all else equal", () => {
    const fromGen = memory({ memoryId: "a", sourceActorId: "gen" });
    const fromStranger = memory({ memoryId: "b", sourceActorId: "sue" });
    const ctx = context();

    expect(recallScore(fromGen, 0.7, ctx).score).toBeGreaterThan(
      recallScore(fromStranger, 0.7, ctx).score,
    );
  });

  it("lets similarity dominate an otherwise identical pair", () => {
    const m = memory();
    const ctx = context();
    expect(recallScore(m, 0.9, ctx).score).toBeGreaterThan(
      recallScore(m, 0.1, ctx).score,
    );
  });

  it("weights terms as exponents, which a plain product could not do", () => {
    // With a plain weighted product the weights collapse into one constant
    // shared by every candidate and cannot affect the ranking at all. These two
    // candidates are chosen so the unweighted product and the weighted
    // geometric mean disagree: only the exponent form puts similarity first.
    const ctx = context({
      trustOf: (actorId) => (actorId === "gen" ? 0.85 : 0.4),
      simulatedAt: T0,
    });
    const strongSimilarity = memory({ memoryId: "sim", sourceActorId: "sue" });
    const strongTrust = memory({ memoryId: "trust", sourceActorId: "gen" });

    const a = recallScore(strongSimilarity, 0.98, ctx);
    const b = recallScore(strongTrust, 0.1, ctx);

    const naiveProduct = (t: typeof a) =>
      t.similarity * t.trust * t.confidence * t.recency * t.emotion;

    // The naive product prefers the trusted informant...
    expect(naiveProduct(a)).toBeLessThan(naiveProduct(b));
    // ...while the weighted geometric mean prefers the closer match.
    expect(a.score).toBeGreaterThan(b.score);

    expect(SCORING.recallWeights.similarity).toBeGreaterThan(
      SCORING.recallWeights.trust,
    );
  });

  it("reports every term so the rationale can be recomputed", () => {
    const breakdown = recallScore(memory(), 0.6, context());
    expect(Object.keys(breakdown).sort()).toEqual(
      [
        "claimId",
        "confidence",
        "emotion",
        "memoryId",
        "recency",
        "score",
        "similarity",
        "trust",
      ].sort(),
    );
  });
});

describe("belief arbitration", () => {
  const ctx = context({ simulatedAt: at(5) });

  const theft = {
    claimId: "stole",
    memories: [
      memory({
        memoryId: "gen-saw",
        claimId: "stole",
        ownerNpcId: "miyo",
        sourceActorId: "gen",
        confidenceAtAcq: 0.7,
        importance: 0.85,
        emotionalWeight: -0.6,
        acquiredAt: at(1),
      }),
    ],
  };

  const repair = {
    claimId: "repaired",
    memories: [
      memory({
        memoryId: "tatsu-saw",
        claimId: "repaired",
        ownerNpcId: "miyo",
        sourceActorId: "tatsu",
        confidenceAtAcq: 0.6,
        importance: 0.8,
        acquiredAt: at(1),
      }),
    ],
  };

  it("keeps both contradictory claims and only moves their status", () => {
    const outcomes = arbitrate([
      claimSupport(theft, ctx),
      claimSupport(repair, ctx),
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.claimId).sort()).toEqual(["repaired", "stole"]);
    for (const outcome of outcomes) {
      expect(outcome.contributions.length).toBeGreaterThan(0);
    }
  });

  it("believes the account from the informant it trusts more", () => {
    const outcomes = arbitrate([
      claimSupport(theft, ctx),
      claimSupport(repair, ctx),
    ]);
    const believed = outcomes.find((o) => o.status === "believed");

    expect(believed?.claimId).toBe("stole");
  });

  it("flips the conclusion when a debt biases the listener the other way", () => {
    // Hana owes the traveller, so the same two accounts land differently.
    const outcomes = arbitrate([
      claimSupport(theft, ctx, -1),
      claimSupport(repair, ctx, 1),
    ]);
    const believed = outcomes.find((o) => o.status === "believed");

    expect(believed?.claimId).toBe("repaired");
  });

  it("doubts both when the two accounts are too close to separate", () => {
    const outcomes = arbitrate([
      claimSupport(theft, ctx),
      claimSupport({ ...repair, memories: theft.memories.map((m) => ({ ...m, memoryId: "x", claimId: "repaired" })) }, ctx),
    ]);

    expect(outcomes.every((o) => o.status === "doubted")).toBe(true);
  });

  it("returns unknown rather than inventing a conviction from nothing", () => {
    const stale = {
      claimId: "faint",
      memories: [
        memory({
          claimId: "faint",
          confidenceAtAcq: 0.2,
          importance: 0,
          emotionalWeight: 0,
          acquiredAt: at(0),
        }),
      ],
    };
    const outcomes = arbitrate([claimSupport(stale, context({ simulatedAt: at(400) }))]);

    expect(outcomes[0].status).toBe("unknown");
  });

  it("is order independent", () => {
    const forward = arbitrate([claimSupport(theft, ctx), claimSupport(repair, ctx)]);
    const reversed = arbitrate([claimSupport(repair, ctx), claimSupport(theft, ctx)]);

    const normalise = (list: typeof forward) =>
      [...list].sort((a, b) => a.claimId.localeCompare(b.claimId)).map((o) => [o.claimId, o.status]);

    expect(normalise(forward)).toEqual(normalise(reversed));
  });
});
