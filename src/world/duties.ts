// The upkeep layer: the ship's standing duties.
//
// Systems break and get repaired; duties are the work that
// never breaks, only fades. Each duty belongs to a department,
// happens in its place, decays on its own clock, and is kept up
// by the crew's ordinary work choices. Neglect is not a failure
// state: it is a slow tax, paid by the systems that read the
// levels (air and food production, sickness, the stores tally),
// and the ship says so once when a duty crosses the line.

import { CONFIG } from "../scenario/config.ts";
import type { World } from "../engine/engine.ts";
import type { Ship } from "./ship.ts";

export interface DutyDef {
  id: string;
  /** Display name, for the Ship tab and the chronicle. */
  name: string;
  /** The department that owns the duty (factions made visible:
   *  the Ship tab groups duties under their departments). */
  department: string;
  /** Roles whose work this is. Others can help, slower and less
   *  eagerly, the way lay hands help in the medbay. */
  owners: readonly string[];
  /** Anchored to the room holding a system of this kind, when set. */
  anchorSystemKind?: string;
  /** Or anchored to rooms of these kinds (first listed wins). */
  anchorRoomKinds?: readonly string[];
  /** The discipline the work teaches. */
  discipline: string;
  /** The chronicle's sentence when the duty crosses into neglect. */
  neglectText: string;
}

export const DUTY_DEFS: readonly DutyDef[] = [
  {
    id: "filters",
    name: "Air filters",
    department: "Engineering",
    owners: ["chief engineer", "engineer"],
    anchorSystemKind: "life support",
    discipline: "lifeSystems",
    neglectText: "The air filters are overdue; the air has gone stale.",
  },
  {
    id: "sanitation",
    name: "Sanitation",
    department: "Services",
    owners: ["cook", "quartermaster"],
    anchorRoomKinds: ["mess", "quarters", "medbay"],
    discipline: "husbandry",
    neglectText: "Sanitation is overdue; the ship smells of itself.",
  },
  {
    id: "crops",
    name: "Crop tending",
    department: "Science",
    owners: ["botanist", "scientist"],
    anchorSystemKind: "hydroponics rig",
    discipline: "husbandry",
    neglectText: "The crops are overdue for tending; the leaves are curling.",
  },
  {
    id: "audit",
    name: "Stores audit",
    department: "Services",
    owners: ["quartermaster"],
    anchorRoomKinds: ["cargo"],
    discipline: "operations",
    neglectText: "The stores audit is overdue; the tally trusts itself less.",
  },
];

export interface DutyState {
  level: number;
  neglected: boolean;
  lastServiceTick: number;
}

export interface DutiesState {
  byId: Record<string, DutyState>;
}

export function createDuties(): DutiesState {
  const byId: Record<string, DutyState> = {};
  for (const def of DUTY_DEFS) {
    byId[def.id] = { level: 0.9, neglected: false, lastServiceTick: -1 };
  }
  return { byId };
}

export function dutyDef(id: string): DutyDef | undefined {
  return DUTY_DEFS.find((d) => d.id === id);
}

export function dutyLevel(ship: Ship, id: string): number {
  return ship.duties?.byId[id]?.level ?? 1;
}

/** The room a duty is done in, or -1 when the ship lacks its place. */
export function dutyRoom(ship: Ship, def: DutyDef): number {
  if (def.anchorSystemKind !== undefined) {
    const system = ship.systems.find((s) => s.kind === def.anchorSystemKind);
    return system === undefined ? -1 : system.room;
  }
  for (const kind of def.anchorRoomKinds ?? []) {
    const room = ship.firstRoomOfKind(kind);
    if (room >= 0) return room;
  }
  return -1;
}

/** Whether this room is a place the duty can be done. */
export function dutyRoomMatches(ship: Ship, def: DutyDef, room: number): boolean {
  if (def.anchorSystemKind !== undefined) {
    return ship
      .systemsInRoom(room)
      .some((s) => s.kind === def.anchorSystemKind);
  }
  return (def.anchorRoomKinds ?? []).includes(ship.roomKind(room));
}

/** Oxygen production share from the filters' state. */
export function filterFactor(ship: Ship): number {
  const floor = CONFIG.duties.filterFloor;
  return floor + (1 - floor) * dutyLevel(ship, "filters");
}

/** Food production share from the crops' state. */
export function cropFactor(ship: Ship): number {
  const floor = CONFIG.duties.cropFloor;
  return floor + (1 - floor) * dutyLevel(ship, "crops");
}

/**
 * Decay every duty and report a fresh neglect once, at the
 * crossing. Restoring is the crew action's business (it knows
 * whose hands did the work); this step only lets go.
 */
export function stepDuties(w: World, ship: Ship): void {
  const duties = ship.duties;
  if (duties === null) return;
  const tpd = CONFIG.time.ticksPerDay;
  for (const def of DUTY_DEFS) {
    const state = duties.byId[def.id];
    if (state === undefined) continue;
    const cfg = CONFIG.duties.perDuty[def.id];
    if (cfg === undefined) continue;
    state.level = Math.max(0, state.level - cfg.decayPerDay / tpd);
    if (!state.neglected && state.level < CONFIG.duties.neglectLine) {
      state.neglected = true;
      w.emit("duty_neglected", [], {
        duty: def.id,
        name: def.name,
        department: def.department,
        level: Math.round(state.level * 1000) / 1000,
      });
    }
  }
}

/** Invariant check: every duty level in range. */
export function checkDutiesState(ship: Ship): string[] {
  const errors: string[] = [];
  if (ship.duties === null) return errors;
  for (const def of DUTY_DEFS) {
    const state = ship.duties.byId[def.id];
    if (state === undefined) {
      errors.push(`duty ${def.id} missing`);
      continue;
    }
    if (!(state.level >= 0 && state.level <= 1)) {
      errors.push(`duty ${def.id} level out of range: ${state.level}`);
    }
  }
  return errors;
}
