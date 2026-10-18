// Faces: a crew member's portrait as a pure function of who they are.
//
// Following the reference viewer's pattern, there is no stored
// appearance data and no image asset. Identity (skin, hair, eyes, face
// shape, uniform) is derived from an integer hash of the crew id, one
// salt per feature, so the same person has the same face in every
// viewer and every run. Live state (expression from morale, tired
// eyes, the furrow of an active grudge) is painted over that stable
// identity at draw time, so the portrait doubles as a status display.
// Portraits are painted once onto offscreen canvases and cached per
// person, keyed by id plus a state signature: a face is only repainted
// when the state that shows on it actually changes.

import type { CrewMember } from "../../src/entities/crew.ts";

// ------------------------------------------------------------- hashing

/**
 * Small integer hash to [0, 1). Pure arithmetic on the crew number and
 * a per-feature salt; no state, no RNG stream, so a look can never
 * diverge between viewers or runs.
 */
export function hash01(id: number, salt: number): number {
  let h =
    Math.imul(id + 0x9e37, 0x85ebca6b) ^ Math.imul(salt + 0x27d4, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function pick<T>(id: number, salt: number, table: readonly T[]): T {
  const index = Math.floor(hash01(id, salt) * table.length);
  return table[Math.min(table.length - 1, index)] as T;
}

/** The numeric part of a crew id ("c7" -> 7). Stable within a run. */
export function crewNumber(member: CrewMember): number {
  const digits = member.id.replace(/\D/g, "");
  if (digits !== "") return Number.parseInt(digits, 10);
  let sum = 0;
  for (let i = 0; i < member.id.length; i++) sum += member.id.charCodeAt(i);
  return sum;
}

// ---------------------------------------------------------- departments

export interface Department {
  name: string;
  colour: string;
}

const DEPARTMENTS: Record<string, Department> = {
  captain: { name: "Command", colour: "#d9a441" },
  "executive officer": { name: "Command", colour: "#d9a441" },
  "chief engineer": { name: "Engineering", colour: "#e07b39" },
  engineer: { name: "Engineering", colour: "#e07b39" },
  medic: { name: "Medical", colour: "#e8edf2" },
  scientist: { name: "Science", colour: "#4a7fd4" },
  botanist: { name: "Science", colour: "#4a7fd4" },
  pilot: { name: "Operations", colour: "#c44b4b" },
  navigator: { name: "Operations", colour: "#c44b4b" },
  "security officer": { name: "Operations", colour: "#c44b4b" },
  cook: { name: "Services", colour: "#4fae62" },
  quartermaster: { name: "Services", colour: "#4fae62" },
};

export function departmentOf(roleKey: string): Department {
  return DEPARTMENTS[roleKey] ?? { name: "Crew", colour: "#8fa3bf" };
}

// ------------------------------------------------------------ identity

const SKINS = [
  { tone: "#f6d3ae", word: "very fair" },
  { tone: "#eec39b", word: "fair" },
  { tone: "#e3ac7c", word: "light tan" },
  { tone: "#cf9264", word: "olive" },
  { tone: "#b57a4e", word: "tan" },
  { tone: "#8a5a33", word: "deep brown" },
  { tone: "#5f3a20", word: "dark brown" },
] as const;

const HAIR_COLOURS = [
  { tone: "#201a17", word: "near-black" },
  { tone: "#3a2417", word: "dark brown" },
  { tone: "#6b4423", word: "chestnut" },
  { tone: "#a9743f", word: "light brown" },
  { tone: "#cfa14e", word: "dark blond" },
  { tone: "#e6cf8a", word: "blond" },
  { tone: "#b5502a", word: "auburn" },
  { tone: "#c9ccd1", word: "silver" },
] as const;

const HAIR_STYLES = [
  { key: "short", word: "a short crop" },
  { key: "long", word: "long hair" },
  { key: "bun", word: "a neat bun" },
  { key: "shaved", word: "a shaved head" },
  { key: "wavy", word: "wavy hair" },
  { key: "swept", word: "swept-back hair" },
] as const;

const EYE_COLOURS = [
  { tone: "#4a3220", word: "brown" },
  { tone: "#7a5a28", word: "hazel" },
  { tone: "#3f7a44", word: "green" },
  { tone: "#3a6ea8", word: "blue" },
  { tone: "#7d8894", word: "grey" },
  { tone: "#a8722a", word: "amber" },
] as const;

const FACE_SHAPES = ["oval", "square", "round"] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

const HEIGHT_WORDS = [
  "short",
  "of middling height",
  "tall",
  "very tall",
] as const;

const BUILD_WORDS = [
  "a slight build",
  "a lean build",
  "a sturdy build",
  "a broad build",
] as const;

// One salt per feature, so features vary independently.
const SALT = {
  skin: 5,
  hairColour: 11,
  hairStyle: 17,
  eyeColour: 23,
  faceShape: 29,
  facialHair: 31,
  mark: 37,
  height: 41,
  build: 43,
  pupil: 47,
  markSide: 53,
} as const;

export interface FaceDescriptor {
  skinTone: string;
  skinWord: string;
  hairTone: string;
  hairWord: string;
  hairStyle: string;
  hairStyleWord: string;
  eyeTone: string;
  eyeWord: string;
  faceShape: FaceShape;
  facialHair: "none" | "stubble" | "beard";
  mark: "none" | "mole" | "freckles";
  markSide: "left" | "right";
  heightWord: string;
  buildWord: string;
  /** -1: pupils sit toward the nose-left; 1: toward the right. */
  pupilSide: -1 | 1;
  department: Department;
}

/** Everything about a person's look that never changes. */
export function appearanceOf(member: CrewMember): FaceDescriptor {
  const id = crewNumber(member);
  const skin = pick(id, SALT.skin, SKINS);
  const hair = pick(id, SALT.hairColour, HAIR_COLOURS);
  const style = pick(id, SALT.hairStyle, HAIR_STYLES);
  const eyes = pick(id, SALT.eyeColour, EYE_COLOURS);
  const hairRoll = hash01(id, SALT.facialHair);
  const markRoll = hash01(id, SALT.mark);
  return {
    skinTone: skin.tone,
    skinWord: skin.word,
    hairTone: hair.tone,
    hairWord: hair.word,
    hairStyle: style.key,
    hairStyleWord: style.word,
    eyeTone: eyes.tone,
    eyeWord: eyes.word,
    faceShape: pick(id, SALT.faceShape, FACE_SHAPES),
    facialHair: hairRoll < 0.22 ? "beard" : hairRoll < 0.45 ? "stubble" : "none",
    mark: markRoll < 0.26 ? "mole" : markRoll < 0.48 ? "freckles" : "none",
    markSide: hash01(id, SALT.markSide) < 0.5 ? "left" : "right",
    heightWord: pick(id, SALT.height, HEIGHT_WORDS),
    buildWord: pick(id, SALT.build, BUILD_WORDS),
    pupilSide: hash01(id, SALT.pupil) < 0.5 ? -1 : 1,
    department: departmentOf(member.roleKey),
  };
}

// --------------------------------------------------------------- state

export type Expression = "content" | "neutral" | "unhappy" | "miserable";

/**
 * The part of a person that shows on their face right now. Computed
 * fresh from live sim state at draw time; never stored.
 */
export interface FaceState {
  expression: Expression;
  /** Energy low enough to bag the eyes. */
  tired: boolean;
  /** Holding at least one active grudge: the furrowed brow. */
  stressed: boolean;
}

export function faceStateOf(member: CrewMember): FaceState {
  const morale = member.needs.morale;
  return {
    expression:
      morale >= 0.62
        ? "content"
        : morale >= 0.45
          ? "neutral"
          : morale >= 0.3
            ? "unhappy"
            : "miserable",
    tired: member.needs.energy < 0.25,
    stressed: member.beliefs.grudges.length > 0,
  };
}

/** Cache key fragment: a face is repainted only when this changes. */
export function stateSignature(state: FaceState): string {
  return `${state.expression}|${state.tired ? 1 : 0}|${state.stressed ? 1 : 0}`;
}

// ------------------------------------------------------------- painting

const SIZE = 16; // logical pixels across
const SCALE = 4; // canvas pixels per logical pixel

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

/** Blend colour a toward colour b by t in [0, 1]. */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** shade(hex, 0.8) darkens; shade(hex, 1.25) lightens. */
function shade(hex: string, factor: number): string {
  return factor <= 1
    ? mix(hex, "#000000", 1 - factor)
    : mix(hex, "#ffffff", Math.min(1, factor - 1));
}

/** A tiny pixel pen over a 2D context, in logical 16x16 coordinates. */
class Pix {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  px(x: number, y: number, colour: string): void {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    this.ctx.fillStyle = colour;
    this.ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
  }

  row(y: number, x0: number, x1: number, colour: string): void {
    for (let x = x0; x <= x1; x++) this.px(x, y, colour);
  }
}

/** Left and right head columns for a row of the head (rows 2 to 11). */
function headCols(row: number, shape: FaceShape): [number, number] {
  switch (shape) {
    case "square":
      if (row <= 2 || row >= 11) return [4, 11];
      return [3, 12];
    case "round":
      if (row <= 2) return [5, 10];
      if (row === 10) return [5, 10];
      if (row >= 11) return [6, 9];
      return [4, 11];
    default: // oval
      if (row <= 2 || row >= 11) return [5, 10];
      return [4, 11];
  }
}

const EYE_LEFT = [5, 6] as const;
const EYE_RIGHT = [9, 10] as const;
const EYE_ROW = 7;
const BROW_ROW = 6;
const MOUTH_ROW = 10;

/** Paint everything about a person that never changes. */
function paintIdentity(g: Pix, d: FaceDescriptor, seed: number): void {
  const skin = d.skinTone;
  const hair = d.hairTone;
  const dept = d.department.colour;

  // Uniform: shoulders and torso in the department colour, with a
  // darker collar and front, and one lighter insignia pixel.
  g.row(12, 0, 6, dept);
  g.row(12, 9, 15, dept);
  g.px(6, 12, shade(dept, 0.7));
  g.px(9, 12, shade(dept, 0.7));
  for (const y of [13, 14, 15]) g.row(y, 0, 15, dept);
  for (const y of [13, 14, 15]) g.px(7, y, shade(dept, 0.75));
  g.px(3, 13, shade(dept, 1.35));

  // Neck.
  g.px(7, 12, shade(skin, 0.88));
  g.px(8, 12, shade(skin, 0.88));

  // Head.
  for (let row = 2; row <= 11; row++) {
    const [l, r] = headCols(row, d.faceShape);
    g.row(row, l, r, skin);
  }
  const [el, er] = headCols(EYE_ROW, d.faceShape);
  g.px(el - 1, EYE_ROW, skin);
  g.px(er + 1, EYE_ROW, skin);
  // A little jaw shading so the chin reads.
  const [jl, jr] = headCols(11, d.faceShape);
  g.px(jl, 11, shade(skin, 0.92));
  g.px(jr, 11, shade(skin, 0.92));

  // Facial hair under the features: beard or stubble around the mouth.
  if (d.facialHair !== "none") {
    const tone =
      d.facialHair === "beard" ? hair : mix(skin, hair, 0.35);
    const [ml, mr] = headCols(MOUTH_ROW, d.faceShape);
    g.px(ml, MOUTH_ROW, tone);
    g.px(ml + 1, MOUTH_ROW, tone);
    g.px(mr - 1, MOUTH_ROW, tone);
    g.px(mr, MOUTH_ROW, tone);
    const [cl, cr] = headCols(11, d.faceShape);
    g.row(11, cl, cr, tone);
  }

  // Hair, by style.
  const cap = (rows: number[]): void => {
    for (const row of rows) {
      const [l, r] = headCols(row, d.faceShape);
      g.row(row, l, r, hair);
    }
  };
  switch (d.hairStyle) {
    case "shaved":
      for (let x = headCols(2, d.faceShape)[0]; x <= headCols(2, d.faceShape)[1]; x++) {
        g.px(x, 2, mix(skin, hair, 0.5));
      }
      break;
    case "long": {
      cap([2, 3]);
      for (let row = 4; row <= 11; row++) {
        const [l, r] = headCols(row, d.faceShape);
        g.px(l, row, hair);
        g.px(r, row, hair);
      }
      for (const x of [3, 4, 11, 12]) g.px(x, 12, hair);
      break;
    }
    case "bun":
      cap([2, 3]);
      g.px(7, 0, hair);
      g.px(8, 0, hair);
      g.px(7, 1, hair);
      g.px(8, 1, hair);
      break;
    case "wavy": {
      cap([2, 3]);
      const [l, r] = headCols(4, d.faceShape);
      for (let x = l; x <= r; x++) {
        if ((x + seed) % 3 === 0) g.px(x, 4, hair);
      }
      break;
    }
    case "swept": {
      cap([2, 3]);
      const [l, r] = headCols(4, d.faceShape);
      if (d.pupilSide > 0) {
        for (let x = 8; x <= r; x++) g.px(x, 4, hair);
      } else {
        for (let x = l; x <= 7; x++) g.px(x, 4, hair);
      }
      break;
    }
    default: // short
      cap([2, 3]);
      g.px(headCols(4, d.faceShape)[0], 4, hair);
      g.px(headCols(4, d.faceShape)[1], 4, hair);
      break;
  }

  // Brows.
  for (const span of [EYE_LEFT, EYE_RIGHT]) {
    g.px(span[0], BROW_ROW, hair);
    g.px(span[1], BROW_ROW, hair);
  }

  // Eyes: iris and pupil, the pupil offset by the person's hash so no
  // two gazes sit quite alike.
  for (const span of [EYE_LEFT, EYE_RIGHT]) {
    const irisAt = d.pupilSide > 0 ? span[0] : span[1];
    const pupilAt = d.pupilSide > 0 ? span[1] : span[0];
    g.px(irisAt, EYE_ROW, d.eyeTone);
    g.px(pupilAt, EYE_ROW, "#1c1712");
  }

  // Nose.
  g.px(7, 8, shade(skin, 0.8));
  g.px(7, 9, shade(skin, 0.86));

  // Distinguishing mark.
  if (d.mark === "mole") {
    const [l, r] = headCols(9, d.faceShape);
    g.px(d.markSide === "left" ? l + 1 : r - 1, 9, "#3a2415");
  } else if (d.mark === "freckles") {
    const tone = shade(skin, 0.78);
    for (const x of [5, 7, 9]) g.px(x, 8, tone);
    g.px(6, 9, tone);
    g.px(8, 9, tone);
  }
}

/** The mouth, by expression. Drawn over any facial hair. */
function paintMouth(g: Pix, expression: Expression): void {
  const tone = "#71363a";
  switch (expression) {
    case "content":
      g.px(6, 9, tone);
      g.px(9, 9, tone);
      g.px(7, MOUTH_ROW, tone);
      g.px(8, MOUTH_ROW, tone);
      break;
    case "neutral":
      g.px(7, MOUTH_ROW, tone);
      g.px(8, MOUTH_ROW, tone);
      break;
    case "unhappy":
      g.px(7, 9, tone);
      g.px(8, 9, tone);
      g.px(6, MOUTH_ROW, tone);
      g.px(9, MOUTH_ROW, tone);
      break;
    case "miserable":
      g.px(7, 9, tone);
      g.px(8, 9, tone);
      g.px(5, MOUTH_ROW, tone);
      g.px(6, MOUTH_ROW, tone);
      g.px(9, MOUTH_ROW, tone);
      g.px(10, MOUTH_ROW, tone);
      g.px(7, MOUTH_ROW, "#4a2327");
      g.px(8, MOUTH_ROW, "#4a2327");
      break;
  }
}

/**
 * Paint live state over the stable identity. This is the overlay hook:
 * expression comes first, then fatigue, then stress. Future overlays
 * (a bandage or scar from an injury list, a grey cast for the dead)
 * belong here, reading the same live state, never the identity layer.
 */
function overlayState(g: Pix, d: FaceDescriptor, state: FaceState): void {
  paintMouth(g, state.expression);

  if (state.tired) {
    // Half-lidded eyes: dim the iris; bags underneath.
    for (const span of [EYE_LEFT, EYE_RIGHT]) {
      const irisAt = d.pupilSide > 0 ? span[0] : span[1];
      g.px(irisAt, EYE_ROW, shade(d.eyeTone, 0.55));
      g.px(span[0], 8, shade(d.skinTone, 0.82));
      g.px(span[1], 8, shade(d.skinTone, 0.82));
    }
  }

  if (state.stressed) {
    // Furrowed brow: outer brow ends lift, a crease opens between them.
    for (const span of [EYE_LEFT, EYE_RIGHT]) {
      const outer = span === EYE_LEFT ? span[0] : span[1];
      g.px(outer, BROW_ROW - 1, d.hairTone);
      g.px(outer, BROW_ROW, d.skinTone);
    }
    g.px(7, BROW_ROW - 1, shade(d.skinTone, 0.85));
    g.px(7, BROW_ROW, shade(d.skinTone, 0.85));
  }
}

function paintPortrait(d: FaceDescriptor, state: FaceState, seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE * SCALE;
  canvas.height = SIZE * SCALE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  const g = new Pix(ctx);
  paintIdentity(g, d, seed);
  overlayState(g, d, state);
  return canvas;
}

/** The head crop of the portrait, for map markers: rows 0-11, cols 2-13. */
function paintMini(portrait: HTMLCanvasElement): HTMLCanvasElement {
  const mini = document.createElement("canvas");
  mini.width = 48;
  mini.height = 48;
  const ctx = mini.getContext("2d");
  if (ctx === null) return mini;
  ctx.fillStyle = "#182233";
  ctx.beginPath();
  ctx.roundRect(0, 0, 48, 48, 10);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, 48, 48, 10);
  ctx.clip();
  // Source rect: logical cols 2..13, rows 0..11, at SCALE px per pixel.
  ctx.drawImage(portrait, 2 * SCALE, 0, 12 * SCALE, 12 * SCALE, 0, 0, 48, 48);
  ctx.restore();
  return mini;
}

// --------------------------------------------------------------- cache

export interface CachedFace {
  signature: string;
  portrait: HTMLCanvasElement;
  mini: HTMLCanvasElement;
  miniUrl: string;
}

const faceCache = new Map<string, CachedFace>();

/**
 * The person's face for their current state, painted at most once per
 * state signature. Returns the full portrait canvas (64x64 backing),
 * the head-crop mini canvas, and the mini as a data URL for SVG use.
 */
export function getFace(
  member: CrewMember,
  state: FaceState = faceStateOf(member),
): CachedFace {
  const signature = stateSignature(state);
  const cached = faceCache.get(member.id);
  if (cached !== undefined && cached.signature === signature) return cached;
  const descriptor = appearanceOf(member);
  const portrait = paintPortrait(descriptor, state, crewNumber(member));
  const mini = paintMini(portrait);
  const entry: CachedFace = {
    signature,
    portrait,
    mini,
    miniUrl: mini.toDataURL(),
  };
  faceCache.set(member.id, entry);
  return entry;
}

/** The full portrait canvas for the person panels (64x64 backing). */
export function getPortraitCanvas(
  member: CrewMember,
  state: FaceState = faceStateOf(member),
): HTMLCanvasElement {
  return getFace(member, state).portrait;
}

/** The head-crop mini canvas used for map markers. */
export function getMiniCanvas(
  member: CrewMember,
  state: FaceState = faceStateOf(member),
): HTMLCanvasElement {
  return getFace(member, state).mini;
}
