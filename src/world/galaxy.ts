// The galaxy: a procedural sector and the voyage across it.
//
// A sector is 6 to 9 named ports scattered on a jittered grid, held
// by 3 to 5 procedurally named factions (each with a home port) or
// by nobody. The voyage is a chartered first leg and, after that,
// a future the ship decides as she sails: each stay is drawn as
// its arrival lands, and the leg out of a stay is laid down only
// when the Ship's Council has set the course for it (see the
// Council chapter) — or, when no council can sit, by the old
// itinerary rule kept as a fallback. The ship's position is a pure
// function of the tick given the legs and stays laid down so far —
// elapsed voyage-time over leg ticks, interpolated between the two
// port positions — with one wrinkle: a ship dead in space (fuel
// gone, see stores) makes way on momentum at a quarter of her
// voyage clock, and the drift spans that record those stretches
// are themselves deterministic run state, so replay reproduces the
// same slow hours. Generation draws only from the "galaxy"
// stream; the tick loop draws a stay's length as each arrival
// lands, in arrival order, so the stream stays reproducible.

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

/** One leg of the itinerary, on the voyage clock (see Voyage). */
export interface VoyageLeg {
  from: number;
  to: number;
  /** Voyage-time ticks: when the leg departs and when it arrives. */
  departTick: number;
  arriveTick: number;
  distanceLightDays: number;
}

/** One stay in port, between two legs of the itinerary. */
export interface PortStay {
  index: number;
  port: number;
  /** Voyage-time ticks bounding the stay. */
  arriveTick: number;
  departTick: number;
}

/** Leg length in ticks for a distance, at cruise: the one formula. */
function legTicksFor(sector: Sector, from: number, to: number): number {
  const distance = sector.distanceBetween(sector.portAt(from), sector.portAt(to));
  return Math.max(
    1,
    Math.round(
      (distance / CONFIG.galaxy.cruiseLightDaysPerDay) *
        CONFIG.time.ticksPerDay,
    ),
  );
}

/**
 * Pick the next port by the old itinerary rule: never the port the
 * ship lies in, never straight back to the port she came from when
 * any alternative exists, preferring the chartered band of
 * reasonable sails (and, like the charter, falling back to the
 * port nearest the band), and weighted toward ports this run has
 * not visited. The Council sets the course now (see council.ts);
 * this rule survives as the fallback for a ship with no council
 * to sit — an ended ship, or a test harness that steps the voyage
 * alone — so the ship is never stranded by an empty table.
 */
function pickNextPort(
  rng: Rng,
  sector: Sector,
  current: number,
  previous: number,
  visited: ReadonlySet<number>,
): number {
  const g = CONFIG.galaxy;
  const from = sector.portAt(current);
  const daysOf = (index: number): number =>
    sector.distanceBetween(from, sector.portAt(index)) / g.cruiseLightDaysPerDay;
  const candidates = sector.ports
    .map((p) => p.index)
    .filter((index) => index !== current);
  let pool = candidates.filter((index) => {
    const days = daysOf(index);
    return days >= g.minLegDays && days <= g.maxLegDays;
  });
  if (pool.length === 0) {
    let best = candidates[0] as number;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const index of candidates) {
      const days = daysOf(index);
      const gap = days < g.minLegDays ? g.minLegDays - days : days - g.maxLegDays;
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    }
    pool = [best];
  }
  const noBacktrack = pool.filter((index) => index !== previous);
  if (noBacktrack.length > 0) pool = noBacktrack;
  if (pool.length === 1) return pool[0] as number;
  let total = 0;
  for (const index of pool) total += visited.has(index) ? 1 : 3;
  let roll = rng.next() * total;
  for (const index of pool) {
    roll -= visited.has(index) ? 1 : 3;
    if (roll < 0) return index;
  }
  return pool[pool.length - 1] as number;
}

