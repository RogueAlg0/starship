// Deck: the ship as a place. A top-down deck plan derived from the
// engine's ship data (rooms, kinds, adjacency, systems) by viewer-local
// hash arithmetic: the same ship always yields the same deck, and the
// engine never hears about any of it. All art is code: floors, walls,
// and props are painted once into a static offscreen canvas; each
// frame draws the moving space backdrop (space.ts), that image, the
// ship's light for the hour (daynight.ts: a tint over the deck, with
// everything that emits light drawn above it), then the dynamic layer
// (glows, blinking lights, damage sparks, welding sparks), then crew
// bodies with door-to-door waypoint movement, working crew at their
// stations, system labels, and bubbles.
//
// Layout: two room bands (dorsal and ventral) flank a central
// corridor inside an elongated hull, tapered at the bow, flat at the
// stern where the engine block sits. Engineering pins the stern,
// the bridge pins the bow, the airlock sits just aft of the bridge;
// the remaining rooms chain by graph adjacency and fill whichever
// band is currently narrower. Doors pierce shared walls between
// neighbouring rooms placed side by side, and every room opens onto
// the corridor. Crew paths route through those doors over a walkable
// tile grid, smoothed by line of sight.

import type { CrewMember } from "../../src/entities/crew.ts";
import type { Ship } from "../../src/world/ship.ts";
import type { ShipSystem } from "../../src/world/systems.ts";
import { hash01 } from "./faces.ts";
import { getBodySprites } from "./bodies.ts";
import { BubbleLayer } from "./bubbles.ts";
import { SpaceBackdrop } from "./space.ts";
import { lightAt, NIGHT_DARK } from "./daynight.ts";
import {
  corridorTile,
  floorEdge,
  floorTile,
  propCanvas,
  propSize,
  structureTile,
} from "./props.ts";

export const TILE_PX = 8;

const BAND_H = 9; // room band height, tiles
const CORR_Y = 9; // corridor top row
const CORR_H = 3; // corridor height
const DECK_H = BAND_H * 2 + CORR_H; // 21
const OX = 5; // canvas tiles left of the hull stern (engine block zone)
const OY = 2; // canvas tiles above the hull

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
}

interface SideDoor {
  a: number;
  b: number;
  approachA: { x: number; y: number };
  approachB: { x: number; y: number };
  mid: { x: number; y: number };
}

export interface DeckLayout {
  seedKey: number;
  rooms: RoomLayout[];
  deckW: number;
  widthPx: number;
  heightPx: number;
  walkable: Uint8Array;
  sideDoors: Map<string, SideDoor>;
  systemAnchor: Map<string, { px: number; py: number; room: number }>;
  reactorCore: { x: number; y: number; w: number; h: number } | null;
  engineGlow: { x: number; y: number };
  navLights: Array<{ x: number; y: number; colour: string; phase: number }>;
  bridgeScreen: { x: number; y: number; w: number; h: number } | null;
}

