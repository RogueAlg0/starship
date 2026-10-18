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

export interface BodySprites {
  idle: HTMLCanvasElement;
  walk: HTMLCanvasElement;
  work: HTMLCanvasElement;
}

function paintBody(
  rows: readonly string[],
  look: FaceDescriptor,
  pants: string,
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
    ctx.fillStyle = colour;
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

  // Hair style, over the shared cap.
  if (look.hairStyle === "shaved") {
    const tint = mix(look.skinTone, look.hairTone, 0.45);
    for (let x = 1; x <= 6; x++) set(x, 0, tint);
    set(0, 1, tint);
    set(7, 1, tint);
  } else if (look.hairStyle === "long") {
    for (let y = 2; y <= 6; y++) {
      set(0, y, look.hairTone);
      set(7, y, look.hairTone);
    }
  } else if (look.hairStyle === "bun") {
    set(3, 0, shade(look.hairTone, 0.7));
    set(4, 0, shade(look.hairTone, 0.7));
  } else if (look.hairStyle === "wavy") {
    set(1, 2, look.hairTone);
    set(6, 2, look.hairTone);
  } else if (look.hairStyle === "swept") {
    if (look.pupilSide > 0) {
      set(5, 1, look.hairTone);
      set(6, 1, look.hairTone);
    } else {
      set(1, 1, look.hairTone);
      set(2, 1, look.hairTone);
    }
  }

  // Facial hair sits on the jaw row.
  if (look.facialHair === "beard") {
    for (const x of [1, 2, 5, 6]) set(x, 3, look.hairTone);
  } else if (look.facialHair === "stubble") {
    const tone = mix(look.skinTone, look.hairTone, 0.35);
    for (const x of [1, 2, 5, 6]) set(x, 3, tone);
  }
  return canvas;
}

const bodyCache = new Map<string, BodySprites>();

/** The person's three body frames, painted at most once per run role. */
export function getBodySprites(member: CrewMember): BodySprites {
  const key = `${member.id}|${member.roleKey}`;
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  const look = appearanceOf(member);
  const pants =
    PANTS[Math.floor(hash01(crewNumber(member), 61) * PANTS.length)] ??
    PANTS[0];
  const sprites: BodySprites = {
    idle: paintBody(IDLE_ROWS, look, pants),
    walk: paintBody(WALK_ROWS, look, pants),
    work: paintBody(WORK_ROWS, look, pants),
  };
  bodyCache.set(key, sprites);
  return sprites;
}
