/**
 * What a villager actually says.
 *
 * The line is assembled from the verdict, never the other way round. A model
 * may reword it — see scripts/pregenerate-lines.mjs — but it cannot change what
 * the villager thinks, and if no model line is available the template below
 * still says the right thing. That ordering is why the demo cannot be broken by
 * a quota.
 *
 * Deterministic: the same belief always produces the same sentence, so a
 * replayed scenario reads identically.
 */

import { hashSeed } from "./propagation";

export type UtteranceMode = "bedrock" | "template";

export interface UtteranceInput {
  villagerJa: string;
  villagerEn: string;
  status: string;
  /** How the villager came by it: an informant's name, or null if they saw it. */
  sourceJa: string | null;
  /** The same informant, for the English rendering. Subtitles read badly with
   *  a name in a script the reader cannot pronounce. */
  sourceEn: string | null;
  /** The wording they hold, already worn down by however many retellings. */
  surfaceJa: string;
  claimEn: string;
  /** Signed: positive for warmth toward the subject, negative for suspicion. */
  emotionalWeight: number;
}

export interface Utterance {
  ja: string;
  en: string;
  mode: UtteranceMode;
}

const BELIEVED_WITNESSED = [
  "この目で見たんだ。{claim}",
  "見間違いじゃない。{claim}",
];

const BELIEVED_HEARD = [
  "{source}から聞いた。{claim}",
  "{source}がそう言ってた。おれはそう思ってるよ。",
];

const DOUBTED = [
  "{claim}……とは聞いたが、どうだかね。",
  "そういう話もあるが、決めつけたかないね。",
];

const REJECTED_WITH_REASON = [
  "そりゃ違うよ。{claim}なんて話は、あたしは信じない。",
  "その話は違う。あたしの見たものとは合わない。",
];

const UNKNOWN = [
  "昔そんな話を聞いた気もするが、もう覚えちゃいないね。",
  "さて……なんだったかね。忘れちまったよ。",
];

function pick(options: string[], seed: number): string {
  return options[seed % options.length];
}

/**
 * A line for one villager on one proposition.
 *
 * Falls back rather than fails: an unrecognised status still produces
 * something a person could have said, because the alternative on a public demo
 * is a blank speech bubble.
 */
export function templateLine(input: UtteranceInput): Utterance {
  const seed = hashSeed(input.villagerEn, input.claimEn, input.status);
  const claim = input.surfaceJa.replace(/[。．]$/, "") + "。";

  let ja: string;
  switch (input.status) {
    case "believed":
      ja = input.sourceJa
        ? pick(BELIEVED_HEARD, seed)
        : pick(BELIEVED_WITNESSED, seed);
      break;
    case "doubted":
      ja = pick(DOUBTED, seed);
      break;
    case "rejected":
      ja = pick(REJECTED_WITH_REASON, seed);
      break;
    default:
      ja = pick(UNKNOWN, seed);
      break;
  }

  ja = ja.replace("{claim}", claim).replace("{source}", input.sourceJa ?? "誰か");

  return { ja, en: englishGloss(input), mode: "template" };
}

/**
 * A plain English rendering, for judges who do not read Japanese.
 *
 * Not a translation of the Japanese line -- it states the same position in the
 * register a subtitle would use, which is what the rules' English requirement
 * is actually asking for.
 */
function englishGloss(input: UtteranceInput): string {
  const source = input.sourceEn ?? input.sourceJa;
  const heard = source ? `heard from ${source}` : "saw it myself";

  switch (input.status) {
    case "believed":
      return source
        ? `I heard it from ${source}, and I believe it: ${input.claimEn}`
        : `I saw it with my own eyes. ${input.claimEn}`;
    case "doubted":
      return `I have heard it — ${input.claimEn} — but I would not swear to it. (${heard})`;
    case "rejected":
      return `That is not what happened. I do not believe it: ${input.claimEn}`;
    default:
      return `I think someone told me about that once. I no longer remember.`;
  }
}
