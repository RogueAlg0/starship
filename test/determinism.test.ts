import { describe, expect, it } from "vitest";
import { StreamRegistry } from "../src/engine/rng.ts";
import { runSimulation } from "../src/sim.ts";

describe("determinism", () => {
  it("same seed twice gives identical hash and event count", () => {
    const a = runSimulation({ seed: 42 }, 120);
    const b = runSimulation({ seed: 42 }, 120);
    expect(a.world.events.hash()).toBe(b.world.events.hash());
    expect(a.world.events.size).toBe(b.world.events.size);
    expect(a.decisions).toEqual(b.decisions);
  });

  it("different seed gives a different hash", () => {
    const a = runSimulation({ seed: 42 }, 120);
    const b = runSimulation({ seed: 43 }, 120);
    expect(a.world.events.hash()).not.toBe(b.world.events.hash());
  });

  it("streams are independent: draws from one do not shift another", () => {
    const first = new StreamRegistry("7");
    const crewAlone = Array.from({ length: 5 }, () =>
      first.get("crew").next(),
    );

    const second = new StreamRegistry("7");
    for (let i = 0; i < 5; i++) second.get("weather").next();
    const crewAfterWeather = Array.from({ length: 5 }, () =>
      second.get("crew").next(),
    );

    expect(crewAfterWeather).toEqual(crewAlone);
  });

  it("same seed and stream name reproduce the same sequence", () => {
    const a = new StreamRegistry(99);
    const b = new StreamRegistry(99);
    const seqA = Array.from({ length: 8 }, () => a.get("weather").next());
    const seqB = Array.from({ length: 8 }, () => b.get("weather").next());
    expect(seqB).toEqual(seqA);
  });

  it("different stream names give different sequences", () => {
    const registry = new StreamRegistry(99);
    const weather = Array.from({ length: 8 }, () =>
      registry.get("weather").next(),
    );
    const fresh = new StreamRegistry(99);
    const crew = Array.from({ length: 8 }, () => fresh.get("crew").next());
    expect(crew).not.toEqual(weather);
  });
});
