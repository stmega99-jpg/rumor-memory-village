/**
 * Recall: what a villager brings to mind when a topic comes up.
 *
 * The vector search runs through Managed MCP, the ranking runs here, and the
 * two are kept apart on purpose. The database decides what is semantically
 * nearby; whether a nearby memory is one this villager would actually reach
 * for depends on who told them, how sure they were, how long ago it was and how
 * much it mattered -- none of which a distance function knows about.
 */

import { aggregate, fetchWidth, type Candidate, type ClaimGroup } from "./recall";
import {
  buildMemoryTextQuery,
  buildRecallQuery,
  MCP_SAFE_RECALL_LIMIT,
} from "./queries";
import { runSelectQuery, type McpCredentials } from "./mcp-client";
import type { MemoryRow } from "./scoring";

/** Values cross the MCP boundary as JSON, so nothing arrives already typed. */
function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function rowToMemory(row: Record<string, unknown>): MemoryRow {
  return {
    memoryId: String(row.memory_id),
    ownerNpcId: String(row.owner_npc_id ?? ""),
    claimId: String(row.claim_id),
    sourceType: (row.source_type as MemoryRow["sourceType"]) ?? "heard",
    sourceActorId: row.source_actor_id ? String(row.source_actor_id) : null,
    sourceMemoryId: row.source_memory_id ? String(row.source_memory_id) : null,
    sourceForgottenAt: asDate(row.source_forgotten_at),
    witnessedDirectly: row.witnessed_directly === true || row.witnessed_directly === "true",
    confidenceAtAcq: asNumber(row.confidence_at_acq, 0.5),
    importance: asNumber(row.importance),
    emotionalWeight: asNumber(row.emotional_weight),
    emotionType: String(row.emotion_type ?? "neutral"),
    acquiredAt: asDate(row.acquired_at) ?? new Date(0),
    lastRecalledAt: asDate(row.last_recalled_at),
    // Prose is not carried by the ranking pass; it is fetched for the few
    // memories that end up being spoken from.
    surfaceJa: "",
  };
}

export interface RecallRequest {
  worldId: string;
  npcId: string;
  /** Embedding of whatever the villager is being asked about. */
  embedding: readonly number[];
  /** How many distinct propositions the caller wants back. */
  wantClaims?: number;
  simulatedAt: Date;
  trustOf: (actorId: string | null) => number;
  credentials: McpCredentials;
  database?: string;
}

export interface RecallResult {
  groups: ClaimGroup[];
  candidateCount: number;
  /** The statement that was sent, for the explanation log. */
  statement: string;
}

/**
 * Search a villager's memory for a topic and rank what comes back.
 *
 * Returns groups, not rows: one villager can hold the same proposition several
 * times over, and a list where the top four entries are the same story would
 * misrepresent both what they know and how sure they are of it.
 */
export async function recall(request: RecallRequest): Promise<RecallResult> {
  const limit = Math.min(
    MCP_SAFE_RECALL_LIMIT,
    fetchWidth(request.wantClaims ?? 3),
  );

  const statement = buildRecallQuery({
    worldId: request.worldId,
    ownerNpcId: request.npcId,
    embedding: request.embedding,
    limit,
  });

  const rows = await runSelectQuery(
    statement,
    request.database ?? "rumor_memory_village",
    request.credentials,
  );

  const candidates: Candidate[] = rows.map((row) => ({
    memory: { ...rowToMemory(row), ownerNpcId: request.npcId },
    // CockroachDB returns cosine distance; similarity is its complement.
    similarity: 1 - asNumber(row.distance, 1),
  }));

  const groups = aggregate(candidates, {
    simulatedAt: request.simulatedAt,
    trustOf: request.trustOf,
  });

  return { groups, candidateCount: candidates.length, statement };
}

/**
 * Fill in the wording for the memories a villager is about to speak from.
 *
 * Separate from ranking because prose is expensive on a 10 KiB response budget
 * and most candidates never get used.
 */
export async function hydrateSurfaces(
  worldId: string,
  memoryIds: string[],
  credentials: McpCredentials,
  database = "rumor_memory_village",
): Promise<Map<string, string>> {
  if (memoryIds.length === 0) return new Map();

  const rows = await runSelectQuery(
    buildMemoryTextQuery(worldId, memoryIds),
    database,
    credentials,
  );

  return new Map(
    rows.map((row) => [String(row.memory_id), String(row.surface_ja ?? "")]),
  );
}
