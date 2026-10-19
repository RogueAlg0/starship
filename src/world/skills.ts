// Crew skills: the hands learn (the "Crew skills" chapter).
//
// Skill is booked from work actually done, the way harm is booked
// to its ledger: when work lands, experience lands with it, in the
// same tick and from the same event, in integer milli-units, by
// pure arithmetic. The booking draws nothing from any stream, so
// experience can never change a run's luck. Every point names the
// task that taught it; the chronicle prints the level-ups.
//
// The level in this ledger is the truth. What the crew holds is a
// belief about it, kept per observer in the belief stores: it
// starts offset from the truth, and corrects only through work
// actually witnessed. The captain appoints by believed skill and
// can appoint wrong; testimony is weighted by believed expertise;
// the formulas that price the work itself read the true level.

import type { World } from "../engine/engine.ts";
import type { Rng } from "../engine/rng.ts";
import type { CrewMember } from "../entities/crew.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Ship } from "./ship.ts";

export const DISCIPLINES = [
  "engineering",
  "lifeSystems",
  "hydroponics",
  "medicine",
  "fabrication",
  "operations",
  "husbandry",
] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  engineering: "Engineering",
  lifeSystems: "Life Systems",
  hydroponics: "Hydroponics",
  medicine: "Medicine",
  fabrication: "Fabrication",
  operations: "Operations",
  husbandry: "Husbandry",
};

/** One or two letters for roster rows and other tight quarters. */
export const DISCIPLINE_SHORT: Record<Discipline, string> = {
  engineering: "Eng",
  lifeSystems: "Life",
  hydroponics: "Hyd",
  medicine: "Med",
  fabrication: "Fab",
  operations: "Ops",
  husbandry: "Hus",
};

/**
 * Each system aboard belongs to exactly one discipline, so the
 * booking is never ambiguous. The fabricator is not a system in
 * this engine: fabrication books from the parts a repair draws
 * out of the locker (see bookXp's callers and DECISIONS).
 */
export const DISCIPLINE_OF_SYSTEM: Record<string, Discipline> = {
  reactor: "engineering",
  engines: "engineering",
  "life support": "lifeSystems",
  "water recycler": "lifeSystems",
  "hydroponics rig": "hydroponics",
  "medbay unit": "medicine",
  comms: "operations",
};

export function disciplineOfSystem(kind: string): Discipline | null {
  return DISCIPLINE_OF_SYSTEM[kind] ?? null;
}

/** The disciplines an acting seat's portfolio teaches, for the
 *  necessity rate: the portfolios the council chapter prices. */
export const SEAT_DISCIPLINES: Record<string, readonly Discipline[]> = {
  "chief engineer": ["engineering", "lifeSystems", "fabrication"],
  "chief medical officer": ["medicine"],
  quartermaster: ["husbandry"],
  "science officer": ["operations"],
  "first officer": ["operations"],
};

/** One person's skills ledger: the truth about their hands. */
export interface SkillsState {
  /** Cumulative integer milli-XP per discipline. */
  xpMilli: Record<Discipline, number>;
  /** The level boarded with, per discipline: the rust floor. */
  boarding: Record<Discipline, number>;
  /** The one discipline learned at double rate. */
  passion: Discipline;
  /** Tick each discipline was last practised. */
  lastPracticed: Record<Discipline, number>;
}

/** Milli-XP needed to reach a level (0 for level 0). */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  const thresholds = CONFIG.skills.thresholdsMilli;
  return thresholds[Math.min(level, thresholds.length) - 1] as number;
}

function blankDisciplines(value: number): Record<Discipline, number> {
  const out = {} as Record<Discipline, number>;
  for (const d of DISCIPLINES) out[d] = value;
  return out;
}

/**
 * Boarding skills from the role table: the levels the flat number
 * was the shadow of. Passion starts as the role's primary here and
 * is re-drawn in the member loop of generateCrew, in the slot the
 * flat number's jitter used to draw from.
 */
export function createSkills(roleKey: string): SkillsState {
  const boarding = blankDisciplines(0);
  const table = CONFIG.skills.boarding[roleKey] ?? {};
  for (const d of DISCIPLINES) {
    const level = table[d] ?? 0;
    boarding[d] = Math.max(0, Math.min(10, Math.floor(level)));
  }
  const xpMilli = blankDisciplines(0);
  for (const d of DISCIPLINES) xpMilli[d] = xpForLevel(boarding[d] as number);
  const primary = (CONFIG.skills.primary[roleKey] ?? "operations") as Discipline;
  return {
    xpMilli,
    boarding,
    passion: primary,
    lastPracticed: blankDisciplines(0),
  };
}

