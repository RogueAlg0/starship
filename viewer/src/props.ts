// Props: the ship's furniture and equipment as string-grid pixel art.
//
// Same tradition as the faces: no image assets, everything painted in
// code from small character grids with a palette, once, into canvases
// that the deck's static layer blits where the layout puts them. One
// character is one pixel. A "." is transparent. Props are drawn at the
// deck's tile scale: a sprite pixel is one canvas pixel, and a tile is
// TILE_PX canvas pixels, so a 6x4 console sits inside a room tile grid
// as furniture against a wall, not as a full tile of machinery.
//
// Floors are painted per tile by floorTile(): a base treatment per room
// kind (grating, pale tile, soil, checker, carpet, concrete) with a
// hash-driven per-tile variation, so no two tiles are quite alike and
// no run can shuffle them: the hash key is the ship seed and the tile's
// own coordinates.

import { hash01 } from "./faces.ts";

export interface SpriteDef {
  rows: readonly string[];
  pal: Record<string, string>;
}

export function spriteCanvas(def: SpriteDef): HTMLCanvasElement {
  const h = def.rows.length;
  const w = Math.max(...def.rows.map((r) => r.length));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row.charAt(x);
      if (ch === "." || ch === " ") continue;
      const colour = def.pal[ch];
      if (colour === undefined) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return canvas;
}

const cache = new Map<string, HTMLCanvasElement>();
export function propCanvas(name: string): HTMLCanvasElement {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const def = PROPS[name];
  if (def === undefined) throw new Error(`props: no sprite named ${name}`);
  const canvas = spriteCanvas(def);
  cache.set(name, canvas);
  return canvas;
}

/** Pixel width and height of a named sprite. */
export function propSize(name: string): { w: number; h: number } {
  const def = PROPS[name];
  if (def === undefined) throw new Error(`props: no sprite named ${name}`);
  return {
    w: Math.max(...def.rows.map((r) => r.length)),
    h: def.rows.length,
  };
}

const METAL = "#39465c";
const METAL_D = "#232c3d";
const METAL_L = "#55678a";

// ------------------------------------------------------------- sprites

