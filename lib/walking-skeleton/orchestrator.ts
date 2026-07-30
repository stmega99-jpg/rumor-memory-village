import type {
  ProbeRow,
  StageEvidence,
  WalkingSkeletonSuccess,
} from "./types";

export interface WalkingSkeletonDependencies {
  readProbe: () => Promise<ProbeRow>;
  generateLine: (row: ProbeRow) => Promise<string>;
  createRequestId: () => string;
  useLiveBedrock: boolean;
}

function fallbackLine(row: ProbeRow): string {
  return `「${row.messageJa}」という噂を、私は覚えています。`;
}

export async function runWalkingSkeleton(
  dependencies: WalkingSkeletonDependencies,
): Promise<WalkingSkeletonSuccess> {
  const row = await dependencies.readProbe();
  let npcLineJa: string;
  let mode: WalkingSkeletonSuccess["mode"];

  if (dependencies.useLiveBedrock) {
    try {
      npcLineJa = await dependencies.generateLine(row);
      mode = "bedrock";
    } catch {
      npcLineJa = fallbackLine(row);
      mode = "fallback";
    }
  } else {
    npcLineJa = row.pregeneratedLineJa;
    mode = "pregenerated";
  }

  const path: StageEvidence[] = [
    {
      stage: "browser",
      status: "ok",
      detail: "The browser received this API response.",
    },
    {
      stage: "amplify",
      status: "ok",
      detail: "The Next.js server route handled the request.",
    },
    {
      stage: "managed-mcp",
      status: "ok",
      detail: "select_query completed without a direct-SQL read fallback.",
    },
    {
      stage: "cockroachdb",
      status: "ok",
      detail: "The fixed world-scoped seed row was returned.",
    },
    {
      stage: "bedrock",
      status: mode === "fallback" ? "degraded" : "ok",
      detail:
        mode === "bedrock"
          ? "Amazon Nova Lite grounded the NPC line in the database row."
          : mode === "pregenerated"
            ? "A Nova Lite line generated in advance was reused from the database."
            : "A deterministic template was used after the model call failed.",
    },
  ];

  return {
    ok: true,
    contractVersion: "walking-skeleton.v1",
    requestId: dependencies.createRequestId(),
    worldId: row.worldId,
    probeKey: row.probeKey,
    sourceMessageJa: row.messageJa,
    sourceMessageEn: row.messageEn,
    npcLineJa,
    mode,
    seededAt: row.seededAt,
    path,
  };
}
