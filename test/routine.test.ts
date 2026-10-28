import { describe, expect, it } from "vitest";
import { UtilitySource } from "../src/decision/decisions.ts";
import { World } from "../src/engine/engine.ts";
import { StreamRegistry } from "../src/engine/rng.ts";
import { generateCrew, type CrewMember } from "../src/entities/crew.ts";
import { blockAt } from "../src/entities/routine.ts";
import { renderChronicle } from "../src/log/chronicle.ts";
import {
  accusationThresholdFor,
  spreadGossip,
  suspicionOf,
} from "../src/perception/beliefs.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, runSimulation } from "../src/sim.ts";
import { generateShip } from "../src/world/ship.ts";

/**
 * The Ship's Routine (Playtest Note #4): watches and daily blocks,
 * synchronized meals, gossip that only travels between people who were
 * actually together, and free-time texture.
 */

function generatedCrew(seed: number): CrewMember[] {
  const registry = new StreamRegistry(seed);
  const ship = generateShip(registry.get("shipgen"));
  return generateCrew(registry.get("crewgen"), ship, registry.get("routine"));
}

describe("routines at generation", () => {
  it("every crew member has a watch, a sleep block, and work blocks", () => {
    for (const seed of [1, 42, 99]) {
      const crew = generatedCrew(seed);
      expect(crew.length).toBe(12);
      for (const member of crew) {
        const blocks = new Set<string>();
        let sleepTicks = 0;
        for (let tick = 0; tick < CONFIG.time.ticksPerDay; tick++) {
          const block = blockAt(member.routine, tick);
          blocks.add(block);
          if (block === "sleep") sleepTicks++;
        }
        expect(blocks.has("sleep"), `${member.name} never sleeps`).toBe(true);
        expect(blocks.has("work"), `${member.name} never works`).toBe(true);
        // At least six hours of sleep in the shape of the day.
        expect(sleepTicks).toBeGreaterThanOrEqual(36);
      }
    }
  });

  it("the night watch is a pair: one engineering hand, one bridge/security hand", () => {
    for (const seed of [1, 7, 42, 99]) {
      const crew = generatedCrew(seed);
      const night = crew.filter((m) => m.watch === "night");
      expect(night.length).toBe(CONFIG.routine.nightWatchSize);
      const pools = CONFIG.routine.nightWatchPools;
      expect(
        night.some((m) => (pools[0] as readonly string[]).includes(m.roleKey)),
      ).toBe(true);
      expect(
        night.some((m) => (pools[1] as readonly string[]).includes(m.roleKey)),
      ).toBe(true);
      // The night watch sleeps through the day and works the dark. (At
      // 07:00 sharp a late-shifted night hand is still at breakfast,
      // which is the routine working as intended, so the sleep check
      // uses 10:00, inside every shift variant of the sleep block.)
      for (const member of night) {
        expect(blockAt(member.routine, 10 * 6)).toBe("sleep"); // 10:00
        expect(blockAt(member.routine, 2 * 6)).toBe("work"); // 02:00
      }
      // And the day watch has the shape the other way round.
      for (const member of crew.filter((m) => m.watch === "day")) {
        expect(blockAt(member.routine, 2 * 6)).toBe("sleep"); // 02:00
      }
    }
  });
});

