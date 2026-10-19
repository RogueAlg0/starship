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

/** Distances and day counts read at one decimal in the log's voice. */
function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
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
        const from = str(data, "from");
        const to = str(data, "to");
        if (from !== "" && to !== "") {
          line(
            `${ts} — The ${this.shipName} departs ${from} for ${to}, ` +
              `${oneDecimal(num(data, "distance"))} light-days out. The voyage begins.`,
            true,
          );
        } else {
          line(`${ts} — The ${this.shipName} departs. The voyage begins.`, true);
        }
        break;
      }
      case "arrival": {
        line(
          `${ts} — The ${this.shipName} arrives at ${str(data, "port")}, ` +
            `${oneDecimal(num(data, "days"))} days under way.`,
          true,
        );
        break;
      }
      case "port_call": {
        line(
          `${ts} — The ${this.shipName} makes port at ${str(data, "port")} ` +
            `(${str(data, "character")}), ${oneDecimal(num(data, "days"))} days under way.`,
          true,
        );
        break;
      }
      case "resupply": {
        const words: Record<string, string> = {
          food: "food",
          water: "water",
          oxygen: "oxygen",
          fuel: "fuel",
          parts: "parts",
        };
        const manifest = Array.isArray(data.manifest) ? data.manifest : [];
        const parts = manifest.map((entry) => {
          const m = asRecord(entry);
          const label = words[str(m, "store")] ?? str(m, "store");
          const days = num(m, "days");
          if (m.full === true) {
            return days > 0
              ? `${label} +${oneDecimal(days)} days, full`
              : `${label} full`;
          }
          return `${label} +${oneDecimal(days)} days`;
        });
        let text =
          parts.length > 0
            ? `${ts} — Taken aboard at ${str(data, "port")}: ${parts.join(", ")}.`
            : `${ts} — No stores taken aboard at ${str(data, "port")}; the ship wanted for nothing.`;
        if (data.gift === true) {
          text +=
            " The shrine's gift was company and quiet, and the crew came back lighter.";
        }
        line(text, true);
        break;
      }
      case "port_dues": {
        line(
          `${ts} — Port dues at ${str(data, "port")} were assessed and paid in kind, per the charter.`,
          false,
        );
        break;
      }
      case "repair_assist": {
        line(
          `${ts} — Dockyard crews at ${str(data, "port")} set to work on the ${system(str(data, "system"))}.`,
          true,
        );
        break;
      }
      case "shore_leave": {
        const members = Array.isArray(data.members)
          ? data.members.map((id) => person(String(id)))
          : [];
        if (members.length === 0) break;
        const names =
          members.length === 1
            ? members[0]
            : `${members.slice(0, -1).join(", ")} and ${members[members.length - 1]}`;
        line(
          `${ts} — Shore leave at ${str(data, "port")}: ${names} went ashore.`,
          true,
        );
        break;
      }
      case "harbour_news": {
        const kind = str(data, "kind");
        if (kind === "berthing") {
          line(
            `${ts} — Harbour news at ${str(data, "port")}: the ${str(data, "type")} ` +
              `${str(data, "ship")} lies berthed here.`,
            true,
          );
        } else if (kind === "recent") {
          const ago = num(data, "daysAgo");
          line(
            `${ts} — Harbour news at ${str(data, "port")}: the ${str(data, "type")} ` +
              `${str(data, "ship")} made port here ${ago} ${ago === 1 ? "day" : "days"} since and has sailed.`,
            true,
          );
        } else {
          const lines = CONFIG.stores.port.rumourLines;
          const template =
            lines[num(data, "variant") % lines.length] ?? lines[0] ?? "";
          line(
            `${ts} — ` +
              template
                .replaceAll("{port}", str(data, "port"))
                .replaceAll("{faction}", str(data, "faction")),
            true,
          );
        }
        break;
      }
      case "port_incident": {
        const lines = CONFIG.stores.port.incidentLines;
        const template =
          lines[num(data, "variant") % lines.length] ?? lines[0] ?? "";
        line(
          `${ts} — ` + template.replaceAll("{port}", str(data, "port")),
          true,
        );
        break;
      }
      case "stores_low": {
        const titles: Record<string, string> = {
          food: "Food",
          water: "Water",
          oxygen: "Oxygen margin",
          fuel: "Fuel",
          parts: "Spare parts",
        };
        const label = titles[str(data, "store")] ?? str(data, "store");
        line(
          `${ts} — ${label} stores run low: ${oneDecimal(num(data, "days"))} days remain.`,
          true,
        );
        break;
      }
      case "stores_critical": {
        const titles: Record<string, string> = {
          food: "Food",
          water: "Water",
          oxygen: "Oxygen margin",
          fuel: "Fuel",
          parts: "Spare parts",
        };
        const label = titles[str(data, "store")] ?? str(data, "store");
        line(
          `${ts} — ${label} stores are critical: ${oneDecimal(num(data, "days"))} days remain.`,
          true,
        );
        break;
      }
      case "rationing_imposed": {
        const by = str(data, "by");
        line(
          by !== ""
            ? `${ts} — ${person(by)} imposes rationing: ${str(data, "store")} stands at ` +
                `${oneDecimal(num(data, "days"))} days.`
            : `${ts} — Rationing is imposed: ${str(data, "store")} stands at ` +
                `${oneDecimal(num(data, "days"))} days.`,
          true,
        );
        break;
      }
      case "rationing_lifted": {
        line(
          str(data, "reason") === "arrival"
            ? `${ts} — Rationing is lifted in port: ${str(data, "store")} stands at ` +
                `${oneDecimal(num(data, "days"))} days.`
            : `${ts} — Rationing is lifted: ${str(data, "store")} stands at ` +
                `${oneDecimal(num(data, "days"))} days.`,
          true,
        );
        break;
      }
      case "theft": {
        // A witnessed theft is ship's news. An unwitnessed one is
        // truth only the log holds, printed only when the log's
        // truth setting allows it — like sabotage.
        if (data.witnessed === true) {
          line(
            `${ts} — ${person(str(data, "witness"))} saw ${person(str(data, "thief"))} ` +
              `take food from the stores.`,
            true,
          );
        } else if (this.knowsTruth) {
          line(
            `${ts} — (The log records what the crew does not know: ` +
              `${person(str(data, "thief"))} took food from the stores.)`,
            true,
          );
        }
        break;
      }
      case "stores_discrepancy": {
        const suspect = str(data, "suspect");
        const by = str(data, "by");
        line(
          suspect !== "" && by !== ""
            ? `${ts} — The stores do not tally: ${oneDecimal(num(data, "days"))} days of food ` +
                `unaccounted for. ${person(by)} has questions for ${person(suspect)}.`
            : `${ts} — The stores do not tally: ${oneDecimal(num(data, "days"))} days of food ` +
                `unaccounted for, and no one can say where it went.`,
          true,
        );
        break;
      }
      case "dead_in_space": {
        line(
          `${ts} — The ${this.shipName} lies dead in space, out of fuel, ` +
            `${oneDecimal(num(data, "distanceLeft"))} light-days short of ${str(data, "boundFor")}.`,
          true,
        );
        break;
      }
      case "life_support_strain": {
        line(
          `${ts} — With the oxygen margin gone, the life support runs hot and strains.`,
          true,
        );
        break;
      }
      case "contact": {
        // Transponders are truthful in this step (see DECISIONS):
        // the log prints what she reports, and what she reports is
        // what she is. Spoofed identities are the bounty step's.
        const factionName = str(data, "faction");
        const registry =
          factionName !== "" ? `${factionName} registry` : "independent registry";
        const boundFor = str(data, "boundFor");
        const inPort = str(data, "inPort");
        const business =
          boundFor !== ""
            ? `bound for ${boundFor}`
            : inPort !== ""
              ? `in port at ${inPort}`
              : "under way";
        const motion = str(data, "motion");
        const flavour =
          motion === "closing"
            ? ", closing"
            : motion === "parallel"
              ? ", on a parallel course"
              : motion === "passing"
                ? ", passing"
                : "";
        line(
          `${ts} — Contact: the ${str(data, "type")} ${str(data, "ship")}, ` +
            `${registry}, ${oneDecimal(num(data, "range"))} light-days out, ` +
            `${business}${flavour}.`,
          true,
        );
        break;
      }
      case "contact_lost": {
        line(
          `${ts} — Contact lost: the ${str(data, "type")} ${str(data, "ship")} ` +
            `passes beyond sensor range.`,
          true,
        );
        break;
      }
      case "port_traffic": {
        line(
          str(data, "movement") === "arrived"
            ? `${ts} — Port traffic: the ${str(data, "type")} ${str(data, "ship")} ` +
                `makes port at ${str(data, "port")}.`
            : `${ts} — Port traffic: the ${str(data, "type")} ${str(data, "ship")} ` +
                `sails from ${str(data, "port")}.`,
          true,
        );
        break;
      }
      case "weather": {
        line(`${ts} — Space weather turns: ${str(data, "to")}.`, true);
        break;
      }
      case "meal": {
        if (actor === undefined) break;
        // A meal eaten in a window is part of the shared service; the
        // meal_service summary carries it, one line for the whole table.
        if (typeof data.window === "string") break;
        const key = `${day}|${actor}`;
        if (this.seenMeal.has(key)) break;
        this.seenMeal.add(key);
        line(
          `${ts} — ${person(actor)} eats in the ${room(num(data, "room"))}.`,
          false,
        );
        break;
      }
      case "meal_service": {
        const mealName =
          str(data, "meal") === "breakfast" ? "Breakfast" : "Evening meal";
        let text =
          `${ts} — ${mealName} in the ${room(num(data, "room"))}: ` +
          `${num(data, "count")} at table.`;
        const notableA = str(data, "notableA");
        const notableB = str(data, "notableB");
        if (notableA !== "" && notableB !== "") {
          text +=
            str(data, "notableKind") === "grudge"
              ? ` ${person(notableA)} and ${person(notableB)} sat at one table, grudge and all.`
              : ` ${person(notableA)} and ${person(notableB)}, fast friends, took a table together.`;
        }
        line(text, false);
        break;
      }
      case "leisure_game": {
        const players = Array.isArray(data.participants)
          ? data.participants.map((id) => person(String(id)))
          : [];
        if (players.length === 0) break;
        const names =
          players.length === 1
            ? players[0]
            : `${players.slice(0, -1).join(", ")} and ${players[players.length - 1]}`;
        line(
          `${ts} — ${names} play a table game in the ${room(num(data, "room"))}; ` +
            `${person(str(data, "winner"))} wins.`,
          true,
        );
        break;
      }
      case "gossip": {
        line(
          `${ts} — Shipboard rumour: ${person(str(data, "to"))} now suspects ` +
            `${person(str(data, "about"))}.`,
          true,
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
