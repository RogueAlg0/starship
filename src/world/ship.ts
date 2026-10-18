// The ship: generated from the seed on the "shipgen" stream.
//
// A ship is a graph of 10 to 14 typed rooms. Every required kind appears
// once; the remaining rooms come from the repeatable kinds (quarters may
// repeat). Connectivity is built as a spanning tree plus a few extra
// loops, so every room is reachable from every other. Rooms host zero to
// two ship systems, rolled from the room kind's affinity list, and a
// guarantee pass makes sure every system kind exists aboard at least
// once. The rest of the simulation only ever asks the ship for rooms,
// neighbours, paths, and systems.

import type { Rng } from "../engine/rng.ts";
import { CONFIG } from "../scenario/config.ts";
import { makeSystem, rollRoomSystems, type ShipSystem } from "./systems.ts";

export interface Room {
  index: number;
  kind: string;
  name: string;
  neighbors: number[];
}

export class Ship {
  readonly name: string;
  readonly rooms: Room[];
  readonly systems: ShipSystem[];
  private readonly systemsById: Map<string, ShipSystem>;

  constructor(name: string, rooms: Room[], systems: ShipSystem[]) {
    this.name = name;
    this.rooms = rooms;
    this.systems = systems;
    this.systemsById = new Map(systems.map((s) => [s.id, s]));
  }

  get roomCount(): number {
    return this.rooms.length;
  }

  roomName(index: number): string {
    const room = this.rooms[index];
    if (room === undefined) throw new Error(`Ship: no room at index ${index}`);
    return room.name;
  }

  roomKind(index: number): string {
    const room = this.rooms[index];
    if (room === undefined) throw new Error(`Ship: no room at index ${index}`);
    return room.kind;
  }

  /** First room index of a kind, or -1 when the ship has none. */
  firstRoomOfKind(kind: string): number {
    const room = this.rooms.find((r) => r.kind === kind);
    return room === undefined ? -1 : room.index;
  }

  systemsInRoom(index: number): ShipSystem[] {
    return this.systems.filter((s) => s.room === index);
  }

  systemById(id: string): ShipSystem {
    const system = this.systemsById.get(id);
    if (system === undefined) throw new Error(`Ship: no system ${id}`);
    return system;
  }

  /** Breadth-first distances and predecessors from a room. */
  distancesFrom(from: number): { dist: number[]; prev: number[] } {
    const dist = new Array<number>(this.rooms.length).fill(-1);
    const prev = new Array<number>(this.rooms.length).fill(-1);
    dist[from] = 0;
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head] as number;
      for (const next of (this.rooms[current] as Room).neighbors) {
        if (dist[next] === -1) {
          dist[next] = (dist[current] as number) + 1;
          prev[next] = current;
          queue.push(next);
        }
      }
    }
    return { dist, prev };
  }

  /** Shortest-path distance between two rooms. */
  distance(a: number, b: number): number {
    if (a === b) return 0;
    return this.distancesFrom(a).dist[b] as number;
  }

  /** The next room on a shortest path from `from` toward `to`. */
  stepToward(from: number, to: number, prev: readonly number[]): number {
    if (from === to) return from;
    let current = to;
    while ((prev[current] as number) !== from) {
      const parent = prev[current] as number;
      if (parent < 0) return from; // unreachable; stay put rather than drift
      current = parent;
    }
    return current;
  }

  /** Stable string identity of the layout, for determinism tests. */
  signature(): string {
    return JSON.stringify({
      name: this.name,
      rooms: this.rooms.map((r) => ({
        kind: r.kind,
        neighbors: r.neighbors,
      })),
      systems: this.systems.map((s) => ({
        kind: s.kind,
        room: s.room,
        condition: Math.round(s.condition * 1000) / 1000,
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

/** Generate a ship. Draws only from the given stream. */
export function generateShip(rng: Rng): Ship {
  const name = `${rng.pick(CONFIG.ship.nameFirst)} ${rng.pick(CONFIG.ship.nameSecond)}`;

  const roomTotal =
    CONFIG.ship.minRooms +
    rng.int(CONFIG.ship.maxRooms - CONFIG.ship.minRooms + 1);
  const kinds = [...CONFIG.ship.requiredKinds];
  while (kinds.length < roomTotal) {
    kinds.push(rng.pick(CONFIG.ship.repeatableKinds));
  }
  const orderedKinds = shuffled(rng, kinds);

  // Spanning tree: each room after the first joins one earlier room.
  const neighbors: Set<number>[] = orderedKinds.map(() => new Set<number>());
  for (let i = 1; i < orderedKinds.length; i++) {
    const parent = rng.int(i);
    (neighbors[i] as Set<number>).add(parent);
    (neighbors[parent] as Set<number>).add(i);
  }
  // Extra loops so the ship is not a single corridor.
  for (let attempt = 0; attempt < CONFIG.ship.extraEdgeAttempts; attempt++) {
    const a = rng.int(orderedKinds.length);
    const b = rng.int(orderedKinds.length);
    if (a !== b) {
      (neighbors[a] as Set<number>).add(b);
      (neighbors[b] as Set<number>).add(a);
    }
  }

  const kindCounts = new Map<string, number>();
  const rooms: Room[] = orderedKinds.map((kind, index) => {
    const occurrence = (kindCounts.get(kind) ?? 0) + 1;
    kindCounts.set(kind, occurrence);
    const label = CONFIG.ship.roomLabels[kind] ?? kind;
    return {
      index,
      kind,
      name: occurrence > 1 ? `${label} ${occurrence}` : label,
      neighbors: [...(neighbors[index] as Set<number>)].sort((x, y) => x - y),
    };
  });

  const counters = new Map<string, number>();
  const systems: ShipSystem[] = [];
  for (const room of rooms) {
    systems.push(...rollRoomSystems(rng, room.kind, room.index, counters));
  }
  // Guarantee: every system kind exists aboard at least once.
  for (const kind of CONFIG.systemKinds) {
    if (systems.some((s) => s.kind === kind)) continue;
    const hosts = rooms.filter(
      (r) =>
        (CONFIG.roomSystemAffinity[r.kind] ?? []).includes(kind) &&
        systems.filter((s) => s.room === r.index).length < 2,
    );
    const fallback = rooms.filter(
      (r) => systems.filter((s) => s.room === r.index).length < 2,
    );
    const host = rng.pick(hosts.length > 0 ? hosts : fallback);
    systems.push(makeSystem(rng, kind, host.index, counters));
  }
  systems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return new Ship(name, rooms, systems);
}
