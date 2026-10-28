import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun } from "../src/sim.ts";
import { productionMilliPerDay } from "../src/world/stores.ts";
import { DUTY_DEFS } from "../src/world/duties.ts";

const TPD = CONFIG.time.ticksPerDay;

function eventsOf(run: ReturnType<typeof createRun>, type: string) {
  return run.world.events.events.filter((e) => e.type === type);
}

describe("the upkeep layer", () => {
  it("every duty starts kept up, in range, and owned", () => {
    const run = createRun({ seed: 42 });
    const duties = run.ship.duties;
    expect(duties).not.toBeNull();
    for (const def of DUTY_DEFS) {
      const state = duties?.byId[def.id];
      expect(state, def.id).toBeDefined();
      expect(state?.level).toBeGreaterThan(CONFIG.duties.neglectLine);
      expect(state?.level).toBeLessThanOrEqual(1);
      expect(def.owners.length).toBeGreaterThan(0);
      expect(def.department).not.toBe("");
    }
  });

  it("neglect is announced once per crossing, and restoration follows service", () => {
    // Seed 11's sanitation lapses and recovers inside 90 days
    // (measured on the duties dig): the announcement fires, and
    // every restoration answers an earlier neglect of that duty.
    const run = createRun({ seed: 11, checkInvariants: true });
    run.run(90 * TPD);
    const neglected = eventsOf(run, "duty_neglected");
    const restored = eventsOf(run, "duty_restored");
    expect(neglected.length).toBeGreaterThanOrEqual(1);
    expect(restored.length).toBeGreaterThanOrEqual(1);
    const open = new Set<string>();
    for (const event of run.world.events.events) {
      if (event.type === "duty_neglected") {
        const duty = String(event.data.duty);
        expect(open.has(duty), `double neglect of ${duty}`).toBe(false);
        open.add(duty);
      }
      if (event.type === "duty_restored") {
        const duty = String(event.data.duty);
        expect(open.has(duty), `restoration without neglect: ${duty}`).toBe(
          true,
        );
        open.delete(duty);
      }
    }
  }, 300_000);

  it("neglected filters and crops tax production by their floors", () => {
    const run = createRun({ seed: 42 });
    run.run(2 * TPD);
    const ship = run.ship;
    const duties = ship.duties;
    expect(duties).not.toBeNull();
    const oxygenFull = productionMilliPerDay(
      run.stores,
      ship,
      run.crew,
      "oxygen",
      run.world.tick,
    );
    const foodFull = productionMilliPerDay(
      run.stores,
      ship,
      run.crew,
      "food",
      run.world.tick,
    );
    if (duties !== null) {
      (duties.byId["filters"] as { level: number }).level = 0;
      (duties.byId["crops"] as { level: number }).level = 0;
    }
    const oxygenDry = productionMilliPerDay(
      run.stores,
      ship,
      run.crew,
      "oxygen",
      run.world.tick,
    );
    const foodDry = productionMilliPerDay(
      run.stores,
      ship,
      run.crew,
      "food",
      run.world.tick,
    );
    // Levels start at 0.9, so the full figures already carry a
    // small tax; what the law pins is the floor at zero: oxygen
    // falls to the filter floor of its untaxed rate, food to
    // the crop floor.
    expect(oxygenDry).toBeLessThan(oxygenFull);
    expect(foodDry).toBeLessThan(foodFull);
    expect(oxygenDry / oxygenFull).toBeGreaterThan(0.5);
    expect(foodDry / foodFull).toBeGreaterThan(0.35);
  });

  it("a kept-up ship keeps its duties off the floor over 90 days", () => {
    const run = createRun({ seed: 42, checkInvariants: true });
    run.run(90 * TPD);
    for (const def of DUTY_DEFS) {
      const state = run.ship.duties?.byId[def.id];
      expect(state?.level, def.id).toBeGreaterThan(0.35);
    }
  }, 300_000);
});
