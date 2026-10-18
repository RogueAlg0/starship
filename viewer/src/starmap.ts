// The star map: the sector the voyage crosses, drawn as a chart.
//
// The deck views show the ship; this one shows the water. Ports are
// points with names and faction colours, the chartered route is a
// line across the sector, and the ship is a marker that walks it as
// the ticks pass — her position read from the voyage's own
// arithmetic (positionAt), never simulated here. The static chart
// (backdrop, grid, route, ports, labels) paints once per voyage
// into an offscreen canvas, in the space backdrop's own palettes;
// per frame the map blits it and draws only the travelled line, the
// ship marker, and two pulses. The engine never hears about it.

import { CONFIG } from "../../src/scenario/config.ts";
import type { Port, Sector, Voyage } from "../../src/world/galaxy.ts";
import { SpaceBackdrop } from "./space.ts";

/** Faction colours by faction index; independence is harbour grey. */
const FACTION_COLOURS = [
  "#e8a33d",
  "#57c465",
  "#4a7fd4",
  "#c44b4b",
  "#b07fd4",
  "#4fc4b5",
] as const;
const INDEPENDENT_COLOUR = "#8fa3bf";
const GRID_LIGHT_DAYS = 10;
const PAD_PX = 30;

export type MapPick =
  | { kind: "port"; port: Port }
  | { kind: "ship" }
  | null;

