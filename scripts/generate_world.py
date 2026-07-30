"""Generate the deterministic seed content for a Rumor Memory Village world.

Output is db/seed_content.json: actors, claims, memories and relationships with
no embeddings. Vectors are added later by scripts/embed_seed.py so that the
committed artefact stays small and reviewable.

Everything here is deterministic. UUIDs come from uuid5 over stable names and
all shuffling uses a fixed seed, so regenerating the world produces byte-identical
output and the golden-file tests stay meaningful.

Why several hundred background memories rather than only the ten the demo
script needs: with a handful of rows per NPC the query optimizer will choose a
full scan over the vector index, which would quietly void the Distributed
Vector Indexing requirement. Volume also makes recall legible -- pulling three
relevant memories out of a hundred and fifty reads as retrieval; pulling three
out of five does not.
"""

from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

NAMESPACE = uuid.UUID("6de26358-78e4-4ac0-bb1a-9d81e3999c4f")
WORLD_ID = str(NAMESPACE)
SEED = 20260819
EPOCH = datetime(2026, 6, 1, tzinfo=timezone.utc)

OUT = Path(__file__).resolve().parent.parent / "db" / "seed_content.json"


def sid(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE, "/".join(parts)))


# ---------------------------------------------------------------------------
# Cast
# ---------------------------------------------------------------------------

ACTORS = [
    ("player", "旅の人", "The Traveller", "", "", ""),
    ("hana", "ハナ", "Hana", "畑を持つ女", "Farmer",
     "恩を長く覚えている。人を悪く言うのをためらう。"),
    ("gen", "ゲン", "Gen", "井戸の番人", "Well keeper",
     "見たものをすぐ人に話す。思い込みが強い。"),
    ("miyo", "ミヨ", "Miyo", "機織り", "Weaver",
     "誰から聞いたかを重んじる。噂の集積点。"),
    ("tatsu", "タツ", "Tatsu", "木こり", "Woodcutter",
     "自分の目で見たことしか信じない。無口。"),
    ("sue", "スエ", "Sue", "薬売り", "Medicine pedlar",
     "村の外を行き来する。話を持ち込む側。"),
]

NPCS = [a[0] for a in ACTORS if a[0] != "player"]

# Initial directed trust. Deliberately uneven: Miyo trusting Gen and Hana being
# fond of the player are what make the demo's two NPCs disagree.
TRUST = {
    ("miyo", "gen"): 0.85,
    ("miyo", "hana"): 0.60,
    ("miyo", "tatsu"): 0.55,
    ("miyo", "sue"): 0.45,
    ("miyo", "player"): 0.35,
    ("hana", "gen"): 0.50,
    ("hana", "miyo"): 0.60,
    ("hana", "tatsu"): 0.65,
    ("hana", "sue"): 0.40,
    ("hana", "player"): 0.75,
    ("gen", "hana"): 0.55,
    ("gen", "miyo"): 0.60,
    ("gen", "tatsu"): 0.70,
    ("gen", "sue"): 0.30,
    ("gen", "player"): 0.20,
    ("tatsu", "hana"): 0.70,
    ("tatsu", "gen"): 0.45,
    ("tatsu", "miyo"): 0.40,
    ("tatsu", "sue"): 0.35,
    ("tatsu", "player"): 0.50,
    ("sue", "hana"): 0.50,
    ("sue", "gen"): 0.50,
    ("sue", "miyo"): 0.65,
    ("sue", "tatsu"): 0.45,
    ("sue", "player"): 0.55,
}

AFFECTION = {("hana", "player"): 0.6}
FEAR = {("gen", "tatsu"): 0.3}


# ---------------------------------------------------------------------------
# Background claims
#
# Twelve topic families with distinct vocabulary. Templates are varied enough
# that embeddings do not collapse onto one another -- a village where every
# memory is a near-duplicate would make vector recall look better than it is.
# ---------------------------------------------------------------------------

BACKGROUND = [
    # (predicate, subject_label, ja, en)
    ("weather_rain", "空", "{}に雨が降って、{}の道がぬかるんだ。", "It rained on {} and the road by {} turned to mud."),
    ("weather_wind", "空", "{}の夜、{}のあたりで風が強かった。", "The wind was strong near {} on the night of {}."),
    ("weather_frost", "空", "{}の朝、{}に霜が降りた。", "Frost settled on {} on the morning of {}."),
    ("crop_harvest", "畑", "{}が{}の収穫を終えた。", "{} finished harvesting the {}."),
    ("crop_fail", "畑", "{}の{}が今年は実らなかった。", "The {} at {} did not bear fruit this year."),
    ("animal_seen", "山", "{}のあたりで{}を見かけた。", "A {} was seen near {}."),
    ("animal_lost", "村", "{}の{}がいなくなった。", "{}'s {} went missing."),
    ("tool_broken", "道具", "{}の{}が壊れた。", "{}'s {} broke."),
    ("tool_lent", "道具", "{}が{}に{}を貸した。", "{} lent a {} to {}."),
    ("repair_done", "普請", "{}が{}を直した。", "{} repaired the {}."),
    ("illness", "体", "{}が寝込んでいるらしい。", "They say {} has taken ill."),
    ("visitor", "外", "{}から人が来て、{}に泊まった。", "Someone came from {} and stayed at {}."),
    ("festival", "祭", "{}の祭りで{}が振る舞われた。", "{} was served at the {} festival."),
    ("river", "川", "{}の水が{}なった。", "The water at {} turned {}."),
    ("road", "道", "{}へ行く道が{}。", "The road to {} is {}."),
    ("food", "台所", "{}が{}を分けてくれた。", "{} shared some {}."),
]

