import "server-only";

import { generateNpcLine } from "./bedrock";
import { readWalkingSkeletonProbe } from "./mcp";
import { runWalkingSkeleton } from "./orchestrator";

export function runProductionWalkingSkeleton() {
  return runWalkingSkeleton({
    readProbe: readWalkingSkeletonProbe,
    generateLine: generateNpcLine,
    createRequestId: () => crypto.randomUUID(),
    useLiveBedrock: process.env.RMV_LIVE_BEDROCK_PROBE === "true",
  });
}
