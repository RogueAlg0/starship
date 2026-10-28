/**
 * The sector game: the factions play each other at the ports.
 *
 * DESIGN, the galaxy chapter, made concrete: every port has an
 * influence table, a share of its trade and voice per faction,
 * always summing to 100. Control of a port (Sector's faction
 * field) is the prize, and it changes hands only through a
 * contest: when a challenger's share draws level with the
 * controller's, the port freezes its drift and the two factions
 * settle it day by day, first to four days, seven at the most.
 * The contest's form follows the factions' natures: like kinds
 * hold an election, martial kinds run a blockade, mercantile
 * kinds an embargo. Ports also fall into conditions (boom,
 * shortage, unrest) with an announced day before they bite and
 * visible effects while they last.
 *
 * The driver is autonomous and daily: factions generate their
 * own effort from home ground, incumbency, temperament, feud
 * and circumstance, drawn on the sector's own stream. The
 * witnessed ship is one input among many: its calls warm the
 * controller's effort a little, and its presence during a
 * shortage is relief that shortens it. The galaxy's wars write
 * themselves, with or without a witness; the witness only gets
 * the better seat.
 *
 * Each faction also gains two derived faces at creation, never
 * drawn from any stream: a rival (the faction whose home port
 * lies nearest, the old grudge) and a voice (a spokesperson's
 * name hashed from the faction's own), so the sector's news
 * has someone to quote.
 */
import { CONFIG } from "../scenario/config.ts";
import type { World } from "../engine/engine.ts";
import { r3 } from "../log/events.ts";
import { nameHash, type Sector } from "./galaxy.ts";

export type ConditionState = "boom" | "shortage" | "unrest";
export type ContestKind = "election" | "embargo" | "blockade";

export interface PortCondition {
  state: ConditionState;
  phase: "pending" | "active" | "cooldown";
  daysLeft: number;
}

export interface Contest {
  portIndex: number;
  /** Faction index holding the port, or -1 for a free port bid. */
  incumbent: number;
  challenger: number;
  kind: ContestKind;
  scoreIncumbent: number;
  scoreChallenger: number;
  days: number;
}

export interface SectorState {
  /** Influence shares per port, per faction index; sums to 100. */
  shares: number[][];
  /**
   * The natural distribution per port, fixed at creation: the
   * port's character, which daily drift pulls shares back
   * toward so no port saturates for good.
   */
  naturalShares: number[][];
  /** Live condition per port, or null. */
  conditions: (PortCondition | null)[];
  /** Live contests, at most one per port. */
  contests: Contest[];
  /** Day number each port may next see a contest. */
  contestReadyDay: number[];
  /** Rival faction index per faction: the old grudge. */
  rivals: number[];
  /**
   * Each faction's current push, or null: a campaign at one
   * port, where its effort concentrates for a few weeks while
   * its attention elsewhere thins. Campaigns are what close
   * the gap drift alone cannot: a challenger with a project
   * gains on a controller day after day until a contest comes.
   */
  campaigns: ({ portIndex: number; daysLeft: number } | null)[];
  /** Spokesperson name per faction, for the news to quote. */
  voices: string[];
  /** The day the driver last ran for. */
  lastDay: number;
  /** Event cursor for ship movements (relief and witness flags). */
  eventCursor: number;
  /** Port index the witnessed ship currently occupies, or null. */
  shipPort: number | null;
}

const VOICE_FIRST = [
  "Mara", "Odo", "Selin", "Vera", "Tomas", "Ines",
  "Rurik", "Alba", "Casper", "Noor", "Ilya", "Petra",
];
const VOICE_LAST = [
  "Vane", "Okafor", "Lindqvist", "Marsh", "Ibarra", "Kowalski",
  "Fen", "Adeyemi", "Roth", "Sillanpaa", "Vega", "Moreau",
];

function hashWeights(seedText: string, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(1 + (nameHash(`${seedText}:${i}`) % 9));
  }
  return out;
}

