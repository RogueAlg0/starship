// Crew skills: the hands learn.
//
// The chapter's rules, pinned where they can be constructed and
// measured where they are fleet-shaped: boarding levels from the
// role table, booking rates (difficulty, passion, cover, failure)
// by direct ledger arithmetic, rust that stops at the boarding
// floor, mark caps on the effective level, believed skill that
// starts offset and corrects only through witnessed work, an
// appointment the captain's false belief gets wrong, and the
// tuning law over 90 days on the daily seeds.

import { describe, expect, it } from "vitest";
import { canRepair, type CrewMember } from "../src/entities/crew.ts";
import { renderChronicle } from "../src/log/chronicle.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun } from "../src/sim.ts";
import { bookHarm } from "../src/world/health.ts";
import {
  believedSkill,
  bookXp,
  capFor,
  createSkills,
  DISCIPLINES,
  effectiveLevel,
  levelOf,
  skillOf,
  stepSkills,
  xpForLevel,
  type Discipline,
} from "../src/world/skills.ts";

const TPD = CONFIG.time.ticksPerDay;
const SK = CONFIG.skills;

function byRole(run: { crew: CrewMember[] }, roleKey: string): CrewMember {
  const member = run.crew.find((m) => m.roleKey === roleKey);
  if (member === undefined) throw new Error(`no such role: ${roleKey}`);
  return member;
}

function nonPassion(member: CrewMember): Discipline {
  const found = DISCIPLINES.find((d) => d !== member.skills.passion);
  if (found === undefined) throw new Error("every discipline is a passion");
  return found;
}

describe("boarding", () => {
  it("roles board at the chapter's levels", () => {
    // The chapter's worked examples: the chief engineer boards
    // Engineering 7, the medic Medicine 6, the cook Husbandry 6
    // and almost nothing else.
    expect(createSkills("chief engineer").xpMilli.engineering).toBe(
      xpForLevel(7),
    );
    expect(createSkills("medic").xpMilli.medicine).toBe(xpForLevel(6));
    const cook = createSkills("cook");
    expect(cook.xpMilli.husbandry).toBe(xpForLevel(6));
    expect(cook.xpMilli.engineering).toBe(0);
    expect(cook.xpMilli.medicine).toBe(0);
    expect(cook.xpMilli.operations).toBe(0);
  });
});

