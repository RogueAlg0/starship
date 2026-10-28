import { describe, expect, it } from "vitest";
import { StreamRegistry } from "../src/engine/rng.ts";
import { renderChronicle } from "../src/log/chronicle.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, type RunContext } from "../src/sim.ts";
import { generateSector, Voyage } from "../src/world/galaxy.ts";
import { dailyUseMilli } from "../src/world/stores.ts";

const TPD = CONFIG.time.ticksPerDay;

type SimEvent = RunContext["world"]["events"]["events"][number];

function decidedEvents(run: RunContext): SimEvent[] {
  return run.world.events.events.filter((e) => e.type === "course_decided");
}

/**
 * Sail a run into its first stay, let the port's resupply land,
 * then (optionally) put the ship in the state the scenario
 * needs, and step until the council sets the course. The
 * manipulation lands after resupply on purpose: a state set
 * before the manifest arrives is a state the port erases.
 */
function firstSitting(
  run: RunContext,
  mutate?: (run: RunContext) => void,
): SimEvent {
  let guard = 0;
  while (
    run.world.events.events.find((e) => e.type === "resupply") === undefined &&
    guard++ < 20000
  ) {
    run.step();
  }
  if (mutate !== undefined) mutate(run);
  let decided = decidedEvents(run)[0];
  for (let i = 0; i < 900 && decided === undefined; i++) {
    run.step();
    decided = decidedEvents(run)[0];
  }
  if (decided === undefined) throw new Error("no course sitting was held");
  return decided;
}

describe("the chart", () => {
  it("excludes the current port, admits the previous, and holds the band for the rest", () => {
    const g = CONFIG.galaxy;
    let outOfBandPreviousSeen = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const registry = new StreamRegistry(seed);
      const sector = generateSector(registry.get("galaxy"));
      const voyage = new Voyage(registry.get("galaxy"), sector);
      for (const from of sector.ports) {
        for (const previous of sector.ports) {
          if (previous.index === from.index) continue;
          const chart = voyage.courseCandidates(from.index, previous.index);
          expect(chart).not.toContain(from.index);
          // The previous port is always on the chart, under its
          // standing penalty rather than a bar.
          expect(chart).toContain(previous.index);
          const fromPort = sector.portAt(from.index);
          const prevDays =
            sector.distanceBetween(fromPort, sector.portAt(previous.index)) /
            g.cruiseLightDaysPerDay;
          if (prevDays < g.minLegDays || prevDays > g.maxLegDays) {
            outOfBandPreviousSeen++;
          }
          for (const index of chart) {
            if (index === previous.index) continue;
            const days =
              sector.distanceBetween(fromPort, sector.portAt(index)) /
              g.cruiseLightDaysPerDay;
            expect(days).toBeGreaterThanOrEqual(g.minLegDays - 1e-9);
            expect(days).toBeLessThanOrEqual(g.maxLegDays + 1e-9);
          }
        }
      }
    }
    // The scan really exercised the out-of-band admission.
    expect(outOfBandPreviousSeen).toBeGreaterThan(0);
  });

  it("recording a course off the chart is refused at the point of mutation", () => {
    const run = createRun({ seed: 42 });
    const voyage = run.galaxy.voyage;
    run.run(voyage.legTicks + 2);
    const stay = voyage.stays[0] as (typeof voyage.stays)[number];
    const chart = voyage.courseCandidates(
      stay.port,
      voyage.previousPortForStay(stay.index),
    );
    const offChart = run.galaxy.sector.ports
      .map((p) => p.index)
      .find((index) => !chart.includes(index) && index !== stay.port);
    if (offChart !== undefined) {
      expect(() => voyage.recordCourseDecision(stay.index, offChart)).toThrow();
    }
    const onChart = chart[0] as number;
    voyage.recordCourseDecision(stay.index, onChart);
    expect(voyage.courseDecisionFor(stay.index)).toBe(onChart);
    expect(() => voyage.recordCourseDecision(stay.index, onChart)).toThrow();
  });
});

