CREATE DATABASE IF NOT EXISTS rumor_memory_village;

CREATE TABLE IF NOT EXISTS rumor_memory_village.public.walking_skeleton_probe (
  world_id UUID NOT NULL,
  probe_key STRING NOT NULL,
  message_ja STRING NOT NULL,
  message_en STRING NOT NULL,
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT walking_skeleton_probe_pk PRIMARY KEY (world_id, probe_key)
);

CREATE TABLE IF NOT EXISTS
  rumor_memory_village.public.mcp_walking_skeleton_probe_demo (
    world_id UUID NOT NULL,
    probe_key STRING NOT NULL,
    message_ja STRING NOT NULL,
    message_en STRING NOT NULL,
    pregenerated_line_ja STRING NOT NULL,
    pregenerated_model_id STRING NOT NULL,
    pregenerated_prompt_version STRING NOT NULL,
    grounding_sha256 STRING NOT NULL,
    pregenerated_at TIMESTAMPTZ NOT NULL,
    seeded_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT mcp_walking_skeleton_probe_demo_pk
      PRIMARY KEY (world_id, probe_key),
    CONSTRAINT mcp_walking_skeleton_probe_demo_world
      CHECK (
        world_id = '6de26358-78e4-4ac0-bb1a-9d81e3999c4f'::UUID
      ),
    CONSTRAINT mcp_walking_skeleton_probe_demo_hash
      CHECK (length(grounding_sha256) = 64)
  );

UPSERT INTO rumor_memory_village.public.walking_skeleton_probe (
  world_id,
  probe_key,
  message_ja,
  message_en
) VALUES (
  '6de26358-78e4-4ac0-bb1a-9d81e3999c4f'::UUID,
  'north-well-blue-water',
  '北の井戸の水は、夜だけ青く光るらしい。',
  'They say the water in the north well glows blue only at night.'
);

UPSERT INTO rumor_memory_village.public.mcp_walking_skeleton_probe_demo (
  world_id,
  probe_key,
  message_ja,
  message_en,
  pregenerated_line_ja,
  pregenerated_model_id,
  pregenerated_prompt_version,
  grounding_sha256,
  pregenerated_at,
  seeded_at
) VALUES (
  '6de26358-78e4-4ac0-bb1a-9d81e3999c4f'::UUID,
  'north-well-blue-water',
  '北の井戸の水は、夜だけ青く光るらしい。',
  'They say the water in the north well glows blue only at night.',
  '北の井戸の水、夜だけ青く光るって聞いたよ。',
  'amazon.nova-lite-v1:0',
  'initial-bedrock-connectivity-smoke-v1',
  '6f9c351be8d7b2a119954fc160b55bf2162841423be3da7efb7f590dfeb01bf2',
  '2026-07-30 06:00:34.059779+00'::TIMESTAMPTZ,
  '2026-07-30 05:42:57.447971+00'::TIMESTAMPTZ
);

CREATE ROLE IF NOT EXISTS rmv_mcp_read;
GRANT CONNECT ON DATABASE rumor_memory_village TO rmv_mcp_read;
GRANT USAGE ON SCHEMA rumor_memory_village.public TO rmv_mcp_read;
GRANT SELECT ON TABLE
  rumor_memory_village.public.mcp_walking_skeleton_probe_demo
  TO rmv_mcp_read;
