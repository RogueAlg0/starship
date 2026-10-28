// Deck: the ship as a place. A top-down deck plan derived from the
// engine's ship data (rooms, kinds, adjacency, systems) by viewer-local
// hash arithmetic: the same ship always yields the same deck, and the
// engine never hears about any of it. All art is code: floors, walls,
// and props are painted once into a static offscreen canvas; each
// frame draws the moving space backdrop (space.ts), that image, the
// wear layer (wear.ts: the ship's accumulated scars, repainted only
// when a wear input crosses a bucket boundary), the ship's light for
// the hour (daynight.ts: a tint over the deck, with everything that
// emits light drawn above it), then the dynamic layer (glows,
// blinking lights, damage sparks, welding sparks), then the staged
// event effects and failure telegraphs of the feel pass
// (staging.ts), then crew bodies with door-to-door waypoint
// movement, working crew at their stations, system labels, and
// bubbles. The whole scene rides inside the staging layer's shake
// transform, so a blow anywhere aboard moves the frame itself.
//
// Layout: the ship has two decks, as the squad sim's buildings have
// floors. Rooms split by kind: bridge, quarters, mess, medbay, and
// lab on Deck 1 (upper); engineering, cargo, hydroponics, airlock,
// and gym on Deck 2 (lower). Each deck is two room bands flanking its
// own corridor spine inside the same hull footprint: the bridge pins
// the upper bow, engineering the lower stern, and a deck shorter
// than the hull pads the difference with structure plating. Two lift
// shafts at fixed fractions of the corridor are the only route
// between decks: crew ride them, fading out on one deck and in on
// the other. The viewer shows one deck at a time; the minimap
// (minimap.ts) watches both. A third view steps outside entirely:
// the hull exterior (exterior.ts), the same ship in side profile
// against the same sky, her windows lit by the life inside. Doors
// pierce shared walls between neighbouring rooms placed side by
// side, and every room opens onto its deck's corridor. Crew paths
// route through those doors over a walkable tile grid, smoothed by
// line of sight. The engine has no
// floors: this is presentation of the room graph, nothing more.

import type { CrewMember } from "../../src/entities/crew.ts";
import type { Ship } from "../../src/world/ship.ts";
import type { ShipSystem } from "../../src/world/systems.ts";
import { hash01 } from "./faces.ts";
import { getBodySprites } from "./bodies.ts";
import { BubbleLayer } from "./bubbles.ts";
import { SpaceBackdrop } from "./space.ts";
import { lightAt, NIGHT_DARK } from "./daynight.ts";
import { WearLayer, type WearGeom } from "./wear.ts";
import {
  StagingLayer,
  type StageAnchor,
  type StageSystemState,
} from "./staging.ts";
import { ExteriorView, type ExteriorContact } from "./exterior.ts";
import {
  corridorTile,
  floorEdge,
  floorTile,
  roomAccent,
  propCanvas,
  propSize,
  structureTile,
} from "./props.ts";

export const TILE_PX = 8;
/**
 * Crew bodies draw larger than their native 8x12: at deck scale
 * a one-tile figure vanishes, and the people are the show. The
 * scale anchors at the feet, so positions, shadows, and bubbles
 * (all keyed to the feet point) stay where they were.
 */
const BODY_SCALE = 1.3;
/** Structural gap between the two deck plans in the cutaway, px. */
export const CUTAWAY_GAP_PX = 12;

const BAND_H = 9; // room band height, tiles
export const CORR_Y = 9; // corridor top row
const CORR_H = 3; // corridor height
const DECK_H = BAND_H * 2 + CORR_H; // 21
export const OX = 5; // canvas tiles left of the hull stern (engine block zone)
export const OY = 2; // canvas tiles above the hull
const CORR_MID = CORR_Y + 1.5; // corridor centre row, tile-float coords
/** Seconds of wall time for each half of a lift ride (out, then in). */
const TRANSIT_PHASE_S = 0.3;

const SIZES: Record<string, [number, number]> = {
  bridge: [11, 7],
  engineering: [15, 9],
  medbay: [9, 7],
  mess: [11, 7],
  quarters: [7, 6],
  hydroponics: [11, 8],
  cargo: [13, 9],
  airlock: [6, 5],
  lab: [9, 7],
  gym: [10, 8],
};

/** Blend two #rrggbb colours, t of the way from a to b. */
function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number): number =>
    Math.round(
      ((pa >> shift) & 255) +
        (((pb >> shift) & 255) - ((pa >> shift) & 255)) * t,
    );
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** A #rrggbb colour at an alpha, as an rgba() string. */
function hexA(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function strHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 100000);
}

const key = (x: number, y: number): string => `${x},${y}`;

// ------------------------------------------------------------ layout

export interface RoomRect {
  index: number;
  kind: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WorkPoint {
  x: number; // tile-float stand position
  y: number;
  systemId: string | null;
  tag: string;
  fx: number; // facing while working: -1, 0, 1
}

interface PlacedProp {
  name: string;
  tx: number;
  ty: number;
  under: boolean;
}

interface LightPoint {
  px: number;
  py: number;
  phase: number;
  colour: string;
  style: "steady" | "pulse" | "blink";
}

interface RoomLayout {
  rect: RoomRect;
  props: PlacedProp[];
  stations: WorkPoint[];
  lights: LightPoint[];
  standTiles: Array<{ x: number; y: number }>;
  center: { x: number; y: number };
  doorTile: { x: number; y: number };
  doorInside: { x: number; y: number };
  screenRect: { x: number; y: number; w: number; h: number } | null;
  systemIds: string[];
  /** Bunk and medbay-bed tile centres: where resting crew lie down. */
  bunks: Array<{ x: number; y: number }>;
  /**
   * Chair positions at the mess tables, in table order: for each
   * table, the tile above it then the tile below it, so seats 2t
   * and 2t+1 face each other across table t. Where eating crew sit
   * and where a table game is played.
   */
  seats: Array<{ x: number; y: number; table: number }>;
  /** Gym mat tile centres: where exercising crew stand to work. */
  mats: Array<{ x: number; y: number }>;
}

interface SideDoor {
  a: number;
  b: number;
  approachA: { x: number; y: number };
  approachB: { x: number; y: number };
  mid: { x: number; y: number };
}

/** One lift shaft: a column pair on the corridor, shared by both decks. */
export interface LiftShaft {
  /** Left tile column of the two-wide shaft. */
  x: number;
  /** Boarding point, tile-float coords: the middle of the car. */
  point: { x: number; y: number };
}

/**
 * One deck's plan. Both decks share the tile coordinate frame and
 * the hull footprint, so a tile position means the same place on
 * either deck and only the deck tag tells them apart.
 */
export interface DeckLayout {
  seedKey: number;
  deckIndex: number;
  rooms: RoomLayout[];
  /** Shared hull width in tiles (both decks, padding included). */
  deckW: number;
  /** This deck's own content width, before the padding to deckW. */
  contentW: number;
  widthPx: number;
  heightPx: number;
  walkable: Uint8Array;
  sideDoors: Map<string, SideDoor>;
  systemAnchor: Map<string, { px: number; py: number; room: number }>;
  reactorCore: { x: number; y: number; w: number; h: number } | null;
  engineGlow: { x: number; y: number };
  navLights: Array<{ x: number; y: number; colour: string; phase: number }>;
  bridgeScreen: { x: number; y: number; w: number; h: number } | null;
  lifts: LiftShaft[];
}

/** The whole ship's presentation: two deck plans in one hull. */
export interface ShipLayout {
  seedKey: number;
  deckW: number;
  widthPx: number;
  heightPx: number;
  decks: [DeckLayout, DeckLayout];
  /** Deck index per room index: 0 upper, 1 lower. */
  deckOfRoom: number[];
  lifts: LiftShaft[];
}

/**
 * Which deck a room kind lives on. A ship is a workplace over a
 * machine: command, living, and care above; the plant below.
 */
const DECK_OF_KIND: Readonly<Record<string, 0 | 1>> = {
  bridge: 0,
  quarters: 0,
  mess: 0,
  medbay: 0,
  lab: 0,
  engineering: 1,
  cargo: 1,
  hydroponics: 1,
  airlock: 1,
  gym: 1,
};

/**
 * Assign every room to a deck. Listed kinds follow the table; a kind
 * the table does not name goes to the deck with more spare width
 * (the smaller summed room width so far), ties broken by hash.
 */
export function assignDecks(ship: Ship, seedKey: number): number[] {
  const deckOf = new Array<number>(ship.rooms.length).fill(-1);
  const load = [0, 0];
  const widthOf = (kind: string): number => (SIZES[kind]?.[0] ?? 9) + 1;
  for (const room of ship.rooms) {
    const d = DECK_OF_KIND[room.kind];
    if (d !== undefined) {
      deckOf[room.index] = d;
      load[d] += widthOf(room.kind);
    }
  }
  for (const room of ship.rooms) {
    if (deckOf[room.index] !== -1) continue;
    let d: 0 | 1;
    if (load[0] !== load[1]) d = load[0] < load[1] ? 0 : 1;
    else d = hash01(seedKey, room.index * 7 + 1) < 0.5 ? 0 : 1;
    deckOf[room.index] = d;
    load[d] += widthOf(room.kind);
  }
  return deckOf;
}

/**
 * Order one deck's rooms for placement: head first (the stern pin),
 * then a greedy adjacency chain, then the tail pins (the bow). Rooms
 * are scored by how many already-placed neighbours they touch, with
 * a hash jitter, so graph neighbours tend to sit side by side.
 */
function orderDeckRooms(
  ship: Ship,
  seedKey: number,
  indices: number[],
  head: number,
  tail: number[],
): number[] {
  const inDeck = new Set(indices);
  const pinned = new Set(
    [head, ...tail].filter((i) => i >= 0 && inDeck.has(i)),
  );
  const pool = indices.filter((i) => !pinned.has(i));
  const anchor =
    head >= 0 ? head : (tail.find((i) => i >= 0 && inDeck.has(i)) ?? -1);
  const chain: number[] = [];
  let last = anchor;
  while (pool.length > 0) {
    let best = -1;
    let bestScore = -1;
    for (const cand of pool) {
      const neighbours = ship.rooms[cand]?.neighbors ?? [];
      let score = last >= 0 && neighbours.includes(last) ? 4 : 0;
      for (const placed of [anchor, ...chain]) {
        if (placed >= 0 && neighbours.includes(placed)) score += 1;
      }
      score += hash01(seedKey, cand * 13 + 3) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best < 0) break;
    chain.push(best);
    pool.splice(pool.indexOf(best), 1);
    last = best;
  }
  const order: number[] = [];
  if (head >= 0 && inDeck.has(head)) order.push(head);
  order.push(...chain);
  for (const t of tail) {
    if (t >= 0 && inDeck.has(t)) order.push(t);
  }
  return order;
}

class RoomBuild {
  readonly blocked = new Set<string>();
  readonly props: PlacedProp[] = [];
  readonly stations: WorkPoint[] = [];
  readonly lights: LightPoint[] = [];
  screenRect: { x: number; y: number; w: number; h: number } | null = null;

  readonly rect: RoomRect;
  private readonly seedKey: number;
  /** Tiles no prop may take: the ground just inside each door. */
  private readonly reserved: ReadonlySet<string>;

  constructor(rect: RoomRect, seedKey: number, reserved: ReadonlySet<string>) {
    this.rect = rect;
    this.seedKey = seedKey;
    this.reserved = reserved;
  }

  get ix0(): number {
    return this.rect.x + 1;
  }
  get iy0(): number {
    return this.rect.y + 1;
  }
  get ix1(): number {
    return this.rect.x + this.rect.w - 2;
  }
  get iy1(): number {
    return this.rect.y + this.rect.h - 2;
  }

  private free(tx: number, ty: number): boolean {
    return (
      tx >= this.ix0 &&
      tx <= this.ix1 &&
      ty >= this.iy0 &&
      ty <= this.iy1 &&
      !this.blocked.has(key(tx, ty)) &&
      !this.reserved.has(key(tx, ty)) &&
      !(tx === this.centerTile.x && ty === this.centerTile.y)
    );
  }

  get centerTile(): { x: number; y: number } {
    return {
      x: this.rect.x + Math.floor(this.rect.w / 2),
      y: this.rect.y + Math.floor(this.rect.h / 2),
    };
  }

  /** Tiles along one interior wall, in scan order from a hashed start. */
  private wallTiles(side: "top" | "bottom" | "left" | "right"): Array<[number, number]> {
    const tiles: Array<[number, number]> = [];
    if (side === "top" || side === "bottom") {
      const ty = side === "top" ? this.iy0 : this.iy1;
      for (let tx = this.ix0; tx <= this.ix1; tx++) tiles.push([tx, ty]);
    } else {
      const tx = side === "left" ? this.ix0 : this.ix1;
      for (let ty = this.iy0; ty <= this.iy1; ty++) tiles.push([tx, ty]);
    }
    if (tiles.length === 0) return tiles;
    const start = Math.floor(
      hash01(this.seedKey, this.rect.index * 17 + side.length * 7) *
        tiles.length,
    );
    return [...tiles.slice(start), ...tiles.slice(0, start)];
  }

