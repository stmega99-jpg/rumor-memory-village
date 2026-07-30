/**
 * Apply the memory core schema and load the generated seed.
 *
 *   node --env-file=.env.local scripts/db-setup.mjs [--schema-only|--seed-only]
 *
 * Statements are batched rather than sent one per round trip: the seed is a
 * little over a thousand inserts and a round trip each would take a minute of
 * pure latency. The seed file opens its own transaction, so a failure part way
 * through leaves nothing behind.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { statements } from "./sql-split.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "db", "schema.sql");
const SEED = join(ROOT, "db", "seed_generated.sql");
const BATCH = 40;

const connectionString = process.env.RMV_COCKROACH_SQL_URL;
if (!connectionString) {
  console.error(
    "RMV_COCKROACH_SQL_URL is not set. Populate .env.local and run with\n" +
      "  node --env-file=.env.local scripts/db-setup.mjs",
  );
  process.exit(1);
}

async function run(client, label, path) {
  const list = statements(readFileSync(path, "utf8"));
  console.log(`${label}: ${list.length} statements`);

  const started = Date.now();
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    try {
      await client.query(chunk.join(";\n") + ";");
    } catch (error) {
      console.error(`\n${label} failed near statement ${i + 1}:`);
      console.error(chunk[0].slice(0, 300));
      throw error;
    }
    process.stdout.write(
      `\r  ${Math.min(i + BATCH, list.length)}/${list.length}`,
    );
  }
  console.log(`\r  ${list.length}/${list.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const only = process.argv[2];
const client = new pg.Client({
  connectionString,
  // CockroachDB Cloud serves a publicly trusted certificate, so the system
  // trust store is enough and no root.crt download is required.
  ssl: { rejectUnauthorized: true },
  statement_timeout: 120_000,
});

try {
  await client.connect();
  const { rows } = await client.query("SELECT version() AS v, current_user AS u");
  console.log(`connected as ${rows[0].u}`);
  console.log(`${rows[0].v.split(" (")[0]}\n`);

  if (only !== "--seed-only") {
    await run(client, "schema", SCHEMA);
  }
  if (only !== "--schema-only") {
    await run(client, "seed", SEED);
  }

  // Without statistics the optimizer will not choose the vector index. It
  // picks a cheap prefix scan plus a sort instead, the demo looks identical,
  // and the vector index is quietly never used. Measured: the same query goes
  // from `scan memory@memory_owner_claim_idx` to `vector search
  // memory@memory_embedding_idx` on nothing but an ANALYZE.
  if (only !== "--schema-only") {
    console.log("\ncollecting statistics (required for vector index planning)");
    for (const table of ["memory", "claim", "actor", "relationship"]) {
      await client.query(`ANALYZE rumor_memory_village.public.${table}`);
    }
  }

  const summary = await client.query(`
    SELECT
      (SELECT count(*) FROM rumor_memory_village.public.claim)  AS claims,
      (SELECT count(*) FROM rumor_memory_village.public.memory) AS memories,
      (SELECT count(*) FROM rumor_memory_village.public.memory
         WHERE embedding IS NULL)                               AS missing_vectors,
      (SELECT count(*) FROM rumor_memory_village.public.actor)  AS actors
  `);
  console.log("\n" + JSON.stringify(summary.rows[0], null, 2));

  if (Number(summary.rows[0].missing_vectors) > 0) {
    console.error("\nSome memories have no embedding; the vector index would be incomplete.");
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