/** Normalize shares to sum to exactly 100, keeping them non-negative. */
function normalize(shares: number[]): void {
  for (let i = 0; i < shares.length; i++) {
    if (shares[i]! < 0) shares[i] = 0;
  }
  const total = shares.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const each = 100 / shares.length;
    for (let i = 0; i < shares.length; i++) shares[i] = each;
    return;
  }
  for (let i = 0; i < shares.length; i++) shares[i] = (shares[i]! / total) * 100;
}

export function createSectorState(sector: Sector): SectorState {
  const factionCount = sector.factions.length;
  const shares: number[][] = [];
  for (const port of sector.ports) {
    const weights = hashWeights(`shares:${port.name}`, factionCount);
    const row = new Array<number>(factionCount).fill(0);
    if (port.faction !== null) {
      const control = 56 + (nameHash(port.name) % 16);
      const rest = 100 - control;
      const restTotal = weights.reduce(
        (a, b, i) => (i === port.faction ? a : a + b),
        0,
      );
      for (let f = 0; f < factionCount; f++) {
        row[f] =
          f === port.faction
            ? control
            : (weights[f]! / restTotal) * rest;
      }
    } else {
      const total = weights.reduce((a, b) => a + b, 0);
      for (let f = 0; f < factionCount; f++) {
        row[f] = (weights[f]! / total) * 100;
      }
      // A free port starts with no faction close to taking it.
      const top = Math.max(...row);
      if (top > 44) {
        const over = top - 44;
        const topIdx = row.indexOf(top);
        row[topIdx] = 44;
        const others = factionCount - 1;
        for (let f = 0; f < factionCount; f++) {
          if (f !== topIdx) row[f] = row[f]! + over / others;
        }
      }
    }
    normalize(row);
    shares.push(row);
  }

  const rivals: number[] = [];
  for (const faction of sector.factions) {
    const home = sector.portAt(faction.homePort);
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const other of sector.factions) {
      if (other.index === faction.index) continue;
      const p = sector.portAt(other.homePort);
      const d = (p.x - home.x) ** 2 + (p.y - home.y) ** 2;
      if (d < bestDist || (d === bestDist && other.index < best)) {
        bestDist = d;
        best = other.index;
      }
    }
    rivals.push(best);
  }

  const voices = sector.factions.map((faction) => {
    const h = nameHash(`${faction.name}:voice`);
    const first = VOICE_FIRST[h % VOICE_FIRST.length] as string;
    const last = VOICE_LAST[(h >>> 5) % VOICE_LAST.length] as string;
    return `${first} ${last}`;
  });

  return {
    shares,
    naturalShares: shares.map((row) => [...row]),
    campaigns: sector.factions.map(() => null),
    conditions: sector.ports.map(() => null),
    contests: [],
    contestReadyDay: sector.ports.map(() => 0),
    rivals,
    voices,
    lastDay: -1,
    eventCursor: 0,
    shipPort: null,
  };
}

function contestKindFor(
  incumbentKind: string | null,
  challengerKind: string,
  incumbentTemperament: string | null,
  challengerTemperament: string,
): ContestKind {
  if (incumbentKind !== null && incumbentKind === challengerKind) {
    return "election";
  }
  if (
    incumbentTemperament === "martial" ||
    challengerTemperament === "martial" ||
    incumbentKind === "order" ||
    challengerKind === "order"
  ) {
    return "blockade";
  }
  if (
    incumbentTemperament === "greedy" ||
    challengerTemperament === "greedy" ||
    challengerKind === "cartel" ||
    challengerKind === "company" ||
    challengerKind === "syndicate" ||
    incumbentKind === "cartel" ||
    incumbentKind === "company" ||
    incumbentKind === "syndicate"
  ) {
    return "embargo";
  }
  return "election";
}

