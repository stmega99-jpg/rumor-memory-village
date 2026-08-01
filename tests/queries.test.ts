import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  MCP_STATEMENT_LIMIT,
  UnsafeQueryValueError,
  buildClaimQuery,
  buildMemoryTextQuery,
  buildProvenanceSourceQuery,
  buildRecallQuery,
  buildRelationshipQuery,
  positiveInt,
  uuid,
  vectorLiteral,
} from "../lib/memory/queries";

const WORLD = "6de26358-78e4-4ac0-bb1a-9d81e3999c4f";
const NPC = "a42e7cdc-727c-5326-a307-3a3d187a4f1c";
const CLAIM = "11111111-2222-3333-4444-555555555555";

const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
  Math.sin(i) / 2,
);

describe("value guards", () => {
  it("accepts a well-formed uuid", () => {
    expect(uuid(WORLD)).toBe(`'${WORLD}'`);
  });

  it.each([
    ["a quoted injection", "' OR 1=1 --"],
    ["a uuid with a trailing statement", `${WORLD}'; DROP TABLE memory; --`],
    ["an empty string", ""],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s outright rather than escaping it", (_label, value) => {
    expect(() => uuid(value)).toThrow(UnsafeQueryValueError);
  });

  it("bounds integers on both sides", () => {
    expect(positiveInt(24, "limit", 200)).toBe("24");
    expect(() => positiveInt(0, "limit", 200)).toThrow(UnsafeQueryValueError);
    expect(() => positiveInt(201, "limit", 200)).toThrow(UnsafeQueryValueError);
    expect(() => positiveInt(1.5, "limit", 200)).toThrow(UnsafeQueryValueError);
  });

  it("requires an embedding of exactly the indexed width", () => {
    expect(() => vectorLiteral(embedding.slice(0, 383))).toThrow(
      UnsafeQueryValueError,
    );
    expect(() => vectorLiteral([...embedding, 0])).toThrow(UnsafeQueryValueError);
  });

  it("rejects a vector containing anything that is not a finite number", () => {
    const withNaN = [...embedding];
    withNaN[7] = Number.NaN;
    expect(() => vectorLiteral(withNaN)).toThrow(UnsafeQueryValueError);

    const withInfinity = [...embedding];
    withInfinity[7] = Number.POSITIVE_INFINITY;
    expect(() => vectorLiteral(withInfinity)).toThrow(UnsafeQueryValueError);
  });

  it("emits a vector literal with no room for anything but digits", () => {
    const literal = vectorLiteral(embedding);
    expect(literal.startsWith("'[")).toBe(true);
    expect(literal.endsWith(`]'::VECTOR(${EMBEDDING_DIMENSIONS})`)).toBe(true);
    expect(/[^0-9.,\-[\]'():VECTOR]/.test(literal)).toBe(false);
  });
});

describe("recall query", () => {
  const sql = buildRecallQuery({
    worldId: WORLD,
    ownerNpcId: NPC,
    embedding,
    limit: 24,
  });

  it("names the vector index explicitly", () => {
    // A freshly forked world is in no histogram, so the planner would estimate
    // one matching row and choose a primary-key scan. Recall would still look
    // right and never touch the vector index.
    expect(sql).toContain("FROM memory@memory_embedding_idx");
  });

  it("never reads the table that holds ground truth", () => {
    expect(sql).not.toContain("claim ");
    expect(sql).not.toContain("truth_value");
  });

  it("pins both index prefix columns", () => {
    expect(sql).toContain(`world_id = '${WORLD}'`);
    expect(sql).toContain(`owner_npc_id = '${NPC}'`);
  });

  it("orders by distance with a limit, which is what drives the vector index", () => {
    expect(sql).toMatch(/ORDER BY distance LIMIT 24$/);
  });

  it("never returns the embedding itself, only a distance derived from it", () => {
    const selectList = sql.slice(0, sql.indexOf(" FROM "));
    // `embedding <=> $q AS distance` yields a float and is fine. A bare
    // `embedding` in the select list would be ~3.6 KB of the 10 KiB response
    // budget per row, so every mention must be consumed by the operator.
    const mentions = selectList.match(/embedding\s*(<=>)?/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(mention).toContain("<=>");
    }
  });

  it("mentions the vector exactly once", () => {
    expect(sql.split("::VECTOR(384)").length - 1).toBe(1);
  });

  it("leaves prose out of the ranking pass", () => {
    // Measured on the live cluster: including surface_ja made a 24-row
    // response 12.8 KB against a 10 KiB ceiling. Text is fetched later, for
    // the few memories actually spoken from.
    expect(sql).not.toContain("surface_ja");
    expect(sql).not.toContain("canonical_ja");
  });

  it("fits inside the statement ceiling with room to spare", () => {
    expect(sql.length).toBeLessThan(MCP_STATEMENT_LIMIT);
    // Half the budget still free is the margin that made 384 dimensions the
    // right choice; if this ever tightens, the dimension count is the cause.
    expect(sql.length).toBeLessThan(MCP_STATEMENT_LIMIT / 2);
  });

  it("refuses to build anything from a malformed villager id", () => {
    expect(() =>
      buildRecallQuery({
        worldId: WORLD,
        ownerNpcId: "'; DELETE FROM memory; --",
        embedding,
        limit: 24,
      }),
    ).toThrow(UnsafeQueryValueError);
  });
});

describe("memory text lookup", () => {
  const MEM = "22222222-3333-4444-5555-666666666666";

  it("fetches prose for a narrow batch", () => {
    const sql = buildMemoryTextQuery(WORLD, [MEM]);
    expect(sql).toContain("surface_ja");
    expect(sql).toContain(`world_id = '${WORLD}'`);
    expect(sql).not.toContain("truth_value");
  });

  it("refuses a batch large enough to overrun the response ceiling", () => {
    const many = Array.from({ length: 13 }, () => MEM);
    expect(() => buildMemoryTextQuery(WORLD, many)).toThrow(UnsafeQueryValueError);
  });

  it("refuses an empty batch rather than emitting IN ()", () => {
    expect(() => buildMemoryTextQuery(WORLD, [])).toThrow(UnsafeQueryValueError);
  });
});

describe("provenance source lookup", () => {
  const ROOT = "22222222-3333-4444-5555-666666666666";

  it("resolves the named source of a root through world-scoped MCP SQL", () => {
    const sql = buildProvenanceSourceQuery(WORLD, [ROOT]);
    expect(sql).toContain("FROM memory AS root");
    expect(sql).toContain("root.source_actor_id");
    expect(sql).toContain("root.owner_npc_id");
    expect(sql).toContain(`root.world_id = '${WORLD}'`);
    expect(sql).not.toContain("truth_value");
  });

  it("validates the batch before constructing an IN clause", () => {
    expect(() => buildProvenanceSourceQuery(WORLD, [])).toThrow(
      UnsafeQueryValueError,
    );
    expect(() => buildProvenanceSourceQuery(WORLD, [ROOT, "not-a-uuid"])).toThrow(
      UnsafeQueryValueError,
    );
  });
});

describe("supporting queries", () => {
  it("looks claims up by id without exposing truth_value", () => {
    const sql = buildClaimQuery(WORLD, [CLAIM]);
    expect(sql).toContain("FROM mcp_claim");
    expect(sql).not.toContain("truth_value");
  });

  it("refuses an empty claim list rather than emitting IN ()", () => {
    expect(() => buildClaimQuery(WORLD, [])).toThrow(UnsafeQueryValueError);
  });

  it("validates every id in a batch, not just the first", () => {
    expect(() => buildClaimQuery(WORLD, [CLAIM, "nope"])).toThrow(
      UnsafeQueryValueError,
    );
  });

  it("scopes relationships to one villager in one world", () => {
    const sql = buildRelationshipQuery(WORLD, NPC);
    expect(sql).toContain(`world_id = '${WORLD}'`);
    expect(sql).toContain(`npc_id = '${NPC}'`);
  });
});