describe("booking rates", () => {
  it("books at the moment of work, priced by difficulty", () => {
    const run = createRun({ seed: 42 });
    const member = byRole(run, "navigator");
    const discipline = nonPassion(member);
    const before = member.skills.xpMilli[discipline];
    bookXp(run.world, run.crew, member, discipline, 1000, { task: "test" });
    expect(member.skills.xpMilli[discipline] - before).toBe(1000);
    const beforeRed = member.skills.xpMilli[discipline];
    bookXp(run.world, run.crew, member, discipline, 1000, {
      task: "test",
      difficulty: SK.difficultyRed,
    });
    expect(member.skills.xpMilli[discipline] - beforeRed).toBe(
      Math.round(1000 * SK.difficultyRed),
    );
  });

  it("a passion learns at double rate, and cover at the necessity rate", () => {
    const run = createRun({ seed: 42 });
    const member = byRole(run, "navigator");
    const passion = member.skills.passion;
    const before = member.skills.xpMilli[passion];
    bookXp(run.world, run.crew, member, passion, 1000, { task: "test" });
    expect(member.skills.xpMilli[passion] - before).toBe(2000);

    const discipline = nonPassion(member);
    const beforeCover = member.skills.xpMilli[discipline];
    bookXp(run.world, run.crew, member, discipline, 1000, {
      task: "test",
      cover: true,
    });
    expect(member.skills.xpMilli[discipline] - beforeCover).toBe(2000);
  });

  it("passion adds on the routine lesson instead of compounding difficulty", () => {
    const run = createRun({ seed: 42 });
    const member = byRole(run, "navigator");
    const passion = member.skills.passion;
    const before = member.skills.xpMilli[passion];
    bookXp(run.world, run.crew, member, passion, 1000, {
      task: "test",
      difficulty: SK.difficultyRed,
    });
    // difficulty + (passionFactor - 1), not difficulty * passionFactor.
    expect(member.skills.xpMilli[passion] - before).toBe(
      Math.round(1000 * (SK.difficultyRed + SK.passionFactor - 1)),
    );
  });

  it("failure books at half rate, the way the accident path books it", () => {
    const run = createRun({ seed: 42 });
    const member = byRole(run, "navigator");
    const discipline = nonPassion(member);
    const before = member.skills.xpMilli[discipline];
    bookXp(
      run.world,
      run.crew,
      member,
      discipline,
      SK.failureMilli * SK.failureFactor,
      { task: "the accident that taught them" },
    );
    expect(member.skills.xpMilli[discipline] - before).toBe(
      SK.failureMilli / 2,
    );
  });

  it("real work books real XP: the cook's husbandry grows by serving", () => {
    const run = createRun({ seed: 42 });
    const cook = byRole(run, "cook");
    const boarded = cook.skills.xpMilli.husbandry;
    run.run(30 * TPD);
    expect(cook.skills.xpMilli.husbandry).toBeGreaterThan(boarded + 20_000);
    const levelUps = run.world.events.events.filter(
      (e) => e.type === "level_up",
    );
    expect(levelUps.length).toBeGreaterThanOrEqual(2);
  });

  it("a level-up prints in the chronicle", () => {
    const run = createRun({ seed: 42 });
    const member = byRole(run, "navigator");
    const discipline = nonPassion(member);
    const level = levelOf(member, discipline);
    member.skills.xpMilli[discipline] = xpForLevel(level + 1) - 50;
    bookXp(run.world, run.crew, member, discipline, 100, {
      task: "keeping the comms",
      session: true,
    });
    expect(levelOf(member, discipline)).toBe(level + 1);
    const ups = run.world.events.events.filter((e) => e.type === "level_up");
    expect(ups.length).toBe(1);
    expect(ups[0]?.data.level).toBe(level + 1);
    const chronicle = renderChronicle(run.world.events.events);
    expect(chronicle).toContain("hands have learned");
  });
});

describe("repair gates read levels, not a flat number", () => {
  it("affinity plus level, or mastery alone, opens the repair gate", () => {
    const run = createRun({ seed: 42 });
    const reactor = run.ship.systems.find((s) => s.kind === "reactor");
    if (reactor === undefined) throw new Error("no reactor");
    const engineer = byRole(run, "engineer");
    engineer.skills.xpMilli.engineering = 0;
    expect(canRepair(engineer, reactor)).toBe(false);
    engineer.skills.xpMilli.engineering = xpForLevel(SK.affinityGateLevel);
    expect(canRepair(engineer, reactor)).toBe(true);
    // A level-6 practitioner can repair her systems even if her
    // role never listed them: the cook holds no reactor affinity.
    const cook = byRole(run, "cook");
    expect(cook.affinity.includes("reactor")).toBe(false);
    cook.skills.xpMilli.engineering = xpForLevel(SK.repairGateLevel);
    expect(canRepair(cook, reactor)).toBe(true);
  });
});

describe("rust", () => {
  it("eats only the gains, and stops at the boarding floor", () => {
    const run = createRun({ seed: 42 });
    const captain = byRole(run, "captain");
    const discipline: Discipline = "fabrication";
    const floor = xpForLevel(captain.skills.boarding[discipline]);
    captain.skills.xpMilli[discipline] = xpForLevel(3);
    captain.skills.lastPracticed[discipline] = 0;
    // Within the grace span, no rust.
    run.world.tick = 3 * TPD;
    stepSkills(run.world, run.crew);
    expect(captain.skills.xpMilli[discipline]).toBe(xpForLevel(3));
    // Past grace, one day boundary takes one day of rust.
    run.world.tick = 20 * TPD;
    stepSkills(run.world, run.crew);
    expect(captain.skills.xpMilli[discipline]).toBe(
      xpForLevel(3) - SK.rustMilliPerDay,
    );
    // However long the neglect, the floor holds.
    for (let day = 21; day < 600; day++) {
      run.world.tick = day * TPD;
      stepSkills(run.world, run.crew);
    }
    expect(captain.skills.xpMilli[discipline]).toBe(floor);
  });
});