/** The daily weight a faction brings to a contest day. */
function contestWeight(
  kind: ContestKind,
  factionKind: string,
  temperament: string,
  isIncumbent: boolean,
): number {
  let weight = 1;
  if (kind === "blockade") {
    if (temperament === "martial") weight *= 1.3;
    if (factionKind === "order") weight *= 1.15;
  } else if (kind === "embargo") {
    if (temperament === "greedy") weight *= 1.3;
    if (
      factionKind === "cartel" ||
      factionKind === "company" ||
      factionKind === "syndicate"
    ) {
      weight *= 1.15;
    }
  } else {
    if (isIncumbent) weight *= 1.1;
    if (temperament === "proud" || temperament === "pious") weight *= 1.15;
  }
  if (temperament === "weary") weight *= 0.9;
  return weight;
}

function topChallenger(
  row: number[],
  controller: number | null,
): { index: number; share: number } {
  let index = -1;
  let share = -1;
  for (let f = 0; f < row.length; f++) {
    if (f === controller) continue;
    if (row[f]! > share) {
      share = row[f]!;
      index = f;
    }
  }
  return { index, share };
}

export function stepSector(w: World, state: SectorState, sector: Sector): void {
  // Track the witnessed ship's port from its own events, the
  // same cursor discipline as the standing ledger.
  const events = w.events.events;
  while (state.eventCursor < events.length) {
    const ev = events[state.eventCursor] as (typeof events)[number];
    state.eventCursor++;
    if (ev.type === "arrival" || ev.type === "port_call") {
      const p = ev.data["portIndex"];
      if (typeof p === "number") state.shipPort = p;
    } else if (ev.type === "departure") {
      state.shipPort = null;
    }
  }

  const day = Math.floor(w.tick / CONFIG.time.ticksPerDay);
  if (day <= state.lastDay) return;
  state.lastDay = day;
  const cfg = CONFIG.factions.sector;
  const rng = w.rng.get("sector");

  // --- campaigns: each faction's push, started and ended daily
  for (const faction of sector.factions) {
    const live = state.campaigns[faction.index] ?? null;
    if (live !== null) {
      live.daysLeft -= 1;
      if (live.daysLeft <= 0) state.campaigns[faction.index] = null;
      continue;
    }
    if (rng.next() >= 0.08) continue;
    const contestedPorts = new Set(state.contests.map((c) => c.portIndex));
    const usable = (p: (typeof sector.ports)[number]): boolean =>
      !contestedPorts.has(p.index) && p.index !== faction.homePort;
    const rival = state.rivals[faction.index] ?? -1;
    const tier1 = sector.ports.filter(
      (p) => usable(p) && p.faction === rival,
    );
    const tier2 = sector.ports.filter((p) => {
      if (!usable(p) || p.faction !== null) return false;
      const row = state.shares[p.index] as number[];
      return topChallenger(row, null).index === faction.index;
    });
    const tier3 = sector.ports.filter(
      (p) => usable(p) && p.faction !== faction.index,
    );
    const tier = tier1.length > 0 ? tier1 : tier2.length > 0 ? tier2 : tier3;
    if (tier.length === 0) continue;
    let target = tier[0] as (typeof tier)[number];
    if (tier === tier3) {
      let bestShare = -1;
      for (const p of tier3) {
        const share = state.shares[p.index]?.[faction.index] ?? 0;
        if (share > bestShare) {
          bestShare = share;
          target = p;
        }
      }
    } else {
      target = tier[rng.int(tier.length)] as (typeof tier)[number];
    }
    state.campaigns[faction.index] = {
      portIndex: target.index,
      daysLeft: 24 + rng.int(14),
    };
    w.emit("sector_campaign", [], {
      faction: faction.id,
      name: faction.name,
      portIndex: target.index,
      port: target.name,
      voice: state.voices[faction.index] ?? "",
      witnessed: state.shipPort === target.index,
    });
  }

  for (const port of sector.ports) {
    const row = state.shares[port.index] as number[];
    const contest = state.contests.find((c) => c.portIndex === port.index);
    const condition = state.conditions[port.index] ?? null;

    // --- conditions tick down, and a witnessed call relieves a shortage
    if (condition !== null) {
      if (
        condition.state === "shortage" &&
        condition.phase === "active" &&
        state.shipPort === port.index
      ) {
        condition.daysLeft -= 1;
        w.emit("sector_relief", [], {
          portIndex: port.index,
          port: port.name,
        });
      }
      condition.daysLeft -= 1;
      if (condition.daysLeft <= 0) {
        if (condition.phase === "pending") {
          condition.phase = "active";
          condition.daysLeft =
            condition.state === "boom"
              ? cfg.boomDays
              : condition.state === "shortage"
                ? cfg.shortageDays
                : cfg.unrestDays;
          w.emit("sector_condition", [], {
            portIndex: port.index,
            port: port.name,
            state: condition.state,
            phase: "active",
            witnessed: state.shipPort === port.index,
          });
        } else if (condition.phase === "active") {
          condition.phase = "cooldown";
          condition.daysLeft = cfg.conditionCooldownDays;
          w.emit("sector_condition", [], {
            portIndex: port.index,
            port: port.name,
            state: condition.state,
            phase: "ended",
            witnessed: state.shipPort === port.index,
          });
        } else {
          state.conditions[port.index] = null;
        }
      }
    }

    // --- a live contest scores its day and may resolve
    if (contest !== undefined) {
      scoreContestDay(w, state, sector, contest);
      continue;
    }

    // --- drift: every faction works the port, every day
    const controller = port.faction;
    const challengerBefore = topChallenger(row, controller);
    const efforts: number[] = [];
    let effortTotal = 0;
    for (const faction of sector.factions) {
      let effort = 1;
      if (faction.homePort === port.index) effort += 0.7;
      if (controller === faction.index) effort += 0.3;
      // The nearly-gone fight hardest: a faction under a tenth
      // of a port's trade is not finished, it is desperate.
      if (controller !== faction.index && (row[faction.index] ?? 0) < 10) {
        effort += 0.3;
      }
      // A campaign concentrates the mind: heavy effort at the
      // target port, thinner attention everywhere else.
      const campaign = state.campaigns[faction.index] ?? null;
      if (campaign !== null) {
        effort += campaign.portIndex === port.index ? 0.9 : -0.15;
      }
      if (
        state.rivals[faction.index] !== undefined &&
        (row[state.rivals[faction.index]!] ?? 0) >= 20
      ) {
        effort += 0.25;
      }
      if (faction.temperament === "greedy" && controller !== faction.index) {
        effort += 0.15;
      }
      if (faction.temperament === "insular" && faction.homePort !== port.index) {
        effort -= 0.2;
      }
      if (faction.temperament === "martial") effort += 0.1;
      if (faction.temperament === "weary") effort -= 0.1;
      if (condition !== null && condition.phase === "active") {
        if (condition.state === "boom" && controller === faction.index) {
          effort *= 1.3;
        } else if (
          condition.state === "shortage" &&
          controller === faction.index
        ) {
          effort *= 0.6;
        } else if (
          condition.state === "unrest" &&
          challengerBefore.index === faction.index
        ) {
          effort *= 1.3;
        }
      }
      if (state.shipPort === port.index && controller === faction.index) {
        effort += 0.2;
      }
      effort *= 0.45 + rng.next() * 1.1;
      efforts.push(effort);
      effortTotal += effort;
    }
    const mean = effortTotal / sector.factions.length;
    const natural = state.naturalShares[port.index] as number[];
    for (let f = 0; f < row.length; f++) {
      row[f] =
        row[f]! +
        (efforts[f]! - mean) * cfg.driftRate +
        ((natural[f] ?? 0) - row[f]!) * cfg.reversion;
    }
    normalize(row);

    // --- collapse: a controller bled white loses the port outright
    if (
      controller !== null &&
      (row[controller] ?? 0) < cfg.collapseLine &&
      day >= (state.contestReadyDay[port.index] ?? 0)
    ) {
      const fallen = sector.factionAt(controller);
      port.faction = null;
      w.emit("sector_collapse", [], {
        portIndex: port.index,
        port: port.name,
        faction: fallen.id,
        name: fallen.name,
        witnessed: state.shipPort === port.index,
      });
      state.contestReadyDay[port.index] = day + cfg.contestCooldownDays;
      continue;
    }

    // --- contest trigger: a challenger draws level
    if (day >= (state.contestReadyDay[port.index] ?? 0)) {
      const gap =
        condition !== null &&
        condition.phase === "active" &&
        condition.state === "unrest"
          ? cfg.unrestGap
          : cfg.contestGap;
      const challenger = topChallenger(row, controller);
      if (controller === null) {
        if (challenger.index >= 0 && challenger.share >= cfg.freePortLine) {
          startContest(w, state, sector, port.index, -1, challenger.index);
        }
      } else if (
        challenger.index >= 0 &&
        challenger.share >= cfg.contestFloor &&
        challenger.share >= (row[controller] ?? 0) - gap
      ) {
        startContest(w, state, sector, port.index, controller, challenger.index);
      }
    }

    // --- condition ignition
    if (state.conditions[port.index] === null) {
      const controllerShare =
        controller === null ? 0 : (row[controller] ?? 0);
      const chance =
        cfg.conditionChance +
        (controller !== null && controllerShare < 30
          ? cfg.weakControllerBonus
          : 0);
      if (rng.next() < chance) {
        let next: ConditionState;
        const top = topChallenger(row, controller);
        const contested =
          controller !== null &&
          top.index >= 0 &&
          controllerShare - top.share < 12;
        if (
          (controller !== null && controllerShare < 30) ||
          (contested && rng.next() < 0.5)
        ) {
          next = "unrest";
        } else {
          next = rng.next() < 0.5 ? "boom" : "shortage";
        }
        state.conditions[port.index] = {
          state: next,
          phase: "pending",
          daysLeft: cfg.conditionPendingDays,
        };
        w.emit("sector_condition", [], {
          portIndex: port.index,
          port: port.name,
          state: next,
          phase: "pending",
          witnessed: state.shipPort === port.index,
        });
      }
    }
  }
}