describe("the sitting", () => {
  it("is deterministic: the same seed gives the same chart, votes, and course, twice", () => {
    const first = createRun({ seed: 42 });
    const firstDecided = firstSitting(first);
    const second = createRun({ seed: 42 });
    const secondDecided = firstSitting(second);
    expect(secondDecided.data).toEqual(firstDecided.data);
    expect(secondDecided.tick).toBe(firstDecided.tick);
  });

  it("a hurt ship chooses the shipyard over the nearer port", () => {
    // Seed 27's first chart: Maren Docks (industrial, 12.4 days),
    // Belka Terminus (shipyard, 13.1 days), Alden Market
    // (industrial, 16.6 days). Sound, the council sails for the
    // nearer industrial port; hurt, with the parts locker
    // draining, the quartermaster's and engineer's arithmetic
    // carries the yard.
    const sectorOf = (run: RunContext) => run.galaxy.sector;
    const control = createRun({ seed: 27 });
    const controlDecided = firstSitting(control);
    const yard = sectorOf(control).ports.find(
      (p) => p.character === "shipyard" && p.name === "Belka Terminus",
    ) as (typeof control.galaxy.sector.ports)[number];
    expect(controlDecided.data.portIndex).not.toBe(yard.index);

    const hurt = createRun({ seed: 27 });
    const hurtDecided = firstSitting(hurt, (run) => {
      for (const system of run.ship.systems) {
        if (system.kind === "reactor") system.condition = 0.15;
      }
      run.stores.byKey.parts.qtyMilli = Math.round(
        2 * dailyUseMilli(run.stores, "parts"),
      );
    });
    expect(hurtDecided.data.portIndex).toBe(yard.index);
    // The yard was not the nearer port: the flip is the
    // arithmetic, not the distance.
    const candidates = hurtDecided.data.candidates as {
      port: string;
      legDays: number;
    }[];
    const yardDays = candidates.find((c) => c.port === yard.name)?.legDays ?? 0;
    const nearer = Math.min(...candidates.map((c) => c.legDays));
    expect(yardDays).toBeGreaterThan(nearer);
  }, 60_000);

  it("the council votes to return to the previous port despite the penalty", () => {
    // Seed 21: the charter sails Belka Crossing (agrarian) to
    // Corvin Reach, and the chart home offers only Belka
    // Crossing back or a listening post on. Sound and fed, the
    // council sails on; starving, with the reactor hurt, it
    // votes to go back to the farm it came from, standing
    // penalty and all.
    const control = createRun({ seed: 21 });
    const origin = control.galaxy.voyage.origin;
    const controlDecided = firstSitting(control);
    expect(controlDecided.data.portIndex).not.toBe(origin);

    const starving = createRun({ seed: 21 });
    const starvingDecided = firstSitting(starving, (run) => {
      run.stores.byKey.food.qtyMilli = Math.round(
        2 * dailyUseMilli(run.stores, "food"),
      );
      run.stores.byKey.water.qtyMilli = Math.round(
        3 * dailyUseMilli(run.stores, "water"),
      );
      run.stores.byKey.parts.qtyMilli = Math.round(
        2 * dailyUseMilli(run.stores, "parts"),
      );
      for (const system of run.ship.systems) {
        if (system.kind === "reactor") system.condition = 0.25;
      }
    });
    expect(starvingDecided.data.portIndex).toBe(origin);
    expect(starvingDecided.data.fromIndex).toBe(
      starving.galaxy.voyage.destination,
    );
  }, 60_000);
});

