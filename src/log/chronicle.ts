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

import {
  chatterText,
  denialText,
  testimonyText,
  type SpeechNames,
} from "../perception/speech.ts";
import { CONFIG } from "../scenario/config.ts";
import { dutyDef } from "../world/duties.ts";
import { DISCIPLINE_LABEL, type Discipline } from "../world/skills.ts";
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
  /** Notable chatter lines already carried as highlights, per day. */
  private readonly chatterHighlights = new Map<number, number>();

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
      case "faction_standing": {
        const phrases: Record<string, string> = {
          cold: "open coldness",
          unregarded: "no regard worth the name",
          warm: "warm regard",
          honoured: "high honour",
        };
        const band = str(data, "band");
        line(
          `${ts} — Word from the wider world: the ${str(data, "name")} ` +
            `now hold the ${this.shipName} in ${phrases[band] ?? band}.`,
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
        const via = str(data, "via");
        const level = str(data, "level");
        const levelWord = level !== "" ? ` (${level})` : "";
        if (via === "council") {
          line(
            `${ts} — The council adopts the quartermaster's proposal: ${str(data, "store")} ` +
              `rationing${levelWord}, at ${oneDecimal(num(data, "days"))} days.`,
            true,
          );
        } else if (via === "captain_emergency") {
          line(
            `${ts} — ${person(by)} imposes emergency rationing alone: ${str(data, "store")}${levelWord} ` +
              `stands at ${oneDecimal(num(data, "days"))} days. The council must ratify it within a day.`,
            true,
          );
        } else {
          line(
            by !== ""
              ? `${ts} — ${person(by)} imposes rationing: ${str(data, "store")} stands at ` +
                  `${oneDecimal(num(data, "days"))} days.`
              : `${ts} — Rationing is imposed: ${str(data, "store")} stands at ` +
                  `${oneDecimal(num(data, "days"))} days.`,
            true,
          );
        }
        break;
      }
      case "rationing_ratified": {
        line(
          `${ts} — The council ratifies the emergency rationing of ${str(data, "store")}.`,
          true,
        );
        break;
      }
      case "injury": {
        const causeWords: Record<string, string> = {
          accident: "an accident at work",
          violence: "an attack",
        };
        const cause = str(data, "cause");
        const who = person(str(data, "person"));
        line(
          `${ts} — ${who} is injured: a ${str(data, "part")} wound, ` +
            `${causeWords[cause] ?? cause} in the ${room(num(data, "room"))}.`,
          true,
        );
        break;
      }
      case "infection": {
        line(
          `${ts} — The wound in ${person(str(data, "person"))}'s ${str(data, "part")} has turned infected.`,
          true,
        );
        break;
      }
      case "sickness": {
        line(
          `${ts} — ${person(str(data, "person"))} is sick, and worsening.`,
          true,
        );
        break;
      }
      case "treatment_started": {
        line(
          data.lay === true
            ? `${ts} — ${person(str(data, "medic"))}, no doctor, tends ${person(str(data, "person"))}'s wounds in the ${room(num(data, "room"))}.`
            : `${ts} — ${person(str(data, "medic"))} tends ${person(str(data, "person"))}'s wounds in the ${room(num(data, "room"))}.`,
          false,
        );
        break;
      }
      case "carried_to_medbay": {
        line(
          `${ts} — ${person(str(data, "carrier"))} carries ${person(str(data, "person"))} to the Medbay.`,
          true,
        );
        break;
      }
      case "lasting_mark": {
        line(
          `${ts} — The wound leaves ${person(str(data, "person"))} with a ${str(data, "mark")}.`,
          true,
        );
        break;
      }
      case "level_up": {
        // The margin prints the true level; the crew's beliefs
        // about it are their own affair.
        const label =
          DISCIPLINE_LABEL[str(data, "discipline") as Discipline] ??
          str(data, "discipline");
        line(
          `${ts} — ${person(str(data, "person"))}'s hands have learned: ` +
            `${label} ${num(data, "level")}, ${str(data, "task")}.`,
          true,
        );
        break;
      }
      case "attack": {
        line(
          `${ts} — ${person(str(data, "attacker"))} attacks ${person(str(data, "victim"))} in the ${room(num(data, "room"))}.`,
          true,
        );
        break;
      }
      case "death": {
        const who = person(str(data, "person"));
        line(
          `${ts} — ${who} has died in the ${room(num(data, "room"))}.`,
          true,
        );
        if (this.knowsTruth) {
          const ledger = Array.isArray(data.ledger) ? data.ledger : [];
          const parts = ledger.map((entry) => {
            const e = asRecord(entry);
            return `${str(e, "cause")} ${oneDecimal(num(e, "amount"))}`;
          });
          if (parts.length > 0) {
            line(
              `${ts} — (The log's ledger records the truth of it: ${parts.join(", ")}.)`,
              true,
            );
          }
          const attacker = str(data, "attacker");
          if (attacker !== "") {
            line(
              `${ts} — (The log records what the crew must prove: the hand was ${person(attacker)}'s.)`,
              true,
            );
          }
        }
        break;
      }
      case "council_convened": {
        const seatTitles: Record<string, string> = {
          captain: "Captain",
          "first officer": "First Officer",
          "chief engineer": "Chief Engineer",
          "chief medical officer": "Chief Medical Officer",
          "security chief": "Security Chief",
          "science officer": "Science Officer",
          quartermaster: "Quartermaster",
        };
        const kind = str(data, "kind");
        const seats = Array.isArray(data.seats) ? data.seats : [];
        const sat = seats
          .map((entry) => {
            const s = asRecord(entry);
            return `${person(str(s, "member"))} (${seatTitles[str(s, "seat")] ?? str(s, "seat")})`;
          })
          .join(", ");
        const kindWords: Record<string, string> = {
          inquiry: "a board of inquiry",
          discipline: "a discipline hearing",
          rationing: "a sitting on rationing",
          lift: "a sitting on lifting rationing",
          ratification: "a sitting to ratify emergency rationing",
          emergency: "a sitting on emergency powers",
          relief: "a sitting on a motion of no confidence",
          appointment: "a sitting to ratify an appointment",
          course: "a sitting to set the course",
        };
        let text =
          `${ts} — The council convenes ${kindWords[kind] ?? "a sitting"} in the ${room(num(data, "room"))}. ` +
          `Sitting: ${sat}.`;
        const recused = Array.isArray(data.recused) ? data.recused : [];
        if (recused.length > 0) {
          text +=
            " Recused: " +
            recused
              .map((entry) => {
                const r = asRecord(entry);
                return `${person(str(r, "member"))} (${str(r, "reason")})`;
              })
              .join(", ") +
            ".";
        }
        const accused = str(data, "accused");
        if (accused !== "") {
          text += ` The accused: ${person(accused)}.`;
        }
        if (kind === "course") {
          const chart = Array.isArray(data.candidates) ? data.candidates : [];
          if (chart.length > 0) {
            text +=
              ` The chart from ${str(data, "from")} offers: ` +
              chart
                .map((entry) =>
                  typeof entry === "string"
                    ? entry
                    : str(asRecord(entry), "port"),
                )
                .join(", ") +
              ".";
          }
        }
        line(text, true);
        break;
      }
      case "course_decided": {
        const from = str(data, "from");
        const port = str(data, "port");
        if (data.noCouncil === true) {
          line(
            `${ts} — No council can sit to set the course from ${from}; ` +
              `the old charter rule lays it, and the ${this.shipName} sails for ${port}.`,
            true,
          );
          break;
        }
        const proposer = str(data, "proposer");
        const chart = Array.isArray(data.candidates) ? data.candidates : [];
        const chartText = chart
          .map((entry) => {
            const c = asRecord(entry);
            return `${str(c, "port")} (${oneDecimal(num(c, "legDays"))} days)`;
          })
          .join(", ");
        const leanings = Array.isArray(data.leanings) ? data.leanings : [];
        const leaningText = leanings
          .map((entry) => {
            const l = asRecord(entry);
            return `${person(str(l, "member"))} backs ${str(l, "port")} — ${str(l, "clause")}`;
          })
          .join("; ");
        const carried = data.carried === true;
        line(
          `${ts} — The course from ${from} is set. ` +
            (proposer !== ""
              ? `${person(proposer)} lays the chart: ${chartText}. `
              : `The chart: ${chartText}. `) +
            `The captain tables ${str(data, "motion")}. ` +
            (leaningText !== "" ? `${leaningText}. ` : "") +
            (carried
              ? `The vote carries the captain's course, ${num(data, "forCount")} to ${num(data, "againstCount")}: `
              : `The vote refuses the captain's course, ${num(data, "againstCount")} to ${num(data, "forCount")}: `) +
            `the ${this.shipName} sails for ${port}, ${oneDecimal(num(data, "legDays"))} days out.`,
          true,
        );
        break;
      }
      case "council_testimony": {
        const witness = person(str(data, "witness"));
        const about = person(str(data, "about"));
        const kind = str(data, "kind");
        const tag = str(data, "tag");
        const tagSuffix = tag !== "" && this.knowsTruth ? ` [${tag}]` : "";
        if (kind === "denial") {
          // The accused answers the board: speech, quoted, and a
          // full-chronicle line only; the summary needs no denial.
          line(`${ts} — ${witness}: "${denialText(data)}"${tagSuffix}`, false);
          break;
        }
        if (kind === "withheld") {
          // A witness who was there and kept quiet. Pure watcher
          // knowledge: with the log's truth setting off, it does
          // not print at all.
          if (this.knowsTruth) {
            line(
              `${ts} — (The log notes: ${witness} was there, and said nothing of ${about}.) [kept quiet]`,
              false,
            );
          }
          break;
        }
        line(
          `${ts} — Testimony: ${witness} names ${about}.` +
            (kind === "scapegoat" && this.knowsTruth
              ? ` (The log records: ${witness} is the culprit, naming a scapegoat.)`
              : ""),
          true,
        );
        // The claim itself, as spoken, with the watcher's grade:
        // a full-chronicle line under the summary.
        line(
          `${ts} — ${witness} testifies: "${testimonyText(data, { person, system, room })}"${tagSuffix}`,
          false,
        );
        break;
      }
      case "council_finding": {
        const kind = str(data, "kind");
        const votes = Array.isArray(data.votes) ? data.votes : [];
        const voteWords = (choice: string): string =>
          votes
            .filter((entry) => str(asRecord(entry), "choice") === choice)
            .map((entry) => person(str(asRecord(entry), "member")))
            .join(", ");
        const forList = voteWords("for");
        const againstList = voteWords("against");
        const abstainList = voteWords("abstain");
        let voteText = "";
        if (votes.length > 0) {
          voteText =
            ` Votes — for: ${forList || "none"}; against: ${againstList || "none"}` +
            (abstainList !== "" ? `; abstaining: ${abstainList}` : "") +
            ".";
        }
        if (kind === "inquiry" || kind === "discipline") {
          const accused = str(data, "accused");
          let text: string;
          if (accused === "") {
            text =
              `${ts} — The board finds a cause — ${str(data, "cause")} — and no culprit. ` +
              `The evidence pointed at no one the board could name.`;
          } else if (data.convicted === true) {
            text =
              `${ts} — The board finds: cause, ${str(data, "cause")}; ${person(accused)} is found culpable. ` +
              `Consequence: ${str(data, "consequence")}.`;
          } else {
            text =
              `${ts} — The board finds: cause, ${str(data, "cause")}; ${person(accused)} is acquitted.`;
          }
          line(text + voteText, true);
          // The truth line: what actually happened, and whether
          // the board's finding matches it. Watcher knowledge,
          // printed under the log's truth setting like every
          // truth marker here, in both chronicle modes, and only
          // where the sitting's record carries a truth to tell
          // (truthKnown): where the engine cannot know a truth,
          // nothing prints rather than an invented certainty.
          // Right means the finding matches on both counts the
          // board pronounced: the hand, and (for a death) the
          // cause.
          if (this.knowsTruth && data.truthKnown === true) {
            const truthCause = str(data, "truthCause");
            const truthCulprit = str(data, "truthCulprit");
            const victim = str(data, "victim");
            const culpritRight =
              accused === ""
                ? truthCulprit === ""
                : data.convicted === true
                  ? accused === truthCulprit
                  : accused !== truthCulprit;
            const causeWrong =
              victim !== "" &&
              truthCause !== "" &&
              str(data, "cause") !== truthCause;
            const right = culpritRight && !causeWrong;
            let facts: string;
            if (victim !== "") {
              facts =
                `${person(victim)} died of ${truthCause}` +
                (truthCulprit !== ""
                  ? `, and the hand was ${person(truthCulprit)}'s`
                  : ", and no hand did it");
            } else if (str(data, "cause") === "theft") {
              facts = `the hand in the stores was ${person(truthCulprit)}'s`;
            } else {
              facts = `the sabotage was ${person(truthCulprit)}'s work`;
            }
            line(
              `${ts} — The truth: ${facts}. The council was ${right ? "right" : "wrong"}.`,
              true,
            );
          }
        } else {
          const words: Record<string, string> = {
            rationing: "the rationing proposal",
            lift: "the motion to lift rationing",
            ratification: "the ratification of emergency rationing",
            emergency: "the grant of emergency powers",
            relief: "the motion of no confidence",
            appointment: "the First Officer's appointment",
            commendation: "a commendation",
            course: "the captain's course",
          };
          line(
            `${ts} — The council votes on ${words[kind] ?? kind}: ` +
              `${data.convicted === true ? "carried" : "refused"}.${voteText}`,
            true,
          );
        }
        break;
      }
      case "council_sentence": {
        const sentenceWords: Record<string, string> = {
          brig: "confined to the brig",
          quarters: "confined to quarters",
          restriction: "restricted from the ship's systems",
          mess_ban: "denied mess privileges",
          extra_duties: "given extra duties",
        };
        const kind = str(data, "sentence");
        line(
          `${ts} — Sentence: ${person(str(data, "member"))} is ${sentenceWords[kind] ?? kind}, ` +
            `until ${stamp(num(data, "untilTick"))}.`,
          true,
        );
        break;
      }
      case "council_seat_vacated": {
        const seatTitles: Record<string, string> = {
          captain: "Captain's",
          "first officer": "First Officer's",
          "chief engineer": "Chief Engineer's",
          "chief medical officer": "Chief Medical Officer's",
          "security chief": "Security Chief's",
          "science officer": "Science Officer's",
          quartermaster: "Quartermaster's",
        };
        line(
          `${ts} — The ${seatTitles[str(data, "seat")] ?? str(data, "seat")} seat stands empty: ` +
            `${person(str(data, "member"))} (${str(data, "reason")}).`,
          true,
        );
        break;
      }
      case "council_appointment": {
        const seatTitles: Record<string, string> = {
          "first officer": "First Officer",
          "chief engineer": "Chief Engineer",
          "chief medical officer": "Chief Medical Officer",
          "security chief": "Security Chief",
          "science officer": "Science Officer",
          quartermaster: "Quartermaster",
        };
        line(
          `${ts} — ${person(str(data, "by"))} appoints ${person(str(data, "member"))} ` +
            `as ${seatTitles[str(data, "seat")] ?? str(data, "seat")}.`,
          true,
        );
        break;
      }
      case "council_succession": {
        line(
          `${ts} — Succession: ${person(str(data, "member"))} takes the Captain's seat.`,
          true,
        );
        break;
      }
      case "appointment_ratified": {
        line(
          `${ts} — The council ratifies ${person(str(data, "member"))} as First Officer.`,
          true,
        );
        break;
      }
      case "appointment_refused": {
        line(
          `${ts} — The council refuses to ratify ${person(str(data, "member"))} as First Officer. The seat stands empty again.`,
          true,
        );
        break;
      }
      case "election_called": {
        const seatTitles: Record<string, string> = {
          captain: "Captain's",
          "first officer": "First Officer's",
          "chief engineer": "Chief Engineer's",
          "chief medical officer": "Chief Medical Officer's",
          "security chief": "Security Chief's",
          "science officer": "Science Officer's",
          quartermaster: "Quartermaster's",
        };
        line(
          `${ts} — An election is called for the ${seatTitles[str(data, "seat")] ?? str(data, "seat")} seat. ` +
            `${person(str(data, "incumbent"))} stands for it, and the campaign runs three days.`,
          true,
        );
        break;
      }
      case "election_result": {
        const seatTitles: Record<string, string> = {
          captain: "Captain's",
          "first officer": "First Officer's",
          "chief engineer": "Chief Engineer's",
          "chief medical officer": "Chief Medical Officer's",
          "security chief": "Security Chief's",
          "science officer": "Science Officer's",
          quartermaster: "Quartermaster's",
        };
        const winner = person(str(data, "winner"));
        line(
          data.changed === true
            ? `${ts} — The crew votes, and the ${seatTitles[str(data, "seat")] ?? str(data, "seat")} seat changes hands: ${winner} takes it.`
            : `${ts} — The crew votes, and ${winner} holds the ${seatTitles[str(data, "seat")] ?? str(data, "seat")} seat.`,
          true,
        );
        break;
      }
      case "election_unopposed": {
        const seatTitles: Record<string, string> = {
          captain: "Captain's",
          "first officer": "First Officer's",
          "chief engineer": "Chief Engineer's",
          "chief medical officer": "Chief Medical Officer's",
          "security chief": "Security Chief's",
          "science officer": "Science Officer's",
          quartermaster: "Quartermaster's",
        };
        line(
          `${ts} — No one stands against ${person(str(data, "incumbent"))} for the ${seatTitles[str(data, "seat")] ?? str(data, "seat")} seat. Returned unopposed.`,
          true,
        );
        break;
      }
      case "election_endorsed": {
        line(
          `${ts} — The captain endorses ${person(str(data, "candidate"))} for the council seat.`,
          false,
        );
        break;
      }
      case "election_void": {
        line(
          `${ts} — The election for a council seat falls through: ${str(data, "reason")}.`,
          false,
        );
        break;
      }
      case "commendation": {
        line(
          `${ts} — ${person(str(data, "member"))} is commended for restoring the ${system(str(data, "system"))}.`,
          true,
        );
        break;
      }
      case "captain_forgiveness": {
        line(
          `${ts} — The captain forgives ${person(str(data, "member"))}: the confinement is lifted, the finding stands.`,
          true,
        );
        break;
      }
      case "emergency_declared": {
        line(
          `${ts} — ${person(str(data, "by"))} declares an emergency and asks the council for emergency powers.`,
          true,
        );
        break;
      }
      case "emergency_granted": {
        line(
          `${ts} — Emergency powers are granted, until ${stamp(num(data, "untilTick"))}` +
            (num(data, "renewal") > 0
              ? ` (renewal ${num(data, "renewal")}).`
              : "."),
          true,
        );
        break;
      }
      case "emergency_refused": {
        line(`${ts} — The council refuses emergency powers.`, true);
        break;
      }
      case "emergency_expired": {
        line(`${ts} — The emergency powers expire.`, true);
        break;
      }
      case "relief_motion": {
        const movers = Array.isArray(data.movers)
          ? data.movers.map((id) => person(String(id)))
          : [];
        line(
          `${ts} — A motion of no confidence in the captain is tabled by ${movers.join(", ")}. The vote is recorded, not secret.`,
          true,
        );
        break;
      }
      case "captain_relieved": {
        line(
          `${ts} — The motion carries. ${person(str(data, "member"))} is relieved of command; ` +
            `${person(str(data, "newCaptain"))} takes the ship.`,
          true,
        );
        break;
      }
      case "relief_failed": {
        const movers = Array.isArray(data.movers)
          ? data.movers.map((id) => person(String(id)))
          : [];
        line(
          `${ts} — The motion of no confidence fails. The movers are marked: ${movers.join(", ")}.`,
          true,
        );
        break;
      }
      case "put_off": {
        line(
          `${ts} — ${person(str(data, "member"))} is put off at ${str(data, "port")}, under the board's sentence.`,
          true,
        );
        break;
      }
      case "ship_lost": {
        const survivors = Array.isArray(data.survivors)
          ? data.survivors.map((id) => person(String(id)))
          : [];
        const lost = Array.isArray(data.lost)
          ? data.lost.map((id) => person(String(id)))
          : [];
        line(
          `${ts} — The ${this.shipName} is lost: her ${str(data, "cause")} took her past saving. ` +
            `Reached the pods: ${survivors.join(", ") || "no one"}. Lost with her: ${lost.join(", ") || "no one"}.`,
          true,
        );
        break;
      }
      case "crew_collapse": {
        line(
          `${ts} — Too few able crew remain to work the ${this.shipName}. She drifts, ` +
            `and the log grows quieter, and then stops.`,
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
      case "chatter": {
        // A spoken line, quoted. The words are the speaker's; the
        // grade in brackets is the log's, printed only when the
        // log's truth setting allows, like every truth marker
        // here. Full mode carries every line; highlights carry
        // only the notable ones, capped per day in config.
        const names: SpeechNames = { person, system, room };
        const text = chatterText(data, names);
        if (text === "") break;
        let rendered =
          `${ts} — ${person(str(data, "speaker"))} tells ` +
          `${person(str(data, "listener"))}: "${text}"`;
        const tag = str(data, "tag");
        if (tag !== "" && this.knowsTruth) rendered += ` [${tag}]`;
        let highlight = false;
        if (data.notable === true) {
          const carried = this.chatterHighlights.get(day) ?? 0;
          if (carried < CONFIG.chatter.highlightsPerDay) {
            this.chatterHighlights.set(day, carried + 1);
            highlight = true;
          }
        }
        line(rendered, highlight);
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
        const two = (value: number): string => value.toFixed(2);
        const reasoning =
          typeof data.means === "number"
            ? ` (their reasoning: means ${two(num(data, "means"))}, ` +
              `motive ${two(num(data, "motive"))}, ` +
              `opportunity ${two(num(data, "opportunity"))})`
            : "";
        line(
          `${ts} — ${person(actor)} accuses ${person(str(data, "accused"))} of sabotage${reasoning}. ` +
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
      case "duty_neglected": {
        const def = dutyDef(str(data, "duty"));
        line(
          `${ts} — ${def?.neglectText ?? `The ${str(data, "name")} duty is overdue.`}`,
          true,
        );
        break;
      }
      case "duty_restored": {
        line(
          `${ts} — ${person(str(data, "by"))} brings the ${str(data, "duty") === "audit" ? "stores audit" : str(data, "duty")} back up to standard.`,
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
