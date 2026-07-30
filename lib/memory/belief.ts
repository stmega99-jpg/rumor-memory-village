/**
 * Belief evaluation.
 *
 * Given everything a villager holds about a disputed point, decide what they
 * currently think and write down why in a form that can be recomputed. Both
 * sides of a contradiction stay in memory; only the verdict moves.
 *
 * The database handle is injected rather than imported. Belief evaluation is
 * driven from a request handler, from a seeding script, and from tests, and
 * only one of those lives inside Next.js.
 */

import {
  arbitrate,
  claimSupport,
  decayedConfidence,
  ENGINE_VERSION,
  SCORING,
  type BeliefOutcome,
  type MemoryRow,
} from "./scoring";
import { supportByClaim } from "./recall";

/** Anything that can run a parameterised query. */
export type Executor = <T extends Record<string, unknown>>(
  sql: string,
  values?: unknown[],
) => Promise<T[]>;

export interface ActorFeeling {
  trust: number;
  affection: number;
  fear: number;
}

export interface ClaimFacts {
  claimId: string;
  canonicalJa: string;
  canonicalEn: string;
  subjectId: string | null;
  subjectLabel: string;
  subjectValence: number;
}

const NEUTRAL: ActorFeeling = { trust: 0.4, affection: 0, fear: 0 };

function toMemoryRow(row: Record<string, unknown>): MemoryRow {
  return {
    memoryId: String(row.id),
    ownerNpcId: String(row.owner_npc_id),
    claimId: String(row.claim_id),
    sourceType: row.source_type as MemoryRow["sourceType"],
    sourceActorId: row.source_actor_id ? String(row.source_actor_id) : null,
    sourceMemoryId: row.source_memory_id ? String(row.source_memory_id) : null,
    sourceForgottenAt: row.source_forgotten_at
      ? new Date(row.source_forgotten_at as string)
      : null,
    witnessedDirectly: Boolean(row.witnessed_directly),
    confidenceAtAcq: Number(row.confidence_at_acq),
    importance: Number(row.importance),
    emotionalWeight: Number(row.emotional_weight),
    emotionType: String(row.emotion_type),
    acquiredAt: new Date(row.acquired_at as string),
    lastRecalledAt: row.last_recalled_at
      ? new Date(row.last_recalled_at as string)
      : null,
    surfaceJa: String(row.surface_ja ?? ""),
  };
}

export async function loadFeelings(
  exec: Executor,
  worldId: string,
  npcId: string,
): Promise<Map<string, ActorFeeling>> {
  const rows = await exec<{
    target_id: string;
    trust: string;
    affection: string;
    fear: string;
  }>(
    `SELECT target_id, trust, affection, fear FROM relationship
     WHERE world_id = $1 AND npc_id = $2`,
    [worldId, npcId],
  );

  return new Map(
    rows.map((row) => [
      row.target_id,
      {
        trust: Number(row.trust),
        affection: Number(row.affection),
        fear: Number(row.fear),
      },
    ]),
  );
}

/**
 * Sets of propositions that cannot all be true.
 *
 * Built by walking `mutually_exclusive` edges, so a three-way dispute forms one
 * group rather than three unrelated pairs.
 */
export async function loadContradictionGroups(
  exec: Executor,
  worldId: string,
): Promise<string[][]> {
  const rows = await exec<{ claim_a: string; claim_b: string }>(
    `SELECT claim_a, claim_b FROM claim_relation
     WHERE world_id = $1 AND relation = 'mutually_exclusive'`,
    [worldId],
  );

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };

  for (const { claim_a: a, claim_b: b } of rows) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const groups = new Map<string, string[]>();
  for (const id of new Set(rows.flatMap((r) => [r.claim_a, r.claim_b]))) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()].map((group) => group.sort());
}

export async function loadClaimFacts(
  exec: Executor,
  worldId: string,
  claimIds: string[],
): Promise<Map<string, ClaimFacts>> {
  if (claimIds.length === 0) return new Map();

  const rows = await exec<Record<string, unknown>>(
    `SELECT id, canonical_ja, canonical_en, subject_id, subject_label, subject_valence
     FROM claim WHERE world_id = $1 AND id = ANY($2::UUID[])`,
    [worldId, claimIds],
  );

  return new Map(
    rows.map((row) => [
      String(row.id),
      {
        claimId: String(row.id),
        canonicalJa: String(row.canonical_ja),
        canonicalEn: String(row.canonical_en),
        subjectId: row.subject_id ? String(row.subject_id) : null,
        subjectLabel: String(row.subject_label),
        subjectValence: Number(row.subject_valence),
      },
    ]),
  );
}

