import { describe, expect, it } from "vitest";
import { renderChronicle } from "../src/log/chronicle.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, type RunContext } from "../src/sim.ts";
import { computeVote } from "../src/world/council.ts";
import { bookHarm } from "../src/world/health.ts";
import { dailyUseMilli } from "../src/world/stores.ts";

const TPD = CONFIG.time.ticksPerDay;

function eventsOf(run: RunContext, type: string) {
  return run.world.events.events.filter((e) => e.type === type);
}

function officerIds(run: RunContext): string[] {
  return Object.values(run.council.seats).filter(
    (id): id is string => id !== null && id !== undefined,
  );
}

describe("the vote", () => {
  it("is computed, not rolled: the same beliefs give the same vote, twice", () => {
    const run = createRun({ seed: 42 });
    run.run(2 * TPD);
    const accused = run.crew[7] as (typeof run.crew)[number];
    const officer = run.crew.find(
      (m) => m.id === run.council.seats["security chief"],
    ) as (typeof run.crew)[number];
    officer.beliefs.suspicion[accused.id] = 0.8;
    const motion = { kind: "inquiry", accusedId: accused.id };
    const ctx = {
      crew: run.crew,
      securityId: run.council.seats["security chief"] ?? null,
    };
    const first = computeVote(officer, "security chief", motion, ctx);
    const second = computeVote(officer, "security chief", motion, ctx);
    expect(second).toEqual(first);
    expect(first.choice).toBe("for");
    // Weaker evidence, weaker vote: the terms move the outcome.
    officer.beliefs.suspicion[accused.id] = 0.1;
    const weak = computeVote(officer, "security chief", motion, ctx);
    expect(weak.score).toBeLessThan(first.score);
  });

  it("science abstains on thin evidence", () => {
    const run = createRun({ seed: 42 });
    const accused = run.crew[7] as (typeof run.crew)[number];
    const scientist = run.crew.find(
      (m) => m.id === run.council.seats["science officer"],
    ) as (typeof run.crew)[number];
    for (const member of run.crew) member.beliefs.suspicion[accused.id] = 0;
    scientist.beliefs.suspicion[accused.id] = 0.1;
    const vote = computeVote(
      scientist,
      "science officer",
      { kind: "inquiry", accusedId: accused.id },
      { crew: run.crew, securityId: null },
    );
    expect(vote.choice).toBe("abstain");
  });
});

describe("boards of inquiry", () => {
  it("a death convenes a board, and only a death or a trigger does", () => {
    // Control: three quiet days, no death. Sittings may occur for
    // other causes on other seeds; a death board may not.
    const control = createRun({ seed: 42 });
    control.run(3 * TPD);
    const controlBoards = eventsOf(control, "council_convened").filter(
      (e) => e.data.kind === "inquiry" && e.data.cause === "death",
    );
    expect(controlBoards).toEqual([]);
    expect(eventsOf(control, "death")).toEqual([]);

    const run = createRun({ seed: 42 });
    const victim = run.crew[6] as (typeof run.crew)[number];
    bookHarm(victim, 0, "suffocation", 5);
    let board: (typeof run.world.events.events)[number] | undefined;
    for (let day = 0; day < 15 && board === undefined; day++) {
      run.run(TPD);
      board = eventsOf(run, "council_convened").find(
        (e) => e.data.kind === "inquiry" && e.data.cause === "death",
      );
    }
    expect(eventsOf(run, "death").length).toBe(1);
    expect(board).toBeDefined();
    expect(board?.data.victim).toBe(victim.id);
  }, 60_000);

  it("the board can name the wrong person, and the chronicle keeps truth apart", () => {
    const run = createRun({ seed: 42 });
    const victim = run.crew[6] as (typeof run.crew)[number];
    const innocent = run.crew[9] as (typeof run.crew)[number];
    // The ship believes, unanimously and wrongly, before the body
    // is cold: every officer's suspicion of the innocent is high.
    for (const member of run.crew) {
      member.beliefs.suspicion[innocent.id] = 0.95;
    }
    bookHarm(victim, 0, "suffocation", 5);
    let finding: (typeof run.world.events.events)[number] | undefined;
    for (let day = 0; day < 20 && finding === undefined; day++) {
      run.run(TPD);
      finding = eventsOf(run, "council_finding").find(
        (e) => e.data.kind === "inquiry" && e.data.victim === victim.id,
      );
    }
    expect(finding).toBeDefined();
    // The verdict is the belief; the record keeps the truth apart:
    // nobody's hand did this, and the finding says so in its own
    // fields even as it names the innocent.
    expect(finding?.data.accused).toBe(innocent.id);
    expect(finding?.data.truthCulprit ?? null).toBeNull();
    expect(finding?.data.truthCause).toBe("suffocation");
    const chronicle = renderChronicle(run.world.events.events);
    expect(chronicle).toContain("The log records the truth apart from the verdict");
    expect(chronicle).toContain("has died");
  }, 60_000);
});

