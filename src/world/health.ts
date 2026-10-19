// Health: the body, harm, and the cause ledger (the Consequences
// chapter).
//
// Harm is modeled, never rolled out of nowhere. Accidents ride on
// work actually done, scaled by the work's danger, the weather,
// fatigue, and hurry. Cascades ride on system condition: bad air,
// radiation, thirst. Sickness rides on water, air, and crowding,
// and spreads the way beliefs do, by co-location. Violence is the
// far end of a grudge, gated on trust, despair, and temperament
// all peaking at once.
//
// The body is the squad model's, slowed to ship time: wounds per
// body part with severity, bleeding, and infection; treatment as
// work; healing in days; marks that last. Death is health reaching
// zero through the ledger and nothing else. Every point of harm
// (and every point of recovery, as a negative entry) is booked to
// a cause at the moment it lands, so the ledger reconciles with
// health exactly: health = 1 - sum(ledger amounts), always. The
// board of inquiry reads this ledger; it is the truth about how
// someone died, written before anyone forms an opinion.

import type { World } from "../engine/engine.ts";
import type { CrewMember } from "../entities/crew.ts";
import { r3 } from "../log/events.ts";
import {
  driftSuspicion,
  driftTrust,
  trustOf,
} from "../perception/beliefs.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Ship } from "./ship.ts";
import { clamp01 } from "./systems.ts";
import type { Weather } from "./weather.ts";

export const BODY_PARTS = ["head", "torso", "arms", "legs"] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

export interface Wound {
  severity: number;
  infected: boolean;
  /** A lasting mark has been left by this part's wounds. */
  marked: boolean;
}

/** One ledger line: harm (positive) or recovery (negative), booked
 *  to a cause at the moment it lands. */
export interface LedgerEntry {
  tick: number;
  cause: string;
  amount: number;
  part: BodyPart | null;
  /** Who caused it, when a person did (violence, an accident's
   *  own hands are the victim's; the field names an attacker). */
  source: string | null;
}

export interface BodyState {
  /** Overall health in [0, 1]. Death is this reaching zero. */
  health: number;
  wounds: Record<BodyPart, Wound>;
  /** Sickness level in [0, 1]: bad water, bad air, other people. */
  sick: number;
  /** Lasting marks, in the order they were earned. */
  marks: string[];
  /** The cause ledger: every point of harm and recovery. */
  ledger: LedgerEntry[];
  /** Treated (bandaged, tended) until this tick. */
  treatedUntil: number;
  lastCarriedTick: number;
  lastSickOnsetTick: number;
  /** The wound episode has been spoken in the log. */
  injuryAnnounced: boolean;
}

export function createBody(): BodyState {
  const wounds = {} as Record<BodyPart, Wound>;
  for (const part of BODY_PARTS) {
    wounds[part] = { severity: 0, infected: false, marked: false };
  }
  return {
    health: 1,
    wounds,
    sick: 0,
    marks: [],
    ledger: [],
    treatedUntil: -1,
    lastCarriedTick: -1000000,
    lastSickOnsetTick: -1000000,
    injuryAnnounced: false,
  };
}

/** Total open wound severity across the body. */
export function totalSeverity(member: CrewMember): number {
  let sum = 0;
  for (const part of BODY_PARTS) sum += member.body.wounds[part].severity;
  return sum;
}

/** Harm totals per cause from the ledger: the truth an inquiry reads. */
export function ledgerTotals(member: CrewMember): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const entry of member.body.ledger) {
    totals[entry.cause] = (totals[entry.cause] ?? 0) + entry.amount;
  }
  return totals;
}

/** The cause that took the most health, net of recovery elsewhere. */
export function topCause(member: CrewMember): string {
  const totals = ledgerTotals(member);
  let best = "unknown";
  let bestAmount = 0;
  for (const cause of Object.keys(totals)) {
    if (cause === "recovery") continue;
    if ((totals[cause] as number) > bestAmount) {
      bestAmount = totals[cause] as number;
      best = cause;
    }
  }
  return best;
}

