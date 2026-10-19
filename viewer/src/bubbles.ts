// Bubbles: thought and speech bubbles over the crew, Sims style.
//
// Every bubble is sourced from real sim state or real events; the
// viewer invents nothing. Thought bubbles (cloud tail) show what is
// on a person's mind, read live from their needs and beliefs: a
// critical need (food, rest, company, low morale), an active grudge,
// a strong suspicion. Speech bubbles (pointed tail) are spoken aloud
// in-fiction: an accusation event puts a "!" over the accuser for a
// few seconds, and crew socializing together in a room occasionally
// get a "...". Icons are tiny string-grid drawings like all the art
// here; no emoji anywhere.
//
// Discipline: at most one bubble per person, speech outranks
// thought, a bubble fades in, holds about three seconds of wall time,
// fades out, and a per-person cooldown keeps the deck from chattering.
// Nothing queues: at high playback speeds a bubble that missed its
// moment is skipped, not stacked.

import type { CrewMember } from "../../src/entities/crew.ts";
import { crewNumber, hash01 } from "./faces.ts";
import { spriteCanvas, type SpriteDef } from "./props.ts";

export type BubbleIcon =
  | "food"
  | "zzz"
  | "people"
  | "rain"
  | "anger"
  | "question"
  | "bang"
  | "aye"
  | "nay"
  | "dots";

const ICONS: Record<BubbleIcon, SpriteDef> = {
  food: {
    rows: [
      "..g....",
      "...s...",
      ".rrrrr.",
      "rrrrrrr",
      "rrrrrrr",
      ".rrrrr.",
      "..rrr..",
    ],
    pal: { g: "#4fae62", s: "#6e5136", r: "#d84a4a" },
  },
  zzz: {
    rows: [
      "zzzzzzz",
      ".....z.",
      "....z..",
      "...z...",
      "..z....",
      ".z.....",
      "zzzzzzz",
    ],
    pal: { z: "#7fb2ff" },
  },
  people: {
    rows: [
      ".s...s.",
      ".s...s.",
      "ttt.ttt",
      "ttt.ttt",
      ".......",
      ".......",
      ".......",
    ],
    pal: { s: "#e8c39a", t: "#5d7ea6" },
  },
  rain: {
    rows: [
      ".ccccc.",
      "ccccccc",
      ".......",
      ".b.b.b.",
      "..b.b..",
      ".b.b.b.",
      ".......",
    ],
    pal: { c: "#8b98ac", b: "#57a8e8" },
  },
  anger: {
    rows: [
      "r..r..r",
      ".r.r.r.",
      "..rrr..",
      "rrrrrrr",
      "..rrr..",
      ".r.r.r.",
      "r..r..r",
    ],
    pal: { r: "#e03c31" },
  },
  question: {
    rows: [
      ".qqqq..",
      "q....q.",
      ".....q.",
      "....q..",
      "...q...",
      ".......",
      "...q...",
    ],
    pal: { q: "#e8a33d" },
  },
  bang: {
    rows: [
      "..rr...",
      "..rr...",
      "..rr...",
      "..rr...",
      ".......",
      ".......",
      "..rr...",
    ],
    pal: { r: "#e03c31" },
  },
  // Council vote tokens: a green tick for a vote for the motion,
  // a red cross against. They rise in seat order when a finding
  // lands (main.ts staggers them); the bubble itself is the token.
  aye: {
    rows: [
      ".......",
      "......g",
      ".....gg",
      "g...gg.",
      "gg.gg..",
      ".ggg...",
      "..g....",
    ],
    pal: { g: "#4fae62" },
  },
  nay: {
    rows: [
      "r.....r",
      ".r...r.",
      "..r.r..",
      "...r...",
      "..r.r..",
      ".r...r.",
      "r.....r",
    ],
    pal: { r: "#e03c31" },
  },
  dots: {
    rows: [
      ".......",
      ".......",
      ".......",
      ".d.d.d.",
      ".......",
      ".......",
      ".......",
    ],
    pal: { d: "#39465c" },
  },
};

const iconCache = new Map<BubbleIcon, HTMLCanvasElement>();
function iconCanvas(icon: BubbleIcon): HTMLCanvasElement {
  const hit = iconCache.get(icon);
  if (hit !== undefined) return hit;
  const canvas = spriteCanvas(ICONS[icon]);
  iconCache.set(icon, canvas);
  return canvas;
}

const LIFE_MS = 3600;
const FADE_IN_MS = 250;
const FADE_OUT_MS = 400;
const NEED_CRITICAL = 0.2;
const SUSPICION_HIGH = 0.6;

interface Active {
  icon: BubbleIcon;
  kind: "thought" | "speech";
  born: number;
  /**
   * A spoken line, pre-rendered to a canvas when the line was
   * set (on its event, never per frame): when present, the
   * bubble is a text bubble sized to the canvas, not an icon.
   */
  textCanvas?: HTMLCanvasElement;
}

const TEXT_FONT = "9px monospace";
const TEXT_MAX_W = 148;
const TEXT_LINE_H = 11;

/**
 * Render a spoken line into a small canvas, once: word-wrapped
 * to the bubble's measure, dark ink on nothing (the bubble body
 * is painted under it at draw time). Returns null when no 2d
 * context is available.
 */
