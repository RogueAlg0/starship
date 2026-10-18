import { describe, expect, it } from "vitest";
import { StreamRegistry } from "../src/engine/rng.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, runSimulation } from "../src/sim.ts";
import {
  generateSector,
  Voyage,
  type Sector,
} from "../src/world/galaxy.ts";

/** The sector a seed sails, drawn the way the engine draws it. */
function sectorFor(seed: number): Sector {
  return generateSector(new StreamRegistry(seed).get("galaxy"));
}

/** The leg a seed sails: sector then voyage, one shared stream. */
function voyageFor(seed: number): Voyage {
  const registry = new StreamRegistry(seed);
  const sector = generateSector(registry.get("galaxy"));
  return new Voyage(registry.get("galaxy"), sector);
}

const SAMPLE_SEEDS = [1, 7, 11, 16, 17, 30, 39, 40, 42, 99];
/** The viewer's daily rotation, plus the standing spare seed. */
const DAILY_SEEDS = [11, 16, 17, 30, 39, 40, 42, 99];

describe("sector generation", () => {
  it("same seed gives the same sector, byte for byte", () => {
    expect(sectorFor(42).signature()).toBe(sectorFor(42).signature());
  });

  it("different seeds give different sectors", () => {
    const signatures = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) => sectorFor(seed).signature()),
    );
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("port counts, positions, and separations stay in bounds", () => {
    const g = CONFIG.galaxy;
    for (const seed of SAMPLE_SEEDS) {
      const sector = sectorFor(seed);
      expect(sector.ports.length).toBeGreaterThanOrEqual(g.minPorts);
      expect(sector.ports.length).toBeLessThanOrEqual(g.maxPorts);
      for (const port of sector.ports) {
        expect(port.x).toBeGreaterThanOrEqual(0);
        expect(port.x).toBeLessThanOrEqual(g.sectorSpanLightDays);
        expect(port.y).toBeGreaterThanOrEqual(0);
        expect(port.y).toBeLessThanOrEqual(g.sectorSpanLightDays);
      }
      for (let i = 0; i < sector.ports.length; i++) {
        for (let j = i + 1; j < sector.ports.length; j++) {
          const d = sector.distanceBetween(
            sector.ports[i] as (typeof sector.ports)[number],
            sector.ports[j] as (typeof sector.ports)[number],
          );
          expect(
            d,
            `seed ${seed} ports ${i} and ${j} too close`,
          ).toBeGreaterThanOrEqual(g.minSeparationLightDays - 1e-9);
        }
      }
    }
  });

  it("factions hold home ports; every allegiance is valid or none", () => {
    for (const seed of SAMPLE_SEEDS) {
      const sector = sectorFor(seed);
      expect(sector.factions.length).toBeGreaterThanOrEqual(
        CONFIG.galaxy.minFactions,
      );
      expect(sector.factions.length).toBeLessThanOrEqual(
        CONFIG.galaxy.maxFactions,
      );
      for (const faction of sector.factions) {
        const home = sector.portAt(faction.homePort);
        expect(home.faction).toBe(faction.index);
      }
      for (const port of sector.ports) {
        if (port.faction !== null) {
          expect(sector.factionAt(port.faction).index).toBe(port.faction);
        }
        expect(CONFIG.galaxy.portCharacters).toContain(port.character);
      }
    }
  });

  it("port and faction names are unique within a sector", () => {
    for (const seed of SAMPLE_SEEDS) {
      const sector = sectorFor(seed);
      expect(new Set(sector.ports.map((p) => p.name)).size).toBe(
        sector.ports.length,
      );
      expect(new Set(sector.factions.map((f) => f.name)).size).toBe(
        sector.factions.length,
      );
    }
  });
});

