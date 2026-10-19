// Beliefs: what a crew member thinks, as opposed to what is true.
//
// Each person carries directed relationships (trust toward each crewmate,
// bond with each), suspicions about who sabotages, and grudges. Beliefs
// are private: two people can hold opposite views of the same crewmate,
// and a suspicion can be entirely wrong. Decisions read beliefs; the event
// log holds truth; the drama lives in the gap.

import type { World } from "../engine/engine.ts";
import type { CrewMember } from "../entities/crew.ts";
import { r3 } from "../log/events.ts";
import { clamp01 } from "../world/systems.ts";
import { CONFIG } from "../scenario/config.ts";

export interface Beliefs {
  /** Directed trust toward each person id, in [-1, 1]. */
  trust: Record<string, number>;
  /** Directed bond with each person id, in [0, 1]. */
  bond: Record<string, number>;
  /** Suspicion that each person id commits sabotage, in [0, 1]. */
  suspicion: Record<string, number>;
  /** Person ids this person holds a grudge against. */
  grudges: string[];
  /** Tick at which trust toward a person fell below the grudge threshold. */
  lowTrustSince: Record<string, number>;
  /** Tick of this person's last accusation against each person id. */
  accusationsMade: Record<string, number>;
  /** Tick gossip last tipped this person's suspicion of each id over
   *  their accusation threshold (the recorded, chronicle-worthy tips). */
  gossipTips: Record<string, number>;
  /** Milestones already reported, keyed `${personId}:bond` / `:trust`. */
  milestones: Record<string, string>;
}

/** Blank beliefs about a roster: neutral until generation seeds them. */
export function createBeliefs(roster: readonly string[]): Beliefs {
  const trust: Record<string, number> = {};
  const bond: Record<string, number> = {};
  const suspicion: Record<string, number> = {};
  for (const id of roster) {
    trust[id] = 0;
    bond[id] = 0;
    suspicion[id] = 0;
  }
  return {
    trust,
    bond,
    suspicion,
    grudges: [],
    lowTrustSince: {},
    accusationsMade: {},
    gossipTips: {},
    milestones: {},
  };
}

export function trustOf(beliefs: Beliefs, id: string): number {
  return beliefs.trust[id] ?? 0;
}

export function bondOf(beliefs: Beliefs, id: string): number {
  return beliefs.bond[id] ?? 0;
}

export function suspicionOf(beliefs: Beliefs, id: string): number {
  return beliefs.suspicion[id] ?? 0;
}

export function driftTrust(beliefs: Beliefs, id: string, delta: number): void {
  const next = trustOf(beliefs, id) + delta;
  beliefs.trust[id] = next < -1 ? -1 : next > 1 ? 1 : next;
}

export function driftBond(beliefs: Beliefs, id: string, delta: number): void {
  beliefs.bond[id] = clamp01(bondOf(beliefs, id) + delta);
}

export function driftSuspicion(
  beliefs: Beliefs,
  id: string,
  delta: number,
): void {
  beliefs.suspicion[id] = clamp01(suspicionOf(beliefs, id) + delta);
}

/**
 * The suspicion level at which this person speaks an accusation aloud:
 * the configured line, lowered by traits that loosen tongues. The society
 * step accuses from it; gossip reports against it.
 */
export function accusationThresholdFor(member: CrewMember): number {
  return (
    CONFIG.accusation.threshold -
    member.traits.reduce(
      (sum, trait) => sum + (CONFIG.traitEffects[trait]?.accuse ?? 0),
      0,
    )
  );
}

/**
 * Gossip: the rumour engine, and the only road suspicion travels socially.
 *
 * When two people are actually together (a shared table, a shared free
 * hour; the callers guarantee the co-location), the speaker's suspicions
 * can take root in the listener: any suspicion the speaker holds at or
 * above the gossip threshold rises in the listener by a small amount,
 * scaled by how much the listener trusts the speaker, and never above
 * the level the speaker holds it at: you cannot catch more suspicion
 * than the teller has. Nor can rumour alone carry a listener past their
 * own accusation threshold: gossip can bring a person to the edge of
 * speaking, but the last step is always evidence or a public claim.
 * Ordinary gossip is silent in the log; only the moment a transferred
 * suspicion reaches the listener's accusation threshold is recorded,
 * because that is the moment rumour becomes a future accusation.
 */
export function spreadGossip(
  w: World,
  speaker: CrewMember,
  listener: CrewMember,
): void {
  const receptivity =
    0.5 + 0.5 * Math.max(0, trustOf(listener.beliefs, speaker.id));
  const threshold = accusationThresholdFor(listener);
  for (const id of Object.keys(speaker.beliefs.suspicion)) {
    if (id === speaker.id || id === listener.id) continue;
    const held = suspicionOf(speaker.beliefs, id);
    if (held < CONFIG.routine.gossipThreshold) continue;
    const before = suspicionOf(listener.beliefs, id);
    if (before >= held) continue;
    const after = Math.min(
      held,
      threshold,
      before + CONFIG.routine.gossipTransfer * receptivity,
    );
    if (after <= before) continue;
    driftSuspicion(listener.beliefs, id, after - before);
    // The tipping line fires when the crossing is news: a suspicion that
    // decays a hair below the line and is topped back up at the next
    // meal does not earn a second line inside the cooldown.
    const lastTip = listener.beliefs.gossipTips[id] ?? -1000000;
    if (
      before < threshold &&
      after >= threshold &&
      w.tick - lastTip >= CONFIG.routine.gossipTipCooldownTicks
    ) {
      listener.beliefs.gossipTips[id] = w.tick;
      w.emit("gossip", [speaker.id], {
        to: listener.id,
        about: id,
        room: speaker.room,
        suspicion: r3(after),
      });
    }
  }
}

