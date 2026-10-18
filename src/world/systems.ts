// Ship systems: reactor, life support, engines, and the rest. Each system
// lives in one room, has a condition in [0, 1], and is tended by the crew
// whose roles cover its kind. Condition falls by wear (faster in a storm),
// rises by work and repair, and drops hard when someone sabotages it. A
// system below the strain threshold drags on every crew member's morale,
// and the crew blame the people whose job it was.

import type { World } from "../engine/engine.ts";
import type { Rng } from "../engine/rng.ts";
import type { CrewMember } from "../entities/crew.ts";
import { r3 } from "../log/events.ts";
import { driftTrust } from "../perception/beliefs.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Ship } from "./ship.ts";
import type { Weather } from "./weather.ts";

export interface ShipSystem {
  id: string;
  /** Display name: the kind, with a number when a kind repeats. */
  name: string;
  kind: string;
  /** Room index hosting this system. */
  room: number;
  condition: number;
  /** Condition has crossed below the damaged threshold and not recovered. */
  damaged: boolean;
  failed: boolean;
  lastStrainTick: number;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Roll the systems a room hosts, from its kind's affinity list. */
export function rollRoomSystems(
  rng: Rng,
  roomKind: string,
  roomIndex: number,
  counters: Map<string, number>,
): ShipSystem[] {
  const affinity = CONFIG.roomSystemAffinity[roomKind] ?? [];
  if (affinity.length === 0) return [];
  const roll = rng.next();
  let count = 0;
  if (roll >= CONFIG.systemGen.emptyChance) {
    count =
      roll < CONFIG.systemGen.emptyChance + CONFIG.systemGen.oneChance ? 1 : 2;
  }
  count = Math.min(count, affinity.length);
  if (count === 0) return [];
  const pool = [...affinity];
  const systems: ShipSystem[] = [];
  for (let i = 0; i < count; i++) {
    const kind = pool.splice(rng.int(pool.length), 1)[0] as string;
    systems.push(makeSystem(rng, kind, roomIndex, counters));
  }
  return systems;
}

/** Create one system instance with a generated starting condition. */
export function makeSystem(
  rng: Rng,
  kind: string,
  roomIndex: number,
  counters: Map<string, number>,
): ShipSystem {
  const n = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, n);
  const span = CONFIG.systemGen.maxCondition - CONFIG.systemGen.minCondition;
  return {
    id: `${kind}#${n}`,
    name: n > 1 ? `${kind} ${n}` : kind,
    kind,
    room: roomIndex,
    condition: CONFIG.systemGen.minCondition + rng.next() * span,
    damaged: false,
    failed: false,
    lastStrainTick: -CONFIG.systems.strainCadenceTicks,
  };
}

/**
 * The one door for condition changes. Clamps to [0, 1], fires
 * system_damaged when a system crosses into damaged (unless the cause is
 * sabotage, whose own event is the record), and system_repaired when a
 * damaged system is brought back above the repair threshold by work.
 */
export function applyConditionDelta(
  w: World,
  system: ShipSystem,
  delta: number,
  actorId: string | null,
  cause: "work" | "repair" | "wear" | "sabotage",
): void {
  system.condition = clamp01(system.condition + delta);
  if (!system.damaged && system.condition < CONFIG.systems.damagedThreshold) {
    system.damaged = true;
    if (cause !== "sabotage") {
      w.emit("system_damaged", [], {
        system: system.id,
        room: system.room,
        condition: r3(system.condition),
        cause,
      });
    }
  }
  if (
    system.damaged &&
    delta > 0 &&
    system.condition >= CONFIG.systems.repairCompleteThreshold
  ) {
    system.damaged = false;
    system.failed = false;
    w.emit("system_repaired", actorId !== null ? [actorId] : [], {
      system: system.id,
      room: system.room,
      by: actorId,
      condition: r3(system.condition),
    });
  }
}

/** Per-tick wear, strain, failure, and blame for every system aboard. */
export function stepSystems(
  w: World,
  ship: Ship,
  weather: Weather,
  crew: readonly CrewMember[],
): void {
  const wear =
    CONFIG.systems.wearPerTick *
    (weather.storm ? CONFIG.systems.stormWearMultiplier : 1);
  for (const system of ship.systems) {
    applyConditionDelta(w, system, -wear, null, "wear");

    if (system.condition <= CONFIG.systems.failedThreshold && !system.failed) {
      system.failed = true;
      w.emit("system_failed", [], {
        system: system.id,
        room: system.room,
        condition: r3(system.condition),
      });
    }

    if (
      system.condition < CONFIG.systems.strainThreshold &&
      w.tick - system.lastStrainTick >= CONFIG.systems.strainCadenceTicks
    ) {
      system.lastStrainTick = w.tick;
      w.emit("system_strain", [], {
        system: system.id,
        room: system.room,
        condition: r3(system.condition),
      });
      const hit =
        system.kind === "life support"
          ? CONFIG.systems.lifeSupportStrainMoraleHit
          : CONFIG.systems.strainMoraleHit;
      for (const member of crew) {
        member.needs.morale = clamp01(member.needs.morale - hit);
        // Blame: the people whose role covers this system let it slide.
        for (const other of crew) {
          if (other === member) continue;
          if (other.affinity.includes(system.kind)) {
            driftTrust(member.beliefs, other.id, -CONFIG.systems.blameTrustHit);
          }
        }
      }
    }
  }
}

/** Invariant check: every system condition in range. */
export function checkShipState(ship: Ship): void {
  for (const system of ship.systems) {
    if (system.condition < 0 || system.condition > 1) {
      throw new Error(
        `system ${system.id} condition out of range: ${system.condition}`,
      );
    }
  }
}
