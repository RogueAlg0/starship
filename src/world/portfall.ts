// PORTFALL, slice 2: the game leaves the mess table and starts
// collecting. Slice 1 kept every deck derived and stateless; this
// module owns the first persistent card state in the game: the
// cards a crew member has actually pulled at ports, the stamps
// and prior owners those cards carry, and the league table the
// mess keeps from match results.
//
// The starter deck is still exactly the derived deck in
// entities/cards.ts. A collection here holds only acquired cards.
// A match fields twelve from the combined holding: strongest
// first, ties by acquisition order with the starter cards first.
// Packets and trades run once per port stay, on the "portfall"
// stream, so the match, sector, and society streams do not move.

import type { World } from "../engine/engine.ts";
import type { Rng } from "../engine/rng.ts";
import {
  starterDeck,
  SUITS,
  type GameCard,
  type Suit,
} from "../entities/cards.ts";
import type { CrewMember } from "../entities/crew.ts";
import { trustOf } from "../perception/beliefs.ts";
import { relationshipLabel } from "../perception/labels.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Port, Sector, Voyage } from "./galaxy.ts";
import type { SectorState } from "./sector.ts";

/** A card pulled at a port: a game card plus its provenance. */
export interface PortfallCard extends GameCard {
  /** Port index the card was pulled at. */
  originPort: number;
  /** Port name at acquisition; ports do not move, so this is stable. */
  originName: string;
  /** Controlling faction name at acquisition, or "Free port". */
  factionName: string;
  /** The stamp printed on the card: the port's name. */
  stamp: string;
  acquiredTick: number;
  /** Global acquisition order, for fielding ties and display. */
  acquiredOrder: number;
  /** Prior crew holders, in order. The current holder is the
   *  collection key, so they are not listed here. */
  owners: string[];
}

export interface LeagueEntry {
  w: number;
  l: number;
  d: number;
  points: number;
}

export interface PortfallState {
  /** Acquired cards per crew id. Starter cards are never stored. */
  collections: Record<string, PortfallCard[]>;
  /** The mess league: one entry per crew id. */
  league: Record<string, LeagueEntry>;
  /** Stay indices whose packet-and-trade phase has already run. */
  packetStays: Set<number>;
  /** `${stayIndex}:${a}:${b}` keys for pairs that already traded
   *  during that stay (pair ids sorted). */
  tradedPairs: Set<string>;
  /** Next global acquisition order to hand out. */
  nextOrder: number;
  matches: number;
  packets: number;
  trades: number;
}

function blankLeague(): LeagueEntry {
  return { w: 0, l: 0, d: 0, points: 0 };
}

/** Create the empty PORTFALL state: no draws, fixed shape. */
export function createPortfallState(
  crew: readonly CrewMember[],
): PortfallState {
  const collections: Record<string, PortfallCard[]> = {};
  const league: Record<string, LeagueEntry> = {};
  for (const member of crew) {
    collections[member.id] = [];
    league[member.id] = blankLeague();
  }
  return {
    collections,
    league,
    packetStays: new Set(),
    tradedPairs: new Set(),
    nextOrder: 0,
    matches: 0,
    packets: 0,
    trades: 0,
  };
}

/** The league entry a crew id reads by, blank for a stranger. */
export function leagueEntry(
  state: PortfallState,
  memberId: string,
): LeagueEntry {
  return state.league[memberId] ?? blankLeague();
}

function leagueEntryForWrite(
  state: PortfallState,
  memberId: string,
): LeagueEntry {
  const existing = state.league[memberId];
  if (existing !== undefined) return existing;
  const entry = blankLeague();
  state.league[memberId] = entry;
  return entry;
}

/** Acquired cards a member holds, in acquisition order. */
export function acquiredCards(
  state: PortfallState,
  memberId: string,
): readonly PortfallCard[] {
  return [...(state.collections[memberId] ?? [])].sort(
    (a, b) => a.acquiredOrder - b.acquiredOrder,
  );
}

