/**
 * Turning a vector search into what a villager actually has in mind.
 *
 * The database returns candidate memory rows ordered by embedding distance.
 * Two things have to happen before those rows mean anything:
 *
 *   1. Collapse them by claim. One villager can hold the same proposition
 *      several times over -- told once, told again, and perhaps witnessed. Left
 *      alone, those duplicates crowd out every other topic in the top-k.
 *   2. Separate corroboration from repetition. Two informants agreeing is
 *      evidence. One informant saying it twice is the same evidence heard
 *      twice, and must not be laundered into the former.
 *
 * The distinction is drawn by provenance: every memory is traced back along its
 * source chain to whoever first held it. Distinct roots corroborate; shared
 * roots merely repeat.
 */

import { MCP_SAFE_RECALL_LIMIT } from "./queries";
import {
  recallScore,
  type MemoryRow,
  type RecallBreakdown,
  type SupportCounts,
} from "./scoring";

export interface Candidate {
  memory: MemoryRow;
  /** Cosine similarity between the topic and the memory's claim, in [-1, 1]. */
  similarity: number;
}

export interface ClaimGroup {
  claimId: string;
  /** Highest scoring memory of this claim; the one the villager speaks from. */
  representative: RecallBreakdown;
  /** Every held memory of this claim, best first. */
  members: RecallBreakdown[];
  support: SupportCounts;
  /** Distinct origins this claim reached the villager through. */
  sourceRoots: string[];
}

export interface AggregateOptions {
  simulatedAt: Date;
  trustOf: (actorId: string | null) => number;
  /**
   * Resolve a memory to the identifier of whoever originated the chain it
   * arrived through. Falls back to the memory itself for first-hand accounts.
   */
  rootOf?: (memory: MemoryRow) => string;
}

/**
 * Resolve source roots within a set of memories.
 *
 * Chains that leave the set -- because the earlier link belongs to a different
 * villager and was not fetched -- terminate at the informant, which is the
 * right granularity: what matters is whether two accounts came from the same
 * mouth, not how far back the story goes beyond that.
 */
export function computeRoots(memories: MemoryRow[]): Map<string, string> {
  const byId = new Map(memories.map((m) => [m.memoryId, m]));
  const roots = new Map<string, string>();

  for (const memory of memories) {
    const seen = new Set<string>();
    let current = memory;

    while (current.sourceMemoryId && byId.has(current.sourceMemoryId)) {
      if (seen.has(current.memoryId)) break; // defensive: never loop forever
      seen.add(current.memoryId);
      current = byId.get(current.sourceMemoryId)!;
    }

    roots.set(
      memory.memoryId,
      current.witnessedDirectly || !current.sourceActorId
        ? current.memoryId
        : current.sourceActorId,
    );
  }

  return roots;
}

/**
 * Group candidates by claim and rank them.
 *
 * Scoring needs the support counts and the support counts need the grouping, so
 * this runs in two passes rather than trying to do both at once.
 */
/**
 * How much independent backing each claim has, from provenance alone.
 *
 * Shared with belief evaluation, which asks the same question of a different
 * set of memories: recall asks it of whatever the vector search returned,
 * arbitration asks it of everything the villager holds about a disputed point.
 */
export function supportByClaim(
  memories: MemoryRow[],
  rootOf?: (memory: MemoryRow) => string,
): { support: Map<string, SupportCounts>; roots: Map<string, string[]> } {
  const fallback = computeRoots(memories);
  const resolve = rootOf ?? ((memory: MemoryRow) => fallback.get(memory.memoryId)!);

  const roots = new Map<string, string[]>();
  for (const memory of memories) {
    const list = roots.get(memory.claimId) ?? [];
    list.push(resolve(memory));
    roots.set(memory.claimId, list);
  }

  const support = new Map<string, SupportCounts>();
  for (const [claimId, list] of roots) {
    const distinct = new Set(list);
    support.set(claimId, {
      // The first account is the baseline, not corroboration of itself.
      corroborationCount: Math.max(0, distinct.size - 1),
      repeatCount: Math.max(0, list.length - distinct.size),
    });
  }

  return { support, roots };
}

export function aggregate(
  candidates: Candidate[],
  options: AggregateOptions,
): ClaimGroup[] {
  const memories = candidates.map((c) => c.memory);
  const { support: supportByClaimId, roots: rootsByClaim } = supportByClaim(
    memories,
    options.rootOf,
  );
  const supportMap = supportByClaimId;

  // Pass two: score every candidate now that support is known.
  const context = {
    simulatedAt: options.simulatedAt,
    trustOf: options.trustOf,
    supportOf: (claimId: string) =>
      supportMap.get(claimId) ?? { corroborationCount: 0, repeatCount: 0 },
  };

  const grouped = new Map<string, RecallBreakdown[]>();
  for (const candidate of candidates) {
    const breakdown = recallScore(candidate.memory, candidate.similarity, context);
    const list = grouped.get(candidate.memory.claimId) ?? [];
    list.push(breakdown);
    grouped.set(candidate.memory.claimId, list);
  }

  const groups: ClaimGroup[] = [];
  for (const [claimId, members] of grouped) {
    members.sort((a, b) => b.score - a.score);
    groups.push({
      claimId,
      representative: members[0],
      members,
      support: context.supportOf(claimId),
      sourceRoots: [...new Set(rootsByClaim.get(claimId) ?? [])],
    });
  }

  groups.sort((a, b) => b.representative.score - a.representative.score);
  return groups;
}

/**
 * How many candidates to pull out of the database for a given final count.
 *
 * Over-fetching is not tuning slack. Vector search is approximate, so the tail
 * of a result set is genuinely unstable between runs, and duplicates of one
 * claim can occupy several slots -- on the seeded world, Gen holds the same
 * proposition about the well twice, at identical distance. Asking for k and
 * returning k would let both effects change what a villager says.
 *
 * The ceiling is not a preference. Managed MCP truncates responses at 10 KiB
 * and the ranking projection costs about 410 bytes a row, so this is as wide
 * as a single recall can be.
 */
export function fetchWidth(desiredClaims: number): number {
  return Math.min(MCP_SAFE_RECALL_LIMIT, Math.max(12, desiredClaims * 6));
}
