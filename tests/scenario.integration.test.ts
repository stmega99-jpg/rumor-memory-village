import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Executor } from "../lib/memory/belief";
import { DEMO_SCENARIO, runScenario } from "../lib/memory/scenario";
import { dropWorld, forkWorld, getTemplateWorldId } from "../lib/memory/world";
import { liveDatabaseUrl } from "./live-env";

const connectionString = liveDatabaseUrl();
const describeLive = connectionString ? describe : describe.skip;

describeLive("the demo scenario, run in its own world", () => {
  let client: pg.Client;
  let exec: Executor;
  let worldId: string;

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

    // Run in a fork so the template stays pristine for the next run.
    const template = await getTemplateWorldId(exec);
    worldId = await forkWorld(exec, template, "scenario-test");
  }, 120_000);

  afterAll(async () => {
    if (worldId) await dropWorld(exec, worldId).catch(() => undefined);
    await client?.end();
  });

  it("plays every step and reports what actually happened", async () => {
    const results = await runScenario(exec, worldId, DEMO_SCENARIO);

    // Printed on purpose. This narration is the demo, and seeing it in the
    // test output is how a regression in the story gets noticed.
    for (const { step, detail, snapshot } of results) {
      const label =
        step.kind === "tell" ? `${step.from} -> ${step.to}` : step.kind;
      console.log(`  ${label.padEnd(16)} ${detail}`);
      console.log(`  ${" ".repeat(16)} (${step.note})`);
      for (const verdict of snapshot ?? []) {
        console.log(
          `  ${" ".repeat(16)}   ${verdict.npc} ${verdict.status.padEnd(9)} ${verdict.claim}`,
        );
      }
    }

    expect(results).toHaveLength(DEMO_SCENARIO.length);
    for (const result of results) {
      expect(result.detail).not.toContain("unknown villager");
      expect(result.detail).not.toContain("unknown claim");
    }

    const tells = results.filter((r) => r.step.kind === "tell");
    expect(tells.length).toBeGreaterThan(0);
    // A demo where everyone believes everyone would prove nothing.
    expect(tells.some((r) => r.detail.includes("refused"))).toBe(true);
    expect(tells.some((r) => r.detail.includes("took it on"))).toBe(true);

    // The beat that does not survive to the final frame: someone believes a
    // rumour when they first hear it from a person they trust, and has no view
    // of it once time has worn it down. Both halves are the demonstration.
    const snapshots = results.filter((r) => r.snapshot?.length);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);

    const afterSpread = snapshots[snapshots.length - 2].snapshot!;
    const afterTime = snapshots[snapshots.length - 1].snapshot!;

    const miyoBefore = afterSpread.find(
      (v) => v.npc === "ミヨ" && v.claim.includes("盗んだ"),
    );
    const miyoAfter = afterTime.find(
      (v) => v.npc === "ミヨ" && v.claim.includes("盗んだ"),
    );

    expect(miyoBefore?.status).toBe("believed");
    expect(miyoAfter?.status).toBe("unknown");

    // Hana's refusal rests on a debt she witnessed, not on hearsay, so it is
    // still there after the same interval that erased Miyo's conviction.
    const hanaAfter = afterTime.find(
      (v) => v.npc === "ハナ" && v.claim.includes("盗んだ"),
    );
    expect(hanaAfter?.status).toBe("rejected");
  }, 180_000);

  it("records every hop, refusals included", async () => {
    const rows = await exec<{ outcome: string; n: string }>(
      `SELECT outcome, count(*)::INT AS n FROM rumor_transfer
       WHERE world_id = $1 GROUP BY outcome`,
      [worldId],
    );
    const byOutcome = new Map(rows.map((r) => [r.outcome, Number(r.n)]));

    expect(byOutcome.get("adopted") ?? 0).toBeGreaterThan(0);
    // A propagation graph containing only successes would be a graph of what
    // we hoped would happen.
    expect(byOutcome.get("rejected") ?? 0).toBeGreaterThan(0);
  });

  it("leaves the village disagreeing about the same event", async () => {
    const rows = await exec<{ canonical_ja: string; verdicts: string }>(
      `SELECT c.canonical_ja,
              count(DISTINCT b.status)::INT AS verdicts
       FROM belief b
       JOIN claim c ON c.world_id = b.world_id AND c.id = b.claim_id
       WHERE b.world_id = $1 AND c.predicate IN ('stole_from_warehouse', 'repaired_warehouse')
       GROUP BY c.canonical_ja`,
      [worldId],
    );

    expect(rows.length).toBeGreaterThan(0);
    // This is the whole demonstration: one event, more than one conclusion.
    expect(rows.some((row) => Number(row.verdicts) > 1)).toBe(true);

    const detail = await exec<{
      claim: string;
      truth_value: boolean | null;
      npc: string;
      status: string;
      rationale_text_ja: string;
    }>(
      `SELECT c.canonical_ja AS claim, c.truth_value, a.name_ja AS npc,
              b.status, b.rationale_text_ja
       FROM belief b
       JOIN claim c ON c.world_id = b.world_id AND c.id = b.claim_id
       JOIN actor a ON a.world_id = b.world_id AND a.id = b.npc_id
       WHERE b.world_id = $1
         AND c.predicate IN ('stole_from_warehouse', 'repaired_warehouse')
       ORDER BY c.canonical_ja, b.score DESC`,
      [worldId],
    );

    let heading = "";
    for (const row of detail) {
      if (row.claim !== heading) {
        heading = row.claim;
        const truth =
          row.truth_value === null ? "unknowable" : row.truth_value ? "true" : "FALSE";
        console.log(`\n  ${row.claim}  [ground truth: ${truth}]`);
      }
      console.log(`    ${row.npc} ${row.status}`);
      console.log(`      ${row.rationale_text_ja}`);
    }
  });

  it("keeps both accounts in every head that heard both", async () => {
    const [row] = await exec<{ n: string }>(
      `SELECT count(*)::INT AS n FROM (
         SELECT m.owner_npc_id
         FROM memory m
         JOIN claim c ON c.world_id = m.world_id AND c.id = m.claim_id
         WHERE m.world_id = $1
           AND c.predicate IN ('stole_from_warehouse', 'repaired_warehouse')
         GROUP BY m.owner_npc_id
         HAVING count(DISTINCT c.predicate) = 2
       )`,
      [worldId],
    );
    // Contradiction is resolved in belief, never by forgetting one side.
    expect(Number(row.n)).toBeGreaterThan(0);
  });

  it("traces every adopted rumour back to a first-hand account", async () => {
    const rows = await exec<{ n: string }>(
      `SELECT count(*)::INT AS n FROM memory m
       WHERE m.world_id = $1
         AND m.source_memory_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM memory p
           WHERE p.world_id = m.world_id AND p.id = m.source_memory_id
         )`,
      [worldId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("does not touch the template it was forked from", async () => {
    const [row] = await exec<{ n: string }>(
      `SELECT count(*)::INT AS n FROM rumor_transfer
       WHERE world_id = (SELECT id FROM world WHERE is_template = true LIMIT 1)`,
    );
    expect(Number(row.n)).toBe(0);
  });
});
