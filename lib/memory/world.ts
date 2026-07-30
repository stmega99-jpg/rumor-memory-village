import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { query, transaction } from "./db";

/**
 * Per-visitor worlds.
 *
 * The demo is a persistent memory system on a public URL, which means the
 * second judge to arrive would otherwise inherit whatever the first one did to
 * the village -- rumours spread, beliefs flipped, time advanced. Every visitor
 * gets their own copy of the template world instead.
 *
 * Forking is cheap because identity is already world-scoped: every primary key
 * is (world_id, id), so a copy keeps each row's `id` and changes only the world
 * it belongs to. No identifier remapping, and every foreign key inside the copy
 * still resolves, by construction.
 */

/** Tables copied into a fork, in an order that satisfies foreign keys. */
const COPIED = [
  "actor",
  "event",
  "claim",
  "claim_relation",
  "memory",
  "relationship",
  "belief",
] as const;

/**
 * Tables deliberately left empty in a fresh fork. These record what happened
 * during a visit, and a new visitor has not done anything yet.
 */
const NOT_COPIED = [
  "rumor_transfer",
  "recall_event",
  "conversation",
  "action_log",
] as const;

export interface WorldSummary {
  id: string;
  label: string;
  simulatedAt: Date;
  forkedFrom: string | null;
  isTemplate: boolean;
  createdAt: Date;
}

async function columnsOf(client: PoolClient, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

export async function getTemplateWorldId(): Promise<string> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM world WHERE is_template = true ORDER BY created_at LIMIT 1",
  );
  if (rows.length === 0) {
    throw new Error("No template world has been seeded.");
  }
  return rows[0].id;
}

/**
 * Copy the template into a new world and return its id.
 *
 * Runs in one transaction: a half-copied village would be worse than no
 * village, because its beliefs would reference memories that do not exist.
 */
export async function forkWorld(
  templateWorldId: string,
  label = "visitor",
): Promise<string> {
  const newWorldId = randomUUID();

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO world (id, label, simulated_at, forked_from, is_template)
       SELECT $1, $2, simulated_at, id, false FROM world WHERE id = $3`,
      [newWorldId, label, templateWorldId],
    );

    for (const table of COPIED) {
      const columns = await columnsOf(client, table);
      const projection = columns
        .map((column) => (column === "world_id" ? "$1" : `"${column}"`))
        .join(", ");
      const names = columns.map((column) => `"${column}"`).join(", ");

      await client.query(
        `INSERT INTO "${table}" (${names})
         SELECT ${projection} FROM "${table}" WHERE world_id = $2`,
        [newWorldId, templateWorldId],
      );
    }
  });

  return newWorldId;
}

/**
 * Remove forked worlds older than the given age.
 *
 * Every visit leaves a copy of a village behind, so without this the cluster
 * accumulates one per judge, per refresh, forever. Templates are never touched.
 */
export async function pruneForks(olderThanHours = 6): Promise<number> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM world
       WHERE is_template = false
         AND created_at < now() - $1::INTERVAL`,
      [`${olderThanHours} hours`],
    );

    for (const { id } of rows) {
      // Children before parents: the schema enforces the ordering that the
      // copy relies on, so deletion has to walk it backwards.
      for (const table of [...NOT_COPIED, ...[...COPIED].reverse()]) {
        await client.query(`DELETE FROM "${table}" WHERE world_id = $1`, [id]);
      }
      await client.query("DELETE FROM world WHERE id = $1", [id]);
    }

    return rows.length;
  });
}

export async function listWorlds(): Promise<WorldSummary[]> {
  const rows = await query<{
    id: string;
    label: string;
    simulated_at: Date;
    forked_from: string | null;
    is_template: boolean;
    created_at: Date;
  }>(
    `SELECT id, label, simulated_at, forked_from, is_template, created_at
     FROM world ORDER BY is_template DESC, created_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    simulatedAt: row.simulated_at,
    forkedFrom: row.forked_from,
    isTemplate: row.is_template,
    createdAt: row.created_at,
  }));
}

export const FORK_TABLES = { COPIED, NOT_COPIED };
