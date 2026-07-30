import { handleWalkingSkeletonRequest } from "@/lib/walking-skeleton/http";
import { runProductionWalkingSkeleton } from "@/lib/walking-skeleton/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleWalkingSkeletonRequest(runProductionWalkingSkeleton);
}
