import { describe, expect, it } from "vitest";
import {
  ReplayDivergenceError,
  ReplaySource,
  type DecisionRecord,
} from "../src/decision/decisions.ts";
import { runSimulation } from "../src/sim.ts";

describe("replay", () => {
  it("replaying a recorded decision log reproduces the hash exactly", () => {
    const live = runSimulation({ seed: 42 }, 120);
    const source = new ReplaySource(live.decisions);
    const replayed = runSimulation({ seed: 42 }, 120, source);
    expect(replayed.world.events.hash()).toBe(live.world.events.hash());
    expect(replayed.world.events.size).toBe(live.world.events.size);
    expect(source.consumed).toBe(live.decisions.length);
    source.assertFullyConsumed();
  });

  it("a tampered decision log raises ReplayDivergenceError", () => {
    const live = runSimulation({ seed: 42 }, 120);
    const tampered: DecisionRecord[] = live.decisions.map((record) => ({
      ...record,
    }));
    const index = tampered.findIndex((record) => record.candidateCount >= 2);
    expect(index).toBeGreaterThanOrEqual(0);
    const record = tampered[index] as DecisionRecord;
    record.chosen = (record.chosen + 1) % record.candidateCount;

    expect(() => runSimulation({ seed: 42 }, 120, new ReplaySource(tampered))).toThrow(
      ReplayDivergenceError,
    );
  });

  it("a truncated decision log raises ReplayDivergenceError", () => {
    const live = runSimulation({ seed: 42 }, 120);
    const truncated = live.decisions.slice(0, 3);
    expect(() => runSimulation({ seed: 42 }, 120, new ReplaySource(truncated))).toThrow(
      ReplayDivergenceError,
    );
  });
});
