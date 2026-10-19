import { describe, expect, it } from "vitest";
import { UtilitySource } from "../src/decision/decisions.ts";
import { Engine, World } from "../src/engine/engine.ts";
import { StreamRegistry } from "../src/engine/rng.ts";
import { generateCrew, type CrewMember } from "../src/entities/crew.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun } from "../src/sim.ts";
import {
  generateSector,
  Voyage,
  type Sector,
} from "../src/world/galaxy.ts";
import { generateShip, type Ship } from "../src/world/ship.ts";
import {
  applyResupply,
  consumptionMilliPerDay,
  createStores,
  dailyUseMilli,
  daysOf,
  productionMilliPerDay,
  stepStores,
  STORE_KEYS,
  type StoresState,
} from "../src/world/stores.ts";
import { generateTraffic, Traffic } from "../src/world/traffic.ts";

const TPD = CONFIG.time.ticksPerDay;

/**
 * A stores harness: the real generation order (ship, crew, sector,
 * voyage, traffic, as sim.ts draws them) with only the voyage and
 * stores systems stepped, so flows can be measured without the
 * crew's own appetites moving the furniture.
 */
interface Harness {
  world: World;
  engine: Engine;
  ship: Ship;
  crew: CrewMember[];
  stores: StoresState;
  voyage: Voyage;
  sector: Sector;
}

function harness(seed = 42): Harness {
  const world = new World({ seed }, new UtilitySource());
  const engine = new Engine(world);
  const ship = generateShip(world.rng.get("shipgen"));
  const crew = generateCrew(
    world.rng.get("crewgen"),
    ship,
    world.rng.get("routine"),
  );
  const sector = generateSector(world.rng.get("galaxy"));
  const voyage = new Voyage(world.rng.get("galaxy"), sector);
  const traffic = new Traffic(
    sector,
    generateTraffic(world.rng.get("traffic"), sector, ship.name),
    voyage,
  );
  const stores = createStores(crew.length);
  ship.stores = stores;
  engine.addSystem({ name: "voyage", step: (w) => voyage.step(w) });
  engine.addSystem({
    name: "stores",
    step: (w) => stepStores(w, ship, crew, { sector, voyage, traffic }),
  });
  return { world, engine, ship, crew, stores, voyage, sector };
}

function setCondition(h: Harness, kind: string, condition: number): void {
  for (const system of h.ship.systems) {
    if (system.kind === kind) system.condition = condition;
  }
}

function quartermaster(h: Harness): CrewMember {
  const qm = h.crew.find((m) => m.roleKey === "quartermaster");
  if (qm === undefined) throw new Error("no quartermaster aboard");
  return qm;
}

