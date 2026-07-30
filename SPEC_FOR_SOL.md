# Rumor Memory Village — 実装発注書（ソル向け）

CockroachDB × AWS Hackathon "Build with Agentic Memory" 提出物。
作成日 2026-07-30 / 発注者: プロデューサー / 監査: Claude

---

## 0. このドキュメントの読み方

- **§1 の大会情報は 2026-07-30 に Devpost 公式ページで実確認済み。再調査は不要。**
  ただし審査配点は非公開、規約タブ全文は未読（§1 末尾に未確認事項を明記）。
- §2 以降は設計指示。**変更してよいが、変更する場合は理由を1行で示すこと。**
- 完成条件（§12）を満たすまで機能を増やさない。

---

## 1. 大会の確定事実（実確認済み）

| 項目 | 内容 |
|---|---|
| 大会 | CockroachDB × AWS Hackathon: Build with Agentic Memory |
| URL | https://cockroachdb-ai.devpost.com/ |
| 締切 | **2026-08-18 17:00 EDT = 2026-08-19 06:00 JST** |
| 賞金 | 1位 $5,000 / 2位 $2,500 / 3位 $1,250（総額 $8,750） |
| 形式 | オンライン・公開 |

### 提出物（全部必須）

1. **公開リポジトリ**（全ソース＋README＋依存関係＋セットアップ手順）
2. **稼働する公開デモURL**
3. **3分未満のデモ動画**（YouTube または Vimeo、公開設定）
4. 使用した CockroachDB / AWS ツールと、その具体的な用途の明示
5. （任意）アーキテクチャ図、CockroachDB AI ツールへのフィードバック

### 必須技術

**CockroachDB ツール — 以下4つのうち最低2つ:**

- Cloud Managed MCP Server
- Distributed Vector Indexing
- ccloud CLI (Agent-Ready)
- Agent Skills Repo (Open Source)

> ⚠ **最重要**: 「CockroachDB を DB として使う」だけではこの要件を**満たさない**。
> ORM (Drizzle/Prisma) で普通の SQL を書くのは上記4つのどれでもない。
> 本発注書では **MCP Server + Distributed Vector Indexing** の2つで満たす（§4）。

**AWS サービス — 最低1つ:**
Bedrock / Lambda / ECS / EKS / S3 / SageMaker / Bedrock Agents 等。
本発注書では **Bedrock（主）＋ Lambda ＋ S3** を使う（§4）。

### 審査軸（5つ・**配点は非公開**）

1. Agentic Memory Design
2. Technical Implementation
3. Real-World Impact
4. Production Readiness
5. Creativity & Originality

### 未確認事項（必要になったら自分で確認すること）

- 規約タブ（Rules）の全文
- チーム人数の上限
- 既存プロジェクトの流用可否
- 提出後の変更可否

---

## 2. 作るもの

**一行**: 信頼度の異なる情報源から矛盾する情報を受け取るマルチエージェント系のための、**来歴付き信念メモリ基盤**。日本の田舎風の村とNPCは、それを可視化するデモ用の皮。

**この順序で説明すること。** 「NPCが噂を流すゲーム」から入ると審査軸3（Real-World Impact）が0点で読まれる。基盤が主、村がデモ、と提示する。README・動画・Devpost説明文すべてこの順序に揃える。

**転用先**（README に書く）: マルチエージェントRAGの汚染検知、インシデント対応の情報伝播追跡、カスタマーサポートの引き継ぎ品質。いずれも「誰から聞いたか」「どれくらい確かか」「矛盾したらどちらを採るか」が同型。

**副次目的**: 完成物は Godot 製ゲーム「龍ミミズ」のNPC記憶サブシステムとして移植可能であること。したがってコアロジックはUIから分離し、HTTP API 越しに完結させる。

---

## 3. 中核となる主張（デモで示すもの）

> **同一の事件に対して、NPCごとに異なる結論と発言が生まれる。その差分の原因が、記憶の来歴として全部追跡できる。**

これ1点。他は全部この主張を支えるための部品。

---

## 4. 要件充足マトリクス

**着手前にこの表を埋め切れることを確認すること。** 埋まらない行があれば実装前に報告。

| 要件 | 満たす実装 | 実質性の説明（提出フォームにそのまま書く） |
|---|---|---|
| CockroachDB #1: MCP Server | NPCエージェントが自分の記憶を MCP 経由で retrieve する。**製品の実行経路に置く**（開発補助ではない） | 「各NPCの想起は MCP Server 経由のクエリとして実行される」 |
| CockroachDB #2: Vector Indexing | claim 本文の埋め込みを CockroachDB のベクトルインデックスに格納し、想起の第一段フィルタに使う | 「意味的に関連する記憶の想起にベクトル検索を使用」 |
| AWS #1: Bedrock | NPCの発話生成＋矛盾裁定の自然言語推論 | 「NPCの発話と信念裁定の推論に使用」 |
| AWS #2: Lambda | 「時間を進める」ティック（NPC間会話の実行・噂の伝播） | 「時間経過イベントの実行」 |
| AWS #3: S3 | 来歴ログ（説明ログ）のエクスポート先 | 「監査ログの永続保存」 |

