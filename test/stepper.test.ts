import { describe, expect, it } from "vitest";
import { createRun, runSimulation } from "../src/sim.ts";

describe("stepper", () => {
  it("stepping 500 ticks manually equals the batch run", () => {
    const batch = runSimulation({ seed: 42 }, 500);
    const run = createRun({ seed: 42 });
    for (let i = 0; i < 500; i++) run.step();
    expect(run.tick).toBe(500);
    expect(run.hash()).toBe(batch.world.events.hash());
    expect(run.world.events.size).toBe(batch.world.events.size);
    expect(run.decisions).toEqual(batch.decisions);
  });

  it("mixed stepping and batching keeps the same identity", () => {
    const batch = runSimulation({ seed: 7 }, 300);
    const run = createRun({ seed: 7 });
    for (let i = 0; i < 120; i++) run.step();
    run.run(180);
    expect(run.hash()).toBe(batch.world.events.hash());
    expect(run.world.events.size).toBe(batch.world.events.size);
  });

  it("a fresh context has only the generation events and tick zero", () => {
    const run = createRun({ seed: 42 });
    expect(run.tick).toBe(0);
    expect(run.world.events.size).toBe(2); // ship_generated, crew_generated
    run.step();
    // First step adds run_start and departure ahead of the tick's events.
    const types = run.world.events.events.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      "ship_generated",
      "crew_generated",
      "run_start",
      "departure",
    ]);
  });
});
