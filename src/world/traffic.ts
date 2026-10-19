// The galaxy, step 2: traffic — other ships in the sector.
//
// The player's ship is not the only hull under way. At build, on
// the "traffic" stream, the sector gains a handful of other ships,
// each with a name, a kind, a registry, and a home port. None of
// them is simulated: every ship sails a leg table generated whole
// at build, out to a horizon far past any run, so her position at
// a tick is a pure function of the tick — the same arithmetic
// discipline as the voyage leg. The tick loop decides nothing for
// them and draws nothing for them; it only reads positions.
//
// A contact is geometry. Each tick the traffic system measures
// the range from the player's ship to every other ship. Crossing
// inside sensor range opens a contact; crossing back out closes
// it. Both edges are computed from the two position functions, so
// replay reproduces them exactly: they are arithmetic, not luck.
//
// Transponders in this step are truthful: what a contact reports
// (name, kind, registry, business) is what she is. The design's
// spoofed and stale identities belong to the bounty step, where
// beliefs about a ship, not the ship, are what circulate. That
// deferral is recorded in DECISIONS.md; nobody should mistake
// this step's honest sky for the finished design.
//
// One refinement keeps the log honest: while the player's ship
// lies in port, the traffic of that port is not "contacts". A
// ship berthed alongside, or under way bound for the same dock,
// makes no sensor contact; her own arrivals and departures there
// are port traffic instead, one line each. A ship that merely
// passes the port by, bound elsewhere, is a contact as usual.

import type { World } from "../engine/engine.ts";
import type { Rng } from "../engine/rng.ts";
import { r3 } from "../log/events.ts";
import { CONFIG } from "../scenario/config.ts";
import { drawName, type Port, type Sector } from "./galaxy.ts";

/** One leg of a traffic ship's table: a port, a port, and its clock. */
export interface TrafficLeg {
  /** Port index she sails from. */
  from: number;
  /** Port index she sails to. */
  to: number;
  /** Tick she leaves the origin. */
  departTick: number;
  /** Tick she makes the destination; the stay there is the gap
   *  to the next leg's departure. */
  arriveTick: number;
}

/**
 * What the traffic system needs of the player's own track: where
 * she is, and whether she lies in port. The voyage satisfies it;
 * tests may stand in a plainer track of their own.
 */
export interface PlayerTrack {
  positionAt(tick: number): { x: number; y: number };
  inPortAt(tick: number): boolean;
  /** Port index the player is berthed at, or null under way. */
  portIndexAt(tick: number): number | null;
}

export class TrafficShip {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  /** Her kind: one of CONFIG.traffic.shipTypes' kinds. */
  readonly type: string;
  /** Index into Sector.factions, or null: she answers to nobody. */
  readonly faction: number | null;
  /** Port index she is registered out of, and berthed at on tick 0. */
  readonly homePort: number;
  readonly cruiseLightDaysPerDay: number;
  /** Her whole schedule, in departure order, generated at build. */
  readonly legs: readonly TrafficLeg[];
  private readonly sector: Sector;

  constructor(
    sector: Sector,
    fields: {
      index: number;
      id: string;
      name: string;
      type: string;
      faction: number | null;
      homePort: number;
      cruiseLightDaysPerDay: number;
      legs: readonly TrafficLeg[];
    },
  ) {
    this.sector = sector;
    this.index = fields.index;
    this.id = fields.id;
    this.name = fields.name;
    this.type = fields.type;
    this.faction = fields.faction;
    this.homePort = fields.homePort;
    this.cruiseLightDaysPerDay = fields.cruiseLightDaysPerDay;
    this.legs = fields.legs;
  }

  get homePortRef(): Port {
    return this.sector.portAt(this.homePort);
  }

