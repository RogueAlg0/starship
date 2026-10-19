// The crew of twelve: generated from the seed on the "crewgen" stream.
//
// Each person has a name, one of the twelve roles, two or three traits,
// needs (energy, hunger, social, morale), and private beliefs about every
// crewmate. Each tick the engine offers them candidates grounded in ship
// life (move along the room graph, eat, rest, work, repair, socialize,
// idle, and, for a grudge-holder alone with a system, sabotage), and the
// world's decision source picks one. Scores are computed from the agent's
// own state and beliefs only: what they need, whom they trust, what they
// suspect. Never from truth they could not know.

import type { Candidate } from "../decision/decisions.ts";
import type { World } from "../engine/engine.ts";
import type { Rng } from "../engine/rng.ts";
import { r3 } from "../log/events.ts";
import {
  bondOf,
  createBeliefs,
  driftBond,
  driftTrust,
  reportMilestones,
  spreadGossip,
  trustOf,
  type Beliefs,
} from "../perception/beliefs.ts";
import {
  blockAt,
  makeRoutine,
  mealWindowAt,
  pickNightWatchRoles,
  type BlockKind,
  type Routine,
  type WatchName,
} from "./routine.ts";
import { applySabotage, sabotageCandidate } from "../plots/sabotage.ts";
import { maybeSocialSpeech } from "../perception/speech.ts";
import { CONFIG } from "../scenario/config.ts";
import { createBody, totalSeverity, type BodyState } from "../world/health.ts";
import type { Voyage } from "../world/galaxy.ts";
import type { Ship } from "../world/ship.ts";
import { gateRepairDelta } from "../world/stores.ts";
import {
  applyConditionDelta,
  clamp01,
  type ShipSystem,
} from "../world/systems.ts";
import type { Weather } from "../world/weather.ts";

export interface Needs {
  energy: number;
  hunger: number;
  social: number;
  morale: number;
}

export class CrewMember {
  readonly id: string;
  readonly name: string;
  readonly roleKey: string;
  readonly title: string;
  readonly affinity: readonly string[];
  readonly repairSkill: number;
  readonly traits: string[];
  room: number;
  readonly needs: Needs;
  readonly beliefs: Beliefs;
  /** The watch this person stands: "day" for most, "night" for the pair. */
  readonly watch: WatchName;
  /** Their daily shape: sleep block, work blocks, free time between. */
  readonly routine: Routine;
  /** What they did most recently; read by crewmates deciding to approach. */
  activity = "idle";
  /** Ashore on leave during a port call: off the ship entirely —
   *  no acting, no witnessing, no deck dot — while the stores
   *  system's rotation holds. Set and cleared by that system. */
  ashore = false;
  /** The body: wounds per part, sickness, marks, the cause ledger.
   *  Owned by the health system (src/world/health.ts); the crew
   *  step reads it (the wounded work slower, the carried are
   *  moved) and never writes it. */
  readonly body: BodyState = createBody();
  /** Dead, through the ledger and nothing else. The dead do not
   *  act, eat, witness, or hold a council seat. */
  dead = false;
  deathTick = -1;
  /** Put off at a port, or evacuated at an ending: gone from the ship. */
  leftShip = false;
  /** Council sentences: confined to quarters until this tick. */
  confinedUntil = -1;
  /** Restricted from systems (repairs, sabotage) until this tick. */
  restrictedUntil = -1;
  /** Loss of mess privileges until this tick (a discipline sentence). */
  messBanUntil = -1;
  lastAttackTick = -1000000;
  /** Person currently being treated by this member, for event dedupe. */
  treatTarget: string | null = null;
  lastAccusationTick = -1000000;
  lastSabotageTick = -1000000;
  /** Tick of this person's last leisure event, for the leisure cooldown. */
  lastLeisureTick = -1000000;
  /** Tick of this person's last spoken chatter line. Owned by the
   *  speech layer (src/perception/speech.ts); read by nothing else. */
  lastChatterTick = -1000000;
  /** System currently being repaired, for repair-session event dedupe. */
  repairTarget: string | null = null;

  constructor(
    id: string,
    name: string,
    roleKey: string,
    title: string,
    affinity: readonly string[],
    repairSkill: number,
    traits: string[],
    room: number,
    needs: Needs,
    beliefs: Beliefs,
    watch: WatchName,
    routine: Routine,
  ) {
    this.id = id;
    this.name = name;
    this.roleKey = roleKey;
    this.title = title;
    this.affinity = affinity;
    this.repairSkill = repairSkill;
    this.traits = traits;
    this.room = room;
    this.needs = needs;
    this.beliefs = beliefs;
    this.watch = watch;
    this.routine = routine;
  }
}

/** Bookkeeping for one meal window, gathered while the crew eat. */
export interface MealServiceState {
  /** `${dayIndex}:${meal}`; one state exists per window with eaters. */
  key: string;
  day: number;
  meal: "breakfast" | "evening";
  /** The mess room the window is served in. */
  room: number;
  /** Ids of everyone who ate in the mess during the window, in order. */
  eaters: string[];
  /** Table groupings recorded as they formed: arrays of person ids. */
  tables: string[][];
  /** Id pairs (sorted, joined) whose gossip has already flowed. */
  pairs: Set<string>;
  /** A table pairing worth a chronicle clause, if one formed. */
  notable: { a: string; b: string; kind: "grudge" | "friends" } | null;
}

