// The Ship's Routine: every crew member lives by a daily shape.
//
// At generation each person draws a watch (the day watch, or the night
// watch pair who keep the ship while others sleep) and a routine: a sleep
// block, work blocks, and the free time between, with the two ship-wide
// meal windows laid over the top. The routine is data on the person, not
// a behaviour: the crew step reads the current block and shapes the
// candidates it offers, so the schedule proposes and needs, emergencies,
// and temperament dispose. All draws come from the "routine" stream, so
// the roster's names, traits, and beliefs are untouched by the routine
// a person happens to draw.

import type { Rng } from "../engine/rng.ts";
import { CONFIG } from "../scenario/config.ts";

export type WatchName = "day" | "night";

/** What part of the daily shape a tick falls in for one person. */
export type BlockKind = "sleep" | "work" | "meal" | "free";

export interface Routine {
  watch: WatchName;
  /** Ship hour the sleep block begins (may exceed the end: it wraps). */
  sleepStartHour: number;
  /** Ship hour the sleep block ends. */
  sleepEndHour: number;
  /** Work blocks as [startHour, endHour) pairs in ship hours. */
  workWindows: readonly (readonly [number, number])[];
}

/**
 * Choose which role keys stand the night watch: one draw from each
 * configured pool, so the pair is always one engineering hand and one
 * bridge or security hand. Draws from the given stream.
 */
export function pickNightWatchRoles(rng: Rng): ReadonlySet<string> {
  const picks = new Set<string>();
  for (const pool of CONFIG.routine.nightWatchPools) {
    if (picks.size >= CONFIG.routine.nightWatchSize) break;
    const options = pool.filter((key) => !picks.has(key));
    if (options.length > 0) {
      picks.add(options[rng.int(options.length)] as string);
    }
  }
  return picks;
}

/**
 * Build one person's routine for their watch. A small per-person shift
 * (an hour either way) keeps the ship from moving in lockstep; the
 * disciplined keep the printed hours, and the restless sleep an hour
 * less. Draws exactly one number from the given stream.
 */
export function makeRoutine(
  watch: WatchName,
  traits: readonly string[],
  rng: Rng,
): Routine {
  const cfg = CONFIG.routine;
  const drawn = rng.int(3) - 1; // -1, 0, or +1 hour
  const shift = traits.includes("disciplined") ? 0 : drawn;
  const shortSleep = traits.includes("restless") ? 1 : 0;
  if (watch === "day") {
    return {
      watch,
      sleepStartHour: mod24(cfg.daySleepStartHour + shift),
      sleepEndHour: mod24(cfg.daySleepEndHour + shift - shortSleep),
      workWindows: cfg.dayWorkWindows.map(([start, end]) => [
        start + shift,
        end + shift,
      ]),
    };
  }
  return {
    watch,
    sleepStartHour: mod24(cfg.nightSleepStartHour + shift),
    sleepEndHour: mod24(cfg.nightSleepEndHour + shift - shortSleep),
    workWindows: cfg.nightWorkWindows.map(([start, end]) => [start, end]),
  };
}

function mod24(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

/** True when `hour` falls in [start, end), where start may wrap past 24. */
function hourIn(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

function hourOfDay(tick: number): number {
  const perDay = CONFIG.time.ticksPerDay;
  const tod = ((tick % perDay) + perDay) % perDay;
  return Math.floor(tod / (perDay / 24));
}

/** The meal window a tick falls in, if any. */
export function mealWindowAt(tick: number): "breakfast" | "evening" | null {
  const hour = hourOfDay(tick);
  const cfg = CONFIG.routine;
  if (hour >= cfg.breakfastStartHour && hour < cfg.breakfastEndHour) {
    return "breakfast";
  }
  if (hour >= cfg.eveningStartHour && hour < cfg.eveningEndHour) {
    return "evening";
  }
  return null;
}

/**
 * The block a tick falls in for a routine. Precedence is the shape of a
 * ship day: sleep first (the night watch sleeps through breakfast), then
 * the shared meal windows (everyone awake eats together, whatever their
 * work block says), then work, and whatever is left is free.
 */
export function blockAt(routine: Routine, tick: number): BlockKind {
  const hour = hourOfDay(tick);
  if (hourIn(hour, routine.sleepStartHour, routine.sleepEndHour)) {
    return "sleep";
  }
  if (mealWindowAt(tick) !== null) return "meal";
  for (const [start, end] of routine.workWindows) {
    if (hour >= start && hour < end) return "work";
  }
  return "free";
}

/** The current block for anything carrying a routine (a crew member). */
export function currentBlock(
  member: { routine: Routine },
  tick: number,
): BlockKind {
  return blockAt(member.routine, tick);
}