AWS は1つで足りるので、時間が足りなければ Lambda と S3 は落としてよい（Bedrock は落とさない）。
**CockroachDB の2つは落とせない。** ここが落ちると失格。

---

## 5. データモデル

### 5.1 3層に分ける（ここが設計の要）

素朴に `memory` テーブル1枚に content 文字列を持たせると、**噂の伝播で表現が変形した瞬間に「同じ話を二度聞いた」が判定できなくなる**。仕様同士が衝突する。したがって命題・記憶・信念を分離する。

```
claim    … 命題そのもの（正規形）。「プレイヤーが倉庫から物を盗んだ」
  ↑ 多対1
memory   … あるNPCが保持する claim のインスタンス。誰から・いつ・どれくらい確かに
  
belief   … (npc_id, claim_id) 単位で「今どちらを信じているか」
```

> ⚠ `current_belief_status` を `memory` に持たせてはならない。
> 同じ命題について記憶が3つある時点で破綻する。**信念は記憶単位ではなく命題単位。**

### 5.2 テーブル定義（最低限）

**claim**
```
world_id           UUID
id                 UUID
event_id           UUID NULL        -- 対応する実際の出来事（あれば）
subject_id         UUID             -- 誰についての話か（npc or player）
predicate          TEXT             -- 正規化された述語 'stole_from_warehouse'
object_ref         TEXT NULL
canonical_text     TEXT             -- 人間可読の正規形
embedding          VECTOR(512)      -- 正本。canonical_text から claim ごとに1回だけ生成
truth_value        BOOL NULL        -- ★ 神の視点。デモの答え合わせ用。NPCには不可視
created_at         TIMESTAMPTZ
PRIMARY KEY (world_id, id)
```

**claim_relation**（矛盾・補強の関係）
```
world_id           UUID
id                 UUID
claim_a            UUID
claim_b            UUID
relation           TEXT             -- 'mutually_exclusive' | 'supports'
PRIMARY KEY (world_id, id)
FOREIGN KEY (world_id, claim_a) REFERENCES claim(world_id, id)
FOREIGN KEY (world_id, claim_b) REFERENCES claim(world_id, id)
```

**memory**
```
world_id           UUID
id                 UUID
owner_npc_id       UUID
claim_id           UUID
source_type        TEXT             -- 'witnessed' | 'heard' | 'told_by_player' | 'inferred'
source_actor_id    UUID NULL        -- 不変の来歴。actor は npc / player 共通
source_memory_id   UUID NULL        -- どの記憶から伝播したか。不変
source_forgotten_at TIMESTAMPTZ NULL -- NPCが主観的に出所を思い出せない状態
witnessed_directly BOOL
confidence_at_acq  REAL             -- 取得時点の確信度（以後不変。減衰は読み取り時計算）
importance         REAL
emotional_weight   REAL             -- 恩・恐怖の強度。符号付き
emotion_type       TEXT             -- 'gratitude' | 'fear' | 'neutral' | ...
acquired_at        TIMESTAMPTZ
last_recalled_at   TIMESTAMPTZ
recall_count       INT
surface_text       TEXT             -- 伝播で変形した表層。claim_id は保たれる
embedding          VECTOR(512)      -- claim.embedding の索引用コピー。クライアント入力禁止
PRIMARY KEY (world_id, id)
FOREIGN KEY (world_id, claim_id) REFERENCES claim(world_id, id)
```

```sql
CREATE VECTOR INDEX memory_embedding_idx
ON memory (world_id, owner_npc_id, embedding vector_cosine_ops);
```

**belief**
```
world_id           UUID
npc_id             UUID
claim_id           UUID
status             TEXT             -- 'believed' | 'doubted' | 'rejected' | 'unknown'
score              REAL
last_evaluated_at  TIMESTAMPTZ
rationale_json     JSONB            -- 数値根拠・engine_version・生成/fallback mode
rationale_text     TEXT             -- 人間可読の説明
PRIMARY KEY (world_id, npc_id, claim_id)
```

**その他**: `world`（`simulated_at` を持つ）, `actor`, `npc`, `player`, `event`, `relationship`(npc→target の trust / affection / fear), `rumor_transfer`(source_memory_id, created_memory_id, from, to, claim_id, at, confidence_delta, distortion), `recall_event`, `conversation`, `action_log`

`rumor_transfer` は「誰から誰へ、どの命題が、いつ」を全部持つ。**可視化画面の伝播グラフはこのテーブルの素直な描画。**

