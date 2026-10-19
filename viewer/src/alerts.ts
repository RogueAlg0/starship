// Alerts: urgency-tiered notifications over the deck, the way the
// reference squad viewer floats its battle news over the map. An
// alert is either a MOMENT (an event the chronicle already speaks:
// a sabotage found, an accusation, a repair finished) or a STATE (a
// system's condition band, which holds for as long as the condition
// holds). Moments fade on a wall-clock lifetime; states persist.
//
// Tiers:
// - critical (red): a system below 30% condition, or failed. A
//   state: it persists while the condition holds. Its dismiss
//   snoozes it until the band changes, not forever.
// - major (amber): sabotage, an accusation, a grudge, a broken
//   trust, a system crossing below 60%. Lingers about 12 s.
// - minor (neutral): a repair completed, a system back above 90%,
//   a bond formed. Fades in about 5 s.
//
// Lifetimes scale mildly with playback speed so a burst at 6x does
// not flood the corner and a note at 1x gets its slow read:
// scale = clamp(2.5 / max(ticksPerSecond, 0.4), 0.5, 2.5), applied
// to the base lifetimes above (12 s major, 5 s minor). At the 1x
// witness pace (0.4 tps) the scale is 2.5; at 3 tps it is about
// 0.83; at 6x (60 tps) it bottoms out at 0.5.
//
// Stack discipline: at most 4 visible, newest on top, one alert per
// subject (a system sliding 55% then 28% escalates its own alert; it
// never stacks two). Minors are rate-limited (one accepted per 3 s)
// and dropped when the stack is full; majors and criticals displace
// the oldest minor, then the oldest timed major. Criticals are never
// displaced.
//
// The stack itself is pure state (no DOM), so the headless harness
// can drive it with a fake clock. AlertStackView renders it.

import { spriteCanvas, type SpriteDef } from "./props.ts";

export type AlertTier = "critical" | "major" | "minor";

export type AlertCategory =
  | "damage"
  | "sabotage"
  | "speech"
  | "grudge"
  | "trust"
  | "repair"
  | "bond"
  | "stores"
  | "death"
  | "ending"
  | "relief"
  | "injury";

/** Where a click takes the viewer: a person, or a room to flash. */
export interface AlertFocus {
  personId?: string;
  room?: number;
  systemId?: string;
}

export interface AlertItem {
  key: string;
  tier: AlertTier;
  category: AlertCategory;
  text: string;
  focus: AlertFocus;
  bornMs: number;
  /** Wall-ms expiry; Infinity while a state holds. */
  expiresMs: number;
  /** Lifetime span for the progress bar; Infinity for states. */
  spanMs: number;
  /** Condition band for state alerts ("critical" | "major"). */
  band: string | null;
}

export interface AlertEventInput {
  /** A critical MOMENT (a store crossing its critical line) is
   *  timed like a long major; critical STATES come from the
   *  condition sync and hold until they clear. */
  tier: "critical" | "major" | "minor";
  category: AlertCategory;
  text: string;
  focus: AlertFocus;
}

/** One system's live state, as the condition sync reads it. */
export interface SystemState {
  id: string;
  name: string;
  room: number;
  roomName: string;
  /** Condition in [0, 1]. */
  condition: number;
  failed: boolean;
}

export const MAX_VISIBLE_ALERTS = 4;
const MINOR_GAP_MS = 3000;
const MAJOR_BASE_MS = 12_000;
const MINOR_BASE_MS = 5_000;
const CRITICAL_BELOW = 0.3;
const MAJOR_BELOW = 0.6;
const RECOVERED_ABOVE = 0.9;

/**
 * The lifetime multiplier for the current playback rate: the brief's
 * rule, clamp(2.5 / max(tps, 0.4), 0.5, 2.5).
 */
export function lifetimeScale(ticksPerSecond: number): number {
  return Math.min(
    2.5,
    Math.max(0.5, 2.5 / Math.max(ticksPerSecond, 0.4)),
  );
}

function bandOf(state: SystemState): "critical" | "major" | "none" {
  if (state.failed || state.condition < CRITICAL_BELOW) return "critical";
  if (state.condition < MAJOR_BELOW) return "major";
  return "none";
}

