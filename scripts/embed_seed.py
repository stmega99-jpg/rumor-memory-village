"""Embed the seed claims locally and emit loadable SQL.

Reads db/seed_content.json, computes one 384-dimension vector per claim with a
locally cached multilingual sentence encoder, and writes db/seed_generated.sql.

Embeddings are generated here rather than through Amazon Bedrock because Titan
Text Embeddings V2 is allocated 0 RPM on this account in every region tried,
and the requirement the hackathon actually imposes is Distributed Vector
Indexing -- vectors stored in and searched from CockroachDB. Where the vectors
come from is unconstrained. The provider sits behind embed_texts() so a Bedrock
implementation can replace it without touching anything downstream.

One vector per *claim*, never per memory: a rumour that has been distorted in
transit is still the same proposition, and corroboration counting depends on
that identity holding. memory.embedding is filled by copying from claim in a
single UPDATE at the end of the generated script.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import torch
from transformers import AutoModel, AutoTokenizer

MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DIM = 384
BATCH = 64
DECIMALS = 6

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "db" / "seed_content.json"
OUT = ROOT / "db" / "seed_generated.sql"

# The world clock starts here. Memory acquisition times are expressed as
# offsets behind it, so "advance time" moves a value the seed already anchors.
SIM_DAYS_AFTER_EPOCH = 60


def embed_texts(texts: list[str]) -> list[list[float]]:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModel.from_pretrained(MODEL_ID)
    model.eval()

    vectors: list[list[float]] = []
    for start in range(0, len(texts), BATCH):
        chunk = texts[start : start + BATCH]
        batch = tokenizer(
            chunk, padding=True, truncation=True, max_length=128, return_tensors="pt"
        )
        with torch.no_grad():
            output = model(**batch)
        mask = batch["attention_mask"].unsqueeze(-1).float()
        pooled = (output.last_hidden_state * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        normalised = torch.nn.functional.normalize(pooled, p=2, dim=1)
        vectors.extend(normalised.tolist())
        print(f"  embedded {min(start + BATCH, len(texts))}/{len(texts)}")

    if any(len(v) != DIM for v in vectors):
        raise SystemExit(f"expected {DIM}-dimension vectors from {MODEL_ID}")
    return vectors


def q(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def vec(values: list[float]) -> str:
    return "'[" + ",".join(f"{v:.{DECIMALS}f}" for v in values) + f"]'::VECTOR({DIM})"


def ts(moment: datetime) -> str:
    return q(moment.strftime("%Y-%m-%d %H:%M:%S+00")) + "::TIMESTAMPTZ"


def main() -> None:
    payload = json.loads(SRC.read_text(encoding="utf-8"))
    world_id = payload["world_id"]
    epoch = datetime.fromisoformat(payload["epoch"]).replace(tzinfo=None)
    simulated_at = epoch + timedelta(days=SIM_DAYS_AFTER_EPOCH)

    claims = payload["claims"]
    print(f"embedding {len(claims)} claims with {MODEL_ID}")
    vectors = embed_texts([c["canonical_ja"] for c in claims])

    longest = max(len(vec(v)) for v in vectors)
    print(f"longest vector literal: {longest} chars (Managed MCP limit 16384)")

    actor_id = {a["key"]: a["id"] for a in payload["actors"]}
    claim_id = {c["key"]: c["id"] for c in claims}

    lines: list[str] = [
        "-- GENERATED FILE. Produced by scripts/embed_seed.py; do not edit.",
        f"-- source: db/seed_content.json   model: {MODEL_ID}   dim: {DIM}",
        "",
        "SET database = rumor_memory_village;",
        "",
        "BEGIN;",
        "",
        f"DELETE FROM recall_event WHERE world_id = {q(world_id)};",
        f"DELETE FROM rumor_transfer WHERE world_id = {q(world_id)};",
        f"DELETE FROM conversation WHERE world_id = {q(world_id)};",
        f"DELETE FROM action_log WHERE world_id = {q(world_id)};",
        f"DELETE FROM belief WHERE world_id = {q(world_id)};",
        f"DELETE FROM memory WHERE world_id = {q(world_id)};",
        f"DELETE FROM claim_relation WHERE world_id = {q(world_id)};",
        f"DELETE FROM claim WHERE world_id = {q(world_id)};",
        f"DELETE FROM relationship WHERE world_id = {q(world_id)};",
        f"DELETE FROM actor WHERE world_id = {q(world_id)};",
        f"DELETE FROM world WHERE id = {q(world_id)};",
        "",
        "INSERT INTO world (id, label, simulated_at, is_template) VALUES",
        f"  ({q(world_id)}, 'Rumor Memory Village (template)', {ts(simulated_at)}, true);",
        "",
    ]

    lines.append("INSERT INTO actor (world_id, id, kind, name_ja, name_en, role_ja, role_en, temperament) VALUES")
    lines.append(
        ",\n".join(
            f"  ({q(world_id)}, {q(a['id'])}, {q(a['kind'])}, {q(a['name_ja'])}, "
            f"{q(a['name_en'])}, {q(a['role_ja'])}, {q(a['role_en'])}, {q(a['temperament'])})"
            for a in payload["actors"]
        )
        + ";"
    )
    lines.append("")

    lines.append("INSERT INTO relationship (world_id, npc_id, target_id, trust, affection, fear, updated_at) VALUES")
    lines.append(
        ",\n".join(
            f"  ({q(world_id)}, {q(actor_id[r['npc']])}, {q(actor_id[r['target']])}, "
            f"{r['trust']}, {r['affection']}, {r['fear']}, {ts(simulated_at)})"
            for r in payload["relationships"]
        )
        + ";"
    )
    lines.append("")

    for claim, vector in zip(claims, vectors):
        subject = q(actor_id[claim["subject_ref"]]) if claim.get("subject_ref") else "NULL"
        truth = "NULL" if claim.get("truth_value") is None else str(claim["truth_value"]).lower()
        lines.append(
            "INSERT INTO claim (world_id, id, subject_id, subject_label, subject_valence, "
            "predicate, canonical_ja, canonical_en, embedding, embedding_model, truth_value) VALUES ("
            f"{q(world_id)}, {q(claim['id'])}, {subject}, {q(claim['subject_label'])}, "
            f"{claim.get('subject_valence', 0.0)}, "
            f"{q(claim['predicate'])}, {q(claim['canonical_ja'])}, {q(claim['canonical_en'])}, "
            f"{vec(vector)}, {q(MODEL_ID)}, {truth});"
        )
    lines.append("")

    lines.append("INSERT INTO claim_relation (world_id, id, claim_a, claim_b, relation) VALUES")
    lines.append(
        ",\n".join(
            f"  ({q(world_id)}, {q(c['id'])}, {q(claim_id[c['a']])}, {q(claim_id[c['b']])}, {q(c['relation'])})"
            for c in payload["contradictions"]
        )
        + ";"
    )
    lines.append("")

    for memory in payload["memories"]:
        acquired = simulated_at - timedelta(days=memory["acquired_offset_days"])
        source = q(actor_id[memory["source_ref"]]) if memory.get("source_ref") else "NULL"
        lines.append(
            "INSERT INTO memory (world_id, id, owner_npc_id, claim_id, source_type, "
            "source_actor_id, witnessed_directly, confidence_at_acq, importance, "
            "emotional_weight, emotion_type, acquired_at, surface_ja) VALUES ("
            f"{q(world_id)}, {q(memory['id'])}, {q(actor_id[memory['owner']])}, "
            f"{q(claim_id[memory['claim_key']])}, {q(memory['source_type'])}, {source}, "
            f"{str(memory['witnessed_directly']).lower()}, {memory['confidence_at_acq']}, "
            f"{memory['importance']}, {memory['emotional_weight']}, {q(memory['emotion_type'])}, "
            f"{ts(acquired)}, {q(memory['surface_ja'])});"
        )
    lines.append("")

    # memory.embedding is a denormalised copy that exists only so the vector
    # index can be prefixed by owner. It is derived, never independently authored.
    lines.append("UPDATE memory SET embedding = claim.embedding")
    lines.append("  FROM claim")
    lines.append("  WHERE memory.world_id = claim.world_id")
    lines.append("    AND memory.claim_id = claim.id")
    lines.append(f"    AND memory.world_id = {q(world_id)};")
    lines.append("")
    lines.append("COMMIT;")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    size_mb = OUT.stat().st_size / 1_048_576
    print(f"wrote {OUT} ({size_mb:.1f} MB, {len(lines)} statements-ish)")


if __name__ == "__main__":
    main()
