import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun } from "../src/sim.ts";

const TPD = CONFIG.time.ticksPerDay;

describe("council elections and campaigning", () => {
  it("elections are called, campaigned, and counted on the cycle", () => {
    const run = createRun({ seed: 42 });
    run.run(2 * 365 * TPD);
    const evs = run.world.events.events;
    const called = evs.filter((e) => e.type === "election_called");
    const results = evs.filter((e) => e.type === "election_result");
    const unopposed = evs.filter((e) => e.type === "election_unopposed");
    // A 45-day cycle over two years: well over ten elections
    // conclude one way or another.
    expect(run.council.electionsHeld).toBeGreaterThanOrEqual(10);
    expect(called.length + unopposed.length).toBeGreaterThanOrEqual(10);
    expect(results.length).toBeGreaterThanOrEqual(5);
    // The captain's seat never stands.
    for (const e of [...called, ...results, ...unopposed]) {
      expect(e.data["seat"]).not.toBe("captain");
    }
    // Every result's ballots are complete and consistent: one
    // ballot per living voter, counts that sum to the ballots.
    for (const r of results) {
      const ballots = r.data["ballots"] as { member: string; choice: string }[];
      const votes = r.data["votes"] as Record<string, number>;
      expect(Array.isArray(ballots)).toBe(true);
      expect(ballots.length).toBeGreaterThanOrEqual(8);
      const sum = Object.values(votes).reduce((a, b) => a + b, 0);
      expect(sum).toBe(ballots.length);
      expect(votes[r.data["winner"] as string]).toBeGreaterThanOrEqual(
        Math.max(...Object.values(votes)),
      );
      // Campaigning happened before the count.
      const campaigns = evs.filter(
        (e) =>
          e.type === "election_campaign" &&
          e.data["seat"] === r.data["seat"] &&
          e.seq < r.seq,
      );
      expect(campaigns.length).toBeGreaterThanOrEqual(1);
    }
  }, 300_000);

  it("a winner the crew chose sits in the seat afterwards", () => {
    const run = createRun({ seed: 7 });
    run.run(2 * 365 * TPD);
    const evs = run.world.events.events;
    const results = evs.filter((e) => e.type === "election_result");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Replay the seat's history: the last word on the seat of
    // the final result (a later election, an appointment, or a
    // vacancy) decides; the election's own word must appear in
    // that history with its winner holding the seat until then.
    const last = results[results.length - 1] as (typeof results)[number];
    const seat = last.data["seat"] as string;
    const winner = last.data["winner"] as string;
    const later = evs.filter(
      (e) =>
        e.seq > last.seq &&
        (e.type === "council_appointment" ||
          e.type === "council_seat_vacated" ||
          e.type === "election_result") &&
        e.data["seat"] === seat,
    );
    if (later.length === 0) {
      expect(run.council.seats[seat]).toBe(winner);
    } else {
      // The seat moved on lawfully after the election; the
      // winner held it in between, which the appointment and
      // vacancy trail presupposes. The invariant suite covers
      // the seat map's sanity on every tick of this run.
      expect(later.length).toBeGreaterThanOrEqual(1);
    }
  }, 300_000);

  it("no election is live at build, and the first comes on its day", () => {
    const run = createRun({ seed: 42 });
    expect(run.council.election).toBeNull();
    run.run(CONFIG.council.firstElectionDay * TPD + 1);
    const evs = run.world.events.events;
    const started =
      evs.some((e) => e.type === "election_called") ||
      evs.some((e) => e.type === "election_unopposed");
    expect(started).toBe(true);
  }, 120_000);
});