describe("stores arithmetic", () => {
  it("production is the system's rate times its condition", () => {
    const h = harness();
    setCondition(h, "hydroponics rig", 1);
    setCondition(h, "life support", 1);
    const daily = dailyUseMilli(h.stores, "food");
    expect(productionMilliPerDay(h.stores, h.ship, h.crew, "food", 0)).toBeCloseTo(
      CONFIG.stores.productionFactor.food * daily,
      6,
    );
    expect(productionMilliPerDay(h.stores, h.ship, h.crew, "oxygen", 0)).toBeCloseTo(
      CONFIG.stores.productionFactor.oxygen * daily,
      6,
    );
    setCondition(h, "hydroponics rig", 0.5);
    setCondition(h, "life support", 0.5);
    expect(productionMilliPerDay(h.stores, h.ship, h.crew, "food", 0)).toBeCloseTo(
      0.5 * CONFIG.stores.productionFactor.food * daily,
      6,
    );
    setCondition(h, "hydroponics rig", 0);
    expect(productionMilliPerDay(h.stores, h.ship, h.crew, "food", 0)).toBe(0);
    expect(productionMilliPerDay(h.stores, h.ship, h.crew, "fuel", 0)).toBe(0);
  });

  it("a healthy ship gains a little food; a dead rig loses a day a day", () => {
    const h = harness();
    setCondition(h, "hydroponics rig", 1);
    const before = h.stores.byKey.food.qtyMilli;
    h.engine.run(TPD);
    const gain = h.stores.byKey.food.qtyMilli - before;
    const expected =
      (CONFIG.stores.productionFactor.food - 1) *
      dailyUseMilli(h.stores, "food");
    expect(Math.abs(gain - expected)).toBeLessThanOrEqual(2);

    const dead = harness();
    setCondition(dead, "hydroponics rig", 0);
    const deadBefore = dead.stores.byKey.food.qtyMilli;
    dead.engine.run(TPD);
    const loss = deadBefore - dead.stores.byKey.food.qtyMilli;
    expect(
      Math.abs(loss - dailyUseMilli(dead.stores, "food")),
    ).toBeLessThanOrEqual(2);
  });

  it("rationing bends consumption by the configured factor", () => {
    const h = harness();
    const daily = dailyUseMilli(h.stores, "food");
    expect(consumptionMilliPerDay(h.stores, "food", true)).toBe(daily);
    h.stores.rationing.food = true;
    expect(consumptionMilliPerDay(h.stores, "food", true)).toBeCloseTo(
      daily * CONFIG.stores.rationing.consumptionFactor,
      6,
    );
    // Fuel burns by the day under way and sips in port.
    const fuelDaily = dailyUseMilli(h.stores, "fuel");
    expect(consumptionMilliPerDay(h.stores, "fuel", true)).toBe(fuelDaily);
    expect(consumptionMilliPerDay(h.stores, "fuel", false)).toBeCloseTo(
      fuelDaily * CONFIG.stores.fuelDockedFraction,
      6,
    );
  });

  it("departure stores sit inside the chapter's buffers", () => {
    const stores = createStores(12);
    expect(daysOf(stores, "food")).toBeGreaterThanOrEqual(30);
    expect(daysOf(stores, "food")).toBeLessThanOrEqual(45);
    for (const key of STORE_KEYS) {
      expect(daysOf(stores, key)).toBeGreaterThan(0);
      expect(stores.byKey[key].qtyMilli).toBeLessThanOrEqual(
        stores.byKey[key].capMilli,
      );
    }
  });
});

describe("resupply", () => {
  it("fills toward the port character's cap and never above capacity", () => {
    const stores = createStores(12);
    for (const key of STORE_KEYS) stores.byKey[key].qtyMilli = 0;
    const manifest = applyResupply(stores, "agrarian");
    const food = manifest.find((e) => e.store === "food");
    expect(food?.full).toBe(true);
    expect(stores.byKey.food.qtyMilli).toBe(stores.byKey.food.capMilli);
    expect(stores.byKey.parts.qtyMilli).toBe(
      Math.round(stores.byKey.parts.capMilli * 0.5),
    );
    // A second taking aboard changes nothing: caps are caps.
    const again = applyResupply(stores, "free port");
    for (const key of STORE_KEYS) {
      expect(stores.byKey[key].qtyMilli).toBeLessThanOrEqual(
        stores.byKey[key].capMilli,
      );
    }
    expect(again.every((e) => e.full)).toBe(true);
  });

  it("a listening post gives little, but no ship sails short of fuel", () => {
    const stores = createStores(12);
    for (const key of STORE_KEYS) stores.byKey[key].qtyMilli = 0;
    applyResupply(stores, "listening post");
    expect(stores.byKey.food.qtyMilli).toBe(
      Math.round(stores.byKey.food.capMilli * 0.35),
    );
    expect(stores.byKey.parts.qtyMilli).toBe(
      Math.round(stores.byKey.parts.capMilli * 0.2),
    );
    expect(stores.byKey.fuel.qtyMilli).toBe(
      Math.round(
        stores.byKey.fuel.capMilli *
          CONFIG.stores.port.minDepartureFuelFraction,
      ),
    );
    // The floor alone outlasts the longest leg in the band.
    expect(daysOf(stores, "fuel")).toBeGreaterThan(CONFIG.galaxy.maxLegDays);
  });

  it("a shrine's material gift is small; a shipyard fills the parts locker", () => {
    const stores = createStores(12);
    for (const key of STORE_KEYS) stores.byKey[key].qtyMilli = 0;
    applyResupply(stores, "shrine");
    expect(stores.byKey.parts.qtyMilli).toBe(
      Math.round(stores.byKey.parts.capMilli * 0.15),
    );
    applyResupply(stores, "shipyard");
    expect(stores.byKey.parts.qtyMilli).toBe(stores.byKey.parts.capMilli);
  });
});

