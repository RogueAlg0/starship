import { describe, expect, it } from "vitest";
import {
  ReplaySource,
  UtilitySource,
} from "../src/decision/decisions.ts";
import { World } from "../src/engine/engine.ts";
import { generateCrew, type CrewMember } from "../src/entities/crew.ts";
import {
  createChronicleRenderer,
  renderChronicle,
} from "../src/log/chronicle.ts";
import { spreadGossip } from "../src/perception/beliefs.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, runSimulation, type RunContext } from "../src/sim.ts";
import { bookHarm } from "../src/world/health.ts";
import { generateShip } from "../src/world/ship.ts";

const TPD = CONFIG.time.ticksPerDay;

function eventsOf(run: RunContext, type: string) {
  return run.world.events.events.filter((e) => e.type === type);
}

/** A bare world with a generated crew and all suspicions zeroed. */
function constructedCrew(): { world: World; crew: CrewMember[] } {
  const world = new World({ seed: 5 }, new UtilitySource());
  const ship = generateShip(world.rng.get("shipgen"));
  const crew = generateCrew(world.rng.get("crewgen"), ship);
  for (const member of crew) {
    for (const other of crew) {
      member.beliefs.suspicion[other.id] = 0;
    }
  }
  return { world, crew };
}

/**
 * Drive gossip between one pair across ticks until a spoken line
 * lands (or the tick budget runs out). The listener's suspicion
 * is reset each attempt so the transfer keeps flowing; the gates
 * are pure functions of the tick, so some tick in the span opens.
 */
function speakViaGossip(
  world: World,
  speaker: CrewMember,
  listener: CrewMember,
  aboutId: string,
  attempts = 400,
) {
  for (let i = 0; i < attempts; i++) {
    world.tick += 1;
    speaker.lastChatterTick = -1000000;
    listener.beliefs.suspicion[aboutId] = 0.2;
    spreadGossip(world, speaker, listener);
    const spoken = world.events.events.filter((e) => e.type === "chatter");
    if (spoken.length > 0) return spoken[0];
  }
  return undefined;
}

describe("gossip made audible", () => {
  it("a false suspicion, spoken, is graded [not true] for the watcher", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, target] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    speaker.beliefs.suspicion[target.id] = 0.6;
    listener.beliefs.trust[speaker.id] = 0.5;
    const spoken = speakViaGossip(world, speaker, listener, target.id);
    expect(spoken).toBeDefined();
    // No crime stands in this log at all: the suspicion is spoken
    // from belief alone, and it is false.
    expect(spoken?.data.about).toBe(target.id);
    expect(spoken?.data.topic).toBe("suspicionNoAct");
    expect(spoken?.data.tag).toBe("not true");
    const chronicle = renderChronicle(world.events.events);
    expect(chronicle).toContain("tells");
    expect(chronicle).toContain("[not true]");
  });

  it("a culprit pointing at an innocent is graded [lie]", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, target] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    // The speaker's own hand is in the log.
    world.emit("sabotage_committed", [speaker.id], {
      culprit: speaker.id,
      system: "life support#1",
      room: 0,
      damage: 0.3,
      condition: 0.6,
    });
    speaker.beliefs.suspicion[target.id] = 0.6;
    listener.beliefs.trust[speaker.id] = 0.5;
    const spoken = speakViaGossip(world, speaker, listener, target.id);
    expect(spoken).toBeDefined();
    expect(spoken?.data.topic).toBe("suspicion");
    expect(spoken?.data.system).toBe("life support#1");
    expect(spoken?.data.tag).toBe("lie");
    expect(renderChronicle(world.events.events)).toContain("[lie]");
  });

  it("a true suspicion, spoken, carries no grade", () => {
    const { world, crew } = constructedCrew();
    const [speaker, listener, culprit] = crew as [
      CrewMember,
      CrewMember,
      CrewMember,
    ];
    world.emit("sabotage_committed", [culprit.id], {
      culprit: culprit.id,
      system: "life support#1",
      room: 0,
      damage: 0.3,
      condition: 0.6,
    });
    speaker.beliefs.suspicion[culprit.id] = 0.6;
    listener.beliefs.trust[speaker.id] = 0.5;
    const spoken = speakViaGossip(world, speaker, listener, culprit.id);
    expect(spoken).toBeDefined();
    expect(spoken?.data.about).toBe(culprit.id);
    expect(spoken?.data.tag ?? null).toBeNull();
  });
});