function renderTextBubble(text: string): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.font = TEXT_FONT;
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`;
    if (ctx.measureText(next).width > TEXT_MAX_W && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, lines.length * TEXT_LINE_H);
  ctx.font = TEXT_FONT;
  ctx.fillStyle = "#20242c";
  ctx.textAlign = "left";
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, (i + 1) * TEXT_LINE_H - 3);
  });
  return canvas;
}

/** What is on this person's mind right now, by the bubble priority. */
function desiredBubble(
  member: CrewMember,
  crew: readonly CrewMember[],
): { icon: BubbleIcon; kind: "thought" | "speech" } | null {
  const needs: Array<[number, BubbleIcon]> = [
    [member.needs.hunger, "food"],
    [member.needs.energy, "zzz"],
    [member.needs.social, "people"],
    [member.needs.morale, "rain"],
  ];
  let worst: [number, BubbleIcon] | null = null;
  for (const entry of needs) {
    if (entry[0] < NEED_CRITICAL && (worst === null || entry[0] < worst[0])) {
      worst = entry;
    }
  }
  if (worst !== null) return { icon: worst[1], kind: "thought" };
  if (member.activity === "rest") return { icon: "zzz", kind: "thought" };
  if (member.beliefs.grudges.length > 0) {
    return { icon: "anger", kind: "thought" };
  }
  let suspicion = 0;
  for (const value of Object.values(member.beliefs.suspicion)) {
    if (value > suspicion) suspicion = value;
  }
  if (suspicion > SUSPICION_HIGH) return { icon: "question", kind: "thought" };
  if (member.activity === "socialize") {
    const company = crew.some(
      (other) =>
        other !== member &&
        other.room === member.room &&
        other.activity === "socialize",
    );
    if (company) return { icon: "dots", kind: "speech" };
  }
  return null;
}

export class BubbleLayer {
  private readonly active = new Map<string, Active>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly cycles = new Map<string, number>();
  private readonly pendingSpeech = new Map<string, BubbleIcon>();
  private readonly pendingLines = new Map<string, HTMLCanvasElement>();

  /** An event just made this person speak. Shows at the next update. */
  speech(id: string, icon: BubbleIcon): void {
    this.pendingSpeech.set(id, icon);
  }

  /**
   * An event gave this person actual words: the line is rendered
   * to a canvas here, once, and the draw step only blits it. A
   * line outranks an icon: it is the thing actually being said.
   * Shows at the next update.
   */
  speechLine(id: string, text: string): void {
    const canvas = renderTextBubble(text);
    if (canvas === null) {
      this.pendingSpeech.set(id, "dots");
      return;
    }
    this.pendingLines.set(id, canvas);
  }

  update(now: number, crew: readonly CrewMember[]): void {
    for (const [id, icon] of this.pendingSpeech) {
      this.active.set(id, { icon, kind: "speech", born: now });
    }
    this.pendingSpeech.clear();
    for (const [id, canvas] of this.pendingLines) {
      this.active.set(id, {
        icon: "dots",
        kind: "speech",
        born: now,
        textCanvas: canvas,
      });
    }
    this.pendingLines.clear();
    for (const member of crew) {
      const current = this.active.get(member.id);
      if (current !== undefined) {
        if (now - current.born < LIFE_MS) continue;
        this.active.delete(member.id);
        const cycle = (this.cycles.get(member.id) ?? 0) + 1;
        this.cycles.set(member.id, cycle);
        this.cooldownUntil.set(
          member.id,
          now + 5000 + hash01(crewNumber(member), 71 + cycle) * 7000,
        );
        continue;
      }
      if (now < (this.cooldownUntil.get(member.id) ?? 0)) continue;
      const want = desiredBubble(member, crew);
      if (want !== null) {
        this.active.set(member.id, { ...want, born: now });
      }
    }
  }

  /** positions: render position per member id, canvas pixels (feet). */
  draw(
    ctx: CanvasRenderingContext2D,
    now: number,
    positions: ReadonlyMap<string, { x: number; y: number }>,
    widthPx: number,
  ): void {
    for (const [id, bubble] of this.active) {
      const pos = positions.get(id);
      if (pos === undefined) continue;
      const age = now - bubble.born;
      if (age < 0 || age >= LIFE_MS) continue;
      let alpha = 1;
      if (age < FADE_IN_MS) alpha = age / FADE_IN_MS;
      else if (age > LIFE_MS - FADE_OUT_MS) {
        alpha = (LIFE_MS - age) / FADE_OUT_MS;
      }
      const text = bubble.textCanvas;
      const w = text !== undefined ? text.width + 8 : 13;
      const h = text !== undefined ? text.height + 6 : 11;
      const bx = Math.max(
        1,
        Math.min(widthPx - w - 1, Math.round(pos.x - w / 2)),
      );
      const by = Math.round(pos.y - 14 - h);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = "#f4f6fa";
      ctx.strokeStyle = "#20242c";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx + 0.5, by + 0.5, w - 1, h - 1, 3);
      ctx.fill();
      ctx.stroke();
      // The tail: two shrinking circles for a thought, a point for speech.
      ctx.beginPath();
      if (bubble.kind === "thought") {
        ctx.arc(pos.x - 2, by + h + 1.5, 1.6, 0, Math.PI * 2);
        ctx.arc(pos.x - 3.5, by + h + 4, 1, 0, Math.PI * 2);
      } else {
        ctx.moveTo(pos.x - 2, by + h - 1);
        ctx.lineTo(pos.x + 2, by + h - 1);
        ctx.lineTo(pos.x, by + h + 3);
        ctx.closePath();
      }
      ctx.fill();
      if (text !== undefined) {
        ctx.drawImage(text, bx + 4, by + 3);
      } else {
        ctx.drawImage(iconCanvas(bubble.icon), bx + 3, by + 2);
      }
      ctx.restore();
    }
  }
}
