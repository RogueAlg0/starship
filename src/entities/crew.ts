// Placeholder crew: the smallest agents that prove the decision machinery.
// Each tick, every crew member is offered candidate actions (move to another
// room, work, rest) and the world's decision source picks one. During a
// radiation storm the rest candidate scores higher, so the crew shelter.

import type { Candidate } from "../decision/decisions.ts";
import type { World } from "../engine/engine.ts";
import { r3 } from "../log/events.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Ship } from "../world/ship.ts";
import type { Weather } from "../world/weather.ts";

export class CrewMember {
  readonly id: string;
  room: number;
  energy: number;

  constructor(id: string, room: number, energy: number) {
    this.id = id;
    this.room = room;
    this.energy = energy;
  }
}

/** Fresh crew from the scenario roster, in roster order. */
export function createCrew(): CrewMember[] {
  return CONFIG.crew.map(
    (entry) => new CrewMember(entry.id, entry.room, entry.energy),
  );
}

/** One tick of crew behaviour, in roster order. */
export function stepCrew(
  w: World,
  crew: readonly CrewMember[],
  ship: Ship,
  weather: Weather,
): void {
  for (const member of crew) {
    const candidates: Candidate[] = [];
    for (let room = 0; room < ship.roomCount; room++) {
      if (room !== member.room) {
        candidates.push({ key: `move:${room}`, base: 0.2 });
      }
    }
    candidates.push({
      key: "work",
      base: member.energy > 0.25 ? 0.55 : 0.1,
    });
    candidates.push({
      key: "rest",
      base: (1 - member.energy) * 0.7 + (weather.storm ? 0.35 : 0),
    });

    const chosen = w.decisions.choose(member.id, candidates, {
      tick: w.tick,
      purpose: "act",
    });
    const key = (candidates[chosen] as Candidate).key;

    if (key.startsWith("move:")) {
      const room = Number(key.slice("move:".length));
      member.room = room;
      member.energy = Math.max(0, member.energy - 0.03);
      w.emit("move", [member.id], { room: ship.roomName(room) });
    } else if (key === "work") {
      member.energy = Math.max(0, member.energy - 0.08);
      w.emit("work", [member.id], {
        room: ship.roomName(member.room),
        energy: r3(member.energy),
      });
    } else {
      member.energy = Math.min(1, member.energy + 0.18);
      w.emit("rest", [member.id], { energy: r3(member.energy) });
    }
  }
}

/** Invariant check: every crew member is in range and in a real room. */
export function checkCrewState(
  crew: readonly CrewMember[],
  ship: Ship,
): void {
  for (const member of crew) {
    if (member.energy < 0 || member.energy > 1) {
      throw new Error(`${member.id} energy out of range: ${member.energy}`);
    }
    if (member.room < 0 || member.room >= ship.roomCount) {
      throw new Error(`${member.id} in invalid room ${member.room}`);
    }
  }
}
