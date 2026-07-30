import { describe, expect, it } from "vitest";

import {
  PROPAGATION,
  distort,
  hashSeed,
  tell,
  type TellRequest,
} from "../lib/memory/propagation";
import type { MemoryRow, SupportCounts } from "../lib/memory/scoring";

const T0 = new Date("2026-06-01T00:00:00Z");
const NO_SUPPORT: SupportCounts = { corroborationCount: 0, repeatCount: 0 };

function memory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    memoryId: "gen-saw-theft",
    ownerNpcId: "gen",
    claimId: "stole",
    sourceType: "witnessed",
    sourceActorId: null,
    sourceMemoryId: null,
    sourceForgottenAt: null,
    witnessedDirectly: true,
    confidenceAtAcq: 0.8,
    importance: 0.85,
    emotionalWeight: -0.6,
    emotionType: "suspicion",
    acquiredAt: T0,
    lastRecalledAt: null,
    surfaceJa: "三日前に旅の人が古い倉庫から物を盗んだ。",
    ...overrides,
  };
}

function request(overrides: Partial<TellRequest> = {}): TellRequest {
  return {
    speakerId: "gen",
    listenerId: "miyo",
    memory: memory(),
    support: NO_SUPPORT,
    simulatedAt: T0,
    trust: 0.85,
    hop: 0,
    contested: false,
    listenerAlreadyHolds: false,
    ...overrides,
  };
}

describe("distortion", () => {
  it("leaves a first-hand account alone", () => {
    const result = distort("旅の人が橋を直していた。", 0, "neutral", 1);
    expect(result.text).toBe("旅の人が橋を直していた。");
    expect(result.note).toBe("first hand");
  });

  it("drops specifics and hedges as a story travels", () => {
    const original = "三日前に旅の人が古い倉庫から物を盗んだ。";
    const once = distort(original, 1, "neutral", 0);

    expect(once.text).not.toBe(original);
    expect(once.text.length).toBeLessThan(original.length + 8);
    expect(once.note).toContain("hedged");
  });

  it("is deterministic for the same inputs", () => {
    const a = distort("旅の人が橋を壊した。", 2, "suspicion", 42);
    const b = distort("旅の人が橋を壊した。", 2, "suspicion", 42);
    expect(a).toEqual(b);
  });

  it("colours the retelling by how the speaker feels", () => {
    const suspicious = distort("旅の人が倉庫に入った。", 1, "suspicion", 0);
    const grateful = distort("旅の人が倉庫に入った。", 1, "gratitude", 0);

    expect(suspicious.text).not.toBe(grateful.text);
    expect(suspicious.note).toContain("suspicion");
    expect(grateful.note).toContain("gratitude");
  });

  it("hashes stably", () => {
    expect(hashSeed("a", "b")).toBe(hashSeed("a", "b"));
    expect(hashSeed("a", "b")).not.toBe(hashSeed("b", "a"));
  });
});

describe("telling", () => {
  it("is adopted by a listener who trusts the speaker", () => {
    const result = tell(request());
    expect(result.outcome).toBe("adopted");
  });

  it("records who it came from and which memory it came from", () => {
    const result = tell(request());
    if (result.outcome !== "adopted") throw new Error("expected adoption");

    expect(result.sourceActorId).toBe("gen");
    expect(result.sourceMemoryId).toBe("gen-saw-theft");
    expect(result.claimId).toBe("stole");
  });

  it("loses confidence on every hop", () => {
    const result = tell(request());
    if (result.outcome !== "adopted") throw new Error("expected adoption");

    expect(result.confidence).toBeLessThan(result.confidenceBefore);
  });

  it("is refused when the listener does not trust the speaker", () => {
    const result = tell(request({ trust: 0.2 }));

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("expected rejection");
    expect(result.reason).toBe("distrusted_source");
    expect(result.actualTrust).toBeLessThan(result.requiredTrust);
  });

  it("demands more trust when the listener already believes otherwise", () => {
    const borderline = 0.45;
    const uncontested = tell(request({ trust: borderline, contested: false }));
    const contested = tell(request({ trust: borderline, contested: true }));

    expect(uncontested.outcome).toBe("adopted");
    expect(contested.outcome).toBe("rejected");
  });

  it("is easier to accept when it corroborates something already held", () => {
    const cold = tell(request({ trust: 0.25, listenerAlreadyHolds: false }));
    const warm = tell(request({ trust: 0.25, listenerAlreadyHolds: true }));

    expect(cold.outcome).toBe("rejected");
    expect(warm.outcome).toBe("adopted");
    if (warm.outcome !== "adopted") throw new Error("expected adoption");
    expect(warm.corroborates).toBe(true);
  });

  it("keeps the proposition identical however mangled the wording gets", () => {
    const first = tell(request({ hop: 0 }));
    const third = tell(request({ hop: 3 }));

    if (first.outcome !== "adopted" || third.outcome !== "adopted") {
      throw new Error("expected adoption");
    }
    // Wording drifts...
    expect(third.surfaceJa).not.toBe(first.surfaceJa);
    // ...the claim does not. Corroboration counting depends on this.
    expect(third.claimId).toBe(first.claimId);
  });

  it("will not pass on a rumour that has already faded away", () => {
    const faint = memory({
      confidenceAtAcq: 0.2,
      importance: 0,
      emotionalWeight: 0,
      emotionType: "neutral",
    });
    const result = tell(
      request({ memory: faint, simulatedAt: new Date("2027-06-01T00:00:00Z") }),
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("expected rejection");
    expect(result.reason).toBe("too_faint");
  });

  it("uses a trust floor between the two published thresholds", () => {
    expect(PROPAGATION.contestedTrustFloor).toBeGreaterThan(
      PROPAGATION.adoptionTrustFloor,
    );
  });
});
