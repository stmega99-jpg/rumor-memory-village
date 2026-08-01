/** Apply one checked-in CockroachDB migration, one statement at a time. */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { statements } from "./sql-split.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = normalize(join(root, "db", "migrations"));
const requested = process.argv[2];

if (!requested || isAbsolute(requested) || basename(requested) !== requested) {
  console.error("Pass the filename of one checked-in db/migrations/*.sql file.");
  process.exit(1);
}

const path = normalize(join(migrations, requested));
const relativePath = relative(migrations, path);
if (
  relativePath.startsWith("..") ||
  isAbsolute(relativePath) ||
  !path.endsWith(".sql")
) {
  console.error("Migration path is outside db/migrations.");
  process.exit(1);
}

const connectionString = process.env.RMV_COCKROACH_SQL_URL;
if (!connectionString) {
  console.error("RMV_COCKROACH_SQL_URL is not set.");
  process.exit(1);
}

const sql = readFileSync(path, "utf8");
const list = statements(sql);
const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 120_000,
});

try {
  await client.connect();
  for (let index = 0; index < list.length; index += 1) {
    await client.query(list[index]);
    console.log(`${index + 1}/${list.length} ${list[index].split(/\s+/).slice(0, 4).join(" ")}`);
  }
  console.log(`applied ${requested}`);
} finally {
  await client.end();
}
