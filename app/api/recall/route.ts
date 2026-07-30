import { NextResponse } from "next/server";

import { hydrateSurfaces, recall } from "@/lib/memory/mcp-recall";
import { currentWorldId, executor, mcpCredentials } from "@/lib/server/village";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Ask a villager what comes to mind about a topic.
 *
 * The topic is named by an existing proposition rather than by free text,
 * because the query vector has to come from somewhere and this deployment has
 * no embedding model at runtime. The stored vector is only the question; the
 * search over the villager's own memories still runs through Managed MCP, and
 * the ranking still runs over what it returns.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      npcId?: string;
      topicClaimId?: string;
    };

    if (!body.npcId || !body.topicClaimId) {
      return NextResponse.json(
        { error: "npcId and topicClaimId are required" },
        { status: 400 },
      );
    }

    const { worldId } = await currentWorldId();

    const [world] = await executor<{ simulated_at: Date }>(
      "SELECT simulated_at FROM rumor_memory_village.public.world WHERE id = $1",
      [worldId],
    );

    const [topic] = await executor<{ v: string; canonical_ja: string; canonical_en: string }>(
      `SELECT embedding::STRING AS v, canonical_ja, canonical_en
       FROM rumor_memory_village.public.claim
       WHERE world_id = $1 AND id = $2`,
      [worldId, body.topicClaimId],
    );
    if (!topic) {
      return NextResponse.json({ error: "unknown topic" }, { status: 404 });
    }

    const relationships = await executor<{ target_id: string; trust: string }>(
      `SELECT target_id, trust FROM rumor_memory_village.public.relationship
       WHERE world_id = $1 AND npc_id = $2`,
      [worldId, body.npcId],
    );
    const trust = new Map(relationships.map((r) => [r.target_id, Number(r.trust)]));

    const result = await recall({
      worldId,
      npcId: body.npcId,
      embedding: JSON.parse(topic.v) as number[],
      simulatedAt: new Date(world.simulated_at),
      trustOf: (actorId) => (actorId ? (trust.get(actorId) ?? 0.3) : 0.3),
      credentials: await mcpCredentials(),
    });

    const top = result.groups.slice(0, 6);
    const surfaces = await hydrateSurfaces(
      worldId,
      top.map((group) => group.representative.memoryId),
      await mcpCredentials(),
    );

    const names = new Map(
      (
        await executor<{ id: string; name_ja: string }>(
          "SELECT id, name_ja FROM rumor_memory_village.public.actor WHERE world_id = $1",
          [worldId],
        )
      ).map((row) => [row.id, row.name_ja]),
    );

    return NextResponse.json({
      topicJa: topic.canonical_ja,
      topicEn: topic.canonical_en,
      candidateCount: result.candidateCount,
      // Shown in the interface: this is the query that ran, and naming the
      // index in it is what keeps the vector search honest.
      statementLength: result.statement.length,
      statementPreview: result.statement.slice(0, 220) + " ...",
      groups: top.map((group) => ({
        claimId: group.claimId,
        surfaceJa: surfaces.get(group.representative.memoryId) ?? "",
        score: group.representative.score,
        similarity: group.representative.similarity,
        trust: group.representative.trust,
        confidence: group.representative.confidence,
        recency: group.representative.recency,
        emotion: group.representative.emotion,
        corroborationCount: group.support.corroborationCount,
        repeatCount: group.support.repeatCount,
        sources: group.sourceRoots.map((root) => names.get(root) ?? "自分"),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "recall failed" },
      { status: 503 },
    );
  }
}