describe("the why line", () => {
  /** First sittings across seeds, skipping any seed whose first
   *  stay holds no sitting in the helper's window. */
  function* firstSittings(): Generator<{ run: RunContext; decided: SimEvent }> {
    for (let seed = 1; seed <= 60; seed++) {
      const run = createRun({ seed });
      try {
        yield { run, decided: firstSitting(run) };
      } catch {
        continue;
      }
    }
  }

  it("a carried motion records the motion basis and its backers", () => {
    let carried: SimEvent | undefined;
    for (const { decided } of firstSittings()) {
      if (decided.data.carried === true) {
        carried = decided;
        break;
      }
    }
    if (carried === undefined) throw new Error("no carried motion in the scan");
    expect(carried.data.basis).toBe("motion");
    expect(carried.data.port).toBe(carried.data.motion);
    expect(Array.isArray(carried.data.backers)).toBe(true);
  }, 180_000);

  it("a refused motion records why the fallback port won, and the chronicle says it", () => {
    let refused: SimEvent | undefined;
    let refusedRun: RunContext | undefined;
    for (const { run, decided } of firstSittings()) {
      if (
        decided.data.carried === false &&
        decided.data.noCouncil !== true
      ) {
        refused = decided;
        refusedRun = run;
        break;
      }
    }
    if (refused === undefined || refusedRun === undefined) {
      throw new Error("no refused course motion found in the seed scan");
    }
    // The decision carries its own explanation: the aggregate
    // basis, the winning margin over the runner-up, and the
    // officers whose prices most favoured the chosen port.
    expect(refused.data.basis).toBe("aggregate");
    expect(refused.data.port).not.toBe(refused.data.motion);
    const backers = refused.data.backers as Array<{
      member: string;
      clause: string;
    }>;
    expect(backers.length).toBeGreaterThan(0);
    expect(backers.length).toBeLessThanOrEqual(3);
    for (const backer of backers) {
      expect(backer.member).not.toBe("");
      expect(backer.clause).not.toBe("");
    }
    expect(typeof refused.data.runnerUp).toBe("string");
    expect(refused.data.runnerUp).not.toBe(refused.data.port);
    expect(refused.data.aggregateTotal as number).toBeGreaterThanOrEqual(
      refused.data.runnerUpTotal as number,
    );
    // And the chronicle prints the why line for the watcher.
    const chronicle = renderChronicle(refusedRun.world.events.events);
    expect(chronicle).toContain(
      "Why this port: the table's combined prices",
    );
    expect(chronicle).toContain(`sails for ${refused.data.port as string}`);
  }, 180_000);
});

describe("the fleet, decided leg by leg", () => {
  it(
    "no ship strands, every sailed leg after the charter was decided, and no run ping-pongs",
    () => {
      const seeds = [11, 16, 17, 30, 39, 40, 42, 99];
      for (const seed of seeds) {
        const run = createRun({ seed });
        run.run(90 * TPD);
        const { voyage } = run.galaxy;
        const events = run.world.events.events;
        const decided = decidedEvents(run);
        // No stranding: the ship keeps making port.
        const arrivals = events.filter(
          (e) => e.type === "arrival" || e.type === "port_call",
        ).length;
        expect(arrivals, `seed ${seed} arrivals`).toBeGreaterThanOrEqual(3);
        expect(decided.length, `seed ${seed} sittings`).toBeGreaterThanOrEqual(1);
        // Every leg the ship actually sailed after the charter,
        // up to any ending, is the leg its stay's sitting chose.
        const ending = events.find(
          (e) => e.type === "ship_lost" || e.type === "crew_collapse",
        );
        const endTick = ending === undefined ? Infinity : ending.tick;
        for (let i = 1; i < voyage.legs.length; i++) {
          const leg = voyage.legs[i] as (typeof voyage.legs)[number];
          if (leg.departTick > endTick) continue;
          const sitting = decided.find(
            (e) =>
              e.data.portIndex === leg.to &&
              e.tick >= (voyage.stays[i - 1]?.arriveTick ?? 0) &&
              e.tick <= leg.departTick,
          );
          expect(
            sitting,
            `seed ${seed} leg ${i} to ${leg.to} was decided`,
          ).toBeDefined();
        }
        // No whole-run ping-pong: the route touches at least
        // three distinct ports on every seed.
        const distinct = new Set(
          voyage.legs.flatMap((leg) => [leg.from, leg.to]),
        );
        expect(distinct.size, `seed ${seed} distinct ports`).toBeGreaterThanOrEqual(3);
      }
    },
    300_000,
  );
});