export class AlertStack {
  /** Newest first. */
  private items: AlertItem[] = [];
  /** Last band seen per system id ("critical" | "major" | "none"). */
  private bands = new Map<string, string>();
  /** System key -> the band its critical alert was snoozed in. */
  private snoozedBand = new Map<string, string>();
  /** Systems that have been below the recovery line this dip. */
  private dipped = new Set<string>();
  /** Systems that reached a condition band during this dip. */
  private banded = new Set<string>();
  private lastMinorMs = Number.NEGATIVE_INFINITY;
  private seq = 0;
  private tps = 0.4;
  onChange: (() => void) | null = null;

  setTps(ticksPerSecond: number): void {
    this.tps = ticksPerSecond;
  }

  private scale(): number {
    return lifetimeScale(this.tps);
  }

  /** Visible alerts, newest first (snoozed states are not here). */
  visible(): AlertItem[] {
    return [...this.items];
  }

  reset(): void {
    this.items = [];
    this.bands.clear();
    this.snoozedBand.clear();
    this.dipped.clear();
    this.banded.clear();
    this.lastMinorMs = Number.NEGATIVE_INFINITY;
    this.changed();
  }

  private changed(): void {
    this.onChange?.();
  }

  /**
   * Post a moment: an event the chronicle already spoke. Returns
   * true when the alert was admitted (minors can be rate-limited or
   * dropped by a full stack).
   */
  post(input: AlertEventInput, nowMs: number): boolean {
    const key = `evt:${input.category}:${++this.seq}`;
    const base =
      input.tier === "critical"
        ? MAJOR_BASE_MS * 2
        : input.tier === "major"
          ? MAJOR_BASE_MS
          : MINOR_BASE_MS;
    const span = base * this.scale();
    const item: AlertItem = {
      key,
      tier: input.tier,
      category: input.category,
      text: input.text,
      focus: input.focus,
      bornMs: nowMs,
      expiresMs: nowMs + span,
      spanMs: span,
      band: null,
    };
    if (!this.admit(item, nowMs)) return false;
    this.changed();
    return true;
  }

  /**
   * Feed the live condition of every system. State alerts are
   * derived from band transitions, so a steady condition never
   * re-fires its own news.
   */
  syncSystems(states: readonly SystemState[], nowMs: number): void {
    for (const state of states) {
      this.syncSystem(state, nowMs);
    }
  }

  private syncSystem(state: SystemState, nowMs: number): void {
    const key = `sys:${state.id}`;
    const band = bandOf(state);
    const prev = this.bands.get(state.id);
    this.bands.set(state.id, band);
    if (state.condition < RECOVERED_ABOVE) this.dipped.add(state.id);
    if (band !== "none") this.banded.add(state.id);

    if (band === "critical") {
      if (prev === "critical") {
        // Steady emergency: keep the alert (unless snoozed in this
        // band), refreshing its text as the number moves.
        if (this.snoozedBand.get(key) !== "critical") {
          this.upsertState(key, state, "critical", nowMs, false);
        }
      } else if (prev !== undefined) {
        // Escalation (or a first sighting): the state takes the stack.
        this.snoozedBand.delete(key);
        this.upsertState(key, state, "critical", nowMs, true);
      }
      // prev === undefined and already critical cannot happen: ships
      // generate systems at 85% or better. If it ever did, the next
      // sync (prev now "critical") raises it.
    } else if (band === "major") {
      if (prev === "critical") {
        // De-escalation: the emergency is over, the news lingers.
        this.snoozedBand.delete(key);
        this.upsertState(key, state, "major", nowMs, true);
      } else if (prev === "none") {
        // The crossing below 60%: a timed major moment.
        this.upsertState(key, state, "major", nowMs, true);
      }
      // prev === "major" or undefined: the crossing already spoke.
    } else {
      // band === "none": healthy air.
      this.snoozedBand.delete(key);
      const existing = this.items.find((i) => i.key === key);
      if (existing !== undefined && existing.tier === "critical") {
        // A jump straight out of the red (a finished repair): the
        // state becomes a lingering major, it does not just vanish.
        const pct = Math.round(state.condition * 100);
        this.upsertState(
          key,
          state,
          "major",
          nowMs,
          true,
          `The ${state.name} is out of danger (${pct}%) — ${state.roomName}.`,
        );
      }
      if (
        state.condition >= RECOVERED_ABOVE &&
        this.dipped.has(state.id) &&
        this.banded.has(state.id)
      ) {
        this.dipped.delete(state.id);
        this.banded.delete(state.id);
        this.post(
          {
            tier: "minor",
            category: "repair",
            text: `The ${state.name} is back above 90%.`,
            focus: { room: state.room, systemId: state.id },
          },
          nowMs,
        );
      } else if (state.condition >= RECOVERED_ABOVE) {
        this.dipped.delete(state.id);
      }
    }
  }