export class StarMapView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly sector: Sector;
  private readonly voyage: Voyage;
  private readonly shipName: string;
  private readonly backdrop: SpaceBackdrop;
  private staticLayer: HTMLCanvasElement | null = null;
  private builtW = 0;
  private builtH = 0;
  private ox = 0;
  private oy = 0;
  private scale = 1;

  constructor(
    canvas: HTMLCanvasElement,
    sector: Sector,
    voyage: Voyage,
    shipName: string,
    seedKey: number,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.sector = sector;
    this.voyage = voyage;
    this.shipName = shipName;
    this.backdrop = new SpaceBackdrop(
      seedKey,
      Math.max(1, canvas.width),
      Math.max(1, canvas.height),
    );
  }

  private project(x: number, y: number): { px: number; py: number } {
    const span = CONFIG.galaxy.sectorSpanLightDays;
    return {
      px: this.ox + x * this.scale,
      py: this.oy + (span - y) * this.scale,
    };
  }

  private factionColour(port: Port): string {
    if (port.faction === null) return INDEPENDENT_COLOUR;
    return (
      FACTION_COLOURS[port.faction % FACTION_COLOURS.length] ??
      INDEPENDENT_COLOUR
    );
  }

  /** Lay out the chart and paint the static layer, once per size. */
  private ensureStatic(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.staticLayer !== null && w === this.builtW && h === this.builtH) {
      return;
    }
    this.builtW = w;
    this.builtH = h;
    const span = CONFIG.galaxy.sectorSpanLightDays;
    this.scale = Math.min((w - PAD_PX * 2) / span, (h - PAD_PX * 2) / span);
    this.ox = (w - span * this.scale) / 2;
    this.oy = (h - span * this.scale) / 2;

    const layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    const ctx = layer.getContext("2d");
    if (ctx === null) {
      this.staticLayer = layer;
      return;
    }
    ctx.fillStyle = "#04060a";
    ctx.fillRect(0, 0, w, h);
    // The sector's own sky, held still: the backdrop at rest.
    this.backdrop.drawFar(ctx, 0, 0);

    // The chart grid, with its scale written on it.
    ctx.strokeStyle = "rgba(120, 150, 190, 0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 0; g <= span; g += GRID_LIGHT_DAYS) {
      const a = this.project(g, 0);
      const b = this.project(g, span);
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      const c = this.project(0, g);
      const d = this.project(span, g);
      ctx.moveTo(c.px, c.py);
      ctx.lineTo(d.px, d.py);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(120, 150, 190, 0.28)";
    ctx.strokeRect(
      this.ox,
      this.oy,
      span * this.scale,
      span * this.scale,
    );
    ctx.fillStyle = "#5f7292";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(
      `grid ${GRID_LIGHT_DAYS} light-days`,
      this.ox + 6,
      this.oy + span * this.scale - 6,
    );

    // The chartered route, under everything that moves.
    const from = this.project(
      this.voyage.originPort.x,
      this.voyage.originPort.y,
    );
    const to = this.project(
      this.voyage.destinationPort.x,
      this.voyage.destinationPort.y,
    );
    ctx.strokeStyle = "rgba(219, 228, 240, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(from.px, from.py);
    ctx.lineTo(to.px, to.py);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ports: a dot in its faction's colour, a ring for a home port,
    // the name beside it, and the leg's two ends named as such.
    ctx.font = "11px system-ui, sans-serif";
    for (const port of this.sector.ports) {
      const { px, py } = this.project(port.x, port.y);
      const colour = this.factionColour(port);
      const faction =
        port.faction === null ? null : this.sector.factionAt(port.faction);
      const isHome = faction !== null && faction.homePort === port.index;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, isHome ? 7 : 5.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(px, py, 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (port.index === this.voyage.origin) {
        ctx.strokeStyle = "#dbe4f0";
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(2, 4, 8, 0.85)";
      ctx.fillText(port.name, px + 10, py - 4);
      ctx.fillStyle = "#dbe4f0";
      ctx.fillText(port.name, px + 9, py - 5);
      ctx.fillStyle = "#8fa3bf";
      ctx.font = "9px system-ui, sans-serif";
      if (port.index === this.voyage.origin) {
        ctx.fillText("origin", px + 9, py + 9);
      } else if (port.index === this.voyage.destination) {
        ctx.fillText("destination", px + 9, py + 9);
      }
      ctx.font = "11px system-ui, sans-serif";
    }
    this.staticLayer = layer;
  }

  /** One frame: the chart, the travelled line, and the ship on it. */
  frame(tick: number, nowMs: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    this.ensureStatic();
    if (this.staticLayer !== null) {
      ctx.drawImage(this.staticLayer, 0, 0);
    }
    const pos = this.voyage.positionAt(tick);
    const ship = this.project(pos.x, pos.y);
    const from = this.project(
      this.voyage.originPort.x,
      this.voyage.originPort.y,
    );
    const to = this.project(
      this.voyage.destinationPort.x,
      this.voyage.destinationPort.y,
    );

    // The part of the route already sailed, drawn solid over the dash.
    ctx.strokeStyle = "rgba(232, 163, 61, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(from.px, from.py);
    ctx.lineTo(ship.px, ship.py);
    ctx.stroke();

    // The destination breathes while it is still ahead.
    if (!this.voyage.inPortAt(tick)) {
      const pulse = 9 + 3 * Math.sin(nowMs / 350);
      ctx.strokeStyle = "rgba(232, 163, 61, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(to.px, to.py, pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    // The ship: a bright diamond with a slow ring, her name above.
    const ring = 7 + 2 * Math.sin(nowMs / 300);
    ctx.strokeStyle = "rgba(242, 247, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ship.px, ship.py, ring, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#f2f7ff";
    ctx.strokeStyle = "#e8a33d";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ship.px, ship.py - 5);
    ctx.lineTo(ship.px + 5, ship.py);
    ctx.lineTo(ship.px, ship.py + 5);
    ctx.lineTo(ship.px - 5, ship.py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "rgba(2, 4, 8, 0.85)";
    ctx.fillText(this.shipName, ship.px + 9, ship.py + 13);
    ctx.fillStyle = "#f2f7ff";
    ctx.fillText(this.shipName, ship.px + 8, ship.py + 12);

    this.backdrop.drawNear(ctx, nowMs);
  }

  /** What a tap at canvas coordinates names: a port, the ship, or space. */
  pick(x: number, y: number, tick: number): MapPick {
    this.ensureStatic();
    const pos = this.voyage.positionAt(tick);
    const ship = this.project(pos.x, pos.y);
    if (Math.hypot(x - ship.px, y - ship.py) <= 12) return { kind: "ship" };
    let best: Port | null = null;
    let bestDist = 13;
    for (const port of this.sector.ports) {
      const { px, py } = this.project(port.x, port.y);
      const d = Math.hypot(x - px, y - py);
      if (d < bestDist) {
        bestDist = d;
        best = port;
      }
    }
    return best === null ? null : { kind: "port", port: best };
  }

  /** Days at cruise speed from the ship's present position to a port. */
  distanceDaysFromShip(port: Port, tick: number): number {
    const pos = this.voyage.positionAt(tick);
    return (
      Math.hypot(port.x - pos.x, port.y - pos.y) /
      CONFIG.galaxy.cruiseLightDaysPerDay
    );
  }

  /** Light-days from the ship's present position to a port. */
  distanceFromShip(port: Port, tick: number): number {
    const pos = this.voyage.positionAt(tick);
    return Math.hypot(port.x - pos.x, port.y - pos.y);
  }
}
