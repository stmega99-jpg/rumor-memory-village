/**
 * SQL construction for the recall path.
 *
 * The Managed MCP `select_query` tool takes a SQL string and offers no bind
 * parameters, so every value in a recall query has to be inlined. That makes
 * this module the one place where untrusted input could become SQL, and it is
 * written to fail closed: identifiers are validated against their expected
 * shape and rejected outright rather than escaped. Nothing here ever quotes
 * its way around a bad value.
 *
 * The 384 floats of a query vector dominate the statement, so the builders
 * also keep an eye on the 16,384 character ceiling the MCP tool enforces.
 */

/** Managed MCP rejects any statement longer than this. */
export const MCP_STATEMENT_LIMIT = 16_384;
/** ...and truncates responses beyond this, which is why vectors are never selected. */
export const MCP_RESPONSE_LIMIT_BYTES = 10 * 1024;

/**
 * Candidates a single recall may ask for.
 *
 * Measured against the live cluster: the ranking projection costs about 410
 * bytes per row, so 24 rows came to 9,861 of the 10,240 available -- passing,
 * but with four percent to spare, which is not a margin. Twenty rows leaves
 * roughly a fifth of the budget free, which survives a villager whose memories
 * happen to carry longer identifiers or more non-null timestamps.
 */
export const MCP_SAFE_RECALL_LIMIT = 20;

export const EMBEDDING_DIMENSIONS = 384;
const VECTOR_DECIMALS = 6;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UnsafeQueryValueError extends Error {
  constructor(what: string) {
    super(`Refusing to build SQL with an invalid ${what}.`);
    this.name = "UnsafeQueryValueError";
  }
}

/** A UUID, or an exception. Never a quoted approximation of one. */
export function uuid(value: unknown, label = "identifier"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new UnsafeQueryValueError(label);
  }
  return `'${value}'`;
}

export function positiveInt(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new UnsafeQueryValueError(label);
  }
  return String(value);
}

/**
 * Render an embedding as a SQL literal.
 *
 * Six decimals is not a rounding convenience: at full JavaScript float
 * precision a 384-dimension vector runs to roughly 7,000 characters, and two
 * copies of it -- the select list and the order by -- would crowd the rest of
 * the statement against the MCP ceiling.
 */
export function vectorLiteral(values: readonly number[]): string {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
    throw new UnsafeQueryValueError("embedding length");
  }
  const parts = new Array<string>(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new UnsafeQueryValueError("embedding component");
    }
    parts[i] = value.toFixed(VECTOR_DECIMALS);
  }
  return `'[${parts.join(",")}]'::VECTOR(${EMBEDDING_DIMENSIONS})`;
}

export interface RecallQueryInput {
  worldId: string;
  ownerNpcId: string;
  embedding: readonly number[];
  limit: number;
}

/**
 * Top-k memories of one villager, nearest to a topic.
 *
 * Reads the MCP projection rather than the base table so ground truth is out of
 * reach, and mentions the vector exactly once so the statement stays well
 * inside the length ceiling.
 *
 * Only the columns ranking needs are selected. Prose -- `surface_ja` above all
 * -- is deliberately left behind: measured against the live cluster, carrying
 * it made a 24-row response 12.8 KB against a 10 KiB ceiling. Text is fetched
 * afterwards, for the handful of memories a villager actually speaks from,
 * which is a fraction of what recall considers.
 */
export function buildRecallQuery(input: RecallQueryInput): string {
  const world = uuid(input.worldId, "world id");
  const owner = uuid(input.ownerNpcId, "villager id");
  const limit = positiveInt(input.limit, "limit", 200);
  const vector = vectorLiteral(input.embedding);

  const sql = `SELECT memory_id, claim_id, source_actor_id, source_memory_id, source_forgotten_at, witnessed_directly, confidence_at_acq, importance, emotional_weight, emotion_type, acquired_at, last_recalled_at, embedding <=> ${vector} AS distance FROM mcp_memory_recall WHERE world_id = ${world} AND owner_npc_id = ${owner} ORDER BY distance LIMIT ${limit}`;

  if (sql.length > MCP_STATEMENT_LIMIT) {
    throw new UnsafeQueryValueError(`statement length (${sql.length} chars)`);
  }
  return sql;
}

/**
 * Surface text for specific memories, fetched once the ranking has narrowed
 * the field. Keep the batch small: this is prose, and the response ceiling is
 * measured in kilobytes.
 */
export function buildMemoryTextQuery(
  worldId: string,
  memoryIds: readonly string[],
): string {
  const world = uuid(worldId, "world id");
  if (memoryIds.length === 0) {
    throw new UnsafeQueryValueError("empty memory list");
  }
  if (memoryIds.length > 12) {
    throw new UnsafeQueryValueError("memory batch size");
  }
  const ids = memoryIds.map((id) => uuid(id, "memory id")).join(", ");
  return `SELECT memory_id, claim_id, source_type, recall_count, surface_ja FROM mcp_memory_recall WHERE world_id = ${world} AND memory_id IN (${ids})`;
}

/** Claim text for a set of claim ids. Vectors deliberately excluded. */
export function buildClaimQuery(worldId: string, claimIds: readonly string[]): string {
  const world = uuid(worldId, "world id");
  if (claimIds.length === 0) {
    throw new UnsafeQueryValueError("empty claim list");
  }
  const ids = claimIds.map((id) => uuid(id, "claim id")).join(", ");
  const sql = `SELECT claim_id, subject_id, predicate, canonical_ja, canonical_en FROM mcp_claim WHERE world_id = ${world} AND claim_id IN (${ids})`;

  if (sql.length > MCP_STATEMENT_LIMIT) {
    throw new UnsafeQueryValueError(`statement length (${sql.length} chars)`);
  }
  return sql;
}

/** Directed trust from one villager toward everyone they know. */
export function buildRelationshipQuery(worldId: string, npcId: string): string {
  return `SELECT target_id, trust, affection, fear FROM relationship WHERE world_id = ${uuid(
    worldId,
    "world id",
  )} AND npc_id = ${uuid(npcId, "villager id")}`;
}