interface FieldCandidate {
  card: GameCard;
  acquired: boolean;
  order: number;
}

/**
 * The twelve cards a member fields: the strongest twelve of the
 * starter deck plus their acquired cards, ties broken by
 * acquisition order with starter cards first. Selection never
 * reorders the holding itself: with no acquired cards this is
 * exactly starterDeck(seed, memberId), in starter order.
 */
export function fieldDeck(
  state: PortfallState,
  seed: number | string,
  memberId: string,
): GameCard[] {
  const candidates: FieldCandidate[] = starterDeck(seed, memberId).map(
    (card, index) => ({ card, acquired: false, order: index }),
  );
  for (const card of state.collections[memberId] ?? []) {
    candidates.push({ card, acquired: true, order: card.acquiredOrder });
  }
  const chosen = new Set(
    [...candidates]
      .sort(
        (a, b) =>
          b.card.power - a.card.power ||
          Number(a.acquired) - Number(b.acquired) ||
          a.order - b.order,
      )
      .slice(0, 12),
  );
  return candidates.filter((c) => chosen.has(c)).map((c) => c.card);
}

/** Record one finished match in the league table. */
export function recordPortfallMatch(
  state: PortfallState,
  aId: string,
  bId: string,
  winnerId: string,
): void {
  const a = leagueEntryForWrite(state, aId);
  const b = leagueEntryForWrite(state, bId);
  state.matches++;
  if (winnerId === "") {
    a.d++;
    b.d++;
    a.points += CONFIG.portfall.leagueDrawPoints;
    b.points += CONFIG.portfall.leagueDrawPoints;
  } else if (winnerId === aId) {
    a.w++;
    b.l++;
    a.points += CONFIG.portfall.leagueWinPoints;
  } else if (winnerId === bId) {
    b.w++;
    a.l++;
    b.points += CONFIG.portfall.leagueWinPoints;
  }
}

/** One-based league rank of a member: points, then wins, then
 *  draws, then roster order. Zero for someone not on the roster. */
export function leagueRank(
  state: PortfallState,
  crew: readonly CrewMember[],
  memberId: string,
): number {
  const order = crew
    .map((member, index) => ({ member, index }))
    .sort((x, y) => {
      const a = leagueEntry(state, x.member.id);
      const b = leagueEntry(state, y.member.id);
      return (
        b.points - a.points ||
        b.w - a.w ||
        b.d - a.d ||
        x.index - y.index
      );
    });
  const at = order.findIndex((entry) => entry.member.id === memberId);
  return at < 0 ? 0 : at + 1;
}

function activeAboard(member: CrewMember, tick: number): boolean {
  return (
    !member.dead &&
    !member.leftShip &&
    !member.ashore &&
    tick >= member.confinedUntil
  );
}

function shuffledByRng<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Suit weights for a port's packets: the controlling faction's
 *  kind and temperament, bent again by the port's character. */
function suitWeights(sector: Sector, port: Port): Record<Suit, number> {
  const weights: Record<Suit, number> = {
    helm: 1,
    forge: 1,
    leaf: 1,
    coin: 1,
  };
  const add = (suit: Suit, amount: number): void => {
    weights[suit] += amount;
  };
  const faction = sector.factionOf(port);
  if (faction !== null) {
    switch (faction.kind) {
      case "combine":
        add("helm", 1);
        add("forge", 1);
        break;
      case "syndicate":
      case "cartel":
        add("coin", 2);
        break;
      case "order":
        add("leaf", 1);
        add("helm", 1);
        break;
      case "church":
        add("leaf", 2);
        break;
      case "league":
        add("helm", 1);
        add("coin", 1);
        break;
      case "company":
        add("coin", 2);
        add("forge", 1);
        break;
      case "communion":
        add("leaf", 1);
        add("coin", 1);
        break;
      default:
        break;
    }
    switch (faction.temperament) {
      case "greedy":
      case "generous":
      case "jealous":
        add("coin", 1);
        break;
      case "martial":
        add("forge", 1);
        add("helm", 1);
        break;
      case "curious":
      case "proud":
        add("helm", 1);
        break;
      case "pious":
      case "insular":
      case "patient":
        add("leaf", 1);
        break;
      case "weary":
        add("forge", 1);
        break;
      default:
        break;
    }
  }
  switch (port.character) {
    case "industrial":
    case "refinery":
      add("forge", 1);
      break;
    case "agrarian":
    case "shrine":
      add("leaf", 2);
      break;
    case "free port":
    case "company town":
      add("coin", 2);
      break;
    case "shipyard":
      add("forge", 2);
      add("helm", 1);
      break;
    case "listening post":
      add("helm", 2);
      break;
    default:
      break;
  }
  return weights;
}

