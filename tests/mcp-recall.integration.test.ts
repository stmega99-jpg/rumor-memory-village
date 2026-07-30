import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpUnavailableError, type McpCredentials } from "../lib/memory/mcp-client";
import { hydrateSurfaces, recall } from "../lib/memory/mcp-recall";
import { liveDatabaseUrl, loadLocalEnv } from "./live-env";

loadLocalEnv();

const sqlUrl = liveDatabaseUrl();
const apiKey = process.env.RMV_COCKROACH_MCP_API_KEY;
const clusterId = process.env.RMV_COCKROACH_CLUSTER_ID;

const configured = Boolean(sqlUrl && apiKey && clusterId);
const describeLive = configured ? describe : describe.skip;

describeLive("recall through the Managed MCP Server", () => {
  let client: pg.Client;
  let credentials: McpCredentials;
  let worldId: string;
  let npcId: string;
  let npcName: string;
  let embedding: number[];
  let simulatedAt: Date;
  let trust: Map<string, number>;

  beforeAll(async () => {
    credentials = { apiKey: apiKey!, clusterId: clusterId! };

    client = new pg.Client({
      connectionString: sqlUrl,
      ssl: { rejectUnauthorized: true },
      statement_timeout: 60_000,
    });
    await client.connect();
    await client.query("SET database = rumor_memory_village");

    const { rows: worlds } = await client.query(
      "SELECT id, simulated_at FROM world WHERE is_template = true LIMIT 1",
    );
    worldId = worlds[0].id;
    simulatedAt = new Date(worlds[0].simulated_at);

    const { rows: npcs } = await client.query(
      "SELECT id, name_ja FROM actor WHERE world_id = $1 AND name_ja = 'ゲン'",
      [worldId],
    );
    npcId = npcs[0].id;
    npcName = npcs[0].name_ja;

    // Ask about the well, using a vector the database already holds so the
    // probe is exactly the shape production sends.
    const { rows: probe } = await client.query(
      `SELECT embedding::STRING AS v FROM claim
       WHERE world_id = $1 AND predicate = 'well_glows' LIMIT 1`,
      [worldId],
    );
    embedding = JSON.parse(probe[0].v);

    const { rows: relationships } = await client.query(
      "SELECT target_id, trust FROM relationship WHERE world_id = $1 AND npc_id = $2",
      [worldId, npcId],
    );
    trust = new Map(relationships.map((r) => [r.target_id, Number(r.trust)]));
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  const trustOf = (actorId: string | null) =>
    actorId ? (trust.get(actorId) ?? 0.3) : 0.3;

  it("returns the villager's own memories, ranked", async () => {
    const result = await recall({
      worldId,
      npcId,
      embedding,
      simulatedAt,
      trustOf,
      credentials,
    });

    expect(result.candidateCount).toBeGreaterThan(0);
    expect(result.groups.length).toBeGreaterThan(0);

    const scores = result.groups.map((g) => g.representative.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    console.log(`  ${npcName} recalls, asked about the well:`);
    for (const group of result.groups.slice(0, 4)) {
      console.log(
        `    score ${group.representative.score.toFixed(3)}  sim ${group.representative.similarity.toFixed(3)}  ` +
          `corroborated by ${group.support.corroborationCount}, repeated ${group.support.repeatCount}`,
      );
    }
  }, 60_000);

  it("collapses duplicate memories of one proposition", async () => {
    const result = await recall({
      worldId,
      npcId,
      embedding,
      simulatedAt,
      trustOf,
      credentials,
    });

    const claimIds = result.groups.map((g) => g.claimId);
    expect(new Set(claimIds).size).toBe(claimIds.length);

    // Every candidate is accounted for: collapsing must lose nothing, only
    // group it. In the template world each villager holds a proposition once,
    // so this is an identity here; duplicates appear once rumours start
    // arriving twice, which the scenario test covers.
    const members = result.groups.reduce((n, g) => n + g.members.length, 0);
    expect(members).toBe(result.candidateCount);
  }, 60_000);

  it("sends a statement inside the MCP ceilings", async () => {
    const result = await recall({
      worldId,
      npcId,
      embedding,
      simulatedAt,
      trustOf,
      credentials,
    });

    expect(result.statement.length).toBeLessThan(16_384);
    expect(result.statement).toContain("memory@memory_embedding_idx");
  }, 60_000);

  it("fetches wording only for the memories about to be used", async () => {
    const result = await recall({
      worldId,
      npcId,
      embedding,
      simulatedAt,
      trustOf,
      credentials,
    });

    const ids = result.groups.slice(0, 3).map((g) => g.representative.memoryId);
    const surfaces = await hydrateSurfaces(worldId, ids, credentials);

    expect(surfaces.size).toBe(ids.length);
    for (const text of surfaces.values()) {
      expect(text.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("fails rather than quietly answering from somewhere else", async () => {
    // The whole point of routing recall through MCP is that it is the path.
    // A fallback to the direct SQL connection would make a broken dependency
    // invisible, so a bad credential must surface as a failure.
    await expect(
      recall({
        worldId,
        npcId,
        embedding,
        simulatedAt,
        trustOf,
        credentials: { ...credentials, apiKey: "CCDB1_not_a_real_key" },
      }),
    ).rejects.toBeInstanceOf(McpUnavailableError);
  }, 60_000);

  it("never returns another villager's memories", async () => {
    const result = await recall({
      worldId,
      npcId,
      embedding,
      simulatedAt,
      trustOf,
      credentials,
    });

    const ids = result.groups.flatMap((g) => g.members.map((m) => m.memoryId));
    const { rows } = await client.query(
      `SELECT count(*)::INT AS n FROM memory
       WHERE world_id = $1 AND id = ANY($2::UUID[]) AND owner_npc_id != $3`,
      [worldId, ids, npcId],
    );
    expect(Number(rows[0].n)).toBe(0);
  }, 60_000);
});
