import { NextResponse } from "next/server";

import { DEMO_SCENARIO, runStep } from "@/lib/memory/scenario";
import {
  currentWorldId,
  executor,
  loadVillage,
  resetWorld,
} from "@/lib/server/village";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Play one step of the demo scenario in the visitor's own village.
 *
 * One step per request, driven by the client. Running the whole script
 * server-side took thirty-odd seconds, past what Amplify's SSR runtime holds a
 * response open for, and it hid the interesting part behind a spinner. Step by
 * step, the visitor watches a rumour travel and sees the one villager who
 * refuses it refuse it.
 */
export async function POST(request: Request) {
  try {
    const { index } = (await request.json()) as { index?: number };

    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= DEMO_SCENARIO.length
    ) {
      return NextResponse.json({ error: "index out of range" }, { status: 400 });
    }

    // Starting the script always starts from an untouched village. Replaying
    // over a world that has already run it advances the clock twice and spreads
    // every rumour twice, which leaves a village where nobody can remember
    // anything -- and a judge who clicks the button a second time would see
    // exactly that.
    const worldId =
      index === 0 ? await resetWorld() : (await currentWorldId()).worldId;

    const result = await runStep(executor, worldId, DEMO_SCENARIO[index]);
    const done = index === DEMO_SCENARIO.length - 1;

    return NextResponse.json({
      index,
      done,
      result,
      // The full picture is only worth re-fetching when something settled.
      state: result.snapshot || done ? await loadVillage(worldId) : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "step failed" },
      { status: 500 },
    );
  }
}

/** The script itself, so the interface can show it before it is run. */
export async function GET() {
  return NextResponse.json({ steps: DEMO_SCENARIO });
}