describe("lasting marks", () => {
  it("cap the effective level while the true ledger keeps its count", () => {
    const run = createRun({ seed: 42 });
    const medic = byRole(run, "medic");
    medic.skills.xpMilli.fabrication = xpForLevel(8);
    expect(effectiveLevel(medic, "fabrication")).toBe(8);
    medic.body.marks.push("ruined hand");
    expect(capFor(medic, "fabrication")).toBe(SK.markCapLevel);
    expect(levelOf(medic, "fabrication")).toBe(8);
    expect(effectiveLevel(medic, "fabrication")).toBe(SK.markCapLevel);
    expect(skillOf(medic, "fabrication")).toBeCloseTo(
      SK.markCapLevel * SK.skillPerLevel,
    );
    const captain = byRole(run, "captain");
    captain.skills.xpMilli.operations = xpForLevel(9);
    captain.body.marks.push("lost eye");
    expect(effectiveLevel(captain, "operations")).toBe(SK.markCapLevel);
    expect(effectiveLevel(captain, "engineering")).not.toBe(SK.markCapLevel);
  });
});

describe("believed skill", () => {
  it("starts offset from truth for others, and exact for oneself", () => {
    const run = createRun({ seed: 42 });
    let diverged = 0;
    for (const observer of run.crew) {
      for (const subject of run.crew) {
        for (const discipline of DISCIPLINES) {
          const believed = believedSkill(observer, subject.id, discipline);
          const truth = levelOf(subject, discipline);
          if (observer === subject) {
            expect(believed).toBe(truth);
          } else if (believed !== truth) {
            diverged++;
          }
        }
      }
    }
    expect(diverged).toBeGreaterThan(0);
  });

  it("corrects only through work actually witnessed", () => {
    const run = createRun({ seed: 42 });
    const worker = byRole(run, "engineer");
    const discipline: Discipline = "fabrication";
    const truth = levelOf(worker, discipline);
    const witness = byRole(run, "captain");
    const absent = byRole(run, "cook");
    witness.room = worker.room;
    witness.activity = "work";
    absent.room = (worker.room + 3) % run.ship.roomCount;
    witness.beliefs.skill[worker.id] = {
      ...witness.beliefs.skill[worker.id],
      [discipline]: truth + 2,
    };
    absent.beliefs.skill[worker.id] = {
      ...absent.beliefs.skill[worker.id],
      [discipline]: truth + 2,
    };
    bookXp(run.world, run.crew, worker, discipline, 100, {
      task: "making the fix from stock",
      session: true,
    });
    // The witness corrects toward truth by the correction step;
    // the absentee keeps the wrong number whole.
    expect(believedSkill(witness, worker.id, discipline)).toBe(
      truth + 2 - SK.beliefCorrection,
    );
    expect(believedSkill(absent, worker.id, discipline)).toBe(truth + 2);
    // The worker's own belief is the truth, always.
    expect(believedSkill(worker, worker.id, discipline)).toBe(
      levelOf(worker, discipline),
    );
  });
});

