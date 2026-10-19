// Alerts: notifications over the deck, rebuilt on a whitelist.
//
// The old stack tiered EVERYTHING the chronicle spoke (sabotage,
// accusations, grudges, broken trust, injuries, repairs, bonds)
// and let it toast behind rate limits; on a busy seed that was a
// card every few seconds, forever. The reference viewers cannot
// spam by construction: only a short whitelist of dramatic kinds
// may ever become a card, and everything else lives in the feed.
// This module is that construction:
//
// - Eleven kinds may toast, ever: death, inquiry opened, verdict,
//   a sabotage finding confirmed against the truth, relief of the
//   captain carried, a system in its critical band (a state card,
//   held while the condition holds), the ship lost, the crew
//   collapsed, arrival, departure, a radiation storm's landfall.
//   Bonds, snubs, repairs, recoveries, level-ups, gossip, injuries,
//   accusations and the rest are chronicle-only. They are not
//   filtered here; they are never posted. The caller (main.ts)
//   maps events onto these kinds and nothing else.
// - Lifetimes are the squad numbers: 6 s on a phone, 9 s on a
//   desktop, majors included. The stack caps at 2 on a phone,
//   4 on a desktop. Condition cards are the only persistent ones.
// - A continuing situation updates its one card: a verdict takes
//   the place of the inquiry card it concludes, a confirmed
//   sabotage finding takes the verdict's place, and a hurt
//   system's card follows its condition in place.
// - The same kind about the same subject cannot re-toast inside
//   a dedupe window (30 s), even if its card already left.
// - Each kind carries a "pause on" preference (the village
//   pattern), persisted in localStorage; defaults pause only on
//   death, the ship lost, and the crew collapsed. When a card is
//   raised for a pausing kind, the stack says so through onRaise
//   and the viewer stops its clock.
//
// The stack itself is pure state (no DOM), so the headless
// harness can drive it with a fake clock. AlertStackView renders.

import { spriteCanvas, type SpriteDef } from "./props.ts";

export type AlertKind =
  | "death"
  | "inquiry"
  | "verdict"
  | "sabotage"
  | "relief"
  | "system"
  | "ship-lost"
  | "collapse"
  | "arrival"
  | "departure"
  | "storm";

/** Display severity: red edge, or amber. */
export type AlertTier = "critical" | "major";

export interface AlertKindDef {
  kind: AlertKind;
  /** One or two words, for the settings sheet. */
  label: string;
  tier: AlertTier;
  /** Pause the clock when a card of this kind is raised. */
  defaultPause: boolean;
}

export const ALERT_KIND_DEFS: readonly AlertKindDef[] = [
  { kind: "death", label: "Death", tier: "critical", defaultPause: true },
  { kind: "inquiry", label: "Inquiry", tier: "major", defaultPause: false },
  { kind: "verdict", label: "Verdict", tier: "major", defaultPause: false },
  { kind: "sabotage", label: "Sabotage", tier: "critical", defaultPause: false },
  { kind: "relief", label: "Relief", tier: "major", defaultPause: false },
  { kind: "system", label: "Systems", tier: "critical", defaultPause: false },
  { kind: "ship-lost", label: "Ship lost", tier: "critical", defaultPause: true },
  { kind: "collapse", label: "Collapse", tier: "critical", defaultPause: true },
  { kind: "arrival", label: "Arrival", tier: "major", defaultPause: false },
  { kind: "departure", label: "Departure", tier: "major", defaultPause: false },
  { kind: "storm", label: "Storm", tier: "major", defaultPause: false },
];

const KIND_DEF = new Map(ALERT_KIND_DEFS.map((d) => [d.kind, d]));

export type PausePrefs = Record<AlertKind, boolean>;

const PAUSE_STORAGE_KEY = "starship.alertPause";

