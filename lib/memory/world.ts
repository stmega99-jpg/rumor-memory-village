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

import { randomUUID } from "node:crypto";

import type { Executor } from "./belief";

/** Tables copied into a fork, in an order that satisfies foreign keys. */
export const COPIED_TABLES = [
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
export const VISIT_TABLES = [
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
}

export async function getTemplateWorldId(exec: Executor): Promise<string> {
  const rows = await exec<{ id: string }>(
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
 * The caller is responsible for the transaction: a half-copied village is worse
 * than no village, because its beliefs reference memories that do not exist.
 */
export async function forkWorld(
  exec: Executor,
  templateWorldId: string,
  label = "visitor",
): Promise<string> {
  const newWorldId = randomUUID();

  await exec(
    `INSERT INTO world (id, label, simulated_at, forked_from, is_template)
     SELECT $1, $2, simulated_at, id, false FROM world WHERE id = $3`,
    [newWorldId, label, templateWorldId],
  );

  for (const table of COPIED_TABLES) {
    const columns = await exec<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );

    const names = columns.map((c) => `"${c.column_name}"`).join(", ");
    const projection = columns
      .map((c) => (c.column_name === "world_id" ? "$1" : `"${c.column_name}"`))
      .join(", ");

    await exec(
      `INSERT INTO "${table}" (${names})
       SELECT ${projection} FROM "${table}" WHERE world_id = $2`,
      [newWorldId, templateWorldId],
    );
  }

  return newWorldId;
}

/** Delete one world and everything in it. Templates are refused. */
export async function dropWorld(exec: Executor, worldId: string): Promise<void> {
  const rows = await exec<{ is_template: boolean }>(
    "SELECT is_template FROM world WHERE id = $1",
    [worldId],
  );
  if (rows.length === 0) return;
  if (rows[0].is_template) {
    throw new Error("Refusing to drop the template world.");
  }

  // Children before parents: the schema enforces the ordering the copy relies
  // on, so deletion has to walk it backwards.
  for (const table of [...VISIT_TABLES, ...[...COPIED_TABLES].reverse()]) {
    await exec(`DELETE FROM "${table}" WHERE world_id = $1`, [worldId]);
  }
  await exec("DELETE FROM world WHERE id = $1", [worldId]);
}

/**
 * Remove forked worlds older than the given age.
 *
 * Every visit leaves a copy of a village behind, so without this the cluster
 * accumulates one per judge, per refresh, forever.
 */
export async function pruneForks(
  exec: Executor,
  olderThanHours = 6,
): Promise<number> {
  const rows = await exec<{ id: string }>(
    `SELECT id FROM world
     WHERE is_template = false AND created_at < now() - $1::INTERVAL`,
    [`${olderThanHours} hours`],
  );

  for (const { id } of rows) {
    await dropWorld(exec, id);
  }
  return rows.length;
}

export async function listWorlds(exec: Executor): Promise<WorldSummary[]> {
  const rows = await exec<{
    id: string;
    label: string;
    simulated_at: Date;
    forked_from: string | null;
    is_template: boolean;
  }>(
    `SELECT id, label, simulated_at, forked_from, is_template
     FROM world ORDER BY is_template DESC, created_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    simulatedAt: new Date(row.simulated_at),
    forkedFrom: row.forked_from,
    isTemplate: row.is_template,
  }));
}
