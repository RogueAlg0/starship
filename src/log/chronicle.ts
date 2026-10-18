// The chronicle: the event log rendered as a ship's log a person can read.
//
// The log holds truth; the chronicle is truth written down. Routine life
// is aggregated (one line per person per day for work and meals, one per
// rest spell), social life appears at its milestones, and the drama is
// verbatim: grudges, sabotage, accusations, failures. An accusation is
// always rendered as an accusation, a belief spoken aloud, never as a
// finding. Whether sabotage lines name the culprit is the chronicle's
// truth setting: with knowsTruth the log's own knowledge is printed,
// marked as such; without it, only the discovered damage is printed.

import { CONFIG } from "../scenario/config.ts";
import type { SimEvent } from "./events.ts";

export interface ChronicleOptions {
  knowsTruth?: boolean;
}

interface RosterEntry {
  id: string;
  name: string;
  role: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

function num(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" ? value : 0;
}

function stamp(tick: number): string {
  const perDay = CONFIG.time.ticksPerDay;
  const day = Math.floor(tick / perDay) + 1;
  const minutes = (tick % perDay) * CONFIG.time.minutesPerTick;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `Day ${day}, ${hh}:${mm}`;
}

function dayOf(tick: number): number {
  return Math.floor(tick / CONFIG.time.ticksPerDay) + 1;
}

export function renderChronicle(
  events: readonly SimEvent[],
  options?: ChronicleOptions,
): string {
  const knowsTruth = options?.knowsTruth ?? CONFIG.chronicle.knowsTruth;
  const lines: string[] = [];

  let shipName = "the ship";
  const roomNames = new Map<number, string>();
  const systemNames = new Map<string, string>();
  const systemRooms = new Map<string, number>();
  const people = new Map<string, RosterEntry>();

  const seenWork = new Set<string>();
  const seenMeal = new Set<string>();
  const seenSnub = new Set<string>();
  const seenStrain = new Set<string>();
  const resting = new Set<string>();

  for (const event of events) {
    const data = event.data;
    const actor = event.actors[0];
    if (actor !== undefined && event.type !== "rest") resting.delete(actor);
    const day = dayOf(event.tick);
    const ts = stamp(event.tick);
    const person = (id: string): string => people.get(id)?.name ?? id;
    const room = (index: number): string => roomNames.get(index) ?? `room ${index}`;
    const system = (id: string): string => systemNames.get(id) ?? id;

    switch (event.type) {
      case "ship_generated": {
        shipName = str(data, "name") || shipName;
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        for (const entry of rooms) {
          const r = asRecord(entry);
          roomNames.set(num(r, "index"), str(r, "name"));
        }
        const systems = Array.isArray(data.systems) ? data.systems : [];
        for (const entry of systems) {
          const s = asRecord(entry);
          systemNames.set(str(s, "id"), str(s, "name"));
          systemRooms.set(str(s, "id"), num(s, "room"));
        }
        lines.push(`Ship's log of the ${shipName}.`);
        lines.push(
          `The ${shipName} carries her crew in ${rooms.length} compartments: ` +
            `${rooms.map((entry) => str(asRecord(entry), "name")).join(", ")}.`,
        );
        break;
      }
      case "crew_generated": {
        const roster = Array.isArray(data.crew) ? data.crew : [];
        for (const entry of roster) {
          const c = asRecord(entry);
          people.set(str(c, "id"), {
            id: str(c, "id"),
            name: str(c, "name"),
            role: str(c, "role"),
          });
        }
        lines.push(
          `Crew of ${roster.length}: ` +
            roster
              .map((entry) => {
                const c = asRecord(entry);
                return `${str(c, "role")} ${str(c, "name")}`;
              })
              .join("; ") +
            ".",
        );
        lines.push("");
        break;
      }
      case "departure": {
        lines.push(`${ts} — The ${shipName} departs. The voyage begins.`);
        break;
      }
      case "weather": {
        lines.push(`${ts} — Space weather turns: ${str(data, "to")}.`);
        break;
      }
      case "meal": {
        if (actor === undefined) break;
        const key = `${day}|${actor}`;
        if (seenMeal.has(key)) break;
        seenMeal.add(key);
        lines.push(
          `${ts} — ${person(actor)} eats in the ${room(num(data, "room"))}.`,
        );
        break;
      }
      case "rest": {
        if (actor === undefined || resting.has(actor)) break;
        resting.add(actor);
        lines.push(
          `${ts} — ${person(actor)} rests in the ${room(num(data, "room"))}.`,
        );
        break;
      }
      case "work": {
        if (actor === undefined) break;
        const systemId = data.system;
        const key = `${day}|${actor}|${typeof systemId === "string" ? systemId : "generic"}`;
        if (seenWork.has(key)) break;
        seenWork.add(key);
        lines.push(
          typeof systemId === "string"
            ? `${ts} — ${person(actor)} works on the ${system(systemId)}.`
            : `${ts} — ${person(actor)} works in the ${room(num(data, "room"))}.`,
        );
        break;
      }
      case "socialize_refused": {
        if (actor === undefined) break;
        const other = str(data, "with");
        const key = `${day}|${actor}|${other}`;
        if (seenSnub.has(key)) break;
        seenSnub.add(key);
        lines.push(
          `${ts} — ${person(actor)} tries to talk with ${person(other)}, who brushes them off.`,
        );
        break;
      }
      case "bond_formed": {
        if (actor === undefined) break;
        const level = num(data, "level");
        lines.push(
          level >= 2
            ? `${ts} — ${person(actor)} and ${person(str(data, "with"))} are fast friends now.`
            : `${ts} — ${person(actor)} and ${person(str(data, "with"))} have grown close.`,
        );
        break;
      }
      case "trust_broken": {
        if (actor === undefined) break;
        lines.push(
          `${ts} — ${person(actor)}'s trust in ${person(str(data, "with"))} is broken.`,
        );
        break;
      }
      case "grudge_formed": {
        if (actor === undefined) break;
        lines.push(
          `${ts} — ${person(actor)} now holds a grudge against ${person(str(data, "target"))}.`,
        );
        break;
      }
      case "sabotage_committed": {
        const systemId = str(data, "system");
        const where = room(systemRooms.get(systemId) ?? num(data, "room"));
        const found =
          `${ts} — Sabotage: the ${system(systemId)} in the ${where} ` +
          `is found damaged.`;
        lines.push(
          knowsTruth
            ? `${found} (The log records what the crew does not know: it was ${person(str(data, "culprit"))}.)`
            : found,
        );
        break;
      }
      case "accusation": {
        if (actor === undefined) break;
        lines.push(
          `${ts} — ${person(actor)} accuses ${person(str(data, "accused"))} of sabotage. ` +
            `It is an accusation, not a finding.`,
        );
        break;
      }
      case "system_damaged": {
        const systemId = str(data, "system");
        lines.push(
          `${ts} — The ${system(systemId)} in the ${room(num(data, "room"))} is failing ` +
            `(condition ${Math.round(num(data, "condition") * 100)}%).`,
        );
        break;
      }
      case "system_strain": {
        const systemId = str(data, "system");
        const key = `${day}|${systemId}`;
        if (seenStrain.has(key)) break;
        seenStrain.add(key);
        lines.push(
          `${ts} — The ${system(systemId)} strains; the whole crew feels it.`,
        );
        break;
      }
      case "system_failed": {
        const systemId = str(data, "system");
        lines.push(
          `${ts} — The ${system(systemId)} in the ${room(num(data, "room"))} has failed.`,
        );
        break;
      }
      case "system_repaired": {
        const systemId = str(data, "system");
        const by = data.by;
        lines.push(
          typeof by === "string"
            ? `${ts} — ${person(by)} has repaired the ${system(systemId)}.`
            : `${ts} — The ${system(systemId)} is repaired.`,
        );
        break;
      }
      default:
        break;
    }
  }

  lines.push("");
  lines.push(`End of log. ${events.length} events recorded.`);
  return lines.join("\n") + "\n";
}