describe("rationing", () => {
  it("the quartermaster imposes it below the trigger and lifts it past the lift line", () => {
    const h = harness();
    const qm = quartermaster(h);
    qm.traits.splice(0, qm.traits.length);
    setCondition(h, "hydroponics rig", 0);
    // Eleven and a half days: under the trigger, above the low line.
    h.stores.byKey.food.qtyMilli = Math.round(11.5 * dailyUseMilli(h.stores, "food"));
    h.engine.run(10);
    expect(h.stores.rationing.food).toBe(true);
    const imposed = h.world.events.events.filter(
      (e) => e.type === "rationing_imposed",
    );
    expect(imposed.length).toBe(1);
    expect(imposed[0]?.data.by).toBe(qm.id);
    expect(imposed[0]?.data.store).toBe("food");

    // Fifteen days is inside the hysteresis band: still rationed.
    setCondition(h, "hydroponics rig", 1);
    h.stores.byKey.food.qtyMilli = Math.round(15 * dailyUseMilli(h.stores, "food"));
    h.engine.run(10);
    expect(h.stores.rationing.food).toBe(true);
    // Production at 1.06 against rationed consumption at 0.7 climbs
    // through the lift line in a few days; the lift speaks once.
    h.engine.run(12 * TPD);
    expect(h.stores.rationing.food).toBe(false);
    const lifted = h.world.events.events.filter(
      (e) => e.type === "rationing_lifted",
    );
    expect(lifted.length).toBe(1);
    expect(lifted[0]?.data.reason).toBe("recovered");
  });

  it("the quartermaster's traits bend the trigger both ways", () => {
    const anxious = harness();
    const aqm = quartermaster(anxious);
    aqm.traits.splice(0, aqm.traits.length, "anxious");
    setCondition(anxious, "hydroponics rig", 0);
    anxious.stores.byKey.food.qtyMilli = Math.round(
      13.5 * dailyUseMilli(anxious.stores, "food"),
    );
    anxious.engine.run(10);
    expect(anxious.stores.rationing.food).toBe(true);

    const kind = harness();
    const kqm = quartermaster(kind);
    kqm.traits.splice(0, kqm.traits.length, "kind");
    setCondition(kind, "hydroponics rig", 0);
    kind.stores.byKey.food.qtyMilli = Math.round(
      11 * dailyUseMilli(kind.stores, "food"),
    );
    kind.engine.run(10);
    expect(kind.stores.rationing.food).toBe(false);
  });
});

