// Day and night aboard: the ship's clock read as light.
//
// The engine already runs on ship time (ten-minute ticks, 144 to a
// day); this module is the viewer's reading of that clock as a
// lighting phase, nothing more. It invents no state: the phase is a
// pure function of the tick of day the header already shows.
//
// Phases: the day watch (07:00-19:00) is fully lit. The evening ramp
// (19:00-22:00) dims through warm lamplight to the night watch
// (22:00-06:00), which sits at 40% brightness under a cool blue tint
// (running lights, in-fiction). The dawn ramp (06:00-07:00) warms
// back up to full day. Ramps are smoothstepped over their boundary
// hours, so the light never cuts, it breathes.
//
// The reference sim treats light as engine state that changes what
// can be seen and done at night. Ours, for now, is presentation
// only; the engine analog is recorded as design-future in
// DECISIONS.md and DESIGN.md, and is not built here.

/** Darkness on the night watch: tint alpha, so 40% of the day shows. */
export const NIGHT_DARK = 0.6;

export type WatchName =
  | "Day watch"
  | "Evening watch"
  | "Night watch"
  | "Dawn watch";

interface Key {
  minute: number;
  dark: number;
  /** 0 = cool blue tint, 1 = warm amber tint. */
  warm: number;
}

const KEYS: readonly Key[] = [
  { minute: 0, dark: NIGHT_DARK, warm: 0.15 },
  { minute: 360, dark: NIGHT_DARK, warm: 0.4 }, // 06:00, dawn begins
  { minute: 420, dark: 0, warm: 0 }, // 07:00, day watch, full light
  { minute: 1140, dark: 0, warm: 0 }, // 19:00, evening begins
  { minute: 1260, dark: 0.3, warm: 0.95 }, // 21:00, warm and half dim
  { minute: 1320, dark: NIGHT_DARK, warm: 0.2 }, // 22:00, night watch
  { minute: 1440, dark: NIGHT_DARK, warm: 0.15 },
];

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function dayMinute(dayMinutes: number): number {
  return ((dayMinutes % 1440) + 1440) % 1440;
}

/** The lighting at a minute of the ship's day: darkness and tint warmth. */
export function lightAt(dayMinutes: number): { dark: number; warm: number } {
  const m = dayMinute(dayMinutes);
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i] as Key;
    const b = KEYS[i + 1] as Key;
    if (m >= a.minute && m <= b.minute) {
      const t = smoothstep((m - a.minute) / (b.minute - a.minute));
      return {
        dark: a.dark + (b.dark - a.dark) * t,
        warm: a.warm + (b.warm - a.warm) * t,
      };
    }
  }
  return { dark: NIGHT_DARK, warm: 0.15 };
}

/** The watch the ship is on at a minute of the day, for the header. */
export function watchName(dayMinutes: number): WatchName {
  const m = dayMinute(dayMinutes);
  if (m >= 360 && m < 420) return "Dawn watch";
  if (m >= 420 && m < 1140) return "Day watch";
  if (m >= 1140 && m < 1320) return "Evening watch";
  return "Night watch";
}
