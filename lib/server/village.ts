import "server-only";

import { cookies } from "next/headers";

import type { Executor } from "../memory/belief";
import { getPool, transaction } from "../memory/db";
import { forkWorld, getTemplateWorldId, pruneForks } from "../memory/world";
import { getRuntimeSecrets } from "../walking-skeleton/config";
import type { McpCredentials } from "../memory/mcp-client";
import { templateLine } from "../memory/utterance";

/**
 * Server-side plumbing for the village.
 *
 * Each visitor gets their own world. The demo is a persistent memory system on
 * a public URL, so without that the second judge to arrive inherits whatever
 * the first one did: rumours already spread, time already advanced, beliefs
 * already settled. A cookie is enough to hold the association -- there is no
 * account here and nothing worth protecting in a world id.
 */

const WORLD_COOKIE = "rmv_world";
const WORLD_MAX_AGE_SECONDS = 6 * 60 * 60;

export const executor: Executor = async (sql, values = []) => {
  const pool = await getPool();
  const result = await pool.query(sql, values);
  return result.rows as never;
};

export async function mcpCredentials(): Promise<McpCredentials> {
  const secrets = await getRuntimeSecrets();
  return {
    apiKey: secrets.cockroachMcpApiKey,
    clusterId: secrets.cockroachClusterId,
  };
}

async function worldExists(worldId: string): Promise<boolean> {
  const rows = await executor<{ id: string }>(
    "SELECT id FROM rumor_memory_village.public.world WHERE id = $1",
    [worldId],
  );
  return rows.length > 0;
}

/**
 * The world this visitor is looking at, forking one if they have no usable
 * cookie.
 *
 * Forking costs a few seconds, so it happens on first contact rather than on
 * every request, and a cookie pointing at a pruned world quietly becomes a new
 * one instead of an error page.
 */
export async function currentWorldId(): Promise<{ worldId: string; fresh: boolean }> {
  const jar = await cookies();
  const existing = jar.get(WORLD_COOKIE)?.value;

  if (existing && (await worldExists(existing))) {
    return { worldId: existing, fresh: false };
  }

  const template = await getTemplateWorldId(executor);
  const worldId = await transaction(async (client) => {
    const scoped: Executor = async (sql, values = []) =>
      (await client.query(sql, values)).rows as never;
    await scoped("SET database = rumor_memory_village");
    return forkWorld(scoped, template, "visitor");
  });

  jar.set(WORLD_COOKIE, worldId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WORLD_MAX_AGE_SECONDS,
    path: "/",
  });

  // Opportunistic cleanup. Every visit leaves a village behind, and one per
  // judge per refresh adds up faster than any scheduled job would notice.
  void pruneForks(executor, 6).catch(() => undefined);

  return { worldId, fresh: true };
}

export async function resetWorld(): Promise<string> {
  const jar = await cookies();
  jar.delete(WORLD_COOKIE);
  const { worldId } = await currentWorldId();
  return worldId;
}

export interface VillagerView {
  id: string;
  nameJa: string;
  nameEn: string;
  roleJa: string;
  roleEn: string;
  kind: string;
  trustInPlayer: number;
  affectionForPlayer: number;
  fearOfPlayer: number;
  memoryCount: number;
}

export interface VerdictView {
  npcId: string;
  npcNameJa: string;
  npcNameEn: string;
  claimId: string;
  claimJa: string;
  claimEn: string;
  truthValue: boolean | null;
  status: string;
  score: number;
  opposingScore: number;
  rationaleJa: string;
  rationaleEn: string;
  rationale: unknown;
  saidJa: string;
  saidEn: string;
  saidMode: string;
}

export interface TransferView {
  id: string;
  claimJa: string;
  claimEn: string;
  fromJa: string;
  fromEn: string;
  toJa: string;
  toEn: string;
  outcome: string;
  confidenceBefore: number;
  confidenceAfter: number;
  note: string;
  occurredAt: string;
}

export interface ContradictionView {
  aJa: string;
  aEn: string;
  bJa: string;
  bEn: string;
  holders: string[];
}

export interface VillageState {
  worldId: string;
  simulatedAt: string;
  villagers: VillagerView[];
  verdicts: VerdictView[];
  transfers: TransferView[];
  contradictions: ContradictionView[];
  totals: { claims: number; memories: number; transfers: number };
}

