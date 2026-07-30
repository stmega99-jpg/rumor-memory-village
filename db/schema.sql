-- Rumor Memory Village — memory core schema
--
-- Design invariants (see DESIGN.md):
--   1. Every state table is world-scoped. world_id is part of the PRIMARY KEY
--      and of every FOREIGN KEY, so cross-world references are impossible at
--      the database level, not merely by application WHERE clauses.
--   2. `world.simulated_at` is the only game clock. Wall-clock now() is used
--      exclusively for audit columns that describe when a row was written.
--   3. Provenance is immutable. A memory's source is never rewritten or
--      nulled; subjective forgetting is a separate, reversible flag.
--   4. Claims are propositions; memories are one agent's instance of a claim;
--      beliefs are per (npc, claim). Distortion changes surface_text only.

CREATE DATABASE IF NOT EXISTS rumor_memory_village;

SET database = rumor_memory_village;

-- ---------------------------------------------------------------------------
-- World
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world (
  id            UUID NOT NULL PRIMARY KEY,
  label         STRING NOT NULL,
  -- The only game clock. Advanced exclusively by the "advance time" action.
  simulated_at  TIMESTAMPTZ NOT NULL,
  -- Worlds forked for a visitor session point back at the world they copied.
  forked_from   UUID NULL REFERENCES world (id),
  is_template   BOOL NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Actors (NPCs and the player share one identity space so that provenance,
-- trust and beliefs can reference either without a polymorphic column.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS actor (
  world_id      UUID NOT NULL,
  id            UUID NOT NULL,
  kind          STRING NOT NULL,
  name_ja       STRING NOT NULL,
  name_en       STRING NOT NULL,
  role_ja       STRING NOT NULL DEFAULT '',
  role_en       STRING NOT NULL DEFAULT '',
  -- Free-text disposition used only to colour generated dialogue. Never an
  -- input to belief arbitration, which stays deterministic.
  temperament   STRING NOT NULL DEFAULT '',
  CONSTRAINT actor_pk PRIMARY KEY (world_id, id),
  CONSTRAINT actor_kind_check CHECK (kind IN ('npc', 'player')),
  CONSTRAINT actor_world_fk FOREIGN KEY (world_id) REFERENCES world (id)
);

-- ---------------------------------------------------------------------------
-- Events: things that actually happened in the world.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event (
  world_id      UUID NOT NULL,
  id            UUID NOT NULL,
  kind          STRING NOT NULL,
  summary_ja    STRING NOT NULL,
  summary_en    STRING NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  CONSTRAINT event_pk PRIMARY KEY (world_id, id),
  CONSTRAINT event_world_fk FOREIGN KEY (world_id) REFERENCES world (id)
);

-- ---------------------------------------------------------------------------
-- Claims: normalised propositions. One row per distinct proposition, shared by
-- every agent that holds a memory of it. Distortion during rumour propagation
-- must never create a new claim, otherwise corroboration counting breaks.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS claim (
  world_id        UUID NOT NULL,
  id              UUID NOT NULL,
  event_id        UUID NULL,
  -- Subject of the proposition. Usually an actor ("Gen repaired the bridge"),
  -- but village rumour is just as often about a place or a thing ("the north
  -- well glows"), so an actor subject is optional and a label always present.
  subject_id      UUID NULL,
  subject_label   STRING NOT NULL,
  -- How the proposition reflects on its subject: -1 accusatory, +1 favourable.
  -- Prior bias is this multiplied by how the villager feels about the subject,
  -- which is what makes someone who owes a debt doubt a theft story about
  -- their creditor while accepting a kind one on the same evidence.
  subject_valence FLOAT NOT NULL DEFAULT 0.0,
  predicate       STRING NOT NULL,
  object_ref      STRING NULL,
  canonical_ja    STRING NOT NULL,
  canonical_en    STRING NOT NULL,
  -- Canonical embedding. Generated once per claim from canonical_ja.
  embedding       VECTOR(384) NULL,
  embedding_model STRING NULL,
  -- Ground truth, for demo scoring only. Hidden from the MCP read role so no
  -- agent can retrieve it.
  truth_value     BOOL NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_pk PRIMARY KEY (world_id, id),
  CONSTRAINT claim_world_fk FOREIGN KEY (world_id) REFERENCES world (id),
  CONSTRAINT claim_subject_fk
    FOREIGN KEY (world_id, subject_id) REFERENCES actor (world_id, id),
  CONSTRAINT claim_event_fk
    FOREIGN KEY (world_id, event_id) REFERENCES event (world_id, id)
);

-- Column additions, kept idempotent so this file can be re-applied over an
-- existing cluster. CREATE TABLE IF NOT EXISTS silently skips a table that
-- already exists, new column and all, so evolution has to be stated separately.
-- The database is not dropped and rebuilt because the deployed walking
-- skeleton lives alongside these tables.
ALTER TABLE claim ADD COLUMN IF NOT EXISTS subject_valence FLOAT NOT NULL DEFAULT 0.0;

-- Mutually exclusive / supporting relations between propositions.
CREATE TABLE IF NOT EXISTS claim_relation (
  world_id      UUID NOT NULL,
  id            UUID NOT NULL,
  claim_a       UUID NOT NULL,
  claim_b       UUID NOT NULL,
  relation      STRING NOT NULL,
  CONSTRAINT claim_relation_pk PRIMARY KEY (world_id, id),
  CONSTRAINT claim_relation_kind_check
    CHECK (relation IN ('mutually_exclusive', 'supports')),
  CONSTRAINT claim_relation_distinct CHECK (claim_a != claim_b),
  CONSTRAINT claim_relation_a_fk
    FOREIGN KEY (world_id, claim_a) REFERENCES claim (world_id, id),
  CONSTRAINT claim_relation_b_fk
    FOREIGN KEY (world_id, claim_b) REFERENCES claim (world_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_relation_pair_idx
  ON claim_relation (world_id, claim_a, claim_b, relation);

-- ---------------------------------------------------------------------------
-- Memories: one agent's held instance of a claim, with immutable provenance.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory (
  world_id            UUID NOT NULL,
  id                  UUID NOT NULL,
  owner_npc_id        UUID NOT NULL,
  claim_id            UUID NOT NULL,
  source_type         STRING NOT NULL,
  -- Immutable provenance. Never nulled, never rewritten.
  source_actor_id     UUID NULL,
  source_memory_id    UUID NULL,
  -- Subjective forgetting: the owner can no longer recall where this came
  -- from, but the audit trail above is intact. Expressed on the game clock.
  source_forgotten_at TIMESTAMPTZ NULL,
  witnessed_directly  BOOL NOT NULL DEFAULT false,
  -- Confidence at acquisition. Immutable; decay is computed at read time.
  confidence_at_acq   FLOAT NOT NULL,
  importance          FLOAT NOT NULL DEFAULT 0.0,
  emotional_weight    FLOAT NOT NULL DEFAULT 0.0,
  emotion_type        STRING NOT NULL DEFAULT 'neutral',
  -- Game-clock timestamps.
  acquired_at         TIMESTAMPTZ NOT NULL,
  last_recalled_at    TIMESTAMPTZ NULL,
  recall_count        INT NOT NULL DEFAULT 0,
  -- Surface form after distortion. claim_id is preserved regardless.
  surface_ja          STRING NOT NULL,
  -- Index-side copy of claim.embedding. Written by the seeding pipeline only;
  -- never accepted from a client.
  embedding           VECTOR(384) NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_pk PRIMARY KEY (world_id, id),
  CONSTRAINT memory_source_type_check
    CHECK (source_type IN ('witnessed', 'heard', 'told_by_player', 'inferred')),
  CONSTRAINT memory_confidence_range
    CHECK (confidence_at_acq > 0.0 AND confidence_at_acq <= 1.0),
  CONSTRAINT memory_importance_range
    CHECK (importance >= 0.0 AND importance <= 1.0),
  CONSTRAINT memory_emotion_range
    CHECK (emotional_weight >= -1.0 AND emotional_weight <= 1.0),
  -- A directly witnessed memory has no informant.
  CONSTRAINT memory_witness_has_no_source
    CHECK (NOT witnessed_directly OR source_actor_id IS NULL),
  CONSTRAINT memory_world_fk FOREIGN KEY (world_id) REFERENCES world (id),
  CONSTRAINT memory_owner_fk
    FOREIGN KEY (world_id, owner_npc_id) REFERENCES actor (world_id, id),
  CONSTRAINT memory_claim_fk
    FOREIGN KEY (world_id, claim_id) REFERENCES claim (world_id, id),
  CONSTRAINT memory_source_actor_fk
    FOREIGN KEY (world_id, source_actor_id) REFERENCES actor (world_id, id),
  CONSTRAINT memory_source_memory_fk
    FOREIGN KEY (world_id, source_memory_id) REFERENCES memory (world_id, id)
);

-- Recall is always "this world, this NPC, semantically near this topic", so
-- both scoping columns are index prefixes ahead of the vector.
CREATE VECTOR INDEX IF NOT EXISTS memory_embedding_idx
  ON memory (world_id, owner_npc_id, embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS memory_owner_claim_idx
  ON memory (world_id, owner_npc_id, claim_id);

-- ---------------------------------------------------------------------------
-- Beliefs: per (npc, claim). Contradictory memories are all retained; only the
-- belief row records which side the NPC currently takes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS belief (
  world_id          UUID NOT NULL,
  npc_id            UUID NOT NULL,
  claim_id          UUID NOT NULL,
  status            STRING NOT NULL,
  score             FLOAT NOT NULL,
  opposing_score    FLOAT NOT NULL DEFAULT 0.0,
  -- Machine-readable derivation: contributing memories, per-term values,
  -- engine version, and whether the text came from a model or a template.
  rationale_json    JSONB NOT NULL,
  rationale_text_ja STRING NOT NULL,
  rationale_text_en STRING NOT NULL,
  engine_version    STRING NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT belief_pk PRIMARY KEY (world_id, npc_id, claim_id),
  CONSTRAINT belief_status_check
    CHECK (status IN ('believed', 'doubted', 'rejected', 'unknown')),
  CONSTRAINT belief_npc_fk
    FOREIGN KEY (world_id, npc_id) REFERENCES actor (world_id, id),
  CONSTRAINT belief_claim_fk
    FOREIGN KEY (world_id, claim_id) REFERENCES claim (world_id, id)
);

-- ---------------------------------------------------------------------------
-- Relationships: directed, from an NPC toward any actor.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS relationship (
  world_id      UUID NOT NULL,
  npc_id        UUID NOT NULL,
  target_id     UUID NOT NULL,
  trust         FLOAT NOT NULL DEFAULT 0.5,
  affection     FLOAT NOT NULL DEFAULT 0.0,
  fear          FLOAT NOT NULL DEFAULT 0.0,
  updated_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT relationship_pk PRIMARY KEY (world_id, npc_id, target_id),
  CONSTRAINT relationship_trust_range CHECK (trust >= 0.0 AND trust <= 1.0),
  CONSTRAINT relationship_affection_range
    CHECK (affection >= -1.0 AND affection <= 1.0),
  CONSTRAINT relationship_fear_range CHECK (fear >= 0.0 AND fear <= 1.0),
  CONSTRAINT relationship_self CHECK (npc_id != target_id),
  CONSTRAINT relationship_npc_fk
    FOREIGN KEY (world_id, npc_id) REFERENCES actor (world_id, id),
  CONSTRAINT relationship_target_fk
    FOREIGN KEY (world_id, target_id) REFERENCES actor (world_id, id)
);

-- ---------------------------------------------------------------------------
-- Rumour transfers: the propagation graph, one row per hop.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rumor_transfer (
  world_id           UUID NOT NULL,
  id                 UUID NOT NULL,
  claim_id           UUID NOT NULL,
  from_actor_id      UUID NOT NULL,
  to_actor_id        UUID NOT NULL,
  source_memory_id   UUID NULL,
  created_memory_id  UUID NULL,
  confidence_before  FLOAT NOT NULL,
  confidence_after   FLOAT NOT NULL,
  -- 'adopted' when the listener kept it, 'rejected' when trust was too low.
  outcome            STRING NOT NULL,
  distortion_note    STRING NOT NULL DEFAULT '',
  occurred_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT rumor_transfer_pk PRIMARY KEY (world_id, id),
  CONSTRAINT rumor_transfer_outcome_check
    CHECK (outcome IN ('adopted', 'rejected')),
  CONSTRAINT rumor_transfer_direction CHECK (from_actor_id != to_actor_id),
  CONSTRAINT rumor_transfer_claim_fk
    FOREIGN KEY (world_id, claim_id) REFERENCES claim (world_id, id),
  CONSTRAINT rumor_transfer_from_fk
    FOREIGN KEY (world_id, from_actor_id) REFERENCES actor (world_id, id),
  CONSTRAINT rumor_transfer_to_fk
    FOREIGN KEY (world_id, to_actor_id) REFERENCES actor (world_id, id)
);

CREATE INDEX IF NOT EXISTS rumor_transfer_claim_idx
  ON rumor_transfer (world_id, claim_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Recall events: recorded only when a memory was actually used as grounds for
-- an utterance. Browsing the visualisation must never rejuvenate a memory.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recall_event (
  world_id       UUID NOT NULL,
  id             UUID NOT NULL,
  memory_id      UUID NOT NULL,
  npc_id         UUID NOT NULL,
  -- Idempotency key: one utterance may cite a memory once. Re-running the same
  -- utterance must not inflate recall_count.
  utterance_key  STRING NOT NULL,
  recalled_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT recall_event_pk PRIMARY KEY (world_id, id),
  CONSTRAINT recall_event_memory_fk
    FOREIGN KEY (world_id, memory_id) REFERENCES memory (world_id, id),
  CONSTRAINT recall_event_npc_fk
    FOREIGN KEY (world_id, npc_id) REFERENCES actor (world_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS recall_event_idempotency_idx
  ON recall_event (world_id, memory_id, utterance_key);

-- ---------------------------------------------------------------------------
-- Conversations and the player-facing action log.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation (
  world_id       UUID NOT NULL,
  id             UUID NOT NULL,
  speaker_id     UUID NOT NULL,
  listener_id    UUID NULL,
  topic          STRING NOT NULL,
  line_ja        STRING NOT NULL,
  line_en        STRING NOT NULL,
  -- 'pregenerated' | 'bedrock' | 'template'
  generation_mode STRING NOT NULL,
  belief_claim_id UUID NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  CONSTRAINT conversation_pk PRIMARY KEY (world_id, id),
  CONSTRAINT conversation_mode_check
    CHECK (generation_mode IN ('pregenerated', 'bedrock', 'template')),
  CONSTRAINT conversation_speaker_fk
    FOREIGN KEY (world_id, speaker_id) REFERENCES actor (world_id, id)
);

CREATE TABLE IF NOT EXISTS action_log (
  world_id      UUID NOT NULL,
  id            UUID NOT NULL,
  action        STRING NOT NULL,
  detail_json   JSONB NOT NULL,
  simulated_at  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_log_pk PRIMARY KEY (world_id, id),
  CONSTRAINT action_log_world_fk FOREIGN KEY (world_id) REFERENCES world (id)
);

-- ---------------------------------------------------------------------------
-- MCP read surface.
--
-- Ground truth lives in exactly one column, `claim.truth_value`, so exactly one
-- table needs hiding behind a projection. `memory` holds nothing an agent
-- should not see -- provenance, confidence and wording are all things the
-- villager themselves knows -- and is granted directly.
--
-- That directness is load-bearing rather than a simplification. Recall must
-- name its index explicitly, because a freshly forked world appears in no
-- statistics and the planner would otherwise estimate a single matching row
-- and choose a primary-key scan over the vector index. Index hints cannot be
-- written through a view, so a view over `memory` would have quietly cost the
-- vector index in every visitor's world.
-- ---------------------------------------------------------------------------

CREATE VIEW IF NOT EXISTS mcp_claim AS
  SELECT
    world_id,
    id AS claim_id,
    event_id,
    subject_id,
    predicate,
    object_ref,
    canonical_ja,
    canonical_en
  FROM claim;

DROP VIEW IF EXISTS mcp_memory_recall;

CREATE ROLE IF NOT EXISTS rmv_mcp_read;
GRANT CONNECT ON DATABASE rumor_memory_village TO rmv_mcp_read;
GRANT USAGE ON SCHEMA public TO rmv_mcp_read;
GRANT SELECT ON TABLE memory TO rmv_mcp_read;
GRANT SELECT ON TABLE mcp_claim TO rmv_mcp_read;
GRANT SELECT ON TABLE actor TO rmv_mcp_read;
GRANT SELECT ON TABLE relationship TO rmv_mcp_read;
-- Deliberately NOT granted: the `claim` base table, which is the only place
-- ground truth exists. Also withheld: belief, event, world, rumor_transfer,
-- recall_event, action_log -- none of which a villager recalls from.
