-- Ground truth is audience-only data. Managed MCP currently queries through a
-- Cloud-managed SQL identity with broad cluster privileges, so a projection or
-- advisory read role cannot make this column secret. The fixed demo answers now
-- live in server-only application code instead of the MCP-connected database.

SET database = rumor_memory_village;

ALTER TABLE claim
  DROP COLUMN IF EXISTS truth_value;
