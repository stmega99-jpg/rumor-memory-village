/**
 * The demo scenario.
 *
 * Written as data so it can be replayed identically, asserted against in tests,
 * and driven from a single button in the interface. Steps refer to villagers by
 * name and propositions by predicate rather than by identifier, so the script
 * stays readable and survives a reseed.
 *
 * The shape of the story matters more than its length. One event, told along
 * different paths, ends with the village holding three incompatible views of
 * it, and every one of them traceable to who said what to whom.
 */

import { evaluateBeliefs, type Executor } from "./belief";
import { tellAbout } from "./telling";

export type ScenarioStep =
  | { kind: "tell"; from: string; to: string; predicate: string; note: string }
  | { kind: "advance"; days: number; note: string }
  | { kind: "evaluate"; note: string };

export const DEMO_SCENARIO: ScenarioStep[] = [
  {
    kind: "evaluate",
    note: "Everyone starts from what they saw themselves.",
  },
  {
    kind: "tell",
    from: "Gen",
    to: "Miyo",
    predicate: "stole_from_warehouse",
    note: "Gen passes on what he thinks he saw. Miyo trusts him.",
  },
  {
    kind: "tell",
    from: "Gen",
    to: "Hana",
    predicate: "stole_from_warehouse",
    note: "The same accusation reaches someone who owes the traveller a debt.",
  },
  {
    kind: "tell",
    from: "Tatsu",
    to: "Hana",
    predicate: "repaired_warehouse",
    note: "Tatsu, who watched the whole thing, offers the other account.",
  },
  {
    kind: "tell",
    from: "Miyo",
    to: "Tatsu",
    predicate: "stole_from_warehouse",
    note: "The rumour reaches the one witness who knows better.",
  },
  {
    kind: "tell",
    from: "Tatsu",
    to: "Miyo",
    predicate: "repaired_warehouse",
    note: "And the correction travels back the other way.",
  },
  {
    kind: "evaluate",
    note: "Each villager re-weighs what they now hold.",
  },
  {
    kind: "advance",
    days: 45,
    note: "Time passes. Weak hearsay fades; debts and frights do not.",
  },
  {
    kind: "evaluate",
    note: "The village settles into its final disagreement.",
  },
];

export interface VerdictSnapshot {
  npc: string;
  claim: string;
  status: string;
  score: number;
  rationaleJa: string;
  rationaleEn: string;
}

export interface StepResult {
  step: ScenarioStep;
  detail: string;
  /**
   * What the village held at this moment. Captured at every evaluation rather
   * than only at the end: the demo's most telling beat is the one that does not
   * survive to the final frame -- Miyo believes the rumour when she first hears
   * it from someone she trusts, and has no view of it six weeks later.
   */
  snapshot?: VerdictSnapshot[];
}

const NARRATED_PREDICATES = ["stole_from_warehouse", "repaired_warehouse"];

async function snapshotVerdicts(
  exec: Executor,
  worldId: string,
): Promise<VerdictSnapshot[]> {
  const rows = await exec<{
    npc: string;
    claim: string;
    status: string;
    score: string;
    rationale_text_ja: string;
    rationale_text_en: string;
  }>(
    `SELECT a.name_ja AS npc, c.canonical_ja AS claim, b.status, b.score,
            b.rationale_text_ja, b.rationale_text_en
     FROM belief b
     JOIN actor a ON a.world_id = b.world_id AND a.id = b.npc_id
     JOIN claim c ON c.world_id = b.world_id AND c.id = b.claim_id
     WHERE b.world_id = $1 AND c.predicate = ANY($2)
     ORDER BY c.canonical_ja, b.score DESC`,
    [worldId, NARRATED_PREDICATES],
  );

  return rows.map((row) => ({
    npc: row.npc,
    claim: row.claim,
    status: row.status,
    score: Number(row.score),
    rationaleJa: row.rationale_text_ja,
    rationaleEn: row.rationale_text_en,
  }));
}

async function resolveActors(
  exec: Executor,
  worldId: string,
): Promise<{ byName: Map<string, string>; namesJa: Map<string, string>; namesEn: Map<string, string> }> {
  const rows = await exec<{ id: string; name_ja: string; name_en: string }>(
    "SELECT id, name_ja, name_en FROM actor WHERE world_id = $1",
    [worldId],
  );
  return {
    byName: new Map(rows.map((r) => [r.name_en, r.id])),
    namesJa: new Map(rows.map((r) => [r.id, r.name_ja])),
    namesEn: new Map(rows.map((r) => [r.id, r.name_en])),
  };
}

/**
 * Run the scenario against a world and return a narration of what happened.
 *
 * Every step reports what it actually did rather than what it intended to do:
 * a refused rumour is a result, not an error, and the demo is more convincing
 * when a villager visibly declines to believe someone.
 */
export async function runScenario(
  exec: Executor,
  worldId: string,
  steps: ScenarioStep[] = DEMO_SCENARIO,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    results.push(await runStep(exec, worldId, step));
  }
  return results;
}

/**
 * Run a single step.
 *
 * The interface drives the scenario one step per request rather than in one
 * call. Playing the whole thing server-side took thirty-odd seconds, which is
 * past what Amplify's SSR runtime will hold a response open for, and it left
 * the visitor watching a spinner through the part of the demo that is
 * supposed to be the interesting bit.
 */
export async function runStep(
  exec: Executor,
  worldId: string,
  step: ScenarioStep,
): Promise<StepResult> {
  const { byName, namesJa, namesEn } = await resolveActors(exec, worldId);

  const currentTime = async (): Promise<Date> => {
    const [row] = await exec<{ simulated_at: Date }>(
      "SELECT simulated_at FROM world WHERE id = $1",
      [worldId],
    );
    return new Date(row.simulated_at);
  };

  {
    const simulatedAt = await currentTime();

    if (step.kind === "advance") {
      await exec(
        `UPDATE world SET simulated_at = simulated_at + $2::INTERVAL WHERE id = $1`,
        [worldId, `${step.days} days`],
      );
      return { step, detail: `advanced ${step.days} days` };
    }

    if (step.kind === "evaluate") {
      let count = 0;
      for (const [, actorId] of byName) {
        const evaluated = await evaluateBeliefs(
          exec,
          worldId,
          actorId,
          simulatedAt,
          namesJa,
          namesEn,
        );
        count += evaluated.length;
      }
      return {
        step,
        detail: `${count} verdicts`,
        snapshot: await snapshotVerdicts(exec, worldId),
      };
    }

    const from = byName.get(step.from);
    const to = byName.get(step.to);
    if (!from || !to) {
      return { step, detail: "skipped: unknown villager" };
    }

    const [claim] = await exec<{ id: string }>(
      "SELECT id FROM claim WHERE world_id = $1 AND predicate = $2 LIMIT 1",
      [worldId, step.predicate],
    );
    if (!claim) {
      return { step, detail: "skipped: unknown claim" };
    }

    const told = await tellAbout(exec, {
      worldId,
      speakerId: from,
      listenerId: to,
      claimId: claim.id,
      simulatedAt,
    });

    if (!told) {
      return { step, detail: `${step.from} has nothing to say about this` };
    }

    if (told.outcome.outcome === "adopted") {
      return {
        step,
        detail: `${step.to} took it on at confidence ${told.outcome.confidence.toFixed(2)} (${told.outcome.distortionNote})`,
      };
    }

    return {
      step,
      detail: `${step.to} refused it (${told.outcome.reason}; trust ${told.outcome.actualTrust.toFixed(2)} < ${told.outcome.requiredTrust.toFixed(2)})`,
    };
  }
}