function pickSuit(rng: Rng, weights: Record<Suit, number>): Suit {
  const total = SUITS.reduce((sum, suit) => sum + weights[suit], 0);
  let roll = rng.next() * total;
  for (const suit of SUITS) {
    roll -= weights[suit];
    if (roll < 0) return suit;
  }
  return SUITS[SUITS.length - 1] as Suit;
}

function plainPower(rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.12) return 2;
  if (roll < 0.34) return 3;
  if (roll < 0.6) return 4;
  if (roll < 0.82) return 5;
  if (roll < 0.95) return 6;
  return 7;
}

function drawPacketCard(
  w: World,
  state: PortfallState,
  port: Port,
  factionName: string,
  weights: Record<Suit, number>,
): PortfallCard {
  const rng = w.rng.get("portfall");
  const suit = pickSuit(rng, weights);
  const effectRoll = rng.next();
  let power: number;
  let effect: PortfallCard["effect"];
  if (effectRoll < 0.06) {
    power = 4;
    effect = "anchor";
  } else if (effectRoll < 0.13) {
    power = 3;
    effect = "surge";
  } else {
    power = plainPower(rng);
    effect = undefined;
  }
  const card: PortfallCard = {
    suit,
    power,
    originPort: port.index,
    originName: port.name,
    factionName,
    stamp: port.name,
    acquiredTick: w.tick,
    acquiredOrder: state.nextOrder++,
    owners: [],
  };
  if (effect !== undefined) card.effect = effect;
  return card;
}

function serializeCard(card: PortfallCard): Record<string, unknown> {
  return {
    suit: card.suit,
    power: card.power,
    effect: card.effect ?? "",
    stamp: card.stamp,
    originPort: card.originPort,
    originName: card.originName,
    faction: card.factionName,
    owners: [...card.owners],
  };
}

function pairKey(stayIndex: number, aId: string, bId: string): string {
  const [first, second] = [aId, bId].sort();
  return `${stayIndex}:${first}:${second}`;
}

/** The relational price of a trade: friends trade, confidants
 *  trade, feuds never do. The number is the friend bar the
 *  labels derivation already reads (mutual trust at 0.2). */
export function canTrade(
  state: PortfallState,
  a: CrewMember,
  b: CrewMember,
  crew: readonly CrewMember[],
  stayIndex: number,
): boolean {
  if (a === b) return false;
  if (state.tradedPairs.has(pairKey(stayIndex, a.id, b.id))) return false;
  if (a.beliefs.grudges.includes(b.id)) return false;
  if (b.beliefs.grudges.includes(a.id)) return false;
  const labelAB = relationshipLabel(a, b, crew);
  const labelBA = relationshipLabel(b, a, crew);
  if (labelAB === "feud" || labelBA === "feud") return false;
  if (labelAB === "confidant" || labelBA === "confidant") return true;
  return (
    trustOf(a.beliefs, b.id) >= CONFIG.portfall.tradeTrust &&
    trustOf(b.beliefs, a.id) >= CONFIG.portfall.tradeTrust
  );
}

/** The card a member would part with: a spare outside the
 *  fielded twelve if they have one, else their weakest pull. */