/**
 * The voyage: a charter leg, then a route the ship decides as she
 * sails. Leg 1 is the CHARTER: its destination is drawn from the
 * ports a reasonable sail away (the config band in days at cruise
 * speed), and its arrival is the voyage's Arrival — the `arrival`
 * event, capital A. Later arrivals are plain `port_call` events.
 * Between legs the ship lies in port for a stay of one to three
 * drawn days, bent a day by the port's character; the stay is
 * drawn as its arrival lands, and the leg out of it is laid down
 * only once the Council has set the course (recordCourseDecision)
 * — or, at the stay's last tick with no decision recorded, by the
 * old itinerary rule, so the ship never waits on an empty table.
 * The future is genuinely undecided until the sitting, and still
 * reproducible from the seed: the only draws are stay lengths, in
 * arrival order, on the "galaxy" stream.
 *
 * Positions read off the VOYAGE CLOCK: voyage-time is the tick
 * slowed by the spans the ship has spent dead in space (fuel gone;
 * the stores system opens and closes those drift spans, through
 * which the clock runs at the drift rate). With no drift the two
 * clocks are the same clock, and position is a pure function of
 * the tick given the legs and stays laid down so far.
 */
export class Voyage {
  readonly sector: Sector;
  readonly legs: VoyageLeg[] = [];
  readonly stays: PortStay[] = [];
  /** The tick the charter arrival fired, or null while under way. */
  arrivedTick: number | null = null;
  /** The generation stream, kept: stay lengths are drawn on it as
   *  arrivals land, and the fallback rule draws on it too. */
  private readonly rng: Rng;
  /** Ports the ship has lain in or sailed to, charter first. */
  private readonly visitedSet = new Set<number>();
  /** Course decisions by stay index: the port the Council chose
   *  for the leg out of that stay. Absent until the sitting. */
  private readonly courseDecisions = new Map<number, number>();
  /** Legs whose arrival has been announced, in order. */
  private announcedLegs = 0;
  /** Real-tick spans during which the ship drifts on momentum:
   *  the voyage clock runs at CONFIG.galaxy.driftRate through
   *  them. Never zero: a frozen clock would strand her forever,
   *  since fuel rises only in port. */
  private driftSpans: { start: number; end: number | null }[] = [];

