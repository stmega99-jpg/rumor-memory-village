/**
 * Deterministic memory scoring.
 *
 * Everything a villager concludes is computed here, in plain code, from stored
 * numbers. No language model participates in arbitration: a model writes the
 * sentence a villager says, never decides what they believe. That split is what
 * makes the demo reproducible and the explanation log honest -- every number in
 * a rationale can be recomputed from the database.
 *
 * The module is pure. It takes a simulated timestamp rather than reading a
 * clock, so advancing time in the demo and replaying a scenario in a test are
 * the same operation.
 */

/** Tuning constants. Exported so the visualisation can display them. */
export const SCORING = {
  /** Base decay rate, per simulated day. */
  lambda: 0.045,
  /** How much independent corroboration slows forgetting. */
  corroborationBoost: 0.35,
  /** How much hearing the same informant again slows forgetting. Deliberately
   *  smaller: repetition from one mouth is not independent evidence. */
  repeatBoost: 0.08,
  /** Half-life, in simulated days, of the recency term used during recall. */
  recencyHalfLifeDays: 21,
  /** Multiplier applied to a memory the villager witnessed themselves. */
  directWitnessBonus: 1.6,
  /** Trust assumed toward oneself, for directly witnessed memories. */
  selfTrust: 1.0,
  /** Trust assumed when the informant has been forgotten. */
  forgottenSourceTrust: 0.4,
  /** Recall weights, applied as exponents on a geometric mean. */
  recallWeights: {
    similarity: 1.0,
    trust: 0.6,
    confidence: 0.9,
    recency: 0.4,
    emotion: 0.5,
  },
  /** Belief must exceed the best rival by this margin to be `believed`. */
  decisionMargin: 0.12,
  /** Below this absolute score nothing is believed either way. */
  minimumConviction: 0.08,
  /** Weight of the villager's existing feeling toward the claim's subject. */
  priorBiasWeight: 0.25,
} as const;

export const ENGINE_VERSION = "scoring-v1";

const DAY_MS = 86_400_000;

export interface MemoryRow {
  memoryId: string;
  ownerNpcId: string;
  claimId: string;
  sourceType: "witnessed" | "heard" | "told_by_player" | "inferred";
  sourceActorId: string | null;
  /** The informant's own memory this one was copied from. Immutable. */
  sourceMemoryId: string | null;
  sourceForgottenAt: Date | null;
  witnessedDirectly: boolean;
  confidenceAtAcq: number;
  importance: number;
  emotionalWeight: number;
  /** Colours how the memory is retold. Never an input to arbitration. */
  emotionType: string;
  acquiredAt: Date;
  lastRecalledAt: Date | null;
  surfaceJa: string;
}

/** How often this claim reached the owner, split by independence of source. */
export interface SupportCounts {
  /** Distinct informants other than the first. Independent corroboration. */
  corroborationCount: number;
  /** Repeats from an informant already counted. Weak evidence. */
  repeatCount: number;
}