function spareCard(
  state: PortfallState,
  seed: number | string,
  member: CrewMember,
): PortfallCard | null {
  const held = state.collections[member.id] ?? [];
  if (held.length === 0) return null;
  const fielded = new Set<GameCard>(fieldDeck(state, seed, member.id));
  const spares = held.filter((card) => !fielded.has(card));
  const pool = spares.length > 0 ? spares : held;
  let worst = pool[0] as PortfallCard;
  for (const card of pool) {
    if (
      card.power < worst.power ||
      (card.power === worst.power && card.acquiredOrder < worst.acquiredOrder)
    ) {
      worst = card;
    }
  }
  return worst;
}

function performTrades(
  w: World,
  state: PortfallState,
  crew: readonly CrewMember[],
  portName: string,
  stayIndex: number,
): void {
  const rng = w.rng.get("portfall");
  const aboard = crew.filter(
    (member) =>
      activeAboard(member, w.tick) &&
      (state.collections[member.id] ?? []).length > 0,
  );
  const pairs: Array<[CrewMember, CrewMember]> = [];
  for (let i = 0; i < aboard.length; i++) {
    for (let j = i + 1; j < aboard.length; j++) {
      pairs.push([aboard[i] as CrewMember, aboard[j] as CrewMember]);
    }
  }
  let done = 0;
  for (const [a, b] of shuffledByRng(rng, pairs)) {
    if (done >= CONFIG.portfall.tradesPerStay) break;
    if (!canTrade(state, a, b, crew, stayIndex)) continue;
    const cardA = spareCard(state, w.config.seed, a);
    const cardB = spareCard(state, w.config.seed, b);
    if (cardA === null || cardB === null || cardA === cardB) continue;
    const aHeld = state.collections[a.id] as PortfallCard[];
    const bHeld = state.collections[b.id] as PortfallCard[];
    aHeld.splice(aHeld.indexOf(cardA), 1);
    bHeld.splice(bHeld.indexOf(cardB), 1);
    cardA.owners.push(a.id);
    cardB.owners.push(b.id);
    bHeld.push(cardA);
    aHeld.push(cardB);
    state.tradedPairs.add(pairKey(stayIndex, a.id, b.id));
    state.trades++;
    done++;
    w.emit("portfall_trade", [a.id, b.id], {
      port: portName,
      stayIndex,
      a: a.id,
      b: b.id,
      aCard: serializeCard(cardA),
      bCard: serializeCard(cardB),
    });
  }
}

/**
 * The PORTFALL system: once per port stay, on the arrival phase,
 * the regulars open their packets and the table trades. Sector
 * conditions bend the packet the way they bend everything at a
 * port: a shortage thins it, a boom fattens it, and under unrest
 * it may never come down the gangway at all.
 */
