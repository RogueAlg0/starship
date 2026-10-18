import { describe, expect, it } from "vitest";
import { runSimulation } from "../src/sim.ts";

/**
 * Playtest Note #1: weather used to flip every few ticks (hourly rolls
 * did not exist; the chain rolled per tick with weak self-holds). These
 * tests pin the fixed pacing: weather is a condition of the voyage,
 * episodes last hours, and a weather turn is news again.
 */

const TICKS_PER_HOUR = 6;

interface DwellStats {
  transitions: number;
  /** Completed and trailing dwells per state, in ship hours. */
  dwells: Map<string, number[]>;
}

function dwellStats(seed: number, ticks: number): DwellStats {
  const { world } = runSimulation({ seed }, ticks);
  const changes = world.events.events.filter((e) => e.type === "weather");
  const dwells = new Map<string, number[]>();
  const push = (state: string, hours: number): void => {
    const list = dwells.get(state) ?? [];
    list.push(hours);
    dwells.set(state, list);
  };
  let state = "calm"; // Weather.index starts at 0: calm.
  let start = 0;
  for (const e of changes) {
    push(state, (e.tick - start) / TICKS_PER_HOUR);
    state = e.data.to as string;
    start = e.tick;
  }
  push(state, (ticks - start) / TICKS_PER_HOUR);
  return { transitions: changes.length, dwells };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

describe("space weather pacing (Playtest Note #1)", () => {
  it("weather turns are rare over a 60-day run, not a per-tick coin toss", () => {
    const stats = dwellStats(42, 8640);
    // The old chain produced on the order of 1,500 turns in 60 days.
    expect(stats.transitions).toBeGreaterThan(10);
    expect(stats.transitions).toBeLessThan(300);
  });

  it("no state ever flips faster than one ship hour", () => {
    const stats = dwellStats(42, 8640);
    for (const list of stats.dwells.values()) {
      for (const hours of list) {
        expect(hours).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("median dwells sit in the designed bands", () => {
    const stats = dwellStats(42, 8640);
    // Designed medians: calm ~23h, solar wind ~8h, radiation storm ~4h.
    expect(median(stats.dwells.get("calm") ?? [])).toBeGreaterThanOrEqual(6);
    expect(median(stats.dwells.get("calm") ?? [])).toBeLessThanOrEqual(72);
    expect(median(stats.dwells.get("solar wind") ?? [])).toBeGreaterThanOrEqual(2);
    expect(median(stats.dwells.get("solar wind") ?? [])).toBeLessThanOrEqual(36);
    expect(median(stats.dwells.get("radiation storm") ?? [])).toBeGreaterThanOrEqual(1);
    expect(median(stats.dwells.get("radiation storm") ?? [])).toBeLessThanOrEqual(30);
  });
});
