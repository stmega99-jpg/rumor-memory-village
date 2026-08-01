/**
 * Persisting one villager telling another something.
 *
 * The decision itself lives in propagation.ts and is pure. This module is the
 * part that touches the world: it finds what the speaker actually holds, asks
 * whether the listener takes it on, and records the hop either way. Refusals
 * are written down too -- a rumour that failed to cross is exactly as
 * interesting as one that did, and a propagation graph with only successes in
 * it would be a graph of what we wanted to happen.
 */

import { randomUUID } from "node:crypto";

import type { Executor } from "./belief";
import { tell, type TellOutcome } from "./propagation";
import { supportByClaim } from "./recall";
import type { MemoryRow } from "./scoring";

export interface TellResult {
  outcome: TellOutcome;
  transferId: string;
  createdMemoryId: string | null;
}

function rowToMemory(row: Record<string, unknown>): MemoryRow {
  return {
    memoryId: String(row.id),
    ownerNpcId: String(row.owner_npc_id),
    claimId: String(row.claim_id),
    sourceType: row.source_type as MemoryRow["sourceType"],
    sourceActorId: row.source_actor_id ? String(row.source_actor_id) : null,
    sourceMemoryId: row.source_memory_id ? String(row.source_memory_id) : null,
    provenanceRootMemoryId: String(row.provenance_root_memory_id),
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

/** How many hops this account has already travelled to reach the speaker. */
async function hopCount(
  exec: Executor,
  worldId: string,
  memoryId: string,
): Promise<number> {
  let hops = 0;
  let current: string | null = memoryId;
  const seen = new Set<string>();

  while (current && !seen.has(current)) {
    seen.add(current);
    const rows: Array<{ source_memory_id: string | null }> = await exec<{
      source_memory_id: string | null;
    }>("SELECT source_memory_id FROM memory WHERE world_id = $1 AND id = $2", [
      worldId,
      current,
    ]);
    current = rows[0]?.source_memory_id ?? null;
    if (current) hops += 1;
  }

  return hops;
}

export interface TellRequestInput {
  worldId: string;
  speakerId: string;
  listenerId: string;
  claimId: string;
  simulatedAt: Date;
}

/**
 * Have one villager tell another about a claim, and record what happened.
 *
 * Returns null when the speaker has nothing to say: you cannot pass on a
 * proposition you hold no memory of.
 */
export async function tellAbout(
  exec: Executor,
  input: TellRequestInput,
): Promise<TellResult | null> {
  const { worldId, speakerId, listenerId, claimId, simulatedAt } = input;

  const speakerRows = await exec<Record<string, unknown>>(
     `SELECT id, owner_npc_id, claim_id, source_type, source_actor_id,
            source_memory_id, provenance_root_memory_id, source_forgotten_at, witnessed_directly,
            confidence_at_acq, importance, emotional_weight, emotion_type,
            acquired_at, last_recalled_at, surface_ja
     FROM memory
     WHERE world_id = $1 AND owner_npc_id = $2 AND claim_id = $3
     ORDER BY witnessed_directly DESC, confidence_at_acq DESC
     LIMIT 1`,
    [worldId, speakerId, claimId],
  );
  if (speakerRows.length === 0) return null;

  const speakerMemory = rowToMemory(speakerRows[0]);

  // Support is computed over everything the speaker holds about this claim,
  // not just the memory they happen to be speaking from.
  const allOfClaim = (
    await exec<Record<string, unknown>>(
       `SELECT id, owner_npc_id, claim_id, source_type, source_actor_id,
               source_memory_id, provenance_root_memory_id, source_forgotten_at, witnessed_directly,
              confidence_at_acq, importance, emotional_weight, emotion_type,
              acquired_at, last_recalled_at, surface_ja
       FROM memory WHERE world_id = $1 AND owner_npc_id = $2 AND claim_id = $3`,
      [worldId, speakerId, claimId],
    )
  ).map(rowToMemory);
  const { support } = supportByClaim(allOfClaim);

  const trustRows = await exec<{ trust: string }>(
    `SELECT trust FROM relationship WHERE world_id = $1 AND npc_id = $2 AND target_id = $3`,
    [worldId, listenerId, speakerId],
  );
  const trust = trustRows.length > 0 ? Number(trustRows[0].trust) : 0.3;

  const heldRows = await exec<{ n: string }>(
    `SELECT count(*)::INT AS n FROM memory
     WHERE world_id = $1 AND owner_npc_id = $2 AND claim_id = $3`,
    [worldId, listenerId, claimId],
  );
  const listenerAlreadyHolds = Number(heldRows[0].n) > 0;

  // Contested means the listener currently believes something this claim
  // cannot coexist with -- a higher bar than merely hearing it for the first
  // time.
  const contestedRows = await exec<{ n: string }>(
    `SELECT count(*)::INT AS n
     FROM belief b
     JOIN claim_relation r
       ON r.world_id = b.world_id
      AND r.relation = 'mutually_exclusive'
      AND ((r.claim_a = $3 AND r.claim_b = b.claim_id)
        OR (r.claim_b = $3 AND r.claim_a = b.claim_id))
     WHERE b.world_id = $1 AND b.npc_id = $2 AND b.status = 'believed'`,
    [worldId, listenerId, claimId],
  );
  const contested = Number(contestedRows[0].n) > 0;

  const outcome = tell({
    speakerId,
    listenerId,
    memory: speakerMemory,
    support: support.get(claimId) ?? { corroborationCount: 0, repeatCount: 0 },
    simulatedAt,
    trust,
    hop: await hopCount(exec, worldId, speakerMemory.memoryId),
    contested,
    listenerAlreadyHolds,
  });

  const transferId = randomUUID();
  let createdMemoryId: string | null = null;

  if (outcome.outcome === "adopted") {
    createdMemoryId = randomUUID();
    await exec(
      `INSERT INTO memory (world_id, id, owner_npc_id, claim_id, source_type,
                           source_actor_id, source_memory_id,
                           provenance_root_memory_id, witnessed_directly,
                           confidence_at_acq, importance, emotional_weight,
                           emotion_type, acquired_at, surface_ja, embedding)
       SELECT $1, $2, $3, $4, 'heard', $5, $6, $7, false, $8, $9, $10, $11, $12, $13,
               c.embedding
       FROM claim c WHERE c.world_id = $1 AND c.id = $4`,
      [
        worldId,
        createdMemoryId,
        listenerId,
        claimId,
        outcome.sourceActorId,
        outcome.sourceMemoryId,
        speakerMemory.provenanceRootMemoryId,
        outcome.confidence,
        // A story someone bothered to tell you matters a little more than the
        // weather, but less than something you saw yourself.
        Math.min(1, speakerMemory.importance * 0.8),
        speakerMemory.emotionalWeight * 0.6,
        speakerMemory.emotionType,
        simulatedAt,
        outcome.surfaceJa,
      ],
    );
  }

  await exec(
    `INSERT INTO rumor_transfer (world_id, id, claim_id, from_actor_id, to_actor_id,
                                 source_memory_id, created_memory_id,
                                 confidence_before, confidence_after, outcome,
                                 distortion_note, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      worldId,
      transferId,
      claimId,
      speakerId,
      listenerId,
      speakerMemory.memoryId,
      createdMemoryId,
      outcome.confidenceBefore,
      outcome.outcome === "adopted" ? outcome.confidence : outcome.confidenceBefore,
      outcome.outcome,
      outcome.outcome === "adopted"
        ? outcome.distortionNote
        : `refused: ${outcome.reason}`,
      simulatedAt,
    ],
  );

  return { outcome, transferId, createdMemoryId };
}
