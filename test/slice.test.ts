import { describe, expect, it } from "vitest";
import { UtilitySource } from "../src/decision/decisions.ts";
import { ReplaySource } from "../src/decision/decisions.ts";
import { World } from "../src/engine/engine.ts";
import { StreamRegistry } from "../src/engine/rng.ts";
import {
  crewSignature,
  generateCrew,
  type CrewMember,
} from "../src/entities/crew.ts";
import { renderChronicle } from "../src/log/chronicle.ts";
import { stepSociety, suspicionOf } from "../src/perception/beliefs.ts";
import { applySabotage } from "../src/plots/sabotage.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { buildWorld, runSimulation } from "../src/sim.ts";
import { generateShip } from "../src/world/ship.ts";
import type { ShipSystem } from "../src/world/systems.ts";

/** Wipe every belief back to mild neutrality, for constructed scenarios. */
function resetBeliefs(crew: readonly CrewMember[]): void {
  for (const member of crew) {
    for (const other of crew) {
      if (other === member) continue;
      member.beliefs.trust[other.id] = 0.2;
      member.beliefs.bond[other.id] = 0.1;
      member.beliefs.suspicion[other.id] = 0;
    }
    member.beliefs.grudges.length = 0;
    for (const key of Object.keys(member.beliefs.lowTrustSince)) {
      delete member.beliefs.lowTrustSince[key];
    }
    for (const key of Object.keys(member.beliefs.accusationsMade)) {
      delete member.beliefs.accusationsMade[key];
    }
    member.lastSabotageTick = -1000000;
  }
}

describe("ship generation", () => {
  it("same seed gives the same layout signature", () => {
    const a = generateShip(new StreamRegistry(42).get("shipgen"));
    const b = generateShip(new StreamRegistry(42).get("shipgen"));
    expect(a.signature()).toBe(b.signature());
  });

  it("different seeds give different layouts somewhere", () => {
    const signatures = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        generateShip(new StreamRegistry(seed).get("shipgen")).signature(),
      ),
    );
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("ships are in range, fully connected, and carry every system kind", () => {
    for (const seed of [1, 7, 42, 99]) {
      const ship = generateShip(new StreamRegistry(seed).get("shipgen"));
      expect(ship.roomCount).toBeGreaterThanOrEqual(CONFIG.ship.minRooms);
      expect(ship.roomCount).toBeLessThanOrEqual(CONFIG.ship.maxRooms);
      const { dist } = ship.distancesFrom(0);
      expect(dist.every((d) => d >= 0)).toBe(true);
      const kinds = new Set(ship.systems.map((s) => s.kind));
      for (const kind of CONFIG.systemKinds) {
        expect(kinds.has(kind), `seed ${seed} missing ${kind}`).toBe(true);
      }
    }
  });
});

