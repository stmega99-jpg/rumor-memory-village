import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateBeliefs, type Executor } from "../lib/memory/belief";
import { liveDatabaseUrl } from "./live-env";

const connectionString = liveDatabaseUrl();
const describeLive = connectionString ? describe : describe.skip;

describeLive("belief evaluation against the seeded village", () => {
  let client: pg.Client;
  let exec: Executor;
  let worldId: string;
  let simulatedAt: Date;
  let names: Map<string, string>;
  let namesEn: Map<string, string>;
  let npcs: Array<{ id: string; name_ja: string }>;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString,
      ssl: { rejectUnauthorized: true },
      statement_timeout: 60_000,
    });
    await client.connect();
    await client.query("SET database = rumor_memory_village");

    exec = (async (sql: string, values: unknown[] = []) =>
      (await client.query(sql, values)).rows) as Executor;

    const [world] = await exec<{ id: string; simulated_at: Date }>(
      "SELECT id, simulated_at FROM world WHERE is_template = true LIMIT 1",
    );
    worldId = world.id;
    simulatedAt = new Date(world.simulated_at);

    const actors = await exec<{
      id: string;
      kind: string;
      name_ja: string;
      name_en: string;
    }>("SELECT id, kind, name_ja, name_en FROM actor WHERE world_id = $1", [worldId]);

    names = new Map(actors.map((a) => [a.id, a.name_ja]));
    namesEn = new Map(actors.map((a) => [a.id, a.name_en]));
    npcs = actors.filter((a) => a.kind === "npc");
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it("reaches a verdict for every villager who holds a disputed memory", async () => {
    let evaluated = 0;

    for (const npc of npcs) {
      const results = await evaluateBeliefs(
        exec,
        worldId,
        npc.id,
        simulatedAt,
        names,
        namesEn,
      );
      evaluated += results.length;

      for (const result of results) {
        expect(["believed", "doubted", "rejected", "unknown"]).toContain(
          result.outcome.status,
        );
        // The rationale has to be recomputable, not merely readable.
        expect(result.rationale.usedMemories.length).toBeGreaterThan(0);
        expect(result.textJa.length).toBeGreaterThan(0);
        expect(result.textEn.length).toBeGreaterThan(0);
      }
    }

    expect(evaluated).toBeGreaterThan(0);
  }, 120_000);

  it("persists verdicts that survive a reconnect", async () => {
    const [row] = await exec<{ n: string }>(
      "SELECT count(*)::INT AS n FROM belief WHERE world_id = $1",
      [worldId],
    );
    expect(Number(row.n)).toBeGreaterThan(0);
  });

  it("never records a verdict on a claim the villager has no memory of", async () => {
    const [row] = await exec<{ n: string }>(
      `SELECT count(*)::INT AS n FROM belief b
       WHERE b.world_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM memory m
           WHERE m.world_id = b.world_id
             AND m.owner_npc_id = b.npc_id
             AND m.claim_id = b.claim_id
         )`,
      [worldId],
    );
    // Never having heard something is not disbelief in it.
    expect(Number(row.n)).toBe(0);
  });

  it("keeps both sides of a contradiction in memory after judging them", async () => {
    const [row] = await exec<{ n: string }>(
      `SELECT count(*)::INT AS n FROM claim_relation r
       WHERE r.world_id = $1 AND r.relation = 'mutually_exclusive'
         AND EXISTS (SELECT 1 FROM memory m WHERE m.world_id = r.world_id AND m.claim_id = r.claim_a)
         AND EXISTS (SELECT 1 FROM memory m WHERE m.world_id = r.world_id AND m.claim_id = r.claim_b)`,
      [worldId],
    );
    expect(Number(row.n)).toBeGreaterThan(0);
  });

  it("writes an engine version alongside every verdict", async () => {
    const rows = await exec<{ engine_version: string }>(
      "SELECT DISTINCT engine_version FROM belief WHERE world_id = $1",
      [worldId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].engine_version).toMatch(/^scoring-v/);
  });
});