  /**
   * Index of the leg whose departure is the latest at or before a
   * tick, or -1 while she still lies in her first stay. The table
   * is in departure order, so this is a binary search; every
   * question about where a ship is starts here.
   */
  private legIndexAt(tick: number): number {
    const legs = this.legs;
    let lo = 0;
    let hi = legs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const leg = legs[mid] as TrafficLeg;
      if (leg.departTick <= tick) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** The leg under way at a tick, or null while she lies in port. */
  legAt(tick: number): TrafficLeg | null {
    const index = this.legIndexAt(tick);
    if (index < 0) return null;
    const leg = this.legs[index] as TrafficLeg;
    return tick < leg.arriveTick ? leg : null;
  }

  /** The port she lies at on a tick, as an index, or null under way. */
  portAt(tick: number): number | null {
    const index = this.legIndexAt(tick);
    if (index < 0) return this.homePort;
    const leg = this.legs[index] as TrafficLeg;
    return tick >= leg.arriveTick ? leg.to : null;
  }

  /** Her sector position at a tick: a pure function of it. */
  positionAt(tick: number): { x: number; y: number } {
    const index = this.legIndexAt(tick);
    if (index < 0) {
      const home = this.homePortRef;
      return { x: home.x, y: home.y };
    }
    const leg = this.legs[index] as TrafficLeg;
    const to = this.sector.portAt(leg.to);
    if (tick >= leg.arriveTick) return { x: to.x, y: to.y };
    const from = this.sector.portAt(leg.from);
    const span = leg.arriveTick - leg.departTick;
    const t = span > 0 ? (tick - leg.departTick) / span : 1;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }

  /** Stable string identity of the ship and her table, for tests. */
  signature(): string {
    return JSON.stringify({
      name: this.name,
      type: this.type,
      faction: this.faction,
      homePort: this.homePort,
      cruise: this.cruiseLightDaysPerDay,
      legs: this.legs,
    });
  }
}

/** A port stay drawn from the config's band, first stays included. */
function drawStay(rng: Rng): number {
  const t = CONFIG.traffic;
  return t.minStayTicks + rng.int(t.maxStayTicks - t.minStayTicks + 1);
}

/**
 * Generate the sector's traffic. Draws only from the given
 * stream. Names come from the ship-name tables and are kept
 * unique among the traffic and clear of the player's own name.
 */
export function generateTraffic(
  rng: Rng,
  sector: Sector,
  playerShipName: string,
): TrafficShip[] {
  const t = CONFIG.traffic;
  const count = t.minShips + rng.int(t.maxShips - t.minShips + 1);
  const horizonTicks = t.scheduleHorizonDays * CONFIG.time.ticksPerDay;
  const usedNames = new Set<string>([playerShipName]);
  const ships: TrafficShip[] = [];
  for (let i = 0; i < count; i++) {
    const type = rng.pick(t.shipTypes);
    const faction =
      sector.factions.length === 0 || rng.chance(t.independentChance)
        ? null
        : rng.int(sector.factions.length);
    const homePort =
      faction !== null
        ? sector.factionAt(faction).homePort
        : rng.int(sector.ports.length);
    const cruise =
      CONFIG.galaxy.cruiseLightDaysPerDay * type.cruiseFactor;
    const name = drawName(
      rng,
      CONFIG.ship.nameFirst,
      CONFIG.ship.nameSecond,
      usedNames,
    );
    // The table: sail, lie, sail, until the horizon is covered.
    // The clock starts after a first stay, so the sector does not
    // all leave port on the same morning the witness arrives.
    const legs: TrafficLeg[] = [];
    let atPort = homePort;
    let clock = drawStay(rng);
    while (clock < horizonTicks) {
      let to = rng.int(sector.ports.length - 1);
      if (to >= atPort) to += 1;
      const distance = sector.distanceBetween(
        sector.portAt(atPort),
        sector.portAt(to),
      );
      const travelTicks = Math.max(
        1,
        Math.round((distance / cruise) * CONFIG.time.ticksPerDay),
      );
      legs.push({
        from: atPort,
        to,
        departTick: clock,
        arriveTick: clock + travelTicks,
      });
      clock += travelTicks + drawStay(rng);
      atPort = to;
    }
    ships.push(
      new TrafficShip(sector, {
        index: i,
        id: `traffic-${i}`,
        name,
        type: type.kind,
        faction,
        homePort,
        cruiseLightDaysPerDay: cruise,
        legs,
      }),
    );
  }
  return ships;
}

/**
 * The traffic system: measures the sky each tick and speaks only
 * on its edges. Its whole state is two flags per ship — was she
 * in range last tick, and is she an announced contact — because
 * everything else is arithmetic on the position functions.
 */
export class Traffic {
  readonly sector: Sector;
  readonly ships: readonly TrafficShip[];
  private readonly player: PlayerTrack;
  private readonly inRangePrev: boolean[];
  private readonly announced: boolean[];
  private readonly contactSince: number[];

  constructor(sector: Sector, ships: readonly TrafficShip[], player: PlayerTrack) {
    this.sector = sector;
    this.ships = ships;
    this.player = player;
    this.inRangePrev = ships.map(() => false);
    this.announced = ships.map(() => false);
    this.contactSince = ships.map(() => -1);
  }

  /** True while a ship stands announced as a sensor contact. */
  isAnnounced(index: number): boolean {
    return this.announced[index] === true;
  }

  /** The contacts open at the last stepped tick, oldest first. */
  activeContacts(): { ship: TrafficShip; sinceTick: number }[] {
    const out: { ship: TrafficShip; sinceTick: number }[] = [];
    for (const ship of this.ships) {
      if (this.announced[ship.index] === true) {
        out.push({
          ship,
          sinceTick: this.contactSince[ship.index] as number,
        });
      }
    }
    return out;
  }

