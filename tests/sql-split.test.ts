import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain ESM helper shared with the loader script.
import { statements } from "../scripts/sql-split.mjs";

const ROOT = join(import.meta.dirname, "..");

describe("sql splitting", () => {
  it("splits on top-level semicolons", () => {
    expect(statements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside string literals", () => {
    const sql = "INSERT INTO t VALUES ('a;b');";
    expect(statements(sql)).toEqual(["INSERT INTO t VALUES ('a;b')"]);
  });

  it("keeps escaped apostrophes intact", () => {
    const sql = "INSERT INTO t VALUES ('Gen''s axe; broke');";
    expect(statements(sql)).toEqual(["INSERT INTO t VALUES ('Gen''s axe; broke')"]);
  });

  it("strips line comments without eating the statement", () => {
    const sql = "-- leading note\nSELECT 1; -- trailing note\nSELECT 2;";
    expect(statements(sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not treat a double dash inside a literal as a comment", () => {
    const sql = "INSERT INTO t VALUES ('a -- b');";
    expect(statements(sql)).toEqual(["INSERT INTO t VALUES ('a -- b')"]);
  });

  it("leaves every quote balanced across the real generated seed", () => {
    const sql = readFileSync(join(ROOT, "db", "seed_generated.sql"), "utf8");
    const list = statements(sql);

    expect(list.length).toBeGreaterThan(1_000);
    for (const statement of list) {
      const quotes = (statement.match(/'/g) ?? []).length;
      expect(quotes % 2).toBe(0);
    }
  });

  it("parses the schema into balanced statements", () => {
    const sql = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");
    const list = statements(sql);

    expect(list.some((s) => s.includes("CREATE VECTOR INDEX"))).toBe(true);
    expect(list.some((s) => s.includes("CREATE VIEW"))).toBe(true);
    // truth_value must never reach the MCP-facing projections.
    const views = list.filter((s) => s.includes("CREATE VIEW"));
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(view).not.toContain("truth_value");
    }
  });
});