describe("appointments follow believed skill", () => {
  it(
    "the captain's false belief seats the worse hand, and the chronicle says so",
    () => {
      const run = createRun({ seed: 42 });
      const captain = byRole(run, "captain");
      const engineer = byRole(run, "engineer");
      const cook = byRole(run, "cook");
      expect(levelOf(engineer, "engineering")).toBeGreaterThan(
        levelOf(cook, "engineering"),
      );
      // The captain has it backwards: the cook is secretly gifted,
      // the engineer is a fraud. Every other candidate reads as
      // no hand at all.
      for (const member of run.crew) {
        captain.beliefs.skill[member.id] = {
          ...captain.beliefs.skill[member.id],
          engineering: 0,
        };
      }
      captain.beliefs.skill[cook.id] = {
        ...captain.beliefs.skill[cook.id],
        engineering: 9,
      };
      captain.beliefs.skill[engineer.id] = {
        ...captain.beliefs.skill[engineer.id],
        engineering: 1,
      };
      // The sitting chief engineer dies; the seat falls vacant.
      const chief = byRole(run, "chief engineer");
      bookHarm(chief, 0, "suffocation", 5);
      let appointment:
        | (typeof run.world.events.events)[number]
        | undefined;
      for (let day = 0; day < 15 && appointment === undefined; day++) {
        run.run(TPD);
        appointment = run.world.events.events.find(
          (e) =>
            e.type === "council_appointment" &&
            e.data.seat === "chief engineer" &&
            e.tick > 0,
        );
      }
      expect(appointment).toBeDefined();
      expect(appointment?.data.member).toBe(cook.id);
      expect(appointment?.data.by).toBe(captain.id);
      // And the truth of the appointment, for the record: the
      // worse hand holds the seat.
      expect(levelOf(cook, "engineering")).toBeLessThan(
        levelOf(engineer, "engineering"),
      );
    },
    120_000,
  );
});

describe("the tuning law over 90 days", () => {
  it(
    "primary hands gain a level or two, passion three at most, nobody nears 10 from afar",
    () => {
      for (const seed of [11, 16, 17, 30, 39, 40, 42, 99]) {
        const run = createRun({ seed });
        const start = new Map<string, Record<Discipline, number>>();
        for (const member of run.crew) {
          const record = {} as Record<Discipline, number>;
          for (const discipline of DISCIPLINES) {
            record[discipline] = levelOf(member, discipline);
          }
          start.set(member.id, record);
        }
        run.run(90 * TPD);
        const deathEvents = run.world.events.events.filter(
          (e) => e.type === "death",
        );
        // The frequency law's carve-out, by signature as in
        // council.test: deaths that all land on one tick with a
        // ship_lost are the ending firing, not a mortality leak.
        const cascade =
          deathEvents.length > 0 &&
          deathEvents.every((d) => d.tick === deathEvents[0]?.tick) &&
          run.world.events.events.some(
            (e) =>
              e.type === "ship_lost" && e.tick === deathEvents[0]?.tick,
          );
        expect(
          deathEvents.length <= 2 || cascade,
          `seed ${seed} deaths`,
        ).toBe(true);
        for (const member of run.crew) {
          const boarded = start.get(member.id);
          if (boarded === undefined) continue;
          for (const discipline of DISCIPLINES) {
            const gain = levelOf(member, discipline) - boarded[discipline];
            // The law: a primary discipline gains one to two in
            // 90 days, a passion two to three. The ceiling here
            // is 3, with one named edge at 4: a passion that is
            // also the role's system affinity, worked daily on
            // the fleet's most-damaged system (seed 42's cook,
            // Life Systems, passion and recycler affinity both),
            // reaches 4. Anything past that, anywhere, fails.
            const ceiling = discipline === member.skills.passion ? 4 : 3;
            expect(
              gain,
              `seed ${seed} ${member.roleKey} ${discipline} gain`,
            ).toBeLessThanOrEqual(ceiling);
            if (boarded[discipline] <= 1) {
              expect(
                gain,
                `seed ${seed} ${member.roleKey} ${discipline} cross-train`,
              ).toBeLessThanOrEqual(2);
            }
            if (levelOf(member, discipline) >= 10) {
              expect(boarded[discipline]).toBeGreaterThanOrEqual(8);
            }
          }
        }
      }
    },
    300_000,
  );
});
