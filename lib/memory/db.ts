import "server-only";

import { Pool, type PoolClient } from "pg";

import { getRuntimeSecrets } from "../walking-skeleton/config";

/**
 * Direct SQL connection, used only for writes.
 *
 * Reads that a villager performs go through the Managed MCP Server; that is the
 * agent's own recall path and it stays that way even when MCP is unavailable,
 * because silently falling back here would turn a broken dependency into an
 * invisible one. This pool exists for the things MCP cannot do: transactional
 * updates, belief re-evaluation, and forking a world for a visitor.
 */

export const DATABASE = "rumor_memory_village";

let pool: Pool | undefined;

export class SqlUnavailableError extends Error {
  constructor() {
    super("The direct SQL connection is unavailable.");
    this.name = "SqlUnavailableError";
  }
}

/**
 * Point a connection string at the village database.
 *
 * The Cloud console hands out a string ending in /defaultdb, and asking every
 * operator to hand-edit it before use invites exactly the mistake that only
 * shows up in production. Rewriting the path here is cheaper than qualifying
 * every table name in every query, and cheaper than a post-connect SET, which
 * races the first real query on the same client.
 */
function pointAtDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `/${DATABASE}`;
    return parsed.toString();
  } catch {
    throw new SqlUnavailableError();
  }
}

async function connectionString(): Promise<string> {
  const fromEnv = process.env.RMV_COCKROACH_SQL_URL;
  if (fromEnv && process.env.RMV_ALLOW_ENV_SECRETS === "true") {
    return pointAtDatabase(fromEnv);
  }

  const secrets = await getRuntimeSecrets();
  return pointAtDatabase(secrets.cockroachSqlUrl);
}

export async function getPool(): Promise<Pool> {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: await connectionString(),
    // CockroachDB Cloud presents a publicly trusted certificate, so the system
    // trust store suffices and no root.crt needs shipping.
    ssl: { rejectUnauthorized: true },
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    application_name: "rumor-memory-village",
  });

  pool.on("error", () => {
    // A dead idle client must not take the process with it.
  });

  return pool;
}

/** Run a unit of work in a transaction, rolling back on any failure. */
export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await (await getPool()).connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await (await getPool()).query(text, values);
  return result.rows as T[];
}