describe("the voyage leg", () => {
  it("endpoints differ, and the charter band is honoured when offered", () => {
    const g = CONFIG.galaxy;
    for (let seed = 1; seed <= 30; seed++) {
      const voyage = voyageFor(seed);
      expect(voyage.origin).not.toBe(voyage.destination);
      const offered = voyage.sector.ports.some((port) => {
        if (port.index === voyage.origin) return false;
        const days =
          voyage.sector.distanceBetween(voyage.originPort, port) /
          g.cruiseLightDaysPerDay;
        return days >= g.minLegDays && days <= g.maxLegDays;
      });
      if (offered) {
        expect(voyage.legDays).toBeGreaterThanOrEqual(g.minLegDays);
        expect(voyage.legDays).toBeLessThanOrEqual(g.maxLegDays + 0.01);
      }
    }
  });

  it("leg ticks match the distance and speed arithmetic", () => {
    for (const seed of SAMPLE_SEEDS) {
      const voyage = voyageFor(seed);
      const exactTicks =
        (voyage.distanceLightDays / CONFIG.galaxy.cruiseLightDaysPerDay) *
        CONFIG.time.ticksPerDay;
      expect(Math.abs(voyage.legTicks - exactTicks)).toBeLessThanOrEqual(0.5);
      expect(voyage.distanceLightDays).toBeCloseTo(
        voyage.sector.distanceBetween(
          voyage.originPort,
          voyage.destinationPort,
        ),
        9,
      );
    }
  });

  it("position is monotonic along the route and ends at the destination", () => {
    const voyage = voyageFor(42);
    const origin = voyage.originPort;
    const destination = voyage.destinationPort;
    expect(voyage.positionAt(0)).toEqual({ x: origin.x, y: origin.y });
    let last = 0;
    for (let tick = 0; tick <= voyage.legTicks + 200; tick += 37) {
      const pos = voyage.positionAt(tick);
      const covered = Math.hypot(pos.x - origin.x, pos.y - origin.y);
      expect(covered).toBeGreaterThanOrEqual(last - 1e-9);
      last = covered;
    }
    expect(voyage.positionAt(voyage.legTicks)).toEqual({
      x: destination.x,
      y: destination.y,
    });
    expect(voyage.positionAt(voyage.legTicks + 500)).toEqual({
      x: destination.x,
      y: destination.y,
    });
    expect(voyage.progressAt(-5)).toBe(0);
    expect(voyage.progressAt(voyage.legTicks + 5)).toBe(1);
    expect(voyage.inPortAt(voyage.legTicks - 1)).toBe(false);
    expect(voyage.inPortAt(voyage.legTicks)).toBe(true);
  });
});

describe("the voyage in a run", () => {
  it("departure leaves at tick 0 naming both ports", () => {
    const run = createRun({ seed: 42 });
    run.step();
    const departure = run.world.events.events.find(
      (e) => e.type === "departure",
    );
    expect(departure).toBeDefined();
    expect(departure?.tick).toBe(0);
    expect(departure?.data.from).toBe(run.galaxy.voyage.originPort.name);
    expect(departure?.data.to).toBe(run.galaxy.voyage.destinationPort.name);
    expect(departure?.data.ship).toBe(run.ship.name);
  });

  it(
    "arrival fires exactly once, on the tick the arithmetic names",
    () => {
      const { world } = runSimulation({ seed: 42 }, 4320);
      const voyage = voyageFor(42);
      const arrivals = world.events.events.filter((e) => e.type === "arrival");
      expect(arrivals.length).toBe(1);
      const arrival = arrivals[0] as (typeof arrivals)[number];
      expect(arrival.tick).toBe(voyage.legTicks);
      expect(arrival.data.port).toBe(voyage.destinationPort.name);
      expect(
        Math.abs((arrival.data.days as number) - voyage.legDays),
      ).toBeLessThanOrEqual(0.001);
      // The run sails on after arrival: the log does not end at the dock.
      expect(
        world.events.events.some((e) => e.tick > arrival.tick),
      ).toBe(true);
    },
    60_000,
  );

  it(
    "every daily seed arrives inside a 30-day run",
    () => {
      for (const seed of DAILY_SEEDS) {
        const run = createRun({ seed });
        const legTicks = run.galaxy.voyage.legTicks;
        expect(legTicks, `seed ${seed} leg`).toBeLessThan(4320);
        // Sail just past the arrival tick: enough to watch it fire,
        // without paying for eight full months of ship life.
        run.run(legTicks + 1);
        const arrivals = run.world.events.events.filter(
          (e) => e.type === "arrival",
        );
        expect(arrivals.length, `seed ${seed} arrivals`).toBe(1);
        expect((arrivals[0] as (typeof arrivals)[number]).tick).toBe(
          legTicks,
        );
      }
    },
    60_000,
  );
});