/** The true level: thresholds crossed by the booked experience. */
export function levelOf(member: CrewMember, discipline: Discipline): number {
  const xp = member.skills.xpMilli[discipline];
  let level = 0;
  for (const threshold of CONFIG.skills.thresholdsMilli) {
    if (xp >= threshold) level++;
    else break;
  }
  return level;
}

/**
 * The cap a lasting mark puts on a discipline, if any: a ruined
 * hand caps engineering and fabrication, a lost eye caps
 * operations. Marks are the body's record (health chapter); the
 * cap reads them, it does not keep its own copy.
 */
export function capFor(member: CrewMember, discipline: Discipline): number | null {
  const marks = member.body.marks;
  if (
    marks.includes("ruined hand") &&
    (discipline === "engineering" || discipline === "fabrication")
  ) {
    return CONFIG.skills.markCapLevel;
  }
  if (marks.includes("lost eye") && discipline === "operations") {
    return CONFIG.skills.markCapLevel;
  }
  return null;
}

/** The level the formulas may use: the truth, as the body allows. */
export function effectiveLevel(
  member: CrewMember,
  discipline: Discipline,
): number {
  const level = levelOf(member, discipline);
  const cap = capFor(member, discipline);
  return cap === null ? level : Math.min(level, cap);
}

/**
 * The competence the old flat number's formulas read, now cast by
 * the discipline's effective level: level 7 reads 0.98, the way
 * the chief engineer's rolled number read before the chapter.
 */
export function skillOf(member: CrewMember, discipline: Discipline): number {
  return effectiveLevel(member, discipline) * CONFIG.skills.skillPerLevel;
}

/** The strongest competence aboard this person's hands. */
export function bestSkillOf(member: CrewMember): number {
  let best = 0;
  for (const d of DISCIPLINES) best = Math.max(best, skillOf(member, d));
  return best;
}

/** The person's primary discipline: their highest effective level,
 *  ties broken toward the discipline they boarded highest in. */
export function topDiscipline(
  member: CrewMember,
): { discipline: Discipline; level: number } {
  let best: Discipline = DISCIPLINES[0] as Discipline;
  let bestLevel = -1;
  let bestBoarding = -1;
  for (const d of DISCIPLINES) {
    const level = effectiveLevel(member, d);
    const boarding = member.skills.boarding[d] as number;
    if (level > bestLevel || (level === bestLevel && boarding > bestBoarding)) {
      best = d;
      bestLevel = level;
      bestBoarding = boarding;
    }
  }
  return { discipline: best, level: bestLevel };
}

/** Progress through the current level, for the person card. */
export function levelProgress(
  member: CrewMember,
  discipline: Discipline,
): { level: number; fraction: number } {
  const level = levelOf(member, discipline);
  if (level >= 10) return { level, fraction: 1 };
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const xp = member.skills.xpMilli[discipline];
  return {
    level,
    fraction: next > floor ? (xp - floor) / (next - floor) : 1,
  };
}

/** The difficulty of work on a system at this condition. */
export function difficultyOf(condition: number): number {
  const cfg = CONFIG.skills;
  if (condition < CONFIG.systems.strainThreshold) return cfg.difficultyRed;
  if (condition < CONFIG.systems.damagedThreshold) return cfg.difficultyDamaged;
  return cfg.difficultyRoutine;
}

// ---------------------------------------------------------- believed skill

/** What this observer believes about a crewmate's level. Beliefs
 *  are floats: a correction moves them by fractions of a level. */
export function believedSkill(
  member: CrewMember,
  subjectId: string,
  discipline: Discipline,
): number {
  return member.beliefs.skill[subjectId]?.[discipline] ?? 0;
}

function setBelievedSkill(
  member: CrewMember,
  subjectId: string,
  discipline: Discipline,
  value: number,
): void {
  const record =
    member.beliefs.skill[subjectId] ??
    (member.beliefs.skill[subjectId] = {});
  record[discipline] = value < 0 ? 0 : value > 10 ? 10 : value;
}

/**
 * The generation pass for skills, drawn on the crew generation
 * stream AFTER every existing draw (identity, traits, beliefs,
 * rivalries), so the roster a seed names is the roster it has
 * always named: one minor discipline boarded low where they had
 * none, and every observer's believed skill seeded offset from
 * the truth. (The passion itself is drawn in the member loop,
 * in the slot the flat repair number's jitter used to draw
 * from: one draw per member, and the stream stays aligned.)
 * A person is never wrong about their own hands.
 */
