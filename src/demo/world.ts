// DEMO SCAFFOLDING — a throwaway world that proves the kernel end to end.
// This is not the starship sim. It exists so determinism, purity, and replay
// have something real to bite on before any crew or ship content lands.
//
// A tiny ship: 3 rooms, 2 placeholder crew. Each tick the weather system may
// change the shipboard weather (a 3-state Markov chain), then each crew
// member picks one candidate action (move, work, rest) through the decision
// source. During a radiation storm the rest candidate scores higher, so the
// crew visibly shelter.

import {
  UtilitySource,
  type Candidate,
  type DecisionRecord,
  type DecisionSource,
} from "../kernel/decisions.ts";
import { Engine, World, type SimConfig } from "../kernel/engine.ts";
import { r3 } from "../kernel/events.ts";

export const ROOMS = ["bridge", "engine room", "quarters"] as const;
export const WEATHERS = ["calm", "solar wind", "radiation storm"] as const;

// Row per current state: probability of moving to calm, solar wind, storm.
const TRANSITIONS: readonly (readonly number[])[] = [
  [0.9, 0.08, 0.02],
  [0.25, 0.65, 0.1],
  [0.35, 0.25, 0.4],
];

interface CrewState {
  id: string;
  room: number;
  energy: number;
}

export interface DemoOutcome {
  world: World;
  decisions: DecisionRecord[];
}

export function runDemo(
  config: SimConfig,
  ticks: number,
  source?: DecisionSource,
): DemoOutcome {
  let world: World;
  const decisions =
    source ?? new UtilitySource(() => world.rng.get("crew").next());
  world = new World(config, decisions);
  const engine = new Engine(world);

  const crew: CrewState[] = [
    { id: "ada", room: 0, energy: 0.9 },
    { id: "bek", room: 2, energy: 0.8 },
  ];
  let weather = 0;

  engine.addSystem({
    name: "weather",
    step(w) {
      const rng = w.rng.get("weather");
      const row = TRANSITIONS[weather] as readonly number[];
      const roll = rng.next();
      let next = weather;
      let acc = 0;
      for (let i = 0; i < row.length; i++) {
        acc += row[i] as number;
        if (roll < acc) {
          next = i;
          break;
        }
      }
      if (next !== weather) {
        w.emit("weather", [], {
          from: WEATHERS[weather],
          to: WEATHERS[next],
        });
        weather = next;
      }
    },
  });

  engine.addSystem({
    name: "crew",
    step(w) {
      const storm = WEATHERS[weather] === "radiation storm";
      for (const member of crew) {
        const candidates: Candidate[] = [];
        for (let room = 0; room < ROOMS.length; room++) {
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
          base: (1 - member.energy) * 0.7 + (storm ? 0.35 : 0),
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
          w.emit("move", [member.id], { room: ROOMS[room] });
        } else if (key === "work") {
          member.energy = Math.max(0, member.energy - 0.08);
          w.emit("work", [member.id], {
            room: ROOMS[member.room],
            energy: r3(member.energy),
          });
        } else {
          member.energy = Math.min(1, member.energy + 0.18);
          w.emit("rest", [member.id], { energy: r3(member.energy) });
        }
      }
    },
  });

  engine.addInvariant("crew state in range", () => {
    for (const member of crew) {
      if (member.energy < 0 || member.energy > 1) {
        throw new Error(`${member.id} energy out of range: ${member.energy}`);
      }
      if (member.room < 0 || member.room >= ROOMS.length) {
        throw new Error(`${member.id} in invalid room ${member.room}`);
      }
    }
  });

  world.emit("run_start", [], { seed: String(config.seed) });
  engine.run(ticks);

  return {
    world,
    decisions: decisions instanceof UtilitySource ? decisions.records : [],
  };
}