  /** Create or refresh the one state alert for a system. */
  private upsertState(
    key: string,
    state: SystemState,
    tier: "critical" | "major",
    nowMs: number,
    fresh: boolean,
    textOverride?: string,
  ): void {
    const pct = Math.round(state.condition * 100);
    const text =
      textOverride ??
      (state.failed
        ? `The ${state.name} in the ${state.roomName} has failed.`
        : tier === "critical"
          ? `The ${state.name} is at ${pct}% — ${state.roomName}.`
          : `The ${state.name} is failing (${pct}%) — ${state.roomName}.`);
    const existing = this.items.find((i) => i.key === key);
    if (existing !== undefined) {
      if (
        existing.tier === tier &&
        existing.text === text &&
        existing.band === tier
      ) {
        return; // Steady state: nothing new to say.
      }
      existing.tier = tier;
      existing.category = "damage";
      existing.text = text;
      existing.focus = { room: state.room, systemId: state.id };
      existing.band = tier;
      if (tier === "critical") {
        existing.expiresMs = Number.POSITIVE_INFINITY;
        existing.spanMs = Number.POSITIVE_INFINITY;
      } else if (fresh) {
        const span = MAJOR_BASE_MS * this.scale();
        existing.bornMs = nowMs;
        existing.expiresMs = nowMs + span;
        existing.spanMs = span;
      }
      // Fresh news goes on top.
      this.items = [existing, ...this.items.filter((i) => i !== existing)];
      this.changed();
      return;
    }
    const span =
      tier === "critical"
        ? Number.POSITIVE_INFINITY
        : MAJOR_BASE_MS * this.scale();
    const item: AlertItem = {
      key,
      tier,
      category: "damage",
      text,
      focus: { room: state.room, systemId: state.id },
      bornMs: nowMs,
      expiresMs: tier === "critical" ? Number.POSITIVE_INFINITY : nowMs + span,
      spanMs: span,
      band: tier,
    };
    if (this.admit(item, nowMs)) this.changed();
  }

  /**
   * Admit an item under the stack discipline. Returns false when a
   * minor is rate-limited or has nowhere to go.
   */
  private admit(item: AlertItem, nowMs: number): boolean {
    if (item.tier === "minor") {
      if (nowMs - this.lastMinorMs < MINOR_GAP_MS) return false;
      if (this.items.length >= MAX_VISIBLE_ALERTS) return false;
      this.lastMinorMs = nowMs;
      this.items.unshift(item);
      return true;
    }
    // Major and critical displace: oldest minor first, then the
    // oldest timed major. Criticals are never displaced; if the
    // stack is wall-to-wall criticals, a critical still gets in
    // (the cap is a discipline, not a blindfold).
    while (this.items.length >= MAX_VISIBLE_ALERTS) {
      const victim =
        this.oldestWhere((i) => i.tier === "minor") ??
        this.oldestWhere((i) => i.tier === "major" && i.band === null) ??
        this.oldestWhere((i) => i.tier === "major");
      if (victim === undefined) break;
      this.items = this.items.filter((i) => i !== victim);
    }
    this.items.unshift(item);
    return true;
  }

  private oldestWhere(
    pred: (item: AlertItem) => boolean,
  ): AlertItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i] as AlertItem;
      if (pred(item)) return item;
    }
    return undefined;
  }

  /**
   * Dismiss an alert. A critical state is snoozed until its band
   * changes; a timed alert is simply gone (it was a moment).
   */
  dismiss(key: string): void {
    const item = this.items.find((i) => i.key === key);
    if (item === undefined) return;
    if (item.band === "critical") {
      this.snoozedBand.set(key, "critical");
    }
    this.items = this.items.filter((i) => i !== item);
    this.changed();
  }

  /** Expire timed alerts whose wall time is up. */
  tick(nowMs: number): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.expiresMs > nowMs);
    if (this.items.length !== before) this.changed();
  }
}

// ------------------------------------------------------------- the view