export async function loadVillage(worldId: string): Promise<VillageState> {
  const [world] = await executor<{ simulated_at: Date }>(
    "SELECT simulated_at FROM rumor_memory_village.public.world WHERE id = $1",
    [worldId],
  );

  const villagers = await executor<Record<string, unknown>>(
    `SELECT a.id, a.kind, a.name_ja, a.name_en, a.role_ja, a.role_en,
            COALESCE(r.trust, 0)     AS trust,
            COALESCE(r.affection, 0) AS affection,
            COALESCE(r.fear, 0)      AS fear,
            (SELECT count(*) FROM rumor_memory_village.public.memory m
              WHERE m.world_id = a.world_id AND m.owner_npc_id = a.id) AS memory_count
     FROM rumor_memory_village.public.actor a
     LEFT JOIN rumor_memory_village.public.relationship r
       ON r.world_id = a.world_id AND r.npc_id = a.id
      AND r.target_id = (SELECT p.id FROM rumor_memory_village.public.actor p
                          WHERE p.world_id = a.world_id AND p.kind = 'player' LIMIT 1)
     WHERE a.world_id = $1
     ORDER BY a.kind DESC, a.name_en`,
    [worldId],
  );

  // Each verdict is spoken from one memory: the strongest the villager holds
  // about that proposition. A pre-generated line overrides the template when
  // one exists for this exact belief state.
  const verdicts = await executor<Record<string, unknown>>(
    `SELECT b.npc_id, a.name_ja AS npc_ja, a.name_en AS npc_en,
            b.claim_id, c.canonical_ja, c.canonical_en, c.truth_value,
            b.status, b.score, b.opposing_score,
            b.rationale_text_ja, b.rationale_text_en, b.rationale_json,
            src.surface_ja, src.source_ja, src.source_en, src.emotional_weight,
            said.line_ja AS said_ja, said.line_en AS said_en,
            said.generation_mode
     FROM rumor_memory_village.public.belief b
     JOIN rumor_memory_village.public.actor a
       ON a.world_id = b.world_id AND a.id = b.npc_id
     JOIN rumor_memory_village.public.claim c
       ON c.world_id = b.world_id AND c.id = b.claim_id
     LEFT JOIN LATERAL (
       SELECT m.surface_ja, m.emotional_weight,
              s.name_ja AS source_ja, s.name_en AS source_en
         FROM rumor_memory_village.public.memory m
         LEFT JOIN rumor_memory_village.public.actor s
           ON s.world_id = m.world_id AND s.id = m.source_actor_id
        WHERE m.world_id = b.world_id
          AND m.owner_npc_id = b.npc_id
          AND m.claim_id = b.claim_id
        ORDER BY m.witnessed_directly DESC, m.confidence_at_acq DESC
        LIMIT 1
     ) AS src ON true
     -- Pre-generated dialogue is looked up in the template world, not this one.
     -- A fork keeps every row id and changes only the world, so a line written
     -- once against (speaker, claim, stance) is valid in every visitor's copy.
     -- Copying it per fork instead would mean regenerating it per fork, which
     -- is exactly the per-click Bedrock call the pre-generation avoids.
     LEFT JOIN LATERAL (
       SELECT v.line_ja, v.line_en, v.generation_mode
         FROM rumor_memory_village.public.conversation v
         JOIN rumor_memory_village.public.world tw
           ON tw.id = v.world_id AND tw.is_template = true
        WHERE v.speaker_id = b.npc_id
          AND v.belief_claim_id = b.claim_id
          AND v.topic = b.status
        ORDER BY v.occurred_at DESC
        LIMIT 1
     ) AS said ON true
     WHERE b.world_id = $1
     ORDER BY c.canonical_en, b.score DESC`,
    [worldId],
  );

  const transfers = await executor<Record<string, unknown>>(
    `SELECT t.id, c.canonical_ja, c.canonical_en,
            f.name_ja AS from_ja, f.name_en AS from_en,
            g.name_ja AS to_ja,   g.name_en AS to_en,
            t.outcome, t.confidence_before, t.confidence_after,
            t.distortion_note, t.occurred_at
     FROM rumor_memory_village.public.rumor_transfer t
     JOIN rumor_memory_village.public.claim c ON c.world_id = t.world_id AND c.id = t.claim_id
     JOIN rumor_memory_village.public.actor f ON f.world_id = t.world_id AND f.id = t.from_actor_id
     JOIN rumor_memory_village.public.actor g ON g.world_id = t.world_id AND g.id = t.to_actor_id
     WHERE t.world_id = $1
     ORDER BY t.occurred_at, t.id`,
    [worldId],
  );

  const contradictions = await executor<Record<string, unknown>>(
    `SELECT ca.canonical_ja AS a_ja, ca.canonical_en AS a_en,
            cb.canonical_ja AS b_ja, cb.canonical_en AS b_en,
            COALESCE(
              (SELECT array_agg(name)
                 FROM (
                   SELECT h.name_ja AS name
                     FROM rumor_memory_village.public.memory m
                     JOIN rumor_memory_village.public.actor h
                       ON h.world_id = m.world_id AND h.id = m.owner_npc_id
                    WHERE m.world_id = r.world_id
                      AND m.claim_id IN (r.claim_a, r.claim_b)
                    GROUP BY m.owner_npc_id, h.name_ja
                   HAVING count(DISTINCT m.claim_id) = 2
                 )),
              ARRAY[]::STRING[]
            ) AS holders
     FROM rumor_memory_village.public.claim_relation r
     JOIN rumor_memory_village.public.claim ca ON ca.world_id = r.world_id AND ca.id = r.claim_a
     JOIN rumor_memory_village.public.claim cb ON cb.world_id = r.world_id AND cb.id = r.claim_b
     WHERE r.world_id = $1 AND r.relation = 'mutually_exclusive'`,
    [worldId],
  );

  const [totals] = await executor<Record<string, unknown>>(
    `SELECT
       (SELECT count(*) FROM rumor_memory_village.public.claim WHERE world_id = $1)  AS claims,
       (SELECT count(*) FROM rumor_memory_village.public.memory WHERE world_id = $1) AS memories,
       (SELECT count(*) FROM rumor_memory_village.public.rumor_transfer WHERE world_id = $1) AS transfers`,
    [worldId],
  );

  return {
    worldId,
    simulatedAt: new Date(world.simulated_at).toISOString(),
    villagers: villagers.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      nameJa: String(row.name_ja),
      nameEn: String(row.name_en),
      roleJa: String(row.role_ja),
      roleEn: String(row.role_en),
      trustInPlayer: Number(row.trust),
      affectionForPlayer: Number(row.affection),
      fearOfPlayer: Number(row.fear),
      memoryCount: Number(row.memory_count),
    })),
    verdicts: verdicts.map((row) => {
      const spoken =
        row.said_ja && row.said_en
          ? {
              ja: String(row.said_ja),
              en: String(row.said_en),
              mode: String(row.generation_mode ?? "bedrock"),
            }
          : templateLine({
              villagerJa: String(row.npc_ja),
              villagerEn: String(row.npc_en),
              status: String(row.status),
              sourceJa: row.source_ja ? String(row.source_ja) : null,
              sourceEn: row.source_en ? String(row.source_en) : null,
              surfaceJa: String(row.surface_ja ?? row.canonical_ja),
              claimEn: String(row.canonical_en),
              emotionalWeight: Number(row.emotional_weight ?? 0),
            });

      return {
      npcId: String(row.npc_id),
      npcNameJa: String(row.npc_ja),
      npcNameEn: String(row.npc_en),
      claimId: String(row.claim_id),
      claimJa: String(row.canonical_ja),
      claimEn: String(row.canonical_en),
      truthValue: row.truth_value === null ? null : Boolean(row.truth_value),
      status: String(row.status),
      score: Number(row.score),
      opposingScore: Number(row.opposing_score),
      rationaleJa: String(row.rationale_text_ja),
      rationaleEn: String(row.rationale_text_en),
      rationale: row.rationale_json,
      saidJa: spoken.ja,
      saidEn: spoken.en,
      saidMode: spoken.mode,
      };
    }),
    transfers: transfers.map((row) => ({
      id: String(row.id),
      claimJa: String(row.canonical_ja),
      claimEn: String(row.canonical_en),
      fromJa: String(row.from_ja),
      fromEn: String(row.from_en),
      toJa: String(row.to_ja),
      toEn: String(row.to_en),
      outcome: String(row.outcome),
      confidenceBefore: Number(row.confidence_before),
      confidenceAfter: Number(row.confidence_after),
      note: String(row.distortion_note),
      occurredAt: new Date(row.occurred_at as string).toISOString(),
    })),
    contradictions: contradictions.map((row) => ({
      aJa: String(row.a_ja),
      aEn: String(row.a_en),
      bJa: String(row.b_ja),
      bEn: String(row.b_en),
      holders: (row.holders as string[] | null) ?? [],
    })),
    totals: {
      claims: Number(totals.claims),
      memories: Number(totals.memories),
      transfers: Number(totals.transfers),
    },
  };
}
