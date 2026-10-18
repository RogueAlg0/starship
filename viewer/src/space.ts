// Space: the moving backdrop behind the hull.
//
// EVE taught everyone what a travelling ship should feel like: the
// stars slide past, nebulae hang in the black, and even standing
// still the view breathes. This is that feeling, generated per
// voyage from the ship's seed by viewer-local hash arithmetic: the
// same voyage always sails the same sector of space, and no two
// seeds share quite the same sky. The engine never hears about it.
//
// Three layers, parallax by distance: a far layer (nebula clouds and
// the densest, dimmest stars) crawls; a mid layer of ordinary stars
// moves faster; a near layer of a few bright stars, some with a
// cross sparkle, is drawn live each frame and moves fastest. The
// nebula and the far and mid layers are pre-rendered once per voyage
// into offscreen canvases the size of the deck and drawn with a
// wraparound offset, so per-frame cost is a few blits and a few
// dozen star points.
//
// Drift speed scales with playback speed (the ship is underway);
// paused, the field keeps an almost imperceptible drift (a twentieth
// of the slowest sail), because space breathes even at anchor.

import { hash01 } from "./faces.ts";

interface NebulaPalette {
  /** The wash that tints the whole sky. */
  deep: string;
  /** Blob body colour. */
  mid: string;
  /** Blob heart colour. */
  glow: string;
}

/**
 * The curated sky palettes: low saturation, darker than the ship, so
 * the deck stays the subject. Each voyage takes one primary palette
 * for most of its clouds and a second for a couple of accents.
 */
const PALETTES: readonly NebulaPalette[] = [
  { deep: "#07222b", mid: "#0d3a47", glow: "#1a6175" }, // deep teal
  { deep: "#180b31", mid: "#2a1650", glow: "#4a2c80" }, // violet
  { deep: "#240d05", mid: "#3d1c0a", glow: "#6b3410" }, // ember
  { deep: "#220a1c", mid: "#3a1230", glow: "#63244e" }, // rose
  { deep: "#081426", mid: "#10263f", glow: "#204a75" }, // ice blue
];

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

interface NearStar {
  /** Position as a fraction of the canvas, so wrapping is trivial. */
  fx: number;
  fy: number;
  phase: number;
  /** One of the bright few: drawn with a pulsing cross sparkle. */
  sparkle: boolean;
}

const FAR_SPEED = 0.7; // px per second at drift factor 1
const MID_SPEED = 2.2;
const NEAR_SPEED = 6.5;
/** Paused drift: space breathes, it does not stop. */
const PAUSED_FACTOR = 0.05;

export class SpaceBackdrop {
  private readonly width: number;
  private readonly height: number;
  private readonly farCanvas: HTMLCanvasElement;
  private readonly midCanvas: HTMLCanvasElement;
  private readonly nearStars: NearStar[] = [];
  private farOff = 0;
  private midOff = 0;
  private nearOff = 0;

  constructor(seedKey: number, width: number, height: number) {
    this.width = width;
    this.height = height;
    const primary =
      PALETTES[Math.floor(hash01(seedKey, 901) * PALETTES.length)] ??
      (PALETTES[0] as NebulaPalette);
    let accentIdx = Math.min(
      PALETTES.length - 1,
      Math.floor(hash01(seedKey, 907) * PALETTES.length),
    );
    if (PALETTES[accentIdx] === primary) {
      accentIdx = (accentIdx + 1) % PALETTES.length;
    }
    const accent = PALETTES[accentIdx] as NebulaPalette;
    this.farCanvas = this.renderFar(seedKey, primary, accent);
    this.midCanvas = this.renderStars(seedKey, 911, 120, true);
    for (let i = 0; i < 34; i++) {
      this.nearStars.push({
        fx: hash01(seedKey, 1300 + i * 3),
        fy: hash01(seedKey, 1301 + i * 3),
        phase: hash01(seedKey, 1302 + i * 3) * Math.PI * 2,
        sparkle: i < 7,
      });
    }
  }

  /** A wraparound blit: the layer drawn twice, offset by `off`. */
  private blitWrapped(
    ctx: CanvasRenderingContext2D,
    layer: HTMLCanvasElement,
    off: number,
  ): void {
    const w = this.width;
    const o = ((off % w) + w) % w;
    ctx.drawImage(layer, -o, 0);
    if (o > 0) ctx.drawImage(layer, w - o, 0);
  }