describe("rationing belongs to the council", () => {
  it("a short store is disposed by vote or ratified emergency, never by the quartermaster alone", () => {
    const run = createRun({ seed: 42 });
    for (const system of run.ship.systems) {
      if (system.kind === "hydroponics rig") system.condition = 0;
    }
    run.stores.byKey.food.qtyMilli = Math.round(
      5 * dailyUseMilli(run.stores, "food"),
    );
    let imposed: typeof run.world.events.events = [];
    for (let day = 0; day < 25 && imposed.length === 0; day++) {
      run.run(TPD);
      for (const system of run.ship.systems) {
        if (system.kind === "hydroponics rig") system.condition = 0;
      }
      imposed = eventsOf(run, "rationing_imposed");
    }
    expect(imposed.length).toBeGreaterThanOrEqual(1);
    // Every imposition carries its authority: the council's vote
    // or the captain's emergency act awaiting ratification. The
    // old interim shape (a quartermaster's unilateral `by`, no
    // `via`) must never appear.
    for (const event of imposed) {
      expect(["council", "captain_emergency"]).toContain(event.data.via);
    }
    expect(run.stores.rationing.food).toBe(true);
    // The disposal itself: a rationing sitting, or the
    // ratification sitting the captain's emergency act is owed
    // within a day. Either way the council convenes on it.
    let disposed = false;
    for (let day = 0; day < 6 && !disposed; day++) {
      run.run(TPD);
      disposed = eventsOf(run, "council_convened").some(
        (e) => e.data.kind === "rationing" || e.data.kind === "ratification",
      );
    }
    expect(disposed).toBe(true);
  }, 60_000);
});

describe("recusal", () => {
  it("an officer closely bonded to the accused does not sit", () => {
    const run = createRun({ seed: 42 });
    const secId = run.council.seats["security chief"] as string;
    const qmId = run.council.seats["quartermaster"] as string;
    const accused = run.crew.find((m) => m.roleKey === "cook") as (
      typeof run.crew
    )[number];
    const qm = run.crew.find((m) => m.id === qmId) as (typeof run.crew)[number];
    // The quartermaster's closest bond aboard, by a distance.
    for (const member of run.crew) qm.beliefs.bond[member.id] = 0.05;
    qm.beliefs.bond[accused.id] = 1;
    // The security chief certifies a case short of an inquiry: a
    // discipline hearing, from their own accusation event.
    run.world.emit("accusation", [secId], {
      accused: accused.id,
      suspicion: 0.8,
    });
    let convened: (typeof run.world.events.events)[number] | undefined;
    for (let day = 0; day < 15 && convened === undefined; day++) {
      run.run(TPD);
      convened = eventsOf(run, "council_convened").find(
        (e) => e.data.kind === "discipline",
      );
    }
    expect(convened).toBeDefined();
    const recused = (convened?.data.recused ?? []) as Array<{
      member: string;
      reason: string;
    }>;
    expect(recused.some((r) => r.member === qmId)).toBe(true);
    const sitting = (convened?.data.seats ?? []) as Array<{ member: string }>;
    expect(sitting.some((s) => s.member === qmId)).toBe(false);
    // The accuser does not sit either.
    expect(recused.some((r) => r.member === secId)).toBe(true);
  }, 60_000);
});

describe("relief of the captain", () => {
  it("three officers with settled grudges can table the motion, and the vote decides", () => {
    const run = createRun({ seed: 42 });
    const captainId = run.council.seats.captain as string;
    const foId = run.council.seats["first officer"] as string;
    for (const id of officerIds(run)) {
      if (id === captainId) continue;
      const officer = run.crew.find((m) => m.id === id) as (
        typeof run.crew
      )[number];
      officer.beliefs.trust[captainId] = -1;
      if (!officer.beliefs.grudges.includes(captainId)) {
        officer.beliefs.grudges.push(captainId);
      }
    }
    let motion: (typeof run.world.events.events)[number] | undefined;
    for (let day = 0; day < 25 && motion === undefined; day++) {
      run.run(TPD);
      motion = eventsOf(run, "relief_motion")[0];
    }
    expect(motion).toBeDefined();
    const relieved = eventsOf(run, "captain_relieved");
    const failed = eventsOf(run, "relief_failed");
    expect(relieved.length + failed.length).toBe(1);
    if (relieved.length === 1) {
      // The First Officer takes command, and the relieved captain
      // is confined: the seat and the body both move.
      expect(run.council.seats.captain).toBe(foId);
      const relievedCaptain = run.crew.find((m) => m.id === captainId) as (
        typeof run.crew
      )[number];
      expect(relievedCaptain.confinedUntil).toBeGreaterThan(run.tick);
    }
  }, 60_000);
});

describe("the frequency law", () => {
  it("the daily seeds plus 99 sit in the band over 90 days: 0 to 2 deaths each", () => {
    const seeds = [11, 16, 17, 30, 39, 40, 42, 99];
    for (const seed of seeds) {
      const run = createRun({ seed });
      run.run(90 * TPD);
      const deathEvents = eventsOf(run, "death");
      // The band counts ordinary mortality. A ship_lost cascade
      // is the ending firing, not a mortality leak: the whole
      // watch suffocates on one tick when life support dies
      // with the locker empty. Seed 11's council routes into
      // one over 90 days (see DECISIONS, the course decisions
      // entry, for the A/B against the old itinerary). Deaths
      // spread over days still fail here, in full.
      const cascade =
        deathEvents.length > 0 &&
        deathEvents.every((d) => d.tick === deathEvents[0]?.tick) &&
        eventsOf(run, "ship_lost").some(
          (e) => e.tick === deathEvents[0]?.tick,
        );
      expect(
        deathEvents.length <= 2 || cascade,
        `seed ${seed} deaths`,
      ).toBe(true);
      // The council sat: the arc is present in every voyage.
      expect(
        run.world.events.countOf("council_convened"),
        `seed ${seed} sittings`,
      ).toBeGreaterThan(0);
      // Determinism holds at this scale: a second run of the
      // flagship seed lands on the same hash.
      if (seed === 42) {
        const again = createRun({ seed });
        again.run(90 * TPD);
        expect(again.hash()).toBe(run.hash());
      }
    }
  }, 300_000);
});
