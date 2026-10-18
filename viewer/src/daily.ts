// Voyage of the Day: a curated list of vetted seeds, rotated by UTC
// day, mirroring the reference project's "Battle of the day". Everyone
// who opens the daily voyage on the same UTC day gets the same ship.
//
// The wall clock lives here, in the viewer layer, and nowhere else:
// the engine never sees a date. A daily voyage is an ordinary run of
// an ordinary seed; only the choosing of it is time-aware.
//
// The list was vetted by running 30-day voyages (4,320 ticks) for
// seeds 1 to 40 and scoring the drama (grudges and sabotages weighted
// 2, accusations 1). Zero-drama seeds were rejected, as were the
// runaway feud cascades (seeds 21, 35, and 6, with accusations in the
// hundreds: the chronicle becomes a firehose, not a story). Seed 42,
// the flagship Keel Harbour story, closes the list. See DECISIONS.md
// for the full vetting entry.

/** The seven vetted daily seeds, in rotation order. */
export const DAILY_SEEDS = [11, 16, 17, 30, 39, 40, 42] as const;

const MS_PER_DAY = 86_400_000;

/** Today's seed: whole UTC days since the epoch, modulo the list. */
export function dailySeed(nowMs: number = Date.now()): number {
  const days = Math.floor(nowMs / MS_PER_DAY);
  const length = DAILY_SEEDS.length;
  const index = ((days % length) + length) % length;
  return DAILY_SEEDS[index] as number;
}
