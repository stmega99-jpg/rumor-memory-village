/**
 * Print the current state of the village: who believes what, and why.
 *
 *   node --env-file=.env.local scripts/show-village.mjs
 *
 * A read-only view for development and for checking a demo run went the way it
 * was supposed to.
 */

import pg from "pg";

const groundTruth = new Map([
  ["helped_with_field", true],
  ["stole_from_warehouse", false],
  ["repaired_warehouse", true],
  ["well_running_dry", true],
  ["broke_bridge", false],
  ["fixed_bridge", true],
]);

const connectionString = process.env.RMV_COCKROACH_SQL_URL;
if (!connectionString) {
  console.error("RMV_COCKROACH_SQL_URL is not set.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 30_000,
});

try {
  await client.connect();
  await client.query("SET database = rumor_memory_village");

  const { rows: worlds } = await client.query(
    `SELECT id, label, simulated_at, is_template FROM world ORDER BY is_template DESC, created_at DESC`,
  );
  console.log("worlds:");
  for (const w of worlds) {
    console.log(`  ${w.is_template ? "template" : "fork    "}  ${w.label}  ${w.id}`);
  }

  const world = worlds.find((w) => w.is_template);

  const { rows: beliefs } = await client.query(
    `SELECT a.name_ja AS npc, c.canonical_ja AS claim, c.predicate,
            b.status, b.score, b.opposing_score, b.rationale_text_ja
     FROM belief b
     JOIN actor a ON a.world_id = b.world_id AND a.id = b.npc_id
     JOIN claim c ON c.world_id = b.world_id AND c.id = b.claim_id
     WHERE b.world_id = $1
     ORDER BY c.canonical_ja, b.score DESC`,
    [world.id],
  );

  console.log(`\nverdicts (${beliefs.length}):`);
  let current = "";
  for (const row of beliefs) {
    if (row.claim !== current) {
      current = row.claim;
      const answer = groundTruth.get(row.predicate) ?? null;
      const truth = answer === null ? "unknowable" : answer ? "true" : "FALSE";
      console.log(`\n  「${row.claim}」  [ground truth: ${truth}]`);
    }
    console.log(
      `    ${row.npc.padEnd(4)} ${row.status.padEnd(9)} ${Number(row.score).toFixed(3)} vs ${Number(row.opposing_score).toFixed(3)}`,
    );
    console.log(`         ${row.rationale_text_ja}`);
  }

  const { rows: transfers } = await client.query(
    `SELECT count(*)::INT AS n FROM rumor_transfer WHERE world_id = $1`,
    [world.id],
  );
  console.log(`\nrumour hops recorded: ${transfers[0].n}`);
} finally {
  await client.end();
}