export async function loadMemoriesForClaims(
  exec: Executor,
  worldId: string,
  npcId: string,
  claimIds: string[],
): Promise<MemoryRow[]> {
  if (claimIds.length === 0) return [];

  const rows = await exec<Record<string, unknown>>(
    `SELECT id, owner_npc_id, claim_id, source_type, source_actor_id,
            source_memory_id, source_forgotten_at, witnessed_directly,
            confidence_at_acq, importance, emotional_weight, emotion_type,
            acquired_at, last_recalled_at, surface_ja
     FROM memory
     WHERE world_id = $1 AND owner_npc_id = $2 AND claim_id = ANY($3::UUID[])`,
    [worldId, npcId, claimIds],
  );

  return rows.map(toMemoryRow);
}

export interface RationaleContribution {
  memoryId: string;
  source: string;
  trust: number;
  confidence: number;
  witnessed: boolean;
  contribution: number;
}

export interface BeliefRationale {
  engineVersion: string;
  conclusion: string;
  score: number;
  opposingScore: number;
  priorBias: number;
  corroborationCount: number;
  repeatCount: number;
  usedMemories: RationaleContribution[];
}

/**
 * A sentence a person could check.
 *
 * Written from the same numbers the verdict came from, so a reader who doubts
 * the wording can look at the contributions and recompute it. The point of the
 * demo is that this is derivable, not that it reads well.
 */
function narrate(
  outcome: BeliefOutcome,
  facts: ClaimFacts,
  names: Map<string, string>,
  support: { corroborationCount: number; repeatCount: number },
  npcNameJa: string,
  npcNameEn: string,
): { ja: string; en: string } {
  const top = [...outcome.contributions].sort(
    (a, b) => b.contribution - a.contribution,
  )[0];
  const sourceJa = top
    ? top.witnessedDirectly
      ? "自分で見た"
      : `${names.get(top.sourceActorId ?? "") ?? "誰か"}から聞いた`
    : "根拠がない";
  const sourceEn = top
    ? top.witnessedDirectly
      ? "saw it themselves"
      : `heard it from ${names.get(top.sourceActorId ?? "") ?? "someone"}`
    : "has nothing to go on";

  const verdictJa = {
    believed: "信じている",
    doubted: "疑っている",
    rejected: "否定している",
    unknown: "判断がつかない",
  }[outcome.status];
  const verdictEn = {
    believed: "believes it",
    doubted: "is unsure",
    rejected: "rejects it",
    unknown: "has no view",
  }[outcome.status];

  const reasons: string[] = [];
  const reasonsEn: string[] = [];
  if (top && !top.witnessedDirectly) {
    reasons.push(`情報源への信頼度は ${top.trust.toFixed(2)}`);
    reasonsEn.push(`trusts that informant ${top.trust.toFixed(2)}`);
  }
  if (support.corroborationCount > 0) {
    reasons.push(`独立した情報源が ${support.corroborationCount + 1} 人`);
    reasonsEn.push(`${support.corroborationCount + 1} independent sources`);
  }
  if (support.repeatCount > 0) {
    reasons.push(`同じ相手から ${support.repeatCount + 1} 回`);
    reasonsEn.push(`the same informant ${support.repeatCount + 1} times`);
  }
  if (Math.abs(outcome.priorBias) > 0.05) {
    const leaning = outcome.priorBias > 0 ? "好意的" : "否定的";
    reasons.push(`${facts.subjectLabel}への感情が${leaning}に働いた`);
    reasonsEn.push(
      `${outcome.priorBias > 0 ? "warm" : "cold"} feelings toward ${facts.subjectLabel}`,
    );
  }

  return {
    ja: `${npcNameJa}は「${facts.canonicalJa}」を${verdictJa}。${sourceJa}話で、${
      reasons.length > 0 ? reasons.join("、") : "他に手がかりがない"
    }。`,
    en: `${npcNameEn} ${verdictEn}: "${facts.canonicalEn}". They ${sourceEn}; ${
      reasonsEn.length > 0 ? reasonsEn.join(", ") : "nothing else to weigh"
    }.`,
  };
}