/**
 * Report relationship milestones for one directed pair: a bond crossing
 * the configured thresholds upward, or trust breaking downward. Each
 * crossing is emitted once; the chronicle turns these into the social
 * highlights of a run.
 */
export function reportMilestones(
  w: World,
  holder: CrewMember,
  otherId: string,
): void {
  const beliefs = holder.beliefs;
  const bondKey = `${otherId}:bond`;
  const bond = bondOf(beliefs, otherId);
  const level =
    bond >= CONFIG.relationships.bondMilestoneHigh
      ? "2"
      : bond >= CONFIG.relationships.bondMilestone
        ? "1"
        : "0";
  if (level > (beliefs.milestones[bondKey] ?? "0")) {
    beliefs.milestones[bondKey] = level;
    w.emit("bond_formed", [holder.id], {
      with: otherId,
      bond: Math.round(bond * 1000) / 1000,
      level: Number(level),
    });
  }
  const trustKey = `${otherId}:trust`;
  if (
    trustOf(beliefs, otherId) <= CONFIG.relationships.trustBrokenThreshold &&
    beliefs.milestones[trustKey] !== "broken"
  ) {
    beliefs.milestones[trustKey] = "broken";
    w.emit("trust_broken", [holder.id], {
      with: otherId,
      trust: Math.round(trustOf(beliefs, otherId) * 1000) / 1000,
    });
  }
}

/**
 * The society step, run after the crew have acted: grudges form where low
 * trust has stayed low, and accusations are spoken where suspicion has
 * crossed the line. Both are public facts with private causes.
 */
export function stepSociety(w: World, crew: readonly CrewMember[]): void {
  // Suspicion fades a little every tick; memories are not ledgers.
  for (const holder of crew) {
    for (const id of Object.keys(holder.beliefs.suspicion)) {
      const value = holder.beliefs.suspicion[id] as number;
      if (value > 0) {
        holder.beliefs.suspicion[id] =
          value * (1 - CONFIG.accusation.suspicionDecayPerTick);
      }
    }
  }

  for (const holder of crew) {
    for (const other of crew) {
      if (other === holder) continue;
      const trust = trustOf(holder.beliefs, other.id);
      // A grudge is not forever: if trust has genuinely recovered, it eases.
      const grudgeIndex = holder.beliefs.grudges.indexOf(other.id);
      if (
        grudgeIndex >= 0 &&
        trust > CONFIG.grudge.threshold + CONFIG.grudge.easeMargin
      ) {
        holder.beliefs.grudges.splice(grudgeIndex, 1);
      }
      if (trust < CONFIG.grudge.threshold) {
        const since = holder.beliefs.lowTrustSince[other.id];
        if (since === undefined) {
          holder.beliefs.lowTrustSince[other.id] = w.tick;
        } else if (
          w.tick - since >= CONFIG.grudge.formTicks &&
          !holder.beliefs.grudges.includes(other.id)
        ) {
          holder.beliefs.grudges.push(other.id);
          w.emit("grudge_formed", [holder.id], {
            target: other.id,
            trust: Math.round(trust * 1000) / 1000,
          });
        }
      } else if (holder.beliefs.lowTrustSince[other.id] !== undefined) {
        delete holder.beliefs.lowTrustSince[other.id];
      }
    }
  }

  for (const accuser of crew) {
    // Accusations are spoken aboard, in company. A member ashore
    // at a port call holds their tongue until they are back.
    if (accuser.ashore) continue;
    const threshold = accusationThresholdFor(accuser);
    for (const other of crew) {
      if (other === accuser) continue;
      const suspicion = suspicionOf(accuser.beliefs, other.id);
      if (suspicion < threshold) continue;
      const last = accuser.beliefs.accusationsMade[other.id];
      if (last !== undefined && w.tick - last < CONFIG.accusation.cooldownTicks) {
        continue;
      }
      if (
        w.tick - other.lastAccusationTick <
        CONFIG.accusation.publicCooldownTicks
      ) {
        continue;
      }
      accuser.beliefs.accusationsMade[other.id] = w.tick;
      // Speaking it aloud vents a little of the accuser's own suspicion,
      // hardens the accuser against the accused, and plants the claim in
      // every listener's beliefs, weighted by nothing but the hearing.
      driftSuspicion(accuser.beliefs, other.id, -CONFIG.accusation.ventRelief);
      driftTrust(accuser.beliefs, other.id, -CONFIG.accusation.selfTrustHit);
      other.lastAccusationTick = w.tick;
      for (const listener of crew) {
        if (listener === accuser || listener === other) continue;
        driftSuspicion(
          listener.beliefs,
          other.id,
          CONFIG.accusation.spreadSuspicion,
        );
        driftTrust(
          listener.beliefs,
          other.id,
          -CONFIG.accusation.listenerTrustHit,
        );
      }
      w.emit("accusation", [accuser.id], {
        accused: other.id,
        suspicion: Math.round(suspicion * 1000) / 1000,
      });
    }
  }
}
