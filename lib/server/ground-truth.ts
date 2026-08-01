import "server-only";

/**
 * Audience-only answers for the fixed demonstration.
 *
 * A villager must never be able to discover these values through its memory
 * tools. Keeping them in server code means the CockroachDB cluster used by the
 * Managed MCP Server does not need to store ground truth at all. Unknown or
 * user-created propositions deliberately remain unknowable.
 */
const DEMO_GROUND_TRUTH: Readonly<Record<string, boolean>> = Object.freeze({
  helped_with_field: true,
  stole_from_warehouse: false,
  repaired_warehouse: true,
  well_running_dry: true,
  broke_bridge: false,
  fixed_bridge: true,
});

export function groundTruthForPredicate(predicate: string): boolean | null {
  return Object.prototype.hasOwnProperty.call(DEMO_GROUND_TRUTH, predicate)
    ? DEMO_GROUND_TRUTH[predicate]
    : null;
}