全状態テーブルに `world_id` を持たせるだけでなく、PK / UNIQUE / FK も `(world_id, id)` の複合で拘束する。アプリ側の `WHERE world_id = ...` だけに依存してはならない。MCP 用 read-only role / view から `truth_value` と秘密列を隠し、`world_id` はクライアント入力ではなく署名済み HttpOnly セッションから解決する。

---

## 6. 想起（ここが審査軸1の得点源）

NPCが何か言う前に、必ず**自分の記憶を検索する**。SQLフィルタで全件舐めるのではなく、スコアで並べる。

```
recall_score(memory m, topic q) =
      w1 * cosine(m.embedding, embed(q))              -- ベクトル検索（CockroachDB Vector Index）
    * w2 * trust(owner, m.source_actor_id)            -- 情報源への信頼（直接目撃なら 1.0）
    * w3 * decayed_confidence(m, world.simulated_at)  -- §7
    * w4 * recency(m.acquired_at, world.simulated_at)
    * w5 * (1 + |m.emotional_weight|)                -- 強い感情は想起されやすい
```

重みはハードコードでよいが、**可視化画面で各項の値を表示できるようにすること**。これがそのまま説明ログになる。

想起は **MCP Server 経由**で実行する（§4 の要件充足）。

MCP では `(world_id, owner_npc_id)` を等価条件にして Vector Index で候補を多めに取得し、コード側で `claim_id` ごとにグループ化する。同一 claim の代表は `recall_score` 最大の memory とし、同じ source root の反復を `repeat_count`、独立 source root の数を `corroboration_count` として同時に集計する。検索 projection テーブルは作らない。

---

## 7. 減衰

> ⚠ **cron で全記憶に減衰値を書き込む実装は禁止。**
> 全件書き込みが走るうえ、審査員が触った時刻で結果が変わりデモの再現性が壊れる。

パラメータだけ保存して、**読み取り時に `world.simulated_at` を基準として計算**する。壁時計の `now()` をゲーム状態の計算に使ってはならない。`world.simulated_at` は「時間を進める」操作だけが更新する。

```
decayed_confidence(m, world.simulated_at) =
    m.confidence_at_acq
    * exp( -λ * effective_age(m, world.simulated_at) / (1 + m.importance + |m.emotional_weight|) )
    * (1 + βc * log(1 + corroboration_count(m))
         + βr * log(1 + min(repeat_count(m), REPEAT_CAP)))

effective_age = max(0, world.simulated_at - max(m.acquired_at, COALESCE(m.last_recalled_at, m.acquired_at)))
corroboration_count = 同じ claim_id の独立 provenance root の数
repeat_count = 同じ claim_id を同一 provenance root から得た回数
βr < βc とし、同一情報源の反復は独立証言ほど確信度を上げない
```

残りやすくなるもの（自動的にそうなる式にしてある）: 強い恩・強い恐怖（`emotional_weight` 大）、直接目撃した重大事件（`importance` 大）、独立した複数情報源から聞いた噂（corroboration 大）。同一情報源からの反復（repeat）は上限付きの弱い効果だけを持つ。

**記憶は削除しない。** 確信度と想起優先度が下がるだけ。

候補をMCPで読んだだけ、記憶一覧をUIで閲覧しただけ、health checkを実行しただけでは `last_recalled_at` / `recall_count` を更新しない。NPCの最終発話・行動の根拠として実際に採用した memory だけ、直接SQL経路で `(interaction_id, memory_id)` 一意の `recall_event` を冪等記録して更新する。

### 出所忘却（入れると効く・実装は数行）

`decayed_confidence` が閾値を割ったら、明示的な「時間を進める」処理の中で `memory.source_forgotten_at` を一度だけ設定する。`source_actor_id` / `source_memory_id` / `rumor_transfer` は監査用の不変来歴として絶対に削除・NULL化しない。

NPCの推論では `source_forgotten_at IS NOT NULL` を「内容は覚えているが誰から聞いたか思い出せない」と扱う。一方、説明・監査画面では元の来歴を追跡可能にする。

---

## 8. 矛盾処理

矛盾する claim を両方保持したまま、**belief で今どちらを採っているかだけを管理する**。片方を消さない。

裁定スコア（NPCごと・claim ごと）:

```
belief_score(npc, claim) =
      Σ over memories of this claim:
          trust(npc, m.source_actor_id) * decayed_confidence(m)
          * (witnessed_directly ? DIRECT_BONUS : 1.0)
          * recency_weight(m)
    + prior_bias(npc, claim.subject_id)     -- 対象への既存感情（恩があれば悪い噂を疑う）
```

`mutually_exclusive` で結ばれた claim 群の中で最高スコアが `believed`、僅差なら両方 `doubted`。

