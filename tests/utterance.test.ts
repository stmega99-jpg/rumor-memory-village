import { describe, expect, it } from "vitest";

import { templateLine, type UtteranceInput } from "../lib/memory/utterance";

function input(overrides: Partial<UtteranceInput> = {}): UtteranceInput {
  return {
    villagerJa: "ハナ",
    villagerEn: "Hana",
    status: "believed",
    sourceJa: "タツ",
    sourceEn: "Tatsu",
    surfaceJa: "旅の人が倉庫を修理していたって話だ。",
    claimEn: "The traveller was repairing the old warehouse.",
    emotionalWeight: 0.2,
    ...overrides,
  };
}

describe("what a villager says", () => {
  it("speaks the wording they actually hold, not the canonical claim", () => {
    // The surface text has already been worn down by retelling. Speaking the
    // tidy original would hide the entire propagation model.
    const line = templateLine(input());
    expect(line.ja).toContain("修理していたって話だ");
  });

  it("names the informant when the memory came second-hand", () => {
    expect(templateLine(input()).ja).toContain("タツ");
  });

  it("does not name an informant for something witnessed", () => {
    const line = templateLine(input({ sourceJa: null, sourceEn: null }));
    expect(line.ja).not.toContain("から聞いた");
  });

  it("keeps Japanese names out of the English rendering", () => {
    // Subtitles are for readers who do not read the script the name is in.
    const line = templateLine(input());
    expect(line.en).toContain("Tatsu");
    expect(line.en).not.toContain("タツ");
  });

  it("says something different for each verdict", () => {
    const lines = ["believed", "doubted", "rejected", "unknown"].map(
      (status) => templateLine(input({ status })).ja,
    );
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("still produces a sentence for an unrecognised verdict", () => {
    // A blank speech bubble on a public demo is worse than a vague villager.
    const line = templateLine(input({ status: "not-a-status" }));
    expect(line.ja.length).toBeGreaterThan(0);
    expect(line.en.length).toBeGreaterThan(0);
  });

  it("is deterministic, so a replayed scenario reads identically", () => {
    expect(templateLine(input())).toEqual(templateLine(input()));
  });

  it("labels itself as the fallback wording", () => {
    // The interface tells the visitor which lines a model wrote and which it
    // did not; claiming Bedrock authorship of a template would be a small lie
    // in the one place the demo is making a point about provenance.
    expect(templateLine(input()).mode).toBe("template");
  });
});