describe("crew generation", () => {
  it("same seed gives the same roster", () => {
    const shipA = generateShip(new StreamRegistry(42).get("shipgen"));
    const shipB = generateShip(new StreamRegistry(42).get("shipgen"));
    const a = generateCrew(new StreamRegistry(42).get("crewgen"), shipA);
    const b = generateCrew(new StreamRegistry(42).get("crewgen"), shipB);
    expect(crewSignature(a)).toBe(crewSignature(b));
  });

  it("twelve crew, twelve distinct roles, distinct names", () => {
    const ship = generateShip(new StreamRegistry(3).get("shipgen"));
    const crew = generateCrew(new StreamRegistry(3).get("crewgen"), ship);
    expect(crew.length).toBe(12);
    expect(new Set(crew.map((m) => m.roleKey)).size).toBe(12);
    expect(new Set(crew.map((m) => m.name)).size).toBe(12);
    for (const member of crew) {
      expect(member.traits.length).toBeGreaterThanOrEqual(2);
      expect(member.traits.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("the living ship", () => {
  it(
    "needs and beliefs stay in bounds over a 2,000-tick run",
    () => {
      const built = buildWorld({ seed: 7 });
      built.run(2000); // per-tick invariants throw on any violation
      for (const member of built.crew) {
        for (const value of Object.values(member.needs)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    },
    30_000,
  );

  it(
    "a strong grudge, alone with a system, leads to sabotage",
    () => {
      const built = buildWorld({ seed: 42 });
      const { crew, ship, engine, world } = built;
      resetBeliefs(crew);

      // Put the culprit in a system room as far as possible from the room
      // the rest of the crew starts crowded into.
      let culpritRoom = -1;
      let crowdRoom = -1;
      let bestDistance = -1;
      for (const room of ship.rooms) {
        if (ship.systemsInRoom(room.index).length === 0) continue;
        for (const other of ship.rooms) {
          const d = ship.distance(room.index, other.index);
          if (d > bestDistance) {
            bestDistance = d;
            culpritRoom = room.index;
            crowdRoom = other.index;
          }
        }
      }
      expect(culpritRoom).toBeGreaterThanOrEqual(0);

      const culprit = crew[0] as CrewMember;
      const target = crew[1] as CrewMember;
      culprit.traits.length = 0;
      culprit.traits.push("bold", "hot-tempered");
      culprit.beliefs.trust[target.id] = -0.95;
      culprit.beliefs.grudges.push(target.id);
      culprit.room = culpritRoom;
      culprit.needs.energy = 0.95;
      culprit.needs.hunger = 0.95;
      culprit.needs.social = 0.95;
      for (const member of crew) {
        if (member !== culprit) member.room = crowdRoom;
      }

      let sabotage: unknown = null;
      for (let t = 0; t < 600 && sabotage === null; t++) {
        engine.step();
        sabotage =
          world.events.events.find(
            (e) =>
              e.type === "sabotage_committed" &&
              e.data.culprit === culprit.id,
          ) ?? null;
      }
      expect(sabotage).not.toBeNull();
    },
    30_000,
  );

  it("sabotage evidence can wrongly suspect a bystander", () => {
    const world = new World({ seed: 5 }, new UtilitySource());
    const ship = generateShip(world.rng.get("shipgen"));
    const crew = generateCrew(world.rng.get("crewgen"), ship);
    resetBeliefs(crew);

    const roomWithSystem = ship.rooms.find(
      (r) => ship.systemsInRoom(r.index).length > 0,
    );
    expect(roomWithSystem).toBeDefined();
    const room = roomWithSystem as { index: number; neighbors: number[] };
    const system = ship.systemsInRoom(room.index)[0] as ShipSystem;
    const neighborRoom = room.neighbors[0] as number;
    let farRoom = room.index;
    let farDistance = -1;
    for (const r of ship.rooms) {
      const d = ship.distance(room.index, r.index);
      if (d > farDistance) {
        farDistance = d;
        farRoom = r.index;
      }
    }

    const culprit = crew[0] as CrewMember;
    const bystander = crew[1] as CrewMember;
    const observer = crew[2] as CrewMember;
    culprit.room = room.index;
    bystander.room = neighborRoom;
    for (const member of crew) {
      if (member !== culprit && member !== bystander) member.room = farRoom;
    }
    const snapshot: Record<string, number> = {};
    for (const member of crew) snapshot[member.id] = member.room;

    const before = system.condition;
    applySabotage(world, ship, crew, culprit, system, [snapshot]);

    expect(before - system.condition).toBeGreaterThanOrEqual(
      CONFIG.sabotage.damageMin - 1e-9,
    );
    expect(before - system.condition).toBeLessThanOrEqual(
      CONFIG.sabotage.damageMax + 1e-9,
    );
    const culpritSuspicion = suspicionOf(observer.beliefs, culprit.id);
    const bystanderSuspicion = suspicionOf(observer.beliefs, bystander.id);
    expect(culpritSuspicion).toBeGreaterThan(0.2);
    // The bystander only stood nearby, and still draws suspicion: the
    // wrongful-accusation engine works.
    expect(bystanderSuspicion).toBeGreaterThan(0);
    expect(culpritSuspicion).toBeGreaterThan(bystanderSuspicion);
  });

  it("an accusation is heard only by the crew in the room", () => {
    const world = new World({ seed: 5 }, new UtilitySource());
    const ship = generateShip(world.rng.get("shipgen"));
    const crew = generateCrew(world.rng.get("crewgen"), ship);
    resetBeliefs(crew);

    const accuser = crew[0] as CrewMember;
    const accused = crew[1] as CrewMember;
    const present = crew[2] as CrewMember;
    const absent = crew[3] as CrewMember;
    const roomA = ship.rooms[0] as { index: number };
    let farRoom = roomA.index;
    let farDistance = -1;
    for (const r of ship.rooms) {
      const d = ship.distance(roomA.index, r.index);
      if (d > farDistance) {
        farDistance = d;
        farRoom = r.index;
      }
    }
    accuser.room = roomA.index;
    accused.room = farRoom;
    present.room = roomA.index;
    absent.room = farRoom;
    for (const member of crew) {
      if (member !== accuser && member !== present) {
        member.room = farRoom;
      }
    }
    accuser.beliefs.suspicion[accused.id] = 0.95;
    accused.lastAccusationTick = -1000000;

    stepSociety(world, crew);

    const spoken = world.events.events.find((e) => e.type === "accusation");
    expect(spoken).toBeDefined();
    // The crewmate in the room hears the claim and takes some of it on.
    expect(suspicionOf(present.beliefs, accused.id)).toBeCloseTo(
      CONFIG.accusation.spreadSuspicion,
    );
    expect(present.beliefs.trust[accused.id]).toBeCloseTo(
      0.2 - CONFIG.accusation.listenerTrustHit,
    );
    // The crewmate across the ship hears nothing: no suspicion gained,
    // no trust lost. A claim is local, like gossip.
    expect(suspicionOf(absent.beliefs, accused.id)).toBe(0);
    expect(absent.beliefs.trust[accused.id]).toBe(0.2);
  });

  it(
    "the full slice replays exactly over 2,000 ticks",
    () => {
      const live = runSimulation({ seed: 42 }, 2000);
      const source = new ReplaySource(live.decisions);
      const replayed = runSimulation({ seed: 42 }, 2000, source);
      expect(replayed.world.events.hash()).toBe(live.world.events.hash());
      expect(replayed.world.events.size).toBe(live.world.events.size);
      source.assertFullyConsumed();
    },
    60_000,
  );

  it(
    "a 30-day run completes at speed",
    () => {
      const started = performance.now();
      const run = runSimulation({ seed: 42 }, 4320);
      const elapsedMs = performance.now() - started;
      const ticksPerSecond = Math.round(4320 / (elapsedMs / 1000));
      console.log(
        `30-day run: ${run.world.events.size} events, ${ticksPerSecond} ticks/sec`,
      );
      expect(run.world.events.size).toBeGreaterThan(1000);
      expect(ticksPerSecond).toBeGreaterThan(250);
    },
    60_000,
  );

  it("the chronicle renders a readable header and departure", () => {
    const run = runSimulation({ seed: 42 }, 60);
    const chronicle = renderChronicle(run.world.events.events);
    expect(chronicle).toContain("Ship's log of the");
    expect(chronicle).toContain("light-days out. The voyage begins.");
    expect(chronicle).toContain("End of log.");
  });
});