  /**
   * Place a prop. With a side, the first free tile along that wall;
   * without, at the given tile. Records a work station on the tile in
   * front of the prop when asked, and a blinking light when asked.
   */
  place(
    name: string,
    opts: {
      side?: "top" | "bottom" | "left" | "right";
      at?: [number, number];
      systemId?: string;
      tag?: string;
      station?: boolean;
      light?: { colour: string; style: LightPoint["style"] };
      under?: boolean;
    } = {},
  ): { tx: number; ty: number } | null {
    let spot: [number, number] | null = null;
    if (opts.at !== undefined) {
      if (this.free(opts.at[0], opts.at[1]) || opts.under === true) {
        spot = opts.at;
      }
    } else if (opts.side !== undefined) {
      for (const [tx, ty] of this.wallTiles(opts.side)) {
        if (this.free(tx, ty)) {
          spot = [tx, ty];
          break;
        }
      }
    }
    if (spot === null) return null;
    const [tx, ty] = spot;
    if (opts.under !== true) this.blocked.add(key(tx, ty));
    this.props.push({ name, tx, ty, under: opts.under === true });
    const size = propSize(name);
    const px = (tx + OX) * TILE_PX + Math.floor((TILE_PX - size.w) / 2);
    const py = (ty + OY) * TILE_PX + Math.floor((TILE_PX - size.h) / 2);
    if (opts.light !== undefined) {
      this.lights.push({
        px: px + size.w - 2,
        py: py + 1,
        phase: hash01(this.seedKey, tx * 41 + ty * 59 + this.rect.index) *
          Math.PI *
          2,
        colour: opts.light.colour,
        style: opts.light.style,
      });
    }
    if (opts.station === true) {
      const front: [number, number] =
        ty === this.iy0
          ? [tx, ty + 1]
          : ty === this.iy1
            ? [tx, ty - 1]
            : tx === this.ix0
              ? [tx + 1, ty]
              : [tx - 1, ty];
      if (
        front[0] >= this.ix0 &&
        front[0] <= this.ix1 &&
        front[1] >= this.iy0 &&
        front[1] <= this.iy1 &&
        !this.blocked.has(key(front[0], front[1]))
      ) {
        this.stations.push({
          x: front[0] + 0.5,
          y: front[1] + 0.5,
          systemId: opts.systemId ?? null,
          tag: opts.tag ?? name,
          fx: front[0] < tx ? -1 : front[0] > tx ? 1 : 0,
        });
      }
    }
    return { tx, ty };
  }
}

/** The prominent prop for a hosted system, by system kind. */
function placeSystem(
  build: RoomBuild,
  system: ShipSystem,
  layout: DeckLayout,
): void {
  const side =
    hash01(layout.seedKey, system.room * 23 + system.id.length) < 0.5
      ? "top"
      : "bottom";
  const light = { colour: "#ffd76a", style: "pulse" as const };
  const put = (
    name: string,
    opts: Parameters<RoomBuild["place"]>[1],
  ): { tx: number; ty: number } | null => build.place(name, opts);
  let anchor: { tx: number; ty: number } | null = null;
  switch (system.kind) {
    case "reactor":
      anchor = put("reactor", { side, systemId: system.id, station: true });
      if (anchor !== null) {
        layout.reactorCore = {
          x: (anchor.tx + OX) * TILE_PX + 3,
          y: (anchor.ty + OY) * TILE_PX + 2,
          w: 2,
          h: 4,
        };
      }
      break;
    case "engines":
      anchor = put("machine", { side, systemId: system.id, station: true, light });
      put("machine", { side, systemId: system.id });
      break;
    case "life support":
      anchor = put("tank", { side, systemId: system.id, station: true, light });
      put("tank", { side, systemId: system.id });
      break;
    case "water recycler":
      anchor = put("tank", { side, systemId: system.id, station: true, light });
      put("machine", { side, systemId: system.id });
      break;
    case "hydroponics rig":
      anchor = put("rack", { side, systemId: system.id, station: true });
      put("rack", { side, systemId: system.id });
      break;
    case "comms":
      anchor = put("comms", { side, systemId: system.id, station: true, light });
      break;
    case "medbay unit":
      anchor = put("bed", { side, systemId: system.id, station: true });
      put("monitor", { side, light: { colour: "#8fe388", style: "blink" } });
      break;
    default:
      anchor = put("machine", { side, systemId: system.id, station: true, light });
  }
  if (anchor !== null) {
    layout.systemAnchor.set(system.id, {
      px: (anchor.tx + OX) * TILE_PX + 4,
      py: (anchor.ty + OY) * TILE_PX + 2,
      room: system.room,
    });
  }
}

/** Kind dressing: the furniture that makes a room read as itself. */
function dressRoom(build: RoomBuild, layout: DeckLayout): void {
  const kind = build.rect.kind;
  const blink = { colour: "#57a8e8", style: "blink" as const };
  switch (kind) {
    case "bridge": {
      // The main screen spans the top wall; sweep drawn dynamically.
      const cx = build.centerTile.x;
      const first = build.place("mainscreen", { at: [cx - 1, build.iy0] });
      build.place("mainscreen", { at: [cx, build.iy0] });
      build.place("mainscreen", { at: [cx + 1, build.iy0] });
      if (first !== null) {
        build.screenRect = {
          x: (cx - 1 + OX) * TILE_PX + 1,
          y: (build.iy0 + OY) * TILE_PX + 1,
          w: TILE_PX * 3 - 2,
          h: 3,
        };
      }
      build.place("chair", { at: [cx, build.iy0 + 1] });
      build.place("console", { side: "top", station: true, tag: "console", light: blink });
      build.place("console", { side: "top", station: true, tag: "console", light: blink });
      build.place("console", { side: "bottom", station: true, tag: "console", light: blink });
      break;
    }
    case "engineering":
      build.place("machine", { side: "bottom", station: true, tag: "machine" });
      build.place("machine", { side: "bottom" });
      build.place("tank", { side: "left" });
      build.place("tank", { side: "right" });
      build.place("cabinet", { side: "top" });
      break;
    case "medbay":
      build.place("bed", { side: "left", station: true, tag: "beds" });
      build.place("bed", { side: "right", station: true, tag: "beds" });
      build.place("bed", { side: "left" });
      build.place("cabinet", { side: "top" });
      build.place("cabinet", { side: "bottom" });
      break;
    case "mess":
      build.place("counter", { side: "top", station: true, tag: "counter" });
      build.place("counter", { side: "top" });
      build.place("table", { at: [build.ix0 + 1, build.centerTile.y] });
      build.place("table", { at: [build.ix1 - 1, build.centerTile.y] });
      build.place("stool", { at: [build.ix0 + 1, build.centerTile.y + 1], under: true });
      build.place("stool", { at: [build.ix1 - 1, build.centerTile.y + 1], under: true });
      break;
    case "quarters":
      build.place("bunk", { side: "top", station: true, tag: "bunk" });
      build.place("bunk", { side: "top" });
      build.place("bunk", { side: "bottom" });
      build.place("locker", { side: "bottom", station: true, tag: "locker" });
      build.place("locker", { side: "left" });
      break;
    case "hydroponics":
      // Rack rows with walk rows between them.
      for (let ty = build.iy0; ty <= build.iy1; ty += 2) {
        for (let tx = build.ix0; tx <= build.ix1; tx++) {
          build.place("rack", {
            at: [tx, ty],
            station: tx === build.centerTile.x,
            tag: "racks",
          });
        }
      }
      break;
    case "cargo":
      for (const [tx, ty] of [
        [build.ix0, build.iy0],
        [build.ix0 + 1, build.iy0],
        [build.ix0, build.iy0 + 1],
        [build.ix1, build.iy0],
        [build.ix1, build.iy1],
        [build.ix1 - 1, build.iy1],
        [build.ix0, build.iy1],
      ] as Array<[number, number]>) {
        build.place("crate", { at: [tx, ty], station: tx === build.ix0, tag: "crates" });
      }
      build.place("barrel", { side: "right" });
      build.place("barrel", { side: "bottom" });
      break;
    case "airlock":
      build.place("suits", { side: "top", station: true, tag: "suits" });
      build.place("suits", { side: "left" });
      build.place("cabinet", { side: "bottom" });
      break;
    case "lab":
      build.place("bench", { side: "top", station: true, tag: "bench", light: blink });
      build.place("bench", { side: "bottom", station: true, tag: "bench" });
      build.place("tank", { side: "left" });
      build.place("tank", { side: "right" });
      break;
    case "gym":
      build.place("mat", { at: [build.centerTile.x - 1, build.centerTile.y], under: true });
      build.place("mat", { at: [build.centerTile.x, build.centerTile.y], under: true });
      build.place("mat", { at: [build.centerTile.x + 1, build.centerTile.y], under: true });
      build.place("weights", { side: "top", station: true, tag: "weights" });
      build.place("weights", { side: "bottom" });
      break;
    default:
      build.place("cabinet", { side: "top" });
      build.place("crate", { side: "bottom" });
  }
}

interface BandRows {
  rows: Array<{ rooms: number[]; width: number }>;
  /** The deck's own content width in tiles, before hull padding. */
  contentW: number;
}

/**
 * Split one deck's ordered rooms into the two bands flanking its
 * corridor: each room goes to the currently narrower band, except
 * the pinned room (engineering), whose band is the hash's choice.
 */
function splitBands(
  ship: Ship,
  seedKey: number,
  order: number[],
  pinnedIndex: number,
): BandRows {
  const rows: Array<{ rooms: number[]; width: number }> = [
    { rooms: [], width: 1 },
    { rooms: [], width: 1 },
  ];
  for (const index of order) {
    const kind = ship.rooms[index]?.kind ?? "quarters";
    const [w] = SIZES[kind] ?? [9, 7];
    let row: number;
    if (index === pinnedIndex) {
      row = hash01(seedKey, 501) < 0.5 ? 0 : 1;
    } else {
      row = rows[0].width <= rows[1].width ? 0 : 1;
    }
    rows[row].rooms.push(index);
    rows[row].width += w + 1;
  }
  return {
    rows,
    contentW: Math.max(rows[0].width, rows[1].width) + 2,
  };
}

/**
 * Build one deck's plan: rects, doors, furniture, walkable grid.
 * Only this deck's rooms exist here; the coordinate frame and the
 * hull width are shared with the other deck, so the two plans stack.
 */
function buildDeckPlan(
  ship: Ship,
  seedKey: number,
  deckIndex: number,
  bands: BandRows,
  deckW: number,
  lifts: LiftShaft[],
): DeckLayout {
  const layout: DeckLayout = {
    seedKey,
    deckIndex,
    rooms: [],
    deckW,
    contentW: bands.contentW,
    widthPx: (OX + deckW + 9) * TILE_PX,
    heightPx: (OY * 2 + DECK_H) * TILE_PX,
    walkable: new Uint8Array(deckW * DECK_H),
    sideDoors: new Map(),
    systemAnchor: new Map(),
    reactorCore: null,
    engineGlow: {
      x: (OX - 2) * TILE_PX,
      y: (OY + CORR_Y + 1) * TILE_PX + 4,
    },
    navLights: [],
    bridgeScreen: null,
    lifts,
  };

  const rects = new Map<number, RoomRect>();
  bands.rows.forEach((rowData, rowIdx) => {
    let cursor = 1;
    for (const index of rowData.rooms) {
      const room = ship.rooms[index];
      if (room === undefined) continue;
      const [w, h] = SIZES[room.kind] ?? [9, 7];
      const y = rowIdx === 0 ? CORR_Y - h : CORR_Y + CORR_H;
      rects.set(index, { index, kind: room.kind, name: room.name, x: cursor, y, w, h });
      cursor += w + 1;
    }
  });

  // Walkable base: the corridor, then room interiors.
  const setWalk = (x: number, y: number): void => {
    if (x >= 0 && x < deckW && y >= 0 && y < DECK_H) {
      layout.walkable[y * deckW + x] = 1;
    }
  };
  for (let x = 0; x < deckW; x++) {
    for (let y = CORR_Y; y < CORR_Y + CORR_H; y++) setWalk(x, y);
  }

  // Doors are decided before any furniture: corridor doors from the
  // hash, side doors where graph neighbours sit side by side. The
  // tiles just inside each door are reserved, so no prop can ever
  // seal a room shut.
  interface DoorInfo {
    doorTx: number;
    doorTy: number;
    insideTy: number;
  }
  const doorInfo = new Map<number, DoorInfo>();
  for (const room of ship.rooms) {
    const rect = rects.get(room.index);
    if (rect === undefined) continue;
    const span = rect.w - 2;
    const doorTx =
      rect.x + 1 + Math.floor(hash01(seedKey, room.index * 31 + 7) * span);
    const topRow = rect.y + rect.h <= CORR_Y;
    const doorTy = topRow ? rect.y + rect.h - 1 : rect.y;
    doorInfo.set(room.index, {
      doorTx,
      doorTy,
      insideTy: topRow ? doorTy - 1 : doorTy + 1,
    });
  }
  interface SideGeom {
    a: number;
    b: number;
    doorY: number;
    wallAx: number;
    gapX: number;
    wallBx: number;
  }
  const sideGeoms: SideGeom[] = [];
  for (const room of ship.rooms) {
    const a = rects.get(room.index);
    if (a === undefined) continue;
    for (const nIdx of room.neighbors) {
      if (nIdx <= room.index) continue;
      const b = rects.get(nIdx);
      if (b === undefined || b.y !== a.y) continue;
      const left = a.x < b.x ? a : b;
      const right = left === a ? b : a;
      if (left.x + left.w + 1 !== right.x) continue;
      const lo = Math.max(left.y + 1, right.y + 1);
      const hi = Math.min(left.y + left.h - 2, right.y + right.h - 2);
      if (hi < lo) continue;
      const doorY =
        lo +
        Math.floor(
          hash01(seedKey, left.index * 43 + right.index) * (hi - lo + 1),
        );
      sideGeoms.push({
        a: left.index,
        b: right.index,
        doorY,
        wallAx: left.x + left.w - 1,
        gapX: left.x + left.w,
        wallBx: right.x,
      });
    }
  }
  const reserved = new Map<number, Set<string>>();
  const reserve = (roomIdx: number, tx: number, ty: number): void => {
    const set = reserved.get(roomIdx) ?? new Set<string>();
    set.add(key(tx, ty));
    reserved.set(roomIdx, set);
  };
  for (const [idx, info] of doorInfo) reserve(idx, info.doorTx, info.insideTy);
  for (const g of sideGeoms) {
    reserve(g.a, g.wallAx - 1, g.doorY);
    reserve(g.b, g.wallBx + 1, g.doorY);
  }

  for (const room of ship.rooms) {
    const rect = rects.get(room.index);
    if (rect === undefined) continue;
    const info = doorInfo.get(room.index);
    if (info === undefined) continue;
    const build = new RoomBuild(
      rect,
      seedKey,
      reserved.get(room.index) ?? new Set<string>(),
    );
    for (const system of ship.systemsInRoom(room.index)) {
      placeSystem(build, system, layout);
    }
    dressRoom(build, layout);
    // Interior walkable where no blocking prop stands.
    const standTiles: Array<{ x: number; y: number }> = [];
    for (let ty = build.iy0; ty <= build.iy1; ty++) {
      for (let tx = build.ix0; tx <= build.ix1; tx++) {
        if (!build.blocked.has(key(tx, ty))) {
          setWalk(tx, ty);
          standTiles.push({ x: tx + 0.5, y: ty + 0.5 });
        }
      }
    }
    setWalk(info.doorTx, info.doorTy);
    layout.rooms[room.index] = {
      rect,
      props: build.props,
      stations: build.stations,
      lights: build.lights,
      standTiles,
      center: {
        x: build.centerTile.x + 0.5,
        y: build.centerTile.y + 0.5,
      },
      doorTile: { x: info.doorTx + 0.5, y: info.doorTy + 0.5 },
      doorInside: { x: info.doorTx + 0.5, y: info.insideTy + 0.5 },
      screenRect: build.screenRect,
      systemIds: ship.systemsInRoom(room.index).map((s) => s.id),
      bunks: build.props
        .filter((p) => p.name === "bunk" || p.name === "bed")
        .map((p) => ({ x: p.tx + 0.5, y: p.ty + 0.5 })),
      seats: build.props
        .filter((p) => p.name === "table")
        .sort((a, b) => a.tx - b.tx || a.ty - b.ty)
        .flatMap((p, table) => [
          { x: p.tx + 0.5, y: p.ty - 0.5, table },
          { x: p.tx + 0.5, y: p.ty + 1.5, table },
        ]),
      mats: build.props
        .filter((p) => p.name === "mat")
        .map((p) => ({ x: p.tx + 0.5, y: p.ty + 0.5 })),
    };
    if (build.screenRect !== null) layout.bridgeScreen = build.screenRect;
  }

  for (const g of sideGeoms) {
    setWalk(g.wallAx, g.doorY);
    setWalk(g.gapX, g.doorY);
    setWalk(g.wallBx, g.doorY);
    layout.sideDoors.set(`${g.a}|${g.b}`, {
      a: g.a,
      b: g.b,
      approachA: { x: g.wallAx - 1 + 0.5, y: g.doorY + 0.5 },
      approachB: { x: g.wallBx + 1 + 0.5, y: g.doorY + 0.5 },
      mid: { x: g.gapX + 0.5, y: g.doorY + 0.5 },
    });
  }


  layout.navLights = [
    { x: (OX + deckW + 5) * TILE_PX, y: (OY + 2) * TILE_PX, colour: "#ff5a4a", phase: 0 },
    { x: (OX + deckW + 5) * TILE_PX, y: (OY + DECK_H - 2) * TILE_PX, colour: "#4ae88a", phase: 2.2 },
    { x: (OX - 4) * TILE_PX + 2, y: (OY + CORR_Y + 1) * TILE_PX + 4, colour: "#f4f6fa", phase: 4.1 },
  ];
  return layout;
}

/**
 * The ship's presentation: assign decks, order and lay out each one
 * in the shared hull footprint, and place the two lift shafts at
 * fixed fractions of the corridor, aligned on both decks.
 */
export function buildShipLayout(ship: Ship): ShipLayout {
  const seedKey = strHash(ship.signature());
  const deckOfRoom = assignDecks(ship, seedKey);
  const byKind = (kind: string): number =>
    ship.rooms.find((r) => r.kind === kind)?.index ?? -1;
  const eng = byKind("engineering");
  const bridge = byKind("bridge");
  const airlock = byKind("airlock");
  const indicesOf = (d: number): number[] =>
    ship.rooms
      .filter((r) => deckOfRoom[r.index] === d)
      .map((r) => r.index);
  // Upper deck: the chain grows toward the bridge, pinned at the bow.
  // Lower deck: engineering pins the stern, the airlock rides aft.
  const order0 = orderDeckRooms(ship, seedKey, indicesOf(0), -1, [bridge]);
  const order1 = orderDeckRooms(ship, seedKey, indicesOf(1), eng, [airlock]);
  const bands0 = splitBands(ship, seedKey, order0, eng);
  const bands1 = splitBands(ship, seedKey, order1, eng);
  const deckW = Math.max(bands0.contentW, bands1.contentW);
  const liftA = Math.max(3, Math.round(deckW / 3));
  const liftB = Math.max(liftA + 6, Math.round((2 * deckW) / 3));
  const lifts: LiftShaft[] = [liftA, liftB].map((x) => ({
    x,
    point: { x: x + 1, y: CORR_MID },
  }));
  const decks: [DeckLayout, DeckLayout] = [
    buildDeckPlan(ship, seedKey, 0, bands0, deckW, lifts),
    buildDeckPlan(ship, seedKey, 1, bands1, deckW, lifts),
  ];
  return {
    seedKey,
    deckW,
    widthPx: (OX + deckW + 9) * TILE_PX,
    heightPx: (OY * 2 + DECK_H) * TILE_PX,
    decks,
    deckOfRoom,
    lifts,
  };
}

// ------------------------------------------------------- static render

function renderStatic(
  layout: DeckLayout,
  ship: Ship,
  bare = false,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = layout.widthPx;
  canvas.height = layout.heightPx;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  const { seedKey, deckW } = layout;

  // Space itself is not painted here: the moving backdrop (space.ts)
  // is drawn under this canvas every frame, and this layer stays
  // transparent beyond the hull so the sky shows through.

  // Hull silhouette. In the cutaway the two decks share one hull,
  // painted once beneath both (renderCutawayHull); a bare deck
  // paints only its interior, and the shared hull shows through
  // the margins and the band between the plans.
  if (!bare) {
  const hullTop = (OY - 1) * TILE_PX;
  const hullBottom = (OY + DECK_H + 1) * TILE_PX;
  const sternX = (OX - 1) * TILE_PX;
  const bowStartX = (OX + deckW) * TILE_PX;
  const bowTipX = (OX + deckW + 7) * TILE_PX;
  const midY = (hullTop + hullBottom) / 2;
  ctx.beginPath();
  ctx.moveTo(sternX + 10, hullTop);
  ctx.lineTo(bowStartX - 10, hullTop);
  ctx.quadraticCurveTo(bowTipX, midY, bowStartX - 10, hullBottom);
  ctx.lineTo(sternX + 10, hullBottom);
  ctx.quadraticCurveTo(sternX - 8, midY, sternX + 10, hullTop);
  ctx.closePath();
  ctx.fillStyle = "#272f3f";
  ctx.fill();
  ctx.strokeStyle = "#46536b";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Plating seams on the bands.
  ctx.strokeStyle = "#1d2534";
  for (let i = 0; i < 12; i++) {
    const x = sternX + 16 + hash01(seedKey, i * 5 + 21) * (bowStartX - sternX - 40);
    ctx.beginPath();
    ctx.moveTo(x, hullTop + 2);
    ctx.lineTo(x, hullTop + 13);
    ctx.moveTo(x, hullBottom - 13);
    ctx.lineTo(x, hullBottom - 2);
    ctx.stroke();
  }
  // Engine block at the stern.
  ctx.fillStyle = "#39465c";
  ctx.fillRect((OX - 4) * TILE_PX, midY - 18, TILE_PX * 3 + 4, 36);
  ctx.fillStyle = "#232c3d";
  for (const dy of [-13, -4, 5]) {
    ctx.fillRect((OX - 4) * TILE_PX, midY + dy, 3, 6);
  }
  // The ship's name on the dorsal plating.
  ctx.fillStyle = "#8fa6c4";
  ctx.font = "bold 7px monospace";
  ctx.textAlign = "left";
  ctx.fillText(ship.name.toUpperCase(), sternX + 14, hullTop + 11);
  }

  // Structure and corridor base.
  for (let ty = 0; ty < DECK_H; ty++) {
    for (let tx = 0; tx < deckW; tx++) {
      const px = (tx + OX) * TILE_PX;
      const py = (ty + OY) * TILE_PX;
      if (ty >= CORR_Y && ty < CORR_Y + CORR_H) {
        ctx.fillStyle = corridorTile(seedKey, tx, ty);
        ctx.fillRect(px, py, TILE_PX, TILE_PX);
      } else if (layout.walkable[ty * deckW + tx] !== 1) {
        ctx.fillStyle = structureTile(seedKey, tx, ty);
        ctx.fillRect(px, py, TILE_PX, TILE_PX);
        // Truss ticks in the frame: unroomed structure reads as
        // bracing, not as blank fill.
        if (hash01(seedKey, tx * 57 + ty * 91) > 0.55) {
          ctx.fillStyle = "#1e2735";
          const flip = hash01(seedKey, tx * 13 + ty * 29) < 0.5;
          for (let s = 0; s < TILE_PX; s += 2) {
            ctx.fillRect(px + s, py + (flip ? s : TILE_PX - 1 - s), 1, 1);
          }
        }
      }
    }
  }
  // Corridor guide lights: two dashed runs down the spine, so
  // the corridor reads as a lit route, not a gap between rooms.
  ctx.fillStyle = "#7d90ad";
  for (let tx = 2; tx < deckW - 2; tx += 3) {
    ctx.fillRect((tx + OX) * TILE_PX + 2, (CORR_Y + OY) * TILE_PX + 12, 3, 1);
  }
  ctx.fillStyle = "#4c5b74";
  for (let tx = 3; tx < deckW - 2; tx += 3) {
    ctx.fillRect((tx + OX) * TILE_PX + 2, (CORR_Y + OY) * TILE_PX + 4, 3, 1);
  }

  // The void where this deck runs shorter than the hull: tank farm
  // and pipe runs in the plating, so the padding reads as ship, not
  // as missing rooms. Only the band rows dress; the corridor runs
  // the hull's full length on both decks.
  if (layout.contentW < deckW - 3) {
    const x0 = layout.contentW - 1;
    const x1 = deckW - 1;
    ctx.strokeStyle = "#20293a";
    ctx.lineWidth = 1;
    for (const bandY of [CORR_Y - 4, CORR_Y + CORR_H + 3]) {
      const py = (bandY + OY) * TILE_PX;
      ctx.beginPath();
      ctx.moveTo((x0 + OX) * TILE_PX, py);
      ctx.lineTo((x1 + OX) * TILE_PX, py);
      ctx.moveTo((x0 + OX) * TILE_PX, py + 3);
      ctx.lineTo((x1 + OX) * TILE_PX, py + 3);
      ctx.stroke();
    }
    const tank = propCanvas("tank");
    for (let tx = x0 + 1; tx < x1 - 1; tx += 3) {
      const h1 = hash01(seedKey, tx * 17 + layout.deckIndex * 101);
      if (h1 >= 0.6) continue;
      const top = hash01(seedKey, tx * 19 + layout.deckIndex * 103) < 0.5;
      const ty = top ? CORR_Y - 7 : CORR_Y + CORR_H + 1;
      ctx.drawImage(tank, (tx + OX) * TILE_PX + 2, (ty + OY) * TILE_PX + 1);
    }
  }

  // Lift shafts: a car block across the corridor's middle row, with
  // frame posts on the rows above and below and up/down arrows on
  // the doors. The same columns on both decks, so the eye learns
  // where the lifts are and the minimap can mark them.
  for (const lift of layout.lifts) {
    const lx = (lift.x + OX) * TILE_PX;
    const lyTop = (CORR_Y + OY) * TILE_PX;
    const lyMid = lyTop + TILE_PX;
    // Frame posts where the shaft pierces the corridor walls.
    ctx.fillStyle = "#39465c";
    ctx.fillRect(lx, lyTop, 2, TILE_PX);
    ctx.fillRect(lx + TILE_PX * 2 - 2, lyTop, 2, TILE_PX);
    ctx.fillRect(lx, lyTop + TILE_PX * 2, 2, TILE_PX);
    ctx.fillRect(lx + TILE_PX * 2 - 2, lyTop + TILE_PX * 2, 2, TILE_PX);
    // The car: darker plate, a door split, a lit header strip.
    ctx.fillStyle = "#141b28";
    ctx.fillRect(lx, lyMid, TILE_PX * 2, TILE_PX);
    ctx.fillStyle = "#46536b";
    ctx.fillRect(lx, lyMid, TILE_PX * 2, 1);
    ctx.fillRect(lx, lyMid + TILE_PX - 1, TILE_PX * 2, 1);
    ctx.fillStyle = "#0a0e14";
    ctx.fillRect(lx + TILE_PX, lyMid + 1, 1, TILE_PX - 2);
    ctx.fillStyle = "#8fa6c4";
    ctx.fillRect(lx + 3, lyMid + 1, TILE_PX * 2 - 6, 1);
    // Arrows: up on the left door, down on the right.
    ctx.fillStyle = "#e8a33d";
    ctx.beginPath();
    ctx.moveTo(lx + 4, lyMid + 3);
    ctx.lineTo(lx + 2, lyMid + 6);
    ctx.lineTo(lx + 6, lyMid + 6);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(lx + TILE_PX + 4, lyMid + 5);
    ctx.lineTo(lx + TILE_PX + 2, lyMid + 2);
    ctx.lineTo(lx + TILE_PX + 6, lyMid + 2);
    ctx.closePath();
    ctx.fill();
  }

  // Rooms: floors, walls, doors, plates, props.
  for (const room of layout.rooms) {
    if (room === undefined) continue;
    const { rect } = room;
    for (let ty = rect.y + 1; ty < rect.y + rect.h - 1; ty++) {
      for (let tx = rect.x + 1; tx < rect.x + rect.w - 1; tx++) {
        const px = (tx + OX) * TILE_PX;
        const py = (ty + OY) * TILE_PX;
        ctx.fillStyle = floorTile(rect.kind, seedKey + rect.index, tx, ty);
        ctx.fillRect(px, py, TILE_PX, TILE_PX);
        const edge = floorEdge(rect.kind);
        if (edge !== null) {
          ctx.fillStyle = edge;
          ctx.fillRect(px, py + TILE_PX - 1, TILE_PX, 1);
          ctx.fillRect(px + TILE_PX - 1, py, 1, TILE_PX);
        }
        // Surface texture: sparse sheen and wear specks, hashed
        // per tile, so the floor reads as material, not flat fill.
        const speck = hash01(seedKey + rect.index * 7, tx * 41 + ty * 67);
        if (speck > 0.84) {
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.fillRect(px + 2, py + 2, 2, 1);
        } else if (speck < 0.1) {
          ctx.fillStyle = "rgba(0,0,0,0.16)";
          ctx.fillRect(px + 5, py + 6, 2, 1);
        }
      }
    }
    // Baked light pool and inner shadow: the room reads as a lit
    // volume, not a flat patch. Static layer only; the day/night
    // tint still rides over it per frame.
    {
      const ix = (rect.x + 1 + OX) * TILE_PX;
      const iy = (rect.y + 1 + OY) * TILE_PX;
      const iw = (rect.w - 2) * TILE_PX;
      const ih = (rect.h - 2) * TILE_PX;
      const grad = ctx.createRadialGradient(
        ix + iw / 2,
        iy + ih / 2,
        2,
        ix + iw / 2,
        iy + ih / 2,
        Math.max(iw, ih) / 1.35,
      );
      grad.addColorStop(0, "rgba(255,232,190,0.13)");
      grad.addColorStop(1, "rgba(255,232,190,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(ix, iy, iw, ih);
      // The room's own colour pooled at its centre: light with
      // an address, so kinds read apart even in silhouette.
      const accent = roomAccent(rect.kind);
      const ag = ctx.createRadialGradient(
        ix + iw / 2,
        iy + ih / 2,
        1,
        ix + iw / 2,
        iy + ih / 2,
        Math.max(iw, ih) / 2.1,
      );
      ag.addColorStop(0, hexA(accent, 0.12));
      ag.addColorStop(1, hexA(accent, 0));
      ctx.fillStyle = ag;
      ctx.fillRect(ix, iy, iw, ih);
      ctx.strokeStyle = "rgba(0,0,0,0.16)";
      ctx.lineWidth = 2;
      ctx.strokeRect(ix + 1, iy + 1, iw - 2, ih - 2);
    }
    // Dressing painted on the floor itself: a rug where people
    // live and eat, a safety line where they work, a cross where
    // they heal. Cheap marks, big readability.
    {
      const ix = (rect.x + 1 + OX) * TILE_PX;
      const iy = (rect.y + 1 + OY) * TILE_PX;
      const iw = (rect.w - 2) * TILE_PX;
      const ih = (rect.h - 2) * TILE_PX;
      const accent = roomAccent(rect.kind);
      if (rect.kind === "quarters" || rect.kind === "mess") {
        const rx = ix + Math.floor(iw * 0.22);
        const ry = iy + Math.floor(ih * 0.3);
        const rw = Math.floor(iw * 0.56);
        const rh = Math.floor(ih * 0.42);
        ctx.fillStyle = hexA(accent, 0.16);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = hexA(accent, 0.4);
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      } else if (rect.kind === "engineering" || rect.kind === "cargo") {
        ctx.fillStyle = hexA("#e8a33d", 0.5);
        for (let dx = ix + 2; dx < ix + iw - 3; dx += 6) {
          ctx.fillRect(dx, iy + ih - 3, 3, 1);
        }
      } else if (rect.kind === "medbay" || rect.kind === "lab") {
        const cx = ix + Math.floor(iw / 2);
        const cy = iy + Math.floor(ih / 2);
        ctx.fillStyle = hexA(accent, 0.4);
        ctx.fillRect(cx - 3, cy - 1, 7, 2);
        ctx.fillRect(cx - 1, cy - 3, 2, 7);
      }
    }
    // Airlock hazard stripes inside the outer wall.
    if (rect.kind === "airlock") {
      for (let ty = rect.y + 1; ty < rect.y + rect.h - 1; ty++) {
        const px = (rect.x + rect.w - 2 + OX) * TILE_PX;
        const py = (ty + OY) * TILE_PX;
        for (let s = 0; s < 4; s++) {
          ctx.fillStyle = s % 2 === 0 ? "#c9a227" : "#20242c";
          ctx.fillRect(px + s * 2, py, 2, TILE_PX);
        }
      }
    }
    // Walls: a raised border with a lighter top edge. The steel
    // is blended toward the room's accent, so the frame itself
    // carries the room's colour identity, and a stripe of the
    // accent runs along the inside of the top wall.
    const wx = (rect.x + OX) * TILE_PX;
    const wy = (rect.y + OY) * TILE_PX;
    const ww = rect.w * TILE_PX;
    const wh = rect.h * TILE_PX;
    ctx.fillStyle = mixHex("#39465c", roomAccent(rect.kind), 0.22);
    ctx.fillRect(wx, wy, ww, TILE_PX);
    ctx.fillRect(wx, wy + wh - TILE_PX, ww, TILE_PX);
    ctx.fillRect(wx, wy, TILE_PX, wh);
    ctx.fillRect(wx + ww - TILE_PX, wy, TILE_PX, wh);
    ctx.fillStyle = "#6d7f96";
    ctx.fillRect(wx, wy, ww, 1);
    ctx.fillRect(wx, wy, 1, wh);
    ctx.fillStyle = "#232c3d";
    ctx.fillRect(wx, wy + wh - 1, ww, 1);
    ctx.fillRect(wx + ww - 1, wy, 1, wh);
    ctx.fillStyle = hexA(roomAccent(rect.kind), 0.65);
    ctx.fillRect(wx + 1, wy + TILE_PX - 1, ww - 2, 1);
    // Corridor door: floor showing through, with a sill line.
    const doorPx = (Math.floor(room.doorTile.x) + OX) * TILE_PX;
    const doorPy = (Math.floor(room.doorTile.y) + OY) * TILE_PX;
    ctx.fillStyle = floorTile(rect.kind, seedKey + rect.index, 0, 0);
    ctx.fillRect(doorPx, doorPy, TILE_PX, TILE_PX);
    ctx.fillStyle = roomAccent(rect.kind);
    ctx.fillRect(doorPx + 1, doorPy + 3, TILE_PX - 2, 1);
    // Name plate on the top edge. The type is sized for the phone
    // the game is watched on: at 5px the plates were illegible at
    // deck scale (playtest note, Oct 27), so the plate is 11px tall
    // with 8px type, its width measured rather than estimated.
    const label = rect.name.toUpperCase();
    ctx.font = "8px monospace";
    const plateW = Math.ceil(ctx.measureText(label).width) + 8;
    const plateX = wx + Math.floor((ww - plateW) / 2);
    ctx.fillStyle = "#141a26";
    ctx.fillRect(plateX, wy - 2, plateW, 11);
    ctx.fillStyle = "#d7e2f0";
    ctx.textAlign = "center";
    ctx.fillText(label, wx + ww / 2, wy + 6);
    ctx.fillStyle = roomAccent(rect.kind);
    ctx.fillRect(plateX, wy - 2, 3, 11);
    // Props: floor decals first, then furniture.
    for (const pass of [true, false]) {
      for (const prop of room.props) {
        if (prop.under !== pass) continue;
        const size = propSize(prop.name);
        const px =
          (prop.tx + OX) * TILE_PX + Math.floor((TILE_PX - size.w) / 2);
        const py =
          (prop.ty + OY) * TILE_PX + Math.floor((TILE_PX - size.h) / 2);
        ctx.drawImage(propCanvas(prop.name), px, py);
      }
    }
  }
  // Side doors between neighbours.
  for (const door of layout.sideDoors.values()) {
    for (const pt of [door.approachA, door.mid, door.approachB]) {
      const px = (Math.floor(pt.x) + OX) * TILE_PX;
      const py = (Math.floor(pt.y) + OY) * TILE_PX;
      ctx.fillStyle = "#252e3d";
      ctx.fillRect(px, py, TILE_PX, TILE_PX);
    }
    const sillX = (Math.floor(door.mid.x) + OX) * TILE_PX;
    const sillY = (Math.floor(door.mid.y) + OY) * TILE_PX;
    ctx.fillStyle = "#8fa6c4";
    ctx.fillRect(sillX + 3, sillY + 1, 1, TILE_PX - 2);
  }
  return canvas;
}

/**
 * The one hull the cutaway's two decks share: an angular plated
 * silhouette spanning both plans and the structural band between
 * them. The band is dressed as the ship's spine (keel beams,
 * ribs, tanks, and the lift shafts piercing it), the engine block
 * sits at the stern on the hull's own midline, and seeded
 * fittings break the top edge. Painted once; the bare deck plans
 * blit over it, their margins transparent, so the two plans read
 * as floors of one vessel instead of two capsules.
 */
function renderCutawayHull(
  shipLayout: ShipLayout,
  ship: Ship,
  gapY: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = shipLayout.widthPx;
  canvas.height = shipLayout.heightPx + gapY;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  const plan = shipLayout.decks[0] as DeckLayout;
  const { seedKey, deckW } = plan;
  const top = (OY - 1) * TILE_PX;
  const bottom = gapY + (OY + DECK_H + 1) * TILE_PX;
  const midY = (top + bottom) / 2;
  const sternX = (OX - 1) * TILE_PX;
  const bowStartX = (OX + deckW) * TILE_PX;
  const bowTipX = (OX + deckW + 7) * TILE_PX;
  // Silhouette: straight runs and angled facets, no capsule curve.
  ctx.beginPath();
  ctx.moveTo(sternX + 6, top);
  ctx.lineTo(bowStartX - 30, top);
  ctx.lineTo(bowTipX - 16, top + (midY - top) * 0.36);
  ctx.lineTo(bowTipX, midY);
  ctx.lineTo(bowTipX - 16, bottom - (bottom - midY) * 0.36);
  ctx.lineTo(bowStartX - 30, bottom);
  ctx.lineTo(sternX + 6, bottom);
  ctx.quadraticCurveTo(sternX - 8, midY, sternX + 6, top);
  ctx.closePath();
  ctx.fillStyle = "#272f3f";
  ctx.fill();
  ctx.strokeStyle = "#46536b";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Plating seams on the top and bottom bands.
  ctx.strokeStyle = "#1d2534";
  for (let i = 0; i < 12; i++) {
    const x =
      sternX + 16 + hash01(seedKey, i * 5 + 21) * (bowStartX - sternX - 40);
    ctx.beginPath();
    ctx.moveTo(x, top + 2);
    ctx.lineTo(x, top + 13);
    ctx.moveTo(x, bottom - 13);
    ctx.lineTo(x, bottom - 2);
    ctx.stroke();
  }
  // Fittings breaking the top edge: a mast, a dome, a dish block.
  ctx.fillStyle = "#39465c";
  const mastX = sternX + (bowStartX - sternX) * 0.3;
  ctx.fillRect(mastX, top - 6, 2, 6);
  ctx.fillStyle = "#e8a33d";
  ctx.fillRect(mastX, top - 7, 2, 1);
  ctx.fillStyle = "#39465c";
  const domeX = sternX + (bowStartX - sternX) * 0.52;
  ctx.beginPath();
  ctx.arc(domeX, top, 5, Math.PI, 0);
  ctx.fill();
  const dishX = sternX + (bowStartX - sternX) * 0.72;
  ctx.fillRect(dishX, top - 4, 8, 4);
  ctx.fillStyle = "#55678a";
  ctx.fillRect(dishX + 1, top - 6, 6, 2);
  // The spine band between the decks: keel beams, ribs, tanks,
  // and the lift shafts piercing through.
  const bandTop = (OY + DECK_H + 1) * TILE_PX;
  const bandBottom = gapY + (OY - 1) * TILE_PX;
  const bandMid = (bandTop + bandBottom) / 2;
  ctx.fillStyle = "#20293a";
  ctx.fillRect(sternX + 10, bandMid - 3, bowStartX - sternX - 44, 2);
  ctx.fillRect(sternX + 10, bandMid + 2, bowStartX - sternX - 44, 2);
  ctx.fillStyle = "#1d2534";
  for (let x = sternX + 18; x < bowStartX - 40; x += 18) {
    ctx.fillRect(x, bandTop + 2, 1, bandBottom - bandTop - 4);
  }
  const tank = propCanvas("tank");
  for (let i = 0; i < 5; i++) {
    const tx =
      sternX + 26 + hash01(seedKey, i * 7 + 3) * (bowStartX - sternX - 90);
    ctx.drawImage(tank, tx, bandMid - 3);
  }
  for (const lift of plan.lifts) {
    const lx = (lift.x + OX) * TILE_PX;
    ctx.fillStyle = "#141b28";
    ctx.fillRect(lx, bandTop, TILE_PX * 2, bandBottom - bandTop);
    ctx.fillStyle = "#39465c";
    ctx.fillRect(lx, bandTop, 2, bandBottom - bandTop);
    ctx.fillRect(lx + TILE_PX * 2 - 2, bandTop, 2, bandBottom - bandTop);
  }
  // Engine block at the stern, on the hull's own midline.
  ctx.fillStyle = "#39465c";
  ctx.fillRect((OX - 4) * TILE_PX, midY - 20, TILE_PX * 3 + 4, 40);
  ctx.fillStyle = "#232c3d";
  for (const dy of [-14, -4, 6]) {
    ctx.fillRect((OX - 4) * TILE_PX, midY + dy, 3, 7);
  }
  // The ship's name on the dorsal plating.
  ctx.fillStyle = "#8fa6c4";
  ctx.font = "bold 7px monospace";
  ctx.textAlign = "left";
  ctx.fillText(ship.name.toUpperCase(), sternX + 64, top + 11);
  return canvas;
}

// ------------------------------------------------------------ the view

export interface DeckFrameOpts {
  now: number;
  dtMs: number;
  /** Milliseconds per sim tick at the current speed; Infinity paused. */
  tickMs: number;
  /** Snap movement instead of gliding (high speeds). */
  snap: boolean;
  selectedId: string | null;
  /** Last system each member worked, from work events (main.ts). */
  workSystem: ReadonlyMap<string, string | null>;
  /**
   * Members seated at a table game, from leisure_game events
   * (main.ts): their seat index within the game, in the game's own
   * room. Presentation only: the deck seats them facing each other
   * while the game lasts.
   */
  gameSeat: ReadonlyMap<string, { room: number; seat: number }>;
  /**
   * Members seated at a council sitting, from council_convened
   * events (main.ts): their seat index at the mess tables, in seat
   * order. Presentation only, like the game seats; main.ts passes
   * presentation copies of the officers with their room set to the
   * mess, so the deck walks them across the ship to the sitting.
   */
  councilSeat: ReadonlyMap<string, { room: number; seat: number }>;
  /**
   * Members standing at a council sitting's open end: slot 0 the
   * accused, slot 1 the security chief beside them. Same room
   * convention as councilSeat.
   */
  councilStand: ReadonlyMap<string, { room: number; slot: number }>;
  /**
   * Members carrying a prop in transit, derived in main.ts from
   * move events: "tool" toward a damaged system's room, "crate"
   * out of the cargo bay. Empty hands draw nothing.
   */
  carry: ReadonlyMap<string, "tool" | "crate">;
  /** Minutes into the ship's day (0-1439): the day/night light. */
  dayMinutes: number;
  /** Elapsed sim ticks this run: the wear layer's clock for ship age. */
  tick: number;
  /** Playback rate in ticks per second; 0 when paused (sky drift). */
  speedTps: number;
  /** The ship is riding out a radiation storm (the exterior's lights). */
  storm?: boolean;
  /** Paint the wear layer into the deck (default true). The wear
   *  itself keeps accruing either way; this gates only the scars'
   *  showing, a view toggle from the viewer's menu row. */
  showWear?: boolean;
  /** Draw speech and thought bubbles (default true). A view toggle,
   *  like showWear: the chatter itself is the chronicle's business. */
  showBubbles?: boolean;
  /** The meal window open at this tick, if any (the exterior's mess glow). */
  meal?: "breakfast" | "evening" | null;
  /**
   * The nearest active sensor contact, computed in main.ts from
   * the traffic system's geometry: the exterior shows her as a
   * distant lit shape crossing behind the hull. Null: empty sky.
   */
  contact?: ExteriorContact | null;
}

/**
 * One leg of a journey. Walks stay on one deck's grid; a lift leg is
 * the ride between decks, boarded and left at the same shaft point.
 * A cross-deck journey is walk, lift, walk, and nothing else.
 */
type Leg =
  | { kind: "walk"; deck: number; points: Array<{ x: number; y: number }> }
  | { kind: "lift"; toDeck: number; point: { x: number; y: number } };

interface PersonState {
  x: number;
  y: number;
  /** The deck the body is physically on (or fading out of). */
  deck: number;
  path: Array<{ x: number; y: number }>;
  /** Legs queued after the current walk. */
  legs: Leg[];
  /** A lift ride in progress: fade out, reappear, fade in. */
  transit: {
    toDeck: number;
    point: { x: number; y: number };
    phase: "out" | "in";
    t: number;
  } | null;
  /** Draw opacity: 1, except mid-transit. */
  alpha: number;
  facing: number;
  walkPhase: number;
  moving: boolean;
  atStation: boolean;
  workFx: number;
  /** The member.room last routed for (hop-distance snap math). */
  lastRoom: number;
  /** The room whose doors the body last routed from, physically. */
  anchorRoom: number;
  /** The body stands at a lift in a corridor, not inside anchorRoom. */
  atLift: boolean;
  stationKey: string;
  phase: number;
  /** Current glide speed, tiles per second (movement easing). */
  vel: number;
  /** The destination is a bunk or bed: draw horizontal on arrival. */
  lying: boolean;
  /** The destination is a chair: draw the seated posture on arrival. */
  seated: boolean;
}

interface Particle {
  /** The deck whose coordinates x and y are in: in the cutaway a
   *  spark belongs to one deck's pass, never both. */
  deck: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  colour: string;
}

const DAMAGE_COLOURS = ["#ffd76a", "#ffb35c", "#ff7847"];
const WELD_COLOURS = ["#eaf6ff", "#bfe0ff", "#7fb2ff"];
const MAX_PARTICLES = 200;

export class DeckView {
  private readonly ship: Ship;
  readonly shipLayout: ShipLayout;
  private readonly statics: [HTMLCanvasElement, HTMLCanvasElement];
  /** The shared hull painted beneath both bare decks (cutaway). */
  private readonly hullCanvas: HTMLCanvasElement;
  private readonly backdrop: SpaceBackdrop;
  /** The ship's accumulated scars, one layer per deck. */
  private readonly wears: [WearLayer, WearLayer];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly people = new Map<string, PersonState>();
  private readonly particles: Particle[] = [];
  private readonly damageAcc = new Map<number, number>();
  private readonly weldAcc = new Map<string, number>();
  private readonly bubbles = new BubbleLayer();
  /** The feel pass (./staging.ts): events staged in the world. */
  private readonly staging: StagingLayer;
  /** The hull exterior (./exterior.ts): the ship from outside. */
  private readonly exterior: ExteriorView;
  /** True while the main canvas shows the exterior, not a deck. */
  private viewExterior = false;
  /** Static deck with the wear layer composited in: one blit a frame. */
  private readonly composites: [HTMLCanvasElement, HTMLCanvasElement];
  /** The staging sync's input rows, mutated in place every frame. */
  private readonly stageStates: StageSystemState[] = [];
  /** Resolved systems per room index; fixed for the life of a ship. */
  private readonly roomSystems = new Map<number, ShipSystem[]>();
  // Frame scratch, cleared and reused in place: the frame loop
  // allocates nothing it can avoid, per the performance pass.
  private readonly slotScratch = new Map<string, number>();
  private readonly perRoomScratch = new Map<number, number>();
  private readonly restSlotScratch = new Map<string, number>();
  private readonly restPerRoomScratch = new Map<number, number>();
  private readonly seatSlotScratch = new Map<string, number>();
  private readonly seatPerRoomScratch = new Map<number, number>();
  private readonly exSlotScratch = new Map<string, number>();
  private readonly exPerRoomScratch = new Map<number, number>();
  /** room * 100 + table keys with a game board to draw this frame. */
  private readonly boardScratch = new Set<number>();
  private readonly positionsScratch = new Map<
    string,
    { x: number; y: number }
  >();
  private readonly orderedScratch: CrewMember[] = [];
  /** Painted system labels, keyed per room by what the label says. */
  private readonly labelCache = new Map<
    number,
    { key: string; canvas: HTMLCanvasElement }
  >();
  /** Glow gradients, built once (per deck) instead of every frame. */
  private hydroGrad: CanvasGradient | null = null;
  private readonly reactorGrads: [CanvasGradient | null, CanvasGradient | null] =
    [null, null];
  private readonly engineGrads: [CanvasGradient | null, CanvasGradient | null] =
    [null, null];
  /** The staging layer's anchor resolver, bound once. */
  private readonly anchorFor = (
    id: string,
    deck: number,
  ): StageAnchor | null => this.anchorForSystem(id, deck);
  private readonly reducedMotionMq: MediaQueryList | null =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  private viewDeck = 0;
  /** Canvas y of the lower deck's origin in the cutaway: the upper
   *  deck's height plus the structural gap between the two plans. */
  private cutawayGapY = 0;

  constructor(ship: Ship, canvas: HTMLCanvasElement) {
    this.ship = ship;
    this.canvas = canvas;
    this.shipLayout = buildShipLayout(ship);
    this.cutawayGapY =
      (this.shipLayout.decks[0] as DeckLayout).heightPx + CUTAWAY_GAP_PX;
    this.applySize();
    this.statics = [
      renderStatic(this.shipLayout.decks[0], ship, true),
      renderStatic(this.shipLayout.decks[1], ship, true),
    ];
    this.hullCanvas = renderCutawayHull(
      this.shipLayout,
      ship,
      this.cutawayGapY,
    );
    this.backdrop = new SpaceBackdrop(
      this.shipLayout.seedKey,
      this.shipLayout.widthPx,
      this.shipLayout.heightPx + this.cutawayGapY,
    );
    // Hull exterior geometry for the wear layer, in the same pixels
    // renderStatic paints: the engine block at the stern, its three
    // exhaust slots, and the hull's top and bottom edges.
    // In the cutaway the decks are bare and share one hull, so
    // the deck wear layers keep their hull-band grime but the
    // engine block is parked offscreen: its soot belongs to the
    // shared hull, not to either plan.
    const wearGeom: WearGeom = {
      tile: TILE_PX,
      ox: OX,
      oy: OY,
      engineBlock: {
        x: (OX - 4) * TILE_PX,
        y: -999,
        w: TILE_PX * 3 + 4,
        h: 36,
      },
      exhaustSlots: [],
      hullTop: (OY - 1) * TILE_PX,
      hullBottom: (OY + DECK_H + 1) * TILE_PX,
      sternX: (OX - 1) * TILE_PX,
    };
    this.wears = [
      new WearLayer(this.shipLayout.decks[0], wearGeom),
      new WearLayer(this.shipLayout.decks[1], wearGeom),
    ];
    // The per-frame base image: the static deck with the wear layer
    // composited over it. Wear repaints are rare (bucketed signature
    // changes), so the composite is refreshed only then, and a frame
    // blits one canvas where it used to blit two.
    this.composites = [
      document.createElement("canvas"),
      document.createElement("canvas"),
    ];
    for (let d = 0; d < 2; d++) {
      const plan = this.shipLayout.decks[d] as DeckLayout;
      const composite = this.composites[d] as HTMLCanvasElement;
      composite.width = plan.widthPx;
      composite.height = plan.heightPx;
      const cctx = composite.getContext("2d");
      if (cctx !== null) {
        cctx.drawImage(this.statics[d] as HTMLCanvasElement, 0, 0);
      }
    }
    // Resolve each room's systems once: the list is fixed for the
    // life of the ship; only the conditions on the objects move.
    for (const plan of this.shipLayout.decks) {
      for (const room of plan.rooms) {
        if (room === undefined || room.systemIds.length === 0) continue;
        const systems: ShipSystem[] = [];
        for (const id of room.systemIds) {
          const system = ship.systemById(id);
          if (system !== undefined) systems.push(system);
        }
        if (systems.length > 0) {
          this.roomSystems.set(room.rect.index, systems);
        }
      }
    }
    this.ctx = canvas.getContext("2d");
    this.staging = new StagingLayer(
      () => this.reducedMotionMq?.matches ?? false,
    );
    this.exterior = new ExteriorView(ship, this.shipLayout, {
      tile: TILE_PX,
      ox: OX,
      oy: OY,
      deckH: DECK_H,
      corrY: CORR_Y,
    });
  }

  /** The deck the main canvas is showing: 0 upper, 1 lower. */
  get visibleDeck(): number {
    return this.viewDeck;
  }

  /** Rebuild one deck's composite after its wear layer repainted. */
  private refreshComposite(deckIndex: number): void {
    const composite = this.composites[deckIndex] as HTMLCanvasElement;
    const cctx = composite.getContext("2d");
    if (cctx === null) return;
    cctx.clearRect(0, 0, composite.width, composite.height);
    cctx.drawImage(this.statics[deckIndex] as HTMLCanvasElement, 0, 0);
    cctx.drawImage((this.wears[deckIndex] as WearLayer).canvas, 0, 0);
  }

  /** Show a deck. Crew, wear, and light all follow the one ship. */
  setDeck(deck: number): void {
    this.viewDeck = deck === 1 ? 1 : 0;
  }

  /** True while the main canvas shows the hull exterior. */
  get exteriorActive(): boolean {
    return this.viewExterior;
  }

  /**
   * Step outside, or come back in. The deck focus is untouched by
   * stepping out: coming back restores the deck that was showing.
   */
  setExterior(on: boolean): void {
    this.viewExterior = on;
    this.applySize();
  }

  /**
   * Size the canvas for the current presentation: the hull
   * exterior is one plan tall; the cutaway is both plans and the
   * gap between them. (The chart reads the canvas as it finds it
   * and centres itself, so it takes the cutaway's taller canvas
   * as given.)
   */
  private applySize(): void {
    this.canvas.width = this.shipLayout.widthPx;
    this.canvas.height = this.viewExterior
      ? this.shipLayout.heightPx
      : this.shipLayout.heightPx + this.cutawayGapY;
  }

  /**
   * The deck a tap on the hull belongs to (the exterior's own
   * sections), or null outside the ship or while inside.
   */
  pickSection(xPx: number, yPx: number): number | null {
    return this.viewExterior ? this.exterior.pickSection(xPx, yPx) : null;
  }

  /** The deck a room lives on. */
  deckOfRoom(room: number): number {
    return this.shipLayout.deckOfRoom[room] ?? 0;
  }

  /** The deck a person's body is on, or null before their first frame. */
  deckOfPerson(id: string): number | null {
    return this.people.get(id)?.deck ?? null;
  }

  /** An accusation was just spoken: bubble over the accuser. */
  speech(id: string): void {
    this.bubbles.speech(id, "bang");
  }

  /** A spoken line: the words themselves in a text bubble. */
  speechLine(id: string, text: string): void {
    this.bubbles.speechLine(id, text);
  }

  /** A council vote lands: the voter's token rises over their head. */
  stageVote(id: string, choice: string): void {
    this.bubbles.speech(
      id,
      choice === "for" ? "aye" : choice === "against" ? "nay" : "dots",
    );
  }

  // ------------------------------------------------------- feel pass
  //
  // The staging layer's feed points, called from main.ts's event
  // drain at the tick each event is displayed, the way the reference
  // viewer's effectsFor() consumes its event stream. Condition
  // crossings need no feed: the frame loop syncs live conditions
  // into the layer itself.

  /** A system's anchor on its own deck, for staging and telegraphs. */
  private anchorForSystem(
    systemId: string,
    deck: number,
  ): StageAnchor | null {
    const anchor = this.shipLayout.decks[deck]?.systemAnchor.get(systemId);
    return anchor === undefined ? null : { px: anchor.px, py: anchor.py };
  }

  /** Stage an event that belongs to one system, at its equipment. */
  private stageSystem(
    kind: "sabotage" | "repaired",
    systemId: string,
  ): void {
    const system = this.ship.systemById(systemId);
    if (system === undefined) return;
    const deck = this.shipLayout.deckOfRoom[system.room] ?? 0;
    this.staging.stage(
      kind,
      systemId,
      deck,
      this.anchorForSystem(systemId, deck),
      performance.now(),
    );
    // The same moment, told on the hull: the exterior keeps its
    // own staging at the system's hull station.
    this.exterior.noteEvent(kind, systemId, performance.now());
  }

  /**
   * A sabotage was just committed: flash the act at the system for
   * the god-witness. In-fiction, nothing has been seen yet.
   */
  stageSabotage(systemId: string): void {
    this.stageSystem("sabotage", systemId);
  }

  /** A repair just completed: the green ring at the system. */
  stageRepaired(systemId: string): void {
    this.stageSystem("repaired", systemId);
  }

  /** A radiation storm just arrived: the nav lights strobe. */
  stageStorm(): void {
    this.staging.stage("storm", null, -1, null, performance.now());
  }

  /** A room outline that pulses briefly (an alert named this room). */
  private flash: { room: number; startMs: number } | null = null;

  /**
   * Flash a room's outline for about two seconds of wall time. The
   * caller switches to the room's deck first; a room on the hidden
   * deck simply never paints.
   */
  flashRoom(room: number): void {
    this.flash = { room, startMs: -1 };
  }

  /** The member whose body sits at canvas pixel (xPx, yPx), if any. */
  pick(xPx: number, yPx: number): string | null {
    let best: string | null = null;
    let bestD = (TILE_PX * 0.9 + 3) ** 2;
    for (const [id, st] of this.people) {
      if (st.deck !== this.viewDeck || st.alpha < 0.5) continue;
      const px = (st.x + OX) * TILE_PX;
      const py = (st.y + OY) * TILE_PX - 6;
      const d = (px - xPx) ** 2 + (py - yPx) ** 2;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private walkableAt(plan: DeckLayout, x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= plan.deckW || ty >= DECK_H) {
      return false;
    }
    return plan.walkable[ty * plan.deckW + tx] === 1;
  }

  private los(
    plan: DeckLayout,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): boolean {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / 0.2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.walkableAt(plan, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) {
        return false;
      }
    }
    return true;
  }

  private smooth(
    plan: DeckLayout,
    pts: Array<{ x: number; y: number }>,
  ): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.los(plan, pts[i] as { x: number; y: number }, pts[j] as { x: number; y: number })) {
        j--;
      }
      out.push(pts[j] as { x: number; y: number });
      i = j;
    }
    return out;
  }

  /** Room to room on one deck: in-room, side door, or via corridor. */
  private route(
    plan: DeckLayout,
    fromRoom: number,
    toRoom: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const rooms = plan.rooms;
    if (fromRoom === toRoom) {
      const room = rooms[fromRoom];
      const pts = [start];
      if (room !== undefined && !this.los(plan, start, end)) pts.push(room.center);
      pts.push(end);
      return this.smooth(plan, pts);
    }
    const sideKey = `${Math.min(fromRoom, toRoom)}|${Math.max(fromRoom, toRoom)}`;
    const side = plan.sideDoors.get(sideKey);
    const a = rooms[fromRoom];
    const b = rooms[toRoom];
    if (side !== undefined && a !== undefined && b !== undefined) {
      const fromA = side.a === fromRoom;
      const approachFrom = fromA ? side.approachA : side.approachB;
      const approachTo = fromA ? side.approachB : side.approachA;
      const pts = [start];
      if (!this.los(plan, start, approachFrom)) pts.push(a.center);
      pts.push(approachFrom, side.mid, approachTo);
      if (!this.los(plan, approachTo, end)) pts.push(b.center);
      pts.push(end);
      return this.smooth(plan, pts);
    }
    if (a === undefined || b === undefined) return [end];
    const pts = [start];
    if (!this.los(plan, start, a.doorInside)) pts.push(a.center);
    pts.push(
      a.doorInside,
      a.doorTile,
      { x: a.doorTile.x, y: CORR_MID },
      { x: b.doorTile.x, y: CORR_MID },
      b.doorTile,
      b.doorInside,
    );
    if (!this.los(plan, b.doorInside, end)) pts.push(b.center);
    pts.push(end);
    return this.smooth(plan, pts);
  }

  /** Out of a room to a point on its deck's corridor (a lift). */
  private routeToPoint(
    plan: DeckLayout,
    fromRoom: number,
    start: { x: number; y: number },
    point: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const room = plan.rooms[fromRoom];
    if (room === undefined) return this.corridorHop(plan, start, point);
    const pts = [start];
    if (!this.los(plan, start, room.doorInside)) pts.push(room.center);
    pts.push(
      room.doorInside,
      room.doorTile,
      { x: room.doorTile.x, y: CORR_MID },
      { x: point.x, y: CORR_MID },
      point,
    );
    return this.smooth(plan, pts);
  }

  /** From a point on the corridor (a lift) into a room's station. */
  private routeFromPoint(
    plan: DeckLayout,
    point: { x: number; y: number },
    toRoom: number,
    end: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const room = plan.rooms[toRoom];
    if (room === undefined) return [point, end];
    const pts = [
      point,
      { x: point.x, y: CORR_MID },
      { x: room.doorTile.x, y: CORR_MID },
      room.doorTile,
      room.doorInside,
    ];
    if (!this.los(plan, room.doorInside, end)) pts.push(room.center);
    pts.push(end);
    return this.smooth(plan, pts);
  }

  /** Along the corridor from one corridor point to another. */
  private corridorHop(
    plan: DeckLayout,
    start: { x: number; y: number },
    point: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    return this.smooth(plan, [
      start,
      { x: start.x, y: CORR_MID },
      { x: point.x, y: CORR_MID },
      point,
    ]);
  }

  /** The lift shaft nearest to a position, by corridor distance. */
  private nearestLift(pos: { x: number; y: number }): LiftShaft {
    let best = this.shipLayout.lifts[0] as LiftShaft;
    let bestD = Number.POSITIVE_INFINITY;
    for (const lift of this.shipLayout.lifts) {
      const d = Math.abs(lift.point.x - pos.x) + Math.abs(lift.point.y - pos.y) * 0.25;
      if (d < bestD) {
        bestD = d;
        best = lift;
      }
    }
    return best;
  }

  /**
   * Build the leg list from the body's physical position to a
   * station. Same deck: one walk. Other deck: walk to the nearest
   * lift, ride, walk in. A body standing in a corridor (off a lift,
   * or routed from a room on the other deck) starts from the
   * corridor, not from a stale room's doors.
   */
  private buildLegs(
    st: PersonState,
    member: CrewMember,
    end: { x: number; y: number },
  ): Leg[] {
    const layout = this.shipLayout;
    const fromDeck = st.deck;
    const toDeck = layout.deckOfRoom[member.room] ?? fromDeck;
    const start = { x: st.x, y: st.y };
    const corridorStart =
      st.atLift || (layout.deckOfRoom[st.anchorRoom] ?? fromDeck) !== fromDeck;
    if (toDeck === fromDeck) {
      const plan = layout.decks[fromDeck] as DeckLayout;
      const points = corridorStart
        ? this.routeFromPoint(plan, start, member.room, end)
        : this.route(plan, st.anchorRoom, member.room, start, end);
      return [{ kind: "walk", deck: fromDeck, points }];
    }
    const lift = this.nearestLift(start);
    const fromPlan = layout.decks[fromDeck] as DeckLayout;
    const toPlan = layout.decks[toDeck] as DeckLayout;
    const first = corridorStart
      ? this.corridorHop(fromPlan, start, lift.point)
      : this.routeToPoint(fromPlan, st.anchorRoom, start, lift.point);
    return [
      { kind: "walk", deck: fromDeck, points: first },
      { kind: "lift", toDeck, point: lift.point },
      {
        kind: "walk",
        deck: toDeck,
        points: this.routeFromPoint(toPlan, lift.point, member.room, end),
      },
    ];
  }

  /**
   * Load the next queued leg: a walk becomes the current path, a
   * lift starts its fade. Called when a walk runs out and when a
   * ride completes, so legs chain without a frame between them.
   */
  private advanceLegs(st: PersonState): void {
    while (st.path.length === 0 && st.transit === null && st.legs.length > 0) {
      const leg = st.legs.shift() as Leg;
      if (leg.kind === "walk") {
        st.path = leg.points.slice();
        return;
      }
      st.transit = {
        toDeck: leg.toDeck,
        point: leg.point,
        phase: "out",
        t: 0,
      };
    }
  }

  private hopDist(a: number, b: number): number {
    if (a === b) return 0;
    const dist = new Map<number, number>([[a, 0]]);
    const queue = [a];
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      const d = dist.get(cur) as number;
      for (const n of this.ship.rooms[cur]?.neighbors ?? []) {
        if (!dist.has(n)) {
          if (n === b) return d + 1;
          dist.set(n, d + 1);
          queue.push(n);
        }
      }
    }
    return 99;
  }

  private stationFor(
    member: CrewMember,
    slot: number,
    workSystem: ReadonlyMap<string, string | null>,
    bunkIndex: number,
    seatIndex: number,
    gameSeat: { room: number; seat: number } | undefined,
    exIndex: number,
    councilSeat: { room: number; seat: number } | undefined,
    councilStand: { room: number; slot: number } | undefined,
  ): {
    point: { x: number; y: number };
    key: string;
    fx: number;
    lying: boolean;
    seated: boolean;
  } {
    const plan = this.shipLayout.decks[
      this.shipLayout.deckOfRoom[member.room] ?? 0
    ] as DeckLayout;
    const room = plan.rooms[member.room];
    const seedKey = this.shipLayout.seedKey;
    const num = Number(member.id.replace(/\D/g, "")) || 0;
    if (room === undefined) {
      return {
        point: { x: 2.5, y: CORR_Y + 1.5 },
        key: "void",
        fx: 0,
        lying: false,
        seated: false,
      };
    }
    if (member.activity === "rest" && room.bunks.length > 0) {
      // Resting crew lie down: a bunk in quarters, a bed in medbay,
      // whichever this room offers. The position is the engine's
      // (their room, their activity); only the posture is ours.
      const idx = (bunkIndex >= 0 ? bunkIndex : 0) % room.bunks.length;
      const bunk = room.bunks[idx] as { x: number; y: number };
      return {
        point: { x: bunk.x, y: bunk.y },
        key: `b:${member.room}:${idx}`,
        fx: 0,
        lying: true,
        seated: false,
      };
    }
    if (
      councilStand !== undefined &&
      councilStand.room === member.room
    ) {
      // The open end of the mess: the accused stands facing the
      // table, the security chief a step beside them. The point is
      // read off the room's own rectangle, south edge inside.
      const rect = room.rect;
      return {
        point: {
          x: rect.x + rect.w / 2 - 0.9 + councilStand.slot * 1.8,
          y: rect.y + rect.h - 1.3,
        },
        key: `cs:${member.room}:${councilStand.slot}`,
        fx: 0,
        lying: false,
        seated: false,
      };
    }
    if (
      councilSeat !== undefined &&
      councilSeat.room === member.room &&
      room.seats.length > 0
    ) {
      // A council sitting: the officers take the mess chairs in
      // seat order for the sitting's span (main.ts holds the
      // roster from the convened event).
      const idx = councilSeat.seat % room.seats.length;
      const seat = room.seats[idx] as { x: number; y: number };
      return {
        point: { x: seat.x, y: seat.y },
        key: `cc:${member.room}:${councilSeat.seat}`,
        fx: 0,
        lying: false,
        seated: true,
      };
    }
    if (
      gameSeat !== undefined &&
      gameSeat.room === member.room &&
      room.seats.length > 0
    ) {
      // A table game in progress (main.ts holds the game's roster
      // from its event): the players sit at one table, consecutive
      // seats facing each other across it, for as long as the game
      // lasts and they stay in the room.
      const idx = gameSeat.seat % room.seats.length;
      const seat = room.seats[idx] as { x: number; y: number };
      return {
        point: { x: seat.x, y: seat.y },
        key: `g:${member.room}:${gameSeat.seat}`,
        fx: 0,
        lying: false,
        seated: true,
      };
    }
    if (
      member.activity === "eat" &&
      room.rect.kind === "mess" &&
      seatIndex >= 0 &&
      seatIndex < room.seats.length
    ) {
      // Eating in the mess is eating at table: the member takes the
      // next chair in table order for their seat index among the
      // room's eaters. More eaters than chairs stand, as they do
      // now; the snapshot signal is the activity and the room, the
      // chair itself is presentation.
      const seat = room.seats[seatIndex] as { x: number; y: number };
      return {
        point: { x: seat.x, y: seat.y },
        key: `s:${member.room}:${seatIndex}`,
        fx: 0,
        lying: false,
        seated: true,
      };
    }
    if (
      member.activity === "exercise" &&
      room.rect.kind === "gym" &&
      room.mats.length > 0
    ) {
      // Exercise happens on the equipment: one member per mat, in
      // roster order, the way resting crew take bunks.
      const idx = (exIndex >= 0 ? exIndex : 0) % room.mats.length;
      const mat = room.mats[idx] as { x: number; y: number };
      return {
        point: { x: mat.x, y: mat.y },
        key: `x:${member.room}:${idx}`,
        fx: 0,
        lying: false,
        seated: false,
      };
    }
    if (member.activity === "work" || member.activity === "repair") {
      let target: WorkPoint | undefined;
      if (member.activity === "repair" && member.repairTarget !== null) {
        target = room.stations.find((s) => s.systemId === member.repairTarget);
      }
      if (target === undefined && member.activity === "work") {
        const ws = workSystem.get(member.id);
        if (ws !== null && ws !== undefined) {
          target = room.stations.find((s) => s.systemId === ws);
        }
      }
      if (target === undefined) {
        const tagByKind: Record<string, string> = {
          hydroponics: "racks",
          mess: "counter",
          bridge: "console",
          lab: "bench",
          cargo: "crates",
          medbay: "beds",
          quarters: "locker",
          gym: "weights",
          airlock: "suits",
          engineering: "machine",
        };
        const tag = tagByKind[room.rect.kind];
        target =
          room.stations.find((s) => s.tag === tag) ?? room.stations[0];
      }
      if (target !== undefined) {
        return {
          point: { x: target.x, y: target.y },
          key: `w:${member.room}:${target.systemId ?? target.tag}`,
          fx: target.fx,
          lying: false,
          seated: false,
        };
      }
    }
    // A reader sits where they stand: same tile, seated posture,
    // and the body pass puts a book in their hands.
    const seated = member.activity === "read";
    const tiles = room.standTiles;
    if (tiles.length === 0) {
      return {
        point: room.center,
        key: `i:${member.room}:c`,
        fx: 0,
        lying: false,
        seated,
      };
    }
    const base = Math.floor(hash01(seedKey, num * 29 + member.room * 7) * tiles.length);
    const tile = tiles[(base + slot) % tiles.length] as { x: number; y: number };
    const jx = (hash01(seedKey, num * 53 + member.room) - 0.5) * 0.3;
    const jy = (hash01(seedKey, num * 59 + member.room) - 0.5) * 0.3;
    return {
      point: { x: tile.x + jx, y: tile.y + jy },
      key: `i:${member.room}:${(base + slot) % tiles.length}`,
      fx: 0,
      lying: false,
      seated,
    };
  }

  /**
   * Everything the minimap needs, read off live view state: each
   * member's deck, room, and position within that room as fractions.
   */
  minimapSnapshot(
    crew: readonly CrewMember[],
  ): Array<{
    id: string;
    deck: number;
    room: number;
    fx: number;
    fy: number;
  }> {
    const out: Array<{
      id: string;
      deck: number;
      room: number;
      fx: number;
      fy: number;
    }> = [];
    for (const m of crew) {
      const st = this.people.get(m.id);
      if (st === undefined) continue;
      const plan = this.shipLayout.decks[st.deck] as DeckLayout;
      const room = plan.rooms[m.room];
      if (room === undefined) continue;
      out.push({
        id: m.id,
        deck: st.deck,
        room: m.room,
        fx: (st.x - room.rect.x) / room.rect.w,
        fy: (st.y - room.rect.y) / room.rect.h,
      });
    }
    return out;
  }

  /**
   * One deck's painting passes, in the deck's own coordinates: the
   * caller has translated the context to the deck's place in the
   * cutaway. Bodies, bubbles, sparks and staged events are this
   * deck's only; the movement that placed them is the frame's,
   * shared across decks, so nothing about how the crew moves is
   * redrawn or re-timed by there being two decks on the canvas.
   */
  private drawDeck(
    ctx: CanvasRenderingContext2D,
    deckIndex: number,
    crew: readonly CrewMember[],
    opts: DeckFrameOpts,
    now: number,
    dt: number,
    light: { dark: number; warm: number },
  ): void {
    const ship = this.ship;
    const layout = this.shipLayout.decks[deckIndex] as DeckLayout;
    ctx.drawImage(
      (opts.showWear === false
        ? this.statics[deckIndex]
        : this.composites[deckIndex]) as HTMLCanvasElement,
      0,
      0,
    );
    // The deck's name, on a plate in the top margin: with both
    // plans on one canvas, the plans say which is which themselves.
    const tag = deckIndex === 0 ? "DECK 1" : "DECK 2";
    ctx.font = "8px monospace";
    const tagW = Math.ceil(ctx.measureText(tag).width) + 8;
    ctx.fillStyle = "#141a26";
    ctx.fillRect(3, 3, tagW, 11);
    ctx.fillStyle = "#8fa6c4";
    ctx.textAlign = "left";
    ctx.fillText(tag, 7, 11);
    // ---- the ship's light for the hour: a tint over the deck, and
    // everything that emits light drawn after it, so the night watch
    // reads as a lit ship in dark space, not a dark smear. The tint
    // is a translucent fill toward the phase colour (cool blue at
    // night, warm amber through the evening), so full night lands at
    // about 40% of the day's brightness.
    if (light.dark > 0.004) {
      const cr = Math.round(8 + (43 - 8) * light.warm);
      const cg = Math.round(14 + (26 - 14) * light.warm);
      const cb = Math.round(36 + (9 - 36) * light.warm);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${light.dark.toFixed(3)})`;
      ctx.fillRect(0, 0, layout.widthPx, layout.heightPx);
    }
    // Near stars stay crisp above the tint: they are outside the ship.
    this.backdrop.drawNear(ctx, now);

    // ---- hydroponics light sweep
    // The sweep gradient is built once in a canonical span and the
    // fill is translated to the sweep's position each frame: the
    // geometry moves, the gradient object does not get rebuilt.
    if (this.hydroGrad === null) {
      const grad = ctx.createLinearGradient(-12, 0, 12, 0);
      grad.addColorStop(0, "rgba(190,255,190,0)");
      grad.addColorStop(0.5, "rgba(190,255,190,0.10)");
      grad.addColorStop(1, "rgba(190,255,190,0)");
      this.hydroGrad = grad;
    }
    for (const room of layout.rooms) {
      if (room === undefined || room.rect.kind !== "hydroponics") continue;
      const rx = (room.rect.x + 1 + OX) * TILE_PX;
      const ry = (room.rect.y + 1 + OY) * TILE_PX;
      const rw = (room.rect.w - 2) * TILE_PX;
      const rh = (room.rect.h - 2) * TILE_PX;
      const sweepX = rx + ((now / 55) % (rw + 28)) - 14;
      ctx.save();
      ctx.translate(sweepX, 0);
      ctx.fillStyle = this.hydroGrad;
      ctx.fillRect(rx - sweepX, ry, rw, rh);
      ctx.restore();
    }

    // ---- reactor and engine glow, scaled by system condition
    // The glow gradients are built once per deck at their fixed
    // geometry, with the peak stop at full strength; the per-frame
    // pulse and condition ride on globalAlpha instead of the stops.
    const reactor = ship.systems.find((s) => s.kind === "reactor");
    if (reactor !== undefined && layout.reactorCore !== null) {
      const core = layout.reactorCore;
      const pulse = 0.8 + 0.2 * Math.sin(now / 800);
      const a = (0.3 + 0.6 * reactor.condition) * pulse;
      ctx.fillStyle = `rgba(255,170,60,${a.toFixed(3)})`;
      ctx.fillRect(core.x, core.y, core.w, core.h);
      const gx = core.x + core.w / 2;
      const gy = core.y + core.h / 2;
      let grad = this.reactorGrads[deckIndex];
      if (grad === null) {
        grad = ctx.createRadialGradient(gx, gy, 1, gx, gy, 17);
        grad.addColorStop(0, "rgba(255,150,50,0.22)");
        grad.addColorStop(1, "rgba(255,150,50,0)");
        this.reactorGrads[deckIndex] = grad;
      }
      ctx.globalAlpha = reactor.condition * pulse;
      ctx.fillStyle = grad;
      ctx.fillRect(gx - 17, gy - 17, 34, 34);
      ctx.globalAlpha = 1;
    }
    const engines = ship.systems.find((s) => s.kind === "engines");
    if (engines !== undefined) {
      const g = layout.engineGlow;
      const pulse = 0.75 + 0.25 * Math.sin(now / 1000 + 1);
      let grad = this.engineGrads[deckIndex];
      if (grad === null) {
        grad = ctx.createRadialGradient(g.x, g.y, 1, g.x, g.y, 20);
        grad.addColorStop(0, "rgba(140,200,255,0.30)");
        grad.addColorStop(1, "rgba(140,200,255,0)");
        this.engineGrads[deckIndex] = grad;
      }
      ctx.globalAlpha = engines.condition * pulse;
      ctx.fillStyle = grad;
      ctx.fillRect(g.x - 20, g.y - 20, 40, 40);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(190,225,255,${(0.25 + 0.6 * engines.condition).toFixed(3)})`;
      for (const dy of [-13, -4, 5]) {
        ctx.fillRect((OX - 4) * TILE_PX, g.y + dy - 4, 3, 6);
      }
    }

    // ---- navigation lights (a storm's arrival strobes them: the
    // staging layer holds the strobe envelope from the storm event)
    const strobe = this.staging.navStrobe(now);
    for (const light of layout.navLights) {
      const blink = 0.5 + 0.5 * Math.sin(now / 1300 + light.phase);
      ctx.globalAlpha = Math.min(1, 0.2 + 0.5 * blink + strobe);
      ctx.fillStyle = light.colour;
      ctx.fillRect(light.x - 1, light.y - 1, 3, 3);
      ctx.globalAlpha = blink > 0.55 || strobe > 0.3 ? 1 : 0.35;
      ctx.fillRect(light.x, light.y, 1, 1);
      if (strobe > 0.3) {
        ctx.globalAlpha = strobe * 0.5;
        ctx.fillRect(light.x - 2, light.y - 2, 5, 5);
      }
    }
    ctx.globalAlpha = 1;

    // ---- bridge main screen: a slow radar sweep
    if (layout.bridgeScreen !== null) {
      const s = layout.bridgeScreen;
      ctx.fillStyle = "#06281f";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const ang = ((now / 2400) % (Math.PI * 2));
      ctx.fillStyle = "#2ec4b6";
      ctx.fillRect(
        Math.round(cx + Math.cos(ang) * (s.w / 2 - 2)),
        Math.round(cy + Math.sin(ang) * 1.2),
        1,
        1,
      );
      ctx.fillStyle = "#1d7a6d";
      ctx.fillRect(s.x + 4, s.y + 1, 1, 1);
      ctx.fillRect(s.x + s.w - 6, s.y + 2, 1, 1);
    }

    // ---- damage overlays, labels, spark spawning
    for (const room of layout.rooms) {
      if (room === undefined) continue;
      const systems = this.roomSystems.get(room.rect.index);
      if (systems === undefined || systems.length === 0) continue;
      let worst = systems[0] as ShipSystem;
      for (const s of systems) if (s.condition < worst.condition) worst = s;
      const { rect } = room;
      const rx = (rect.x + OX) * TILE_PX;
      const ry = (rect.y + OY) * TILE_PX;
      if (worst.condition < 0.6) {
        const flicker = hash01(layout.seedKey, rect.index * 97 + Math.floor(now / 110));
        const base = worst.condition < 0.3 ? 0.11 : 0.06;
        ctx.fillStyle = `rgba(255,110,50,${(base * (flicker > 0.4 ? 1 : 0.3)).toFixed(3)})`;
        ctx.fillRect(rx + TILE_PX, ry + TILE_PX, (rect.w - 2) * TILE_PX, (rect.h - 2) * TILE_PX);
        // Spawn damage sparks from the hurting system's equipment.
        const rate = worst.condition < 0.3 ? 26 : 9;
        let acc = (this.damageAcc.get(rect.index) ?? 0) + rate * dt;
        const anchor = layout.systemAnchor.get(worst.id);
        while (acc >= 1) {
          acc -= 1;
          if (this.particles.length >= MAX_PARTICLES) break;
          const h1 = hash01(layout.seedKey, rect.index * 131 + this.particles.length * 7 + Math.floor(now));
          const h2 = hash01(layout.seedKey, rect.index * 137 + this.particles.length * 11 + Math.floor(now / 37));
          this.particles.push({
            deck: deckIndex,
            x: (anchor?.px ?? rx + rect.w * 4) + (h1 - 0.5) * 6,
            y: (anchor?.py ?? ry + rect.h * 4) + (h2 - 0.5) * 4,
            vx: (h1 - 0.5) * 16,
            vy: -(5 + h2 * 15),
            life: 0.35 + h1 * 0.45,
            max: 0.8,
            colour: DAMAGE_COLOURS[Math.floor(h2 * 3)] ?? "#ffb35c",
          });
        }
        this.damageAcc.set(rect.index, acc);
      }
      if (worst.condition < 0.3) {
        // A red warning lamp over the room: a system in its worst
        // band strobes it fast (the staging layer owns the tempo).
        if (this.staging.lampOn(worst.id, now)) {
          const lx = rx + rect.w * 4;
          ctx.fillStyle = "#ff4a3c";
          ctx.fillRect(lx - 1, ry + 2, 3, 3);
          ctx.globalAlpha = 0.35;
          ctx.fillRect(lx - 2, ry + 1, 5, 5);
          ctx.globalAlpha = 1;
        }
      }
      // System label and condition bar, live from the ship. The bar
      // is two small fills per frame; the text is a painted sprite,
      // repainted only when what it says changes (the worst system,
      // its rounded percent, or its colour band): names and numbers
      // are never re-typeset per frame.
      const pct = Math.round(worst.condition * 100);
      const extra = systems.length > 1 ? ` +${systems.length - 1}` : "";
      ctx.fillStyle = "#141a26";
      ctx.fillRect(rx + 3, ry + rect.h * TILE_PX - 3, 34, 3);
      ctx.fillStyle =
        worst.condition < 0.3
          ? "#ff7a5c"
          : worst.condition < 0.6
            ? "#ffb35c"
            : "#7fd4a8";
      ctx.fillRect(rx + 3, ry + rect.h * TILE_PX - 3, 34 * worst.condition, 3);
      const band =
        worst.condition < 0.3 ? 2 : worst.condition < 0.6 ? 1 : 0;
      const labelKey = `${worst.id}|${pct}|${band}`;
      let label = this.labelCache.get(rect.index);
      if (label === undefined || label.key !== labelKey) {
        const text = `${worst.name} ${pct}%${extra}`;
        const canvas = document.createElement("canvas");
        const lctx = canvas.getContext("2d");
        if (lctx !== null) {
          lctx.font = "9px monospace";
          canvas.width = Math.max(1, Math.ceil(lctx.measureText(text).width) + 6);
          canvas.height = 13;
          lctx.font = "9px monospace";
          lctx.textAlign = "left";
          lctx.fillStyle = "#141a26";
          lctx.fillRect(0, 0, canvas.width, 13);
          lctx.fillStyle =
            band === 2
              ? "#ff8a6a"
              : band === 1
                ? "#ffb35c"
                : "#cfd8e6";
          lctx.fillText(text, 3, 10);
        }
        label = { key: labelKey, canvas };
        this.labelCache.set(rect.index, label);
      }
      ctx.drawImage(
        label.canvas,
        rx + 3,
        ry + rect.h * TILE_PX - 16,
      );
    }

    // ---- equipment lights
    for (const room of layout.rooms) {
      if (room === undefined) continue;
      for (const light of room.lights) {
        let alpha = 0.85;
        if (light.style === "pulse") {
          alpha = 0.35 + 0.6 * (0.5 + 0.5 * Math.sin(now / 650 + light.phase));
        } else if (light.style === "blink") {
          alpha = Math.sin(now / 420 + light.phase) > 0.3 ? 0.95 : 0.12;
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = light.colour;
        ctx.fillRect(light.px, light.py, 1, 1);
      }
    }
    ctx.globalAlpha = 1;

    // ---- welding sparks at the hands of anyone repairing
    for (const member of crew) {
      if (member.activity !== "repair") continue;
      const st = this.people.get(member.id);
      if (st === undefined || !st.atStation) continue;
      if (st.deck !== deckIndex) continue;
      let acc = (this.weldAcc.get(member.id) ?? 0) + 36 * dt;
      while (acc >= 1) {
        acc -= 1;
        if (this.particles.length >= MAX_PARTICLES) break;
        const h1 = hash01(layout.seedKey, this.particles.length * 13 + Math.floor(now / 17));
        const h2 = hash01(layout.seedKey, this.particles.length * 19 + Math.floor(now / 23));
        this.particles.push({
          deck: deckIndex,
          x: (st.x + OX) * TILE_PX + st.facing * 4,
          y: (st.y + OY) * TILE_PX - 7,
          vx: st.facing * (8 + h1 * 20),
          vy: -(3 + h2 * 13),
          life: 0.2 + h1 * 0.25,
          max: 0.45,
          colour: WELD_COLOURS[Math.floor(h2 * 3)] ?? "#bfe0ff",
        });
      }
      this.weldAcc.set(member.id, acc);
    }

    // ---- particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as Particle;
      if (p.deck !== deckIndex) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 1.6 * dt;
      p.vy *= 1 - 1.6 * dt;
      ctx.globalAlpha = Math.max(0, (p.life / p.max) * 0.95);
      ctx.fillStyle = p.colour;
      ctx.fillRect(p.x, p.y, 1, 1);
    }
    ctx.globalAlpha = 1;

    // ---- staged events (./staging.ts): the act, the blow, and the
    // mend, drawn over the deck's own sparks and under the crew: a
    // body can stand in front of the thing it just did.
    this.staging.draw(ctx, now, deckIndex);

    // ---- crew bodies
    // Bodies dim less than the deck at night (0.82 of full at the
    // darkest): crew carry their own small light in-fiction, and a
    // watch-stander must stay findable in a dark room. The dim is a
    // pre-tinted sprite variant from the bodies cache, bucketed so
    // a night costs the same drawImage as the day: no canvas filter
    // ever wraps this pass.
    const bodyDim = 1 - 0.18 * (light.dark / NIGHT_DARK);
    const dimBucket = Math.round(bodyDim / 0.05) * 0.05;
    const positions = this.positionsScratch;
    positions.clear();
    const ordered = this.orderedScratch;
    ordered.length = 0;
    for (const member of crew) ordered.push(member);
    ordered.sort(
      (a, b) =>
        (this.people.get(a.id)?.y ?? 0) - (this.people.get(b.id)?.y ?? 0),
    );
    for (const member of ordered) {
      const st = this.people.get(member.id);
      if (st === undefined) continue;
      // One deck at a time: the other deck's crew are the minimap's
      // dots, not ghosts on this plan. A body mid-fade in a lift is
      // drawn by the deck it is leaving, then by the deck it joins.
      if (st.deck !== deckIndex || st.alpha <= 0.01) continue;
      const sprites = getBodySprites(member, dimBucket);
      const working =
        (member.activity === "work" || member.activity === "repair") &&
        st.atStation;
      const seated = st.seated && !st.moving;
      const exercising =
        member.activity === "exercise" && !st.moving && !seated;
      // The wounded stand hunched: any open wound severity, or a
      // sickness past the point of hiding it, swaps the standing
      // frame for the hurt one. Seated, working, and walking keep
      // their own frames; a body in a bunk is the lying pass below.
      const hurt =
        !st.moving &&
        !seated &&
        member.body !== undefined &&
        (Object.values(member.body.wounds).some((w) => w.severity > 0) ||
          member.body.sick >= 0.4);
      let sprite = sprites.idle;
      if (st.moving) {
        sprite = Math.floor(st.walkPhase * 1.6) % 2 === 0 ? sprites.walk : sprites.idle;
      } else if (seated) {
        sprite = sprites.seated;
      } else if (hurt) {
        sprite = sprites.hurt;
      } else if (working) {
        sprite = Math.floor(now / 170) % 2 === 0 ? sprites.work : sprites.idle;
      } else if (exercising) {
        // On the machine: the two walk frames at the working tempo
        // are the machine's motion; no new clock is invented for it.
        sprite = Math.floor(now / 170) % 2 === 0 ? sprites.walk : sprites.idle;
      }
      const lying = st.lying && !st.moving;
      if (lying) sprite = sprites.idle;
      let bob = 0;
      let swayX = 0;
      if (st.moving) bob = -Math.abs(Math.sin(st.walkPhase * 2.2)) * 1;
      else if (working) bob = Math.sin(now / 95 + st.phase) * 0.4;
      else if (exercising) bob = Math.sin(now / 95 + st.phase) * 0.5;
      else if (seated) bob = Math.sin(now / 1700 + st.phase) * 0.15;
      else {
        bob = Math.sin(now / 1700 + st.phase) * 0.3;
        swayX = Math.sin(now / 2100 + st.phase) * 0.3;
      }
      const px = (st.x + OX) * TILE_PX + swayX;
      const py = (st.y + OY) * TILE_PX;
      positions.set(member.id, { x: px, y: py });
      // Shadow, then the selection ring, then the body.
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      if (lying) ctx.ellipse(px, py - 2, 6.5, 1.9, 0, 0, Math.PI * 2);
      else ctx.ellipse(px, py - 1, 4.4, 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
      if (opts.selectedId === member.id) {
        ctx.strokeStyle = `rgba(255,215,106,${(0.7 + 0.3 * Math.sin(now / 300)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(px, py - 1, 6, 2.4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.save();
      if (st.alpha < 1) {
        // In the lift: fade and shrink into the car.
        ctx.globalAlpha = st.alpha;
        ctx.translate(px, py - 6);
        ctx.scale(Math.max(st.alpha, 0.05), Math.max(st.alpha, 0.05));
        ctx.translate(-px, -(py - 6));
      }
      if (lying) {
        // Horizontal on the bunk, head toward the bow, breathing slow.
        const breathe = Math.sin(now / 2600 + st.phase) * 0.3;
        ctx.translate(px, py - 4 + breathe);
        ctx.rotate(Math.PI / 2);
        ctx.scale(BODY_SCALE, BODY_SCALE);
        ctx.drawImage(sprite, -4, -6);
      } else if (st.facing < 0) {
        ctx.translate(px, py + bob);
        ctx.scale(-BODY_SCALE, BODY_SCALE);
        ctx.drawImage(sprite, -4, -12);
      } else {
        ctx.translate(px, py + bob);
        ctx.scale(BODY_SCALE, BODY_SCALE);
        ctx.drawImage(sprite, -4, -12);
      }
      ctx.restore();
      // Full hands, drawn over the body: a traveller on an errand
      // carries the thing (main.ts derives whose hands are full and
      // with what; empty hands draw nothing).
      if (st.moving) {
        const carry = opts.carry.get(member.id);
        if (carry !== undefined) {
          const prop = propCanvas(carry === "tool" ? "toolcase" : "crate");
          ctx.drawImage(
            prop,
            Math.round(px + st.facing * 4 - prop.width / 2),
            Math.round(py - 9),
          );
        }
      }
      // A seated reader's book, open in front of the torso.
      if (seated && member.activity === "read") {
        const book = propCanvas("book");
        ctx.drawImage(
          book,
          Math.round(px + st.facing * 2 - book.width / 2),
          Math.round(py - 7),
        );
      }
    }

    // ---- game boards: on each table where a game is seated, for
    // as long as the game lasts. The pair across the table is in
    // the bodies above; the board is what they are looking at.
    const boards = this.boardScratch;
    boards.clear();
    for (const [id, seatInfo] of opts.gameSeat) {
      const st = this.people.get(id);
      if (st === undefined || st.deck !== deckIndex) continue;
      boards.add(seatInfo.room * 100 + Math.floor(seatInfo.seat / 2));
    }
    if (boards.size > 0) {
      const board = propCanvas("board");
      for (const boardKey of boards) {
        const room = layout.rooms[Math.floor(boardKey / 100)];
        if (room === undefined) continue;
        const table = boardKey % 100;
        const above = room.seats[table * 2];
        const below = room.seats[table * 2 + 1];
        if (above === undefined || below === undefined) continue;
        const cx = (above.x + OX) * TILE_PX;
        const cy = ((above.y + below.y) / 2 + OY) * TILE_PX;
        ctx.drawImage(
          board,
          Math.round(cx - board.width / 2),
          Math.round(cy - board.height / 2),
        );
      }
    }

    // ---- bubbles, above everything
    if (opts.showBubbles !== false) {
      this.bubbles.draw(ctx, now, positions, layout.widthPx);
    }

    // ---- alert flash: a pulsing outline on the room an alert named
    if (
      this.flash !== null &&
      (this.shipLayout.deckOfRoom[this.flash.room] ?? 0) === deckIndex
    ) {
      if (this.flash.startMs < 0) this.flash.startMs = now;
      const age = now - this.flash.startMs;
      const roomLayout = layout.rooms[this.flash.room];
      if (age > 2000 || roomLayout === undefined) {
        this.flash = null;
      } else {
        const rect = roomLayout.rect;
        const rx = (rect.x + OX) * TILE_PX;
        const ry = (rect.y + OY) * TILE_PX;
        const rw = rect.w * TILE_PX;
        const rh = rect.h * TILE_PX;
        const pulse = 0.5 + 0.5 * Math.sin(now / 130);
        const fade = age > 1600 ? 1 - (age - 1600) / 400 : 1;
        ctx.strokeStyle = `rgba(255, 215, 106, ${((0.45 + 0.55 * pulse) * fade).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
        ctx.fillStyle = `rgba(255, 215, 106, ${(0.07 * pulse * fade).toFixed(3)})`;
        ctx.fillRect(rx + 1, ry + 1, rw - 2, rh - 2);
      }
    }
  }


  frame(crew: readonly CrewMember[], opts: DeckFrameOpts): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const { ship } = this;
    const shipLayout = this.shipLayout;
    // The visible deck's plan. Every per-deck structure below (rooms,
    // anchors, screens, glows) reads from it; the hull, the sky, and
    // the ship's clock are shared.
    const layout = shipLayout.decks[this.viewDeck] as DeckLayout;
    const now = opts.now;
    const dt = Math.min(0.1, Math.max(0, opts.dtMs / 1000));
    ctx.imageSmoothingEnabled = false;

    // ---- the feel pass (./staging.ts): live conditions sync in
    // (a crossing into the critical band stages a failure where it
    // happened), telegraphs cough and smoke on the visible deck, and
    // the accumulated shake kicks offset the whole scene: the deck
    // and the sky move, the page around the canvas does not.
    // The sync's input rows are persistent objects, mutated in
    // place: a frame builds no fresh state for the staging layer.
    if (this.stageStates.length !== ship.systems.length) {
      this.stageStates.length = 0;
      for (const s of ship.systems) {
        this.stageStates.push({
          id: s.id,
          condition: s.condition,
          failed: s.failed,
          deck: shipLayout.deckOfRoom[s.room] ?? 0,
        });
      }
    } else {
      for (let i = 0; i < ship.systems.length; i++) {
        const s = ship.systems[i] as ShipSystem;
        const row = this.stageStates[i] as StageSystemState;
        row.condition = s.condition;
        row.failed = s.failed;
        row.deck = shipLayout.deckOfRoom[s.room] ?? 0;
      }
    }
    const crossed = this.staging.syncSystems(this.stageStates, now, this.anchorFor);
    // A crossing into failure is staged on the hull too, at the
    // system's station, whether or not anyone is outside to see it.
    for (const id of crossed) {
      this.exterior.noteEvent("failure", id, now);
    }
    this.staging.updateTelegraphs(now, dt * 1000, this.viewDeck, this.anchorFor);
    // The cutaway shows both decks, so the other deck's telegraphs
    // advance too; the shake stays the focus deck's, being the
    // whole scene's offset.
    this.staging.updateTelegraphs(
      now,
      dt * 1000,
      this.viewDeck === 0 ? 1 : 0,
      this.anchorFor,
    );
    const shake = this.staging.shakeOffset(now, this.viewDeck);
    ctx.save();
    if (shake.x !== 0 || shake.y !== 0) ctx.translate(shake.x, shake.y);

    // The moving sky behind the hull, then the ship herself.
    this.backdrop.drawFar(ctx, dt, opts.speedTps);
    // The ship's scars sit on the deck with the static layer, under
    // the night tint; the update repaints them only on bucket change.
    // Both decks' layers update every frame: a ship scars whether or
    // not anyone is watching that deck. A repaint refreshes that
    // deck's composite; the frame then blits the one composite.
    if (this.wears[0].update(ship, opts.tick)) this.refreshComposite(0);
    if (this.wears[1].update(ship, opts.tick)) this.refreshComposite(1);

    // Occupant slots, for spreading stand positions inside a room.
    // Scratch maps, cleared and reused: no allocation per frame.
    const slots = this.slotScratch;
    const perRoom = this.perRoomScratch;
    slots.clear();
    perRoom.clear();
    for (const member of crew) {
      const slot = perRoom.get(member.room) ?? 0;
      slots.set(member.id, slot);
      perRoom.set(member.room, slot + 1);
    }
    // Resting members in roster order per room: who takes which bunk.
    const restSlot = this.restSlotScratch;
    const restPerRoom = this.restPerRoomScratch;
    restSlot.clear();
    restPerRoom.clear();
    for (const member of crew) {
      if (member.activity !== "rest") continue;
      const idx = restPerRoom.get(member.room) ?? 0;
      restSlot.set(member.id, idx);
      restPerRoom.set(member.room, idx + 1);
    }
    // Eaters in the mess in roster order per room: who takes which
    // chair. Only the mess has chairs, so only its eaters are seated.
    const seatSlot = this.seatSlotScratch;
    const seatPerRoom = this.seatPerRoomScratch;
    seatSlot.clear();
    seatPerRoom.clear();
    for (const member of crew) {
      if (member.activity !== "eat") continue;
      if (ship.roomKind(member.room) !== "mess") continue;
      const idx = seatPerRoom.get(member.room) ?? 0;
      seatSlot.set(member.id, idx);
      seatPerRoom.set(member.room, idx + 1);
    }
    // Exercisers in roster order per room: who takes which mat.
    const exSlot = this.exSlotScratch;
    const exPerRoom = this.exPerRoomScratch;
    exSlot.clear();
    exPerRoom.clear();
    for (const member of crew) {
      if (member.activity !== "exercise") continue;
      const idx = exPerRoom.get(member.room) ?? 0;
      exSlot.set(member.id, idx);
      exPerRoom.set(member.room, idx + 1);
    }

    // ---- movement and stations
    for (const member of crew) {
      const num = Number(member.id.replace(/\D/g, "")) || 0;
      let st = this.people.get(member.id);
      const want = this.stationFor(
        member,
        slots.get(member.id) ?? 0,
        opts.workSystem,
        restSlot.get(member.id) ?? -1,
        seatSlot.get(member.id) ?? -1,
        opts.gameSeat.get(member.id),
        exSlot.get(member.id) ?? -1,
        opts.councilSeat.get(member.id),
        opts.councilStand.get(member.id),
      );
      const homeDeck = shipLayout.deckOfRoom[member.room] ?? 0;
      if (st === undefined) {
        st = {
          x: want.point.x,
          y: want.point.y,
          deck: homeDeck,
          path: [],
          legs: [],
          transit: null,
          alpha: 1,
          facing: 1,
          walkPhase: 0,
          moving: false,
          atStation: want.key.startsWith("w:"),
          workFx: want.fx,
          lastRoom: member.room,
          anchorRoom: member.room,
          atLift: false,
          stationKey: want.key,
          phase: hash01(shipLayout.seedKey, num * 67) * Math.PI * 2,
          vel: 0,
          lying: want.lying,
          seated: want.seated,
        };
        this.people.set(member.id, st);
      }
      if (st.lastRoom !== member.room || st.stationKey !== want.key) {
        const roomChanged = st.lastRoom !== member.room;
        const hops = this.hopDist(st.lastRoom, member.room);
        if (opts.snap || hops > 2 || st.transit !== null) {
          // Teleport-grade changes (snap speeds, sim jumps, catch-up
          // bursts) cut straight there, even mid-ride: at high speed
          // a deck change reads as a clean cut, never a stuck fade.
          st.x = want.point.x;
          st.y = want.point.y;
          st.deck = homeDeck;
          st.path = [];
          st.legs = [];
          st.transit = null;
          st.alpha = 1;
          st.vel = 0;
          st.anchorRoom = member.room;
          st.atLift = false;
          st.lying = want.lying;
          st.seated = want.seated;
        } else if (roomChanged || st.legs.length > 0) {
          // A real journey: legs from where the body physically is.
          // Cross-deck, that is walk, lift, walk; same deck, one walk.
          st.legs = this.buildLegs(st, member, want.point);
          st.path = [];
          st.vel = 0;
          st.lying = false;
          st.seated = false;
          this.advanceLegs(st);
        } else {
          // A new station in the same room, from a standstill.
          const plan = shipLayout.decks[homeDeck] as DeckLayout;
          st.path = this.route(
            plan,
            member.room,
            member.room,
            { x: st.x, y: st.y },
            want.point,
          );
          st.vel = 0;
          st.lying = false;
          st.seated = false;
        }
        st.lastRoom = member.room;
        st.stationKey = want.key;
        st.workFx = want.fx;
        st.atStation = false;
      }
      // Lift rides run on wall time, like the walks they join. The
      // body fades out at the origin deck's shaft, reappears at the
      // same shaft on the other deck, and fades back in: if the
      // viewer is watching the origin deck they simply vanish into
      // the lift, and the minimap tells the rest of the story.
      if (st.transit !== null) {
        const ride = st.transit;
        const step = opts.snap
          ? TRANSIT_PHASE_S
          : dt *
            (Number.isFinite(opts.tickMs)
              ? Math.min(opts.tickMs / 300, 1)
              : 1);
        ride.t += step;
        if (ride.phase === "out") {
          st.alpha = Math.max(0, 1 - ride.t / TRANSIT_PHASE_S);
          if (ride.t >= TRANSIT_PHASE_S) {
            st.deck = ride.toDeck;
            st.x = ride.point.x;
            st.y = ride.point.y;
            st.anchorRoom = member.room;
            st.atLift = true;
            ride.phase = "in";
            ride.t = 0;
            st.alpha = 0;
          }
        } else {
          st.alpha = Math.min(1, ride.t / TRANSIT_PHASE_S);
          if (ride.t >= TRANSIT_PHASE_S) {
            st.transit = null;
            st.alpha = 1;
            this.advanceLegs(st);
          }
        }
      }
      st.moving = false;
      if (st.transit === null && st.path.length > 0) {
        let remaining = 0;
        let px = st.x;
        let py = st.y;
        for (const pt of st.path) {
          remaining += Math.hypot(pt.x - px, pt.y - py);
          px = pt.x;
          py = pt.y;
        }
        const tickSec = opts.tickMs / 1000;
        let cruise = 14;
        if (Number.isFinite(tickSec) && tickSec > 0) {
          cruise = Math.max(
            10,
            Math.min(60, remaining / Math.max(0.2, tickSec * 0.9)),
          );
        }
        // Ease the walk: accelerate away from a standstill, and slow
        // into the destination rather than halting dead at full pace.
        // Velocity is per person, so a mid-walk retarget stays smooth.
        const target =
          cruise * Math.max(0.18, Math.min(1, remaining / 1.5));
        const accel = 42 * dt;
        st.vel += Math.max(-accel * 1.7, Math.min(accel, target - st.vel));
        if (st.vel < 0) st.vel = 0;
        let step = st.vel * dt;
        while (step > 0 && st.path.length > 0) {
          const target = st.path[0] as { x: number; y: number };
          const dx = target.x - st.x;
          const dy = target.y - st.y;
          const d = Math.hypot(dx, dy);
          if (d < 1e-6) {
            st.path.shift();
            continue;
          }
          const move = Math.min(step, d);
          st.x += (dx / d) * move;
          st.y += (dy / d) * move;
          st.walkPhase += move;
          if (Math.abs(dx) > 0.01) st.facing = dx > 0 ? 1 : -1;
          st.moving = true;
          step -= move;
          if (move >= d) st.path.shift();
        }
        if (st.path.length === 0) {
          st.vel = 0;
          // A walk that ends with legs queued has reached a lift:
          // step in and ride. Only a walk with nothing behind it is
          // an arrival.
          if (st.legs.length > 0) this.advanceLegs(st);
          if (st.path.length === 0 && st.transit === null) {
            st.atStation = st.stationKey.startsWith("w:");
            st.anchorRoom = member.room;
            st.atLift = false;
            st.lying = want.lying;
            st.seated = want.seated;
          }
        }
      } else if (st.transit === null) {
        if (st.legs.length > 0) this.advanceLegs(st);
        if (st.path.length === 0 && st.transit === null) {
          st.atStation = st.stationKey.startsWith("w:");
          st.vel = 0;
          st.anchorRoom = member.room;
          st.atLift = false;
          st.lying = want.lying;
          st.seated = want.seated;
          if (st.atStation && st.workFx !== 0) st.facing = st.workFx;
        }
      }
    }

    // ---- outside, the same ship is drawn from the hull
    // The movement above ran as usual (the minimap stays live, and
    // the crew are where they should be when the witness comes back
    // in); only the painting differs. The sky and the shake are
    // already in place, shared with the deck view.
    if (this.viewExterior) {
      this.exterior.draw(ctx, {
        now,
        dtSec: dt,
        speedTps: opts.speedTps,
        dayMinutes: opts.dayMinutes,
        tick: opts.tick,
        crew,
        storm: opts.storm === true,
        meal: opts.meal ?? null,
        contact: opts.contact ?? null,
        navStrobe: this.staging.navStrobe(now),
        trackOf: (id: string) => (this.wears[0] as WearLayer).trackOf(id),
      });
      // Near stars stay crisp above the hull: they are outside her.
      this.backdrop.drawNear(ctx, now);
      ctx.restore();
      return;
    }

    // ---- the cutaway: both decks, one frame, no switching. The
    // passes live in drawDeck; the frame runs them once per deck
    // under a translate, so a crewmate riding the lift is simply
    // in the other deck's pass. The light is the ship's, shared.
    const light = lightAt(opts.dayMinutes);
    if (opts.showBubbles !== false) this.bubbles.update(now, crew);
    // One hull under both decks, painted before the plans.
    ctx.drawImage(this.hullCanvas, 0, 0);
    for (let d = 0; d < 2; d++) {
      ctx.save();
      if (d === 1) ctx.translate(0, this.cutawayGapY);
      this.drawDeck(ctx, d, crew, opts, now, dt, light);
      ctx.restore();
    }
    // The structural gap takes the ship's light too.
    if (light.dark > 0.004) {
      const cr = Math.round(8 + (43 - 8) * light.warm);
      const cg = Math.round(14 + (26 - 14) * light.warm);
      const cb = Math.round(36 + (9 - 36) * light.warm);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${light.dark.toFixed(3)})`;
      ctx.fillRect(
        0,
        this.shipLayout.heightPx,
        this.shipLayout.widthPx,
        CUTAWAY_GAP_PX,
      );
    }


    // Balance the shake transform opened at the top of the frame.
    ctx.restore();
  }
}