  private renderFar(
    seedKey: number,
    primary: NebulaPalette,
    accent: NebulaPalette,
  ): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return canvas;
    const w = this.width;
    const h = this.height;
    ctx.fillStyle = "#04060a";
    ctx.fillRect(0, 0, w, h);
    // The palette's deep wash over the whole sky.
    const wash = ctx.createLinearGradient(0, 0, w * 0.3, h);
    wash.addColorStop(0, rgba(primary.deep, 0.55));
    wash.addColorStop(0.6, rgba(primary.deep, 0.18));
    wash.addColorStop(1, rgba(accent.deep, 0.4));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
    // Nebula clouds: soft radial blobs, drawn at wraparound offsets
    // so the scrolling layer tiles seamlessly.
    const blobs = 8;
    for (let i = 0; i < blobs; i++) {
      const useAccent = i >= blobs - 2;
      const pal = useAccent ? accent : primary;
      const cx = hash01(seedKey, 1000 + i * 7) * w;
      const cy = hash01(seedKey, 1001 + i * 7) * h;
      const r = 50 + hash01(seedKey, 1002 + i * 7) * 130;
      const strength = 0.5 + hash01(seedKey, 1003 + i * 7) * 0.5;
      for (const ox of [-w, 0, w]) {
        for (const oy of [-h, 0, h]) {
          const grad = ctx.createRadialGradient(
            cx + ox,
            cy + oy,
            r * 0.08,
            cx + ox,
            cy + oy,
            r,
          );
          grad.addColorStop(0, rgba(pal.glow, 0.16 * strength));
          grad.addColorStop(0.55, rgba(pal.mid, 0.13 * strength));
          grad.addColorStop(1, rgba(pal.mid, 0));
          ctx.fillStyle = grad;
          ctx.fillRect(cx + ox - r, cy + oy - r, r * 2, r * 2);
        }
      }
    }
    // Far stars: the densest, dimmest layer, part of this canvas.
    for (let i = 0; i < 320; i++) {
      const x = hash01(seedKey, 1100 + i * 3) * w;
      const y = hash01(seedKey, 1101 + i * 3) * h;
      const b = hash01(seedKey, 1102 + i * 3);
      ctx.fillStyle =
        b > 0.9 ? "#aebdd4" : b > 0.55 ? "#66779a" : "#3d4a63";
      ctx.globalAlpha = 0.35 + b * 0.5;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  private renderStars(
    seedKey: number,
    salt: number,
    count: number,
    mid: boolean,
  ): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return canvas;
    const w = this.width;
    const h = this.height;
    for (let i = 0; i < count; i++) {
      const x = hash01(seedKey, salt + i * 3) * w;
      const y = hash01(seedKey, salt + i * 3 + 1) * h;
      const b = hash01(seedKey, salt + i * 3 + 2);
      ctx.fillStyle = b > 0.85 ? "#dfe8f5" : b > 0.5 ? "#93a7c4" : "#5a6c8c";
      ctx.globalAlpha = mid ? 0.5 + b * 0.5 : 0.85;
      ctx.fillRect(x, y, 1, 1);
      if (b > 0.93) ctx.fillRect(x, y + 1, 1, 1); // a few stand taller
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  /**
   * Advance the drift and draw the nebula, far, and mid layers.
   * Called once per frame before the deck; drawNear follows after
   * the ship so the bright stars stay crisp over the night tint.
   */
  drawFar(
    ctx: CanvasRenderingContext2D,
    dtSec: number,
    speedTps: number,
  ): void {
    const factor =
      speedTps > 0 ? 0.45 + Math.sqrt(speedTps) : PAUSED_FACTOR;
    this.farOff += dtSec * FAR_SPEED * factor;
    this.midOff += dtSec * MID_SPEED * factor;
    this.nearOff += dtSec * NEAR_SPEED * factor;
    this.blitWrapped(ctx, this.farCanvas, this.farOff);
    this.blitWrapped(ctx, this.midCanvas, this.midOff);
  }

  /** The near layer: bright stars, the sparkled few pulsing. */
  drawNear(ctx: CanvasRenderingContext2D, now: number): void {
    const w = this.width;
    const h = this.height;
    for (const star of this.nearStars) {
      const fx = (((star.fx - this.nearOff / w) % 1) + 1) % 1;
      const x = Math.round(fx * w);
      const y = Math.round(star.fy * h);
      const pulse = 0.6 + 0.4 * Math.sin(now / 600 + star.phase);
      if (star.sparkle) {
        ctx.globalAlpha = 0.95 * pulse + 0.05;
        ctx.fillStyle = "#f2f7ff";
        ctx.fillRect(x, y, 1, 1);
        ctx.globalAlpha = 0.45 * pulse;
        ctx.fillRect(x - 2, y, 1, 1);
        ctx.fillRect(x + 2, y, 1, 1);
        ctx.fillRect(x, y - 2, 1, 1);
        ctx.fillRect(x, y + 2, 1, 1);
        ctx.globalAlpha = 0.2 * pulse;
        ctx.fillRect(x - 3, y, 1, 1);
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x, y - 3, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);
      } else {
        ctx.globalAlpha = 0.55 + 0.4 * pulse;
        ctx.fillStyle = "#cdd9ec";
        ctx.fillRect(x, y, 1, 1);
        if (star.phase > 4.5) ctx.fillRect(x, y + 1, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }
}
