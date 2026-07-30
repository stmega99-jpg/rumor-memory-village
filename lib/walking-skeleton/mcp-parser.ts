import {
  NOVA_LITE_MODEL_ID,
  PREGENERATED_GROUNDING_SHA256,
  PREGENERATED_PROMPT_VERSION,
  WALKING_SKELETON_PROBE_KEY,
  WALKING_SKELETON_WORLD_ID,
} from "./constants";
import type { ProbeRow } from "./types";

interface TextContent {
  type: "text";
  text: string;
}

interface SelectQueryPayload {
  rows?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContent(value: unknown): value is TextContent {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string"
  );
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Managed MCP row is missing ${field}.`);
  }
  return value;
}

export function parseSelectQueryResult(result: unknown): ProbeRow {
  if (!isRecord(result) || result.isError === true) {
    throw new Error("Managed MCP returned an error result.");
  }

  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error("Managed MCP returned no content.");
  }

  const text = content.find(isTextContent)?.text;
  if (!text) {
    throw new Error("Managed MCP returned no text payload.");
  }

  let payload: SelectQueryPayload;
  try {
    payload = JSON.parse(text) as SelectQueryPayload;
  } catch {
    throw new Error("Managed MCP returned invalid JSON.");
  }

  if (!Array.isArray(payload.rows) || payload.rows.length !== 1) {
    throw new Error("Managed MCP did not return exactly one probe row.");
  }

  const row = payload.rows[0];
  if (!isRecord(row)) {
    throw new Error("Managed MCP returned an invalid probe row.");
  }

  const parsed: ProbeRow = {
    worldId: requiredString(row, "world_id"),
    probeKey: requiredString(row, "probe_key"),
    messageJa: requiredString(row, "message_ja"),
    messageEn: requiredString(row, "message_en"),
    pregeneratedLineJa: requiredString(row, "pregenerated_line_ja"),
    pregeneratedModelId: requiredString(row, "pregenerated_model_id"),
    pregeneratedPromptVersion: requiredString(
      row,
      "pregenerated_prompt_version",
    ),
    groundingSha256: requiredString(row, "grounding_sha256"),
    pregeneratedAt: requiredString(row, "pregenerated_at"),
    seededAt: requiredString(row, "seeded_at"),
  };

  if (
    parsed.worldId !== WALKING_SKELETON_WORLD_ID ||
    parsed.probeKey !== WALKING_SKELETON_PROBE_KEY ||
    parsed.pregeneratedModelId !== NOVA_LITE_MODEL_ID ||
    parsed.pregeneratedPromptVersion !== PREGENERATED_PROMPT_VERSION ||
    parsed.groundingSha256 !== PREGENERATED_GROUNDING_SHA256
  ) {
    throw new Error("Managed MCP returned a row outside the fixed demo scope.");
  }

  return parsed;
}