export function drawSkillsPass(rng: Rng, crew: readonly CrewMember[]): void {
  const cfg = CONFIG.skills;
  for (const member of crew) {
    const minor = DISCIPLINES[rng.int(DISCIPLINES.length)] as Discipline;
    const minorLevel = 1 + rng.int(2);
    if ((member.skills.boarding[minor] as number) === 0) {
      member.skills.boarding[minor] = minorLevel;
      member.skills.xpMilli[minor] = xpForLevel(minorLevel);
    }
  }
  for (const observer of crew) {
    for (const subject of crew) {
      for (const d of DISCIPLINES) {
        if (observer === subject) {
          setBelievedSkill(observer, subject.id, d, levelOf(subject, d));
          continue;
        }
        const span = cfg.beliefOffsetMax * 2 + 1;
        const offset = rng.int(span) - cfg.beliefOffsetMax;
        setBelievedSkill(
          observer,
          subject.id,
          d,
          levelOf(subject, d) + offset,
        );
      }
    }
  }
}

// ------------------------------------------------------------- the booking

export interface BookOptions {
  /** The work that taught it, in the chronicle's voice. */
  task: string;
  /** Necessity: appointed cover, or no able native hand aboard. */
  cover?: boolean;
  /** The booking opens a work session (a repair begun, a
   *  treatment begun): witnesses correct their beliefs on it
   *  without waiting for the standing gate. */
  session?: boolean;
  /** The booking is a lesson a bystander can share: juniors
   *  standing with the worker book the mentor fraction of it.
   *  Repairs, treatments, and session-opening work radiate;
   *  routine ticks do not — watching is not doing, and a ship
   *  where standing in engineering teaches engineering would
   *  mint experts out of patrol routes. */
  mentor?: boolean;
  /** How hard the work was, as a multiplier on the base lesson
   *  (the caller reads it off the system's condition, or a
   *  treatment's severity). Passion and cover add their
   *  doubling on top of the routine lesson rather than
   *  multiplying the difficulty: at routine work a passionate
   *  hand learns at exactly double rate, and red work with a
   *  passion learns at difficulty plus one, not difficulty
   *  times two — the compounding was minting masters. */
  difficulty?: number;
}

/** Who stood with the worker and could see the work. */
function witnessesOf(
  crew: readonly CrewMember[],
  member: CrewMember,
): CrewMember[] {
  return crew.filter(
    (other) =>
      other !== member &&
      !other.dead &&
      !other.leftShip &&
      !other.ashore &&
      other.room === member.room &&
      other.activity !== "rest",
  );
}

/**
 * Apply milli-XP to the ledger. With witnesses, the two social
 * consequences of work land with it: juniors standing with a
 * better hand book the mentor fraction of the lesson, and every
 * witness's believed skill corrects toward the truth (at once,
 * on a session or a level-up; otherwise through the standing
 * gate). A level-up prints when the work is done, and a witness
 * of the work that carried them over holds the new level exactly.
 */
function applyXp(
  w: World,
  crew: readonly CrewMember[],
  member: CrewMember,
  discipline: Discipline,
  milli: number,
  task: string,
  withWitnesses: boolean,
  session: boolean,
  mentorOk: boolean,
): void {
  if (milli <= 0 || member.dead || member.leftShip) return;
  const cfg = CONFIG.skills;
  const before = levelOf(member, discipline);
  member.skills.xpMilli[discipline] += milli;
  member.skills.lastPracticed[discipline] = w.tick;
  const after = levelOf(member, discipline);
  // A person is never wrong about their own hands.
  setBelievedSkill(member, member.id, discipline, after);

  const witnesses = withWitnesses ? witnessesOf(crew, member) : [];
  if (after > before) {
    w.emit("level_up", [member.id], {
      person: member.id,
      discipline,
      level: after,
      task,
    });
    for (const witness of witnesses) {
      setBelievedSkill(witness, member.id, discipline, after);
      witness.beliefs.skillSeen[`${member.id}:${discipline}`] = w.tick;
    }
  } else if (withWitnesses) {
    for (const witness of witnesses) {
      const key = `${member.id}:${discipline}`;
      const seen = witness.beliefs.skillSeen[key] ?? -1000000;
      if (!session && w.tick - seen < cfg.beliefSeenGateTicks) continue;
      witness.beliefs.skillSeen[key] = w.tick;
      const current = believedSkill(witness, member.id, discipline);
      const delta = Math.max(
        -cfg.beliefCorrection,
        Math.min(cfg.beliefCorrection, after - current),
      );
      if (delta !== 0) {
        setBelievedSkill(witness, member.id, discipline, current + delta);
      }
    }
  }

  if (withWitnesses && mentorOk) {
    const fraction = Math.round(milli * cfg.mentorFraction);
    if (fraction > 0) {
      for (const witness of witnesses) {
        if (levelOf(witness, discipline) < after) {
          applyXp(
            w,
            crew,
            witness,
            discipline,
            fraction,
            `at ${member.name}'s side`,
            false,
            false,
            false,
          );
        }
      }
    }
  }
}