function orderRooms(ship: Ship, seedKey: number): number[] {
  const byKind = (kind: string): number =>
    ship.rooms.find((r) => r.kind === kind)?.index ?? -1;
  const eng = byKind("engineering");
  const bridge = byKind("bridge");
  const airlock = byKind("airlock");
  const pinned = new Set([eng, bridge, airlock]);
  const pool = ship.rooms
    .map((r) => r.index)
    .filter((i) => !pinned.has(i));
  const chain: number[] = [];
  let last = eng;
  while (pool.length > 0) {
    let best = -1;
    let bestScore = -1;
    for (const cand of pool) {
      const neighbours = ship.rooms[cand]?.neighbors ?? [];
      let score = neighbours.includes(last) ? 4 : 0;
      for (const placed of [eng, ...chain]) {
        if (neighbours.includes(placed)) score += 1;
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
  const order = [eng, ...chain];
  if (airlock >= 0) order.push(airlock);
  if (bridge >= 0) order.push(bridge);
  return order.filter((i) => i >= 0);
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

export function buildLayout(ship: Ship): DeckLayout {
  const seedKey = strHash(ship.signature());
  const order = orderRooms(ship, seedKey);
  const engFirst = hash01(seedKey, 501) < 0.5;
  const rows: Array<{ rooms: number[]; width: number }> = [
    { rooms: [], width: 1 },
    { rooms: [], width: 1 },
  ];
  const homeRow = new Map<number, number>();
  for (const index of order) {
    const kind = ship.rooms[index]?.kind ?? "quarters";
    const [w] = SIZES[kind] ?? [9, 7];
    let row: number;
    if (index === ship.rooms.find((r) => r.kind === "engineering")?.index) {
      row = engFirst ? 0 : 1;
    } else {
      row = rows[0].width <= rows[1].width ? 0 : 1;
    }
    homeRow.set(index, row);
    rows[row].rooms.push(index);
    rows[row].width += w + 1;
  }
  const deckW = Math.max(rows[0].width, rows[1].width) + 2;

  const layout: DeckLayout = {
    seedKey,
    rooms: [],
    deckW,
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
  };

  const rects = new Map<number, RoomRect>();
  rows.forEach((rowData, rowIdx) => {
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

// ------------------------------------------------------- static render

function renderStatic(layout: DeckLayout, ship: Ship): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = layout.widthPx;
  canvas.height = layout.heightPx;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  const { seedKey, deckW } = layout;

  // Space itself is not painted here: the moving backdrop (space.ts)
  // is drawn under this canvas every frame, and this layer stays
  // transparent beyond the hull so the sky shows through.

  // Hull silhouette.
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
      }
    }
  }
  ctx.fillStyle = "#39465c";
  for (let tx = 2; tx < deckW - 2; tx += 3) {
    ctx.fillRect((tx + OX) * TILE_PX + 2, (CORR_Y + OY) * TILE_PX + 12, 3, 1);
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
    // Walls: a raised border with a lighter top edge.
    const wx = (rect.x + OX) * TILE_PX;
    const wy = (rect.y + OY) * TILE_PX;
    const ww = rect.w * TILE_PX;
    const wh = rect.h * TILE_PX;
    ctx.fillStyle = "#39465c";
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
    // Corridor door: floor showing through, with a sill line.
    const doorPx = (Math.floor(room.doorTile.x) + OX) * TILE_PX;
    const doorPy = (Math.floor(room.doorTile.y) + OY) * TILE_PX;
    ctx.fillStyle = floorTile(rect.kind, seedKey + rect.index, 0, 0);
    ctx.fillRect(doorPx, doorPy, TILE_PX, TILE_PX);
    ctx.fillStyle = "#8fa6c4";
    ctx.fillRect(doorPx + 1, doorPy + 3, TILE_PX - 2, 1);
    // Name plate on the top edge.
    const label = rect.name.toUpperCase();
    const plateW = label.length * 4 + 6;
    const plateX = wx + Math.floor((ww - plateW) / 2);
    ctx.fillStyle = "#141a26";
    ctx.fillRect(plateX, wy - 1, plateW, 7);
    ctx.fillStyle = "#c8d4e4";
    ctx.font = "5px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, wx + ww / 2, wy + 4.5);
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
  /** Minutes into the ship's day (0-1439): the day/night light. */
  dayMinutes: number;
  /** Playback rate in ticks per second; 0 when paused (sky drift). */
  speedTps: number;
}

interface PersonState {
  x: number;
  y: number;
  path: Array<{ x: number; y: number }>;
  facing: number;
  walkPhase: number;
  moving: boolean;
  atStation: boolean;
  workFx: number;
  lastRoom: number;
  stationKey: string;
  phase: number;
  /** Current glide speed, tiles per second (movement easing). */
  vel: number;
  /** The destination is a bunk or bed: draw horizontal on arrival. */
  lying: boolean;
}

interface Particle {
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
  private readonly layout: DeckLayout;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly backdrop: SpaceBackdrop;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly people = new Map<string, PersonState>();
  private readonly particles: Particle[] = [];
  private readonly damageAcc = new Map<number, number>();
  private readonly weldAcc = new Map<string, number>();
  private readonly bubbles = new BubbleLayer();

  constructor(ship: Ship, canvas: HTMLCanvasElement) {
    this.ship = ship;
    this.canvas = canvas;
    this.layout = buildLayout(ship);
    canvas.width = this.layout.widthPx;
    canvas.height = this.layout.heightPx;
    this.staticCanvas = renderStatic(this.layout, ship);
    this.backdrop = new SpaceBackdrop(
      this.layout.seedKey,
      this.layout.widthPx,
      this.layout.heightPx,
    );
    this.ctx = canvas.getContext("2d");
  }

  /** An accusation was just spoken: bubble over the accuser. */
  speech(id: string): void {
    this.bubbles.speech(id, "bang");
  }

  /** The member whose body sits at canvas pixel (xPx, yPx), if any. */
  pick(xPx: number, yPx: number): string | null {
    let best: string | null = null;
    let bestD = (TILE_PX * 0.9 + 3) ** 2;
    for (const [id, st] of this.people) {
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

  private walkableAt(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.layout.deckW || ty >= DECK_H) {
      return false;
    }
    return this.layout.walkable[ty * this.layout.deckW + tx] === 1;
  }

  private los(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / 0.2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.walkableAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) {
        return false;
      }
    }
    return true;
  }

  private smooth(
    pts: Array<{ x: number; y: number }>,
  ): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.los(pts[i] as { x: number; y: number }, pts[j] as { x: number; y: number })) {
        j--;
      }
      out.push(pts[j] as { x: number; y: number });
      i = j;
    }
    return out;
  }

  private route(
    fromRoom: number,
    toRoom: number,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const rooms = this.layout.rooms;
    if (fromRoom === toRoom) {
      const room = rooms[fromRoom];
      const pts = [start];
      if (room !== undefined && !this.los(start, end)) pts.push(room.center);
      pts.push(end);
      return this.smooth(pts);
    }
    const sideKey = `${Math.min(fromRoom, toRoom)}|${Math.max(fromRoom, toRoom)}`;
    const side = this.layout.sideDoors.get(sideKey);
    const a = rooms[fromRoom];
    const b = rooms[toRoom];
    if (side !== undefined && a !== undefined && b !== undefined) {
      const fromA = side.a === fromRoom;
      const approachFrom = fromA ? side.approachA : side.approachB;
      const approachTo = fromA ? side.approachB : side.approachA;
      const pts = [start];
      if (!this.los(start, approachFrom)) pts.push(a.center);
      pts.push(approachFrom, side.mid, approachTo);
      if (!this.los(approachTo, end)) pts.push(b.center);
      pts.push(end);
      return this.smooth(pts);
    }
    if (a === undefined || b === undefined) return [end];
    const corrY = CORR_Y + 1.5;
    const pts = [start];
    if (!this.los(start, a.doorInside)) pts.push(a.center);
    pts.push(
      a.doorInside,
      a.doorTile,
      { x: a.doorTile.x, y: corrY },
      { x: b.doorTile.x, y: corrY },
      b.doorTile,
      b.doorInside,
    );
    if (!this.los(b.doorInside, end)) pts.push(b.center);
    pts.push(end);
    return this.smooth(pts);
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
  ): {
    point: { x: number; y: number };
    key: string;
    fx: number;
    lying: boolean;
  } {
    const room = this.layout.rooms[member.room];
    const seedKey = this.layout.seedKey;
    const num = Number(member.id.replace(/\D/g, "")) || 0;
    if (room === undefined) {
      return {
        point: { x: 2.5, y: CORR_Y + 1.5 },
        key: "void",
        fx: 0,
        lying: false,
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
        };
      }
    }
    const tiles = room.standTiles;
    if (tiles.length === 0) {
      return { point: room.center, key: `i:${member.room}:c`, fx: 0, lying: false };
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
    };
  }

  frame(crew: readonly CrewMember[], opts: DeckFrameOpts): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const { layout, ship } = this;
    const now = opts.now;
    const dt = Math.min(0.1, Math.max(0, opts.dtMs / 1000));
    ctx.imageSmoothingEnabled = false;
    // The moving sky behind the hull, then the ship herself.
    this.backdrop.drawFar(ctx, dt, opts.speedTps);
    ctx.drawImage(this.staticCanvas, 0, 0);

    // Occupant slots, for spreading stand positions inside a room.
    const slots = new Map<string, number>();
    const perRoom = new Map<number, number>();
    for (const member of crew) {
      const slot = perRoom.get(member.room) ?? 0;
      slots.set(member.id, slot);
      perRoom.set(member.room, slot + 1);
    }
    // Resting members in roster order per room: who takes which bunk.
    const restSlot = new Map<string, number>();
    const restPerRoom = new Map<number, number>();
    for (const member of crew) {
      if (member.activity !== "rest") continue;
      const idx = restPerRoom.get(member.room) ?? 0;
      restSlot.set(member.id, idx);
      restPerRoom.set(member.room, idx + 1);
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
      );
      if (st === undefined) {
        st = {
          x: want.point.x,
          y: want.point.y,
          path: [],
          facing: 1,
          walkPhase: 0,
          moving: false,
          atStation: want.key.startsWith("w:"),
          workFx: want.fx,
          lastRoom: member.room,
          stationKey: want.key,
          phase: hash01(layout.seedKey, num * 67) * Math.PI * 2,
          vel: 0,
          lying: want.lying,
        };
        this.people.set(member.id, st);
      }
      if (st.lastRoom !== member.room || st.stationKey !== want.key) {
        const fromRoom = st.lastRoom;
        const hops = this.hopDist(fromRoom, member.room);
        const path = this.route(fromRoom, member.room, { x: st.x, y: st.y }, want.point);
        if (opts.snap || hops > 2) {
          st.x = want.point.x;
          st.y = want.point.y;
          st.path = [];
          st.vel = 0;
        } else {
          st.path = path;
        }
        st.lastRoom = member.room;
        st.stationKey = want.key;
        st.workFx = want.fx;
        st.lying = want.lying;
        st.atStation = false;
      }
      st.moving = false;
      if (st.path.length > 0) {
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
          st.atStation = st.stationKey.startsWith("w:");
          st.vel = 0;
        }
      } else {
        st.atStation = st.stationKey.startsWith("w:");
        st.vel = 0;
        if (st.atStation && st.workFx !== 0) st.facing = st.workFx;
      }
    }

    // ---- the ship's light for the hour: a tint over the deck, and
    // everything that emits light drawn after it, so the night watch
    // reads as a lit ship in dark space, not a dark smear. The tint
    // is a translucent fill toward the phase colour (cool blue at
    // night, warm amber through the evening), so full night lands at
    // about 40% of the day's brightness.
    const light = lightAt(opts.dayMinutes);
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
    for (const room of layout.rooms) {
      if (room === undefined || room.rect.kind !== "hydroponics") continue;
      const rx = (room.rect.x + 1 + OX) * TILE_PX;
      const ry = (room.rect.y + 1 + OY) * TILE_PX;
      const rw = (room.rect.w - 2) * TILE_PX;
      const rh = (room.rect.h - 2) * TILE_PX;
      const sweepX = rx + ((now / 55) % (rw + 28)) - 14;
      const grad = ctx.createLinearGradient(sweepX - 12, 0, sweepX + 12, 0);
      grad.addColorStop(0, "rgba(190,255,190,0)");
      grad.addColorStop(0.5, "rgba(190,255,190,0.10)");
      grad.addColorStop(1, "rgba(190,255,190,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(rx, ry, rw, rh);
    }

    // ---- reactor and engine glow, scaled by system condition
    const reactor = ship.systems.find((s) => s.kind === "reactor");
    if (reactor !== undefined && layout.reactorCore !== null) {
      const core = layout.reactorCore;
      const pulse = 0.8 + 0.2 * Math.sin(now / 800);
      const a = (0.3 + 0.6 * reactor.condition) * pulse;
      ctx.fillStyle = `rgba(255,170,60,${a.toFixed(3)})`;
      ctx.fillRect(core.x, core.y, core.w, core.h);
      const gx = core.x + core.w / 2;
      const gy = core.y + core.h / 2;
      const grad = ctx.createRadialGradient(gx, gy, 1, gx, gy, 17);
      grad.addColorStop(0, `rgba(255,150,50,${(0.22 * reactor.condition * pulse).toFixed(3)})`);
      grad.addColorStop(1, "rgba(255,150,50,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(gx - 17, gy - 17, 34, 34);
    }
    const engines = ship.systems.find((s) => s.kind === "engines");
    if (engines !== undefined) {
      const g = layout.engineGlow;
      const pulse = 0.75 + 0.25 * Math.sin(now / 1000 + 1);
      const grad = ctx.createRadialGradient(g.x, g.y, 1, g.x, g.y, 20);
      grad.addColorStop(0, `rgba(140,200,255,${(0.30 * engines.condition * pulse).toFixed(3)})`);
      grad.addColorStop(1, "rgba(140,200,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(g.x - 20, g.y - 20, 40, 40);
      ctx.fillStyle = `rgba(190,225,255,${(0.25 + 0.6 * engines.condition).toFixed(3)})`;
      for (const dy of [-13, -4, 5]) {
        ctx.fillRect((OX - 4) * TILE_PX, g.y + dy - 4, 3, 6);
      }
    }

    // ---- navigation lights
    for (const light of layout.navLights) {
      const blink = 0.5 + 0.5 * Math.sin(now / 1300 + light.phase);
      ctx.globalAlpha = 0.2 + 0.5 * blink;
      ctx.fillStyle = light.colour;
      ctx.fillRect(light.x - 1, light.y - 1, 3, 3);
      ctx.globalAlpha = blink > 0.55 ? 1 : 0.35;
      ctx.fillRect(light.x, light.y, 1, 1);
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
      const systems = room.systemIds
        .map((id) => ship.systemById(id))
        .filter((s): s is ShipSystem => s !== undefined);
      if (systems.length === 0) continue;
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
        // A red warning lamp blinks over the room.
        if (Math.floor(now / 450 + rect.index) % 2 === 0) {
          const lx = rx + rect.w * 4;
          ctx.fillStyle = "#ff4a3c";
          ctx.fillRect(lx - 1, ry + 2, 3, 3);
          ctx.globalAlpha = 0.35;
          ctx.fillRect(lx - 2, ry + 1, 5, 5);
          ctx.globalAlpha = 1;
        }
      }
      // System label and condition bar, live from the ship.
      const pct = Math.round(worst.condition * 100);
      const extra = systems.length > 1 ? ` +${systems.length - 1}` : "";
      ctx.font = "6px monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = "#141a26";
      ctx.fillRect(rx + 3, ry + rect.h * TILE_PX - 10, 30, 2);
      ctx.fillStyle =
        worst.condition < 0.3
          ? "#ff7a5c"
          : worst.condition < 0.6
            ? "#ffb35c"
            : "#7fd4a8";
      ctx.fillRect(rx + 3, ry + rect.h * TILE_PX - 10, 30 * worst.condition, 2);
      ctx.fillStyle =
        worst.condition < 0.6 ? "#ffb35c" : "rgba(207,216,230,0.85)";
      if (worst.condition < 0.3) ctx.fillStyle = "#ff8a6a";
      ctx.fillText(
        `${worst.name} ${pct}%${extra}`,
        rx + 3,
        ry + rect.h * TILE_PX - 3,
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
      let acc = (this.weldAcc.get(member.id) ?? 0) + 36 * dt;
      while (acc >= 1) {
        acc -= 1;
        if (this.particles.length >= MAX_PARTICLES) break;
        const h1 = hash01(layout.seedKey, this.particles.length * 13 + Math.floor(now / 17));
        const h2 = hash01(layout.seedKey, this.particles.length * 19 + Math.floor(now / 23));
        this.particles.push({
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

    // ---- crew bodies
    // Bodies dim less than the deck at night (0.82 of full at the
    // darkest): crew carry their own small light in-fiction, and a
    // watch-stander must stay findable in a dark room.
    const bodyDim = 1 - 0.18 * (light.dark / NIGHT_DARK);
    ctx.filter =
      bodyDim < 0.999 ? `brightness(${bodyDim.toFixed(3)})` : "none";
    const positions = new Map<string, { x: number; y: number }>();
    const ordered = [...crew].sort(
      (a, b) =>
        (this.people.get(a.id)?.y ?? 0) - (this.people.get(b.id)?.y ?? 0),
    );
    for (const member of ordered) {
      const st = this.people.get(member.id);
      if (st === undefined) continue;
      const sprites = getBodySprites(member);
      const working =
        (member.activity === "work" || member.activity === "repair") &&
        st.atStation;
      let sprite = sprites.idle;
      if (st.moving) {
        sprite = Math.floor(st.walkPhase * 1.6) % 2 === 0 ? sprites.walk : sprites.idle;
      } else if (working) {
        sprite = Math.floor(now / 170) % 2 === 0 ? sprites.work : sprites.idle;
      }
      const lying = st.lying && !st.moving;
      if (lying) sprite = sprites.idle;
      let bob = 0;
      let swayX = 0;
      if (st.moving) bob = -Math.abs(Math.sin(st.walkPhase * 2.2)) * 1;
      else if (working) bob = Math.sin(now / 95 + st.phase) * 0.4;
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
      if (lying) ctx.ellipse(px, py - 2, 5.5, 1.6, 0, 0, Math.PI * 2);
      else ctx.ellipse(px, py - 1, 3.5, 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (opts.selectedId === member.id) {
        ctx.strokeStyle = `rgba(255,215,106,${(0.7 + 0.3 * Math.sin(now / 300)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(px, py - 1, 5, 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.save();
      if (lying) {
        // Horizontal on the bunk, head toward the bow, breathing slow.
        const breathe = Math.sin(now / 2600 + st.phase) * 0.3;
        ctx.translate(px, py - 4 + breathe);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(sprite, -4, -6);
      } else if (st.facing < 0) {
        ctx.translate(px, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(sprite, -4, py - 12 + bob);
      } else {
        ctx.drawImage(sprite, px - 4, py - 12 + bob);
      }
      ctx.restore();
    }
    ctx.filter = "none";

    // ---- bubbles, above everything
    this.bubbles.update(now, crew);
    this.bubbles.draw(ctx, now, positions, layout.widthPx);
  }
}
