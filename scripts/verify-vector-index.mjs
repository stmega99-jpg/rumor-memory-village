/**
 * Prove that recall actually uses the vector index at production data volume.
 *
 *   node --env-file=.env.local scripts/verify-vector-index.mjs
 *
 * This exists because the failure it guards against is silent. With few enough
 * rows behind the (world_id, owner_npc_id) prefix the optimizer will prefer a
 * full scan, the demo will look identical, and the Distributed Vector Indexing
 * requirement would be met on paper only. The check runs the exact shape of
 * query the application issues, against the same view the MCP role reads, and
 * fails if the plan is not a vector search over the expected index.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = "rumor_memory_village";
const INDEX = "memory_embedding_idx";
const LIMIT = 24;

const connectionString = process.env.RMV_COCKROACH_SQL_URL;
if (!connectionString) {
  console.error("RMV_COCKROACH_SQL_URL is not set.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 60_000,
});

let failures = 0;
function check(label, passed, detail = "") {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

try {
  await client.connect();
  await client.query(`SET database = ${DB}`);

  const { rows: worlds } = await client.query("SELECT id FROM world LIMIT 1");
  const worldId = worlds[0].id;

  const { rows: npcs } = await client.query(
    "SELECT id, name_ja FROM actor WHERE world_id = $1 AND kind = 'npc' ORDER BY name_en",
    [worldId],
  );

  const { rows: rowCounts } = await client.query(
    `SELECT owner_npc_id, count(*) AS n FROM memory
     WHERE world_id = $1 GROUP BY owner_npc_id ORDER BY n DESC`,
    [worldId],
  );
  console.log("memories per NPC:", rowCounts.map((r) => r.n).join(", "));

  // Use a stored claim vector as the probe so the literal matches production
  // shape exactly: the application inlines a vector because the Managed MCP
  // select_query tool takes a SQL string and no bind parameters.
  const { rows: probe } = await client.query(
    `SELECT canonical_ja, embedding::STRING AS v FROM claim
     WHERE world_id = $1 AND predicate = 'well_glows' LIMIT 1`,
    [worldId],
  );
  const topic = probe[0];
  const vector = `'${topic.v}'::VECTOR(384)`;

  const npc = npcs.find((n) => n.name_ja === "ゲン") ?? npcs[0];
  const recall = `
    SELECT memory_id, claim_id, surface_ja, embedding <=> ${vector} AS distance
    FROM mcp_memory_recall
    WHERE world_id = '${worldId}' AND owner_npc_id = '${npc.id}'
    ORDER BY embedding <=> ${vector}
    LIMIT ${LIMIT}
  `;

  console.log(`\nplan for ${npc.name_ja}'s recall (limit ${LIMIT}):`);
  const { rows: planRows } = await client.query(`EXPLAIN ${recall}`);
  const plan = planRows.map((r) => Object.values(r)[0]).join("\n");
  console.log(plan.split("\n").map((l) => "  | " + l).join("\n"));

  console.log("\nchecks:");
  check("plan performs a vector search", /vector\s*search/i.test(plan));
  check(`plan names ${INDEX}`, plan.includes(INDEX));
  // Both prefix columns must be pinned, otherwise the search would range over
  // every villager's memories and the per-NPC scoping would be a lie.
  const prefixSpan = /prefix spans:.*/.exec(plan)?.[0] ?? "";
  check("prefix span pins the world", prefixSpan.includes(worldId));
  check("prefix span pins the villager", prefixSpan.includes(npc.id));
  check("plan is not a full table scan", !/FULL SCAN/i.test(plan));
  check(
    "plan does not fall back to a sort over a prefix scan",
    !/memory_owner_claim_idx/.test(plan),
    "an ANALYZE is required after seeding",
  );

  const { rows: results } = await client.query(recall);
  check("recall returns rows", results.length > 0, `${results.length} rows`);

  console.log(`\ntopic: ${topic.canonical_ja}`);
  console.log(`nearest memories held by ${npc.name_ja}:`);
  for (const row of results.slice(0, 5)) {
    console.log(`  ${Number(row.distance).toFixed(4)}  ${row.surface_ja}`);
  }

  // The MCP-facing views must not expose ground truth.
  const { rows: leak } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('mcp_memory_recall', 'mcp_claim')
       AND column_name = 'truth_value'`,
  );
  console.log("");
  check("truth_value is absent from the MCP views", leak.length === 0);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await client.end();
}
