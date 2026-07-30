export interface ProbeRow {
  worldId: string;
  probeKey: string;
  messageJa: string;
  messageEn: string;
  pregeneratedLineJa: string;
  pregeneratedModelId: string;
  pregeneratedPromptVersion: string;
  groundingSha256: string;
  pregeneratedAt: string;
  seededAt: string;
}

export type ReplyMode = "bedrock" | "pregenerated" | "fallback";

export type PathStage =
  | "browser"
  | "amplify"
  | "managed-mcp"
  | "cockroachdb"
  | "bedrock";

export interface StageEvidence {
  stage: PathStage;
  status: "ok" | "degraded";
  detail: string;
}

export interface WalkingSkeletonSuccess {
  ok: true;
  contractVersion: "walking-skeleton.v1";
  requestId: string;
  worldId: string;
  probeKey: string;
  sourceMessageJa: string;
  sourceMessageEn: string;
  npcLineJa: string;
  mode: ReplyMode;
  seededAt: string;
  path: StageEvidence[];
}

export interface WalkingSkeletonFailure {
  ok: false;
  contractVersion: "walking-skeleton.v1";
  requestId: string;
  stage: "configuration" | "managed-mcp" | "server";
  error: string;
}

export type WalkingSkeletonApiResponse =
  | WalkingSkeletonSuccess
  | WalkingSkeletonFailure;