  step(w: World): void {
    const tick = w.tick;
    const range = CONFIG.traffic.sensorRangeLightDays;
    const playerPos = this.player.positionAt(tick);
    const playerPort = this.player.portIndexAt(tick);
    for (const ship of this.ships) {
      const i = ship.index;
      if (playerPort !== null) this.notePortTraffic(w, ship, playerPort, tick);

      const pos = ship.positionAt(tick);
      const dist = Math.hypot(pos.x - playerPos.x, pos.y - playerPos.y);
      const inRangeNow = dist <= range;
      const wasInRange = this.inRangePrev[i] === true;
      // While the player lies in port, that port's own traffic is
      // not sensor contacts: ships berthed alongside, and ships
      // under way bound for the same dock, stay out of the contact
      // ledger entirely. Their comings and goings are port traffic.
      let eligible = true;
      if (playerPort !== null) {
        const leg = ship.legAt(tick);
        if (ship.portAt(tick) === playerPort) eligible = false;
        else if (leg !== null && leg.to === playerPort) eligible = false;
      }

      if (inRangeNow && !wasInRange && eligible && !this.isAnnounced(i)) {
        this.announced[i] = true;
        this.contactSince[i] = tick;
        w.emit("contact", [], this.contactData(ship, dist, tick));
      }
      if (!inRangeNow && wasInRange && this.isAnnounced(i)) {
        this.announced[i] = false;
        this.contactSince[i] = -1;
        w.emit("contact_lost", [], {
          ship: ship.name,
          shipIndex: ship.index,
          type: ship.type,
          range: r3(dist),
        });
      }
      if (!eligible && this.isAnnounced(i)) {
        // She joined the port's own traffic mid-contact (the
        // player docked under her, or she turned for the same
        // dock): the contact closes without a line. The port
        // traffic ledger tells her story from here.
        this.announced[i] = false;
        this.contactSince[i] = -1;
      }
      this.inRangePrev[i] = inRangeNow;
    }
  }

  /**
   * One line for each of a ship's arrivals at, and departures
   * from, the port the player lies in. The leg table is in
   * departure order, so the scan stops at the first leg that has
   * not begun by this tick.
   */
  private notePortTraffic(
    w: World,
    ship: TrafficShip,
    playerPort: number,
    tick: number,
  ): void {
    const port = this.sector.portAt(playerPort);
    for (const leg of ship.legs) {
      if (leg.departTick > tick && leg.arriveTick > tick) break;
      if (leg.arriveTick === tick && leg.to === playerPort) {
        w.emit("port_traffic", [], {
          ship: ship.name,
          shipIndex: ship.index,
          type: ship.type,
          faction: this.factionName(ship),
          port: port.name,
          portIndex: playerPort,
          movement: "arrived",
        });
      } else if (leg.departTick === tick && leg.from === playerPort) {
        w.emit("port_traffic", [], {
          ship: ship.name,
          shipIndex: ship.index,
          type: ship.type,
          faction: this.factionName(ship),
          port: port.name,
          portIndex: playerPort,
          movement: "departed",
        });
      }
    }
  }

  private factionName(ship: TrafficShip): string | null {
    return ship.faction === null
      ? null
      : this.sector.factionAt(ship.faction).name;
  }

  /** The contact event's payload: who she is, and what she is about. */
  private contactData(
    ship: TrafficShip,
    dist: number,
    tick: number,
  ): Record<string, unknown> {
    const leg = ship.legAt(tick);
    const berthed = ship.portAt(tick);
    let motion: string;
    if (leg === null) {
      motion = "berthed";
    } else {
      // Relative motion from the geometry alone: how fast the
      // range itself is opening or closing, per ship day.
      const nextShip = ship.positionAt(tick + 1);
      const nextPlayer = this.player.positionAt(tick + 1);
      const nextDist = Math.hypot(
        nextShip.x - nextPlayer.x,
        nextShip.y - nextPlayer.y,
      );
      const radialPerDay = (nextDist - dist) * CONFIG.time.ticksPerDay;
      motion =
        radialPerDay <= -0.2
          ? "closing"
          : radialPerDay >= 0.2
            ? "passing"
            : "parallel";
    }
    return {
      ship: ship.name,
      shipIndex: ship.index,
      type: ship.type,
      faction: this.factionName(ship),
      factionIndex: ship.faction,
      range: r3(dist),
      boundFor: leg !== null ? this.sector.portAt(leg.to).name : null,
      boundForIndex: leg !== null ? leg.to : null,
      inPort: berthed !== null ? this.sector.portAt(berthed).name : null,
      inPortIndex: berthed,
      motion,
    };
  }
}

/**
 * Invariant: traffic stays inside the sector, and an announced
 * contact is a true statement about the geometry — she is inside
 * sensor range at the tick the state claims her.
 */
export function checkTrafficState(
  traffic: Traffic,
  player: PlayerTrack,
  tick: number,
): void {
  const span = CONFIG.galaxy.sectorSpanLightDays;
  const range = CONFIG.traffic.sensorRangeLightDays;
  const playerPos = player.positionAt(tick);
  for (const ship of traffic.ships) {
    const pos = ship.positionAt(tick);
    if (!(pos.x >= 0 && pos.x <= span && pos.y >= 0 && pos.y <= span)) {
      throw new Error(
        `traffic ship ${ship.name} out of sector at tick ${tick}: ${pos.x}, ${pos.y}`,
      );
    }
    if (traffic.isAnnounced(ship.index)) {
      const dist = Math.hypot(pos.x - playerPos.x, pos.y - playerPos.y);
      if (dist > range + 1e-9) {
        throw new Error(
          `contact with ${ship.name} announced at tick ${tick} but range is ${dist}`,
        );
      }
    }
  }
}