`status` は拮抗時を含め、固定閾値と tie epsilon を使うコードだけで決定する。僅差なら両方 `doubted` とし、Bedrock に状態変更を許可しない。

**Bedrock の使いどころ**: コードが確定した結論と機械可読な根拠から、NPCの台詞と人間可読な説明文だけを生成する。

---

## 9. 説明ログ（デモの主役）

`belief.rationale_json` と `belief.rationale_text` に、**なぜその結論に至ったか**を機械可読＋人間可読の両方で残す。

```json
{
  "conclusion": "believed",
  "score": 0.71,
  "against": 0.34,
  "repeat_count": 2,
  "corroboration_count": 1,
  "used_memories": [
    {"memory_id":"...", "source":"ゲン", "trust":0.8, "confidence":0.6,
     "witnessed":false, "contribution":0.48},
    {"memory_id":"...", "source":"ゲン", "trust":0.8, "confidence":0.4,
     "witnessed":false, "contribution":0.23, "note":"二度目の伝聞"}
  ],
  "text": "ミヨはゲンから同じ噂を二度聞いている。ただし独立情報源は1つとして評価した。"
}
```

**動画とデモ画面で最も長く映すのはこれ。** 綺麗なUIより優先。

---

## 10. 公開デモの世界分離（GPT原案に記述なし・必須）

永続化が売りのアプリなので、**世界が1個だと前の審査員の破壊がそのまま残る**。審査員Bは意味不明な状態を見ることになる。

**A: セッション毎に世界を fork** を採用する。初回の状態変更時に seed 付き初期状態を複製して `world_id` を発行し、botの閲覧だけでは世界を量産しない。「デモをリセット」は現世界を破壊せず、新しい fork を原子的に作る。

全状態テーブルのPK / UNIQUE / FKに `world_id` を通す。**最初から通すこと**（後付けは地獄）。

---

## 11. 工程（この順序を守る）

> ⚠ **原案の「データモデル→機能→デプロイ」順は禁止。**
> このプロジェクトで一番落ちやすいのは記憶ロジックではなく、
> 公開デモURL・CockroachDB Cloud 接続・MCP Server・Bedrock 権限。ここを最初に通す。

### Day 1–2: Walking Skeleton（これが通るまで機能を書かない）

- CockroachDB Cloud にクラスタ作成、`world_id` 付きの1テーブル
- 直接SQLで seed を1件 writeし、**MCP Server 経由**で同じ行を readできる
- Bedrock で1文生成が通る
- Next.js の1画面が **公開URLで** それを表示する
- ここまでを1本の疎通として README に手順化

### Day 3–5: メモリコア

- claim / memory / belief / relationship / rumor_transfer 実装
- 埋め込み生成 + Vector Index、想起スコア（§6）
- 減衰の読み取り時計算（§7）
- **UIなしでAPIとテストだけで動く状態にする**（龍ミミズ移植性の担保も兼ねる）

### Day 6–9: 伝播と裁定

- NPC間会話 → 噂伝播（確信度低下・表層変形・出所記録・信頼閾値で不採用）
- 矛盾裁定（§8）と `rationale` 生成（§9）

### Day 10–13: デモUI

- NPC一覧 / 記憶一覧 / 信頼グラフ / 伝播経路 / 矛盾ペア / 説明ログ
- プレイヤー操作（**4種で足りる**: 話しかける・助ける・情報を伝える・時間を進める）
- ワンクリックのデモシナリオ再生

### Day 14–16: 提出物

- 動画（先に絵コンテ。§13）
- README（クローンして起動できることを**別マシンで検証**）
- Devpost 提出フォーム、ツール用途の記述（§4の表を流用）

### Day 17–19: 予備

締切 8/19 06:00 JST に対して2日の余裕。**この余裕を機能追加で食わない。**

---

## 12. 完成条件（優先順位付き）

### 死守（欠けたら提出しない）

- [ ] CockroachDB 指定ツールを2つ、実行経路で使用している
- [ ] AWS サービスを1つ以上、実質的に使用している
- [ ] 記憶が CockroachDB に永続化され、再起動後に完全復元する
- [ ] NPCごとに異なる記憶を持ち、同じ事件に異なる結論を出す
- [ ] 噂の情報源が追跡できる（誰から誰へ）
- [ ] 矛盾する記憶を両方保持し、belief だけが切り替わる
- [ ] 説明ログが出る
- [ ] 公開デモURLが動く（世界分離済み）
- [ ] 3分未満の動画
- [ ] README だけでローカル起動できる

### あると強い

- [ ] 時間経過で弱い記憶だけ減衰する（強い恩・恐怖・直接目撃は残る）
- [ ] 出所忘却
- [ ] アーキテクチャ図

### 削ってよい（時間が足りなければ即切る）