PLACES = ["北の井戸", "南の畑", "水車小屋", "杉の林", "橋のたもと", "村はずれの祠",
          "谷の田んぼ", "峠の道", "古い倉庫", "川べりの小屋"]
PLACES_EN = ["the north well", "the south field", "the mill", "the cedar grove",
             "the bridge", "the roadside shrine", "the valley paddy",
             "the mountain pass", "the old warehouse", "the riverside hut"]
DAYS = ["三日前", "五日前", "先の市の日", "先月のはじめ", "雪解けのころ",
        "田植えのあと", "先の満月の晩", "祭りの前の日"]
DAYS_EN = ["three days ago", "five days ago", "the last market day",
           "early last month", "the thaw", "after the planting",
           "the last full moon", "the day before the festival"]
CROPS = ["麦", "豆", "菜", "芋", "柿", "栗", "米", "瓜"]
CROPS_EN = ["barley", "beans", "greens", "taro", "persimmons", "chestnuts",
            "rice", "melons"]
ANIMALS = ["狐", "鹿", "猪", "鳶", "野良犬", "山猫", "蛇", "白い鳥"]
ANIMALS_EN = ["fox", "deer", "boar", "kite", "stray dog", "wildcat", "snake",
              "white bird"]
TOOLS = ["鍬", "鎌", "桶", "縄", "斧", "臼", "笠", "背負い籠"]
TOOLS_EN = ["hoe", "sickle", "bucket", "rope", "axe", "mortar", "hat",
            "carrying basket"]
STRUCTURES = ["屋根", "垣根", "水路", "戸", "梯子", "小屋の床", "橋の板", "井戸の縄"]
STRUCTURES_EN = ["roof", "fence", "channel", "door", "ladder", "hut floor",
                 "bridge plank", "well rope"]
FOODS = ["漬物", "干し柿", "餅", "煮豆", "甘酒", "焼き栗"]
FOODS_EN = ["pickles", "dried persimmons", "rice cakes", "stewed beans",
            "sweet sake", "roasted chestnuts"]
OUTSIDE = ["隣の郷", "町", "峠の向こう", "海のほう"]
OUTSIDE_EN = ["the next hamlet", "town", "beyond the pass", "the coast"]
WATER_STATES = [("濁った", "muddy"), ("澄んだ", "clear"), ("減った", "low"),
                ("increased", "high")]
ROAD_STATES = [("ぬかるんでいる", "muddy"), ("崩れている", "washed out"),
               ("塞がっている", "blocked"), ("直った", "passable again")]

NAME_JA = {a[0]: a[1] for a in ACTORS}
NAME_EN = {a[0]: a[2] for a in ACTORS}