export const PROPS: Record<string, SpriteDef> = {
  // A work console: dark desk, teal screen with a bright trace line.
  console: {
    rows: [
      "mmmmmm",
      "mTTTTm",
      "mTttTm",
      "mmmmmm",
      "m.kk.m",
      "bbbbbb",
    ],
    pal: {
      m: METAL,
      T: "#0d3b3a",
      t: "#2ec4b6",
      k: "#e8a33d",
      b: METAL_D,
    },
  },
  // Comms console: screen plus a little dish glyph on top.
  comms: {
    rows: [
      "...d..",
      "..d.d.",
      "mmmmmm",
      "mBBBBm",
      "mBbbBm",
      "mmmmmm",
      "bbbbbb",
    ],
    pal: {
      d: "#9fb4cc",
      m: METAL,
      B: "#10304f",
      b: "#57a8e8",
    },
  },
  // The bridge main screen frame. The interior is drawn dark here; the
  // deck's dynamic layer paints the radar sweep inside it.
  mainscreen: {
    rows: [
      "mmmmmmmm",
      "m......m",
      "m......m",
      "m......m",
      "mmmmmmmm",
    ],
    pal: { m: METAL_L },
  },
  // Captain's chair: high back, armrests.
  chair: {
    rows: [
      ".cc.",
      "cccc",
      "cccc",
      ".cc.",
      "s..s",
    ],
    pal: { c: "#7a3b3b", s: METAL_D },
  },
  // Reactor core housing: a vertical cylinder; the bright core column
  // (cols 1-2) is left dark in the static layer and lit dynamically.
  reactor: {
    rows: [
      ".mmmm.",
      "mMMMMm",
      "mM..Mm",
      "mM..Mm",
      "mM..Mm",
      "mM..Mm",
      "mMMMMm",
      ".mmmm.",
    ],
    pal: { m: METAL_D, M: METAL },
  },
  // A machine block: vents, a gauge, a status jewel (lit dynamically).
  machine: {
    rows: [
      "mmmmmm",
      "mvvvvm",
      "mvGv.m",
      "mmmmmm",
      "bbbbbb",
    ],
    pal: { m: METAL, v: METAL_D, G: "#c8d4e4", b: "#161d29" },
  },
  // A standing tank: life support, water, lab gas.
  tank: {
    rows: [
      ".tt.",
      "tTTt",
      "tTTt",
      "tTTt",
      "tTTt",
      ".tt.",
    ],
    pal: { t: "#6d7f96", T: "#93a7c2" },
  },
  // Medbay bed: frame, white sheet, red cross on the pillow end.
  bed: {
    rows: [
      "fwwf",
      "fwwf",
      "frrf",
      "fwwf",
      "fwwf",
      "ffff",
    ],
    pal: { f: "#5a6a82", w: "#e8edf2", r: "#d84a4a" },
  },
  // A wall cabinet: doors and handles.
  cabinet: {
    rows: [
      "cccccc",
      "c.kk.c",
      "cccccc",
    ],
    pal: { c: "#7d8ea8", k: METAL_D },
  },
  // A monitor post: screen on a stand.
  monitor: {
    rows: [
      "mmmm",
      "mGGm",
      "mmmm",
      ".m..",
      ".m..",
    ],
    pal: { m: METAL, G: "#8fe388" },
  },
  // Mess table with place settings and a warm centrepiece.
  table: {
    rows: [
      "tttttt",
      "tpttpt",
      "ttlltt",
      "tttttt",
      ".t..t.",
    ],
    pal: { t: "#6e5136", p: "#cfd8e6", l: "#e8a33d" },
  },
  // A small chair, seen from above-ish: seat and back.
  stool: {
    rows: ["ss", "SS"],
    pal: { s: "#54432c", S: "#77603e" },
  },
  // Serving counter: steel top, warm lamps (lit dynamically too).
  counter: {
    rows: [
      "ssssssss",
      "slllllls",
      "ssssssss",
      "bbbbbbbb",
    ],
    pal: { s: "#8b98ac", l: "#e8c98a", b: METAL_D },
  },
  // Bunk bed: two levels, pillow at the head, a folded blanket
  // stripe across each level so the levels read apart at deck scale.
  bunk: {
    rows: [
      "fppf",
      "fbbf",
      "fBBf",
      "fppf",
      "fbbf",
      "ffff",
    ],
    pal: { f: "#46536b", p: "#e6ebf2", b: "#5d7ea6", B: "#48698d" },
  },
  // A locker: tall door, vent slits.
  locker: {
    rows: ["ll", "ll", "l.", "ll", "ll", "ll"],
    pal: { l: "#66788f" },
  },
  // Hydroponics rack: frame, soil, crop rows in two greens.
  rack: {
    rows: [
      "fffffff",
      "fgggggf",
      "fgsgsgf",
      "fffffff",
    ],
    pal: { f: "#4c4237", g: "#3f9e4d", s: "#79c94f" },
  },
  // A cargo crate: planks, corner braces and a stencil band.
  crate: {
    rows: [
      "kcck",
      "cccc",
      "ckkc",
      "kcck",
    ],
    pal: { c: "#8a6b3f", k: "#5f4825" },
  },
  // A barrel.
  barrel: {
    rows: [".bb.", "bBBb", "bBBb", ".bb."],
    pal: { b: "#5d7186", B: "#7690ab" },
  },
  // Lab bench: pale top, bottles.
  bench: {
    rows: [
      "bbbbbbbb",
      "b.g.g..b",
      "bbbbbbbb",
      "d......d",
    ],
    pal: { b: "#9aa7ba", g: "#7fd4c1", d: METAL_D },
  },
  // Gym mat: a floor decal (walkable, drawn underfoot).
  mat: {
    rows: ["mmmm", "mmmm", "mmmm", "mmmm"],
    pal: { m: "#31435f" },
  },
  // Weight rack: bar and plates.
  weights: {
    rows: [
      "p....p",
      "prrrp.",
      "p....p",
    ],
    pal: { p: "#202733", r: "#8b98ac" },
  },
  // Suit hook row for the airlock: two suit silhouettes.
  suits: {
    rows: [
      "s..s",
      "ssss",
      "s..s",
      "s..s",
    ],
    pal: { s: "#c8ccd4" },
  },
  // A tool case, drawn in a traveller's hands (deck.ts): handle on
  // top, warm case body, two bright latches. Full hands mean an
  // errand; the deck decides whose hands are full.
  toolcase: {
    rows: [
      "..hh..",
      "tttttt",
      "tTllTt",
      "tttttt",
    ],
    pal: { h: "#8a94a6", t: "#8c4a32", T: "#a85a3c", l: "#e8c98a" },
  },
  // A book, drawn open in a seated reader's hands (deck.ts).
  book: {
    rows: [
      "bbbbb",
      "bwwwb",
      "bwwwb",
      "bbbbb",
    ],
    pal: { b: "#7a3b3b", w: "#e8e2d0" },
  },
  // A table game board, drawn on the mess table between two seated
  // players while a game lasts (deck.ts): green felt, cards down.
  board: {
    rows: [
      "gggggg",
      "gwrrwg",
      "gggggg",
    ],
    pal: { g: "#2e5d43", w: "#e8e2d0", r: "#d84a4a" },
  },
};

