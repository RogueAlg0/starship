// The ship: for the scaffold, a fixed list of rooms from the scenario
// config. Procedural layout generation replaces this later; the rest of the
// engine only ever asks the ship for room names and counts.

import { CONFIG } from "../scenario/config.ts";

export class Ship {
  readonly rooms: readonly string[] = CONFIG.rooms;

  get roomCount(): number {
    return this.rooms.length;
  }

  roomName(index: number): string {
    const name = this.rooms[index];
    if (name === undefined) throw new Error(`Ship: no room at index ${index}`);
    return name;
  }
}