def build_background(rng: random.Random) -> list[dict]:
    """Produce a few hundred distinct, semantically spread propositions."""
    claims: list[dict] = []
    seen: set[str] = set()

    def add(predicate: str, label: str, ja: str, en: str, subject: str | None = None) -> None:
        if ja in seen:
            return
        seen.add(ja)
        claims.append(
            {
                "key": f"bg-{len(claims):04d}",
                "predicate": predicate,
                "subject_ref": subject,
                "subject_label": label,
                "canonical_ja": ja,
                "canonical_en": en,
                "truth_value": None,
            }
        )

    for day, day_en in zip(DAYS, DAYS_EN):
        for place, place_en in zip(PLACES, PLACES_EN):
            add("weather_rain", place, f"{day}に雨が降って、{place}の道がぬかるんだ。",
                f"It rained {day_en} and the road by {place_en} turned to mud.")
    for place, place_en in zip(PLACES, PLACES_EN):
        for day, day_en in zip(DAYS[:4], DAYS_EN[:4]):
            add("weather_wind", place, f"{day}の夜、{place}のあたりで風が強かった。",
                f"The wind was strong near {place_en} {day_en}.")
    for npc in NPCS:
        for crop, crop_en in zip(CROPS, CROPS_EN):
            add("crop_harvest", NAME_JA[npc], f"{NAME_JA[npc]}が{crop}の収穫を終えた。",
                f"{NAME_EN[npc]} finished harvesting the {crop_en}.", npc)
        for tool, tool_en in zip(TOOLS, TOOLS_EN):
            add("tool_broken", NAME_JA[npc], f"{NAME_JA[npc]}の{tool}が壊れた。",
                f"{NAME_EN[npc]}'s {tool_en} broke.", npc)
        for structure, structure_en in zip(STRUCTURES, STRUCTURES_EN):
            add("repair_done", NAME_JA[npc], f"{NAME_JA[npc]}が{structure}を直した。",
                f"{NAME_EN[npc]} repaired the {structure_en}.", npc)
        for food, food_en in zip(FOODS, FOODS_EN):
            add("food", NAME_JA[npc], f"{NAME_JA[npc]}が{food}を分けてくれた。",
                f"{NAME_EN[npc]} shared some {food_en}.", npc)
        add("illness", NAME_JA[npc], f"{NAME_JA[npc]}が寝込んでいるらしい。",
            f"They say {NAME_EN[npc]} has taken ill.", npc)
    for animal, animal_en in zip(ANIMALS, ANIMALS_EN):
        for place, place_en in zip(PLACES, PLACES_EN):
            add("animal_seen", place, f"{place}のあたりで{animal}を見かけた。",
                f"A {animal_en} was seen near {place_en}.")
    for place, place_en in zip(PLACES[:6], PLACES_EN[:6]):
        for state, state_en in WATER_STATES:
            add("river", place, f"{place}の水が{state}。",
                f"The water at {place_en} turned {state_en}.")
    for out, out_en in zip(OUTSIDE, OUTSIDE_EN):
        for state, state_en in ROAD_STATES:
            add("road", out, f"{out}へ行く道が{state}。",
                f"The road to {out_en} is {state_en}.")
        for place, place_en in zip(PLACES[:4], PLACES_EN[:4]):
            add("visitor", out, f"{out}から人が来て、{place}に泊まった。",
                f"Someone came from {out_en} and stayed at {place_en}.")

    rng.shuffle(claims)
    for index, claim in enumerate(claims):
        claim["key"] = f"bg-{index:04d}"
    return claims


# ---------------------------------------------------------------------------
# Scenario claims: the ten propositions the demo actually argues about.
# ---------------------------------------------------------------------------

SCENARIO = [
    dict(key="sc-help-hana", predicate="helped_with_field", subject_ref="player",
         subject_label="旅の人", truth_value=True,
         canonical_ja="旅の人がハナの畑仕事を手伝った。",
         canonical_en="The traveller helped Hana with her field work."),
    dict(key="sc-stole", predicate="stole_from_warehouse", subject_ref="player",
         subject_label="旅の人", truth_value=False,
         canonical_ja="旅の人が古い倉庫から物を盗んだ。",
         canonical_en="The traveller stole goods from the old warehouse."),
    dict(key="sc-repaired", predicate="repaired_warehouse", subject_ref="player",
         subject_label="旅の人", truth_value=True,
         canonical_ja="旅の人が古い倉庫を修理していた。",
         canonical_en="The traveller was repairing the old warehouse."),
    dict(key="sc-well-glow", predicate="well_glows", subject_ref=None,
         subject_label="北の井戸", truth_value=None,
         canonical_ja="北の井戸の水は、夜だけ青く光るらしい。",
         canonical_en="They say the water in the north well glows blue only at night."),
    dict(key="sc-well-dry", predicate="well_running_dry", subject_ref=None,
         subject_label="北の井戸", truth_value=True,
         canonical_ja="北の井戸の水が減ってきている。",
         canonical_en="The north well is running low."),
    dict(key="sc-bridge-broke", predicate="broke_bridge", subject_ref="player",
         subject_label="旅の人", truth_value=False,
         canonical_ja="旅の人が橋を壊した。",
         canonical_en="The traveller broke the bridge."),
    dict(key="sc-bridge-fixed", predicate="fixed_bridge", subject_ref="player",
         subject_label="旅の人", truth_value=True,
         canonical_ja="旅の人が橋を直していた。",
         canonical_en="The traveller was mending the bridge."),
]

CONTRADICTIONS = [
    ("sc-stole", "sc-repaired"),
    ("sc-bridge-broke", "sc-bridge-fixed"),
]