function startContest(
  w: World,
  state: SectorState,
  sector: Sector,
  portIndex: number,
  incumbent: number,
  challenger: number,
): void {
  const port = sector.portAt(portIndex);
  const chal = sector.factionAt(challenger);
  const inc = incumbent >= 0 ? sector.factionAt(incumbent) : null;
  const kind = contestKindFor(
    inc?.kind ?? null,
    chal.kind,
    inc?.temperament ?? null,
    chal.temperament,
  );
  state.contests.push({
    portIndex,
    incumbent,
    challenger,
    kind,
    scoreIncumbent: 0,
    scoreChallenger: 0,
    days: 0,
  });
  w.emit("sector_contest_started", [], {
    portIndex,
    port: port.name,
    kind,
    incumbent: inc?.id ?? "",
    incumbentName: inc?.name ?? "",
    challenger: chal.id,
    challengerName: chal.name,
    feud:
      inc !== null &&
      (state.rivals[challenger] === incumbent ||
        state.rivals[incumbent] === challenger),
    voice: state.voices[challenger] ?? "",
    incumbentVoice: inc !== null ? (state.voices[incumbent] ?? "") : "",
    witnessed: state.shipPort === portIndex,
  });
}

function scoreContestDay(
  w: World,
  state: SectorState,
  sector: Sector,
  contest: Contest,
): void {
  const cfg = CONFIG.factions.sector;
  const rng = w.rng.get("sector");
  const port = sector.portAt(contest.portIndex);
  const chal = sector.factionAt(contest.challenger);
  const inc =
    contest.incumbent >= 0 ? sector.factionAt(contest.incumbent) : null;
  const chalWeight =
    contestWeight(contest.kind, chal.kind, chal.temperament, false) *
    (0.7 + rng.next() * 0.6);
  const incWeight =
    (inc === null
      ? 0.85
      : contestWeight(contest.kind, inc.kind, inc.temperament, true)) *
    (0.7 + rng.next() * 0.6);
  contest.days += 1;
  if (chalWeight > incWeight) {
    contest.scoreChallenger += 1;
  } else {
    contest.scoreIncumbent += 1;
  }
  w.emit("sector_contest_day", [], {
    portIndex: contest.portIndex,
    port: port.name,
    kind: contest.kind,
    day: contest.days,
    scoreIncumbent: contest.scoreIncumbent,
    scoreChallenger: contest.scoreChallenger,
    incumbentName: inc?.name ?? "",
    challengerName: chal.name,
    witnessed: state.shipPort === contest.portIndex,
  });

  const chalWon = contest.scoreChallenger >= cfg.contestWinDays;
  const incWon = contest.scoreIncumbent >= cfg.contestWinDays;
  const spent = contest.days >= cfg.contestMaxDays;
  if (!chalWon && !incWon && !spent) return;

  const challengerTakes =
    chalWon ||
    (spent && contest.scoreChallenger > contest.scoreIncumbent);
  const row = state.shares[contest.portIndex] as number[];
  let flipped = false;
  if (challengerTakes) {
    if (contest.incumbent >= 0) {
      const move = Math.min(6, row[contest.incumbent] ?? 6);
      row[contest.incumbent] = (row[contest.incumbent] ?? 0) - move;
      row[contest.challenger] = (row[contest.challenger] ?? 0) + move;
    }
    port.faction = contest.challenger;
    flipped = contest.incumbent !== contest.challenger;
  } else if (contest.incumbent >= 0) {
    const move = Math.min(5, row[contest.challenger] ?? 5);
    row[contest.challenger] = (row[contest.challenger] ?? 0) - move;
    row[contest.incumbent] = (row[contest.incumbent] ?? 0) + move;
  }
  normalize(row);
  state.contests = state.contests.filter((c) => c !== contest);
  state.contestReadyDay[contest.portIndex] =
    Math.floor(w.tick / CONFIG.time.ticksPerDay) + cfg.contestCooldownDays;
  w.emit("sector_contest_resolved", [], {
    portIndex: contest.portIndex,
    port: port.name,
    kind: contest.kind,
    flipped,
    winner: challengerTakes ? chal.id : (inc?.id ?? ""),
    winnerName: challengerTakes ? chal.name : (inc?.name ?? "the port itself"),
    loser: challengerTakes ? (inc?.id ?? "") : chal.id,
    loserName: challengerTakes ? (inc?.name ?? "the free port") : chal.name,
    scoreWinner: challengerTakes
      ? contest.scoreChallenger
      : contest.scoreIncumbent,
    scoreLoser: challengerTakes
      ? contest.scoreIncumbent
      : contest.scoreChallenger,
    voice: state.voices[contest.challenger] ?? "",
    witnessed: state.shipPort === contest.portIndex,
  });
}

