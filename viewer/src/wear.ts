// Wear: the ship as a wound report.
//
// The faces set the doctrine: a portrait is painted from identity,
// then live state is painted over it, so the face is a status report.
// This module applies the same rule to the ship herself. Every mark
// on the deck derives from state the viewer already holds: each
// system's condition now, its worst condition observed this run,
// its repair history read off the frame stream, and the engines'
// worst day written onto the hull. The viewer invents nothing, and
// the engine stores nothing new: the tracks live here and die with
// the page.
//
// Three kinds of mark:
//
// - Damage wear, per system. Scorch blotches around the system's
//   equipment, scuffs on the floor, grime streaks down a wall, and
//   (when it is bad) a panel knocked askew. Intensity reads BOTH
//   the current condition and the worst condition observed this
//   run, so a system repaired back to 95% keeps most of its
//   scorch. Getting hurt leaves a mark; getting fixed does not
//   erase it.
// - Repair patches. When a system that fell below 60% climbs back
//   above 80%, a patch is stamped beside its equipment: a lighter
//   plate with rivet dots and a weld-bead edge, on floor someone
//   scrubbed clean. One patch per damage and repair cycle, and
//   patches persist for the rest of the run.
// - Hull wear. Scorch and pitting at the engine block, scaled by
//   the engines' worst observed condition, plus exhaust staining
//   on the stern plating that grows very slowly with elapsed
//   ticks and caps low: the ship ages under way.
//
// Performance follows the static deck's pattern: wear is painted
// into an offscreen canvas the size of the deck and repainted only
// when an input crosses a bucket boundary (condition in 5% bands,
// a new worst low, a new patch, an age step of five ship days).
// Per frame the cost is one drawImage, set under the day/night
// tint with the static deck; sparks and glows stay above both.

import type { Ship } from "../../src/world/ship.ts";
import type { ShipSystem } from "../../src/world/systems.ts";
import { hash01 } from "./faces.ts";
import type { DeckLayout } from "./deck.ts";

/** Pixel geometry of the hull exterior, computed in deck.ts. */
export interface WearGeom {
  tile: number;
  ox: number;
  oy: number;
  engineBlock: { x: number; y: number; w: number; h: number };
  exhaustSlots: Array<{ x: number; y: number; w: number; h: number }>;
  hullTop: number;
  hullBottom: number;
  sternX: number;
}

/** Condition is bucketed in 5% bands for repaint decisions. */
const BAND = 0.05;
/** A system below this counts as hurt for the patch rule. */
const HURT_BELOW = 0.6;
/** A hurt system back above this has recovered: stamp a patch. */
const RECOVERED_ABOVE = 0.8;
/** The share of worst-ever damage that survives a full repair. */
const SCAR_KEEP = 0.8;
/** Repaint the age stain at most once per this many ticks. */
const AGE_STEP_TICKS = 720; // five ship days
/** Elapsed ticks at which the exhaust staining reaches its cap. */
const AGE_FULL_TICKS = 12960; // ninety ship days
/** The age stain never gets darker than this. */
const AGE_MAX_ALPHA = 0.15;

function bandOf(condition: number): number {
  return Math.max(0, Math.min(20, Math.floor(condition / BAND)));
}

