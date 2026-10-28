import { describe, expect, it } from "vitest";
import { StreamRegistry } from "../src/engine/rng.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, runSimulation } from "../src/sim.ts";
import { generateSector } from "../src/world/galaxy.ts";
import { bandOf, stepFactionStanding } from "../src/world/factions.ts";

const TICKS_PER_DAY = CONFIG.time.ticksPerDay;

function sectorFor(seed: number) {
  return generateSector(new StreamRegistry(seed).get("galaxy"));
}

describe("galactic factions: generation", () => {
  it("every faction has a kind and a temperament from the vocabularies", () => {
    for (const seed of [1, 7, 11, 16, 30, 42, 99]) {
      const sector = sectorFor(seed);
      expect(sector.factions.length).toBeGreaterThanOrEqual(3);
      for (const f of sector.factions) {
        expect(CONFIG.galaxy.factionKinds).toContain(f.kind);
        expect(CONFIG.galaxy.factionTemperaments).toContain(f.temperament);
      }
    }
  });

  it("the same seed grows the same powers", () => {
    const a = sectorFor(42);
    const b = sectorFor(42);
    expect(a.factions.map((f) => [f.name, f.kind, f.temperament])).toEqual(
      b.factions.map((f) => [f.name, f.kind, f.temperament]),
    );
  });
});

describe("standing: the ledger the voyage writes", () => {
  it("port calls warm the ledger by the written amounts, and bands cross once", () => {
    const run = createRun({ seed: 42 });
    const sector = run.galaxy.sector;
    const port = sector.ports.find((p) => p.faction !== null);
    if (port === undefined || port.faction === null) {
      throw new Error("seed 42 sector has no factioned port");
    }
    const faction = sector.factionAt(port.faction);
    const f = CONFIG.factions;
    // Five calls with long stays: arrival + stay bonus each.
    for (let i = 0; i < 5; i++) {
      run.world.emit("port_call", [], {
        port: port.name,
        portIndex: port.index,
        character: port.character,
        faction: faction.name,
        days: 1,
        stayDays: 3,
      });
      stepFactionStanding(run.world, run.standing, sector);
    }
    const perCall =
      f.arrivalGain +
      (faction.temperament === "greedy" ? f.stayBonus * 1.5 : f.stayBonus);
    const expected = Math.min(
      1,
      5 * (faction.temperament === "insular" ? perCall * 0.6 : perCall),
    );
    expect(run.standing.byId[faction.id]).toBeCloseTo(expected, 6);
    const crossed = run.world.events.events.filter(
      (e) => e.type === "faction_standing",
    );
    expect(crossed.length).toBe(1);
    expect(crossed[0]?.data["band"]).toBe("warm");
    expect(crossed[0]?.data["name"]).toBe(faction.name);
  });

  it("a real voyage warms somebody: standing accrues over a year at sea", () => {
    const run = createRun({ seed: 42 });
    run.run(365 * TICKS_PER_DAY);
    const warmed = Object.values(run.standing.byId).filter((v) => v > 0);
    expect(warmed.length).toBeGreaterThanOrEqual(1);
    for (const v of Object.values(run.standing.byId)) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  }, 240_000);

  it("the charter's arrival warms its faction by the arrival gain alone", () => {
    const run = createRun({ seed: 42 });
    const sector = run.galaxy.sector;
    const port = sector.ports.find((p) => p.faction !== null);
    if (port === undefined || port.faction === null) {
      throw new Error("seed 42 sector has no factioned port");
    }
    const faction = sector.factionAt(port.faction);
    run.world.emit("arrival", [], {
      port: port.name,
      portIndex: port.index,
      days: 9,
      distance: 12,
    });
    stepFactionStanding(run.world, run.standing, sector);
    const expected =
      CONFIG.factions.arrivalGain *
      (faction.temperament === "insular" ? 0.6 : 1);
    expect(run.standing.byId[faction.id]).toBeCloseTo(expected, 6);
  });

  it("bands follow the configured lines", () => {
    const f = CONFIG.factions;
    expect(bandOf(f.coldLine - 0.01)).toBe("cold");
    expect(bandOf(0)).toBe("unregarded");
    expect(bandOf(f.warmLine)).toBe("warm");
    expect(bandOf(f.honouredLine)).toBe("honoured");
    expect(bandOf(1)).toBe("honoured");
  });

  it("a short hop before any port call leaves every ledger at zero", () => {
    const { world } = runSimulation({ seed: 42 }, 12);
    void world;
    const run = createRun({ seed: 42 });
    run.run(12);
    for (const v of Object.values(run.standing.byId)) {
      expect(v).toBe(0);
    }
  });
});
