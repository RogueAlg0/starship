import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo/world.ts";
import {
  ReplayDivergenceError,
  ReplaySource,
  type DecisionRecord,
} from "../src/kernel/decisions.ts";

describe("replay", () => {
  it("replaying a recorded decision log reproduces the hash exactly", () => {
    const live = runDemo({ seed: 42 }, 120);
    const source = new ReplaySource(live.decisions);
    const replayed = runDemo({ seed: 42 }, 120, source);
    expect(replayed.world.events.hash()).toBe(live.world.events.hash());
    expect(replayed.world.events.size).toBe(live.world.events.size);
    expect(source.consumed).toBe(live.decisions.length);
    source.assertFullyConsumed();
  });

  it("a tampered decision log raises ReplayDivergenceError", () => {
    const live = runDemo({ seed: 42 }, 120);
    const tampered: DecisionRecord[] = live.decisions.map((record) => ({
      ...record,
    }));
    const index = tampered.findIndex((record) => record.candidateCount >= 2);
    expect(index).toBeGreaterThanOrEqual(0);
    const record = tampered[index] as DecisionRecord;
    record.chosen = (record.chosen + 1) % record.candidateCount;

    expect(() => runDemo({ seed: 42 }, 120, new ReplaySource(tampered))).toThrow(
      ReplayDivergenceError,
    );
  });

  it("a truncated decision log raises ReplayDivergenceError", () => {
    const live = runDemo({ seed: 42 }, 120);
    const truncated = live.decisions.slice(0, 3);
    expect(() => runDemo({ seed: 42 }, 120, new ReplaySource(truncated))).toThrow(
      ReplayDivergenceError,
    );
  });
});
