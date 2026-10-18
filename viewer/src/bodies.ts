// Bodies: the crew as little top-down figures in the string-grid
// tradition, about 8x12, one character per pixel.
//
// A body is painted once per person from the same hash-derived look
// the portrait uses (appearanceOf in faces.ts): the head carries the
// person's own skin and hair, the torso is their department colour,
// so a figure on the deck matches the face in the panel at a glance.
// Three frames: idle (legs together), walk (legs apart), and work
// (one arm raised, tool in hand). Facing is a horizontal mirror at
// draw time; the deck owns position, sway, and bob. No image assets,
// no stored appearance data, same rule as the faces.

import type { CrewMember } from "../../src/entities/crew.ts";
import { appearanceOf, crewNumber, hash01, type FaceDescriptor } from "./faces.ts";

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

function shade(hex: string, factor: number): string {
  return factor <= 1
    ? mix(hex, "#000000", 1 - factor)
    : mix(hex, "#ffffff", Math.min(1, factor - 1));
}

const PANTS = ["#2e3a4e", "#3a3f4a", "#4a3b2c", "#2c3434"] as const;

const IDLE_ROWS = [
  ".HHHHHH.",
  "HSSSSSSH",
  "HSESSESH",
  ".SSSSSS.",
  ".TTTTTT.",
  "ATTTTTTA",
  "ATTTTTTA",
  "hTTTTTTh",
  "...PP...",
  "...PP...",
  "...PP...",
  "...BB...",
] as const;

const WALK_ROWS = [
  ".HHHHHH.",
  "HSSSSSSH",
  "HSESSESH",
  ".SSSSSS.",
  ".TTTTTT.",
  "ATTTTTTA",
  "ATTTTTTA",
  "hTTTTTTh",
  "..P..P..",
  "..P..P..",
  "..P..P..",
  "..B..B..",
] as const;

const WORK_ROWS = [
  ".HHHHHH.",
  "HSSSSSSH",
  "HSESSESW",
  ".SSSSSSA",
  ".TTTTTTh",
  "ATTTTTTT",
  "ATTTTTTA",
  "hTTTTTTh",
  "...PP...",
  "...PP...",
  "...PP...",
  "...BB...",
] as const;

// Seated: the same figure one row lower (the head starts at row 1),
// legs folded under the torso into a wide base: at a meal table, over
// a game board, or in a chair with a book. The deck decides who sits;
// the dictionary only knows the shape.
const SEATED_ROWS = [
  "........",
  ".HHHHHH.",
  "HSSSSSSH",
  "HSESSESH",
  ".SSSSSS.",
  ".TTTTTT.",
  "ATTTTTTA",
  "hTTTTTTh",
  ".TTTTTT.",
  ".PPPPPP.",
  "PPPPPPPP",
  ".BB..BB.",
] as const;

export interface BodySprites {
  idle: HTMLCanvasElement;
  walk: HTMLCanvasElement;
  work: HTMLCanvasElement;
  seated: HTMLCanvasElement;
}

/** Multiply a hex colour's channels by a factor (a paint-time tint). */
function dimColour(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * factor, g * factor, b * factor);
}

function paintBody(
  rows: readonly string[],
  look: FaceDescriptor,
  pants: string,
  dim = 1,
  headDy = 0,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 12;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  const dept = look.department.colour;
  const pal: Record<string, string> = {
    H: look.hairTone,
    S: look.skinTone,
    E: "#1c1712",
    T: dept,
    A: shade(dept, 0.72),
    h: shade(look.skinTone, 0.9),
    P: pants,
    B: "#22262c",
    W: "#c8d4e4",
  };
  const set = (x: number, y: number, colour: string): void => {
    // Every paint goes through here, so the night dim is applied
    // once, at paint time, to the whole figure (the pre-tinted
    // variant the deck draws instead of filtering the live canvas).
    ctx.fillStyle = dim < 1 ? dimColour(colour, dim) : colour;
    ctx.fillRect(x, y, 1, 1);
  };
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row.charAt(x);
      if (ch === ".") continue;
      const colour = pal[ch];
      if (colour !== undefined) set(x, y, colour);
    }
  });

  // Hair style, over the shared cap. The overlays sit on the head's
  // rows, so a posture whose head rides lower (seated) passes its
  // offset and every mark follows the head.
  if (look.hairStyle === "shaved") {
    const tint = mix(look.skinTone, look.hairTone, 0.45);
    for (let x = 1; x <= 6; x++) set(x, headDy, tint);
    set(0, headDy + 1, tint);
    set(7, headDy + 1, tint);
  } else if (look.hairStyle === "long") {
    for (let y = headDy + 2; y <= headDy + 6; y++) {
      set(0, y, look.hairTone);
      set(7, y, look.hairTone);
    }
  } else if (look.hairStyle === "bun") {
    set(3, headDy, shade(look.hairTone, 0.7));
    set(4, headDy, shade(look.hairTone, 0.7));
  } else if (look.hairStyle === "wavy") {
    set(1, headDy + 2, look.hairTone);
    set(6, headDy + 2, look.hairTone);
  } else if (look.hairStyle === "swept") {
    if (look.pupilSide > 0) {
      set(5, headDy + 1, look.hairTone);
      set(6, headDy + 1, look.hairTone);
    } else {
      set(1, headDy + 1, look.hairTone);
      set(2, headDy + 1, look.hairTone);
    }
  }

  // Facial hair sits on the jaw row.
  if (look.facialHair === "beard") {
    for (const x of [1, 2, 5, 6]) set(x, headDy + 3, look.hairTone);
  } else if (look.facialHair === "stubble") {
    const tone = mix(look.skinTone, look.hairTone, 0.35);
    for (const x of [1, 2, 5, 6]) set(x, headDy + 3, tone);
  }
  return canvas;
}

const bodyCache = new Map<string, BodySprites>();

/**
 * The person's body frames, painted at most once per run role per
 * dim bucket. The dim bucket (1 by day, lower at night, in 0.05
 * steps from the deck) keys pre-tinted variants, so a night body
 * costs the same single drawImage as a day body and no per-frame
 * canvas filter is ever paid for the crew pass. Every posture the
 * deck can ask for lives in the one record, keyed like the rest.
 */
export function getBodySprites(member: CrewMember, dim = 1): BodySprites {
  const key =
    dim < 1
      ? `${member.id}|${member.roleKey}|dim${dim.toFixed(2)}`
      : `${member.id}|${member.roleKey}`;
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  const look = appearanceOf(member);
  const pants =
    PANTS[Math.floor(hash01(crewNumber(member), 61) * PANTS.length)] ??
    PANTS[0];
  const sprites: BodySprites = {
    idle: paintBody(IDLE_ROWS, look, pants, dim),
    walk: paintBody(WALK_ROWS, look, pants, dim),
    work: paintBody(WORK_ROWS, look, pants, dim),
    seated: paintBody(SEATED_ROWS, look, pants, dim, 1),
  };
  bodyCache.set(key, sprites);
  return sprites;
}
