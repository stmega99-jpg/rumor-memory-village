export const WALKING_SKELETON_WORLD_ID =
  "6de26358-78e4-4ac0-bb1a-9d81e3999c4f";

export const WALKING_SKELETON_PROBE_KEY = "north-well-blue-water";

export const COCKROACH_CLUSTER_ID =
  "dcd3153f-e8af-4509-a796-b4f160170270";

export const COCKROACH_DATABASE = "rumor_memory_village";

export const COCKROACH_MCP_URL = "https://cockroachlabs.cloud/mcp";

export const NOVA_LITE_MODEL_ID = "amazon.nova-lite-v1:0";

export const NOVA_LITE_INFERENCE_PROFILE_ID =
  "us.amazon.nova-lite-v1:0";

export const PREGENERATED_PROMPT_VERSION =
  "initial-bedrock-connectivity-smoke-v1";

export const PREGENERATED_GROUNDING_SHA256 =
  "6f9c351be8d7b2a119954fc160b55bf2162841423be3da7efb7f590dfeb01bf2";

export const WALKING_SKELETON_QUERY = `
SELECT
  world_id::STRING AS world_id,
  probe_key,
  message_ja,
  message_en,
  pregenerated_line_ja,
  pregenerated_model_id,
  pregenerated_prompt_version,
  grounding_sha256,
  pregenerated_at::STRING AS pregenerated_at,
  seeded_at::STRING AS seeded_at
FROM public.mcp_walking_skeleton_probe_demo
WHERE world_id = '${WALKING_SKELETON_WORLD_ID}'::UUID
  AND probe_key = '${WALKING_SKELETON_PROBE_KEY}'
LIMIT 1
`.trim();