describe("the scheduled ship, live", () => {
  it("at a deep-night tick the day watch is abed and the night watch is up", () => {
    const run = createRun({ seed: 42 });
    run.run(144 + 18 + 1); // through 03:00 on day 2
    const dayWatch = run.crew.filter((m) => m.watch === "day");
    const nightWatch = run.crew.filter((m) => m.watch === "night");
    const resting = dayWatch.filter((m) => m.activity === "rest").length;
    expect(resting).toBeGreaterThanOrEqual(8);
    expect(nightWatch.every((m) => m.activity !== "rest")).toBe(true);
  });

  it("meal windows gather the awake ship in the mess", () => {
    const run = createRun({ seed: 42 });
    run.run(3 * 144);
    const services = run.world.events.events.filter(
      (e) => e.type === "meal_service",
    );
    // Two windows a day, three days, every one of them served.
    expect(services.length).toBe(6);
    const total = services.reduce(
      (sum, e) => sum + (e.data.count as number),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(45);
    // The evening meal seats nearly the whole ship, night watch included.
    for (const service of services) {
      if (service.data.meal === "evening") {
        expect(service.data.count as number).toBeGreaterThanOrEqual(8);
      }
    }
    // Windowed eats carry their table: every attendee produced at least
    // one windowed eat (seconds at breakfast are the eater's own
    // business), and every windowed eat names its tablemates.
    const windowedMeals = run.world.events.events.filter(
      (e) => e.type === "meal" && typeof e.data.window === "string",
    );
    expect(windowedMeals.length).toBeGreaterThanOrEqual(total);
    for (const meal of windowedMeals) {
      expect(Array.isArray(meal.data.tablemates)).toBe(true);
    }
  });

  it("free time textures a 30-day run without flooding it", () => {
    const run = runSimulation({ seed: 42 }, 4320);
    const events = run.world.events;
    expect(events.countOf("meal_service")).toBe(60);
    expect(events.countOf("leisure_game")).toBeGreaterThan(0);
    expect(events.countOf("leisure_exercise")).toBeGreaterThan(0);
    expect(events.countOf("leisure_read")).toBeGreaterThan(0);
    // Texture, not flood: the whole run stays in the old run's class.
    expect(events.size).toBeLessThan(65000);
    const chronicle = renderChronicle(events.events);
    expect(chronicle).toContain("at table.");
    expect(chronicle).toContain("play PORTFALL");
  });
});

describe("gossip, the rumour engine", () => {
  function constructedCrew(): {
    world: World;
    crew: CrewMember[];
  } {
    const world = new World({ seed: 5 }, new UtilitySource());
    const ship = generateShip(world.rng.get("shipgen"));
    const crew = generateCrew(world.rng.get("crewgen"), ship);
    for (const member of crew) {
      for (const other of crew) {
        member.beliefs.suspicion[other.id] = 0;
      }
    }
    return { world, crew };
  }

  it("transfers a held suspicion to a listener, scaled by trust", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, target] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    speaker.beliefs.suspicion[target.id] = 0.6;
    listener.beliefs.trust[speaker.id] = 0.5;
    listener.beliefs.suspicion[target.id] = 0.2;
    spreadGossip(world, speaker, listener);
    // Receptivity 0.75 at trust 0.5: 0.2 + 0.008 * 0.75.
    expect(suspicionOf(listener.beliefs, target.id)).toBeCloseTo(0.206, 6);
    expect(world.events.countOf("gossip")).toBe(0);
  });

  it("does not transfer suspicions held below the gossip threshold", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, target] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    speaker.beliefs.suspicion[target.id] = 0.3;
    listener.beliefs.suspicion[target.id] = 0.1;
    spreadGossip(world, speaker, listener);
    expect(suspicionOf(listener.beliefs, target.id)).toBe(0.1);
  });

  it("never raises a listener above the speaker's own level", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, target] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    speaker.beliefs.suspicion[target.id] = 0.55;
    listener.beliefs.suspicion[target.id] = 0.6;
    spreadGossip(world, speaker, listener);
    expect(suspicionOf(listener.beliefs, target.id)).toBe(0.6);
  });

  it("caps rumour at the listener's accusation threshold, records the tip once", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, target] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    const threshold = accusationThresholdFor(listener);
    speaker.beliefs.suspicion[target.id] = 0.95;
    listener.beliefs.suspicion[target.id] = threshold - 0.003;
    spreadGossip(world, speaker, listener);
    expect(suspicionOf(listener.beliefs, target.id)).toBeCloseTo(
      threshold,
      9,
    );
    expect(world.events.countOf("gossip")).toBe(1);
    // A re-top inside the cooldown is not news twice.
    listener.beliefs.suspicion[target.id] = threshold - 0.003;
    spreadGossip(world, speaker, listener);
    expect(world.events.countOf("gossip")).toBe(1);
  });

  it("in a live run, gossip only flows between people who were together", () => {
    // 90 days: under the cooled accusation economy (Oct 27, 2026)
    // seed 39's first gossip lands on day 52; the 30-day probe
    // predates that pacing and finds an honestly quiet month.
    const run = runSimulation({ seed: 39 }, 12960);
    const events = run.world.events.events;
    const gossip = events.filter((e) => e.type === "gossip");
    expect(gossip.length).toBeGreaterThan(0);
    const byTick = new Map<number, typeof events>();
    for (const event of events) {
      const list = byTick.get(event.tick) ?? [];
      list.push(event);
      byTick.set(event.tick, list);
    }
    for (const tip of gossip) {
      const from = tip.actors[0] as string;
      const to = tip.data.to as string;
      const room = tip.data.room as number;
      // The same tick must hold the occasion: a shared meal (a windowed
      // eat whose table held both people) or a conversation between them
      // in the room the gossip names.
      const together = (byTick.get(tip.tick) ?? []).some((other) => {
        if (other.type === "socialize" && other.data.room === room) {
          return (
            (other.actors[0] === from && other.data.with === to) ||
            (other.actors[0] === to && other.data.with === from)
          );
        }
        if (
          other.type === "meal" &&
          typeof other.data.window === "string" &&
          other.data.room === room
        ) {
          const mates = (other.data.tablemates as string[] | undefined) ?? [];
          return (
            (other.actors[0] === from && mates.includes(to)) ||
            (other.actors[0] === to && mates.includes(from))
          );
        }
        return false;
      });
      expect(
        together,
        `gossip at tick ${tip.tick} (${from} -> ${to}) has no shared occasion`,
      ).toBe(true);
    }
  }, 60_000);
});
