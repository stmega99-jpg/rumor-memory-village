/**
 * Prove that a forked world is a real, independent village.
 *
 *   node --env-file=.env.local scripts/verify-fork.mjs
 *
 * The demo is a persistent memory system on a public URL. If forks share state,
 * the second judge inherits the first judge's vandalism; if forks are not
 * indexed the same way, recall silently degrades inside them and only the
 * template looks good. Both failures are invisible from the screen, so they are
 * checked here.
 */

import pg from "pg";

import { buildRecallQuery, MCP_SAFE_RECALL_LIMIT } from "../lib/memory/queries.ts";

const connectionString = process.env.RMV_COCKROACH_SQL_URL;
if (!connectionString) {
  console.error("RMV_COCKROACH_SQL_URL is not set.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 120_000,
});

let failures = 0;
function check(label, passed, detail = "") {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

const COPIED = ["actor", "event", "claim", "claim_relation", "memory", "relationship", "belief"];

async function counts(worldId) {
  const out = {};
  for (const table of COPIED) {
    const { rows } = await client.query(
      `SELECT count(*)::INT AS n FROM ${table} WHERE world_id = $1`,
      [worldId],
    );
    // CockroachDB INT is 64-bit, and node-pg hands 64-bit integers back as
    // strings to avoid silent precision loss. Compare numbers, not whatever
    // the driver felt like returning.
    out[table] = Number(rows[0].n);
  }
  return out;
}

try {
  await client.connect();
  await client.query("SET database = rumor_memory_village");

  const { rows: templates } = await client.query(
    "SELECT id FROM world WHERE is_template = true ORDER BY created_at LIMIT 1",
  );
  const templateId = templates[0].id;
  const before = await counts(templateId);
  console.log("template:", JSON.stringify(before));

  // --- fork -----------------------------------------------------------------
  const forkId = crypto.randomUUID();
  const started = Date.now();
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO world (id, label, simulated_at, forked_from, is_template)
     SELECT $1, 'verify-fork', simulated_at, id, false FROM world WHERE id = $2`,
    [forkId, templateId],
  );
  for (const table of COPIED) {
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    const names = cols.map((c) => `"${c.column_name}"`).join(", ");
    const projection = cols
      .map((c) => (c.column_name === "world_id" ? "$1" : `"${c.column_name}"`))
      .join(", ");
    await client.query(
      `INSERT INTO "${table}" (${names}) SELECT ${projection} FROM "${table}" WHERE world_id = $2`,
      [forkId, templateId],
    );
  }
  await client.query("COMMIT");
  const elapsed = Date.now() - started;

  const after = await counts(forkId);
  console.log(`fork:     ${JSON.stringify(after)}  (${elapsed} ms)`);

  console.log("\nchecks:");
  check(
    "fork carries the same rows as the template",
    JSON.stringify(before) === JSON.stringify(after),
  );
  check("forking is fast enough to do per visitor", elapsed < 10_000, `${elapsed} ms`);

  // --- independence ---------------------------------------------------------
  await client.query(
    `UPDATE memory SET confidence_at_acq = 0.01 WHERE world_id = $1`,
    [forkId],
  );
  const { rows: templateUntouched } = await client.query(
    `SELECT count(*)::INT AS n FROM memory WHERE world_id = $1 AND confidence_at_acq = 0.01`,
    [templateId],
  );
  check(
    "vandalising a fork leaves the template untouched",
    Number(templateUntouched[0].n) === 0,
    `${templateUntouched[0].n} template rows affected`,
  );

  // A fork keeps each row's id and changes only its world, so the same claim id
  // legitimately exists in several worlds. What must never happen is a memory
  // whose claim is missing from its *own* world.
  const { rows: orphans } = await client.query(
    `SELECT count(*)::INT AS n FROM memory m
     WHERE NOT EXISTS (
       SELECT 1 FROM claim c WHERE c.world_id = m.world_id AND c.id = m.claim_id
     )`,
  );
  check(
    "every memory's claim lives in its own world",
    Number(orphans[0].n) === 0,
    `${orphans[0].n} orphans`,
  );

  // --- recall inside the fork ----------------------------------------------
  const { rows: npc } = await client.query(
    "SELECT id, name_ja FROM actor WHERE world_id = $1 AND name_ja = 'ゲン'",
    [forkId],
  );
  const { rows: probe } = await client.query(
    `SELECT embedding::STRING AS v FROM claim
     WHERE world_id = $1 AND predicate = 'well_glows' LIMIT 1`,
    [forkId],
  );
  const recall = buildRecallQuery({
    worldId: forkId,
    ownerNpcId: npc[0].id,
    embedding: JSON.parse(probe[0].v),
    limit: MCP_SAFE_RECALL_LIMIT,
  });

  const { rows: planRows } = await client.query(`EXPLAIN ${recall}`);
  const plan = planRows.map((r) => Object.values(r)[0]).join("\n");
  const usesVectorIndex = /vector\s*search/i.test(plan);
  if (!usesVectorIndex) {
    console.log("\nplan inside the fork:");
    console.log(plan.split("\n").map((l) => "  | " + l).join("\n"));
    console.log("");
  }
  check("recall inside a fork still uses the vector index", usesVectorIndex);
  check("the fork's own world id scopes the search", plan.includes(forkId));

  const { rows: results } = await client.query(recall);
  check("recall inside a fork returns rows", results.length > 0, `${results.length} rows`);

  // --- prune ---------------------------------------------------------------
  await client.query("BEGIN");
  for (const table of [
    "rumor_transfer",
    "recall_event",
    "conversation",
    "action_log",
    ...COPIED.slice().reverse(),
  ]) {
    await client.query(`DELETE FROM "${table}" WHERE world_id = $1`, [forkId]);
  }
  await client.query("DELETE FROM world WHERE id = $1", [forkId]);
  await client.query("COMMIT");

  const remaining = await counts(forkId);
  check(
    "a pruned fork leaves nothing behind",
    Object.values(remaining).every((n) => Number(n) === 0),
    JSON.stringify(remaining),
  );

  const afterPrune = await counts(templateId);
  check(
    "pruning a fork does not touch the template",
    JSON.stringify(afterPrune) === JSON.stringify(before),
  );

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