describe("theft and the tally", () => {
  it(
    "stolen food reconciles: ship store plus caches plus eaten is the whole",
    () => {
      const h = harness();
      const savedChance = CONFIG.stores.theft.chancePerDay;
      CONFIG.stores.theft.chancePerDay = 1;
      try {
        // One hoarding hand aboard, a dead rig, and short stores:
        // scarcity is guaranteed, and so is temptation.
        const thief = h.crew[3] as CrewMember;
        if (!thief.traits.includes("hoarding")) thief.traits.push("hoarding");
        setCondition(h, "hydroponics rig", 0);
        h.stores.byKey.food.qtyMilli = Math.round(
          6 * dailyUseMilli(h.stores, "food"),
        );
        // The books start where the test starts the store.
        h.stores.initialMilli.food = h.stores.byKey.food.qtyMilli;
        h.engine.run(30 * TPD);
      } finally {
        CONFIG.stores.theft.chancePerDay = savedChance;
      }
      const thefts = h.world.events.events.filter((e) => e.type === "theft");
      expect(thefts.length).toBeGreaterThanOrEqual(2);
      // Every stolen milli-unit is in a cache or has been eaten.
      const cached = Object.values(h.stores.caches).reduce((a, b) => a + b, 0);
      expect(cached + h.stores.cacheEatenMilli).toBe(
        thefts.length * CONFIG.stores.theft.takeMilli,
      );
      // The food identity, exact to the milli-unit.
      const food = h.stores.byKey.food;
      const totals = h.stores.totals.food;
      expect(
        h.stores.initialMilli.food +
          totals.producedMilli +
          totals.resuppliedMilli +
          totals.consumedMilli +
          totals.chargedMilli,
      ).toBe(food.qtyMilli + cached + h.stores.cacheEatenMilli);
      // The theft entered the beliefs machinery somehow: seen, or
      // found by the tally.
      const witnessed = thefts.filter((e) => e.data.witnessed === true).length;
      const discrepancies = h.world.events.events.filter(
        (e) => e.type === "stores_discrepancy",
      ).length;
      expect(witnessed + discrepancies).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("fuel and the drift", () => {
  it(
    "an empty tank slows the voyage clock but can never strand the ship",
    () => {
      const run = createRun({ seed: 42 });
      run.run(100);
      const { voyage } = run.galaxy;
      expect(voyage.inPortAt(run.tick)).toBe(false);
      // The tank is empty from here on: every tick, the test holds
      // it at zero, the way a holed tank would. The ship drifts on
      // momentum at the drift rate — slower, never stopped.
      const before = voyage.positionAt(run.tick);
      for (let i = 0; i < 400; i++) {
        run.stores.byKey.fuel.qtyMilli = 0;
        run.step();
      }
      expect(voyage.drifting).toBe(true);
      const dead = run.world.events.events.filter(
        (e) => e.type === "dead_in_space",
      );
      expect(dead.length).toBe(1);
      const after = voyage.positionAt(run.tick);
      expect(after).not.toEqual(before);
      // 400 real ticks at the drift rate buy about 100 ticks of
      // voyage: progress, at a quarter of the pace.
      const advanced =
        voyage.voyageTimeAt(run.tick) - voyage.voyageTimeAt(100);
      expect(advanced).toBeGreaterThan(90);
      expect(advanced).toBeLessThan(110);
      // The invariant the frozen-clock version broke: arrival
      // stays reachable from the drift. At the drift rate the
      // whole remaining leg costs at most four times its ticks.
      const bound = 100 + 4 * (voyage.legTicks - 100) + TPD;
      let arrivalTick = -1;
      while (run.tick < bound) {
        run.stores.byKey.fuel.qtyMilli = 0;
        run.step();
        const arrival = run.world.events.events.find(
          (e) => e.type === "arrival",
        );
        if (arrival !== undefined) {
          arrivalTick = arrival.tick;
          break;
        }
      }
      expect(arrivalTick).toBeGreaterThan(voyage.legTicks);
      expect(arrivalTick).toBeLessThanOrEqual(bound);
      // And the story completes: in port, the manifest refuels
      // her. The drift ends at the dock, not in the black.
      run.run(200);
      const resupply = run.world.events.events.find(
        (e) => e.type === "resupply" && e.tick > arrivalTick,
      );
      expect(resupply).toBeDefined();
      expect(run.stores.byKey.fuel.qtyMilli).toBeGreaterThan(0);
      expect(voyage.drifting).toBe(false);
    },
    60_000,
  );
});

describe("stores over long runs", () => {
  it(
    "quantities stay inside their tanks across seeds and seasons",
    () => {
      for (const seed of [11, 16, 42, 99]) {
        const run = createRun({ seed });
        // The engine's own invariant throws on any violation; this
        // run finishing is the assertion, with the books checked
        // at the end for good measure.
        run.run(90 * TPD);
        for (const key of STORE_KEYS) {
          const store = run.stores.byKey[key];
          expect(store.qtyMilli).toBeGreaterThanOrEqual(0);
          expect(store.qtyMilli).toBeLessThanOrEqual(store.capMilli);
        }
        for (const cache of Object.values(run.stores.caches)) {
          expect(cache).toBeGreaterThanOrEqual(0);
        }
      }
    },
    120_000,
  );
});