const ICONS: Record<AlertCategory, SpriteDef> = {
  damage: {
    rows: [
      "....r....",
      "...rro...",
      "...royo..",
      "..royyo..",
      "..oyyyo..",
      "..oyyyo..",
      "...oyo...",
      "...o.o...",
      "....o....",
    ],
    pal: { r: "#e5534b", o: "#e07b39", y: "#ffd76a" },
  },
  sabotage: {
    rows: [
      "x...x...x",
      ".x..x..x.",
      "..x.x.x..",
      "...xxx...",
      "xx.xxx.xx",
      "...xxx...",
      "..x.x.x..",
      ".x..x..x.",
      "x...x...x",
    ],
    pal: { x: "#ffd76a" },
  },
  speech: {
    rows: [
      ".wwwwwww.",
      "wwwwwwwww",
      "ww.w.w.ww",
      "wwwwwwwww",
      "wwwwwwwww",
      ".wwwwwww.",
      "..ww.....",
      ".ww......",
      ".........",
    ],
    pal: { w: "#cfe0f4" },
  },
  grudge: {
    rows: [
      "....zz...",
      "...zz....",
      "..zzzzz..",
      "...zz....",
      "..zz.....",
      ".zz......",
      "zz.......",
      ".........",
      ".........",
    ],
    pal: { z: "#ff7847" },
  },
  trust: {
    rows: [
      ".hh...hh.",
      "hhhh..hhh",
      "hhhh..hhh",
      ".hhh..hh.",
      "..hh..h..",
      "...h..h..",
      "....h....",
      ".........",
      ".........",
    ],
    pal: { h: "#c98a9d" },
  },
  repair: {
    rows: [
      ".rr...rr.",
      "rrrrrrrrr",
      "rrrwwwrrr",
      "rrwwwwwrr",
      ".rrwwwrr.",
      "..rrrrr..",
      "...rrr...",
      "....r....",
      ".........",
    ],
    pal: { r: "#7fd4a8", w: "#eef6ee" },
  },
  bond: {
    rows: [
      ".hh...hh.",
      "hhhhhhhhh",
      "hhhhhhhhh",
      ".hhhhhhh.",
      "..hhhhh..",
      "...hhh...",
      "....h....",
      ".........",
      ".........",
    ],
    pal: { h: "#e86a92" },
  },
  stores: {
    rows: [
      ".........",
      ".xxxxxxx.",
      "xooooooox",
      "xo.ooo.ox",
      "xooooooox",
      "xo.ooo.ox",
      "xooooooox",
      ".xxxxxxx.",
      ".........",
    ],
    pal: { x: "#a8763e", o: "#e8a33d" },
  },
  death: {
    rows: [
      "....g....",
      "...ggg...",
      "....g....",
      "....g....",
      ".ggggggg.",
      "....g....",
      "....g....",
      "....g....",
      "..ggggg..",
    ],
    pal: { g: "#9aa7b8" },
  },
  ending: {
    rows: [
      ".........",
      ".s...s...",
      "..s.s....",
      "...s..s..",
      "....ss...",
      "...s.....",
      "..s...s..",
      ".s.....s.",
      ".........",
    ],
    pal: { s: "#e5534b" },
  },
  relief: {
    rows: [
      ".........",
      ".g.g.g.g.",
      "ggggggggg",
      ".ggggggg.",
      "..ggggg..",
      ".........",
      ".........",
      ".........",
      ".........",
    ],
    pal: { g: "#ffd76a" },
  },
  injury: {
    rows: [
      ".........",
      "...www...",
      "...www...",
      ".wwwwwww.",
      ".wwwrwww.",
      ".wwwwwww.",
      "...www...",
      "...www...",
      ".........",
    ],
    pal: { w: "#eef2f4", r: "#e5534b" },
  },
};

interface Chip {
  root: HTMLDivElement;
  fill: HTMLDivElement | null;
  item: AlertItem;
  leaving: boolean;
  /** "x" for critical (dismiss button), "bar" for timed tiers. */
  shape: string;
  /** The born|span the lifetime bar's CSS animation was armed with. */
  barKey: string;
}

/**
 * Renders an AlertStack into the stack container: dark chips with a
 * tier-coloured left bar, a pixel icon, one line of text, and a
 * thin lifetime bar on timed tiers. Chips are reconciled by key, so
 * a state alert that escalates keeps its element and just changes
 * colour. The frame loop drives expiry only: the lifetime bar is a
 * CSS animation armed when a chip is built or its span is refreshed,
 * never a per-frame style write.
 */
export class AlertStackView {
  private readonly container: HTMLElement;
  private readonly stack: AlertStack;
  private readonly onFocus: (item: AlertItem) => void;
  private readonly chips = new Map<string, Chip>();

