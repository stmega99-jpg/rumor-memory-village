"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The village, as a judge sees it.
 *
 * Built around one claim: the same afternoon produces different conclusions in
 * different heads, and every difference can be traced to who said what to whom.
 * So the explanation under each verdict is the primary content on this page,
 * not a detail panel behind a click.
 */

interface Villager {
  id: string;
  kind: string;
  nameJa: string;
  nameEn: string;
  roleJa: string;
  roleEn: string;
  trustInPlayer: number;
  affectionForPlayer: number;
  fearOfPlayer: number;
  memoryCount: number;
}

interface Verdict {
  npcId: string;
  npcNameJa: string;
  npcNameEn: string;
  claimId: string;
  claimJa: string;
  claimEn: string;
  truthValue: boolean | null;
  status: string;
  score: number;
  opposingScore: number;
  rationaleJa: string;
  rationaleEn: string;
  rationale: {
    corroborationCount?: number;
    repeatCount?: number;
    priorBias?: number;
    usedMemories?: Array<{
      source: string;
      trust: number;
      confidence: number;
      witnessed: boolean;
      contribution: number;
    }>;
  } | null;
}

interface Transfer {
  id: string;
  claimJa: string;
  claimEn: string;
  fromJa: string;
  fromEn: string;
  toJa: string;
  toEn: string;
  outcome: string;
  confidenceBefore: number;
  confidenceAfter: number;
  note: string;
}

interface Contradiction {
  aJa: string;
  aEn: string;
  bJa: string;
  bEn: string;
  holders: string[];
}

interface VillageState {
  worldId: string;
  simulatedAt: string;
  villagers: Villager[];
  verdicts: Verdict[];
  transfers: Transfer[];
  contradictions: Contradiction[];
  totals: { claims: number; memories: number; transfers: number };
}

interface Step {
  kind: string;
  note: string;
  from?: string;
  to?: string;
  days?: number;
}

interface StepLine {
  index: number;
  label: string;
  note: string;
  detail: string;
  outcome: "adopted" | "refused" | "other";
}

interface RecallGroup {
  claimId: string;
  surfaceJa: string;
  score: number;
  similarity: number;
  trust: number;
  confidence: number;
  recency: number;
  emotion: number;
  corroborationCount: number;
  repeatCount: number;
  sources: string[];
}

interface RecallResult {
  topicJa: string;
  topicEn: string;
  candidateCount: number;
  statementLength: number;
  statementPreview: string;
  groups: RecallGroup[];
}