  constructor(rng: Rng, sector: Sector) {
    this.sector = sector;
    this.rng = rng;
    const g = CONFIG.galaxy;
    const origin = rng.int(sector.ports.length);
    const originPort = sector.portAt(origin);
    const inBand: number[] = [];
    let fallback = -1;
    let fallbackGap = Number.POSITIVE_INFINITY;
    for (const port of sector.ports) {
      if (port.index === origin) continue;
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
    const destination = inBand.length > 0 ? rng.pick(inBand) : fallback;
    const charterTicks = legTicksFor(sector, origin, destination);
    this.legs.push({
      from: origin,
      to: destination,
      departTick: 0,
      arriveTick: charterTicks,
      distanceLightDays: sector.distanceBetween(
        originPort,
        sector.portAt(destination),
      ),
    });
    this.visitedSet.add(origin);
    this.visitedSet.add(destination);
    // Nothing past the charter is laid down. Stays are drawn as
    // arrivals land and later legs are decided in port (see the
    // class comment): the table grows with the run, never ahead
    // of the sittings that choose it.
  }

  /** Draw the stay that begins when the given leg arrives. */
  private drawStay(leg: VoyageLeg): PortStay {
    const g = CONFIG.galaxy;
    const tpd = CONFIG.time.ticksPerDay;
    const character = this.sector.portAt(leg.to).character;
    const bend = g.stayDayModifier[character] ?? 0;
    const days = Math.max(
      1,
      g.minStayDays + this.rng.int(g.maxStayDays - g.minStayDays + 1) + bend,
    );
    return {
      index: this.stays.length,
      port: leg.to,
      arriveTick: leg.arriveTick,
      departTick: leg.arriveTick + days * tpd,
    };
  }

  /** Lay down the leg out of a stay, to a decided port. */
  private buildLeg(stay: PortStay, to: number): void {
    const ticks = legTicksFor(this.sector, stay.port, to);
    this.legs.push({
      from: stay.port,
      to,
      departTick: stay.departTick,
      arriveTick: stay.departTick + ticks,
      distanceLightDays: this.sector.distanceBetween(
        this.sector.portAt(stay.port),
        this.sector.portAt(to),
      ),
    });
    this.visitedSet.add(to);
  }

  /**
   * The chart for a course sitting at a port: the ports inside
   * the chartered band of reasonable sails, plus the port the
   * ship came from, admitted under its standing penalty rather
   * than barred — a council may vote to go back, and the
   * chronicle can say why. Ordered by distance, then index, so
   * every reader lays the same chart. The current port is never
   * on it.
   */
  courseCandidates(from: number, previous: number): number[] {
    const g = CONFIG.galaxy;
    const fromPort = this.sector.portAt(from);
    const daysOf = (index: number): number =>
      this.sector.distanceBetween(fromPort, this.sector.portAt(index)) /
      g.cruiseLightDaysPerDay;
    const pool = this.sector.ports
      .map((p) => p.index)
      .filter((index) => index !== from)
      .filter((index) => {
        const days = daysOf(index);
        return days >= g.minLegDays && days <= g.maxLegDays;
      });
    if (!pool.includes(previous)) pool.push(previous);
    pool.sort((a, b) => daysOf(a) - daysOf(b) || a - b);
    return pool;
  }

  /** The port the ship sailed from to reach a stay's port. */
  previousPortForStay(stayIndex: number): number {
    const leg = this.legs[stayIndex] as VoyageLeg;
    return leg.from;
  }

  /** Whether the ship has lain in or sailed to a port yet. */
  hasVisited(portIndex: number): boolean {
    return this.visitedSet.has(portIndex);
  }

  /**
   * Record the Council's course for the leg out of a stay. The
   * port must be on that stay's chart: the invariant is enforced
   * here, at the point of mutation, not reconciled later.
   */
  recordCourseDecision(stayIndex: number, portIndex: number): void {
    const stay = this.stays[stayIndex] as PortStay | undefined;
    if (stay === undefined) {
      throw new Error(`course decision for unknown stay ${stayIndex}`);
    }
    if (this.courseDecisions.has(stayIndex)) {
      throw new Error(`course for stay ${stayIndex} already decided`);
    }
    const previous = this.previousPortForStay(stayIndex);
    if (!this.courseCandidates(stay.port, previous).includes(portIndex)) {
      throw new Error(
        `course decision names port ${portIndex}, not on the chart from ${stay.port}`,
      );
    }
    this.courseDecisions.set(stayIndex, portIndex);
  }

  /** The decided port for the leg out of a stay, or null. */
  courseDecisionFor(stayIndex: number): number | null {
    return this.courseDecisions.get(stayIndex) ?? null;
  }

  /** The old itinerary rule's pick for a stay: the fallback when
   *  no council can sit to decide. */
  fallbackCourseFor(stayIndex: number): number {
    const stay = this.stays[stayIndex] as PortStay;
    return pickNextPort(
      this.rng,
      this.sector,
      stay.port,
      this.previousPortForStay(stayIndex),
      this.visitedSet,
    );
  }

  /** The charter leg's origin port index. */
  get origin(): number {
    return (this.legs[0] as VoyageLeg).from;
  }

  /** The charter leg's destination port index. */
  get destination(): number {
    return (this.legs[0] as VoyageLeg).to;
  }

  get originPort(): Port {
    return this.sector.portAt(this.origin);
  }

  get destinationPort(): Port {
    return this.sector.portAt(this.destination);
  }

  /** Charter route length in light-days. */
  get distanceLightDays(): number {
    return (this.legs[0] as VoyageLeg).distanceLightDays;
  }

  /** Ticks under way on the charter leg: its whole clock. */
  get legTicks(): number {
    return (this.legs[0] as VoyageLeg).arriveTick;
  }

  /** Days under way the charter leg takes. */
  get legDays(): number {
    return this.legTicks / CONFIG.time.ticksPerDay;
  }

  /** Ports this itinerary has called at, in order, charter first. */
  get visitedPorts(): number[] {
    return this.legs.map((leg) => leg.to);
  }

  /** True while a drift span stands open. */
  get drifting(): boolean {
    return this.driftSpans.some((span) => span.end === null);
  }

  /** Open a drift span at a real tick: the voyage clock slows
   *  to the drift rate from here. */
  beginDrift(tick: number): void {
    if (!this.drifting) this.driftSpans.push({ start: tick, end: null });
  }

  /** Close the open drift span at a real tick. */
  endDrift(tick: number): void {
    const open = this.driftSpans.find((span) => span.end === null);
    if (open !== undefined) open.end = tick;
  }

  /**
   * Voyage-time at a real tick: the tick, less the share of each
   * drift span that momentum did not cover. Through a drift span
   * the voyage clock advances at driftRate, so voyage-time is
   * fractional there — the itinerary arithmetic reads it the same.
   */
  voyageTimeAt(tick: number): number {
    let vt = tick;
    for (const span of this.driftSpans) {
      if (tick <= span.start) continue;
      const end = span.end ?? tick;
      const overlap = Math.max(0, Math.min(tick, end) - span.start);
      vt -= overlap * (1 - CONFIG.galaxy.driftRate);
    }
    return vt;
  }

  /** Real ticks spent drifting before a real tick. */
  driftTicksBefore(tick: number): number {
    let drift = 0;
    for (const span of this.driftSpans) {
      if (tick <= span.start) continue;
      const end = span.end ?? tick;
      drift += Math.max(0, Math.min(tick, end) - span.start);
    }
    return drift;
  }

  /** The leg being sailed at a voyage-time, or null in a stay. */
  private legAtVoyageTime(vt: number): VoyageLeg | null {
    for (const leg of this.legs) {
      if (vt >= leg.departTick && vt < leg.arriveTick) return leg;
    }
    return null;
  }

  /** The stay being lived at a voyage-time, or null under way. */
  private stayAtVoyageTime(vt: number): PortStay | null {
    for (const stay of this.stays) {
      if (vt >= stay.arriveTick && vt < stay.departTick) return stay;
    }
    return null;
  }

  /** The leg under way at a tick, or null while in port. */
  currentLegAt(tick: number): VoyageLeg | null {
    return this.legAtVoyageTime(this.voyageTimeAt(tick));
  }

  /** The stay being lived at a tick, or null while under way. The
   *  origin before departure is not a stay: the ship is loading,
   *  not calling. */
  stayAt(tick: number): PortStay | null {
    return this.stayAtVoyageTime(this.voyageTimeAt(tick));
  }

  /** Fraction of the current leg covered at a tick, in [0, 1]. */
  progressAt(tick: number): number {
    const vt = this.voyageTimeAt(tick);
    if (vt <= 0) return 0;
    const leg = this.legAtVoyageTime(vt);
    if (leg !== null) {
      return (vt - leg.departTick) / (leg.arriveTick - leg.departTick);
    }
    return 1;
  }

  /** The ship's sector position at a tick, from the itinerary. */
  positionAt(tick: number): { x: number; y: number } {
    const vt = this.voyageTimeAt(tick);
    if (vt <= 0) {
      const origin = this.originPort;
      return { x: origin.x, y: origin.y };
    }
    const leg = this.legAtVoyageTime(vt);
    if (leg !== null) {
      const a = this.sector.portAt(leg.from);
      const b = this.sector.portAt(leg.to);
      const t = (vt - leg.departTick) / (leg.arriveTick - leg.departTick);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    const stay = this.stayAtVoyageTime(vt);
    if (stay !== null) {
      const port = this.sector.portAt(stay.port);
      return { x: port.x, y: port.y };
    }
    const last = this.legs[this.legs.length - 1] as VoyageLeg;
    const port = this.sector.portAt(last.to);
    return { x: port.x, y: port.y };
  }

  /** Days under way on the current leg at a tick. */
  daysOutAt(tick: number): number {
    const vt = this.voyageTimeAt(tick);
    const leg = this.legAtVoyageTime(vt);
    if (leg !== null) {
      return (vt - leg.departTick) / CONFIG.time.ticksPerDay;
    }
    const stay = this.stayAtVoyageTime(vt);
    if (stay !== null) {
      const finished = this.legs[stay.index] as VoyageLeg;
      return (finished.arriveTick - finished.departTick) / CONFIG.time.ticksPerDay;
    }
    return 0;
  }

  /** True when the ship lies in port at a tick. */
  inPortAt(tick: number): boolean {
    return this.portIndexAt(tick) !== null;
  }

  /**
   * The port the ship is berthed at, as an index: the origin
   * before she sails, the stay's port while she lies there, and
   * null while she is under way between them.
   */
  portIndexAt(tick: number): number | null {
    const vt = this.voyageTimeAt(tick);
    if (vt <= 0) return this.origin;
    const stay = this.stayAtVoyageTime(vt);
    if (stay !== null) return stay.port;
    if (this.legAtVoyageTime(vt) !== null) return null;
    const last = this.legs[this.legs.length - 1] as VoyageLeg;
    return last.to;
  }

  /**
   * The voyage system: arrivals fire exactly once each, in leg
   * order. The charter's arrival is `arrival`; every later one is
   * a `port_call`. Each arrival draws its stay as it lands, and
   * the leg out of a stay is laid down once the Council's course
   * for it stands recorded — or, at the stay's last tick with no
   * decision, by the old itinerary rule.
   */
  step(w: World): void {
    const vt = this.voyageTimeAt(w.tick);
    // Stays are drawn as their arrivals land, in arrival order,
    // before anything announces them: readers this same tick (the
    // stores call opening, the council's course trigger) see the
    // stay whole.
    while (
      this.stays.length < this.legs.length &&
      vt >= (this.legs[this.stays.length] as VoyageLeg).arriveTick
    ) {
      const leg = this.legs[this.stays.length] as VoyageLeg;
      this.stays.push(this.drawStay(leg));
    }
    while (this.announcedLegs < this.legs.length) {
      const leg = this.legs[this.announcedLegs] as VoyageLeg;
      if (vt < leg.arriveTick) break;
      const index = this.announcedLegs;
      this.announcedLegs++;
      const port = this.sector.portAt(leg.to);
      if (index === 0) {
        this.arrivedTick = w.tick;
        w.emit("arrival", [], {
          port: port.name,
          portIndex: leg.to,
          days: r3(this.legDays),
          distance: r3(this.distanceLightDays),
        });
      } else {
        // The stay that begins with this arrival was drawn above,
        // on this tick or an earlier one.
        const stay = this.stays[index] as PortStay;
        const faction = this.sector.factionOf(port);
        w.emit("port_call", [], {
          port: port.name,
          portIndex: leg.to,
          character: port.character,
          faction: faction === null ? null : faction.name,
          days: r3(
            (leg.arriveTick - leg.departTick) / CONFIG.time.ticksPerDay,
          ),
          stayDays: r3(
            (stay.departTick - stay.arriveTick) / CONFIG.time.ticksPerDay,
          ),
        });
      }
    }
    // The leg out of the current stay: laid down when the course
    // for it stands decided, and no later than the stay's last
    // tick, when the fallback rule speaks for an empty table.
    const stay = this.stayAt(w.tick);
    if (stay !== null && this.legs.length === stay.index + 1) {
      const decided = this.courseDecisions.get(stay.index);
      if (decided !== undefined) {
        this.buildLeg(stay, decided);
      } else if (vt >= stay.departTick - 1) {
        this.buildLeg(stay, this.fallbackCourseFor(stay.index));
      }
    }
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
    // The charter arrival fired on the first tick whose voyage-time
    // reached the leg's end: no earlier, no later.
    if (voyage.voyageTimeAt(voyage.arrivedTick) < voyage.legTicks) {
      throw new Error(
        `arrival fired at tick ${voyage.arrivedTick}, before the leg ended`,
      );
    }
    if (
      voyage.arrivedTick > 0 &&
      voyage.voyageTimeAt(voyage.arrivedTick - 1) >= voyage.legTicks
    ) {
      throw new Error(
        `arrival fired at tick ${voyage.arrivedTick}, after the leg ended`,
      );
    }
    if (tick < voyage.arrivedTick) {
      throw new Error(`tick ${tick} precedes the recorded arrival`);
    }
  } else if (voyage.voyageTimeAt(tick) >= voyage.legTicks) {
    throw new Error(`tick ${tick} is past the leg but arrival never fired`);
  }
}