/** FNV-1a over the system id, the same hash the deck layout uses. */
function strHash(text: string): number {
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

interface SystemTrack {
  /** Condition at the latest frame. */
  current: number;
  /** Worst (lowest) condition observed this run. */
  worst: number;
  /** Fell below HURT_BELOW since the last stamped patch. */
  hurt: boolean;
  /** Repair patches stamped this run. */
  patches: number;
}

/** A read-only view of one system's wear state, for tests and tools. */
export interface WearTrackView {
  current: number;
  worst: number;
  patches: number;
  /** Effective damage the decals are scaled by, in [0, 1]. */
  damage: number;
}

/**
 * How hurt a system looks: the worse of how hurt it is and most of
 * how hurt it has ever been. This is the line that makes a repaired
 * system keep its scorch.
 */
function damageOf(track: SystemTrack): number {
  return Math.max(1 - track.current, (1 - track.worst) * SCAR_KEEP);
}

/** Wear intensity band: 0 none, 1 faint, 2 clear, 3 heavy. */
function levelOf(damage: number): number {
  if (damage < 0.15) return 0;
  if (damage < 0.4) return 1;
  if (damage < 0.7) return 2;
  return 3;
}

export class WearLayer {
  readonly canvas: HTMLCanvasElement;
  /** How many times the wear canvas has been painted. */
  renderCount = 0;

  private readonly layout: DeckLayout;
  private readonly geom: WearGeom;
  private readonly tracks = new Map<string, SystemTrack>();
  private signature = "";
  private ageAlpha = 0;

  constructor(layout: DeckLayout, geom: WearGeom) {
    this.layout = layout;
    this.geom = geom;
    this.canvas = document.createElement("canvas");
    this.canvas.width = layout.widthPx;
    this.canvas.height = layout.heightPx;
  }

  /** One system's wear state, or undefined if never observed. */
  trackOf(systemId: string): WearTrackView | undefined {
    const track = this.tracks.get(systemId);
    if (track === undefined) return undefined;
    return {
      current: track.current,
      worst: track.worst,
      patches: track.patches,
      damage: damageOf(track),
    };
  }

  /** Repair patches stamped for one system this run. */
  patchCount(systemId: string): number {
    return this.tracks.get(systemId)?.patches ?? 0;
  }

  /**
   * Observe one frame of the run. Tracks update from the ship's
   * live conditions; the canvas repaints only when a bucketed
   * input changed. Returns true when it repainted.
   */
  update(ship: Ship, tick: number): boolean {
    const parts: string[] = [];
    for (const system of ship.systems) {
      let track = this.tracks.get(system.id);
      if (track === undefined) {
        track = {
          current: system.condition,
          worst: system.condition,
          hurt: system.condition < HURT_BELOW,
          patches: 0,
        };
        this.tracks.set(system.id, track);
      }
      track.current = system.condition;
      if (system.condition < track.worst) track.worst = system.condition;
      if (system.condition < HURT_BELOW) track.hurt = true;
      if (track.hurt && system.condition >= RECOVERED_ABOVE) {
        // The damage and repair cycle closes: stamp the patch.
        track.patches += 1;
        track.hurt = false;
      }
      parts.push(
        `${system.id}:${bandOf(track.current)}:${bandOf(track.worst)}:${track.patches}`,
      );
    }
    this.ageAlpha = Math.min(
      AGE_MAX_ALPHA,
      (Math.max(0, tick) / AGE_FULL_TICKS) * AGE_MAX_ALPHA,
    );
    parts.push(`age:${Math.floor(Math.max(0, tick) / AGE_STEP_TICKS)}`);
    const signature = parts.join("|");
    if (signature === this.signature) return false;
    this.signature = signature;
    this.render(ship);
    this.renderCount += 1;
    return true;
  }

  /** Blit the wear canvas. Called once per frame, after the deck. */
  draw(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.canvas, 0, 0);
  }

  // ------------------------------------------------------------ paint

  private render(ship: Ship): void {
    const ctx = this.canvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.renderHull(ctx, ship);
    for (const system of ship.systems) {
      const track = this.tracks.get(system.id);
      if (track === undefined) continue;
      this.renderSystem(ctx, system, track);
    }
  }

  /** Hull wear: the engines' worst day, and the ship's age. */
  private renderHull(ctx: CanvasRenderingContext2D, ship: Ship): void {
    const { geom } = this;
    const block = geom.engineBlock;

    // Age: a faint soot wash over the engine block, and staining
    // along the stern plating bands. Subtle, capped, and slow.
    if (this.ageAlpha > 0.004) {
      ctx.fillStyle = `rgba(14,12,9,${(this.ageAlpha * 0.8).toFixed(3)})`;
      ctx.fillRect(block.x, block.y, block.w, block.h);
      ctx.fillStyle = `rgba(14,12,9,${this.ageAlpha.toFixed(3)})`;
      const span = 150;
      for (let sgm = 0; sgm < 3; sgm++) {
        const a = this.ageAlpha * (1 - sgm / 3);
        ctx.fillStyle = `rgba(14,12,9,${a.toFixed(3)})`;
        const x = geom.sternX + 6 + sgm * (span / 3);
        ctx.fillRect(x, geom.hullTop + 1, span / 3, geom.tile - 2);
        ctx.fillRect(
          x,
          geom.hullBottom - geom.tile + 1,
          span / 3,
          geom.tile - 2,
        );
      }
    }

    const engines = ship.systems.find((s) => s.kind === "engines");
    if (engines === undefined) return;
    const track = this.tracks.get(engines.id);
    if (track === undefined) return;
    const depth = 1 - track.worst;
    if (depth <= 0.15) return;

    // Scorch: a dark halo on the block face around each exhaust
    // slot, and a soot streak blown across the block from the slot.
    for (const slot of geom.exhaustSlots) {
      ctx.fillStyle = `rgba(9,7,5,${(0.4 * depth).toFixed(3)})`;
      ctx.fillRect(slot.x - 1, slot.y - 2, slot.w + 3, slot.h + 4);
      const len = 5 + depth * 16;
      for (let sgm = 0; sgm < 3; sgm++) {
        const a = 0.34 * depth * (1 - sgm / 3);
        ctx.fillStyle = `rgba(9,7,5,${a.toFixed(3)})`;
        ctx.fillRect(
          slot.x + slot.w + sgm * (len / 3),
          slot.y,
          len / 3,
          slot.h,
        );
      }
    }

    // Pitting: small dark pits scattered over the stern plating
    // bands and the block face, counted by the engines' worst day.
    const seedKey = this.layout.seedKey;
    const pits = Math.round(depth * 36);
    for (let i = 0; i < pits; i++) {
      const h1 = hash01(seedKey, 77003 + i * 5);
      const h2 = hash01(seedKey, 77004 + i * 5);
      const h3 = hash01(seedKey, 77005 + i * 5);
      let x: number;
      let y: number;
      if (h3 < 0.3) {
        x = block.x + h1 * block.w;
        y = block.y + h2 * block.h;
      } else if (h2 < 0.5) {
        x = geom.sternX + 4 + h1 * 150;
        y = geom.hullTop + 1 + h3 * (geom.tile - 2);
      } else {
        x = geom.sternX + 4 + h1 * 150;
        y = geom.hullBottom - geom.tile + 1 + h3 * (geom.tile - 2);
      }
      ctx.fillStyle = "rgba(8,8,10,0.55)";
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }

  /** One system's marks: patches first, then the damage over them. */
  private renderSystem(
    ctx: CanvasRenderingContext2D,
    system: ShipSystem,
    track: SystemTrack,
  ): void {
    const anchor = this.layout.systemAnchor.get(system.id);
    const roomLayout = this.layout.rooms[system.room];
    if (anchor === undefined || roomLayout === undefined) return;
    const { rect } = roomLayout;
    const { tile, ox, oy } = this.geom;
    const rx = (rect.x + ox) * tile;
    const ry = (rect.y + oy) * tile;
    const ix = rx + tile;
    const iy = ry + tile;
    const iw = (rect.w - 2) * tile;
    const ih = (rect.h - 2) * tile;
    const seedKey = this.layout.seedKey;
    const sysSeed = strHash(system.id);
    const salt = (k: number): number => sysSeed * 131 + k;

    // Repair patches persist even on a pristine system: draw them
    // under any newer damage, the way a real plate sits under soot.
    for (let i = 0; i < track.patches; i++) {
      const pcx = clamp(
        anchor.px + (hash01(seedKey, salt(900 + i * 3)) - 0.5) * 26,
        ix + 9,
        ix + iw - 9,
      );
      const pcy = clamp(
        anchor.py + 7 + (hash01(seedKey, salt(901 + i * 3)) - 0.5) * 12,
        iy + 7,
        iy + ih - 7,
      );
      // Scrubbed floor: someone cleaned up after the repair crew.
      ctx.fillStyle = "rgba(190,205,225,0.055)";
      ctx.fillRect(pcx - 8, pcy - 6, 16, 12);
      // The plate itself: lighter metal than the deck around it.
      ctx.fillStyle = "#55678a";
      ctx.fillRect(pcx - 5, pcy - 3, 10, 6);
      // Weld bead: light dots along the long edges.
      ctx.fillStyle = "#93a7c2";
      for (let x = -5; x < 5; x += 2) {
        ctx.fillRect(pcx + x, pcy - 3, 1, 1);
        ctx.fillRect(pcx + x, pcy + 2, 1, 1);
      }
      // Rivets: dark dots at the corners.
      ctx.fillStyle = "#232c3d";
      ctx.fillRect(pcx - 4, pcy - 2, 1, 1);
      ctx.fillRect(pcx + 3, pcy - 2, 1, 1);
      ctx.fillRect(pcx - 4, pcy + 1, 1, 1);
      ctx.fillRect(pcx + 3, pcy + 1, 1, 1);
    }

    const damage = damageOf(track);
    const level = levelOf(damage);
    if (level === 0) return;

    // Scorch blotches around the system's equipment: irregular
    // dark blooms, more and darker as the damage deepens.
    const radius = 5 + damage * 9;
    const blobs = level === 1 ? 2 : level === 2 ? 4 : 6;
    const scorchAlpha = 0.08 + damage * 0.22;
    ctx.fillStyle = `rgba(10,8,6,${scorchAlpha.toFixed(3)})`;
    for (let i = 0; i < blobs; i++) {
      const cx =
        anchor.px + (hash01(seedKey, salt(100 + i * 4)) - 0.5) * 2 * radius;
      const cy =
        anchor.py + (hash01(seedKey, salt(101 + i * 4)) - 0.5) * 2 * radius * 0.7;
      const r = 1.6 + hash01(seedKey, salt(102 + i * 4)) * 3.2;
      for (let j = 0; j < 3; j++) {
        const jx = (hash01(seedKey, salt(103 + i * 4 + j * 17)) - 0.5) * 3;
        const jy = (hash01(seedKey, salt(113 + i * 4 + j * 17)) - 0.5) * 2;
        ctx.beginPath();
        ctx.ellipse(cx + jx, cy + jy, r * (1 - j * 0.25), r * 0.62, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Floor scuffs: short dark strokes on the room floor, biased
    // toward the equipment and the traffic around it.
    const scuffs = 2 + Math.round(damage * 7);
    ctx.fillStyle = `rgba(8,9,11,${(0.12 + damage * 0.2).toFixed(3)})`;
    for (let i = 0; i < scuffs; i++) {
      const sx = clamp(
        anchor.px + (hash01(seedKey, salt(200 + i * 4)) - 0.5) * 32,
        ix + 1,
        ix + iw - 6,
      );
      const sy = clamp(
        anchor.py + (hash01(seedKey, salt(201 + i * 4)) - 0.5) * 22,
        iy + 1,
        iy + ih - 2,
      );
      const len = 2 + hash01(seedKey, salt(202 + i * 4)) * 4;
      if (hash01(seedKey, salt(203 + i * 4)) > 0.8) {
        ctx.fillRect(sx, sy, 1, len);
      } else {
        ctx.fillRect(sx, sy, len, 1);
      }
    }

    // Grime streaks: run down the nearer wall from the equipment,
    // longer and darker as the damage deepens.
    const streaks = level >= 2 ? 2 : 1;
    const streakAlpha = 0.1 + damage * 0.16;
    ctx.fillStyle = `rgba(18,16,12,${streakAlpha.toFixed(3)})`;
    const topHalf = anchor.py - ry < (rect.h * tile) / 2;
    for (let i = 0; i < streaks; i++) {
      const gx =
        anchor.px + (hash01(seedKey, salt(300 + i * 3)) - 0.5) * 16;
      const len = 4 + damage * 11 + hash01(seedKey, salt(301 + i * 3)) * 3;
      if (topHalf) {
        ctx.fillRect(gx, ry + 1, 2, len);
      } else {
        ctx.fillRect(gx, ry + rect.h * tile - 1 - len, 2, len);
      }
    }

    // A panel knocked askew: clear damage and worse only. At heavy
    // damage it hangs further off true, with debris at its feet.
    if (level >= 2) {
      const px =
        anchor.px + (hash01(seedKey, salt(400)) - 0.5) * 18;
      const py = anchor.py + (hash01(seedKey, salt(401)) - 0.5) * 14 + 4;
      const angle =
        (hash01(seedKey, salt(402)) - 0.5) * (level === 3 ? 0.9 : 0.5);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.fillStyle = "#2a3446";
      ctx.fillRect(-4, -3, 8, 6);
      ctx.fillStyle = "#46536b";
      ctx.fillRect(-3, -2, 6, 4);
      ctx.fillStyle = "#6d7f96";
      ctx.fillRect(-3, -2, 6, 1);
      ctx.restore();
      if (level === 3) {
        ctx.fillStyle = "rgba(8,8,10,0.5)";
        for (let i = 0; i < 3; i++) {
          const dx = px + (hash01(seedKey, salt(410 + i * 2)) - 0.5) * 10;
          const dy = py + 4 + hash01(seedKey, salt(411 + i * 2)) * 3;
          ctx.fillRect(dx, dy, 1, 1);
        }
      }
    }
  }
}