- NPC 5人 → **3人でよい**（動画に映るのは3人）
- プレイヤー操作 8種 → 4種
- 凝った減衰式 → 単調減少＋例外保持が見えれば十分
- 見た目の作り込み → 最後。**説明ログの可読性の方が優先**

---

## 13. デモシナリオと動画

### シナリオ（ワンクリック再生）

1. プレイヤーがハナの畑仕事を助ける → ハナに恩の記憶
2. ゲンが「プレイヤーが倉庫から物を盗んだ」と誤解（claim A, `truth_value=false`）
3. ゲン → ミヨ に伝播（確信度低下・表層変形・source記録）
4. ミヨはゲンへの信頼が高く採用
5. ハナは恩の prior があるため同じ噂を `doubted`
6. 第三のNPCが「プレイヤーは倉庫を修理していた」と証言（claim B, `mutually_exclusive` with A）
7. NPCごとに異なる belief と発言が出る
8. 時間を進める → 弱い噂だけ減衰
9. リロード → 全部残っている

### 動画（3分未満）

> ⚠ **9ステップは3分に入らない。** 先に絵コンテを書くこと。

配分案:
- 0:00–0:20 何の基盤か（§2の一行。村の説明から入らない）
- 0:20–1:40 同じ事件に対する3人の違う発言 → **各発言の下に説明ログを開いて見せる**
- 1:40–2:20 伝播グラフと矛盾ペアの可視化
- 2:20–2:45 時間経過での減衰、リロードで復元
- 2:45–3:00 使用ツールとアーキテクチャ

---

## 14. テスト（「自動テストがある」だけでは不足）

固定 seed の決定論テストで以下を通す:

1. `decayed_confidence` が時間について単調減少すること
2. `importance` / `emotional_weight` が高い記憶は同時刻で有意に高く残ること（恩・恐怖・直接目撃）
3. 発話根拠として採用された想起だけ `last_recalled_at` が更新され、UI閲覧では更新されないこと
4. 信頼度が閾値以下の情報源からの噂が採用されないこと
5. `mutually_exclusive` な claim が**両方 memory に残り**、belief だけが切り替わること
6. 伝播で `surface_text` が変形しても `claim_id` が保たれ、repeat_count / corroboration_count が情報源の独立性どおりに増えること
7. プロセス再起動後、全 NPC の belief と relationship が完全一致で復元すること
8. デモシナリオ9ステップのゴールデンファイル比較
9. `world.simulated_at` が同一なら壁時計と実行時刻にかかわらず結果が一致すること
10. 別 `world_id` の行をPK/FK・MCP view・APIの各層から参照できないこと
11. `source_forgotten_at` 設定後も監査用 provenance を完全追跡できること
12. Bedrock障害とMCP障害を別々に注入し、前者だけテンプレ発話へfallback、後者は直接SQL readへ迂回しないこと

Bedrock 呼び出しはテストではモック。**スコア計算はコード側にあるので決定論でテストできる**（§8）。

---

## 15. 運用上の注意

- **Bedrock のコストとレイテンシ**: 審査員が触るたびにNPC全員分の生成が走る。発話キャッシュ（同一 belief 状態なら再利用）＋テンプレフォールバックを入れる
- **秘匿情報**: 公開リポジトリなので、接続文字列・APIキーは `.env.example` のみコミット
- **ホスティング**: フロントは Vercel でもよい（AWS要件はエージェント側で満たしている）。**リスクの低い方を選ぶこと。ただし選択理由を1行で報告**

---

## 16. 禁止事項

- 勝手に機能を増やす。完成条件（§12死守）が全部埋まるまで追加禁止
- §1 の大会情報を推測で上書きする。不明なものは「不明」と報告する
- 減衰を cron で書き込む（§7）
- `current_belief_status` を memory に持たせる（§5.1）
- テーマ・示唆・「情報の信頼性について考えさせられる」的なメッセージを画面に出す。**出来事と数値だけ出す**
- walking skeleton より先にデータモデルを完成させる（§11）

---

## 17. 追補（2026-07-30・規約全文の実確認を反映）

**§1の「未確認事項」はすべて解消。以下が確定事実。Claude が公式Rulesページで再検証済み。**

### 17.1 確定した規約事項

