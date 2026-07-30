# Submission kit

Everything needed to record the video and fill in the Devpost form. Written to
be executed, not adapted.

Deadline: **2026-08-18 17:00 EDT** (2026-08-19 06:00 JST).

---

## 1. Video storyboard (target 2:45, hard limit 3:00)

Screen recording of the live demo. No face, no voice required — burned-in
English captions are enough, and they satisfy the rules' English requirement.
Japanese appears on screen as villager dialogue, which is the point rather than
a problem.

**Before you hit record**

1. Open the live URL and click **Reset the village**. Wait for it to finish.
2. Set the browser to a wide window so the layout is the desktop one.
3. Have the page scrolled to the top.

| Time | On screen | Caption |
|---|---|---|
| 0:00–0:15 | The headline and lede, unscrolled | "Agents that exchange information of uneven reliability need more than a shared memory. They need to know who told them, how sure they were, and when." |
| 0:15–0:22 | Click **Run the demonstration**. The first line appears immediately. | "Every visitor gets their own copy of the village. This one is forked live." |
| 0:22–1:05 | The narration fills in, step by step. Let it run; do not scroll away. | "Gen thinks he saw a theft. He tells Miyo, who trusts him. He tells Hana, who owes the traveller a debt." … "Tatsu watched the whole thing. He refuses the rumour: believing the opposite raises his bar from 0.35 to 0.55, and he trusts Miyo 0.40." |
| 1:05–1:15 | The **45 days pass** line, then the last evaluation | "Then six weeks pass." |
| 1:15–1:55 | Scroll to **Who believes what, and why**. Rest on the theft card. | "One afternoon. Gen still believes it — he saw it. Miyo no longer knows; hearsay faded. Hana rejects it, and her refusal rests on a debt she witnessed herself, so it did not fade." Point at the evidence table: "Every number here is recomputed from the database. No model decides what anyone believes." |
| 1:55–2:10 | Scroll to **How it travelled** | "Refusals are recorded too. A propagation graph with only successes in it would be a graph of what we hoped would happen." |
| 2:10–2:20 | Scroll to **Contradictions held, not resolved** | "Nothing is deleted to resolve a contradiction. Two villagers still hold both accounts." |
| 2:20–2:45 | Scroll to **Ask a villager**, click **Hana**, wait for results | "Her memory is searched through the CockroachDB Cloud Managed MCP Server — a vector search over her memories, then ranked. Notice the rumour still carries the wariness Gen put into it. And notice the ranking disagrees with raw similarity: that difference is the whole reason there is a ranking pass." |
| 2:45–2:55 | The footer | "CockroachDB Managed MCP and Distributed Vector Indexing, on AWS Amplify with Bedrock. MIT licensed." |

**If it runs long**, cut 1:55–2:10 (the propagation panel) first. It is the
most self-explanatory section.

**Do not** film the reset, the first fork wait, or any page load. Cut to the
narration already moving.

---

## 2. Devpost fields

### Tagline (one line)

> Durable, provenance-aware memory for multi-agent systems — demonstrated by a
> village that cannot agree on what happened.

### What it does

> Rumor Memory Village is a memory layer for systems where agents exchange
> information of uneven reliability. Each agent holds its own memories tagged
> with source, confidence and time. Information passes between agents, loses
> fidelity in transit, and is sometimes refused. When two accounts cannot both
> be true, both are kept and only the verdict moves — and every verdict can be
> recomputed from the evidence that produced it.
>
> The demo is five villagers and one disputed afternoon. They end up holding
> three incompatible views of the same event, and the interface shows why each
> one landed where it did: who told them, how much they trusted that person,
> how much confidence survived the retelling, and what their existing feelings
> did to it.
>
> The same substrate applies wherever agents pass each other claims of uneven
> reliability: contamination tracking in multi-agent RAG, provenance in incident
> response, handover quality in customer support.

### How we built it

> Memories are stored in CockroachDB with a 384-dimension embedding and searched
> through a cosine vector index prefixed by (world, agent), so a search is scoped
> to one agent before distance is considered. Recall runs exclusively through the
> CockroachDB Cloud Managed MCP Server; transactional updates use a direct SQL
> connection, because Managed MCP offers select_query and insert_rows but not the
> updates belief re-evaluation needs.
>
> Ranking, decay, propagation and arbitration are deterministic code. A language
> model writes the sentence a villager says; it never decides what they believe.
> That is what makes the explanation log honest — every number in it can be
> recomputed.
>
> Runs on AWS Amplify Hosting with credentials from Secrets Manager, and Amazon
> Bedrock Nova Lite for dialogue.

### Challenges we ran into

> The most useful bug was silent. With table statistics missing — or in a
> freshly forked world, which appears in no histogram — the query planner
> estimated one matching row where there were 655 and chose a primary-key scan
> over the vector index. Recall still returned the right memories, so nothing
> looked wrong; the vector index was simply never touched. The recall query now
> names its index, and a check fails the build if the plan regresses.
>
> Managed MCP's ceilings shaped the schema more than we expected: 16,384
> characters per statement and 10 KiB per response. A 24-row response carrying
> memory text came to 12.8 KB. Ranking now selects only what scoring consumes and
> fetches prose afterwards for the few memories actually spoken from.

### What's next

> The propagation and arbitration core is engine-agnostic and sits behind an HTTP
> API, so it is meant to be lifted into a game runtime rather than stay a web
> demo.

### Tools used (the form asks explicitly)

**CockroachDB**
- Cloud Managed MCP Server — the only path by which an agent reads its own
  memory; every recall is a `select_query` through it, with no direct-SQL
  fallback.
- Distributed Vector Indexing — cosine vector index over memory embeddings,
  prefixed by `(world_id, owner_npc_id)`.

**AWS**
- Amplify Hosting — runs the Next.js app and API routes.
- Amazon Bedrock (Nova Lite) — villager dialogue.
- Secrets Manager — MCP key, cluster id, database URL.

---

## 3. Pre-submission checklist

- [ ] `cockroachSqlUrl` present in the `rumor-memory-village/prod` secret
- [ ] Live URL loads and **Run the demonstration** completes end to end
- [ ] Reset works, and a second run produces the same result as the first
- [ ] Repository public, `LICENSE` detected by GitHub in the sidebar
- [ ] README front page renders (tables, diagram, no broken links)
- [ ] Video under 3:00, public on YouTube or Vimeo, English captions
- [ ] Devpost fields filled from section 2
- [ ] AWS Budgets alert set (notification only — it must not throttle the demo,
      which the rules require to stay free and unrestricted during judging)
- [ ] `npm test` green and `npm run db:verify` green on the submitted commit
