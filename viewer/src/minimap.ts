// Minimap: both decks at a glance. The main canvas shows one deck;
// the minimap is how the other deck stays in the room. It draws the
// two deck silhouettes stacked in the same tile coordinate frame as
// deck.ts, room blocks as faint rectangles, lift shafts as pairs of
// ticks, crew as department-colour dots at their room positions, and
// a pulsing outline on any room whose worst system is critical (red
// under 30%, amber under 60%), the same thresholds the sparks use.
// Tapping a deck's half switches the main view to it. The layer is
// presentation only: it reads the layout, engine state, and the deck
// view's live body positions, and writes nothing back but the switch
// request. Updates are throttled by the caller (about 250ms).

import type { CrewMember } from "../../src/entities/crew.ts";
import type { Ship } from "../../src/world/ship.ts";
import { departmentOf } from "./faces.ts";
import { OX, TILE_PX, type ShipLayout } from "./deck.ts";

/** Native canvas size: both decks stacked at a tenth of deck scale. */
export const MINIMAP_W = 176;
export const MINIMAP_H = 56;

const DECK_H_TILES = 21;
const PAD_PX = 3;
const GAP_PX = 4;

interface Zone {
  deck: number;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layout: ShipLayout;
  private readonly zones: [Zone, Zone];

  constructor(layout: ShipLayout, canvas: HTMLCanvasElement) {
    this.layout = layout;
    this.canvas = canvas;
    canvas.width = MINIMAP_W;
    canvas.height = MINIMAP_H;
    this.ctx = canvas.getContext("2d");
    const innerW = MINIMAP_W - PAD_PX * 2;
    const zoneH = (MINIMAP_H - PAD_PX * 2 - GAP_PX) / 2;
    const tilesW = layout.widthPx / TILE_PX;
    const scale = Math.min(innerW / tilesW, zoneH / DECK_H_TILES);
    const drawnW = tilesW * scale;
    const x0 = PAD_PX + (innerW - drawnW) / 2;
    this.zones = [0, 1].map((deck) => ({
      deck,
      x: x0,
      y: PAD_PX + deck * (zoneH + GAP_PX),
      w: drawnW,
      h: DECK_H_TILES * scale,
      scale,
    })) as [Zone, Zone];
  }

  /** The deck under a tap in canvas pixels, or null outside both. */
  deckAt(xPx: number, yPx: number): number | null {
    for (const zone of this.zones) {
      if (
        xPx >= zone.x &&
        xPx <= zone.x + zone.w &&
        yPx >= zone.y - GAP_PX / 2 &&
        yPx <= zone.y + zone.h + GAP_PX / 2
      ) {
        return zone.deck;
      }
    }
    return null;
  }

  draw(
    ship: Ship,
    crew: readonly CrewMember[],
    snapshot: ReadonlyArray<{
      id: string;
      deck: number;
      room: number;
      fx: number;
      fy: number;
    }>,
    visibleDeck: number,
    now: number,
  ): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
    ctx.fillStyle = "#0b0f16";
    ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);
    const condById = new Map(ship.systems.map((s) => [s.id, s.condition]));

    for (const zone of this.zones) {
      const plan = this.layout.decks[zone.deck];
      if (plan === undefined) continue;
      const toPx = (tx: number, ty: number): [number, number] => [
        zone.x + (tx + OX) * zone.scale,
        zone.y + ty * zone.scale,
      ];
      // Silhouette: the deck's extent, rooms over it.
      ctx.fillStyle = zone.deck === visibleDeck ? "#232c3d" : "#161d29";
      ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
      for (const room of plan.rooms) {
        if (room === undefined) continue;
        const [rx, ry] = toPx(room.rect.x, room.rect.y);
        ctx.fillStyle =
          zone.deck === visibleDeck ? "#39465c" : "#2a3448";
        ctx.fillRect(
          rx,
          ry,
          room.rect.w * zone.scale,
          room.rect.h * zone.scale,
        );
        let worst = 1;
        for (const id of room.systemIds) {
          worst = Math.min(worst, condById.get(id) ?? 1);
        }
        if (worst < 0.6) {
          const pulse = 0.55 + 0.45 * Math.sin(now / 320);
          ctx.strokeStyle =
            worst < 0.3
              ? `rgba(255, 70, 50, ${pulse.toFixed(3)})`
              : `rgba(255, 165, 60, ${(pulse * 0.85).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(
            rx + 0.5,
            ry + 0.5,
            room.rect.w * zone.scale - 1,
            room.rect.h * zone.scale - 1,
          );
        }
      }
      // Lifts: the paired ticks the eye learns from the main canvas.
      ctx.fillStyle = "#e8a33d";
      for (const lift of this.layout.lifts) {
        const [lx, ly] = toPx(lift.x, 9);
        ctx.fillRect(lx, ly, Math.max(1, 2 * zone.scale), 3 * zone.scale);
      }
      // The visible deck gets the frame.
      if (zone.deck === visibleDeck) {
        ctx.strokeStyle = "#8fa6c4";
        ctx.lineWidth = 1;
        ctx.strokeRect(zone.x + 0.5, zone.y + 0.5, zone.w - 1, zone.h - 1);
      }
      ctx.fillStyle = "#8fa6c4";
      ctx.font = "6px monospace";
      ctx.textAlign = "left";
      ctx.fillText(
        zone.deck === 0 ? "DECK 1" : "DECK 2",
        zone.x + 2,
        zone.y + 7,
      );
    }
    // Crew dots: department colour, a hair larger than their room.
    const byId = new Map(snapshot.map((s) => [s.id, s]));
    for (const member of crew) {
      const snap = byId.get(member.id);
      if (snap === undefined) continue;
      const zone = this.zones[snap.deck];
      const plan = this.layout.decks[snap.deck];
      const room = plan?.rooms[snap.room];
      if (zone === undefined || room === undefined) continue;
      const cx =
        zone.x +
        (room.rect.x + OX + snap.fx * room.rect.w) * zone.scale;
      const cy = zone.y + (room.rect.y + snap.fy * room.rect.h) * zone.scale;
      ctx.fillStyle = departmentOf(member.roleKey).colour;
      ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2);
    }
  }
}
