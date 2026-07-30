import { NextResponse } from "next/server";

import { currentWorldId, loadVillage, resetWorld } from "@/lib/server/village";

export const dynamic = "force-dynamic";

/** The visitor's own village, forked on first contact. */
export async function GET() {
  try {
    const { worldId, fresh } = await currentWorldId();
    const state = await loadVillage(worldId);
    return NextResponse.json({ ...state, fresh });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unavailable" },
      { status: 503 },
    );
  }
}

/** Start over with an untouched copy of the village. */
export async function DELETE() {
  try {
    const worldId = await resetWorld();
    const state = await loadVillage(worldId);
    return NextResponse.json({ ...state, fresh: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unavailable" },
      { status: 503 },
    );
  }
}