describe("testimony and the truth line", () => {
  it("a wrong board: testimony graded, denial printed, truth line says wrong", () => {
    const run = createRun({ seed: 42 });
    const victim = run.crew[6] as (typeof run.crew)[number];
    const innocent = run.crew[9] as (typeof run.crew)[number];
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
    const testimony = eventsOf(run, "council_testimony");
    // The witnesses name the innocent with a false claim, and the
    // log grades it for the watcher.
    expect(
      testimony.some(
        (e) => e.data.about === innocent.id && e.data.tag === "not true",
      ),
    ).toBe(true);
    // The accused answers the board.
    expect(
      testimony.some(
        (e) => e.data.kind === "denial" && e.data.witness === innocent.id,
      ),
    ).toBe(true);
    const chronicle = renderChronicle(run.world.events.events);
    expect(chronicle).toContain("testifies:");
    expect(chronicle).toContain("The truth:");
    expect(chronicle).toContain("died of suffocation, and no hand did it");
    expect(chronicle).toContain(
      finding?.data.convicted === true
        ? "The council was wrong."
        : "The council was right.",
    );
  }, 60_000);

  it("a right board: the culprit's denial is graded [lie] and the truth line says right", () => {
    const run = createRun({ seed: 42 });
    const victim = run.crew[6] as (typeof run.crew)[number];
    const attacker = run.crew[9] as (typeof run.crew)[number];
    for (const member of run.crew) {
      member.beliefs.suspicion[attacker.id] = 0.95;
    }
    bookHarm(victim, 0, "violence", 5, null, attacker.id);
    let finding: (typeof run.world.events.events)[number] | undefined;
    for (let day = 0; day < 20 && finding === undefined; day++) {
      run.run(TPD);
      finding = eventsOf(run, "council_finding").find(
        (e) => e.data.kind === "inquiry" && e.data.victim === victim.id,
      );
    }
    expect(finding).toBeDefined();
    expect(finding?.data.accused).toBe(attacker.id);
    expect(finding?.data.convicted).toBe(true);
    const testimony = eventsOf(run, "council_testimony");
    const denial = testimony.find((e) => e.data.kind === "denial");
    expect(denial?.data.witness).toBe(attacker.id);
    expect(denial?.data.tag).toBe("lie");
    // Honest testimony about the true culprit carries no grade.
    expect(
      testimony.some(
        (e) =>
          e.data.about === attacker.id &&
          e.data.kind === "suspicion" &&
          (e.data.tag ?? null) === null,
      ),
    ).toBe(true);
    const chronicle = renderChronicle(run.world.events.events);
    expect(chronicle).toContain("The council was right.");
    expect(chronicle).toContain(`the hand was`);
  }, 60_000);

  it("a witness who was there and kept quiet is noted [kept quiet]", () => {
    const run = createRun({ seed: 42 });
    const victim = run.crew[6] as (typeof run.crew)[number];
    const witness = run.crew[8] as (typeof run.crew)[number];
    const attacker = run.crew[10] as (typeof run.crew)[number];
    const scapegoat = run.crew[9] as (typeof run.crew)[number];
    // Victim and witness share the quarters for the whole span:
    // the witness is present when the harm lands.
    victim.confinedUntil = 1000000000;
    witness.confinedUntil = 1000000000;
    for (const member of run.crew) {
      member.beliefs.suspicion[scapegoat.id] = 0.95;
    }
    // The witness knows better, and says nothing of it.
    witness.beliefs.suspicion[attacker.id] = 0.9;
    bookHarm(victim, 0, "violence", 5, null, attacker.id);
    let finding: (typeof run.world.events.events)[number] | undefined;
    for (let day = 0; day < 20 && finding === undefined; day++) {
      run.run(TPD);
      finding = eventsOf(run, "council_finding").find(
        (e) => e.data.kind === "inquiry" && e.data.victim === victim.id,
      );
    }
    expect(finding).toBeDefined();
    const withheld = eventsOf(run, "council_testimony").filter(
      (e) => e.data.kind === "withheld",
    );
    expect(
      withheld.some(
        (e) => e.data.witness === witness.id && e.data.about === attacker.id,
      ),
    ).toBe(true);
    expect(renderChronicle(run.world.events.events)).toContain("[kept quiet]");
  }, 60_000);
});

