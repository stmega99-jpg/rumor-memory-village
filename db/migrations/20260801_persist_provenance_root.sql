-- Persist the oldest stored memory in every provenance chain.
--
-- Safe to re-run. Rows that already carry a root are deliberately untouched:
-- provenance is immutable after the first successful backfill or insert.

SET database = rumor_memory_village;

ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS provenance_root_memory_id UUID NULL;

WITH RECURSIVE provenance_lineage AS (
  SELECT
    world_id,
    id AS leaf_id,
    id AS ancestor_id,
    source_memory_id AS parent_id,
    0 AS depth
  FROM memory
  WHERE provenance_root_memory_id IS NULL

  UNION ALL

  SELECT
    lineage.world_id,
    lineage.leaf_id,
    parent.id AS ancestor_id,
    parent.source_memory_id AS parent_id,
    lineage.depth + 1
  FROM provenance_lineage AS lineage
  JOIN memory AS parent
    ON parent.world_id = lineage.world_id
   AND parent.id = lineage.parent_id
  WHERE lineage.parent_id IS NOT NULL
    AND lineage.depth < 1024
), deepest_ancestor AS (
  SELECT world_id, leaf_id, ancestor_id
  FROM (
    SELECT
      world_id,
      leaf_id,
      ancestor_id,
      row_number() OVER (
        PARTITION BY world_id, leaf_id
        ORDER BY depth DESC
      ) AS position
    FROM provenance_lineage
  )
  WHERE position = 1
)
UPDATE memory AS held
SET provenance_root_memory_id = root.ancestor_id
FROM deepest_ancestor AS root
WHERE held.world_id = root.world_id
  AND held.id = root.leaf_id
  AND held.provenance_root_memory_id IS NULL;

ALTER TABLE memory
  ALTER COLUMN provenance_root_memory_id SET NOT NULL;

ALTER TABLE memory
  ADD CONSTRAINT IF NOT EXISTS memory_provenance_root_fk
  FOREIGN KEY (world_id, provenance_root_memory_id)
  REFERENCES memory (world_id, id);
