// The galaxy, step 1: a procedural sector and the voyage leg.
//
// A sector is 6 to 9 named ports scattered on a jittered grid, held
// by 3 to 5 procedurally named factions (each with a home port) or
// by nobody. The voyage is one leg across it: an origin, a
// destination chartered a reasonable sail away, and a travel clock.
// The ship's position is a pure function of the tick count —
// elapsed ticks over leg ticks, interpolated between the two port
// positions — so there is no drift to accumulate and nothing for
// replay to reproduce but the arithmetic itself. Generation draws
// only from the "galaxy" stream and is never in the tick loop.

import type { World } from "../engine/engine.ts";
import type { Rng } from "../engine/rng.ts";
import { r3 } from "../log/events.ts";
import { CONFIG } from "../scenario/config.ts";

export interface Port {
  index: number;
  id: string;
  name: string;
  /** Light-days from the sector's origin corner, per axis. */
  x: number;
  y: number;
  /** Index into Sector.factions, or null: the port answers to nobody. */
  faction: number | null;
  character: string;
}

export interface Faction {
  index: number;
  id: string;
  name: string;
  /** Index into Sector.ports: where this faction's flag flies. */
  homePort: number;
}

export class Sector {
  readonly ports: Port[];
  readonly factions: Faction[];

  constructor(ports: Port[], factions: Faction[]) {
    this.ports = ports;
    this.factions = factions;
  }

  portAt(index: number): Port {
    const port = this.ports[index];
    if (port === undefined) throw new Error(`Sector: no port at index ${index}`);
    return port;
  }

  factionAt(index: number): Faction {
    const faction = this.factions[index];
    if (faction === undefined) {
      throw new Error(`Sector: no faction at index ${index}`);
    }
    return faction;
  }

  /** The faction holding a port, or null when it is independent. */
  factionOf(port: Port): Faction | null {
    return port.faction === null ? null : this.factionAt(port.faction);
  }