/**
 * Book experience from work actually done. The amount the caller
 * computed (task rate times difficulty) is scaled here by the two
 * rates that belong to the person, not the task: their passion
 * for the discipline, and necessity when the work is cover.
 */
export function bookXp(
  w: World,
  crew: readonly CrewMember[],
  member: CrewMember,
  discipline: Discipline,
  baseMilli: number,
  opts: BookOptions,
): void {
  const cfg = CONFIG.skills;
  let factor = opts.difficulty ?? 1;
  if (discipline === member.skills.passion) factor += cfg.passionFactor - 1;
  if (opts.cover === true) factor += cfg.coverFactor - 1;
  const milli = Math.round(baseMilli * factor);
  applyXp(
    w,
    crew,
    member,
    discipline,
    milli,
    opts.task,
    true,
    opts.session === true,
    opts.mentor === true,
  );
}

/**
 * A public failure corrects the record: witnesses who rated the
 * worker above the truth in the work's discipline now hold the
 * truth. (Work seen going wrong lowers believed skill, where
 * work seen only corrects it by steps.)
 */
export function notePublicFailure(
  w: World,
  crew: readonly CrewMember[],
  member: CrewMember,
  discipline: Discipline,
): void {
  const truth = levelOf(member, discipline);
  for (const witness of witnessesOf(crew, member)) {
    if (believedSkill(witness, member.id, discipline) > truth) {
      setBelievedSkill(witness, member.id, discipline, truth);
      witness.beliefs.skillSeen[`${member.id}:${discipline}`] = w.tick;
    }
  }
}

/**
 * Is this member covering this system's work of necessity? Two
 * doors: they hold an acting council seat whose portfolio covers
 * the discipline (appointed by the captain, not born to the
 * role), or they lack the affinity and no able native hand
 * remains aboard to do it. Native hands at their own work are
 * never cover, however stretched the ship.
 */
export function isCover(
  tick: number,
  member: CrewMember,
  systemKind: string,
  crew: readonly CrewMember[],
  ship: Ship,
): boolean {
  const discipline = disciplineOfSystem(systemKind);
  if (discipline === null) return false;
  const acting = ship.councilPublic?.acting ?? {};
  for (const [seat, holderId] of Object.entries(acting)) {
    if (
      holderId === member.id &&
      (SEAT_DISCIPLINES[seat] ?? []).includes(discipline)
    ) {
      return true;
    }
  }
  if (member.affinity.includes(systemKind)) return false;
  return !crew.some(
    (other) =>
      other !== member &&
      !other.dead &&
      !other.leftShip &&
      !other.ashore &&
      tick >= other.confinedUntil &&
      other.affinity.includes(systemKind),
  );
}

// ------------------------------------------------------------------- rust

/**
 * Rust, at the day line: a discipline unpractised past the grace
 * loses a little of its gains each day, down to the level its
 * holder boarded with and never below. Silent in the log: rust
 * is a number the epilogue reads, not an event.
 */
export function stepSkills(w: World, crew: readonly CrewMember[]): void {
  const tpd = CONFIG.time.ticksPerDay;
  if (w.tick === 0 || w.tick % tpd !== 0) return;
  const cfg = CONFIG.skills;
  for (const member of crew) {
    if (member.dead || member.leftShip) continue;
    for (const d of DISCIPLINES) {
      const floor = xpForLevel(member.skills.boarding[d] as number);
      const xp = member.skills.xpMilli[d];
      if (xp <= floor) continue;
      if (w.tick - member.skills.lastPracticed[d] < cfg.rustGraceDays * tpd) {
        continue;
      }
      member.skills.xpMilli[d] = Math.max(floor, xp - cfg.rustMilliPerDay);
    }
  }
}
