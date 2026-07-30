import "server-only";

import { NextResponse } from "next/server";
import { RuntimeConfigurationError } from "./config";
import { McpReadError } from "./mcp";
import type {
  WalkingSkeletonFailure,
  WalkingSkeletonSuccess,
} from "./types";

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
};

export async function handleWalkingSkeletonRequest(
  run: () => Promise<WalkingSkeletonSuccess>,
) {
  const requestId = crypto.randomUUID();

  try {
    const result = await run();
    return NextResponse.json(result, { headers: responseHeaders });
  } catch (error) {
    const stage: WalkingSkeletonFailure["stage"] =
      error instanceof RuntimeConfigurationError
        ? "configuration"
        : error instanceof McpReadError
          ? "managed-mcp"
          : "server";

    // Log only the safe error class and request id. SDK error objects can
    // contain request metadata, so they are deliberately not serialized.
    console.error(
      `[walking-skeleton] request=${requestId} stage=${stage} error=${
        error instanceof Error ? error.name : "UnknownError"
      }`,
    );

    const body: WalkingSkeletonFailure = {
      ok: false,
      contractVersion: "walking-skeleton.v1",
      requestId,
      stage,
      error:
        stage === "managed-mcp"
          ? "The memory read path is temporarily unavailable."
          : stage === "configuration"
            ? "The server is not configured yet."
            : "The server could not complete the request.",
    };

    return NextResponse.json(body, {
      status: 503,
      headers: responseHeaders,
    });
  }
}