export interface RecallContext {
  simulatedAt: Date;
  /** Directed trust from the owner toward an actor id. */
  trustOf: (actorId: string | null) => number;
  supportOf: (claimId: string) => SupportCounts;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Age used for decay. Recalling a memory refreshes it, so a story a villager
 * keeps retelling stays sharp while one they never touch fades.
 */
export function effectiveAgeDays(memory: MemoryRow, simulatedAt: Date): number {
  const anchor =
    memory.lastRecalledAt && memory.lastRecalledAt > memory.acquiredAt
      ? memory.lastRecalledAt
      : memory.acquiredAt;
  return daysBetween(anchor, simulatedAt);
}

/**
 * Confidence after forgetting. Memories are never deleted; this is the only
 * thing time does to them.
 *
 * Importance and emotional charge divide the decay rate, which is why a strong
 * debt or a bad fright still reads clearly months later while an ordinary
 * afternoon does not. Corroboration multiplies it back up.
 */
export function decayedConfidence(
  memory: MemoryRow,
  support: SupportCounts,
  simulatedAt: Date,
): number {
  const age = effectiveAgeDays(memory, simulatedAt);
  const resistance = 1 + memory.importance + Math.abs(memory.emotionalWeight);
  const decay = Math.exp((-SCORING.lambda * age) / resistance);
  const reinforcement =
    1 +
    SCORING.corroborationBoost * Math.log1p(support.corroborationCount) +
    SCORING.repeatBoost * Math.log1p(support.repeatCount);
  return clamp(memory.confidenceAtAcq * decay * reinforcement, 0, 1);
}

/** Trust the owner extends to this memory's informant. */
export function sourceTrust(
  memory: MemoryRow,
  context: RecallContext,
): number {
  if (memory.witnessedDirectly) {
    return SCORING.selfTrust;
  }
  if (memory.sourceForgottenAt && memory.sourceForgottenAt <= context.simulatedAt) {
    // The villager still holds the claim but can no longer say who told them,
    // so they fall back on a generic wariness rather than the real informant.
    return SCORING.forgottenSourceTrust;
  }
  return clamp(context.trustOf(memory.sourceActorId), 0, 1);
}

function recencyTerm(memory: MemoryRow, simulatedAt: Date): number {
  const age = daysBetween(memory.acquiredAt, simulatedAt);
  return Math.pow(0.5, age / SCORING.recencyHalfLifeDays);
}

export interface RecallBreakdown {
  memoryId: string;
  claimId: string;
  similarity: number;
  trust: number;
  confidence: number;
  recency: number;
  emotion: number;
  score: number;
}

/**
 * Rank a candidate memory against the current topic.
 *
 * The terms combine as a weighted geometric mean rather than a plain product:
 * with a product, the weights would collapse into one constant factor shared by
 * every candidate and could not change the ordering at all. As exponents they
 * genuinely trade the terms off, and a near-zero term still suppresses the
 * memory the way it should.
 */
export function recallScore(
  memory: MemoryRow,
  similarity: number,
  context: RecallContext,
): RecallBreakdown {
  const w = SCORING.recallWeights;
  const support = context.supportOf(memory.claimId);
  const terms = {
    similarity: clamp((similarity + 1) / 2, 0, 1),
    trust: clamp(sourceTrust(memory, context), 0, 1),
    confidence: decayedConfidence(memory, support, context.simulatedAt),
    recency: recencyTerm(memory, context.simulatedAt),
    emotion: clamp((1 + Math.abs(memory.emotionalWeight)) / 2, 0, 1),
  };
  const score =
    Math.pow(Math.max(terms.similarity, 1e-6), w.similarity) *
    Math.pow(Math.max(terms.trust, 1e-6), w.trust) *
    Math.pow(Math.max(terms.confidence, 1e-6), w.confidence) *
    Math.pow(Math.max(terms.recency, 1e-6), w.recency) *
    Math.pow(Math.max(terms.emotion, 1e-6), w.emotion);

  return {
    memoryId: memory.memoryId,
    claimId: memory.claimId,
    ...terms,
    score,
  };
}

export interface ClaimEvidence {
  claimId: string;
  memories: MemoryRow[];
}

export interface BeliefContribution {
  memoryId: string;
  sourceActorId: string | null;
  trust: number;
  confidence: number;
  witnessedDirectly: boolean;
  contribution: number;
}

export interface ClaimVerdict {
  claimId: string;
  score: number;
  priorBias: number;
  contributions: BeliefContribution[];
}

/**
 * Accumulated support for one proposition, before rivals are considered.
 *
 * `priorBias` is how the villager already feels about whoever the claim is
 * about. It is what makes Hana doubt a theft story about someone she owes.
 */
export function claimSupport(
  evidence: ClaimEvidence,
  context: RecallContext,
  priorBias = 0,
): ClaimVerdict {
  const support = context.supportOf(evidence.claimId);
  const contributions = evidence.memories.map((memory) => {
    const trust = sourceTrust(memory, context);
    const confidence = decayedConfidence(memory, support, context.simulatedAt);
    const witnessFactor = memory.witnessedDirectly
      ? SCORING.directWitnessBonus
      : 1;
    const contribution =
      trust * confidence * witnessFactor * recencyTerm(memory, context.simulatedAt);
    return {
      memoryId: memory.memoryId,
      sourceActorId: memory.sourceActorId,
      trust,
      confidence,
      witnessedDirectly: memory.witnessedDirectly,
      contribution,
    };
  });

  const raw = contributions.reduce((total, item) => total + item.contribution, 0);
  return {
    claimId: evidence.claimId,
    score: raw + SCORING.priorBiasWeight * priorBias,
    priorBias,
    contributions,
  };
}

export type BeliefStatus = "believed" | "doubted" | "rejected" | "unknown";

export interface BeliefOutcome {
  claimId: string;
  status: BeliefStatus;
  score: number;
  opposingScore: number;
  contributions: BeliefContribution[];
  priorBias: number;
}

/**
 * Decide a set of mutually exclusive propositions.
 *
 * Both sides are always retained; only the status changes. When the leader's
 * lead is inside the decision margin the villager holds both as `doubted`
 * rather than picking one, which is the honest outcome for a person who has
 * heard two credible accounts and cannot tell them apart.
 */
export function arbitrate(verdicts: ClaimVerdict[]): BeliefOutcome[] {
  if (verdicts.length === 0) {
    return [];
  }

  const ranked = [...verdicts].sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const hasRival = ranked.length > 1;

  // Nothing left worth an opinion. A villager whose memories have all faded
  // below conviction does not half-believe them; they simply no longer know,
  // and that has to be true of the whole group at once. Judging members
  // individually here produced villagers who rejected one account while
  // holding no view on the account that outranked it.
  const decidable = leader.score >= SCORING.minimumConviction;

  // The margin is about telling two accounts apart, so it only applies when
  // there are two. An uncontested memory that clears conviction is simply
  // believed -- an eyewitness with nobody contradicting them should not end up
  // doubting themselves for want of an opponent to beat.
  const decisive =
    decidable &&
    (!hasRival || leader.score - ranked[1].score >= SCORING.decisionMargin);

  return ranked.map((verdict, index) => {
    const opposing = Math.max(
      0,
      ...ranked
        .filter((other) => other.claimId !== verdict.claimId)
        .map((other) => other.score),
      0,
    );

    let status: BeliefStatus;
    if (!decidable) {
      status = "unknown";
    } else if (decisive) {
      status = index === 0 ? "believed" : "rejected";
    } else {
      // Two credible accounts, too close to separate. Holding both in doubt is
      // the honest outcome; picking one would be a coin toss wearing a number.
      status =
        leader.score - verdict.score < SCORING.decisionMargin ? "doubted" : "rejected";
    }

    return {
      claimId: verdict.claimId,
      status,
      score: verdict.score,
      opposingScore: opposing,
      contributions: verdict.contributions,
      priorBias: verdict.priorBias,
    };
  });
}