const STATUS_LABEL: Record<string, string> = {
  believed: "believes it",
  doubted: "is unsure",
  rejected: "rejects it",
  unknown: "no longer knows",
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default function VillageClient() {
  const [state, setState] = useState<VillageState | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [lines, setLines] = useState<StepLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [recalling, setRecalling] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/village");
      const body = (await response.json()) as VillageState & { error?: string };
      if (body.error) throw new Error(body.error);
      setState(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The village is unreachable.");
    }
  }, []);

  useEffect(() => {
    void load();
    void fetch("/api/scenario")
      .then((r) => r.json())
      .then((b: { steps: Step[] }) => setSteps(b.steps))
      .catch(() => undefined);
  }, [load]);

  const runDemonstration = useCallback(async () => {
    setRunning(true);
    setLines([]);
    setRecall(null);
    setError(null);

    try {
      for (let index = 0; index < steps.length; index += 1) {
        const response = await fetch("/api/scenario", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ index }),
        });
        const body = (await response.json()) as {
          error?: string;
          result: { step: Step; detail: string };
          state: VillageState | null;
        };
        if (body.error) throw new Error(body.error);

        const step = body.result.step;
        setLines((previous) => [
          ...previous,
          {
            index,
            label:
              step.kind === "tell"
                ? `${step.from} tells ${step.to}`
                : step.kind === "advance"
                  ? `${step.days} days pass`
                  : "Everyone re-weighs what they hold",
            note: step.note,
            detail: body.result.detail,
            outcome: body.result.detail.includes("refused")
              ? "refused"
              : body.result.detail.includes("took it on")
                ? "adopted"
                : "other",
          },
        ]);
        if (body.state) setState(body.state);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The demonstration stopped.");
    } finally {
      setRunning(false);
    }
  }, [steps]);

  const reset = useCallback(async () => {
    setRunning(true);
    setLines([]);
    setRecall(null);
    try {
      const response = await fetch("/api/village", { method: "DELETE" });
      const body = (await response.json()) as VillageState & { error?: string };
      if (body.error) throw new Error(body.error);
      setState(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset.");
    } finally {
      setRunning(false);
    }
  }, []);

  const askVillager = useCallback(
    async (npcId: string, topicClaimId: string) => {
      setRecalling(true);
      setSelected(npcId);
      try {
        const response = await fetch("/api/recall", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ npcId, topicClaimId }),
        });
        const body = (await response.json()) as RecallResult & { error?: string };
        if (body.error) throw new Error(body.error);
        setRecall(body);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Recall failed.");
        setRecall(null);
      } finally {
        setRecalling(false);
      }
    },
    [],
  );

  /** Verdicts grouped by the proposition they are about. */
  const disputes = useMemo(() => {
    const byClaim = new Map<string, Verdict[]>();
    for (const verdict of state?.verdicts ?? []) {
      byClaim.set(verdict.claimId, [...(byClaim.get(verdict.claimId) ?? []), verdict]);
    }
    return [...byClaim.values()]
      .filter((group) => group.length > 0)
      .sort((a, b) => b.length - a.length);
  }, [state]);

  const npcs = (state?.villagers ?? []).filter((v) => v.kind === "npc");
  const topicClaimId = disputes[0]?.[0]?.claimId ?? null;

  return (
    <main className="village">
      <header className="village-head">
        <p className="eyebrow">Durable memory for multi-agent worlds</p>
        <h1>
          One afternoon.
          <br />
          Three incompatible accounts of it.
        </h1>
        <p className="lede">
          Five villagers each keep their own memories: what they saw, what they
          were told, who told them, how sure they were and how long ago it was.
          Rumours travel between them, wear down, and get refused. Nothing is
          deleted to resolve a contradiction — only the verdict moves, and every
          verdict below can be traced back to the evidence that produced it.
        </p>

        <div className="controls">
          <button
            type="button"
            onClick={() => void runDemonstration()}
            disabled={running || steps.length === 0}
            className="primary"
          >
            {running ? "Running…" : "Run the demonstration"}
          </button>
          <button type="button" onClick={() => void reset()} disabled={running}>
            Reset the village
          </button>
          {state ? (
            <span className="meta">
              your own copy · {state.totals.memories} memories ·{" "}
              {state.totals.claims} propositions · day{" "}
              {state.simulatedAt.slice(0, 10)}
            </span>
          ) : null}
        </div>

        {error ? <p className="error">{error}</p> : null}
      </header>

      {lines.length > 0 || running ? (
        <section className="panel">
          <h2>What happened</h2>
          <ol className="timeline">
            {lines.map((line) => (
              <li key={line.index} className={line.outcome}>
                <span className="step-label">{line.label}</span>
                <span className="step-detail">{line.detail}</span>
                <span className="step-note">{line.note}</span>
              </li>
            ))}
            {running && lines.length < steps.length ? (
              // Named while it runs, not after. The first step forks a village
              // and re-weighs every villager, which takes long enough that an
              // unlabelled spinner reads as a hang.
              <li className="pending">
                <span className="step-label">
                  {(() => {
                    const next = steps[lines.length];
                    if (!next) return "Working…";
                    if (next.kind === "tell") return `${next.from} tells ${next.to}`;
                    if (next.kind === "advance") return `${next.days} days pass`;
                    return "Everyone re-weighs what they hold";
                  })()}
                </span>
                <span className="step-detail">working…</span>
                <span className="step-note">{steps[lines.length]?.note}</span>
              </li>
            ) : null}
          </ol>
        </section>
      ) : null}

      {disputes.length > 0 ? (
        <section className="panel">
          <h2>Who believes what, and why</h2>
          {disputes.map((group) => (
            <article key={group[0].claimId} className="dispute">
              <header>
                <p className="claim-ja">{group[0].claimJa}</p>
                <p className="claim-en">{group[0].claimEn}</p>
                <p className="truth">
                  ground truth:{" "}
                  {group[0].truthValue === null
                    ? "unknowable"
                    : group[0].truthValue
                      ? "true"
                      : "false"}
                  <span className="hint">
                    {" "}
                    — held out of every villager&rsquo;s reach
                  </span>
                </p>
              </header>

              <ul className="verdicts">
                {group.map((verdict) => (
                  <li key={verdict.npcId} className={verdict.status}>
                    <div className="verdict-head">
                      <strong>{verdict.npcNameEn}</strong>
                      <span className="ja">{verdict.npcNameJa}</span>
                      <span className={`status ${verdict.status}`}>
                        {STATUS_LABEL[verdict.status] ?? verdict.status}
                      </span>
                      <span className="score">
                        {verdict.score.toFixed(2)} vs {verdict.opposingScore.toFixed(2)}
                      </span>
                    </div>
                    <p className="why-en">{verdict.rationaleEn}</p>
                    <p className="why-ja">{verdict.rationaleJa}</p>
                    {verdict.rationale?.usedMemories?.length ? (
                      <table className="evidence">
                        <thead>
                          <tr>
                            <th>from</th>
                            <th>trust</th>
                            <th>confidence</th>
                            <th>weight</th>
                          </tr>
                        </thead>
                        <tbody>
                          {verdict.rationale.usedMemories.map((memory, i) => (
                            <tr key={i}>
                              <td>{memory.witnessed ? "saw it" : memory.source}</td>
                              <td>{memory.trust.toFixed(2)}</td>
                              <td>{memory.confidence.toFixed(2)}</td>
                              <td>{memory.contribution.toFixed(3)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      ) : null}

      {state && state.transfers.length > 0 ? (
        <section className="panel">
          <h2>How it travelled</h2>
          <ul className="hops">
            {state.transfers.map((hop) => (
              <li key={hop.id} className={hop.outcome}>
                <span className="hop-route">
                  {hop.fromEn} → {hop.toEn}
                </span>
                <span className={`hop-outcome ${hop.outcome}`}>{hop.outcome}</span>
                <span className="hop-conf">
                  {pct(hop.confidenceBefore)} → {pct(hop.confidenceAfter)}
                </span>
                <span className="hop-note">{hop.note}</span>
                <span className="hop-claim">{hop.claimEn}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state && state.contradictions.some((c) => c.holders.length > 0) ? (
        <section className="panel">
          <h2>Contradictions held, not resolved</h2>
          {state.contradictions
            .filter((c) => c.holders.length > 0)
            .map((c) => (
              <div key={c.aEn} className="contradiction">
                <p>{c.aEn}</p>
                <p className="versus">cannot both be true</p>
                <p>{c.bEn}</p>
                <p className="holders">
                  both accounts still in memory: {c.holders.join(", ")}
                </p>
              </div>
            ))}
        </section>
      ) : null}

      {npcs.length > 0 && topicClaimId ? (
        <section className="panel">
          <h2>Ask a villager</h2>
          <p className="lede small">
            Their memory is searched through the CockroachDB Cloud Managed MCP
            Server: a vector search over their own memories, then ranked by who
            told them, how sure they were, how long ago it was and how much it
            mattered. Similarity alone would give a different order.
          </p>
          <div className="asks">
            {npcs.map((npc) => (
              <button
                key={npc.id}
                type="button"
                onClick={() => void askVillager(npc.id, topicClaimId)}
                disabled={recalling}
                className={selected === npc.id ? "selected" : ""}
              >
                {npc.nameEn}
                <span className="ja">{npc.nameJa}</span>
                <span className="role">{npc.roleEn}</span>
                <span className="count">{npc.memoryCount} memories</span>
              </button>
            ))}
          </div>

          {recalling ? <p className="meta">searching…</p> : null}

          {recall ? (
            <div className="recall">
              <p className="meta">
                asked about “{recall.topicEn}” · {recall.candidateCount} candidates
                considered · statement {recall.statementLength} chars of the 16,384
                Managed MCP allows
              </p>
              <ol className="recalled">
                {recall.groups.map((group) => (
                  <li key={group.claimId}>
                    <p className="recalled-text">{group.surfaceJa}</p>
                    <p className="recalled-terms">
                      score <strong>{group.score.toFixed(3)}</strong> ·
                      similarity {group.similarity.toFixed(3)} · trust{" "}
                      {group.trust.toFixed(2)} · confidence{" "}
                      {group.confidence.toFixed(2)} · recency{" "}
                      {group.recency.toFixed(2)}
                      {group.corroborationCount > 0
                        ? ` · ${group.corroborationCount + 1} independent sources`
                        : ""}
                      {group.repeatCount > 0
                        ? ` · heard ${group.repeatCount + 1} times from the same person`
                        : ""}
                    </p>
                    <p className="recalled-src">from: {group.sources.join(", ")}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      ) : null}

      <footer className="village-foot">
        <p>
          CockroachDB Cloud Managed MCP Server · Distributed Vector Indexing ·
          AWS Amplify Hosting · Amazon Bedrock
        </p>
        <p className="meta">
          MIT licensed. Every visitor gets their own copy of the village, so
          nothing you do here changes what the next person sees.
        </p>
      </footer>
    </main>
  );
}