// -------------------------------------------------------------- floors

interface FloorSpec {
  base: string;
  alt: string;
  /** Checkerboard alternation instead of hash noise. */
  checker?: boolean;
  /** Edge line colour drawn on the tile's bottom/right, or null. */
  edge: string | null;
}

const FLOORS: Record<string, FloorSpec> = {
  bridge: { base: "#33507e", alt: "#2b446c", edge: "#1f3355" },
  engineering: { base: "#4a4238", alt: "#3e382f", edge: "#2c2721" },
  medbay: { base: "#cfe3d8", alt: "#b7d3c2", edge: "#97b7a2", checker: true },
  mess: { base: "#6e4f30", alt: "#7a5734", edge: "#4c351d", checker: true },
  quarters: { base: "#51386b", alt: "#5b4076", edge: "#3a2850" },
  hydroponics: { base: "#3d5c2e", alt: "#456832", edge: "#2a421f" },
  cargo: { base: "#5a5a42", alt: "#4e4e39", edge: "#38382a" },
  airlock: { base: "#5c6066", alt: "#51555d", edge: "#3a3e45" },
  lab: { base: "#a8c8c2", alt: "#93b5ad", edge: "#779e95", checker: true },
  gym: { base: "#4a3a42", alt: "#53404a", edge: "#332831" },
};

const DEFAULT_FLOOR: FloorSpec = {
  base: "#3a4763",
  alt: "#414e6b",
  edge: "#2a3348",
};

/** A room kind's accent colour: the plate tick and small trims. */
const ROOM_ACCENTS: Record<string, string> = {
  bridge: "#57a8e8",
  engineering: "#e8a33d",
  medbay: "#7fd4a8",
  mess: "#e8c98a",
  quarters: "#b48ec7",
  hydroponics: "#79c94f",
  cargo: "#c9a86a",
  airlock: "#c9a227",
  lab: "#7fd4c1",
  gym: "#d87f6a",
};

/** The accent colour for a room kind, or a neutral steel. */
export function roomAccent(kind: string): string {
  return ROOM_ACCENTS[kind] ?? "#8fa6c4";
}

/** The colour of one floor tile, set by the room kind and its hash. */
export function floorTile(
  kind: string,
  seedKey: number,
  gx: number,
  gy: number,
): string {
  const spec = FLOORS[kind] ?? DEFAULT_FLOOR;
  if (spec.checker === true) {
    return (gx + gy) % 2 === 0 ? spec.base : spec.alt;
  }
  return hash01(seedKey, gx * 131 + gy * 197) < 0.5 ? spec.base : spec.alt;
}

/** The edge line colour for a floor tile, or null for none. */
export function floorEdge(kind: string): string | null {
  return (FLOORS[kind] ?? DEFAULT_FLOOR).edge;
}

/** Corridor plating: metal plates with a hash-worn tone. */
export function corridorTile(seedKey: number, gx: number, gy: number): string {
  return hash01(seedKey, gx * 131 + gy * 197) < 0.5 ? "#2c3547" : "#2a3244";
}

/** Structure (unroomed interior) plating: darker than corridor. */
export function structureTile(seedKey: number, gx: number, gy: number): string {
  return hash01(seedKey, gx * 131 + gy * 197) < 0.5 ? "#141926" : "#12161f";
}
