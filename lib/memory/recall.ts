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
 * The distinction is drawn by immutable provenance. Every memory stores the id
 * of the oldest memory in its source chain. Distinct roots corroborate; shared
 * roots merely repeat, even when the story arrived through different mouths.
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
   * Override the persisted root resolver. Intended for focused tests only;
   * production callers all use memory.provenanceRootMemoryId.
   */
  rootOf?: (memory: MemoryRow) => string;
}

/**
 * Read source roots from their persisted, world-scoped identity.
 *
 * Reconstructing roots from the candidate set is incorrect: recall candidates
 * belong to one owner, while the parent memory normally belongs to the previous
 * speaker. A chain walk over that set stops after one hop and launders one
 * original rumour relayed by two people into two independent sources.
 */
export function computeRoots(memories: MemoryRow[]): Map<string, string> {
  return new Map(
    memories.map((memory) => [memory.memoryId, memory.provenanceRootMemoryId]),
  );
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
  const resolve =
    rootOf ?? ((memory: MemoryRow) => memory.provenanceRootMemoryId);

  const roots = new Map<string, string[]>();
  for (const memory of memories) {
    const list = roots.get(memory.claimId) ?? [];
    list.push(resolve(memory));
    roots.set(memory.claimId, list);
  }

  const support = new Map<string, SupportCounts>();
  for (const [claimId, list] of roots) {
    const frequencies = new Map<string, number>();
    for (const root of list) {
      frequencies.set(root, (frequencies.get(root) ?? 0) + 1);
    }
    support.set(claimId, {
      // These are absolute counts used in the explanation contract. One root
      // heard twice is 1 independent source and 2 repeated acquisitions; two
      // roots heard once each are 2 independent sources and 0 repetitions.
      corroborationCount: frequencies.size,
      repeatCount: [...frequencies.values()].reduce(
        (total, count) => total + (count > 1 ? count : 0),
        0,
      ),
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