| 項目 | 確定内容 | 影響 |
|---|---|---|
| 審査配点 | **5軸は明示的に均等配点**（"equally weighted"）。各20% | §17.2 参照。戦略が変わる |
| 提出期間 | 2026-06-30 10:00 ET 開始 〜 08-18 17:00 EDT | 期間内の新規作成なら問題なし |
| 新規性 | **提出期間中の新規作成が必須**。FW・ライブラリ・テンプレ・AIコーディング支援は可。既存コードの組み込みは**開示義務** | 龍ミミズの既存コードを持ち込まない。**逆方向（ここ→龍ミミズ）は自由** |
| 言語 | **全提出物が英語**、または英訳の添付（動画・説明文・テスト手順・その他すべて） | §17.3 |
| ライセンス | **OSSライセンスファイル必須**（MIT または Apache 2.0 推奨）。リポジトリ上部で検出可能なこと | **最初のcommitで LICENSE を置く** |
| デプロイ | 規約原文 "uses CockroachDB as its persistent memory layer, **deployed on AWS**" | §15の「フロントは Vercel でもよい」を**撤回**。§17.4 |
| デモ公開 | 審査期間終了まで **無料かつ無制限**で利用可能にすること | §17.5。レート制限・ログイン壁は規約違反リスク |
| チーム | 最大5人 | 影響なし |
| 提出後変更 | 締切前は可、締切後は原則不可 | 予備日を使い切らない |

### 17.2 均等配点を受けた戦力配分（重要）

5軸が各20%。つまり **Production Readiness と Real-World Impact が、Agentic Memory Design と同じ重み**を持つ。

- 記憶モデルの作り込みは **20%が上限**。ここに時間を吸われすぎないこと
- **Production Readiness（20%）は最も安い得点源**。多くの参加作品がほぼ0点になる領域。テスト・エラーハンドリング・README・LICENSE・環境変数の扱い・落ちない公開デモ、で埋まる。§14 と §12 を軽視しない
- **Real-World Impact（20%）は §2 のフレーミング1個で大半が決まる**。「村のNPCが噂を流すゲーム」から説明を始めた時点で失点する

### 17.3 英語対応（原案のスケジュールに入っていなかった）

- README、Devpost説明文、テスト手順、アーキテクチャ図の注記：**英語で書く**
- 動画：英語ナレーションまたは英語字幕
- **NPCの台詞と村の世界観は日本語のままでよい**（英語字幕を付ける）。むしろ Creativity & Originality 側で効く
- **可視化UIのラベルと説明ログは英語**にする。審査員が読むのはここ
- §11 の Day 14–16 に「英語パス」を明示的なタスクとして積むこと

### 17.4 AWS デプロイ（§15を上書き）

規約が "deployed on AWS" と明記しているため、**フロントだけ Vercel は不可**。

- Next.js / API 実行基盤を AWS に置く（Amplify Hosting または Lambda + API Gateway。**権限を確認して最小構成を選ぶ**）
- 公開URL → AWS → Managed MCP → CockroachDB、および AWS → Bedrock の一気通貫疎通を Walking Skeleton で通す（§11 Day 1–2 の定義をこれに差し替え）

### 17.5 「無料・無制限」とコストの衝突

規約上、審査期間中のデモにレート制限・課金・ログイン壁をかけられない。一方 Bedrock は呼ばれた分だけ課金される。

**予算上限で機能が止まる設計は「デモでエラーが出る」に該当するので不可。** 必ず何かが返る二段構えにする。

1. 発話キャッシュ：同一の (npc, belief状態, topic) なら生成結果を再利用
2. テンプレートフォールバック：Bedrock が失敗・上限到達しても、**belief と説明ログから組み立てた定型文で必ず応答する**
3. デモシナリオの標準経路の発話は**事前生成してDBに焼いておく**（審査員の大半はワンクリック再生しか触らない）

なお、フォールバック時も**説明ログは常にフル表示**すること。説明ログは Bedrock に依存しない（スコアはコード側計算）。

### 17.6 着手前に必ず潰す未確認リスク（これが通らないと計画が崩れる）

> ⚠ **以下の3つは「アカウントが使えるか」より前の、機能提供の有無の問題。Day 1 の最初にここを確認すること。**

1. **CockroachDB Cloud のどのティアで `CREATE VECTOR INDEX` が使えるか。**
   無料/Basic で使えない場合、必須ツール#2 の計画が丸ごと崩れる。使えなければ代替は ccloud CLI か Agent Skills Repo（ただし審査軸への寄与は落ちる）
2. **Cloud Managed MCP Server がどのティアで提供されるか。** 同上。必須ツール#1 が崩れる
3. **Bedrock の対象モデルがリージョンで有効化されているか。** モデルアクセスは**リージョン単位で明示的な有効化申請が要る**場合がある。埋め込みモデルの**次元数を先に確定**すること（`VECTOR(N)` の N を後から変えるとインデックス再作成）

### 17.7 MCP の読み書き経路（設計を明示すること）

Managed MCP Server が `select_query` / `insert_rows` 中心である場合、**UPDATE 系（belief の更新、`last_recalled_at`、出所忘却）は MCP を通らない**。

したがって:

