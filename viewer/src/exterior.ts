// Hull exterior: the ship from outside.
//
// The third view, beside the two deck plans: the ship in side
// profile against the same sky the deck view sails through (the
// backdrop itself stays the DeckView's; this module paints only
// the ship). Everything here derives from the ship signature the
// viewer already holds, by the same viewer-local hash arithmetic
// the deck plan uses: hull length and window banding from the deck
// plan's actual width and room rects, the bridge blister over the
// bridge's own span, the sensor mast over the lab, the airlock
// hatch at the airlock, engine bells at the stern block the wear
// layer already knows. Archetypes are designed but not yet in
// shipgen, so the silhouette's character is read off the ship that
// exists: a wide cargo bay bellies the hull and hangs pods under
// the keel, many quarters make her windowed like a lantern, a
// small ship draws sleeker. Same seed, same ship, every time.
//
// The windows are the interior made visible. Each compartment's
// light is computed from the live snapshot the deck view consumes:
// crew awake in a room lights it, a room of sleepers sits at a dim
// night-light, an empty room keeps only the day watch's ambient or
// the night's standby, and during a meal window the mess glows
// warm with a halo. The day/night tint drives the ambient, so the
// ship reads as a lit house crossing the dark.
//
// Performance follows the house rules. The base silhouette is
// painted once per ship into an offscreen canvas. The window
// lights and the hull wear (the wear layer's own quantities: the
// engines' worst day, per-system damage, the age stain) live on
// their own canvases, repainted only when a bucketed signature
// changes. Per frame this module draws three blits, the engine
// plume from a pre-built sprite, the nav lights, and a capped
// particle pool whose positions are pure functions of age. No
// gradient is created per frame; the two sprites that need one
// are built once, beside the silhouette.

import type { CrewMember } from "../../src/entities/crew.ts";
import type { Ship } from "../../src/world/ship.ts";
import type { ShipSystem } from "../../src/world/systems.ts";
import { hash01 } from "./faces.ts";
import { lightAt, NIGHT_DARK } from "./daynight.ts";
import type { DeckLayout, ShipLayout } from "./deck.ts";
import type { WearTrackView } from "./wear.ts";

/** Pixel geometry of the deck plan, handed over by deck.ts. */
export interface ExteriorGeom {
  tile: number;
  ox: number;
  oy: number;
  deckH: number;
  corrY: number;
}

/** One frame of live state, assembled by the DeckView. */
export interface ExteriorFrameOpts {
  now: number;
  /** Frame delta, seconds, already clamped by the caller. */
  dtSec: number;
  /** Playback rate in ticks per second; 0 when paused. */
  speedTps: number;
  /** Minutes into the ship's day (0-1439): the day/night light. */
  dayMinutes: number;
  /** Elapsed sim ticks this run: the age stain's clock. */
  tick: number;
  crew: readonly CrewMember[];
  /** The ship is riding out a radiation storm. */
  storm: boolean;
  /** The meal window open at this tick, if any. */
  meal: "breakfast" | "evening" | null;
  /** Storm-arrival strobe envelope, from the staging layer. */
  navStrobe: number;
  /** The wear layer's per-system tracks (worst day, damage, patches). */
  trackOf: (systemId: string) => WearTrackView | undefined;
}

type StageKind = "sabotage" | "failure" | "repaired";

interface HullWindow {
  x: number;
  y: number;
  /** Per-window threshold: lit while the room's level exceeds it. */
  hash: number;
}

interface RoomFace {
  index: number;
  kind: string;
  deck: number;
  /** Hull-pixel centre of the room's span along the ship. */
  cx: number;
  windows: HullWindow[];
}

interface HullStation {
  systemId: string;
  room: number;
  deck: number;
  x: number;
  y: number;
}

interface ExtParticle {
  kind: "spark" | "vapour" | "shimmer";
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornMs: number;
  spanMs: number;
  seed: number;
  colour: string;
}

interface ExtEffect {
  kind: StageKind;
  station: HullStation;
  bornMs: number;
  spanMs: number;
  seed: number;
}

const MAX_EXT_PARTICLES = 160;
const SPAN_MS: Record<StageKind, number> = {
  sabotage: 900,
  failure: 1200,
  repaired: 800,
};
const SPARK_COLOURS = ["#ffd76a", "#ffb35c", "#ff7847"];
const SABOTAGE_COLOURS = ["#fff3f0", "#ff5a4a", "#ffb35c"];
const VAPOUR_COLOUR = "#aebacd";
/** Exhaust slot offsets from hull mid-height, as the wear layer knows them. */
const SLOT_DY = [-13, -4, 5] as const;
/** Elapsed ticks at which the exhaust age staining reaches its cap. */
const AGE_FULL_TICKS = 12960;
const AGE_MAX_ALPHA = 0.15;
/** Muted hull liveries; a seed takes one for its accent stripe. */
const LIVERIES = ["#7d8ea8", "#8a6f4d", "#5f7d6a", "#7a5f74", "#94835c"];

/** Window light by room kind: the interior's colour, seen through glass. */
const ROOM_LIGHT: Readonly<Record<string, string>> = {
  mess: "#ffca7a",
  hydroponics: "#a9f29a",
  medbay: "#dceaff",
  bridge: "#9fe8dd",
  quarters: "#ffd9a3",
  engineering: "#ffc98f",
  lab: "#cfe4ff",
};

function strSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 100000);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export class ExteriorView {
  private readonly ship: Ship;
  private readonly layout: ShipLayout;
  private readonly geom: ExteriorGeom;
  private readonly seedKey: number;

  // Derived silhouette geometry, fixed for the life of a ship.
  private readonly sternX: number;
  private readonly bowStartX: number;
  private readonly bowTipX: number;
  private readonly midY: number;
  private readonly hullTop: number;
  private readonly hullBottom: number;
  private readonly blockX: number;
  private readonly bandY: [number, number];
  private readonly needleBow: boolean;
  private readonly livery: string;

  private readonly faces: RoomFace[] = [];
  private readonly stations = new Map<string, HullStation>();
  private readonly blister: {
    cx: number;
    baseY: number;
    rx: number;
    room: number;
    windows: HullWindow[];
  } | null;
  private readonly navLights: Array<{
    x: number;
    y: number;
    colour: string;
    phase: number;
    beacon: boolean;
  }> = [];

  private readonly baseCanvas: HTMLCanvasElement;
  private readonly lightCanvas: HTMLCanvasElement;
  private lightSig = "";
  private readonly wearCanvas: HTMLCanvasElement;
  private wearSig = "";
  private readonly plumeSprite: HTMLCanvasElement;
  private readonly haloSprite: HTMLCanvasElement;
  private readonly glowSprite: HTMLCanvasElement;

  private readonly particles: ExtParticle[] = [];
  private readonly effects: ExtEffect[] = [];
  private readonly ventAcc = new Map<string, number>();
  private readonly sparkAcc = new Map<string, number>();
  private shimmerAcc = 0;
  private seq = 0;
  // Frame scratch: occupancy counts per room index, reused in place.
  private readonly awakeScratch: number[] = [];
  private readonly asleepScratch: number[] = [];
  private readonly levelScratch: Float32Array;
  private readonly damageScratch: Array<{
    station: HullStation;
    damage: number;
    patches: number;
  }> = [];

  constructor(ship: Ship, layout: ShipLayout, geom: ExteriorGeom) {
    this.ship = ship;
    this.layout = layout;
    this.geom = geom;
    this.seedKey = layout.seedKey;
    const { tile, ox, oy } = geom;
    const seedKey = this.seedKey;

    // The footprint is the deck plan's own: the same stern, the
    // same bow tip, the same mid-height, so the ship outside is
    // the ship inside, turned sideways.
    this.sternX = (ox - 1) * tile;
    this.bowStartX = (ox + layout.deckW) * tile;
    this.bowTipX = (ox + layout.deckW + 7) * tile;
    this.midY = (oy + geom.deckH / 2) * tile;
    this.blockX = (ox - 4) * tile;

    // Character from the signature: cargo bellies her, a small
    // ship draws sleeker, the bow and the paint are the seed's.
    const cargoRect = this.rectOfKind(1, "cargo");
    const roomCount = ship.rooms.length;
    let beam = tile * 6.5;
    if (cargoRect !== undefined && cargoRect.w >= 13) beam += 4;
    if (roomCount <= 10) beam -= 3;
    beam = clamp(beam, tile * 5.5, tile * 7.25);
    this.hullTop = this.midY - beam;
    this.hullBottom = this.midY + beam;
    this.bandY = [this.midY - beam * 0.44, this.midY + beam * 0.44];
    this.needleBow = hash01(seedKey, 517) < 0.5;
    this.livery =
      LIVERIES[Math.floor(hash01(seedKey, 521) * LIVERIES.length)] ??
      (LIVERIES[0] as string);

    // Window faces: every room of every deck, in plan order. A
    // room's windows spread across its own span of the hull; its
    // row is its deck's band, nudged up or down by which plan band
    // (above or below the corridor) the room sits in, so the two
    // faces of one deck stay legible side by side.
    for (let d = 0; d < 2; d++) {
      const plan = layout.decks[d] as DeckLayout;
      for (const roomLayout of plan.rooms) {
        if (roomLayout === undefined) continue;
        const { rect } = roomLayout;
        const topFace = rect.y + rect.h <= geom.corrY;
        const rowY = (this.bandY[d] as number) + (topFace ? -4 : 4);
        const x0 = (rect.x + ox) * tile + 4;
        const span = rect.w * tile - 8;
        const count = clamp(Math.round(rect.w / 2.2), 2, 6);
        const windows: HullWindow[] = [];
        for (let i = 0; i < count; i++) {
          windows.push({
            x: Math.round(x0 + ((i + 0.5) * span) / count),
            y: rowY,
            hash: hash01(seedKey, rect.index * 331 + i * 17 + d * 7919) * 0.95,
          });
        }
        this.faces.push({
          index: rect.index,
          kind: rect.kind,
          deck: d,
          cx: (rect.x + rect.w / 2 + ox) * tile,
          windows,
        });
      }
    }
    this.faces.sort((a, b) => a.index - b.index);

    // Hull stations: where each system's room meets the skin, for
    // scorch, sparks, and venting.
    for (const system of ship.systems) {
      const deck = layout.deckOfRoom[system.room] ?? 0;
      const face = this.faces.find((f) => f.index === system.room);
      if (face === undefined) continue;
      this.stations.set(system.id, {
        systemId: system.id,
        room: system.room,
        deck,
        x: face.cx,
        y: (this.bandY[deck] as number) + (deck === 0 ? -9 : 9),
      });
    }

    // The bridge blister rides the spine over the bridge's span.
    const bridgeFace = this.faces.find((f) => f.kind === "bridge");
    if (bridgeFace !== undefined) {
      const rect = this.rectOfKind(0, "bridge");
      const rx = clamp(((rect?.w ?? 11) * tile) / 2, 13, 24);
      const baseY = this.hullTop + 1;
      const windows: HullWindow[] = [];
      for (let i = 0; i < 3; i++) {
        windows.push({
          x: Math.round(bridgeFace.cx + (i - 1) * rx * 0.45),
          y: baseY - 5,
          hash: hash01(seedKey, 6100 + i * 13) * 0.95,
        });
      }
      this.blister = {
        cx: bridgeFace.cx,
        baseY,
        rx,
        room: bridgeFace.index,
        windows,
      };
    } else {
      this.blister = null;
    }

    // Running lights: bow pair in the deck view's own colours, a
    // stern white, and the mast beacon.
    const mastX = this.mastX();
    this.navLights.push(
      { x: this.bowTipX - 5, y: this.hullTop + 7, colour: "#ff5a4a", phase: 0, beacon: false },
      { x: this.bowTipX - 5, y: this.hullBottom - 7, colour: "#4ae88a", phase: 2.2, beacon: false },
      { x: this.blockX + 2, y: this.midY - 21, colour: "#f4f6fa", phase: 4.1, beacon: false },
      { x: mastX, y: this.hullTop - 22, colour: "#ff5a4a", phase: 1.3, beacon: true },
    );

    this.levelScratch = new Float32Array(this.faces.length);
    this.plumeSprite = this.buildPlumeSprite();
    this.haloSprite = this.buildHaloSprite("255,196,110");
    this.glowSprite = this.buildHaloSprite("160,205,255");
    this.baseCanvas = this.paintBase(mastX);
    this.lightCanvas = document.createElement("canvas");
    this.lightCanvas.width = layout.widthPx;
    this.lightCanvas.height = layout.heightPx;
    this.wearCanvas = document.createElement("canvas");
    this.wearCanvas.width = layout.widthPx;
    this.wearCanvas.height = layout.heightPx;
  }

  /** A room rect of a kind on a deck, or undefined when absent. */
  private rectOfKind(
    deck: number,
    kind: string,
  ): { x: number; y: number; w: number; h: number } | undefined {
    const plan = this.layout.decks[deck] as DeckLayout;
    for (const roomLayout of plan.rooms) {
      if (roomLayout !== undefined && roomLayout.rect.kind === kind) {
        return roomLayout.rect;
      }
    }
    return undefined;
  }

  /** The sensor mast stands over the lab; without one, at a hashed bow-third point. */
  private mastX(): number {
    const { tile, ox } = this.geom;
    const lab = this.rectOfKind(0, "lab");
    if (lab !== undefined) return (lab.x + lab.w / 2 + ox) * tile;
    return (
      this.sternX + (this.bowStartX - this.sternX) * (0.62 + hash01(this.seedKey, 613) * 0.1)
    );
  }

  // ------------------------------------------------------------ paint: base

  /** A soft radial glow sprite in one hue, built once. */
  private buildHaloSprite(rgb: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return canvas;
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},0.55)`);
    grad.addColorStop(0.5, `rgba(${rgb},0.18)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return canvas;
  }

  /** The exhaust plume sprite: a bright core thinning aft, built once. */
  private buildPlumeSprite(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 28;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return canvas;
    const grad = ctx.createLinearGradient(0, 0, 96, 0);
    grad.addColorStop(0, "rgba(190,225,255,0)");
    grad.addColorStop(0.55, "rgba(150,200,245,0.35)");
    grad.addColorStop(0.85, "rgba(215,240,255,0.75)");
    grad.addColorStop(1, "rgba(240,250,255,0.9)");
    ctx.fillStyle = grad;
    // A lens: full height at the nozzle end, a point at the tail.
    ctx.beginPath();
    ctx.moveTo(0, 14);
    ctx.quadraticCurveTo(40, 1, 96, 10);
    ctx.lineTo(96, 18);
    ctx.quadraticCurveTo(40, 27, 0, 14);
    ctx.closePath();
    ctx.fill();
    return canvas;
  }

  /** The silhouette: painted once per ship, invalidated never. */
  private paintBase(mastX: number): HTMLCanvasElement {
    const { tile, ox } = this.geom;
    const seedKey = this.seedKey;
    const canvas = document.createElement("canvas");
    canvas.width = this.layout.widthPx;
    canvas.height = this.layout.heightPx;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return canvas;
    const top = this.hullTop;
    const bottom = this.hullBottom;
    const midY = this.midY;

    // Engine block at the stern, with three bells.
    ctx.fillStyle = "#39465c";
    ctx.fillRect(this.blockX, midY - 18, tile * 3 + 4, 36);
    ctx.fillStyle = this.livery;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(this.blockX, midY - 18, 3, 36);
    ctx.globalAlpha = 1;
    for (const dy of SLOT_DY) {
      const cy = midY + dy + 3;
      ctx.beginPath();
      ctx.moveTo(this.blockX - 7, cy - 4);
      ctx.lineTo(this.blockX + 1, cy - 2.5);
      ctx.lineTo(this.blockX + 1, cy + 2.5);
      ctx.lineTo(this.blockX - 7, cy + 4);
      ctx.closePath();
      ctx.fillStyle = "#2a3446";
      ctx.fill();
      ctx.strokeStyle = "#141a26";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#0b0e13";
      ctx.fillRect(this.blockX - 7, cy - 1.5, 2, 3);
    }

    // The hull herself.
    const hullGrad = ctx.createLinearGradient(0, top, 0, bottom);
    hullGrad.addColorStop(0, "#2e394e");
    hullGrad.addColorStop(0.45, "#252f40");
    hullGrad.addColorStop(1, "#1b2331");
    ctx.beginPath();
    ctx.moveTo(this.sternX + 8, top);
    ctx.lineTo(this.bowStartX - 8, top);
    if (this.needleBow) {
      ctx.quadraticCurveTo(this.bowTipX + 6, midY, this.bowStartX - 8, bottom);
    } else {
      ctx.quadraticCurveTo(this.bowTipX - 2, top + (bottom - top) * 0.3, this.bowTipX - 1, midY);
      ctx.quadraticCurveTo(this.bowTipX - 2, bottom - (bottom - top) * 0.3, this.bowStartX - 8, bottom);
    }
    ctx.lineTo(this.sternX + 8, bottom);
    ctx.quadraticCurveTo(this.sternX - 7, midY, this.sternX + 8, top);
    ctx.closePath();
    ctx.fillStyle = hullGrad;
    ctx.fill();
    ctx.strokeStyle = "#46536b";
    ctx.lineWidth = 1;
    ctx.stroke();

    // The dorsal spine, and the bridge blister riding it.
    const spineH = 3 + Math.round(hash01(seedKey, 529) * 3);
    const spineX0 = this.sternX + (this.bowStartX - this.sternX) * 0.3;
    ctx.fillStyle = "#303c52";
    ctx.fillRect(spineX0, top - spineH, this.bowStartX - 6 - spineX0, spineH + 2);
    ctx.strokeStyle = "#46536b";
    ctx.strokeRect(spineX0, top - spineH, this.bowStartX - 6 - spineX0, spineH + 2);
    if (this.blister !== null) {
      const b = this.blister;
      ctx.beginPath();
      ctx.ellipse(b.cx, b.baseY - spineH + 1, b.rx, 9, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = "#35445e";
      ctx.fill();
      ctx.strokeStyle = "#55678a";
      ctx.stroke();
    }

    // Sensor mast: spar, dish, crossbar over the lab.
    ctx.strokeStyle = "#46536b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mastX, top - spineH);
    ctx.lineTo(mastX, top - 21);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mastX - 5, top - 15);
    ctx.lineTo(mastX + 5, top - 15);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(mastX - 3, top - 19, 4, 2.5, -0.5, 0, Math.PI * 2);
    ctx.strokeStyle = "#6d7f96";
    ctx.stroke();

    // Keel fin, swept, under midships; cargo pods under the bay.
    const keelLen = (this.bowStartX - this.sternX) * 0.3;
    const keelX = this.sternX + (this.bowStartX - this.sternX) * 0.36;
    const keelD = 8 + hash01(seedKey, 533) * 5;
    ctx.beginPath();
    ctx.moveTo(keelX, bottom - 2);
    ctx.lineTo(keelX + keelLen, bottom - 2);
    ctx.lineTo(keelX + keelLen - 10, bottom + keelD);
    ctx.lineTo(keelX + 12, bottom + keelD);
    ctx.closePath();
    ctx.fillStyle = "#20293a";
    ctx.fill();
    ctx.strokeStyle = "#39465c";
    ctx.stroke();
    const cargo = this.rectOfKind(1, "cargo");
    if (cargo !== undefined) {
      const pods = clamp(Math.round(cargo.w / 5), 1, 3);
      const podW = (cargo.w * tile - 10) / pods;
      for (let i = 0; i < pods; i++) {
        const px = (cargo.x + ox) * tile + 5 + i * podW;
        ctx.fillStyle = "#27324a";
        ctx.fillRect(px, bottom - 1, podW - 4, 7);
        ctx.strokeStyle = "#39465c";
        ctx.strokeRect(px, bottom - 1, podW - 4, 7);
      }
    }

    // Plating seams and the livery stripe.
    ctx.strokeStyle = "rgba(16,21,31,0.65)";
    for (let i = 0; i < 14; i++) {
      const x =
        this.sternX + 14 +
        hash01(seedKey, i * 5 + 541) * (this.bowStartX - this.sternX - 30);
      ctx.beginPath();
      ctx.moveTo(x, top + 3);
      ctx.lineTo(x, bottom - 3);
      ctx.stroke();
    }
    ctx.fillStyle = this.livery;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(this.sternX + 10, midY - 2, this.bowStartX - this.sternX - 16, 2);
    ctx.globalAlpha = 1;

    // Her name on the bow plating, and the registry under it.
    ctx.fillStyle = "#9db1cc";
    ctx.font = "bold 7px monospace";
    ctx.textAlign = "left";
    ctx.fillText(this.ship.name.toUpperCase(), this.sternX + 14, top + 12);
    ctx.fillStyle = "#5f7189";
    ctx.font = "5px monospace";
    ctx.fillText(`REG ${seedKey}`, this.sternX + 14, top + 19);

    // The airlock hatch and its docking target, low on the hull.
    const airlock = this.rectOfKind(1, "airlock");
    if (airlock !== undefined) {
      const hx = (airlock.x + airlock.w / 2 + ox) * tile;
      const hy = (this.bandY[1] as number) + 17;
      ctx.strokeStyle = "#55678a";
      ctx.lineWidth = 1;
      ctx.strokeRect(hx - 6, hy - 5, 12, 10);
      ctx.strokeRect(hx - 3.5, hy - 2.5, 7, 5);
      ctx.beginPath();
      ctx.moveTo(hx - 9, hy);
      ctx.lineTo(hx - 7, hy);
      ctx.moveTo(hx + 7, hy);
      ctx.lineTo(hx + 9, hy);
      ctx.moveTo(hx, hy - 8);
      ctx.lineTo(hx, hy - 6);
      ctx.moveTo(hx, hy + 6);
      ctx.lineTo(hx, hy + 8);
      ctx.stroke();
    }

    // RCS quads: small blocks at the four corners of the hull.
    ctx.fillStyle = "#39465c";
    for (const [rx, ry] of [
      [this.bowStartX - 12, top + 3],
      [this.bowStartX - 12, bottom - 6],
      [this.sternX + 12, top + 3],
      [this.sternX + 12, bottom - 6],
    ] as const) {
      ctx.fillRect(rx, ry, 4, 3);
    }

    // Window frames: dark glass in the base; the light layer
    // paints over the glass of any room that is lit.
    for (const face of this.faces) {
      for (const win of face.windows) {
        ctx.fillStyle = "#0a0f16";
        ctx.fillRect(win.x - 2, win.y - 2, 5, 4);
        ctx.fillStyle = "rgba(190,215,245,0.10)";
        ctx.fillRect(win.x - 2, win.y - 2, 5, 1);
      }
    }
    if (this.blister !== null) {
      for (const win of this.blister.windows) {
        ctx.fillStyle = "#0a0f16";
        ctx.fillRect(win.x - 2, win.y - 2, 4, 3);
      }
    }
    // Nav light housings.
    ctx.fillStyle = "#141a26";
    for (const light of this.navLights) {
      ctx.fillRect(light.x - 1, light.y - 1, 3, 3);
    }
    return canvas;
  }

  // ------------------------------------------------------------ paint: wear

  /**
   * The hull's scars, from the wear layer's own tracks: the
   * engines' worst day scorched around the bells and pitted along
   * the stern, the age stain trailing off the stern plating, and a
   * scorch bloom at the hull station of every system that has been
   * hurt, with a repair plate beside it once it has been mended.
   * Repainted only when a bucketed input crosses.
   */
  private syncWear(opts: ExteriorFrameOpts): void {
    let enginesWorst = 1;
    let parts = `a:${Math.floor(Math.max(0, opts.tick) / 720)}`;
    const damages = this.damageScratch;
    damages.length = 0;
    for (const system of this.ship.systems) {
      const track = opts.trackOf(system.id);
      if (track === undefined) continue;
      if (system.kind === "engines") enginesWorst = track.worst;
      if (track.damage >= 0.15 || track.patches > 0) {
        const station = this.stations.get(system.id);
        if (station === undefined) continue;
        damages.push({ station, damage: track.damage, patches: track.patches });
        parts += `|${system.id}:${Math.floor(track.damage / 0.05)}:${track.patches}`;
      }
    }
    parts += `|e:${Math.floor(enginesWorst / 0.05)}`;
    if (parts === this.wearSig) return;
    this.wearSig = parts;
    const ctx = this.wearCanvas.getContext("2d");
    if (ctx === null) return;
    const seedKey = this.seedKey;
    ctx.clearRect(0, 0, this.wearCanvas.width, this.wearCanvas.height);

    // Age: a faint soot wash trailing along the stern plating.
    const ageAlpha = Math.min(
      AGE_MAX_ALPHA,
      (Math.max(0, opts.tick) / AGE_FULL_TICKS) * AGE_MAX_ALPHA,
    );
    if (ageAlpha > 0.004) {
      for (let sgm = 0; sgm < 3; sgm++) {
        const a = ageAlpha * (1 - sgm / 3);
        ctx.fillStyle = `rgba(14,12,9,${a.toFixed(3)})`;
        const x = this.sternX + 4 + sgm * 50;
        ctx.fillRect(x, this.hullTop + 1, 50, 5);
        ctx.fillRect(x, this.hullBottom - 6, 50, 5);
      }
      ctx.fillStyle = `rgba(14,12,9,${(ageAlpha * 0.8).toFixed(3)})`;
      ctx.fillRect(this.blockX, this.midY - 18, this.geom.tile * 3 + 4, 36);
    }

    // The engines' worst day: scorch at the bells, pitting aft.
    const depth = 1 - enginesWorst;
    if (depth > 0.15) {
      for (const dy of SLOT_DY) {
        const cy = this.midY + dy + 3;
        ctx.fillStyle = `rgba(9,7,5,${(0.42 * depth).toFixed(3)})`;
        ctx.fillRect(this.blockX - 8, cy - 5, 12, 10);
        const len = 6 + depth * 18;
        for (let sgm = 0; sgm < 3; sgm++) {
          const a = 0.3 * depth * (1 - sgm / 3);
          ctx.fillStyle = `rgba(9,7,5,${a.toFixed(3)})`;
          ctx.fillRect(this.blockX - 8 - sgm * (len / 3), cy - 2, len / 3, 4);
        }
      }
      const pits = Math.round(depth * 36);
      ctx.fillStyle = "rgba(8,8,10,0.55)";
      for (let i = 0; i < pits; i++) {
        const h1 = hash01(seedKey, 77003 + i * 5);
        const h2 = hash01(seedKey, 77004 + i * 5);
        const h3 = hash01(seedKey, 77005 + i * 5);
        let x: number;
        let y: number;
        if (h3 < 0.3) {
          x = this.blockX + h1 * (this.geom.tile * 3 + 4);
          y = this.midY - 18 + h2 * 36;
        } else if (h2 < 0.5) {
          x = this.sternX + 4 + h1 * 150;
          y = this.hullTop + 1 + h3 * 4;
        } else {
          x = this.sternX + 4 + h1 * 150;
          y = this.hullBottom - 5 + h3 * 4;
        }
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }

    // Per-system scorch at its hull station, and its repair plate.
    for (const { station, damage, patches } of damages) {
      if (damage >= 0.15) {
        const level = damage < 0.4 ? 1 : damage < 0.7 ? 2 : 3;
        const blobs = level === 1 ? 2 : level === 2 ? 4 : 6;
        const radius = 4 + damage * 7;
        ctx.fillStyle = `rgba(10,8,6,${(0.1 + damage * 0.22).toFixed(3)})`;
        const sysSeed = strSeed(station.systemId);
        for (let i = 0; i < blobs; i++) {
          const cx = station.x + (hash01(seedKey, sysSeed + i * 4) - 0.5) * 2 * radius;
          const cy = station.y + (hash01(seedKey, sysSeed + 1 + i * 4) - 0.5) * radius;
          const r = 1.6 + hash01(seedKey, sysSeed + 2 + i * 4) * 3;
          ctx.beginPath();
          ctx.ellipse(cx, cy, r, r * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (patches > 0) {
        const sysSeed = strSeed(station.systemId);
        const px = station.x + (hash01(seedKey, sysSeed + 900) - 0.5) * 18;
        const py = station.y + (station.deck === 0 ? -6 : 6);
        ctx.fillStyle = "#55678a";
        ctx.fillRect(px - 4, py - 2, 8, 5);
        ctx.fillStyle = "#93a7c2";
        for (let x = -4; x < 4; x += 2) {
          ctx.fillRect(px + x, py - 2, 1, 1);
          ctx.fillRect(px + x, py + 2, 1, 1);
        }
      }
    }
  }

  // ------------------------------------------------------------ paint: lights

  /**
   * Compute every room's light from the live snapshot, then
   * repaint the light canvas only if a bucketed level changed.
   * Returns nothing; the canvas is the record.
   */
  private syncLights(opts: ExteriorFrameOpts): void {
    const awake = this.awakeScratch;
    const asleep = this.asleepScratch;
    const roomCount = this.ship.rooms.length;
    if (awake.length !== roomCount) {
      awake.length = roomCount;
      asleep.length = roomCount;
    }
    awake.fill(0);
    asleep.fill(0);
    for (const member of opts.crew) {
      if (member.room < 0 || member.room >= roomCount) continue;
      if (member.activity === "rest") {
        asleep[member.room] = (asleep[member.room] as number) + 1;
      } else {
        awake[member.room] = (awake[member.room] as number) + 1;
      }
    }
    const light = lightAt(opts.dayMinutes);
    const dayness = clamp(1 - light.dark / NIGHT_DARK, 0, 1);
    const levels = this.levelScratch;
    let sig = `d:${Math.round(light.dark / 0.05)}|m:${opts.meal ?? "-"}`;
    for (let i = 0; i < this.faces.length; i++) {
      const face = this.faces[i] as RoomFace;
      const a = awake[face.index] ?? 0;
      const s = asleep[face.index] ?? 0;
      let level: number;
      if (a > 0) level = 0.9;
      else if (s > 0) level = 0.14;
      else level = 0.05 + 0.3 * dayness;
      if (face.kind === "hydroponics") level = Math.max(level, 0.75);
      if (face.kind === "bridge") level = Math.max(level, 0.3);
      if (face.kind === "mess" && opts.meal !== null) level = 0.97;
      const bucket = Math.round(level / 0.05);
      levels[i] = bucket * 0.05;
      sig += `|${face.index}:${bucket}`;
    }
    if (this.blister !== null) {
      const bridgeFace = this.faces.findIndex((f) => f.index === this.blister?.room);
      sig += `|b:${bridgeFace >= 0 ? Math.round((levels[bridgeFace] as number) / 0.05) : 0}`;
    }
    if (sig === this.lightSig) return;
    this.lightSig = sig;
    const ctx = this.lightCanvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, this.lightCanvas.width, this.lightCanvas.height);

    // The mess at table: a warm halo behind its windows first, so
    // the lit glass sits inside the glow.
    if (opts.meal !== null) {
      for (let i = 0; i < this.faces.length; i++) {
        const face = this.faces[i] as RoomFace;
        if (face.kind !== "mess") continue;
        ctx.globalAlpha = 0.55;
        ctx.drawImage(
          this.haloSprite,
          face.cx - 45,
          (this.bandY[face.deck] as number) - 16,
          90,
          32,
        );
      }
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i < this.faces.length; i++) {
      const face = this.faces[i] as RoomFace;
      const level = levels[i] as number;
      if (level <= 0.02) continue;
      ctx.fillStyle = ROOM_LIGHT[face.kind] ?? "#ffe9c4";
      ctx.globalAlpha = 0.25 + 0.7 * level;
      for (const win of face.windows) {
        if (win.hash < level) ctx.fillRect(win.x - 1, win.y - 1, 3, 2);
      }
    }
    ctx.globalAlpha = 1;
    if (this.blister !== null) {
      const face = this.faces.find((f) => f.index === this.blister?.room);
      if (face !== undefined) {
        const idx = this.faces.indexOf(face);
        const level = levels[idx] as number;
        if (level > 0.02) {
          ctx.fillStyle = ROOM_LIGHT.bridge as string;
          ctx.globalAlpha = 0.25 + 0.7 * level;
          for (const win of this.blister.windows) {
            if (win.hash < level) ctx.fillRect(win.x - 1, win.y - 1, 2, 2);
          }
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // ------------------------------------------------------------ live events

  /**
   * A staged moment at one system, fed by the DeckView at the same
   * instant the deck stages its own: sabotage flickers red at the
   * hull station, a failure flashes and vents, a repair rings
   * green on the skin. The witness outside sees what the witness
   * inside sees, in the hull's own language.
   */
  noteEvent(kind: StageKind, systemId: string, nowMs: number): void {
    const station = this.stations.get(systemId);
    if (station === undefined) return;
    const seed = strSeed(systemId) + ++this.seq;
    this.effects.push({
      kind,
      station,
      bornMs: nowMs,
      spanMs: SPAN_MS[kind],
      seed,
    });
    if (this.effects.length > 24) this.effects.splice(0, this.effects.length - 24);
    if (kind === "sabotage") {
      this.spawnSparks(station, 9, 26, SABOTAGE_COLOURS, nowMs, seed);
    } else if (kind === "failure") {
      this.spawnSparks(station, 12, 34, SPARK_COLOURS, nowMs, seed);
      this.spawnVapour(station, 6, nowMs, seed);
    }
  }

  private makeRoom(): boolean {
    if (this.particles.length < MAX_EXT_PARTICLES) return true;
    const idx = this.particles.findIndex((p) => p.kind !== "spark");
    if (idx >= 0) {
      this.particles.splice(idx, 1);
      return true;
    }
    return false;
  }

  private spawnSparks(
    station: HullStation,
    count: number,
    spread: number,
    colours: readonly string[],
    nowMs: number,
    seed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      if (!this.makeRoom()) return;
      const h1 = hash01(seed, i * 7 + 1);
      const h2 = hash01(seed, i * 11 + 3);
      this.particles.push({
        kind: "spark",
        x: station.x + (h1 - 0.5) * 5,
        y: station.y + (h2 - 0.5) * 3,
        vx: (h1 - 0.5) * spread,
        vy: -(3 + h2 * spread * 0.55),
        bornMs: nowMs,
        spanMs: 300 + h1 * 400,
        seed: seed + i,
        colour: colours[Math.floor(h2 * colours.length)] ?? (colours[0] as string),
      });
    }
  }

  private spawnVapour(
    station: HullStation,
    count: number,
    nowMs: number,
    seed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      if (!this.makeRoom()) return;
      const h1 = hash01(seed, i * 13 + 7);
      const h2 = hash01(seed, i * 17 + 11);
      this.particles.push({
        kind: "vapour",
        x: station.x + (h1 - 0.5) * 4,
        y: station.y,
        vx: -(4 + h1 * 5),
        vy: (station.deck === 0 ? -1 : 1) * (2 + h2 * 3),
        bornMs: nowMs,
        spanMs: 1100 + h1 * 500,
        seed: seed + i,
        colour: VAPOUR_COLOUR,
      });
    }
  }

  // ------------------------------------------------------------ the frame

  /**
   * Draw the ship from outside into the deck's context: the shake
   * transform and the sky are the caller's, already in place. The
   * plume rides behind the hull; then the three cached layers;
   * then everything that moves.
   */
  draw(ctx: CanvasRenderingContext2D, opts: ExteriorFrameOpts): void {
    const now = opts.now;
    this.syncWear(opts);
    this.syncLights(opts);

    // ---- engine plume, behind the hull
    const engines = this.ship.systems.find((s) => s.kind === "engines");
    let throttle = 0;
    if (engines !== undefined) {
      throttle = engines.condition * (opts.speedTps > 0 ? 1 : 0.22);
      if (engines.failed) {
        // A dead engine gutters: whole buckets of flicker.
        const bucket = Math.floor(now / 130);
        if (hash01(this.seedKey, bucket) < 0.35) throttle *= 0.25;
      }
    }
    if (throttle > 0.02) {
      const flicker =
        0.92 + 0.06 * Math.sin(now / 47) + 0.04 * Math.sin(now / 31 + 2);
      const len = (18 + 62 * throttle) * flicker;
      const h = 8 + 13 * throttle;
      ctx.globalAlpha = 0.25 + 0.65 * throttle;
      ctx.drawImage(
        this.plumeSprite,
        this.blockX - 8 - len,
        this.midY - h / 2,
        len,
        h,
      );
      ctx.globalAlpha = 1;
      // Exhaust shimmer: motes shed into the wake while she burns.
      this.shimmerAcc += opts.dtSec * (3 + 11 * throttle);
      while (this.shimmerAcc >= 1) {
        this.shimmerAcc -= 1;
        if (!this.makeRoom()) break;
        const seed = this.seedKey + ++this.seq;
        const h1 = hash01(seed, 3);
        const h2 = hash01(seed, 5);
        this.particles.push({
          kind: "shimmer",
          x: this.blockX - 8,
          y: this.midY + (h1 - 0.5) * 16,
          vx: -(13 + h2 * 11),
          vy: (h2 - 0.5) * 1.6,
          bornMs: now,
          spanMs: 900 + h1 * 800,
          seed,
          colour: "#9fc8e8",
        });
      }
    }

    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.drawImage(this.wearCanvas, 0, 0);
    ctx.drawImage(this.lightCanvas, 0, 0);

    // Nozzle glow rides on the bells, breathing with the burn.
    if (engines !== undefined && throttle > 0.02) {
      const pulse = 0.75 + 0.25 * Math.sin(now / 1000 + 1);
      ctx.globalAlpha = throttle * pulse * 0.8;
      ctx.drawImage(this.glowSprite, this.blockX - 22, this.midY - 16, 32, 32);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(190,225,255,${(0.25 + 0.6 * engines.condition).toFixed(3)})`;
      for (const dy of SLOT_DY) {
        ctx.fillRect(this.blockX - 8, this.midY + dy + 1, 3, 4);
      }
    }

    // ---- running lights: doubled in a storm, strobed on arrival
    for (const light of this.navLights) {
      let alpha: number;
      if (light.beacon) {
        alpha = Math.sin(now / 900 + light.phase) > 0.6 ? 1 : 0.15;
      } else {
        const blink = 0.5 + 0.5 * Math.sin(now / 1300 + light.phase);
        alpha = Math.min(1, 0.2 + 0.5 * blink + opts.navStrobe);
      }
      if (opts.storm) alpha = Math.min(1, alpha + 0.3);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = light.colour;
      ctx.fillRect(light.x - 1, light.y - 1, 3, 3);
      ctx.globalAlpha = alpha > 0.55 ? 1 : 0.35;
      ctx.fillRect(light.x, light.y, 1, 1);
      if (opts.navStrobe > 0.3 || opts.storm) {
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillRect(light.x - 2, light.y - 2, 5, 5);
      }
    }
    ctx.globalAlpha = 1;

    // ---- damage, live: a failed system vents; a critical one sparks
    for (const system of this.ship.systems) {
      const station = this.stations.get(system.id);
      if (station === undefined) continue;
      if (system.failed) {
        let acc = (this.ventAcc.get(system.id) ?? 0) + 15 * opts.dtSec;
        while (acc >= 1) {
          acc -= 1;
          this.spawnVapour(station, 1, now, strSeed(system.id) + Math.floor(now / 97));
        }
        this.ventAcc.set(system.id, acc);
      } else if (system.condition < 0.3) {
        let acc = (this.sparkAcc.get(system.id) ?? 0) + 9 * opts.dtSec;
        while (acc >= 1) {
          acc -= 1;
          this.spawnSparks(station, 1, 22, SPARK_COLOURS, now, strSeed(system.id) + Math.floor(now / 89));
        }
        this.sparkAcc.set(system.id, acc);
      }
    }

    // ---- staged moments at their stations
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i] as ExtEffect;
      const age = now - effect.bornMs;
      if (age < 0 || age >= effect.spanMs) {
        this.effects.splice(i, 1);
        continue;
      }
      const frac = age / effect.spanMs;
      const st = effect.station;
      if (effect.kind === "sabotage") {
        const bucket = Math.floor(age / 60);
        const hot = hash01(effect.seed, bucket) > 0.35;
        ctx.globalAlpha = (hot ? 0.3 : 0.06) * (1 - frac);
        ctx.fillStyle = "#e63c28";
        ctx.fillRect(st.x - 5, st.y - 4, 11, 9);
      } else if (effect.kind === "failure") {
        if (age < 130) {
          ctx.globalAlpha = 0.5 * (1 - age / 130);
          ctx.fillStyle = "#ffb35c";
          ctx.fillRect(st.x - 5, st.y - 4, 11, 9);
        }
      } else {
        const r = Math.round(2 + frac * 12);
        ctx.globalAlpha = 0.8 * (1 - frac);
        ctx.strokeStyle = "#7fd4a8";
        ctx.lineWidth = 1;
        ctx.strokeRect(st.x - r, st.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;

    // ---- particles: positions are pure functions of age
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i] as ExtParticle;
      const ageMs = now - p.bornMs;
      if (ageMs < 0 || ageMs >= p.spanMs) {
        this.particles.splice(i, 1);
        continue;
      }
      const ageS = ageMs / 1000;
      const frac = ageMs / p.spanMs;
      if (p.kind === "spark") {
        const drag = 1 - 0.35 * frac;
        const x = p.x + p.vx * ageS * drag;
        const y = p.y + p.vy * ageS * drag + 26 * ageS * ageS;
        ctx.globalAlpha = (1 - frac) * 0.95;
        ctx.fillStyle = p.colour;
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      } else if (p.kind === "vapour") {
        const x = p.x + p.vx * ageS;
        const y = p.y + p.vy * ageS;
        const size = Math.round(2 + frac * 5);
        ctx.globalAlpha = 0.3 * (1 - frac) * Math.min(1, frac * 5);
        ctx.fillStyle = p.colour;
        ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      } else {
        const x = p.x + p.vx * ageS;
        const y = p.y + p.vy * ageS + Math.sin(ageS * 3 + p.seed) * 1.5;
        ctx.globalAlpha = 0.4 * (1 - frac);
        ctx.fillStyle = p.colour;
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ picking

  /**
   * The deck a tap on the hull belongs to: the engine block and
   * the lower hull go to the working deck, the blister and the
   * upper hull to the living deck. Outside the ship, null.
   */
  pickSection(xPx: number, yPx: number): number | null {
    if (xPx < this.blockX - 10 || xPx > this.bowTipX + 2) return null;
    if (yPx < this.hullTop - 24 || yPx > this.hullBottom + 14) return null;
    if (this.blister !== null) {
      const b = this.blister;
      if (Math.abs(xPx - b.cx) <= b.rx + 3 && yPx <= b.baseY + 2 && yPx >= b.baseY - 14) {
        return 0;
      }
    }
    if (xPx < this.sternX + 26) return 1;
    return yPx <= this.midY ? 0 : 1;
  }
}
