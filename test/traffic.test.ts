import { describe, expect, it } from "vitest";
import { UtilitySource } from "../src/decision/decisions.ts";
import { Engine, World } from "../src/engine/engine.ts";
import { StreamRegistry } from "../src/engine/rng.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun } from "../src/sim.ts";
import {
  generateSector,
  Sector,
  type Port,
} from "../src/world/galaxy.ts";
import {
  generateTraffic,
  Traffic,
  TrafficShip,
  type PlayerTrack,
  type TrafficLeg,
} from "../src/world/traffic.ts";

const TICKS_30_DAYS = 4320;
const SAMPLE_SEEDS = [1, 7, 11, 16, 17, 30, 39, 40, 42, 99];
const DAILY_SEEDS = [11, 16, 17, 30, 39, 40, 42, 99];

/** The traffic a seed sails with, drawn the way the engine draws it. */
function trafficFor(seed: number): { sector: Sector; ships: TrafficShip[] } {
  const registry = new StreamRegistry(seed);
  const sector = generateSector(registry.get("galaxy"));
  // A stand-in player name; only its exclusion from the name pool matters.
  const ships = generateTraffic(registry.get("traffic"), sector, "Player Ship");
  return { sector, ships };
}

describe("traffic generation", () => {
  it("same seed gives the same traffic, ship for ship", () => {
    const a = trafficFor(42).ships.map((s) => s.signature());
    const b = trafficFor(42).ships.map((s) => s.signature());
    expect(a).toEqual(b);
  });

  it("different seeds give different traffic", () => {
    const signatures = new Set(
      [1, 2, 3, 4, 5].map((seed) =>
        trafficFor(seed)
          .ships.map((s) => s.signature())
          .join("|"),
      ),
    );
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("ship counts, kinds, and registries stay in their tables", () => {
    const t = CONFIG.traffic;
    const kinds = new Set(t.shipTypes.map((entry) => entry.kind));
    for (const seed of SAMPLE_SEEDS) {
      const { sector, ships } = trafficFor(seed);
      expect(ships.length).toBeGreaterThanOrEqual(t.minShips);
      expect(ships.length).toBeLessThanOrEqual(t.maxShips);
      const names = new Set(ships.map((s) => s.name));
      expect(names.size).toBe(ships.length);
      expect(names.has("Player Ship")).toBe(false);
      for (const ship of ships) {
        expect(kinds.has(ship.type)).toBe(true);
        if (ship.faction !== null) {
          expect(sector.factionAt(ship.faction).index).toBe(ship.faction);
          // A registered ship is berthed at her faction's home port.
          expect(ship.homePort).toBe(sector.factionAt(ship.faction).homePort);
        }
        const factor = t.shipTypes.find((e) => e.kind === ship.type)
          ?.cruiseFactor as number;
        expect(ship.cruiseLightDaysPerDay).toBeCloseTo(
          CONFIG.galaxy.cruiseLightDaysPerDay * factor,
          9,
        );
      }
    }
  });

  it("schedules are sane: chained legs, ordered ticks, real ports", () => {
    for (const seed of SAMPLE_SEEDS) {
      const { sector, ships } = trafficFor(seed);
      for (const ship of ships) {
        expect(ship.legs.length).toBeGreaterThan(0);
        let previous: TrafficLeg | null = null;
        for (const leg of ship.legs) {
          expect(leg.from).not.toBe(leg.to);
          expect(sector.portAt(leg.from).index).toBe(leg.from);
          expect(sector.portAt(leg.to).index).toBe(leg.to);
          expect(leg.arriveTick).toBeGreaterThan(leg.departTick);
          // Travel time is the distance over her own cruise speed.
          const distance = sector.distanceBetween(
            sector.portAt(leg.from),
            sector.portAt(leg.to),
          );
          const exact =
            (distance / ship.cruiseLightDaysPerDay) *
            CONFIG.time.ticksPerDay;
          expect(Math.abs(leg.arriveTick - leg.departTick - exact)).toBeLessThanOrEqual(0.5);
          if (previous === null) {
            expect(leg.from).toBe(ship.homePort);
            // The first sailing is never on tick 0.
            expect(leg.departTick).toBeGreaterThanOrEqual(
              CONFIG.traffic.minStayTicks,
            );
          } else {
            expect(leg.from).toBe(previous.to);
            expect(leg.departTick).toBeGreaterThanOrEqual(previous.arriveTick);
            const stay = leg.departTick - previous.arriveTick;
            expect(stay).toBeGreaterThanOrEqual(CONFIG.traffic.minStayTicks);
            expect(stay).toBeLessThanOrEqual(CONFIG.traffic.maxStayTicks);
          }
          previous = leg;
        }
        // The table covers the horizon the config promises.
        const last = ship.legs[ship.legs.length - 1] as TrafficLeg;
        expect(last.arriveTick).toBeGreaterThan(
          CONFIG.traffic.scheduleHorizonDays * CONFIG.time.ticksPerDay -
            60 * CONFIG.time.ticksPerDay,
        );
      }
    }
  });
});

describe("traffic positions", () => {
  it("position is a pure function of the tick, inside the sector", () => {
    const span = CONFIG.galaxy.sectorSpanLightDays;
    for (const seed of SAMPLE_SEEDS) {
      const { ships } = trafficFor(seed);
      for (const ship of ships) {
        for (let tick = 0; tick < 6000; tick += 173) {
          const a = ship.positionAt(tick);
          const b = ship.positionAt(tick);
          expect(a).toEqual(b);
          expect(a.x).toBeGreaterThanOrEqual(0);
          expect(a.x).toBeLessThanOrEqual(span);
          expect(a.y).toBeGreaterThanOrEqual(0);
          expect(a.y).toBeLessThanOrEqual(span);
        }
      }
    }
  });

  it("a berthed ship sits exactly on her port; a sailing ship interpolates", () => {
    const { sector, ships } = trafficFor(42);
    for (const ship of ships) {
      // Tick 0: everyone lies at their home port, in their first stay.
      expect(ship.portAt(0)).toBe(ship.homePort);
      expect(ship.legAt(0)).toBeNull();
      expect(ship.positionAt(0)).toEqual({
        x: ship.homePortRef.x,
        y: ship.homePortRef.y,
      });
      // The middle of a stay: exactly on the port she made.
      const leg = ship.legs[0] as TrafficLeg;
      const next = ship.legs[1];
      if (next !== undefined) {
        const midStay = Math.floor((leg.arriveTick + next.departTick) / 2);
        const port = sector.portAt(leg.to);
        expect(ship.portAt(midStay)).toBe(leg.to);
        expect(ship.positionAt(midStay)).toEqual({ x: port.x, y: port.y });
      }
      // The middle of a leg: halfway between the two ports.
      const midLeg = Math.floor((leg.departTick + leg.arriveTick) / 2);
      const from = sector.portAt(leg.from);
      const to = sector.portAt(leg.to);
      const frac = (midLeg - leg.departTick) / (leg.arriveTick - leg.departTick);
      const pos = ship.positionAt(midLeg);
      expect(ship.legAt(midLeg)).toEqual(leg);
      expect(pos.x).toBeCloseTo(from.x + (to.x - from.x) * frac, 9);
      expect(pos.y).toBeCloseTo(from.y + (to.y - from.y) * frac, 9);
    }
  });
});

/** A hand-built sector: two ports on the player's line, two far off it. */
function handSector(): Sector {
  const port = (index: number, x: number, y: number): Port => ({
    index,
    id: `port-${index}`,
    name: `Port ${index}`,
    x,
    y,
    faction: null,
    character: "industrial",
  });
  return new Sector(
    [port(0, 2, 2), port(1, 58, 2), port(2, 58, 58), port(3, 2, 58)],
    [],
  );
}

/** A plain player track: out of port 0 for port 1 over `legTicks`. */
function handTrack(legTicks: number): PlayerTrack {
  return {
    positionAt: (tick) => {
      const t = Math.min(1, Math.max(0, tick / legTicks));
      return { x: 2 + 56 * t, y: 2 };
    },
    inPortAt: (tick) => tick >= legTicks,
    portIndexAt: (tick) => (tick <= 0 ? 0 : tick >= legTicks ? 1 : null),
  };
}

function handShip(
  sector: Sector,
  fields: Partial<{
    homePort: number;
    legs: TrafficLeg[];
  }>,
): TrafficShip {
  return new TrafficShip(sector, {
    index: 0,
    id: "traffic-0",
    name: "Hand Built",
    type: "hauler",
    faction: null,
    homePort: fields.homePort ?? 2,
    cruiseLightDaysPerDay: 2,
    legs: fields.legs ?? [],
  });
}

function runTraffic(
  sector: Sector,
  ships: TrafficShip[],
  track: PlayerTrack,
  ticks: number,
): World {
  const world = new World({ seed: 1 }, new UtilitySource());
  const traffic = new Traffic(sector, ships, track);
  const engine = new Engine(world);
  engine.addSystem({ name: "traffic", step: (w) => traffic.step(w) });
  engine.run(ticks);
  return world;
}

describe("contacts, constructed cases", () => {
  it("a ship that never comes near makes no events at all", () => {
    const sector = handSector();
    // She shuttles between the two far ports, 56 light-days off the
    // player's line at the closest, forever out of sensor range.
    const legs: TrafficLeg[] = [];
    for (let i = 0; i < 6; i++) {
      const from = i % 2 === 0 ? 2 : 3;
      legs.push({
        from,
        to: from === 2 ? 3 : 2,
        departTick: 100 + i * 400,
        arriveTick: 400 + i * 400,
      });
    }
    const ship = handShip(sector, { homePort: 2, legs });
    const world = runTraffic(sector, [ship], handTrack(2000), 2500);
    expect(world.events.size).toBe(0);
  });

  it("a ship berthed at the destination is a contact on approach, then port company", () => {
    const sector = handSector();
    const ship = handShip(sector, { homePort: 1, legs: [] });
    const world = runTraffic(sector, [ship], handTrack(1000), 1200);
    const contacts = world.events.events.filter((e) => e.type === "contact");
    const lost = world.events.events.filter((e) => e.type === "contact_lost");
    const portTraffic = world.events.events.filter(
      (e) => e.type === "port_traffic",
    );
    // Range closes 56 light-days over 1000 ticks: it crosses the
    // 8 light-day sensor line at tick 858, exactly.
    expect(contacts.length).toBe(1);
    expect(contacts[0]?.tick).toBe(858);
    expect(contacts[0]?.data.inPort).toBe("Port 1");
    expect(contacts[0]?.data.motion).toBe("berthed");
    // Docking closes the contact without a lost line, and a ship
    // that was already there makes no port traffic of her own.
    expect(lost.length).toBe(0);
    expect(portTraffic.length).toBe(0);
  });

  it("a ship bound for the player's port is port traffic, never a contact", () => {
    const sector = handSector();
    const ship = handShip(sector, {
      homePort: 3,
      legs: [
        { from: 3, to: 1, departTick: 1200, arriveTick: 1500 },
        { from: 1, to: 3, departTick: 1600, arriveTick: 1900 },
      ],
    });
    const world = runTraffic(sector, [ship], handTrack(1000), 2200);
    const events = world.events.events;
    expect(events.filter((e) => e.type === "contact").length).toBe(0);
    expect(events.filter((e) => e.type === "contact_lost").length).toBe(0);
    const portTraffic = events.filter((e) => e.type === "port_traffic");
    expect(portTraffic.length).toBe(2);
    expect(portTraffic[0]?.tick).toBe(1500);
    expect(portTraffic[0]?.data.movement).toBe("arrived");
    expect(portTraffic[0]?.data.port).toBe("Port 1");
    expect(portTraffic[1]?.tick).toBe(1600);
    expect(portTraffic[1]?.data.movement).toBe("departed");
  });
});

interface ExpectedEvent {
  tick: number;
  type: string;
  shipIndex: number;
  movement?: string;
}

/**
 * The contact ledger, re-derived from the position functions and
 * the documented rules alone: range edges, the port-eligibility
 * rule, silent closes. If the engine and this derivation ever
 * disagree, one of them has misunderstood the rules.
 */
function expectedTrafficEvents(
  run: ReturnType<typeof createRun>,
  ticks: number,
): ExpectedEvent[] {
  const { sector, voyage, traffic } = run.galaxy;
  void sector;
  const range = CONFIG.traffic.sensorRangeLightDays;
  const out: ExpectedEvent[] = [];
  const inPrev = new Map<number, boolean>();
  const announced = new Map<number, boolean>();
  for (let tick = 0; tick < ticks; tick++) {
    const playerPort = voyage.portIndexAt(tick);
    const playerPos = voyage.positionAt(tick);
    for (const ship of traffic.ships) {
      if (playerPort !== null) {
        for (const leg of ship.legs) {
          if (leg.arriveTick === tick && leg.to === playerPort) {
            out.push({
              tick,
              type: "port_traffic",
              shipIndex: ship.index,
              movement: "arrived",
            });
          } else if (leg.departTick === tick && leg.from === playerPort) {
            out.push({
              tick,
              type: "port_traffic",
              shipIndex: ship.index,
              movement: "departed",
            });
          }
        }
      }
      const pos = ship.positionAt(tick);
      const dist = Math.hypot(pos.x - playerPos.x, pos.y - playerPos.y);
      const inNow = dist <= range;
      const inWas = inPrev.get(ship.index) ?? false;
      let eligible = true;
      if (playerPort !== null) {
        const leg = ship.legAt(tick);
        if (ship.portAt(tick) === playerPort) eligible = false;
        else if (leg !== null && leg.to === playerPort) eligible = false;
      }
      if (inNow && !inWas && eligible && !(announced.get(ship.index) ?? false)) {
        out.push({ tick, type: "contact", shipIndex: ship.index });
        announced.set(ship.index, true);
      }
      if (!inNow && inWas && (announced.get(ship.index) ?? false)) {
        out.push({ tick, type: "contact_lost", shipIndex: ship.index });
        announced.set(ship.index, false);
      }
      if (!eligible && (announced.get(ship.index) ?? false)) {
        announced.set(ship.index, false);
      }
      inPrev.set(ship.index, inNow);
    }
  }
  return out;
}

describe("contacts in a run", () => {
  it(
    "the event stream matches the geometry, derived independently",
    () => {
      for (const seed of [42, 17]) {
        const run = createRun({ seed });
        run.run(TICKS_30_DAYS);
        const actual: ExpectedEvent[] = run.world.events.events
          .filter(
            (e) =>
              e.type === "contact" ||
              e.type === "contact_lost" ||
              e.type === "port_traffic",
          )
          .map((e) => {
            const entry: ExpectedEvent = {
              tick: e.tick,
              type: e.type,
              shipIndex: e.data.shipIndex as number,
            };
            if (e.type === "port_traffic") {
              entry.movement = e.data.movement as string;
            }
            return entry;
          });
        expect(actual, `seed ${seed}`).toEqual(
          expectedTrafficEvents(run, TICKS_30_DAYS),
        );
        // The derivation is not vacuous: these seeds do meet people.
        expect(actual.length).toBeGreaterThan(0);
      }
    },
    60_000,
  );

  it(
    "contacts and losses alternate per ship; a loss never leads",
    () => {
      for (const seed of DAILY_SEEDS) {
        const run = createRun({ seed });
        run.run(TICKS_30_DAYS);
        const perShip = new Map<number, string[]>();
        for (const e of run.world.events.events) {
          if (e.type !== "contact" && e.type !== "contact_lost") continue;
          const list = perShip.get(e.data.shipIndex as number) ?? [];
          list.push(e.type);
          perShip.set(e.data.shipIndex as number, list);
        }
        for (const [index, list] of perShip) {
          list.forEach((type, i) => {
            expect(type, `seed ${seed} ship ${index} event ${i}`).toBe(
              i % 2 === 0 ? "contact" : "contact_lost",
            );
          });
        }
      }
    },
    60_000,
  );

  it(
    "port traffic speaks only of the port the player lies in",
    () => {
      for (const seed of DAILY_SEEDS) {
        const run = createRun({ seed });
        run.run(TICKS_30_DAYS);
        const { voyage } = run.galaxy;
        for (const e of run.world.events.events) {
          if (e.type !== "port_traffic") continue;
          const expected =
            e.tick >= voyage.legTicks
              ? voyage.destinationPort.name
              : voyage.originPort.name;
          expect(e.data.port, `seed ${seed} tick ${e.tick}`).toBe(expected);
        }
      }
    },
    60_000,
  );

  it(
    "contact payloads tell the truth about the ship they name",
    () => {
      const run = createRun({ seed: 42 });
      run.run(TICKS_30_DAYS);
      const { sector, traffic } = run.galaxy;
      const range = CONFIG.traffic.sensorRangeLightDays;
      const contacts = run.world.events.events.filter(
        (e) => e.type === "contact",
      );
      expect(contacts.length).toBeGreaterThan(0);
      for (const e of contacts) {
        const ship = traffic.ships[e.data.shipIndex as number] as TrafficShip;
        expect(e.data.ship).toBe(ship.name);
        expect(e.data.type).toBe(ship.type);
        expect(e.data.faction).toBe(
          ship.faction === null ? null : sector.factionAt(ship.faction).name,
        );
        // Detection happens at the sensor line, within a tick's travel.
        expect(e.data.range as number).toBeLessThanOrEqual(range);
        expect(e.data.range as number).toBeGreaterThan(range - 0.1);
        const leg = ship.legAt(e.tick);
        const berthed = ship.portAt(e.tick);
        if (leg !== null) {
          expect(e.data.boundFor).toBe(sector.portAt(leg.to).name);
          expect(e.data.inPort).toBeNull();
        } else {
          expect(berthed).not.toBeNull();
          expect(e.data.inPort).toBe(
            sector.portAt(berthed as number).name,
          );
          expect(e.data.boundFor).toBeNull();
          expect(e.data.motion).toBe("berthed");
        }
      }
    },
    60_000,
  );
});