def build_memories(claims: list[dict], rng: random.Random) -> list[dict]:
    """Spread background claims across the cast, then lay the scenario on top."""
    memories: list[dict] = []

    def add(owner: str, claim_key: str, *, source_type: str, source: str | None,
            confidence: float, importance: float, emotion: float,
            emotion_type: str, day_offset: int, surface: str | None = None,
            claim_ja: str = "") -> None:
        memories.append(
            {
                "key": f"mem-{len(memories):05d}",
                "owner": owner,
                "claim_key": claim_key,
                "source_type": source_type,
                "source_ref": source,
                "witnessed_directly": source_type == "witnessed",
                "confidence_at_acq": round(confidence, 4),
                "importance": round(importance, 4),
                "emotional_weight": round(emotion, 4),
                "emotion_type": emotion_type,
                "acquired_offset_days": day_offset,
                "surface_ja": surface or claim_ja,
            }
        )

    by_key = {c["key"]: c for c in claims}

    # Background: every NPC witnesses a slice of village life and hears another
    # slice second-hand. Overlap is intentional -- shared claims are what make
    # corroboration counting non-trivial.
    for npc in NPCS:
        pool = list(claims)
        rng.shuffle(pool)
        witnessed = pool[:70]
        heard = pool[70:130]
        for claim in witnessed:
            add(npc, claim["key"], source_type="witnessed", source=None,
                confidence=rng.uniform(0.75, 0.98),
                importance=rng.uniform(0.05, 0.35),
                emotion=rng.uniform(-0.15, 0.2), emotion_type="neutral",
                day_offset=rng.randint(1, 60), claim_ja=claim["canonical_ja"])
        for claim in heard:
            informant = rng.choice([n for n in NPCS if n != npc])
            add(npc, claim["key"], source_type="heard", source=informant,
                confidence=rng.uniform(0.35, 0.75),
                importance=rng.uniform(0.03, 0.25),
                emotion=rng.uniform(-0.1, 0.15), emotion_type="neutral",
                day_offset=rng.randint(1, 45), claim_ja=claim["canonical_ja"])

    # Scenario. These are the memories the demo narrates.
    gratitude = by_key["sc-help-hana"]
    add("hana", "sc-help-hana", source_type="witnessed", source=None,
        confidence=1.0, importance=0.9, emotion=0.85, emotion_type="gratitude",
        day_offset=2, claim_ja=gratitude["canonical_ja"])

    add("gen", "sc-stole", source_type="witnessed", source=None,
        confidence=0.8, importance=0.85, emotion=-0.6, emotion_type="suspicion",
        day_offset=1, claim_ja=by_key["sc-stole"]["canonical_ja"])

    add("tatsu", "sc-repaired", source_type="witnessed", source=None,
        confidence=0.95, importance=0.8, emotion=0.1, emotion_type="neutral",
        day_offset=1, claim_ja=by_key["sc-repaired"]["canonical_ja"])

    add("gen", "sc-well-glow", source_type="heard", source="sue",
        confidence=0.5, importance=0.4, emotion=0.2, emotion_type="wonder",
        day_offset=6, claim_ja=by_key["sc-well-glow"]["canonical_ja"])
    add("gen", "sc-well-dry", source_type="witnessed", source=None,
        confidence=0.9, importance=0.7, emotion=-0.3, emotion_type="worry",
        day_offset=4, claim_ja=by_key["sc-well-dry"]["canonical_ja"])

    return memories


def main() -> None:
    rng = random.Random(SEED)
    background = build_background(rng)
    claims = background + [dict(c, subject_label=c["subject_label"]) for c in SCENARIO]
    memories = build_memories(claims, rng)

    payload = {
        "world_id": WORLD_ID,
        "seed": SEED,
        "epoch": EPOCH.isoformat(),
        "actors": [
            {
                "key": key,
                "id": sid("actor", key),
                "kind": "player" if key == "player" else "npc",
                "name_ja": name_ja,
                "name_en": name_en,
                "role_ja": role_ja,
                "role_en": role_en,
                "temperament": temperament,
            }
            for key, name_ja, name_en, role_ja, role_en, temperament in ACTORS
        ],
        "relationships": [
            {
                "npc": npc,
                "target": target,
                "trust": trust,
                "affection": AFFECTION.get((npc, target), 0.0),
                "fear": FEAR.get((npc, target), 0.0),
            }
            for (npc, target), trust in sorted(TRUST.items())
        ],
        "claims": [dict(c, id=sid("claim", c["key"])) for c in claims],
        "contradictions": [
            {"id": sid("rel", a, b), "a": a, "b": b, "relation": "mutually_exclusive"}
            for a, b in CONTRADICTIONS
        ],
        "memories": [dict(m, id=sid("memory", m["key"])) for m in memories],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    per_npc = len(payload["memories"]) / max(len(NPCS), 1)
    print(f"world      {WORLD_ID}")
    print(f"actors     {len(payload['actors'])}")
    print(f"claims     {len(payload['claims'])}  ({len(background)} background + {len(SCENARIO)} scenario)")
    print(f"memories   {len(payload['memories'])}  (~{per_npc:.0f} per NPC)")
    print(f"written to {OUT}")


if __name__ == "__main__":
    main()