- **読み取り（想起）＝ MCP 経由**。ここが「エージェントが自分の記憶を検索する」実行経路であり、要件充足の本体
- **書き込み更新 ＝ 直接接続**。これは正当。ただし提出フォームでは**この二経路構成を正直に記述する**こと（「全通信がMCP」と書かない）
- 検証では test 環境に invalid endpoint / key を注入し、MCP障害時に live 想起が失敗または明示的に stale/degraded となり、直接SQL readへ迂回しないことを確認する。Bedrock障害時だけ決定論テンプレートで発話を継続する

### 17.8 §17.6 調査結果の受領と補正（2026-07-30）

**3件とも計画成立を確認。以下だけ補正する。**

**A. Vector Index の構文は正しい。クラスタ設定は実測して、false の場合だけ変更する。**
公式ドキュメントで確認済み：opclass のインライン記述、prefix列、複数prefix列、いずれも報告どおり。既定は **L2** なので `vector_cosine_ops` の明示は必須（報告どおり）。

v25.4以降は `feature.vector_index.enabled` が既定 `true` だが、実クラスタを推測で扱わない。Day 1 の最初に実測し、false の場合だけ変更可否を確認する：

```sql
SHOW CLUSTER SETTING feature.vector_index.enabled;
SELECT version();
```

また **Basic はバージョンを選べない**（マネージド更新）。「v25.4以上を選ぶ」は操作ではなく**確認項目**として扱う。ここが v25.4 未満だった場合のみ、ティア変更か代替ツールの判断に入る。

**B. prefix列は `(world_id, owner_npc_id, embedding)` にする。**
複数prefix列が使えることを確認した。想起は常に「ある世界の、あるNPCの記憶」なので、`owner_npc_id` までインデックスで絞る方が正しい。

```sql
VECTOR INDEX claim_embedding_idx (world_id, owner_npc_id, embedding vector_cosine_ops)
```
（memory 側に埋め込みを持たせるか claim 側に持たせるかで所属テーブルが変わる。NPCごとに絞るなら memory 側に非正規化して持つ方が素直。**どちらを採るか報告すること**）

**C. リージョンは `us-east-1` に変更する。**
根拠は審査規約の時刻表記や審査員所在地の推測ではなく、Nova Lite / Titan Text Embeddings V2 の可用性と、AWS・CockroachDBを同一リージョンへ寄せられること。

さらに重要な点として、**CockroachDB Cloud クラスタのリージョンと AWS のリージョンを揃えること**。MCP 経由の想起はデモ操作のたびに往復するので、ここがずれると体感速度に直撃する。両方 us-east-1 で揃える。

**D. Nova Lite の日本語出力を Day 1 に実測する。**
§17.3 で NPC の台詞は日本語のままにする方針だが、Nova Lite の日本語品質は未検証。**実際のNPC台詞1本を生成して品質を確認**し、

- 十分 → 日本語台詞＋英語字幕（Creativity 側で有利）
- 不十分 → 台詞も英語にする（審査員が直接読めるので実害は小さい）か、Bedrock 上の別モデルに替える

を決めて報告すること。なお「Amazonのモデルはモデルアクセス申請が不要」という補正は **Amazon製モデル（Titan / Nova）を選んだから成立している**。Claude 等に替える場合、**モデルアクセス有効化の手順が復活する**ので注意。

**E. 未決の着手ブロッカー：AWS ホスティング先。**
Amplify Hosting か Lambda + API Gateway か、**Walking Skeleton を書き始める前に1つ選んで理由を1行で報告**すること。ここが決まらないと Day 1 が進まない。

**F. 最初の commit に `LICENSE`（MIT または Apache 2.0）を入れる。**
規約でリポジトリ上部から検出可能であることが求められている。後回しにしない。

### 17.9 A/E 報告の受領（2026-07-30）

**E（Amplify Hosting）承認。** Secrets Manager を production branch 専用の SSR Compute Role から読む設計も採用。ビルド環境変数に焼かない判断は正しい（Production Readiness = 20% の得点源でもある）。

**A はブロック解除待ちで正しい対応。** 認証は発注者が行う。

以下だけ追加で確定させる。

**G. 埋め込みは `claim.canonical_text` から生成する。`surface_text` から生成してはならない。**
memory 側への非正規化は承認する。ただし埋め込みの生成元は **claim の正規形**であり、伝播で変形した `surface_text` ではない。

> ⚠ これは意図的な設計であって最適化漏れではない。**表現が変形しても命題IDと埋め込みが保たれることが、repeat_count / 独立情報源の corroboration_count / 矛盾検出の前提**。後から「変形も埋め込みに反映した方が精度が上がる」と改善してはならない。改善した瞬間に §5.1 の設計が壊れる。

**H. 埋め込みは claim ごとに1回だけ生成し、memory 行にはコピーする。**
同じ claim を5人が持てば同一ベクトルが5本になる。Bedrock を5回呼ばないこと。`claim` に正本を持ち、memory 行には複製を書く（prefix 索引のための非正規化なので複製で正しい）。

