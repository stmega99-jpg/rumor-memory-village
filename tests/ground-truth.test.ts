import { describe, expect, it } from "vitest";

import { groundTruthForPredicate } from "@/lib/server/ground-truth";

describe("audience-only demo ground truth", () => {
  it("keeps the warehouse verdict outside the database", () => {
    expect(groundTruthForPredicate("stole_from_warehouse")).toBe(false);
    expect(groundTruthForPredicate("repaired_warehouse")).toBe(true);
  });

  it("covers the fixed background contradiction shown by the demo", () => {
    expect(groundTruthForPredicate("broke_bridge")).toBe(false);
    expect(groundTruthForPredicate("fixed_bridge")).toBe(true);
  });

  it("preserves every audience-only answer removed from the seed database", () => {
    expect(groundTruthForPredicate("helped_with_field")).toBe(true);
    expect(groundTruthForPredicate("well_running_dry")).toBe(true);
  });

  it("does not invent an answer for an unrecognised proposition", () => {
    expect(groundTruthForPredicate("someone_might_have_sneezed")).toBeNull();
  });
});
