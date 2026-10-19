// The first incident generator: grudges incite sabotage.
//
// A crew member who holds a grudge, who is alone in a room with a ship
// system, and whose grudge is strong (and whose traits let anger win over
// discipline) gains a sabotage candidate. If it is chosen, the act is
// recorded in the true event log with the culprit. What the crew get is
// not truth but evidence: everyone forms suspicion from who was seen
// near the room in the surrounding ticks, weighted by how much they
// already distrusted each suspect. A bystander who lingered nearby can
// draw more suspicion than they deserve, and the real culprit may draw
// less. Wrong accusations are possible by construction.

import type { Candidate } from "../decision/decisions.ts";
import type { World } from "../engine/engine.ts";
import type { CrewMember } from "../entities/crew.ts";
import { r3 } from "../log/events.ts";
import {
  driftSuspicion,
  driftTrust,
  trustOf,
  type Beliefs,
} from "../perception/beliefs.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Ship } from "../world/ship.ts";
import { applyConditionDelta, type ShipSystem } from "../world/systems.ts";

/** How strongly this person's traits push toward (or away from) sabotage. */
export function sabotageTraitFactor(traits: readonly string[]): number {
  const sum = traits.reduce(
    (acc, trait) => acc + (CONFIG.traitEffects[trait]?.sabotage ?? 0),
    0,
  );
  return Math.max(0.1, 1 + sum);
}

/**
 * Build the sabotage candidate for a crew member, or null when the act is
 * not on the table this tick: no grudge, company present, no system here,
 * or a grudge too weak for their temperament.
 */
export function sabotageCandidate(
  member: CrewMember,
  ship: Ship,
  crew: readonly CrewMember[],
  tick: number,
): Candidate | null {
  if (member.beliefs.grudges.length === 0) return null;
  if (tick - member.lastSabotageTick < CONFIG.sabotage.cooldownTicks) {
    return null;
  }
  const systemsHere = ship.systemsInRoom(member.room);
  if (systemsHere.length === 0) return null;
  for (const other of crew) {
    if (other !== member && other.room === member.room) return null;
  }

  // The grudge that burns hottest decides both motive and target system.
  let targetId = member.beliefs.grudges[0] as string;
  let intensity = 0;
  for (const grudgeId of member.beliefs.grudges) {
    const heat = -trustOf(member.beliefs, grudgeId);
    if (heat > intensity) {
      intensity = heat;
      targetId = grudgeId;
    }
  }
  const factor = sabotageTraitFactor(member.traits);
  if (intensity * factor < CONFIG.sabotage.minIntensity) return null;

  const target = crew.find((c) => c.id === targetId);
  const hated =
    target !== undefined
      ? systemsHere.find((s) => target.affinity.includes(s.kind))
      : undefined;
  const system =
    hated ??
    systemsHere.reduce((a, b) => (a.condition <= b.condition ? a : b));
  return {
    key: `sabotage:${system.id}`,
    base:
      CONFIG.sabotage.baseScore +
      intensity * factor * CONFIG.sabotage.intensityWeight,
  };
}

/**
 * Commit the act: damage the system, record the truth, and let every crew
 * member form suspicion from the presence evidence in the window.
 */
export function applySabotage(
  w: World,
  ship: Ship,
  crew: readonly CrewMember[],
  culprit: CrewMember,
  system: ShipSystem,
  history: readonly Record<string, number>[],
): void {
  const rng = w.rng.get("plots");
  const damage =
    CONFIG.sabotage.damageMin +
    rng.next() * (CONFIG.sabotage.damageMax - CONFIG.sabotage.damageMin);
  culprit.lastSabotageTick = w.tick;
  applyConditionDelta(w, system, -damage, culprit.id, "sabotage");
  // Catharsis: striking back spends some of the hottest grudge's heat.
  let hottest: string | null = null;
  let heat = 0;
  for (const grudgeId of culprit.beliefs.grudges) {
    const h = -trustOf(culprit.beliefs, grudgeId);
    if (h > heat) {
      heat = h;
      hottest = grudgeId;
    }
  }
  if (hottest !== null) {
    driftTrust(culprit.beliefs, hottest, CONFIG.sabotage.catharsisTrust);
  }
  w.emit("sabotage_committed", [culprit.id], {
    culprit: culprit.id,
    system: system.id,
    room: system.room,
    damage: r3(damage),
    condition: r3(system.condition),
  });

  // Evidence: for each person, the closest they were seen to the room
  // across the window, recent sightings counting for more. Observers
  // weight that evidence by how little they already trusted the suspect,
  // so old distrust poisons new evidence.
  const windowSize = Math.max(1, history.length);
  for (const observer of crew) {
    // A member ashore saw nothing and was seen nowhere: leave at a
    // port call is an alibi the evidence must honour.
    if (observer.ashore || observer.dead || observer.leftShip) continue;
    const anxiousBonus = observer.traits.reduce(
      (sum, trait) => sum + (CONFIG.traitEffects[trait]?.suspicion ?? 0),
      0,
    );
    for (const suspect of crew) {
      if (suspect === observer) continue;
      if (suspect.ashore || suspect.dead || suspect.leftShip) continue;
      let evidence = 0;
      for (let i = 0; i < history.length; i++) {
        const snapshot = history[i] as Record<string, number>;
        const seenRoom = snapshot[suspect.id];
        if (seenRoom === undefined) continue;
        const proximity = 1 / (1 + ship.distance(seenRoom, system.room));
        const age = history.length - 1 - i;
        const recency = 1 - 0.4 * (age / windowSize);
        if (proximity * recency > evidence) evidence = proximity * recency;
      }
      if (evidence <= 0) continue;
      const distrust = 0.75 + 0.5 * (0.5 - trustOf(observer.beliefs, suspect.id));
      const gain =
        CONFIG.sabotage.suspicionBase * evidence * distrust * (1 + anxiousBonus);
      driftSuspicion(observer.beliefs, suspect.id, gain);
    }
  }
}

/** The beliefs record a direct test can inspect after an act. */
export function suspicionsOf(member: CrewMember): Beliefs["suspicion"] {
  return member.beliefs.suspicion;
}