**I. Amplify SSR Compute の応答時間とコールドスタートを設計に織り込む。**
Amplify の SSR は Lambda ベース。以下2点がデモの第一印象に直撃する。

- **NPC全員分の発話を1リクエストで直列生成しない。** NPC単位の短い非ストリーム処理に分割するか、事前生成する。Amplify Hosting は Next.js streaming 非対応なので採用しない
- **審査員の散発的な利用ではコールドスタートが起こりうる**。§17.5 の事前生成（デモシナリオの標準経路の発話をDBに焼く）は、コスト対策であると同時に**この対策**でもある。優先度を上げる

**J. 課金アラートを最初に設定する。**
デモは審査期間中「無料かつ無制限」で公開する義務がある（§17.5）＝**こちらの課金は青天井方向にしか動かない**。Amplify・Bedrock・CockroachDB の3つとも課金対象になりうる。

- AWS Budgets でアラートを設定してから Walking Skeleton に入る
- **ただしアラートで機能を止めないこと**（止まるとデモが落ちて規約違反）。アラートは通知のみ、防御は §17.5 のキャッシュと事前生成で行う

**K. Lambda / S3 は §4 から落としてよい。**
Amplify + Bedrock で AWS 要件（最低1つ）は満たされる。使わないものを「使った」と書かない。提出フォームには実際に使ったものだけ記載する。

**L. 埋め込み次元は `512` に確定し、凍結する。**

Titan Text Embeddings V2 の1024次元は物理的に不可能ではない。浮動小数を6桁程度へ丸めれば、Managed MCP のSQL 16,384文字制限内へ収められる。ただし本仕様では **10KiB応答制限、SQL本文・条件・将来の列追加に対する余裕、インデックス再作成回避**を優先し、`VECTOR(512)` を最終決定とする。後から「丸めれば1024も使える」という理由で蒸し返さない。

- query embedding は有限値・512要素を検証する
- MCPへ渡すSQL全文が16,384文字未満であることをunit testする
- MCP応答にはembedding列を含めず、必要最小限の候補列だけ返す
- 日本語query→日本語claimの関連順位はDay 1に実モデルで検証する

**M. Amplifyからの直接SQL接続のためにNAT Gatewayを構築しない。**

Basicクラスタへの直接SQLは public endpoint + TLS証明書検証 + 専用SQL userの最小権限 + Secrets Managerで担保する。固定送信元IPのためのNAT Gatewayは、この予算と日程では採用しない。READMEに「デモ環境ではネットワーク認可を広く取り、認証・TLS・秘密管理で担保している」とトレードオフを明記し、本番推奨との差を隠さない。

MCPのservice account API keyは対象クラスタだけに権限を付与し、`mcp-cluster-id` headerでも単一クラスタへ固定する。公開クライアントへDB接続情報・MCP keyを渡してはならない。

**N. MCP用read経路から神の視点を遮蔽する。**

MCPは専用read-only role / viewを使用し、`truth_value`、秘密列、他worldのデータを読めないこと。モデルに自由SQLを生成させず、サーバ側の固定SQLテンプレートへ検証済み `world_id` / `owner_npc_id` / query vector / LIMITだけを渡す。

**O. Aの実測完了条件を拡張する。**

以下がすべて証拠付きで通るまでAを完了扱いにしない。

1. cluster plan / region、`SELECT version()`、`SHOW CLUSTER SETTING feature.vector_index.enabled`
2. `VECTOR(512)` テーブルと `(world_id, owner_npc_id, embedding vector_cosine_ops)` indexの実作成
3. optimizerがVector Indexを選べるだけの検証行投入
4. 本番同型のprefix付き cosine queryを実行
5. Managed MCP `explain_query` に `vector search`、対象index、両prefixの利用が現れる
6. Managed MCP `select_query` で同じ検索が成功する

tiny datasetでfull scanになった場合は「Vector Indexを使用した」と主張しない。検証用worldへ十分なsynthetic行をseedし、製品と同一schema・queryで使用を証明する。

**P. 最終仕様凍結。**

2026-07-30の本監査反映を最後の机上仕様変更とする。以降は実装中の実物・実環境・テスト結果が仕様を反証した場合だけ変更し、変更時は反証証拠と影響範囲を同じcommitに記録する。P1以下の机上改善を理由にWalking Skeletonを遅らせない。

---

## 18. 報告フォーマット

各工程の終わりに、これだけを報告する。

```
■ 変更したファイル
■ 実装した機能
■ 実行したテストとその結果（通った/落ちた件数と落ちた理由）
■ 未解決の問題
■ 次に実装する項目
■ §4 要件充足マトリクスの現在の状態
```

**着手前に、まず §1 の未確認事項の確認結果と、§4 の充足計画を報告すること。**
コードはその後。
