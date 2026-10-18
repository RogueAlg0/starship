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
  trustOf,
  type Beliefs,
} from "../perception/beliefs.ts";
import { applySabotage, sabotageCandidate } from "../plots/sabotage.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Ship } from "../world/ship.ts";
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
  /** What they did most recently; read by crewmates deciding to approach. */
  activity = "idle";
  lastAccusationTick = -1000000;
  lastSabotageTick = -1000000;
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
  }
}

export interface CrewContext {
  ship: Ship;
  weather: Weather;
  /** Recent presence snapshots, one per tick, oldest first. */
  history: Record<string, number>[];
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

/** Generate the crew of twelve. Draws only from the given stream. */
export function generateCrew(rng: Rng, ship: Ship): CrewMember[] {
  const firstNames = shuffled(rng, CONFIG.crewGen.firstNames);
  const lastNames = shuffled(rng, CONFIG.crewGen.lastNames);
  const roles = shuffled(rng, CONFIG.roles);
  const roster = roles.map((_, i) => `c${i}`);

  const crew: CrewMember[] = roles.map((role, i) => {
    const traitPool = shuffled(rng, CONFIG.crewGen.traitPool);
    const traitCount = CONFIG.crewGen.minTraits + rng.int(2); // 2 or 3
    const traits = traitPool.slice(0, traitCount);
    const home = ship.firstRoomOfKind(role.home);
    const need = () =>
      CONFIG.crewGen.needMin +
      rng.next() * (CONFIG.crewGen.needMax - CONFIG.crewGen.needMin);
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
  const candidates: Candidate[] = [];
  const roomKind = ship.roomKind(member.room);
  const systemsHere = ship.systemsInRoom(member.room);

  if (roomKind === "mess") {
    candidates.push({
      key: "eat",
      base: CONFIG.scores.eatBase,
      urgency:
        CONFIG.scores.eatUrgencyBase +
        (1 - member.needs.hunger) * CONFIG.scores.eatUrgencyPerDeficit,
    });
  }
  candidates.push({
    key: "rest",
    base: restScore(member, weather, roomKind === "quarters"),
  });

  if (systemsHere.length > 0) {
    const system = pickWorkSystem(member, systemsHere);
    let base = workScore(member);
    if (!member.affinity.includes(system.kind)) base *= 0.6;
    candidates.push({ key: `work:${system.id}`, base });
    for (const s of systemsHere) {
      if (s.damaged && canRepair(member, s)) {
        candidates.push({
          key: `repair:${s.id}`,
          base: CONFIG.scores.repairBase,
          urgency: 1 + (1 - s.condition),
        });
      }
    }
  } else {
    candidates.push({
      key: "work:generic",
      base: workScore(member) * CONFIG.scores.genericWorkFactor,
    });
  }

  for (const other of crew) {
    if (other === member || other.room !== member.room) continue;
    if (trustOf(member.beliefs, other.id) < CONFIG.relationships.socializeMinTrust) {
      continue;
    }
    candidates.push({
      key: `socialize:${other.id}`,
      base: socialScore(member, other),
    });
  }

  const sabotage = sabotageCandidate(member, ship, crew, tick);
  if (sabotage !== null) candidates.push(sabotage);

  // Travel: one candidate per destination room worth reaching.
  const { dist } = ship.distancesFrom(member.room);
  const desires = new Map<number, number>();
  const consider = (roomIndex: number, desire: number): void => {
    if (roomIndex < 0 || roomIndex === member.room || desire <= 0) return;
    if (desire > (desires.get(roomIndex) ?? 0)) desires.set(roomIndex, desire);
  };
  consider(ship.firstRoomOfKind("mess"), eatScore(member));
  consider(ship.firstRoomOfKind("quarters"), restScore(member, weather, true));
  const duty = ship.systems
    .filter((s) => member.affinity.includes(s.kind))
    .reduce<ShipSystem | null>(
      (best, s) => (best === null || s.condition < best.condition ? s : best),
      null,
    );
  if (duty !== null) consider(duty.room, workScore(member));
  for (const s of ship.systems) {
    if (s.damaged && canRepair(member, s)) {
      consider(
        s.room,
        CONFIG.scores.repairBase * (1 + (1 - s.condition)),
      );
    }
  }
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
  if (member.roleKey === "security officer") {
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
    member.needs.hunger = clamp01(member.needs.hunger + CONFIG.needs.eatRestore);
    member.activity = "eat";
    w.emit("meal", [member.id], { room: member.room });
    return;
  }
  if (key === "rest") {
    const inQuarters = ship.roomKind(member.room) === "quarters";
    const amount =
      CONFIG.needs.restRestore *
      (inQuarters ? 1 : CONFIG.needs.restOffQuartersFactor);
    member.needs.energy = clamp01(member.needs.energy + amount);
    member.activity = "rest";
    w.emit("rest", [member.id], {
      room: member.room,
      energy: r3(member.needs.energy),
    });
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
    applyConditionDelta(w, system, amount, member.id, "repair");
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
    if (target !== undefined) resolveSocialize(w, member, target);
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
  member.activity = "idle";
}

/** One tick of crew behaviour, in roster order. */
export function stepCrew(
  w: World,
  crew: readonly CrewMember[],
  ctx: CrewContext,
): void {
  const snapshot: Record<string, number> = {};
  for (const member of crew) snapshot[member.id] = member.room;
  ctx.history.push(snapshot);
  while (ctx.history.length > CONFIG.sabotage.witnessWindowTicks) {
    ctx.history.shift();
  }

  const occupancy = new Array<number>(ctx.ship.roomCount).fill(0);
  for (const member of crew) {
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

    // Crowding stress: too many people in one room frays small trusts.
    if ((occupancy[member.room] as number) >= CONFIG.relationships.crowdThreshold) {
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