describe("speech never feeds back", () => {
  it("chatter on or off, the run is the same run", () => {
    const strip = (run: RunContext) =>
      run.world.events.events
        .filter((e) => e.type !== "chatter")
        .map((e) => ({
          tick: e.tick,
          type: e.type,
          actors: e.actors,
          data: e.data,
        }));
    const beliefsOf = (run: RunContext) =>
      run.crew.map((m) => ({
        needs: m.needs,
        suspicion: m.beliefs.suspicion,
        trust: m.beliefs.trust,
      }));

    CONFIG.chatter.enabled = true;
    const withSpeech = createRun({ seed: 7 });
    withSpeech.run(30 * TPD);
    expect(eventsOf(withSpeech, "chatter").length).toBeGreaterThan(0);

    CONFIG.chatter.enabled = false;
    try {
      const silent = createRun({ seed: 7 });
      silent.run(30 * TPD);
      expect(eventsOf(silent, "chatter").length).toBe(0);
      expect(strip(silent)).toEqual(strip(withSpeech));
      expect(silent.decisions).toEqual(withSpeech.decisions);
      expect(beliefsOf(silent)).toEqual(beliefsOf(withSpeech));
    } finally {
      CONFIG.chatter.enabled = true;
    }
  }, 60_000);

  it("a run full of chatter replays hash-exact", () => {
    const live = runSimulation({ seed: 42 }, 4_320);
    expect(
      live.world.events.events.some((e) => e.type === "chatter"),
    ).toBe(true);
    const source = new ReplaySource(live.decisions);
    const replayed = runSimulation({ seed: 42 }, 4_320, source);
    expect(replayed.world.events.hash()).toBe(live.world.events.hash());
    expect(replayed.world.events.size).toBe(live.world.events.size);
    source.assertFullyConsumed();
  }, 60_000);
});

describe("dosage", () => {
  it("accusations carry their reasoning, in the payload and the line", () => {
    const run = createRun({ seed: 42 });
    run.run(30 * TPD);
    const accusations = eventsOf(run, "accusation");
    expect(accusations.length).toBeGreaterThan(0);
    for (const event of accusations) {
      for (const key of ["means", "motive", "opportunity"] as const) {
        const value = event.data[key];
        expect(typeof value).toBe("number");
        expect(value as number).toBeGreaterThanOrEqual(0);
        expect(value as number).toBeLessThanOrEqual(1);
      }
    }
    expect(renderChronicle(run.world.events.events)).toContain(
      "their reasoning:",
    );
  }, 60_000);

  it("highlights stay capped and the full chronicle stays occasional over 90 days", () => {
    const run = createRun({ seed: 42 });
    run.run(90 * TPD);
    const renderer = createChronicleRenderer();
    const highlightsPerDay = new Map<number, number>();
    let fullChatter = 0;
    for (const event of run.world.events.events) {
      for (const entry of renderer.push(event)) {
        if (!entry.text.includes(" tells ")) continue;
        fullChatter += 1;
        if (entry.highlight) {
          const day = Number(/Day (\d+),/.exec(entry.text)?.[1] ?? 0);
          highlightsPerDay.set(day, (highlightsPerDay.get(day) ?? 0) + 1);
        }
      }
    }
    for (const count of highlightsPerDay.values()) {
      expect(count).toBeLessThanOrEqual(CONFIG.chatter.highlightsPerDay);
    }
    // Occasional, not a transcript: some talk most weeks, never a
    // flood. Seed 42 tunes to roughly 3-6 full lines a day.
    expect(fullChatter / 90).toBeGreaterThan(0.5);
    expect(fullChatter / 90).toBeLessThan(15);
  }, 120_000);
});