export interface CrewContext {
  ship: Ship;
  weather: Weather;
  /** The voyage, for the speech layer's situation read (the port
   *  ahead, the leg being sailed). Read-only here, like the rest. */
  voyage: Voyage;
  /** Recent presence snapshots, one per tick, oldest first. */
  history: Record<string, number>[];
  /** The meal window currently gathering, if anyone has eaten in it. */
  meal: MealServiceState | null;
  /** Last tick a table game started in each room, by room index. */
  lastGameTick: Map<number, number>;
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/**
 * Generate the crew of twelve. Identity draws (names, traits, needs,
 * beliefs) come from the given stream; watches and routines are drawn
 * from the routine stream, so the routine a person draws can never
 * reshuffle who they are.
 */
export function generateCrew(
  rng: Rng,
  ship: Ship,
  routineRng: Rng = rng,
): CrewMember[] {
  const firstNames = shuffled(rng, CONFIG.crewGen.firstNames);
  const lastNames = shuffled(rng, CONFIG.crewGen.lastNames);
  const roles = shuffled(rng, CONFIG.roles);
  const roster = roles.map((_, i) => `c${i}`);
  const nightRoles = pickNightWatchRoles(routineRng);

  const crew: CrewMember[] = roles.map((role, i) => {
    const traitPool = shuffled(rng, CONFIG.crewGen.traitPool);
    const traitCount = CONFIG.crewGen.minTraits + rng.int(2); // 2 or 3
    const traits = traitPool.slice(0, traitCount);
    const home = ship.firstRoomOfKind(role.home);
    const need = () =>
      CONFIG.crewGen.needMin +
      rng.next() * (CONFIG.crewGen.needMax - CONFIG.crewGen.needMin);
    const watch: WatchName = nightRoles.has(role.key) ? "night" : "day";
    return new CrewMember(
      roster[i] as string,
      `${firstNames[i]} ${lastNames[i]}`,
      role.key,
      role.title,
      role.affinity,
      Math.min(1, role.repair + rng.next() * 0.1),
      traits,
      home >= 0 ? home : 0,
      {
        energy: need(),
        hunger: need(),
        social: need(),
        morale: CONFIG.needs.moraleBase,
      },
      createBeliefs(roster),
      watch,
      makeRoutine(watch, traits, routineRng),
    );
  });

  // Seed pairwise beliefs, then a few directed rivalries with a head start.
  for (const member of crew) {
    for (const other of crew) {
      if (other === member) continue;
      member.beliefs.trust[other.id] = -0.1 + rng.next() * 0.5;
      member.beliefs.bond[other.id] = rng.next() * 0.25;
    }
  }
  const seenPairs = new Set<string>();
  for (let n = 0; n < CONFIG.crewGen.initialRivalries; n++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = rng.int(crew.length);
      const b = rng.int(crew.length);
      if (a === b) continue;
      const key = `${a}->${b}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const holder = crew[a] as CrewMember;
      const target = crew[b] as CrewMember;
      const trust = -(
        CONFIG.crewGen.rivalryTrustMin +
        rng.next() *
          (CONFIG.crewGen.rivalryTrustMax - CONFIG.crewGen.rivalryTrustMin)
      );
      holder.beliefs.trust[target.id] = trust;
      if (trust < CONFIG.grudge.threshold) {
        holder.beliefs.lowTrustSince[target.id] = 0;
      }
      break;
    }
  }
  return crew;
}

/** Stable string identity of the roster, for determinism tests. */
export function crewSignature(crew: readonly CrewMember[]): string {
  return JSON.stringify(
    crew.map((m) => ({
      name: m.name,
      role: m.roleKey,
      traits: m.traits,
      room: m.room,
      watch: m.watch,
    })),
  );
}

function traitEffect(member: CrewMember, key: string): number {
  return member.traits.reduce(
    (sum, trait) =>
      sum +
      ((CONFIG.traitEffects[trait] as Record<string, number> | undefined)?.[
        key
      ] ?? 0),
    0,
  );
}

function eatScore(member: CrewMember): number {
  const deficit = 1 - member.needs.hunger;
  return (
    CONFIG.scores.eatBase *
    (CONFIG.scores.eatUrgencyBase + deficit * CONFIG.scores.eatUrgencyPerDeficit)
  );
}

function restScore(member: CrewMember, weather: Weather, inQuarters: boolean): number {
  const deficit = 1 - member.needs.energy;
  const base =
    deficit *
    CONFIG.scores.restPerDeficit *
    (inQuarters ? 1 : CONFIG.needs.restOffQuartersFactor);
  return Math.max(
    CONFIG.scores.restFloor,
    base + (weather.storm ? CONFIG.scores.restStormBonus : 0),
  );
}

function workScore(member: CrewMember): number {
  return member.needs.energy > 0.2
    ? CONFIG.scores.work
    : CONFIG.scores.workLowEnergy;
}

function socialScore(member: CrewMember, other: CrewMember): number {
  const deficit = 1 - member.needs.social;
  const base =
    CONFIG.scores.socializeBase +
    deficit * CONFIG.scores.socializePerDeficit +
    traitEffect(member, "socialDesire");
  return Math.max(
    CONFIG.scores.socializeFloor,
    base * (0.6 + bondOf(member.beliefs, other.id)),
  );
}

function canRepair(member: CrewMember, system: ShipSystem): boolean {
  return member.affinity.includes(system.kind) && member.repairSkill >= 0.2;
}

function pickWorkSystem(
  member: CrewMember,
  systemsHere: readonly ShipSystem[],
): ShipSystem {
  const damaged = systemsHere.filter((s) => s.damaged);
  const pool = damaged.length > 0 ? damaged : systemsHere;
  const affinity = pool.filter((s) => member.affinity.includes(s.kind));
  const choices = affinity.length > 0 ? affinity : pool;
  return choices.reduce((a, b) => (a.condition <= b.condition ? a : b));
}

function buildCandidates(
  member: CrewMember,
  crew: readonly CrewMember[],
  ctx: CrewContext,
  tick: number,
): Candidate[] {
  const { ship, weather } = ctx;
  const routine = CONFIG.routine;
  const candidates: Candidate[] = [];
  const roomKind = ship.roomKind(member.room);
  const systemsHere = ship.systemsInRoom(member.room);

  // The schedule comes first: the member's current block shapes what is
  // worth doing. In a work block the ship's business runs at full score;
  // in free time it fades; at a meal it waits; in the sleep block it all
  // but vanishes. Needs and emergencies push back through the same scores:
  // hunger still drags a sleeper toward the mess, and a failed system in
  // the member's own department ignores the schedule completely.
  const block: BlockKind = blockAt(member.routine, tick);
  let workFactor =
    block === "work"
      ? 1
      : block === "free"
        ? routine.freeWorkFactor
        : block === "meal"
          ? routine.mealWorkFactor
          : routine.sleepWorkFactor;
  // Under emergency powers the watches dissolve: compulsory duties.
  if (
    ship.councilPublic !== null &&
    tick < ship.councilPublic.emergencyUntil
  ) {
    workFactor = 1;
  }
  // The wounded and the sick work at the pace their bodies allow.
  workFactor *= Math.max(
    0.25,
    1 - totalSeverity(member) * 0.45 - member.body.sick * 0.3,
  );
  if (member.body.health < 0.45) workFactor *= 0.6;

  if (roomKind === "mess" && tick >= member.messBanUntil) {
    candidates.push({
      key: "eat",
      base:
        CONFIG.scores.eatBase *
        (block === "meal" ? routine.mealEatFactor : 1),
      urgency:
        CONFIG.scores.eatUrgencyBase +
        (1 - member.needs.hunger) * CONFIG.scores.eatUrgencyPerDeficit,
    });
  }
  let restBase = restScore(member, weather, roomKind === "quarters");
  if (block === "sleep") {
    restBase = Math.max(
      restBase,
      routine.sleepRestBase *
        (roomKind === "quarters" ? 1 : CONFIG.needs.restOffQuartersFactor),
    );
  }
  candidates.push({ key: "rest", base: restBase });

  if (systemsHere.length > 0) {
    const system = pickWorkSystem(member, systemsHere);
    let base = workScore(member) * workFactor;
    if (!member.affinity.includes(system.kind)) base *= 0.6;
    candidates.push({ key: `work:${system.id}`, base });
    for (const s of systemsHere) {
      if (s.damaged && canRepair(member, s) && tick >= member.restrictedUntil) {
        candidates.push({
          key: `repair:${s.id}`,
          base:
            CONFIG.scores.repairBase *
            (block === "sleep" && !s.failed ? routine.sleepRepairFactor : 1),
          urgency: 1 + (1 - s.condition),
        });
      }
    }
  } else {
    candidates.push({
      key: "work:generic",
      base: workScore(member) * CONFIG.scores.genericWorkFactor * workFactor,
    });
  }

  // Treatment is work: in the medbay, a member who can tend the
  // medbay unit can tend the wounded lying there. The medic is
  // best at it; anyone's hands are better than none (and the
  // health system prices lay treatment at its own rate).
  if (roomKind === "medbay") {
    for (const other of crew) {
      if (other === member || other.dead || other.ashore || other.leftShip) {
        continue;
      }
      if (other.room !== member.room) continue;
      if (totalSeverity(other) <= 0 && other.body.sick < 0.4) continue;
      const skill = member.affinity.includes("medbay unit")
        ? 0.6 + member.repairSkill
        : 0.25;
      candidates.push({
        key: `treat:${other.id}`,
        base: CONFIG.scores.repairBase * skill * workFactor + totalSeverity(other),
      });
    }
  }

  // Nobody holds a conversation in their sleep; free time and meals are
  // when the ship talks.
  if (block !== "sleep") {
    const socialFactor =
      block === "free" || block === "meal" ? routine.freeSocialFactor : 1;
    for (const other of crew) {
      if (other === member || other.room !== member.room) continue;
      if (other.ashore || other.dead || other.leftShip) continue;
      if (trustOf(member.beliefs, other.id) < CONFIG.relationships.socializeMinTrust) {
        continue;
      }
      candidates.push({
        key: `socialize:${other.id}`,
        base: socialScore(member, other) * socialFactor,
      });
    }
  }

  // Free-time texture: a table game in the mess when company is present,
  // exercise in the gym, reading in quarters. Cooldowns keep these
  // occasions, not a per-tick drumbeat.
  if (block === "free" && tick - member.lastLeisureTick >= routine.leisureCooldownTicks) {
    if (roomKind === "mess") {
      const company = crew.some(
        (other) =>
          other !== member &&
          !other.ashore &&
          other.room === member.room &&
          other.activity !== "rest",
      );
      const lastGame = ctx.lastGameTick.get(member.room) ?? -1000000;
      if (company && tick - lastGame >= routine.gameCooldownTicks) {
        candidates.push({ key: "game", base: routine.gameBase });
      }
    } else if (roomKind === "gym") {
      candidates.push({ key: "exercise", base: routine.exerciseBase });
    } else if (roomKind === "quarters") {
      candidates.push({ key: "read", base: routine.readBase });
    }
  }

  const sabotage =
    tick < member.restrictedUntil
      ? null
      : sabotageCandidate(member, ship, crew, tick);
  if (sabotage !== null) candidates.push(sabotage);

  // Travel: one candidate per destination room worth reaching.
  const { dist } = ship.distancesFrom(member.room);
  const desires = new Map<number, number>();
  const consider = (roomIndex: number, desire: number): void => {
    if (roomIndex < 0 || roomIndex === member.room || desire <= 0) return;
    if (desire > (desires.get(roomIndex) ?? 0)) desires.set(roomIndex, desire);
  };
  consider(ship.firstRoomOfKind("mess"), eatScore(member));
  if (block === "meal") {
    // The whole awake ship comes to table when the window opens.
    consider(
      ship.firstRoomOfKind("mess"),
      Math.max(eatScore(member), routine.mealTravelDesire),
    );
  }
  consider(ship.firstRoomOfKind("quarters"), restScore(member, weather, true));
  if (block === "free") {
    consider(ship.firstRoomOfKind("gym"), routine.freeGymDesire);
    consider(ship.firstRoomOfKind("quarters"), routine.freeQuartersDesire);
  }
  if (block === "work" || block === "free") {
    const duty = ship.systems
      .filter((s) => member.affinity.includes(s.kind))
      .reduce<ShipSystem | null>(
        (best, s) => (best === null || s.condition < best.condition ? s : best),
        null,
      );
    if (duty !== null) {
      consider(
        duty.room,
        workScore(member) * (block === "free" ? routine.freeWorkFactor : 1),
      );
    }
  }
  for (const s of ship.systems) {
    if (s.damaged && canRepair(member, s)) {
      let desire = CONFIG.scores.repairBase * (1 + (1 - s.condition));
      // A failed system is an emergency in any block, even at 3 a.m.
      if (s.failed) desire *= routine.emergencyRepairFactor;
      consider(s.room, desire);
    }
  }
  if (block !== "sleep" && block !== "meal") {
    let bestSocial: CrewMember | null = null;
    let bestSocialScore = 0;
    for (const other of crew) {
      if (other === member || other.room === member.room) continue;
      if (trustOf(member.beliefs, other.id) < CONFIG.relationships.socializeMinTrust) {
        continue;
      }
      const score = socialScore(member, other);
      if (score > bestSocialScore) {
        bestSocialScore = score;
        bestSocial = other;
      }
    }
    if (bestSocial !== null) consider(bestSocial.room, bestSocialScore);
  }
  if (member.roleKey === "security officer" && block === "work") {
    const room = ship.rooms[member.room];
    if (room !== undefined) {
      for (const neighbor of room.neighbors) {
        consider(neighbor, CONFIG.scores.patrol);
      }
    }
  }
  for (const [roomIndex, desire] of desires) {
    candidates.push({
      key: `go:${roomIndex}`,
      base:
        desire * CONFIG.scores.travelDiscount -
        CONFIG.scores.travelDistanceCost * (dist[roomIndex] ?? 1),
    });
  }

  candidates.push({ key: "idle", base: CONFIG.scores.idle });
  return candidates;
}

function driftWithCoworkers(
  w: World,
  member: CrewMember,
  crew: readonly CrewMember[],
): void {
  for (const other of crew) {
    if (other === member || other.room !== member.room) continue;
    if (other.activity === "rest") continue;
    driftTrust(member.beliefs, other.id, CONFIG.relationships.workTrustDrift);
    driftBond(member.beliefs, other.id, CONFIG.relationships.workBondDrift);
    driftTrust(other.beliefs, member.id, CONFIG.relationships.workTrustDrift);
    driftBond(other.beliefs, member.id, CONFIG.relationships.workBondDrift);
    reportMilestones(w, member, other.id);
  }
}

function resolveSocialize(
  w: World,
  member: CrewMember,
  target: CrewMember,
  ctx: CrewContext,
): void {
  const refused =
    target.activity === "rest" ||
    target.activity === "repair" ||
    trustOf(target.beliefs, member.id) < CONFIG.relationships.refuseTrust;
  member.activity = "socialize";
  if (refused) {
    // A snub: being brushed off by someone busy, resting, or cold toward
    // you costs them a little of your trust.
    driftTrust(member.beliefs, target.id, -CONFIG.relationships.snubTrustHit);
    member.needs.social = clamp01(member.needs.social + 0.01);
    w.emit("socialize_refused", [member.id], {
      with: target.id,
      room: member.room,
    });
    return;
  }
  member.needs.social = clamp01(
    member.needs.social + CONFIG.needs.socialRestore,
  );
  target.needs.social = clamp01(
    target.needs.social + CONFIG.needs.socialRestore * 0.8,
  );
  driftTrust(member.beliefs, target.id, CONFIG.relationships.socializeTrustDrift);
  driftBond(member.beliefs, target.id, CONFIG.relationships.socializeBondDrift);
  driftTrust(target.beliefs, member.id, CONFIG.relationships.socializeTrustDrift);
  driftBond(target.beliefs, member.id, CONFIG.relationships.socializeBondDrift);
  w.emit("socialize", [member.id], { with: target.id, room: member.room });
  reportMilestones(w, member, target.id);
  reportMilestones(w, target, member.id);

  // Talk in shared free time is where rumour travels: suspicion passes
  // between the two in both directions, and companionship itself nudges
  // trust a little further along the way it already leans. Workaday chat
  // carries no gossip; the pair must both be off the clock or at table.
  const memberBlock = blockAt(member.routine, w.tick);
  const targetBlock = blockAt(target.routine, w.tick);
  const sharedLeisure =
    (memberBlock === "free" || memberBlock === "meal") &&
    (targetBlock === "free" || targetBlock === "meal");
  if (sharedLeisure) {
    spreadGossip(w, member, target);
    spreadGossip(w, target, member);
    const drift = CONFIG.routine.companionDrift;
    const memberLean = trustOf(member.beliefs, target.id);
    if (memberLean !== 0) {
      driftTrust(member.beliefs, target.id, Math.sign(memberLean) * drift);
    }
    const targetLean = trustOf(target.beliefs, member.id);
    if (targetLean !== 0) {
      driftTrust(target.beliefs, member.id, Math.sign(targetLean) * drift);
    }
    // Talk, occasionally, out loud: the speech layer reads the
    // pair and the ship's situation and writes only its own
    // events. The gossip above may already have spoken for one
    // of them; the shared cooldown in the speech layer keeps a
    // pair from holding forth in stereo.
    maybeSocialSpeech(w, member, target, ctx.ship, ctx.weather, ctx.voyage, "social");
  }
}

function updateMorale(
  w: World,
  member: CrewMember,
  ctx: CrewContext,
  roomOccupancy: number,
): void {
  let target = CONFIG.needs.moraleBase;
  for (const system of ctx.ship.systems) {
    if (system.condition < CONFIG.systems.strainThreshold) {
      target -= system.kind === "life support" ? 0.16 : 0.06;
    }
  }
  if (ctx.weather.storm) target -= 0.05;
  if (member.beliefs.grudges.length > 0) target -= 0.06;
  if (w.tick - member.lastAccusationTick < CONFIG.accusation.moraleShadowTicks) {
    target -= CONFIG.accusation.moraleShadowHit;
  }
  if (member.needs.social < 0.25) target -= 0.08;
  if (roomOccupancy >= CONFIG.relationships.crowdThreshold) target -= 0.05;
  target = target < 0.05 ? 0.05 : target > 0.95 ? 0.95 : target;
  member.needs.morale = clamp01(
    member.needs.morale + (target - member.needs.morale) * CONFIG.needs.moraleRate,
  );
}

function applyChoice(
  w: World,
  member: CrewMember,
  crew: readonly CrewMember[],
  ctx: CrewContext,
  key: string,
): void {
  const { ship } = ctx;
  if (!key.startsWith("repair:")) member.repairTarget = null;
  if (!key.startsWith("treat:")) member.treatTarget = null;
  if (key.startsWith("treat:")) {
    const target = crew.find((c) => c.id === key.slice("treat:".length));
    member.activity = "treat";
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.needs.workEnergyCost,
    );
    if (target !== undefined && !target.dead) {
      // The health system prices the treatment (medic's skill,
      // medbay condition by place, lay hands when there is no
      // doctor): here we only record whose hands are on them.
      target.body.treatedUntil = w.tick + 1;
      if (member.treatTarget !== target.id) {
        member.treatTarget = target.id;
        w.emit("treatment_started", [member.id], {
          medic: member.id,
          person: target.id,
          room: member.room,
          lay: !member.affinity.includes("medbay unit"),
        });
      }
    }
    return;
  }
  if (key.startsWith("go:")) {
    const target = Number(key.slice("go:".length));
    const { prev } = ship.distancesFrom(member.room);
    const from = member.room;
    member.room = ship.stepToward(member.room, target, prev);
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.needs.moveEnergyCost,
    );
    member.activity = "move";
    w.emit("move", [member.id], { from, to: member.room, towards: target });
    return;
  }
  if (key === "eat") {
    // Eating draws on the stores in spirit (the flat daily draw is
    // the stores system's own accounting): under rationing the
    // plate is smaller and hunger caps at the ration line, and
    // with food gone there is nothing to restore from at all.
    const stores = ship.stores;
    const foodOut = stores !== null && stores.byKey.food.qtyMilli <= 0;
    const cap =
      stores !== null && stores.rationing.food
        ? CONFIG.stores.rationing.hungerCap
        : 1;
    if (!foodOut && member.needs.hunger < cap) {
      member.needs.hunger = clamp01(
        Math.min(cap, member.needs.hunger + CONFIG.needs.eatRestore),
      );
    }
    member.activity = "eat";
    const data: Record<string, unknown> = { room: member.room };
    const mealName = mealWindowAt(w.tick);
    if (mealName !== null && ship.roomKind(member.room) === "mess") {
      // Eating in the mess during a meal window is eating at table: the
      // window gathers the company, the tables, and the gossip.
      data.window = mealName;
      data.tablemates = recordMealAttendance(w, member, crew, ctx, mealName);
    }
    w.emit("meal", [member.id], data);
    return;
  }
  if (key === "rest") {
    const inQuarters = ship.roomKind(member.room) === "quarters";
    const amount =
      CONFIG.needs.restRestore *
      (inQuarters ? 1 : CONFIG.needs.restOffQuartersFactor);
    member.needs.energy = clamp01(member.needs.energy + amount);
    // One event per rest spell, not per tick, as with repair sessions:
    // the log records that a person went to rest, not every minute of it.
    const startingSpell = member.activity !== "rest";
    member.activity = "rest";
    if (startingSpell) {
      w.emit("rest", [member.id], {
        room: member.room,
        energy: r3(member.needs.energy),
      });
    }
    return;
  }
  if (key.startsWith("work:")) {
    member.activity = "work";
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.needs.workEnergyCost,
    );
    const systemId = key.slice("work:".length);
    if (systemId !== "generic") {
      const system = ship.systemById(systemId);
      const factor =
        (0.5 + member.repairSkill) * (1 + traitEffect(member, "maintain"));
      applyConditionDelta(
        w,
        system,
        CONFIG.systems.maintainPerTick * factor,
        member.id,
        "work",
      );
    }
    driftWithCoworkers(w, member, crew);
    w.emit("work", [member.id], {
      room: member.room,
      system: systemId === "generic" ? null : systemId,
    });
    return;
  }
  if (key.startsWith("repair:")) {
    const system = ship.systemById(key.slice("repair:".length));
    const amount =
      CONFIG.systems.repairPerTick *
      (0.5 + member.repairSkill) *
      (1 + traitEffect(member, "repair"));
    // A repair pays for the condition it restores out of the parts
    // locker; a short locker buys a smaller repair.
    applyConditionDelta(
      w,
      system,
      gateRepairDelta(ship, amount, w.tick),
      member.id,
      "repair",
    );
    member.activity = "repair";
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.needs.workEnergyCost,
    );
    // One event per repair session, not per tick: the log records that a
    // repair began; system_repaired records that it finished.
    if (member.repairTarget !== system.id) {
      member.repairTarget = system.id;
      w.emit("repair", [member.id], { system: system.id, room: member.room });
    }
    return;
  }
  if (key.startsWith("socialize:")) {
    const target = crew.find((c) => c.id === key.slice("socialize:".length));
    if (target !== undefined) resolveSocialize(w, member, target, ctx);
    return;
  }
  if (key.startsWith("sabotage:")) {
    const system = ship.systemById(key.slice("sabotage:".length));
    applySabotage(w, ship, crew, member, system, ctx.history);
    // The culprit looks busy, like anyone else at work.
    member.activity = "work";
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.needs.workEnergyCost,
    );
    return;
  }
  if (key === "game") {
    resolveGame(w, member, crew, ctx);
    return;
  }
  if (key === "exercise") {
    const partner = crew.find(
      (other) =>
        other !== member &&
        !other.ashore &&
        other.room === member.room &&
        other.activity !== "rest",
    );
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.routine.exerciseEnergyCost,
    );
    member.needs.morale = clamp01(
      member.needs.morale + CONFIG.routine.exerciseMorale,
    );
    member.lastLeisureTick = w.tick;
    member.activity = "exercise";
    if (partner !== undefined) {
      partner.needs.morale = clamp01(
        partner.needs.morale + CONFIG.routine.exerciseMorale * 0.6,
      );
      driftTrust(member.beliefs, partner.id, CONFIG.routine.gameTrustDrift);
      driftBond(member.beliefs, partner.id, CONFIG.routine.gameBondDrift);
      driftTrust(partner.beliefs, member.id, CONFIG.routine.gameTrustDrift);
      driftBond(partner.beliefs, member.id, CONFIG.routine.gameBondDrift);
      reportMilestones(w, member, partner.id);
      reportMilestones(w, partner, member.id);
    }
    w.emit("leisure_exercise", [member.id], {
      room: member.room,
      with: partner !== undefined ? partner.id : null,
    });
    return;
  }
  if (key === "read") {
    member.needs.morale = clamp01(
      member.needs.morale + CONFIG.routine.readMorale,
    );
    member.lastLeisureTick = w.tick;
    member.activity = "read";
    w.emit("leisure_read", [member.id], { room: member.room });
    return;
  }
  member.activity = "idle";
}

/**
 * A table game in the mess: the member and the company present (up to the
 * table size) play, one of them wins, and an hour of cards does what
 * cards do: company restored, small change in how the players regard
 * each other, a lift for the winner. The winner is drawn on the
 * "routine" stream, so the game replays exactly.
 */
function resolveGame(
  w: World,
  member: CrewMember,
  crew: readonly CrewMember[],
  ctx: CrewContext,
): void {
  const cfg = CONFIG.routine;
  const company = crew.filter(
    (other) =>
      other !== member &&
      !other.ashore &&
      other.room === member.room &&
      other.activity !== "rest",
  );
  const participants = [member, ...company].slice(0, cfg.gameMaxPlayers);
  if (participants.length < cfg.gameMinPlayers) {
    member.activity = "idle";
    return;
  }
  const winner = participants[
    w.rng.get("routine").int(participants.length)
  ] as CrewMember;
  for (const player of participants) {
    player.needs.social = clamp01(player.needs.social + cfg.gameSocialRestore);
    player.needs.morale = clamp01(
      player.needs.morale +
        (player === winner ? cfg.gameWinnerMorale : cfg.gamePlayerMorale),
    );
    player.lastLeisureTick = w.tick;
    for (const other of participants) {
      if (other === player) continue;
      driftTrust(player.beliefs, other.id, cfg.gameTrustDrift);
      driftBond(player.beliefs, other.id, cfg.gameBondDrift);
    }
  }
  for (const player of participants) {
    for (const other of participants) {
      if (other !== player) reportMilestones(w, player, other.id);
    }
  }
  ctx.lastGameTick.set(member.room, w.tick);
  member.activity = "socialize";
  w.emit("leisure_game", [member.id], {
    room: member.room,
    participants: participants.map((p) => p.id),
    winner: winner.id,
  });
}

/**
 * Record one person eating in the mess during a meal window: gather the
 * window's state, seat them at a table formed from who is actually
 * present and awake, flow the table's gossip once per pair, and return
 * the tablemates' ids for the meal event.
 */
function recordMealAttendance(
  w: World,
  member: CrewMember,
  crew: readonly CrewMember[],
  ctx: CrewContext,
  mealName: "breakfast" | "evening",
): string[] {
  const day = Math.floor(w.tick / CONFIG.time.ticksPerDay);
  const key = `${day}:${mealName}`;
  let state = ctx.meal;
  if (state === null || state.key !== key) {
    state = {
      key,
      day,
      meal: mealName,
      room: member.room,
      eaters: [],
      tables: [],
      pairs: new Set<string>(),
      notable: null,
    };
    ctx.meal = state;
  }
  if (!state.eaters.includes(member.id)) state.eaters.push(member.id);

  const present = crew.filter(
    (other) =>
      !other.ashore && other.room === member.room && other.activity !== "rest",
  );
  const size = CONFIG.routine.gameMaxPlayers;
  let table: CrewMember[] = [member];
  for (let i = 0; i < present.length; i += size) {
    const chunk = present.slice(i, i + size);
    if (chunk.includes(member)) table = chunk;
  }
  const tableIds = table.map((p) => p.id);
  if (!state.tables.some((t) => t.join(",") === tableIds.join(","))) {
    state.tables.push(tableIds);
  }
  if (state.notable === null) {
    state.notable = notableTablePairing(table);
  }

  const tablemates: string[] = [];
  for (const other of table) {
    if (other === member) continue;
    tablemates.push(other.id);
    const pairKey = [member.id, other.id].sort().join("|");
    if (state.pairs.has(pairKey)) continue;
    state.pairs.add(pairKey);
    spreadGossip(w, member, other);
    spreadGossip(w, other, member);
    // Table talk, once per pair per window: the speech layer
    // decides whether either of them has anything to say.
    maybeSocialSpeech(w, member, other, ctx.ship, ctx.weather, ctx.voyage, "table");
  }
  return tablemates;
}

/**
 * The pairing at a table that earns a chronicle clause: two people at
 * one table with a grudge between them, or two fast friends who took a
 * table together. Grudges outrank friendships; first found wins.
 */
function notableTablePairing(
  table: readonly CrewMember[],
): MealServiceState["notable"] {
  for (const a of table) {
    for (const b of table) {
      if (a !== b && a.beliefs.grudges.includes(b.id)) {
        return { a: a.id, b: b.id, kind: "grudge" };
      }
    }
  }
  for (const a of table) {
    for (const b of table) {
      if (
        a !== b &&
        bondOf(a.beliefs, b.id) >= CONFIG.relationships.bondMilestoneHigh &&
        bondOf(b.beliefs, a.id) >= CONFIG.relationships.bondMilestoneHigh
      ) {
        return { a: a.id, b: b.id, kind: "friends" };
      }
    }
  }
  return null;
}

/**
 * When a meal window closes, close its book: one summary event for the
 * whole window, naming how many sat down, rather than a line per eater.
 */
function flushMealService(w: World, ctx: CrewContext): void {
  const state = ctx.meal;
  if (state === null) return;
  const day = Math.floor(w.tick / CONFIG.time.ticksPerDay);
  const tod = w.tick % CONFIG.time.ticksPerDay;
  const endHour =
    state.meal === "breakfast"
      ? CONFIG.routine.breakfastEndHour
      : CONFIG.routine.eveningEndHour;
  const ticksPerHour = CONFIG.time.ticksPerDay / 24;
  if (day === state.day && tod < endHour * ticksPerHour) return;
  ctx.meal = null;
  const data: Record<string, unknown> = {
    meal: state.meal,
    room: state.room,
    count: state.eaters.length,
    tables: state.tables,
  };
  if (state.notable !== null) {
    data.notableA = state.notable.a;
    data.notableB = state.notable.b;
    data.notableKind = state.notable.kind;
  }
  w.emit("meal_service", [], data);
}

/** One tick of crew behaviour, in roster order. */
export function stepCrew(
  w: World,
  crew: readonly CrewMember[],
  ctx: CrewContext,
): void {
  // A meal window that ended with the last tick gets its summary first,
  // before anyone acts in the new hour.
  flushMealService(w, ctx);

  // An ended ship (lost, or crew collapsed) has no crew decisions
  // left to make: the log quiets to the ship's own noises.
  if (ctx.ship.ended) return;

  const snapshot: Record<string, number> = {};
  for (const member of crew) snapshot[member.id] = member.room;
  ctx.history.push(snapshot);
  while (ctx.history.length > CONFIG.sabotage.witnessWindowTicks) {
    ctx.history.shift();
  }

  const occupancy = new Array<number>(ctx.ship.roomCount).fill(0);
  for (const member of crew) {
    if (member.ashore || member.dead || member.leftShip) continue;
    occupancy[member.room] = (occupancy[member.room] as number) + 1;
  }

  for (const member of crew) {
    member.needs.energy = clamp01(
      member.needs.energy - CONFIG.needs.energyDecay,
    );
    member.needs.hunger = clamp01(
      member.needs.hunger - CONFIG.needs.hungerDecay,
    );
    member.needs.social = clamp01(
      member.needs.social - CONFIG.needs.socialDecay,
    );
    updateMorale(w, member, ctx, occupancy[member.room] as number);

    // The dead do not act, and the gone are gone. The confined sit
    // in quarters under sentence: needs still run, no decision is
    // drawn, and the room is the sentence's room.
    if (member.dead) {
      member.activity = "dead";
      continue;
    }
    if (member.leftShip) {
      member.activity = "gone";
      continue;
    }
    if (w.tick < member.confinedUntil) {
      const quarters = ctx.ship.firstRoomOfKind("quarters");
      if (quarters >= 0) member.room = quarters;
      member.activity = "confined";
      // Confinement is not starvation: meals are brought, and a
      // bunk in quarters rests, slowly. The sentence is the room
      // and the idleness, not the body.
      member.needs.hunger = clamp01(member.needs.hunger + 0.0018);
      member.needs.energy = clamp01(member.needs.energy + 0.01);
      continue;
    }

    // Ashore on leave: the body is at the port, not the post. Needs
    // still decay (applied above), company and novelty restore the
    // social self faster than any hour aboard, and no decision is
    // drawn: there is nothing to decide from a dockside cafe.
    if (member.ashore) {
      member.needs.social = clamp01(
        member.needs.social + CONFIG.stores.port.shoreSocialPerTick,
      );
      member.needs.morale = clamp01(
        member.needs.morale + CONFIG.stores.port.shoreMoralePerTick,
      );
      member.activity = "ashore";
      continue;
    }

    // Crowding stress: too many people in one room frays small trusts.
    // A shared meal is the exception: a full mess at dinner is the
    // routine working as intended, not a crowd.
    if (
      (occupancy[member.room] as number) >= CONFIG.relationships.crowdThreshold &&
      blockAt(member.routine, w.tick) !== "meal"
    ) {
      const lonerFactor = member.traits.includes("loner") ? 2 : 1;
      for (const other of crew) {
        if (other !== member && other.room === member.room) {
          driftTrust(
            member.beliefs,
            other.id,
            -CONFIG.relationships.crowdTrustHit * lonerFactor,
          );
        }
      }
    }

    const candidates = buildCandidates(member, crew, ctx, w.tick);
    const chosen = w.decisions.choose(member.id, candidates, {
      tick: w.tick,
      purpose: "act",
    });
    applyChoice(w, member, crew, ctx, (candidates[chosen] as Candidate).key);
  }
}

/** Invariant check: needs and beliefs in range, everyone in a real room. */
export function checkCrewState(
  crew: readonly CrewMember[],
  ship: Ship,
): void {
  for (const member of crew) {
    for (const [label, value] of Object.entries(member.needs)) {
      if (value < 0 || value > 1) {
        throw new Error(`${member.id} need ${label} out of range: ${value}`);
      }
    }
    if (member.room < 0 || member.room >= ship.roomCount) {
      throw new Error(`${member.id} in invalid room ${member.room}`);
    }
    for (const [id, value] of Object.entries(member.beliefs.trust)) {
      if (value < -1 || value > 1) {
        throw new Error(`${member.id} trust toward ${id} out of range: ${value}`);
      }
    }
    for (const [label, table] of [
      ["bond", member.beliefs.bond],
      ["suspicion", member.beliefs.suspicion],
    ] as const) {
      for (const [id, value] of Object.entries(table)) {
        if (value < 0 || value > 1) {
          throw new Error(
            `${member.id} ${label} toward ${id} out of range: ${value}`,
          );
        }
      }
    }
  }
}