  constructor(
    container: HTMLElement,
    stack: AlertStack,
    onFocus: (item: AlertItem) => void,
  ) {
    this.container = container;
    this.stack = stack;
    this.onFocus = onFocus;
    this.stack.onChange = () => this.render();
    this.render();
  }

  /** Advance expiry. Call once per frame. */
  frame(nowMs: number): void {
    this.stack.tick(nowMs);
  }

  /**
   * (Re)start a timed chip's lifetime bar as a CSS animation over
   * the item's span. Called when a chip is built and whenever its
   * item's born/span pair changes (a refreshed state alert); a
   * steady chip is never touched again.
   */
  private armBar(chip: Chip): void {
    const { fill, item } = chip;
    if (fill === null || !Number.isFinite(item.spanMs)) return;
    const key = `${item.bornMs}|${item.spanMs}`;
    if (chip.barKey === key) return;
    chip.barKey = key;
    fill.style.animationName = "none";
    void fill.offsetWidth; // restart the animation from full width
    fill.style.animationDuration = `${item.spanMs}ms`;
    fill.style.animationName = "alert-burn";
  }

  private render(): void {
    const visible = this.stack.visible();
    const wanted = new Set(visible.map((i) => i.key));
    // Retire chips whose alert is gone: a short fade, then removal.
    for (const [key, chip] of this.chips) {
      if (wanted.has(key) || chip.leaving) continue;
      chip.leaving = true;
      chip.root.classList.add("leaving");
      window.setTimeout(() => {
        chip.root.remove();
        if (this.chips.get(key) === chip) this.chips.delete(key);
      }, 280);
    }
    // Create or refresh chips, newest on top.
    for (const item of visible) {
      // The × shape belongs to states (infinite span); a timed
      // critical moment burns a bar like any other moment.
      const shape =
        item.tier === "critical" && !Number.isFinite(item.spanMs)
          ? "x"
          : "bar";
      let chip = this.chips.get(item.key);
      if (chip !== undefined && !chip.leaving && chip.shape !== shape) {
        // The alert changed shape (a timed major escalated to a
        // critical state, or the reverse): rebuild its element.
        chip.root.remove();
        this.chips.delete(item.key);
        chip = undefined;
      }
      if (chip === undefined || chip.leaving) {
        chip = this.buildChip(item);
        this.chips.set(item.key, chip);
      } else {
        chip.item = item;
        chip.root.className = `alert tier-${item.tier}`;
        const text = chip.root.querySelector(".alert-text");
        if (text !== null) text.textContent = item.text;
        this.armBar(chip);
      }
      this.container.appendChild(chip.root);
    }
  }

  private buildChip(item: AlertItem): Chip {
    const root = document.createElement("div");
    root.className = `alert tier-${item.tier} enter`;
    if (item.tier === "critical") root.setAttribute("role", "alert");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "alert-main";
    const icon = document.createElement("canvas");
    icon.className = "alert-icon";
    icon.width = 9;
    icon.height = 9;
    icon.setAttribute("aria-hidden", "true");
    const iconCtx = icon.getContext("2d");
    if (iconCtx !== null) {
      iconCtx.drawImage(spriteCanvas(ICONS[item.category]), 0, 0);
    }
    const text = document.createElement("span");
    text.className = "alert-text";
    text.textContent = item.text;
    main.append(icon, text);
    main.addEventListener("click", () => this.onFocus(item));
    root.appendChild(main);

    let fill: HTMLDivElement | null = null;
    if (item.tier === "critical" && !Number.isFinite(item.spanMs)) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "alert-x";
      x.textContent = "×";
      x.setAttribute("aria-label", "Dismiss alert");
      x.addEventListener("click", () => this.stack.dismiss(item.key));
      root.appendChild(x);
    } else {
      const track = document.createElement("div");
      track.className = "alert-life";
      fill = document.createElement("div");
      fill.className = "alert-life-fill";
      track.appendChild(fill);
      root.appendChild(track);
    }
    // The enter flourish plays once; without it the chip just is.
    window.setTimeout(() => root.classList.remove("enter"), 30);
    const chip: Chip = {
      root,
      fill,
      item,
      leaving: false,
      shape:
        item.tier === "critical" && !Number.isFinite(item.spanMs)
          ? "x"
          : "bar",
      barKey: "",
    };
    this.armBar(chip);
    return chip;
  }
}
