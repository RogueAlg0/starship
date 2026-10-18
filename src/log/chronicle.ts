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
//
// Two ways to render: renderChronicle turns a finished event list into
// the whole text at once (the CLI path), and createChronicleRenderer
// turns events into lines one at a time as they happen (the viewer
// path). Both share the one implementation below, so the two can never
// drift apart.

import { CONFIG } from "../scenario/config.ts";
import type { SimEvent } from "./events.ts";

export interface ChronicleOptions {
  knowsTruth?: boolean;
}

/** One rendered chronicle line. */
export interface ChronicleLine {
  text: string;
  /**
   * Drama and milestones (weather, grudges, sabotage, accusations,
   * repairs, bonds) are highlights; routine life (work, meals, rest) is
   * not. A highlights-only view shows the highlights and drops the rest.
   */
  highlight: boolean;
  /** The event's first actor, when it has one. */
  actor?: string;
}

/** Incremental renderer: feed events in order, get lines back. */
export interface ChronicleRenderer {
  push(event: SimEvent): ChronicleLine[];
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

class Renderer implements ChronicleRenderer {
  private readonly knowsTruth: boolean;
  private shipName = "the ship";
  private readonly roomNames = new Map<number, string>();
  private readonly systemNames = new Map<string, string>();
  private readonly systemRooms = new Map<string, number>();
  private readonly people = new Map<string, RosterEntry>();
  private readonly seenWork = new Set<string>();
  private readonly seenMeal = new Set<string>();
  private readonly seenSnub = new Set<string>();
  private readonly seenStrain = new Set<string>();
  private readonly resting = new Set<string>();

  constructor(options?: ChronicleOptions) {
    this.knowsTruth = options?.knowsTruth ?? CONFIG.chronicle.knowsTruth;
  }

