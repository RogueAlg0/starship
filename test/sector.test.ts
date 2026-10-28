// The sector game: influence tables, campaigns, contests and
// conditions, played by the factions at the ports whether or
// not the witnessed ship is watching. Behaviour bounds come
// from a measured 2-year seed-42 harness run (32 contests,
// 8 flips, plural shares at contested ports); the tests hold
// the laws, not the exact counts.

import { describe, expect, it } from "vitest";
import { createRun } from "../src/sim.ts";
import { checkSectorState, createSectorState } from "../src/world/sector.ts";
import { generateSector } from "../src/world/galaxy.ts";
import { World } from "../src/engine/engine.ts";
import { UtilitySource } from "../src/decision/decisions.ts";

const YEAR = 365 * 144;

describe("the sector game", () => {
  it("opens with influence tables that sum to 100 and sane control", () => {
    const world = new World({ seed: 42 }, new UtilitySource());
    const sector = generateSector(world.rng.get("galaxy"));
    const state = createSectorState(sector);
    expect(checkSectorState(sector, state)).toEqual([]);
    for (const port of sector.ports) {
      const row = state.shares[port.index] as number[];
      const total = row.reduce((a, b) => a + b, 0);
      expect(Math.abs(total - 100)).toBeLessThan(0.01);
      const top = Math.max(...row);
      if (port.faction !== null) {
        expect(row[port.faction]).toBe(top);
      } else {
        expect(top).toBeLessThanOrEqual(45.5);
      }
    }
    // Rivals and voices cover every faction, and no faction is
    // its own rival.
    for (const f of sector.factions) {
      expect(state.rivals[f.index]).not.toBe(f.index);
      expect(state.voices[f.index]).toContain(" ");
    }
  });

  it("replays its own history exactly", () => {
    const runA = createRun({ seed: 42 });
    const runB = createRun({ seed: 42 });
    runA.run(120 * 144);
    runB.run(120 * 144);
    const sectorEvents = (run: typeof runA): string[] =>
      run.world.events.events
        .filter((e) => e.type.startsWith("sector_"))
        .map((e) => `${e.type}:${JSON.stringify(e.data)}`);
    expect(sectorEvents(runA)).toEqual(sectorEvents(runB));
  }, 120_000);

  it("plays a living sector year: campaigns force contests, contests resolve, ports change hands at a stately pace", () => {
    const run = createRun({ seed: 42 });
    run.run(YEAR);
    const ev = run.world.events;
    const started = ev.countOf("sector_contest_started");
    const resolved = ev.countOf("sector_contest_resolved");
    const flips = ev.events.filter(
      (e) => e.type === "sector_contest_resolved" && e.data["flipped"] === true,
    ).length;
    const campaigns = ev.countOf("sector_campaign");
    const conditions = ev.events.filter(
      (e) => e.type === "sector_condition" && e.data["phase"] === "active",
    ).length;
    expect(campaigns).toBeGreaterThan(3);
    expect(started).toBeGreaterThanOrEqual(4);
    expect(resolved).toBeGreaterThanOrEqual(3);
    // At most one contest can still be live at year's end per port.
    expect(started - resolved).toBeLessThanOrEqual(
      run.galaxy.sector.ports.length,
    );
    expect(flips).toBeGreaterThanOrEqual(1);
    expect(flips).toBeLessThanOrEqual(12);
    expect(conditions).toBeGreaterThanOrEqual(5);
    expect(checkSectorState(run.galaxy.sector, run.sectorState)).toEqual([]);
  }, 180_000);

  it("keeps every seed's sector lawful for a year", () => {
    for (const seed of [3, 7, 11]) {
      const run = createRun({ seed });
      run.run(YEAR);
      expect(checkSectorState(run.galaxy.sector, run.sectorState)).toEqual(
        [],
      );
    }
  }, 300_000);
});