export function stepPortfall(
  w: World,
  state: PortfallState,
  crew: readonly CrewMember[],
  galaxy: { sector: Sector; voyage: Voyage; sectorState: SectorState },
): void {
  const { sector, voyage, sectorState } = galaxy;
  const stay = voyage.stayAt(w.tick);
  if (stay === null) return;
  if (state.packetStays.has(stay.index)) return;
  state.packetStays.add(stay.index);

  const port = sector.portAt(stay.port);
  const faction = sector.factionOf(port);
  const factionName = faction?.name ?? "Free port";
  const condition = sectorState.conditions[port.index] ?? null;
  const conditionState =
    condition !== null && condition.phase === "active" ? condition.state : "";
  const rng = w.rng.get("portfall");
  const cfg = CONFIG.portfall;

  const unrestSkips =
    conditionState === "unrest" && rng.chance(cfg.unrestSkipChance);
  if (!unrestSkips) {
    const packetSize =
      conditionState === "shortage"
        ? cfg.shortageCards
        : conditionState === "boom"
          ? cfg.boomCards
          : cfg.packetCards;
    const aboard = crew.filter((member) => activeAboard(member, w.tick));
    const regulars = aboard.filter((member) => {
      const entry = leagueEntry(state, member.id);
      return entry.w + entry.l + entry.d > 0;
    });
    const pool = regulars.length >= cfg.packetMinPlayers ? regulars : aboard;
    if (pool.length > 0) {
      const count = Math.min(
        pool.length,
        cfg.packetMinPlayers +
          rng.int(cfg.packetMaxPlayers - cfg.packetMinPlayers + 1),
      );
      const recipients = shuffledByRng(rng, pool).slice(0, count);
      const weights = suitWeights(sector, port);
      const cardsBy: Array<Record<string, unknown>> = [];
      let best: Record<string, unknown> | null = null;
      for (const member of recipients) {
        const cards: PortfallCard[] = [];
        for (let i = 0; i < packetSize; i++) {
          cards.push(drawPacketCard(w, state, port, factionName, weights));
        }
        (state.collections[member.id] as PortfallCard[]).push(...cards);
        cardsBy.push({
          member: member.id,
          cards: cards.map(serializeCard),
        });
        for (const card of cards) {
          if (
            best === null ||
            card.power > (best.power as number) ||
            (card.power === (best.power as number) &&
              card.effect !== undefined &&
              best.effect === "")
          ) {
            best = { member: member.id, ...serializeCard(card) };
          }
        }
      }
      state.packets++;
      w.emit("portfall_packet", recipients.map((m) => m.id), {
        port: port.name,
        portIndex: port.index,
        stayIndex: stay.index,
        condition: conditionState,
        faction: factionName,
        cardsBy,
        best,
      });
    }
  }

  performTrades(w, state, crew, port.name, stay.index);
}

/** Invariant check: collections carry lawful stamped cards, the
 *  league table reconciles with its points, and the counters
 *  agree with the state they count. */
export function checkPortfallState(
  state: PortfallState,
  crew: readonly CrewMember[],
): void {
  const ids = new Set(crew.map((member) => member.id));
  let maxOrder = -1;
  let totalCards = 0;
  for (const member of crew) {
    const held = state.collections[member.id];
    if (held === undefined) {
      throw new Error(`portfall: no collection for ${member.id}`);
    }
    const entry = state.league[member.id];
    if (entry === undefined) {
      throw new Error(`portfall: no league entry for ${member.id}`);
    }
    for (const [label, value] of Object.entries(entry)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          `portfall: ${member.id} league ${label} out of range: ${value}`,
        );
      }
    }
    const expectedPoints =
      entry.w * CONFIG.portfall.leagueWinPoints +
      entry.d * CONFIG.portfall.leagueDrawPoints;
    if (entry.points !== expectedPoints) {
      throw new Error(
        `portfall: ${member.id} league points ${entry.points} != ${expectedPoints}`,
      );
    }
    for (const card of held) {
      totalCards++;
      maxOrder = Math.max(maxOrder, card.acquiredOrder);
      if (!SUITS.includes(card.suit)) {
        throw new Error(`portfall: bad suit ${card.suit}`);
      }
      if (!Number.isInteger(card.power) || card.power < 2 || card.power > 7) {
        throw new Error(`portfall: card power out of range: ${card.power}`);
      }
      if (card.effect === "anchor" && card.power !== 4) {
        throw new Error("portfall: an Anchor must be power 4");
      }
      if (card.effect === "surge" && card.power !== 3) {
        throw new Error("portfall: a Surge must be power 3");
      }
      if (card.originPort < 0 || card.acquiredTick < 0) {
        throw new Error("portfall: card provenance out of range");
      }
      if (card.stamp === "" || card.originName === "") {
        throw new Error("portfall: card carries no stamp");
      }
      for (const owner of card.owners) {
        if (!ids.has(owner)) {
          throw new Error(`portfall: card owner ${owner} is not crew`);
        }
      }
    }
  }
  if (state.nextOrder !== maxOrder + 1 && totalCards > 0) {
    throw new Error(
      `portfall: nextOrder ${state.nextOrder} disagrees with cards (max ${maxOrder})`,
    );
  }
  if (state.nextOrder !== 0 && totalCards === 0) {
    throw new Error("portfall: orders spent with no cards held");
  }
}