  push(event: SimEvent): ChronicleLine[] {
    const out: ChronicleLine[] = [];
    const line = (text: string, highlight: boolean): void => {
      const entry: ChronicleLine = { text, highlight };
      const actor = event.actors[0];
      if (actor !== undefined) entry.actor = actor;
      out.push(entry);
    };

    const data = event.data;
    const actor = event.actors[0];
    if (actor !== undefined && event.type !== "rest") this.resting.delete(actor);
    const day = dayOf(event.tick);
    const ts = stamp(event.tick);
    const person = (id: string): string => this.people.get(id)?.name ?? id;
    const room = (index: number): string =>
      this.roomNames.get(index) ?? `room ${index}`;
    const system = (id: string): string => this.systemNames.get(id) ?? id;

    switch (event.type) {
      case "ship_generated": {
        this.shipName = str(data, "name") || this.shipName;
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        for (const entry of rooms) {
          const r = asRecord(entry);
          this.roomNames.set(num(r, "index"), str(r, "name"));
        }
        const systems = Array.isArray(data.systems) ? data.systems : [];
        for (const entry of systems) {
          const s = asRecord(entry);
          this.systemNames.set(str(s, "id"), str(s, "name"));
          this.systemRooms.set(str(s, "id"), num(s, "room"));
        }
        line(`Ship's log of the ${this.shipName}.`, true);
        line(
          `The ${this.shipName} carries her crew in ${rooms.length} compartments: ` +
            `${rooms.map((entry) => str(asRecord(entry), "name")).join(", ")}.`,
          true,
        );
        break;
      }
      case "crew_generated": {
        const roster = Array.isArray(data.crew) ? data.crew : [];
        for (const entry of roster) {
          const c = asRecord(entry);
          this.people.set(str(c, "id"), {
            id: str(c, "id"),
            name: str(c, "name"),
            role: str(c, "role"),
          });
        }
        line(
          `Crew of ${roster.length}: ` +
            roster
              .map((entry) => {
                const c = asRecord(entry);
                return `${str(c, "role")} ${str(c, "name")}`;
              })
              .join("; ") +
            ".",
          true,
        );
        line("", true);
        break;
      }
      case "departure": {
        line(`${ts} — The ${this.shipName} departs. The voyage begins.`, true);
        break;
      }
      case "weather": {
        line(`${ts} — Space weather turns: ${str(data, "to")}.`, true);
        break;
      }
      case "meal": {
        if (actor === undefined) break;
        const key = `${day}|${actor}`;
        if (this.seenMeal.has(key)) break;
        this.seenMeal.add(key);
        line(
          `${ts} — ${person(actor)} eats in the ${room(num(data, "room"))}.`,
          false,
        );
        break;
      }
      case "rest": {
        if (actor === undefined || this.resting.has(actor)) break;
        this.resting.add(actor);
        line(
          `${ts} — ${person(actor)} rests in the ${room(num(data, "room"))}.`,
          false,
        );
        break;
      }
      case "work": {
        if (actor === undefined) break;
        const systemId = data.system;
        const key = `${day}|${actor}|${typeof systemId === "string" ? systemId : "generic"}`;
        if (this.seenWork.has(key)) break;
        this.seenWork.add(key);
        line(
          typeof systemId === "string"
            ? `${ts} — ${person(actor)} works on the ${system(systemId)}.`
            : `${ts} — ${person(actor)} works in the ${room(num(data, "room"))}.`,
          false,
        );
        break;
      }
      case "socialize_refused": {
        if (actor === undefined) break;
        const other = str(data, "with");
        const key = `${day}|${actor}|${other}`;
        if (this.seenSnub.has(key)) break;
        this.seenSnub.add(key);
        line(
          `${ts} — ${person(actor)} tries to talk with ${person(other)}, who brushes them off.`,
          true,
        );
        break;
      }
      case "bond_formed": {
        if (actor === undefined) break;
        const level = num(data, "level");
        line(
          level >= 2
            ? `${ts} — ${person(actor)} and ${person(str(data, "with"))} are fast friends now.`
            : `${ts} — ${person(actor)} and ${person(str(data, "with"))} have grown close.`,
          true,
        );
        break;
      }
      case "trust_broken": {
        if (actor === undefined) break;
        line(
          `${ts} — ${person(actor)}'s trust in ${person(str(data, "with"))} is broken.`,
          true,
        );
        break;
      }
      case "grudge_formed": {
        if (actor === undefined) break;
        line(
          `${ts} — ${person(actor)} now holds a grudge against ${person(str(data, "target"))}.`,
          true,
        );
        break;
      }
      case "sabotage_committed": {
        const systemId = str(data, "system");
        const where = room(this.systemRooms.get(systemId) ?? num(data, "room"));
        const found =
          `${ts} — Sabotage: the ${system(systemId)} in the ${where} ` +
          `is found damaged.`;
        line(
          this.knowsTruth
            ? `${found} (The log records what the crew does not know: it was ${person(str(data, "culprit"))}.)`
            : found,
          true,
        );
        break;
      }
      case "accusation": {
        if (actor === undefined) break;
        line(
          `${ts} — ${person(actor)} accuses ${person(str(data, "accused"))} of sabotage. ` +
            `It is an accusation, not a finding.`,
          true,
        );
        break;
      }
      case "system_damaged": {
        const systemId = str(data, "system");
        line(
          `${ts} — The ${system(systemId)} in the ${room(num(data, "room"))} is failing ` +
            `(condition ${Math.round(num(data, "condition") * 100)}%).`,
          true,
        );
        break;
      }
      case "system_strain": {
        const systemId = str(data, "system");
        const key = `${day}|${systemId}`;
        if (this.seenStrain.has(key)) break;
        this.seenStrain.add(key);
        line(
          `${ts} — The ${system(systemId)} strains; the whole crew feels it.`,
          true,
        );
        break;
      }
      case "system_failed": {
        const systemId = str(data, "system");
        line(
          `${ts} — The ${system(systemId)} in the ${room(num(data, "room"))} has failed.`,
          true,
        );
        break;
      }
      case "system_repaired": {
        const systemId = str(data, "system");
        const by = data.by;
        line(
          typeof by === "string"
            ? `${ts} — ${person(by)} has repaired the ${system(systemId)}.`
            : `${ts} — The ${system(systemId)} is repaired.`,
          true,
        );
        break;
      }
      default:
        break;
    }
    return out;
  }
}

/** Create an incremental chronicle renderer (the viewer's path). */
export function createChronicleRenderer(
  options?: ChronicleOptions,
): ChronicleRenderer {
  return new Renderer(options);
}

export function renderChronicle(
  events: readonly SimEvent[],
  options?: ChronicleOptions,
): string {
  const renderer = createChronicleRenderer(options);
  const lines: string[] = [];
  for (const event of events) {
    for (const entry of renderer.push(event)) lines.push(entry.text);
  }
  lines.push("");
  lines.push(`End of log. ${events.length} events recorded.`);
  return lines.join("\n") + "\n";
}
