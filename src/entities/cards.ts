// PORTFALL, the crew's card game. Pure module: a deck derives
// from a hash of the run seed and the member id, and a match
// resolves from two decks, a table condition, and a draw source.
// No state lives here, and no existing stream is touched.

export type Suit = "helm" | "forge" | "leaf" | "coin";
export type CardEffect = "anchor" | "surge";

export interface GameCard {
  suit: Suit;
  power: number;
  effect?: CardEffect;
}

export const SUITS: readonly Suit[] = ["helm", "forge", "leaf", "coin"];

/** Plain-card powers in every starter deck: the same ladder for
 *  everyone, so no one starts rich. Anchor (4) and Surge (3)
 *  ride along, for a deck of twelve totalling 52. */
const PLAIN_POWERS: readonly number[] = [7, 6, 6, 5, 5, 4, 4, 3, 3, 2];
const ANCHOR_POWER = 4;
const SURGE_POWER = 3;

/** FNV-1a over the key, then xorshift32: a tiny deterministic
 *  sequence for deck building that draws on no sim stream. */
function hashSequence(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function shuffledBy<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/**
 * The starter deck a crew member carries: twelve cards, three of
 * each suit, the shared power ladder, one Anchor and one Surge.
 * Which suits hold the power is the member's own, dealt by the
 * hash of seed and id, so decks differ without anyone starting
 * ahead and no two runs of the same seed ever disagree.
 */
export function starterDeck(seed: number | string, memberId: string): GameCard[] {
  const next = hashSequence(`portfall:${String(seed)}:${memberId}`);
  const suits = shuffledBy(
    SUITS.flatMap((suit) => [suit, suit, suit]),
    next,
  );
  const cards: GameCard[] = PLAIN_POWERS.map((power, i) => ({
    suit: suits[i] as Suit,
    power,
  }));
  cards.push({ suit: suits[10] as Suit, power: ANCHOR_POWER, effect: "anchor" });
  cards.push({ suit: suits[11] as Suit, power: SURGE_POWER, effect: "surge" });
  return shuffledBy(cards, next);
}

/** The table condition: the suit the room itself favours. In
 *  port the market rules (coin); under way the weather does. */
export function conditionFor(inPort: boolean, weatherName: string): Suit {
  if (inPort) return "coin";
  if (weatherName === "solar wind") return "helm";
  if (weatherName === "radiation storm") return "forge";
  return "leaf";
}

export interface RunResult {
  a: GameCard;
  b: GameCard;
  aEff: number;
  bEff: number;
  /** Who took the run; null when it burned (a tie with no Anchor). */
  point: "a" | "b" | null;
}

export interface MatchResult {
  runs: RunResult[];
  scoreA: number;
  scoreB: number;
  winner: "a" | "b" | null;
  condition: Suit;
}

const REGULATION_RUNS = 5;

/** Effective power of a card in a run: face value, +1 when its
 *  suit matches the table condition, +2 for a Surge played
 *  while its side trails on runs. */
function effective(
  card: GameCard,
  condition: Suit,
  mine: number,
  theirs: number,
): number {
  let value = card.power;
  if (card.suit === condition) value += 1;
  if (card.effect === "surge" && mine < theirs) value += 2;
  return value;
}

/**
 * Play a match: both decks shuffled on the caller's draw source,
 * five regulation runs, then sudden-death runs from what is
 * left until someone takes one. A tie burns the run unless
 * exactly one card is an Anchor, which holds the table and
 * takes it. Winner is null only when the decks run out level,
 * which honest starter decks make vanishingly rare.
 */
export function playMatch(
  deckA: readonly GameCard[],
  deckB: readonly GameCard[],
  condition: Suit,
  int: (n: number) => number,
): MatchResult {
  const shuffle = (deck: readonly GameCard[]): GameCard[] => {
    const out = [...deck];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = out[i] as GameCard;
      out[i] = out[j] as GameCard;
      out[j] = tmp;
    }
    return out;
  };
  const handA = shuffle(deckA);
  const handB = shuffle(deckB);
  const runs: RunResult[] = [];
  let scoreA = 0;
  let scoreB = 0;
  const limit = Math.min(handA.length, handB.length);
  for (let i = 0; i < limit; i++) {
    const a = handA[i] as GameCard;
    const b = handB[i] as GameCard;
    const aEff = effective(a, condition, scoreA, scoreB);
    const bEff = effective(b, condition, scoreB, scoreA);
    let point: "a" | "b" | null = null;
    if (aEff > bEff) point = "a";
    else if (bEff > aEff) point = "b";
    else if (a.effect === "anchor" && b.effect !== "anchor") point = "a";
    else if (b.effect === "anchor" && a.effect !== "anchor") point = "b";
    if (point === "a") scoreA++;
    else if (point === "b") scoreB++;
    runs.push({ a, b, aEff, bEff, point });
    if (i + 1 >= REGULATION_RUNS && scoreA !== scoreB) break;
  }
  return {
    runs,
    scoreA,
    scoreB,
    winner: scoreA > scoreB ? "a" : scoreB > scoreA ? "b" : null,
    condition,
  };
}