  /** Straight-line distance between two ports, in light-days. */
  distanceBetween(a: Port, b: Port): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Stable string identity of the sector, for determinism tests. */
  signature(): string {
    return JSON.stringify({
      ports: this.ports.map((p) => ({
        name: p.name,
        x: p.x,
        y: p.y,
        faction: p.faction,
        character: p.character,
      })),
      factions: this.factions.map((f) => ({
        name: f.name,
        homePort: f.homePort,
      })),
    });
  }
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** A name from the tables that this sector has not spent yet. */
export function drawName(
  rng: Rng,
  first: readonly string[],
  second: readonly string[],
  used: Set<string>,
): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${rng.pick(first)} ${rng.pick(second)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // The tables hold far more names than a sector can spend; this is
  // a belt over the braces, reached only if the draws run cruel.
  for (const suffix of ["Prime", "Minor", "Major", "Ultima"]) {
    const name = `${rng.pick(first)} ${rng.pick(second)} ${suffix}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  throw new Error("galaxy: name tables exhausted");
}

/** Generate a sector. Draws only from the given stream. */
export function generateSector(rng: Rng): Sector {
  const g = CONFIG.galaxy;
  const portCount =
    g.minPorts + rng.int(g.maxPorts - g.minPorts + 1);
  const factionCount =
    g.minFactions + rng.int(g.maxFactions - g.minFactions + 1);

  // Positions: one port per cell of a coarse grid, jittered inside
  // its cell. Neighbouring cells keep their ports at least
  // minSeparationLightDays apart by construction (see config).
  const cellsPerAxis = g.sectorCellsPerAxis;
  const cellSize = g.sectorSpanLightDays / cellsPerAxis;
  const jitterLo = Math.ceil(g.minSeparationLightDays / 2);
  const jitterSpan = Math.floor(cellSize - 2 * jitterLo) + 1;
  const cells = shuffled(
    rng,
    Array.from({ length: cellsPerAxis * cellsPerAxis }, (_, i) => i),
  );

  const usedNames = new Set<string>();
  const ports: Port[] = [];
  for (let i = 0; i < portCount; i++) {
    const cell = cells[i] as number;
    const col = cell % cellsPerAxis;
    const row = Math.floor(cell / cellsPerAxis);
    ports.push({
      index: i,
      id: `port-${i}`,
      name: drawName(rng, g.portNameFirst, g.portNameSecond, usedNames),
      x: col * cellSize + jitterLo + rng.int(jitterSpan),
      y: row * cellSize + jitterLo + rng.int(jitterSpan),
      faction: null,
      character: rng.pick(g.portCharacters),
    });
  }

  const factions: Faction[] = [];
  const usedFactionNames = new Set<string>();
  for (let i = 0; i < factionCount; i++) {
    factions.push({
      index: i,
      id: `faction-${i}`,
      name: drawName(
        rng,
        g.factionNameFirst,
        g.factionNameSecond,
        usedFactionNames,
      ),
      homePort: -1,
    });
  }

  // Home ports first: each faction's flag over one port, drawn from
  // a shuffled deck so the homes spread across the sector.
  const homeDeck = shuffled(
    rng,
    ports.map((p) => p.index),
  );
  for (let i = 0; i < factionCount; i++) {
    const home = homeDeck[i] as number;
    (factions[i] as Faction).homePort = home;
    (ports[home] as Port).faction = i;
  }
  // The rest declare for a faction or stay independent.
  for (const port of ports) {
    if (port.faction !== null) continue;
    if (!rng.chance(g.independentChance)) {
      port.faction = rng.int(factionCount);
    }
  }

  return new Sector(ports, factions);
}

/**
 * The voyage: one leg, chartered at generation. The destination is
 * drawn from the ports a reasonable sail away (the config band in
 * days at cruise speed); when the sector offers none, the port
 * nearest the band serves. The leg's length in ticks is fixed here
 * and never moves again.
 */
export class Voyage {
  readonly sector: Sector;
  readonly origin: number;
  readonly destination: number;
  /** Route length in light-days. */
  readonly distanceLightDays: number;
  /** Ticks under way until arrival: the leg's whole clock. */
  readonly legTicks: number;
  /** The tick the arrival fired, or null while under way. */
  arrivedTick: number | null = null;

  constructor(rng: Rng, sector: Sector) {
    this.sector = sector;
    const g = CONFIG.galaxy;
    this.origin = rng.int(sector.ports.length);
    const originPort = sector.portAt(this.origin);
    const inBand: number[] = [];
    let fallback = -1;
    let fallbackGap = Number.POSITIVE_INFINITY;
    for (const port of sector.ports) {
      if (port.index === this.origin) continue;
      const days =
        sector.distanceBetween(originPort, port) / g.cruiseLightDaysPerDay;
      if (days >= g.minLegDays && days <= g.maxLegDays) {
        inBand.push(port.index);
      }
      const gap = days < g.minLegDays ? g.minLegDays - days : days - g.maxLegDays;
      if (gap < fallbackGap) {
        fallbackGap = gap;
        fallback = port.index;
      }
    }
    this.destination =
      inBand.length > 0 ? rng.pick(inBand) : fallback;
    this.distanceLightDays = sector.distanceBetween(
      originPort,
      sector.portAt(this.destination),
    );
    this.legTicks = Math.max(
      1,
      Math.round(
        (this.distanceLightDays / g.cruiseLightDaysPerDay) *
          CONFIG.time.ticksPerDay,
      ),
    );
  }

  get originPort(): Port {
    return this.sector.portAt(this.origin);
  }

  get destinationPort(): Port {
    return this.sector.portAt(this.destination);
  }

  /** Days under way the whole leg takes, by the charter arithmetic. */
  get legDays(): number {
    return this.legTicks / CONFIG.time.ticksPerDay;
  }

  /** Fraction of the route covered at a tick, clamped to [0, 1]. */
  progressAt(tick: number): number {
    if (tick <= 0) return 0;
    if (tick >= this.legTicks) return 1;
    return tick / this.legTicks;
  }

  /** The ship's sector position at a tick: a pure function of it. */
  positionAt(tick: number): { x: number; y: number } {
    const t = this.progressAt(tick);
    const a = this.originPort;
    const b = this.destinationPort;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** Whole and part days under way at a tick. */
  daysOutAt(tick: number): number {
    return Math.min(Math.max(tick, 0), this.legTicks) / CONFIG.time.ticksPerDay;
  }

  /** True once the leg is complete at a tick: the ship is in port. */
  inPortAt(tick: number): boolean {
    return tick >= this.legTicks;
  }

  /**
   * The port the ship is berthed at, as an index: the origin
   * before she sails and the destination once she has arrived,
   * and null while she is under way between them.
   */
  portIndexAt(tick: number): number | null {
    if (tick <= 0) return this.origin;
    if (tick >= this.legTicks) return this.destination;
    return null;
  }

  /** The voyage system: arrival fires exactly once, on its tick. */
  step(w: World): void {
    if (this.arrivedTick !== null) return;
    if (w.tick < this.legTicks) return;
    this.arrivedTick = w.tick;
    w.emit("arrival", [], {
      port: this.destinationPort.name,
      portIndex: this.destination,
      days: r3(this.legDays),
      distance: r3(this.distanceLightDays),
    });
  }
}

/** Invariant: the ship is somewhere in the sector, and arrival is sane. */
export function checkVoyageState(voyage: Voyage, tick: number): void {
  const span = CONFIG.galaxy.sectorSpanLightDays;
  const pos = voyage.positionAt(tick);
  if (!(pos.x >= 0 && pos.x <= span && pos.y >= 0 && pos.y <= span)) {
    throw new Error(
      `voyage position out of sector at tick ${tick}: ${pos.x}, ${pos.y}`,
    );
  }
  if (voyage.arrivedTick !== null) {
    if (voyage.arrivedTick !== voyage.legTicks) {
      throw new Error(
        `arrival fired at tick ${voyage.arrivedTick}, leg is ${voyage.legTicks}`,
      );
    }
    if (tick < voyage.arrivedTick) {
      throw new Error(`tick ${tick} precedes the recorded arrival`);
    }
  } else if (tick >= voyage.legTicks) {
    throw new Error(`tick ${tick} is past the leg but arrival never fired`);
  }
}