export function loadPausePrefs(): PausePrefs {
  const prefs = {} as PausePrefs;
  for (const def of ALERT_KIND_DEFS) prefs[def.kind] = def.defaultPause;
  try {
    const raw = window.localStorage.getItem(PAUSE_STORAGE_KEY);
    if (raw !== null) {
      const stored = JSON.parse(raw) as Partial<Record<string, unknown>>;
      for (const def of ALERT_KIND_DEFS) {
        if (typeof stored[def.kind] === "boolean") {
          prefs[def.kind] = stored[def.kind] as boolean;
        }
      }
    }
  } catch {
    // Storage can refuse or hold junk; the defaults stand.
  }
  return prefs;
}

export function savePausePrefs(prefs: PausePrefs): void {
  try {
    window.localStorage.setItem(PAUSE_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The preference is a nicety, not state worth crashing over.
  }
}

/** Where a click takes the viewer: a person, or a room to flash. */
export interface AlertFocus {
  personId?: string;
  room?: number;
  systemId?: string;
}

export interface AlertItem {
  key: string;
  kind: AlertKind;
  tier: AlertTier;
  /** Icon key in the view's sprite table. */
  category: string;
  text: string;
  focus: AlertFocus;
  bornMs: number;
  /** Wall-ms expiry; Infinity while a state holds. */
  expiresMs: number;
  /** Lifetime span for the progress bar; Infinity for states. */
  spanMs: number;
  /** True for the condition-held system card. */
  state: boolean;
}

export interface AlertMomentInput {
  /** Any whitelisted kind except "system" (a state, not a moment). */
  kind: Exclude<AlertKind, "system">;
  /** The person, port, or matter the card is about: the dedupe key. */
  subject: string;
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

const CRITICAL_BELOW = 0.3;
/** The same kind about the same subject stays quiet this long. */
const DEDUPE_MS = 30_000;
/** A kind whose card replaces an earlier card about the subject. */
const REPLACES: Partial<Record<AlertKind, readonly AlertKind[]>> = {
  verdict: ["inquiry"],
  sabotage: ["inquiry", "verdict"],
};

export class AlertStack {
  /** Newest first. */
  private items: AlertItem[] = [];
  /** System ids currently in the critical band. */
  private critical = new Set<string>();
  /** System key -> dismissed in the critical band: stay quiet. */
  private snoozed = new Set<string>();
  /** Dedupe keys ("kind:subject") -> last accepted post, wall-ms. */
  private lastPost = new Map<string, number>();
  private phone = false;
  onChange: (() => void) | null = null;
  /** A card was raised; the viewer pauses if the kind says so. */
  onRaise: ((kind: AlertKind) => void) | null = null;

  setPhoneMode(phone: boolean): void {
    if (this.phone === phone) return;
    this.phone = phone;
    this.trim();
    this.changed();
  }

  private get cap(): number {
    return this.phone ? 2 : 4;
  }

  private get lifetimeMs(): number {
    return this.phone ? 6_000 : 9_000;
  }

  /** Visible alerts, newest first (snoozed states are not here). */
  visible(): AlertItem[] {
    return [...this.items];
  }

  reset(): void {
    this.items = [];
    this.critical.clear();
    this.snoozed.clear();
    this.lastPost.clear();
    this.changed();
  }

  private changed(): void {
    this.onChange?.();
  }

  /**
   * Post a moment: one of the whitelisted kinds, about a subject.
   * A continuing situation updates in place (a verdict replaces
   * its inquiry card); the same kind and subject inside the
   * dedupe window refreshes its card instead of stacking, and
   * stays suppressed if the card was dismissed or expired.
   */
  post(input: AlertMomentInput, nowMs: number): boolean {
    const def = KIND_DEF.get(input.kind);
    if (def === undefined) return false;
    const key = `mom:${input.kind}:${input.subject}`;
    const dedupeKey = `${input.kind}:${input.subject}`;
    const last = this.lastPost.get(dedupeKey);
    const existing = this.items.find((i) => i.key === key);
    if (last !== undefined && nowMs - last < DEDUPE_MS && existing === undefined) {
      return false; // Said already, and gone: the window holds.
    }
    this.lastPost.set(dedupeKey, nowMs);
    // A conclusion takes its opening's place.
    for (const replaced of REPLACES[input.kind] ?? []) {
      const old = this.items.find(
        (i) => i.kind === replaced && i.key.endsWith(`:${input.subject}`),
      );
      if (old !== undefined) {
        this.items = this.items.filter((i) => i !== old);
      }
    }
    const span = this.lifetimeMs;
    if (existing !== undefined) {
      existing.text = input.text;
      existing.focus = input.focus;
      existing.bornMs = nowMs;
      existing.expiresMs = nowMs + span;
      existing.spanMs = span;
      this.items = [existing, ...this.items.filter((i) => i !== existing)];
      this.changed();
      return true;
    }
    const item: AlertItem = {
      key,
      kind: input.kind,
      tier: def.tier,
      category: input.kind,
      text: input.text,
      focus: input.focus,
      bornMs: nowMs,
      expiresMs: nowMs + span,
      spanMs: span,
      state: false,
    };
    if (!this.admit(item)) return false;
    this.onRaise?.(input.kind);
    this.changed();
    return true;
  }

  /**
   * Feed the live condition of every system. Only the critical
   * band holds a card: below 30% or failed. The card follows the
   * condition in place and leaves quietly when the system climbs
   * out; nothing toasts for the merely-failing or the recovered.
   */
  syncSystems(states: readonly SystemState[], nowMs: number): void {
    for (const state of states) {
      this.syncSystem(state, nowMs);
    }
  }

  private syncSystem(state: SystemState, nowMs: number): void {
    const key = `sys:${state.id}`;
    const isCritical = state.failed || state.condition < CRITICAL_BELOW;
    const wasCritical = this.critical.has(state.id);
    if (isCritical) this.critical.add(state.id);
    else this.critical.delete(state.id);

    if (!isCritical) {
      this.snoozed.delete(key);
      const existing = this.items.find((i) => i.key === key);
      if (existing !== undefined) {
        this.items = this.items.filter((i) => i !== existing);
        this.changed();
      }
      return;
    }
    if (this.snoozed.has(key)) return;
    const pct = Math.round(state.condition * 100);
    const text = state.failed
      ? `The ${state.name} in the ${state.roomName} has failed.`
      : `The ${state.name} is at ${pct}% — ${state.roomName}.`;
    const existing = this.items.find((i) => i.key === key);
    if (existing !== undefined) {
      if (existing.text !== text) {
        existing.text = text;
        this.changed();
      }
      return;
    }
    const item: AlertItem = {
      key,
      kind: "system",
      tier: "critical",
      category: "system",
      text,
      focus: { room: state.room, systemId: state.id },
      bornMs: nowMs,
      expiresMs: Number.POSITIVE_INFINITY,
      spanMs: Number.POSITIVE_INFINITY,
      state: true,
    };
    if (this.admit(item)) {
      if (!wasCritical) this.onRaise?.("system");
      this.changed();
    }
  }

  /**
   * Admit a moment under the stack discipline: timed cards make
   * room by displacing the oldest timed card; state cards are
   * never displaced, and a critical kind still gets in over a
   * wall of states (the cap is a discipline, not a blindfold).
   */
  private admit(item: AlertItem): boolean {
    while (this.items.length >= this.cap) {
      const victim = this.oldestWhere((i) => !i.state);
      if (victim === undefined) break;
      this.items = this.items.filter((i) => i !== victim);
    }
    if (this.items.length >= this.cap && item.tier !== "critical") {
      return false;
    }
    this.items.unshift(item);
    return true;
  }

  /** Enforce the cap after a mode change (desktop to phone). */
  private trim(): void {
    while (this.items.length > this.cap) {
      const victim =
        this.oldestWhere((i) => !i.state) ?? this.oldestWhere(() => true);
      if (victim === undefined) break;
      this.items = this.items.filter((i) => i !== victim);
    }
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
   * Dismiss a card. A system state is snoozed until its band
   * changes; a timed card is simply gone (it was a moment), and
   * its dedupe window still holds.
   */
  dismiss(key: string): void {
    const item = this.items.find((i) => i.key === key);
    if (item === undefined) return;
    if (item.state) this.snoozed.add(key);
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

const ICONS: Record<string, SpriteDef> = {
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
  inquiry: {
    rows: [
      "....g....",
      "...ggg...",
      "ggggggggg",
      ".g..g..g.",
      ".g..g..g.",
      "....g....",
      "...ggg...",
      "..ggggg..",
      ".........",
    ],
    pal: { g: "#ffd76a" },
  },
  verdict: {
    rows: [
      "....g....",
      "...ggg...",
      "ggggggggg",
      ".g..g..g.",
      ".g..g..g.",
      "....g....",
      "...ggg...",
      "..ggggg..",
      ".........",
    ],
    pal: { g: "#cfe0f4" },
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
  system: {
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
  "ship-lost": {
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
  collapse: {
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
  arrival: {
    rows: [
      "....g....",
      "....g....",
      ".g..g..g.",
      ".g..g..g.",
      "..g.g.g..",
      "...ggg...",
      "....g....",
      ".ggggggg.",
      ".........",
    ],
    pal: { g: "#7fd4a8" },
  },
  departure: {
    rows: [
      "....g....",
      ".ggggggg.",
      "....g....",
      "...ggg...",
      "..g.g.g..",
      ".g..g..g.",
      ".g..g..g.",
      "....g....",
      "....g....",
    ],
    pal: { g: "#8fa3bf" },
  },
  storm: {
    rows: [
      ".....zz..",
      "....zz...",
      "...zz....",
      "..zzzzz..",
      "....zz...",
      "...zz....",
      "..zz.....",
      ".zz......",
      "zz.......",
    ],
    pal: { z: "#ffd76a" },
  },
};

interface Chip {
  root: HTMLDivElement;
  fill: HTMLDivElement | null;
  item: AlertItem;
  leaving: boolean;
  /** "x" for state cards (dismiss button), "bar" for timed kinds. */
  shape: string;
  /** The born|span the lifetime bar's CSS animation was armed with. */
  barKey: string;
}

/**
 * Renders an AlertStack into the stack container: dark chips with
 * a tier-coloured left bar, a pixel icon, one line of text, and a
 * thin lifetime bar on timed kinds. Chips are reconciled by key,
 * so a state card that changes its text keeps its element. The
 * frame loop drives expiry only: the lifetime bar is a CSS
 * animation armed when a chip is built or its span is refreshed,
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
   * item's born/span pair changes (a refreshed card); a steady
   * chip is never touched again.
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
      const shape = item.state ? "x" : "bar";
      let chip = this.chips.get(item.key);
      if (chip !== undefined && !chip.leaving && chip.shape !== shape) {
        // The card changed shape (a moment became a state, or the
        // reverse): rebuild its element.
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
        chip.root.dataset.kind = item.kind;
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
    root.dataset.kind = item.kind;
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
    const sprite = ICONS[item.category] ?? ICONS.system;
    if (iconCtx !== null && sprite !== undefined) {
      iconCtx.drawImage(spriteCanvas(sprite), 0, 0);
    }
    const text = document.createElement("span");
    text.className = "alert-text";
    text.textContent = item.text;
    main.append(icon, text);
    main.addEventListener("click", () => this.onFocus(item));
    root.appendChild(main);

    let fill: HTMLDivElement | null = null;
    if (item.state) {
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
      shape: item.state ? "x" : "bar",
      barKey: "",
    };
    this.armBar(chip);
    return chip;
  }
}