export function checkSectorState(
  sector: Sector,
  state: SectorState,
): string[] {
  const problems: string[] = [];
  if (state.shares.length !== sector.ports.length) {
    problems.push("sector shares do not cover every port");
  }
  for (const port of sector.ports) {
    const row = state.shares[port.index];
    if (row === undefined || row.length !== sector.factions.length) {
      problems.push(`port ${port.name} influence row is malformed`);
      continue;
    }
    const total = row.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.75) {
      problems.push(`port ${port.name} influence sums to ${r3(total)}`);
    }
    for (const share of row) {
      if (share < 0 || share > 100) {
        problems.push(`port ${port.name} holds a share outside [0, 100]`);
      }
    }
  }
  const seenPorts = new Set<number>();
  for (const contest of state.contests) {
    if (seenPorts.has(contest.portIndex)) {
      problems.push("two contests live at one port");
    }
    seenPorts.add(contest.portIndex);
    if (contest.scoreChallenger < 0 || contest.scoreIncumbent < 0) {
      problems.push("a contest score went negative");
    }
  }
  if (state.rivals.length !== sector.factions.length) {
    problems.push("rivals do not cover every faction");
  }
  if (state.campaigns.length !== sector.factions.length) {
    problems.push("campaigns do not cover every faction");
  }
  if (state.voices.length !== sector.factions.length) {
    problems.push("voices do not cover every faction");
  }
  return problems;
}
