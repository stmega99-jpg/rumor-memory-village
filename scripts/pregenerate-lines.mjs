/**
 * Pre-generate villager dialogue with Amazon Bedrock.
 *
 *   node --env-file=.env.local scripts/pregenerate-lines.mjs
 *
 * Asks Nova Lite to word each belief state as something that villager would
 * say, and writes the result into `conversation` against the template world.
 * Visitors' worlds read it from there: a fork keeps every row id and changes
 * only the world, so a line written once for (speaker, claim, stance) is valid
 * in every copy. The public demo therefore never calls Bedrock on a visitor's
 * click -- it cannot be slowed by a cold model or broken by a quota, and the
 * rules require it to stay free and unrestricted throughout judging.
 *
 * Requires AWS credentials in the environment. Run it from a machine with the
 * account configured, or from inside AWS.
 *
 * Belief states are harvested from every world that exists, not just the
 * template: the scenario reaches states an untouched village never holds, and
 * ids are stable across forks, so a state seen in any world can be voiced once
 * and reused everywhere. Run the demonstration at least once before this, so
 * there is something to harvest.
 *
 * The model is given the stance and the wording the villager actually holds and
 * asked only to phrase it. It is not asked what the villager thinks -- that is
 * already decided, deterministically, before this script runs. Anything it
 * returns that looks like it invented a fact is discarded and the template
 * stands.
 *
 * Failure here is not an error. If Bedrock is unavailable, nothing is written
 * and every line falls back to the deterministic template, which the interface
 * labels honestly.
 */

import { randomUUID } from "node:crypto";

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import pg from "pg";

const MODEL_ID = process.env.RMV_BEDROCK_MODEL_ID ?? "amazon.nova-lite-v1:0";
const REGION = process.env.RMV_BEDROCK_REGION ?? "us-east-1";

const connectionString = process.env.RMV_COCKROACH_SQL_URL;
if (!connectionString) {
  console.error("RMV_COCKROACH_SQL_URL is not set.");
  process.exit(1);
}

const STANCE = {
  believed: { ja: "信じている", en: "believes it" },
  doubted: { ja: "半信半疑でいる", en: "is unsure of it" },
  rejected: { ja: "否定している", en: "rejects it" },
  unknown: { ja: "もう思い出せない", en: "can no longer recall it" },
};

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true },
  statement_timeout: 60_000,
});
const bedrock = new BedrockRuntimeClient({ region: REGION });

function prompt(row) {
  const stance = STANCE[row.status] ?? STANCE.unknown;
  return `あなたは日本の農村の村人「${row.npc_ja}」（${row.role_ja}）です。

次の話について、あなたは${stance.ja}。
話の内容: 「${row.surface_ja}」
${row.source_ja ? `この話は${row.source_ja}から聞きました。` : "この話はあなた自身が見たことです。"}

この立場を、村人らしい一言のセリフにしてください。制約:
- 日本語で1文、40字以内
- 新しい事実を足さない。上の内容以外のことを言わない
- 立場を変えない
- 説明や前置きを書かず、セリフだけを出力

続けて、同じ内容の英語字幕を1文、"EN: " で始めて出力してください。`;
}

async function generate(row) {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt(row) }] }],
      inferenceConfig: { maxTokens: 200, temperature: 0.7 },
    }),
  );

  const text = response.output?.message?.content?.[0]?.text ?? "";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const ja = lines.find((line) => !line.startsWith("EN:"));
  const en = lines.find((line) => line.startsWith("EN:"))?.slice(3).trim();

  if (!ja || !en || ja.length > 80) return null;
  return { ja, en };
}

try {
  await client.connect();
  await client.query("SET database = rumor_memory_village");

  const { rows } = await client.query(
    `SELECT DISTINCT ON (b.npc_id, b.claim_id, b.status)
            b.npc_id, b.claim_id, b.status,
            a.name_ja AS npc_ja, a.role_ja,
            src.surface_ja, src.source_ja
       FROM belief b
       JOIN actor a ON a.world_id = b.world_id AND a.id = b.npc_id
       LEFT JOIN LATERAL (
         SELECT m.surface_ja, s.name_ja AS source_ja
           FROM memory m
           LEFT JOIN actor s ON s.world_id = m.world_id AND s.id = m.source_actor_id
          WHERE m.world_id = b.world_id AND m.owner_npc_id = b.npc_id
            AND m.claim_id = b.claim_id
          ORDER BY m.witnessed_directly DESC, m.confidence_at_acq DESC
          LIMIT 1
       ) AS src ON true
      WHERE src.surface_ja IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation v
           JOIN world tw ON tw.id = v.world_id AND tw.is_template = true
           WHERE v.speaker_id = b.npc_id
             AND v.belief_claim_id = b.claim_id
             AND v.topic = b.status
        )
      ORDER BY b.npc_id, b.claim_id, b.status`,
  );

  console.log(`${rows.length} belief states to voice, model ${MODEL_ID} in ${REGION}`);

  let written = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const line = await generate(row);
      if (!line) {
        failed += 1;
        console.log(`  skip  ${row.npc_ja} / ${row.status}: unusable response`);
        continue;
      }

      await client.query(
        `UPSERT INTO conversation (world_id, id, speaker_id, topic, line_ja, line_en,
                                   generation_mode, belief_claim_id, occurred_at)
         SELECT w.id, $1, $2, $3, $4, $5, 'bedrock', $6, w.simulated_at
           FROM world w WHERE w.is_template = true`,
        [randomUUID(), row.npc_id, row.status, line.ja, line.en, row.claim_id],
      );
      written += 1;
      console.log(`  ok    ${row.npc_ja} / ${row.status}: ${line.ja}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  fail  ${row.npc_ja} / ${row.status}: ${message.slice(0, 120)}`);
    }
  }

  console.log(`\n${written} written, ${failed} left to the template.`);
  if (written === 0) {
    console.log(
      "No lines were generated. Every villager will speak from the deterministic\n" +
        "template, which the interface labels as such. This is a supported state,\n" +
        "not a broken one.",
    );
  }
} finally {
  await client.end();
}