export interface EvaluatedBelief {
  npcId: string;
  claimId: string;
  outcome: BeliefOutcome;
  facts: ClaimFacts;
  rationale: BeliefRationale;
  textJa: string;
  textEn: string;
}

/**
 * Decide every disputed point for one villager and persist the verdicts.
 *
 * Claims a villager holds no memory of are skipped rather than recorded as
 * rejected: never having heard something is not the same as disbelieving it.
 */
export async function evaluateBeliefs(
  exec: Executor,
  worldId: string,
  npcId: string,
  simulatedAt: Date,
  names: Map<string, string>,
  namesEn: Map<string, string>,
): Promise<EvaluatedBelief[]> {
  const feelings = await loadFeelings(exec, worldId, npcId);
  const groups = await loadContradictionGroups(exec, worldId);
  const results: EvaluatedBelief[] = [];

  for (const group of groups) {
    const memories = await loadMemoriesForClaims(exec, worldId, npcId, group);
    if (memories.length === 0) continue;

    const facts = await loadClaimFacts(exec, worldId, group);
    const { support } = supportByClaim(memories);
    const context = {
      simulatedAt,
      trustOf: (actorId: string | null) =>
        actorId ? (feelings.get(actorId) ?? NEUTRAL).trust : NEUTRAL.trust,
      supportOf: (claimId: string) =>
        support.get(claimId) ?? { corroborationCount: 0, repeatCount: 0 },
    };

    const held = group.filter((claimId) =>
      memories.some((memory) => memory.claimId === claimId),
    );

    const verdicts = held.map((claimId) => {
      const claim = facts.get(claimId);
      // How the villager already feels about whoever the claim is about,
      // pointed the way the claim points.
      const affection = claim?.subjectId
        ? (feelings.get(claim.subjectId) ?? NEUTRAL).affection
        : 0;
      const priorBias = affection * (claim?.subjectValence ?? 0);

      return claimSupport(
        {
          claimId,
          memories: memories.filter((memory) => memory.claimId === claimId),
        },
        context,
        priorBias,
      );
    });

    for (const outcome of arbitrate(verdicts)) {
      const claim = facts.get(outcome.claimId);
      if (!claim) continue;

      const counts = context.supportOf(outcome.claimId);
      const text = narrate(
        outcome,
        claim,
        names,
        counts,
        names.get(npcId) ?? "?",
        namesEn.get(npcId) ?? "?",
      );

      const rationale: BeliefRationale = {
        engineVersion: ENGINE_VERSION,
        conclusion: outcome.status,
        score: outcome.score,
        opposingScore: outcome.opposingScore,
        priorBias: outcome.priorBias,
        corroborationCount: counts.corroborationCount,
        repeatCount: counts.repeatCount,
        usedMemories: outcome.contributions.map((contribution) => ({
          memoryId: contribution.memoryId,
          source: contribution.witnessedDirectly
            ? "self"
            : (names.get(contribution.sourceActorId ?? "") ?? "unknown"),
          trust: contribution.trust,
          confidence: contribution.confidence,
          witnessed: contribution.witnessedDirectly,
          contribution: contribution.contribution,
        })),
      };

      await exec(
        `UPSERT INTO belief (world_id, npc_id, claim_id, status, score,
                             opposing_score, rationale_json, rationale_text_ja,
                             rationale_text_en, engine_version, last_evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          worldId,
          npcId,
          outcome.claimId,
          outcome.status,
          outcome.score,
          outcome.opposingScore,
          JSON.stringify(rationale),
          text.ja,
          text.en,
          ENGINE_VERSION,
          simulatedAt,
        ],
      );

      results.push({
        npcId,
        claimId: outcome.claimId,
        outcome,
        facts: claim,
        rationale,
        textJa: text.ja,
        textEn: text.en,
      });
    }
  }

  return results;
}

export { decayedConfidence, SCORING };