/** The ledger's causes in harm order, for the chronicle's truth line. */
export function ledgerSummary(member: CrewMember): { cause: string; amount: number }[] {
  const totals = ledgerTotals(member);
  return Object.keys(totals)
    .filter((cause) => cause !== "recovery" && (totals[cause] as number) > 0)
    .map((cause) => ({ cause, amount: r3(totals[cause] as number) }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Book harm (or, with a negative amount, recovery) to the ledger
 * and move health by it. This is the only door health moves
 * through, which is what makes the reconciliation exact.
 */
export function bookHarm(
  member: CrewMember,
  tick: number,
  cause: string,
  amount: number,
  part: BodyPart | null = null,
  source: string | null = null,
): void {
  if (amount === 0) return;
  // Book what actually moved: at the clamps (full health, or the
  // final blow) the effective amount is smaller than the asked
  // amount, and the ledger records the effective one, so the
  // identity health = 1 - sum(ledger) holds exactly, always.
  const next = clamp01(member.body.health - amount);
  const effective = member.body.health - next;
  if (effective === 0) return;
  member.body.ledger.push({ tick, cause, amount: effective, part, source });
  member.body.health = next;
}

/** The lasting mark a part's bad wound leaves, if it leaves one. */
const MARK_BY_PART: Record<BodyPart, string> = {
  head: "lost eye",
  torso: "scarred torso",
  arms: "ruined hand",
  legs: "lame leg",
};

/**
 * Land a wound on a body part: severity now, bleeding and
 * infection behind it, immediate harm booked, and a lasting mark
 * when the wound is deep enough. Emits the injury line and, when
 * it lands, the mark line.
 */
export function woundMember(
  w: World,
  member: CrewMember,
  cause: string,
  part: BodyPart,
  severity: number,
  source: string | null = null,
): void {
  const cfg = CONFIG.health;
  const wound = member.body.wounds[part];
  wound.severity = Math.min(1, wound.severity + severity);
  bookHarm(member, w.tick, cause, severity * cfg.woundImpact, part, source);
  w.emit("injury", [member.id], {
    person: member.id,
    cause,
    part,
    severity: r3(severity),
    room: member.room,
    source,
  });
  member.body.injuryAnnounced = true;
  if (severity >= cfg.markSeverity && !wound.marked) {
    wound.marked = true;
    const mark = MARK_BY_PART[part];
    if (mark !== undefined && !member.body.marks.includes(mark)) {
      member.body.marks.push(mark);
      w.emit("lasting_mark", [member.id], { person: member.id, mark, part });
    }
  }
}

/** One recorded death, for the council's automatic inquiry. */
export interface DeathRecord {
  memberId: string;
  tick: number;
  room: number;
  /** Ids of the living who stood in the room when it happened. */
  presentIds: string[];
  topCause: string;
  /** The attacker, when the ledger names one (violence). */
  attackerId: string | null;
}

export interface HealthState {
  deaths: DeathRecord[];
  /** Ticks life support has stood failed with no oxygen margin. */
  doomTicks: number;
  shipLost: boolean;
  collapsed: boolean;
  /** Last act of violence, for the inquiry's truth about culprits. */
  lastViolence: { attackerId: string; victimId: string; tick: number } | null;
}

export function createHealthState(): HealthState {
  return { deaths: [], doomTicks: 0, shipLost: false, collapsed: false, lastViolence: null };
}

function systemCondition(ship: Ship, kind: string): number {
  const system = ship.systems.find((s) => s.kind === kind);
  return system === undefined ? 1 : system.condition;
}

function systemFailed(ship: Ship, kind: string): boolean {
  const system = ship.systems.find((s) => s.kind === kind);
  return system !== undefined && system.failed;
}

/** Whether this member is treated right now: tended this tick by a
 *  medic's hands, or lying in the medbay with the medic present. */
function treatedNow(
  member: CrewMember,
  crew: readonly CrewMember[],
  ship: Ship,
  tick: number,
): boolean {
  if (tick <= member.body.treatedUntil) return true;
  if (ship.roomKind(member.room) !== "medbay") return false;
  return crew.some(
    (other) =>
      other !== member &&
      !other.dead &&
      other.room === member.room &&
      other.affinity.includes("medbay unit"),
  );
}

function die(
  w: World,
  state: HealthState,
  member: CrewMember,
  crew: readonly CrewMember[],
): void {
  member.dead = true;
  member.deathTick = w.tick;
  member.activity = "dead";
  const presentIds = crew
    .filter((other) => other !== member && !other.dead && other.room === member.room && !other.ashore)
    .map((other) => other.id);
  let attackerId: string | null = null;
  for (const entry of member.body.ledger) {
    if (entry.source !== null && (entry.cause === "violence")) {
      attackerId = entry.source;
    }
  }
  const record: DeathRecord = {
    memberId: member.id,
    tick: w.tick,
    room: member.room,
    presentIds,
    topCause: topCause(member),
    attackerId,
  };
  state.deaths.push(record);
  w.emit("death", [member.id], {
    person: member.id,
    cause: record.topCause,
    ledger: ledgerSummary(member),
    room: member.room,
    present: presentIds,
    attacker: attackerId,
  });
}

/**
 * Accidents: risk over the tasks actually done. A member at work
 * or repair draws once per tick on the "harm" stream against a
 * risk scaled by the room's most dangerous system, the weather,
 * failed systems (darkness, hurry), and their own fatigue.
 */
function accidents(
  w: World,
  ship: Ship,
  crew: readonly CrewMember[],
  weather: Weather,
): void {
  const cfg = CONFIG.health;
  const rng = w.rng.get("harm");
  const anyFailed = ship.systems.some((s) => s.failed);
  for (const member of crew) {
    if (member.dead || member.ashore || member.leftShip) continue;
    if (w.tick < member.confinedUntil) continue;
    if (member.activity !== "work" && member.activity !== "repair") continue;
    let danger = member.activity === "repair" ? cfg.dangerRepair : cfg.dangerWork;
    let roomDanger = 0.5;
    let roomFailed = false;
    for (const system of ship.systemsInRoom(member.room)) {
      roomDanger = Math.max(roomDanger, cfg.dangerByKind[system.kind] ?? 0.5);
      if (system.failed) roomFailed = true;
    }
    danger *= roomDanger;
    if (weather.storm) danger *= cfg.stormFactor;
    if (roomFailed) danger *= cfg.failedRoomFactor;
    if (anyFailed) danger *= cfg.hurryFactor;
    if (member.needs.energy < cfg.fatigueLowEnergy) danger *= cfg.fatigueFactor;
    else if (member.needs.energy < cfg.tiredEnergy) danger *= cfg.tiredFactor;
    // The wounded work clumsy, and the sick worse.
    danger *= 1 + totalSeverity(member) * 0.5 + member.body.sick * 0.4;
    if (!rng.chance(cfg.accidentPerTick * danger)) continue;
    const part = BODY_PARTS[rng.int(BODY_PARTS.length)] as BodyPart;
    const severity =
      cfg.woundSeverityMin + rng.next() * (cfg.woundSeverityMax - cfg.woundSeverityMin);
    woundMember(w, member, "accident", part, severity);
  }
}

/**
 * Violence, the far end of a grudge. All gates at once: a grudge
 * held, trust at the floor, morale in despair, the target in the
 * room and awake, and temperament that lets anger win. Then the
 * stream decides, rarely.
 */
function violence(w: World, state: HealthState, crew: readonly CrewMember[]): void {
  const cfg = CONFIG.health;
  const rng = w.rng.get("harm");
  for (const member of crew) {
    if (member.dead || member.ashore || member.leftShip) continue;
    if (w.tick < member.confinedUntil) continue;
    if (w.tick - member.lastAttackTick < cfg.violenceCooldownTicks) continue;
    if (member.needs.morale > cfg.violenceMorale) continue;
    // Despair has a body, too: the fed and rested rarely strike.
    if (member.needs.hunger > 0.35 && member.needs.energy > 0.3) continue;
    if (member.beliefs.grudges.length === 0) continue;
    if (member.activity === "rest") continue;
    let traitFactor = 1;
    for (const trait of member.traits) {
      traitFactor += cfg.violenceTraitFactor[trait] ?? 0;
    }
    if (member.traits.includes("disciplined")) traitFactor *= 0.4;
    if (member.traits.includes("kind") || member.traits.includes("gentle")) {
      traitFactor *= 0.5;
    }
    for (const targetId of member.beliefs.grudges) {
      if (trustOf(member.beliefs, targetId) > cfg.violenceTrust) continue;
      const since = member.beliefs.lowTrustSince[targetId];
      if (since === undefined || w.tick - since < cfg.violenceGrudgeAgeTicks) {
        continue;
      }
      const target = crew.find((c) => c.id === targetId);
      if (target === undefined || target.dead || target.ashore || target.leftShip) {
        continue;
      }
      if (target.room !== member.room || target.activity === "rest") continue;
      if (!rng.chance(cfg.violenceChancePerTick * traitFactor)) continue;
      member.lastAttackTick = w.tick;
      const parts: BodyPart[] = ["torso", "arms", "head"];
      const part = parts[rng.int(parts.length)] as BodyPart;
      const severity =
        cfg.violenceWoundMin + rng.next() * (cfg.violenceWoundMax - cfg.violenceWoundMin);
      state.lastViolence = { attackerId: member.id, victimId: target.id, tick: w.tick };
      w.emit("attack", [member.id], {
        attacker: member.id,
        victim: target.id,
        room: member.room,
      });
      woundMember(w, target, "violence", part, severity, member.id);
      // Witnesses know what they saw: suspicion and broken trust.
      for (const other of crew) {
        if (other === member || other === target) continue;
        if (other.room !== member.room || other.dead || other.ashore) continue;
        driftSuspicion(other.beliefs, member.id, cfg.violenceWitnessSuspicion);
        driftTrust(other.beliefs, member.id, -0.3);
      }
      driftTrust(target.beliefs, member.id, -0.4);
      break;
    }
  }
}

/**
 * One tick of bodies: accidents, cascades, sickness, violence,
 * bleeding, infection, healing, treatment, carrying, and death.
 * Runs after the crew and the ship's systems, so it reads the
 * tick's work, conditions, and company as they stood.
 */
export function stepHealth(
  w: World,
  state: HealthState,
  ship: Ship,
  crew: readonly CrewMember[],
  weather: Weather,
): void {
  const cfg = CONFIG.health;
  const tpd = CONFIG.time.ticksPerDay;
  const rng = w.rng.get("harm");
  if (state.shipLost || state.collapsed) return;

  accidents(w, ship, crew, weather);
  violence(w, state, crew);

  const lifeSupport = systemCondition(ship, "life support");
  const recycler = systemCondition(ship, "water recycler");
  const reactorRoom = ship.systems.find((s) => s.kind === "reactor")?.room;
  const reactor = systemCondition(ship, "reactor");
  const stores = ship.stores;
  const oxygenOut = stores !== null && stores.byKey.oxygen.qtyMilli <= 0;
  const waterOut = stores !== null && stores.byKey.water.qtyMilli <= 0;
  const foodOut = stores !== null && stores.byKey.food.qtyMilli <= 0;
  const cmoFilled = ship.councilPublic?.cmoFilled ?? true;
  const medbayRoom = ship.firstRoomOfKind("medbay");

  const occupancy = new Map<number, number>();
  for (const member of crew) {
    if (member.dead || member.ashore || member.leftShip) continue;
    occupancy.set(member.room, (occupancy.get(member.room) ?? 0) + 1);
  }
  // Who is sick in each room, for the spread pass.
  const sickByRoom = new Map<number, number>();
  for (const member of crew) {
    if (member.dead || member.ashore || member.leftShip) continue;
    if (member.body.sick > cfg.spreadLine) {
      sickByRoom.set(member.room, (sickByRoom.get(member.room) ?? 0) + 1);
    }
  }

  for (const member of crew) {
    if (member.dead || member.ashore || member.leftShip) continue;
    const body = member.body;
    const treated = treatedNow(member, crew, ship, w.tick);
    const inMedbay = member.room === medbayRoom && medbayRoom >= 0;

    // ---- cascades: the ship's condition becomes the body's.
    if (lifeSupport < cfg.cascadeThreshold) {
      const depth = (cfg.cascadeThreshold - lifeSupport) / cfg.cascadeThreshold;
      bookHarm(member, w.tick, "suffocation", (cfg.airHarmPerDay * depth) / tpd);
    }
    if (oxygenOut) {
      bookHarm(member, w.tick, "suffocation", cfg.oxygenZeroHarmPerDay / tpd);
    }
    if (reactor < cfg.reactorCascadeThreshold && member.room === reactorRoom) {
      const depth =
        (cfg.reactorCascadeThreshold - reactor) / cfg.reactorCascadeThreshold;
      bookHarm(member, w.tick, "radiation", (cfg.radiationPerDay * depth) / tpd);
    }
    if (waterOut) {
      bookHarm(member, w.tick, "dehydration", cfg.dehydrationPerDay / tpd);
    }
    if (foodOut) {
      bookHarm(member, w.tick, "starvation", cfg.starvationPerDay / tpd);
    }

    // ---- sickness: sources and spread push up, recovery always
    // pushes back (weaker while the water or air that ails the
    // ship stays bad). The balance of the two is the epidemic
    // curve: a sound ship's background sniffles decay away, a
    // fouled ship's do not.
    let sickDelta = 0;
    if (recycler < cfg.cascadeThreshold) {
      sickDelta +=
        (cfg.sickWaterPerDay * (cfg.cascadeThreshold - recycler)) /
        cfg.cascadeThreshold /
        tpd;
    }
    if (lifeSupport < cfg.cascadeThreshold) {
      sickDelta +=
        (cfg.sickAirPerDay * (cfg.cascadeThreshold - lifeSupport)) /
        cfg.cascadeThreshold /
        tpd;
    }
    if ((occupancy.get(member.room) ?? 0) >= cfg.crowdSize) {
      sickDelta += cfg.sickCrowdPerDay / tpd;
    }
    const spreaders = sickByRoom.get(member.room) ?? 0;
    if (spreaders > 0 && body.sick <= cfg.spreadLine) {
      sickDelta += (cfg.spreadPerDay * spreaders) / tpd;
    }
    const soundShip =
      recycler >= cfg.cascadeThreshold && lifeSupport >= cfg.cascadeThreshold;
    let recovery = (cfg.sickRecoveryPerDay / tpd) * (soundShip ? 1 : 0.3);
    if (inMedbay) recovery *= cfg.medbaySickFactor;
    if (treated) recovery *= 1.5;
    body.sick = clamp01(body.sick + sickDelta - recovery);
    if (body.sick > cfg.sickHarmLine) {
      bookHarm(
        member,
        w.tick,
        "sickness",
        ((body.sick - cfg.sickHarmLine) * cfg.sickHarmPerDay) / tpd,
      );
    }
    if (
      body.sick >= cfg.sickOnsetLine &&
      w.tick - body.lastSickOnsetTick >= tpd
    ) {
      body.lastSickOnsetTick = w.tick;
      w.emit("sickness", [member.id], {
        person: member.id,
        level: r3(body.sick),
        room: member.room,
      });
    }

    // ---- wounds: bleeding, infection, healing.
    let bleeding = 0;
    let healing = 0;
    for (const part of BODY_PARTS) {
      const wound = body.wounds[part];
      if (wound.severity <= 0) continue;
      bleeding += wound.severity * (cfg.bleedPerDay / tpd);
      if (wound.infected) {
        bookHarm(member, w.tick, "infection", cfg.infectionHarmPerDay / tpd, part);
        wound.severity = Math.min(
          1,
          wound.severity + cfg.infectionGrowthPerDay / tpd,
        );
      }
      let heal = cfg.healPerDay / tpd;
      if (treated) heal *= cfg.treatedHealFactor;
      if (inMedbay) heal *= cfg.medbayHealFactor;
      if (member.activity === "rest") heal *= cfg.restHealFactor;
      if (!cmoFilled) heal *= cfg.layHealFactor;
      if (body.sick > cfg.sickHarmLine) heal *= 0.6;
      const healed = Math.min(wound.severity, heal);
      wound.severity -= healed;
      healing += healed * cfg.woundImpact;
      if (wound.severity <= 0.001) {
        wound.severity = 0;
        wound.infected = false;
      }
    }
    if (bleeding > 0) {
      bookHarm(
        member,
        w.tick,
        "bleeding",
        bleeding * (treated ? cfg.treatedBleedFactor : 1),
      );
    }
    // Death is checked here, between the harm bookings and the
    // healing bookings: a body the harm brought to zero this tick
    // dies this tick. Checked only at the end of the pass, the
    // background recovery line would resurrect the body every
    // tick (harm to zero, recovery back to one tick's worth,
    // forever), and nobody could ever die of a slow cascade.
    if (body.health <= 0) {
      die(w, state, member, crew);
      continue;
    }
    if (healing > 0) {
      bookHarm(member, w.tick, "recovery", -healing);
    }
    if (totalSeverity(member) === 0 && body.sick <= cfg.sickHarmLine) {
      bookHarm(member, w.tick, "recovery", -cfg.recoveryPerDay / tpd);
    }
    // Infection is a daily risk per open wound, drawn at the day line.
    if (w.tick % tpd === 0) {
      for (const part of BODY_PARTS) {
        const wound = body.wounds[part];
        if (wound.severity <= 0 || wound.infected) continue;
        const chance =
          wound.severity *
          cfg.infectionChancePerDay *
          (treated ? cfg.treatedInfectionFactor : 1);
        if (rng.chance(chance)) {
          wound.infected = true;
          w.emit("infection", [member.id], { person: member.id, part });
        }
      }
    }

    // ---- treatment spoken: the medic's work leaves a line a day.
    if (
      treated &&
      totalSeverity(member) > 0 &&
      w.tick % tpd === CONFIG.routine.breakfastStartHour * (tpd / 24)
    ) {
      w.emit("treatment", [member.id], {
        person: member.id,
        health: r3(body.health),
        inMedbay,
      });
    }

    // ---- carrying: the badly wounded are taken to the medbay.
    if (
      medbayRoom >= 0 &&
      member.room !== medbayRoom &&
      totalSeverity(member) >= cfg.carrySeverity &&
      body.health < 0.65 &&
      w.tick - body.lastCarriedTick >= tpd
    ) {
      const carrier = crew.find(
        (other) =>
          other !== member &&
          !other.dead &&
          !other.ashore &&
          !other.leftShip &&
          other.room === member.room &&
          totalSeverity(other) < 0.3,
      );
      if (carrier !== undefined) {
        body.lastCarriedTick = w.tick;
        const from = member.room;
        member.room = medbayRoom;
        w.emit("carried_to_medbay", [carrier.id], {
          carrier: carrier.id,
          person: member.id,
          from,
          to: medbayRoom,
        });
      }
    }

    // ---- death, only through the ledger.
    if (body.health <= 0) {
      die(w, state, member, crew);
    }
  }

  // ---- endings: the ship herself.
  const lsFailed = systemFailed(ship, "life support");
  const reactorFloor = reactor <= 0.02 && systemFailed(ship, "reactor");
  if ((lsFailed && oxygenOut) || reactorFloor) {
    state.doomTicks++;
  } else {
    state.doomTicks = 0;
  }
  if (state.doomTicks >= cfg.doomDays * tpd && !state.shipLost) {
    state.shipLost = true;
    ship.ended = true;
    const airlockRoom = ship.firstRoomOfKind("airlock");
    const survivors: string[] = [];
    const lost: string[] = [];
    for (const member of crew) {
      if (member.dead || member.leftShip) continue;
      const dist = airlockRoom >= 0 ? ship.distance(member.room, airlockRoom) : 3;
      const chance = 0.55 + member.body.health * 0.3 - dist * 0.08;
      if (rng.chance(Math.max(0.05, Math.min(0.95, chance)))) {
        member.leftShip = true;
        member.activity = "evacuated";
        survivors.push(member.id);
      } else {
        bookHarm(member, w.tick, "ship_lost", member.body.health + 1);
        lost.push(member.id);
        die(w, state, member, crew);
      }
    }
    w.emit("ship_lost", [], {
      cause: reactorFloor ? "reactor" : "life support",
      survivors,
      lost,
    });
    w.emit("abandon_ship", [], { survivors, lost });
    return;
  }
  const able = crew.filter(
    (m) => !m.dead && !m.leftShip && m.body.health > 0.35,
  ).length;
  if (able < 3 && !state.collapsed) {
    state.collapsed = true;
    ship.ended = true;
    w.emit("crew_collapse", [], { able });
  }
}

/** Invariant check: health, wounds, and sickness in range, and the
 *  ledger reconciling with health to float tolerance. */
export function checkHealthState(crew: readonly CrewMember[]): void {
  for (const member of crew) {
    const body = member.body;
    if (body.health < 0 || body.health > 1) {
      throw new Error(`${member.id} health out of range: ${body.health}`);
    }
    if (body.sick < 0 || body.sick > 1) {
      throw new Error(`${member.id} sickness out of range: ${body.sick}`);
    }
    for (const part of BODY_PARTS) {
      const wound = body.wounds[part];
      if (wound.severity < 0 || wound.severity > 1) {
        throw new Error(`${member.id} wound ${part} out of range: ${wound.severity}`);
      }
    }
    let sum = 0;
    for (const entry of body.ledger) sum += entry.amount;
    if (Math.abs(1 - sum - body.health) > 1e-6) {
      throw new Error(
        `${member.id} ledger does not reconcile: health ${body.health}, ledger sum ${sum}`,
      );
    }
  }
}
