// Scuttlebutt: the ship's social feed, built from the event
// stream and nothing else. The chronicle stays the record of what
// is true; the feed is what the crew says about it, in their own
// voices, plus the ship's own announcements and the council's
// votes drawn as polls. Every specific in a post (a name, a
// system, a room, a score) comes out of the event it answers;
// the words around the specifics are presentation, chosen by a
// hash of the event's sequence number, so the feed is as
// deterministic as the run and no engine stream is ever drawn.

import type { SimEvent } from "../../src/log/events.ts";
import { CONFIG } from "../../src/scenario/config.ts";
import { dutyDef } from "../../src/world/duties.ts";
import {
  chatterText,
  denialText,
  testimonyText,
} from "../../src/perception/speech.ts";
import { hash01 } from "./faces.ts";

export interface FeedNames {
  person: (id: string) => string;
  firstName: (id: string) => string;
  system: (id: string) => string;
  room: (index: number) => string;
  ship: string;
}

/** One face of a PORTFALL card, as the feed strip draws it. */
export interface MatchCardFace {
  suit: string;
  power: number;
  effect?: string;
}

/** A played PORTFALL match, carried on its result post so the
 *  card can draw the runs instead of only talking about them. */
export interface MatchStrip {
  condition: string;
  a: string;
  b: string;
  runs: Array<{ a: MatchCardFace; b: MatchCardFace; point: "a" | "b" | null }>;
}

/**
 * The feed's lanes: the reader's filter. Crew is the society
 * talking, Cards is the PORTFALL table, Sector is the wider
 * world's news, Ship is the vessel's own announcements.
 */
export type FeedLane = "crew" | "cards" | "sector" | "ship";

export interface FeedPost {
  kind: "post";
  seq: number;
  tick: number;
  /** Crew id of the poster, or null for the ship itself. */
  author: string | null;
  /** The lane this post files under; set by the builder's caller. */
  lane?: FeedLane;
  text: string;
  replies?: Array<{ author: string; text: string }>;
  /** Crew ids whose faces react warmly, from bonds already formed. */
  reactions?: string[];
  /** Set on PORTFALL result posts: the match, for the strip. */
  match?: MatchStrip;
}

export interface FeedPoll {
  kind: "poll";
  seq: number;
  tick: number;
  /** The lane this poll files under; set by the builder's caller. */
  lane?: FeedLane;
  question: string;
  outcome: string;
  bars: Array<{ choice: string; voters: string[] }>;
}

export type FeedItem = FeedPost | FeedPoll;

/**
 * File an item into its lane from the event that made it.
 * The table game and the sector have their own event families;
 * everything else files by voice: a named crew member (or a
 * council poll) is Crew, the ship speaking for itself is Ship.
 */
export function laneForEvent(event: SimEvent, item: FeedItem): FeedLane {
  if (event.type === "leisure_game") return "cards";
  if (
    event.type.startsWith("sector_") ||
    event.type === "faction_standing" ||
    event.type === "harbour_news"
  ) {
    return "sector";
  }
  if (item.kind === "poll") return "crew";
  if (item.author !== null) return "crew";
  return "ship";
}

function str(event: SimEvent, key: string): string {
  const value = event.data[key];
  return typeof value === "string" ? value : "";
}

function num(event: SimEvent, key: string): number {
  const value = event.data[key];
  return typeof value === "number" ? value : 0;
}

function pick<T>(seq: number, salt: number, bank: readonly T[]): T {
  const index = Math.floor(hash01(seq, salt) * bank.length) % bank.length;
  return bank[index] as T;
}

/** The PORTFALL duel carried on a leisure_game event, parsed
 *  into the strip shape; null when the event predates the game
 *  or the payload is not the shape the engine writes. */
function readDuel(event: SimEvent): {
  strip: MatchStrip;
  scoreA: number;
  scoreB: number;
} | null {
  const raw = event.data.duel;
  if (typeof raw !== "object" || raw === null) return null;
  const duel = raw as Record<string, unknown>;
  const a = duel.a;
  const b = duel.b;
  const condition = duel.condition;
  const scoreA = duel.scoreA;
  const scoreB = duel.scoreB;
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    typeof condition !== "string" ||
    typeof scoreA !== "number" ||
    typeof scoreB !== "number" ||
    !Array.isArray(duel.runs)
  ) {
    return null;
  }
  const runs: MatchStrip["runs"] = [];
  for (const entry of duel.runs) {
    if (!Array.isArray(entry) || entry.length < 7) return null;
    const [aSuit, aPower, aEffect, bSuit, bPower, bEffect, point] = entry as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    if (
      typeof aSuit !== "string" ||
      typeof aPower !== "number" ||
      typeof bSuit !== "string" ||
      typeof bPower !== "number"
    ) {
      return null;
    }
    runs.push({
      a: {
        suit: aSuit,
        power: aPower,
        effect: typeof aEffect === "string" && aEffect !== "" ? aEffect : undefined,
      },
      b: {
        suit: bSuit,
        power: bPower,
        effect: typeof bEffect === "string" && bEffect !== "" ? bEffect : undefined,
      },
      point: point === "a" || point === "b" ? point : null,
    });
  }
  return { strip: { condition, a, b, runs }, scoreA, scoreB };
}

const REPLIES_AGREE = [
  "Anytime.",
  "You had to be there. You were there, but still.",
  "Saving this for the hearing.",
  "Tea's on you, then.",
  "Heard, and logged, and framed.",
] as const;

const REPLIES_PROTEST = [
  "That is not how it happened.",
  "I was standing right there.",
  "Post it under your own name next time. Oh. You did.",
  "The log will sort this out.",
  "Bold words from someone who eats my cooking.",
] as const;

const REPLIES_DRY = [
  "Some of us remember the whole story.",
  "Posted with great confidence, as always.",
  "The rest of the ship was there too, you know.",
  "Keeping this one for the memoirs.",
] as const;

const REPLIES_EXCUSE = [
  "I was mid-repair. The ship comes first, apparently.",
  "Rest is a duty too. Ask the roster.",
  "Rain check. A real one, not a corridor one.",
  "My hands were full. My conscience is clear.",
] as const;

const SNUBBED = [
  "Walked up, said hello, got the back of a schedule. Noted, with love.",
  "Some conversations need an appointment now. Fine. Booking never.",
  "A nod would have cost nothing. Just putting that in the minutes.",
] as const;

const CALLBACK_REPAIRED = [
  "After everything, this.",
  "Took the long way round, this one.",
  "Water under the hull, then.",
  "Nobody frame this. It will not last a week. (It might.)",
] as const;

const CALLBACK_FALLEN = [
  "We used to eat together. Used to.",
  "There was a time this post would have read the other way.",
  "The mess seating chart feels this, even if nobody says it.",
] as const;

const REPAIR_AGAIN = [
  "Fixed. Again. The {system} and I are on familiar terms now.",
  "The {system} hums again. It knows the way to my toolbox by heart.",
  "{system}: restored, encore performance. I am taking a bow nobody asked for.",
] as const;

const STORE_LABELS: Record<string, string> = {
  food: "food",
  water: "water",
  parts: "spare parts",
  medicine: "medicine",
  fuel: "fuel",
};

function maybeReply(
  event: SimEvent,
  author: string,
  bank: readonly string[],
): { author: string; text: string } | undefined {
  if (hash01(event.seq, 91) >= 0.45) return undefined;
  return { author, text: pick(event.seq, 97, bank) };
}

/** One feed item for one event, or null when the event is not feed matter. */
export function feedItemFor(event: SimEvent, names: FeedNames): FeedItem | null {
  const seq = event.seq;
  const tick = event.tick;
  const actor = event.actors[0];
  switch (event.type) {
    case "chatter": {
      const speaker = str(event, "speaker");
      if (speaker === "") return null;
      const text = chatterText(event.data, names);
      if (text === "") return null;
      const listener = str(event, "listener");
      const post: FeedPost = { kind: "post", seq, tick, author: speaker, text };
      if (listener !== "" && listener !== speaker) {
        const reply = maybeReply(event, listener, REPLIES_AGREE);
        if (reply !== undefined) post.replies = [reply];
      }
      return post;
    }
    case "gossip": {
      const to = str(event, "to");
      const about = str(event, "about");
      if (to === "" || about === "") return null;
      const text = pick(seq, 11, [
        `Not naming names. Just saying some people are always near the scene. ${names.firstName(about)} knows.`,
        `Watching ${names.firstName(about)} around the stores these days. That is all. That is the post.`,
        `If ${names.firstName(about)} offers to fix something of yours, maybe hold off. No reason.`,
        `Interesting week to suddenly be everyone's best friend, ${names.firstName(about)}.`,
      ]);
      const post: FeedPost = { kind: "post", seq, tick, author: to, text };
      const reply = maybeReply(event, about, REPLIES_PROTEST);
      if (reply !== undefined) post.replies = [reply];
      return post;
    }
    case "bond_formed": {
      const withId = str(event, "with");
      if (actor === undefined || withId === "") return null;
      const level = num(event, "level");
      const text =
        level >= 2
          ? pick(seq, 13, [
              `${names.firstName(withId)} is my person now. The rest of you can form a queue.`,
              `Long watches go short with ${names.firstName(withId)}. Official.`,
              `If I am ever lost in a wreck, send ${names.firstName(withId)}. Nobody else. Send snacks too.`,
            ])
          : pick(seq, 13, [
              `${names.firstName(withId)} is good people. Writing it here so it is on record.`,
              `Shared a watch with ${names.firstName(withId)}. Would do it again.`,
            ]);
      const post: FeedPost = { kind: "post", seq, tick, author: actor, text };
      const reply = maybeReply(event, withId, REPLIES_AGREE);
      if (reply !== undefined) post.replies = [reply];
      return post;
    }
    case "grudge_formed": {
      const target = str(event, "target");
      if (actor === undefined || target === "") return null;
      const text = pick(seq, 17, [
        `Some people chew with their whole soul. No names. You know who you are.`,
        `New rule: my tools come back to me, or the airlock gets a suggestion box.`,
        `Smiled at ${names.firstName(target)} in the corridor today. Growth is tiring.`,
        `Counting to ten is a lifestyle now. Ask me how it is going in a week.`,
      ]);
      return { kind: "post", seq, tick, author: actor, text };
    }
    case "trust_broken": {
      const withId = str(event, "with");
      if (actor === undefined || withId === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: actor,
        text: pick(seq, 19, [
          `Fool me once, the log sorts it out. Fool me twice and I start checking locks.`,
          `Keeping my own counsel for a while. Nothing personal. Everything personal.`,
        ]),
      };
    }
    case "accusation": {
      const accused = str(event, "accused");
      if (actor === undefined || accused === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: actor,
        text: pick(seq, 23, [
          `I said it in the open and I will say it here: check ${names.firstName(accused)}'s story.`,
          `Accusation is on the record. Let the council earn its chairs.`,
        ]),
      };
    }
    case "leisure_game": {
      const winner = str(event, "winner");
      const players = Array.isArray(event.data.participants)
        ? event.data.participants.filter(
            (p): p is string => typeof p === "string",
          )
        : [];
      if (players.length === 0) return null;
      const duel = readDuel(event);
      if (duel === null) {
        // A game with no recorded match: the old table brag.
        if (winner === "") return null;
        const others = players
          .filter((p) => p !== winner)
          .map((p) => names.firstName(p))
          .join(", ");
        return {
          kind: "post",
          seq,
          tick,
          author: winner,
          text:
            others === ""
              ? `Champion of the ${names.room(num(event, "room"))}. Unopposed, undefeated.`
              : `Beat ${others} at the table in the ${names.room(num(event, "room"))}. Rematch when you have recovered.`,
        };
      }
      const { strip, scoreA, scoreB } = duel;
      const roomName = names.room(num(event, "room"));
      const score =
        winner === strip.b
          ? `${scoreB}–${scoreA}`
          : `${scoreA}–${scoreB}`;
      if (winner === "") {
        return {
          kind: "post",
          seq,
          tick,
          author: strip.a,
          text:
            `Played ${names.firstName(strip.b)} to a standstill at PORTFALL in the ${roomName}, ` +
            `${scoreA}–${scoreB} on a ${strip.condition} table. The cards settle nothing. Rematch pending.`,
          match: strip,
        };
      }
      const loser = winner === strip.a ? strip.b : strip.a;
      const winnerRuns = winner === strip.a ? scoreA : scoreB;
      const loserRuns = winner === strip.a ? scoreB : scoreA;
      let flavour = "Rematch when you have recovered.";
      const lastRun = strip.runs[strip.runs.length - 1];
      if (loserRuns === 0) {
        flavour = "Not close. The table saw it.";
      } else if (
        lastRun !== undefined &&
        ((lastRun.point === "a" && winner === strip.a) ||
          (lastRun.point === "b" && winner === strip.b)) &&
        (winner === strip.a ? lastRun.a : lastRun.b).effect === "anchor"
      ) {
        flavour = "The Anchor held the last run. That is the whole story.";
      } else if (winnerRuns - loserRuns === 1) {
        flavour = "By a single run. It will be argued about at breakfast.";
      }
      return {
        kind: "post",
        seq,
        tick,
        author: winner,
        text:
          `Beat ${names.firstName(loser)} ${score} at PORTFALL in the ${roomName}, ` +
          `on a ${strip.condition} table. ${flavour}`,
        match: strip,
      };
    }
    case "meal_service": {
      const notableA = str(event, "notableA");
      const notableB = str(event, "notableB");
      const meal =
        str(event, "meal") === "breakfast" ? "Breakfast" : "Evening meal";
      if (notableA !== "" && notableB !== "") {
        if (str(event, "notableKind") === "grudge") {
          return {
            kind: "post",
            seq,
            tick,
            author: notableA,
            text: `Sat across from ${names.firstName(notableB)}. Ate. Said nothing. Growth.`,
          };
        }
        return {
          kind: "post",
          seq,
          tick,
          author: notableA,
          text: `${meal} with ${names.firstName(notableB)}. Best seat on the ship, every time.`,
        };
      }
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `${meal} in the ${names.room(num(event, "room"))}: ${num(event, "count")} at table.`,
      };
    }
    case "system_repaired": {
      const by = str(event, "by");
      const system = names.system(str(event, "system"));
      if (by === "") {
        return {
          kind: "post",
          seq,
          tick,
          author: null,
          text: `The ${system} is repaired.`,
        };
      }
      return {
        kind: "post",
        seq,
        tick,
        author: by,
        text: pick(seq, 29, [
          `The ${system} hums again. You are welcome.`,
          `${system}: fixed. Hands: filthy. Standards: kept.`,
          `For the record, the ${system} did not fix itself.`,
        ]),
      };
    }
    case "system_failed": {
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `The ${names.system(str(event, "system"))} in the ${names.room(num(event, "room"))} has failed. Engineering has the call.`,
      };
    }
    case "sabotage_committed": {
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Sabotage found: the ${names.system(str(event, "system"))} in the ${names.room(num(event, "room"))} is damaged. Report what you saw.`,
      };
    }
    case "weather": {
      const to = str(event, "to");
      if (to === "") return null;
      const text =
        to === "radiation storm"
          ? "Radiation storm. Suits stay on hooks, tempers stay short, and nobody goes visiting the hull."
          : to === "solar wind"
            ? "Solar wind rising. The old hands say the ship sings in it. The old hands are romantic and wrong."
            : to === "debris field"
              ? "Debris field. Every clang is a reminder the hull is thinner than your plans."
              : "Skies clear. The calm is back on the manifest.";
      return { kind: "post", seq, tick, author: null, text };
    }
    case "departure": {
      const from = str(event, "from");
      const to = str(event, "to");
      if (from === "" || to === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Departing ${from} for ${to}. ${num(event, "days").toFixed(1)} days under way, if the weather minds its manners.`,
      };
    }
    case "arrival":
    case "port_call": {
      const port = str(event, "port");
      if (port === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Made port at ${port}. Shore leave rosters are with the quartermaster. Behave like the posters are watching.`,
      };
    }
    case "faction_standing": {
      const name = str(event, "name");
      if (name === "") return null;
      const band = str(event, "band");
      const texts: Record<string, string> = {
        warm: `Word travels faster than we do: the ${name} now speak well of this ship in their harbours.`,
        honoured: `The ${name} have raised this ship's name in their hall, and word travels. We are somebody out here now.`,
        cold: `Word travels: the ${name} have cooled on this ship. Mind your manners in their harbours.`,
        unregarded: `The ${name} no longer speak of this ship one way or the other. Ports forget fast.`,
      };
      const text = texts[band];
      if (text === undefined) return null;
      return { kind: "post", seq, tick, author: null, text };
    }
    case "sector_campaign": {
      const voice = str(event, "voice");
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text:
          `Harbour news: the ${str(event, "name")} are making a push at ${str(event, "port")}. Their ships are suddenly everywhere on that run.` +
          (voice !== ""
            ? ` ${voice} calls it "a long-overdue correction."`
            : ""),
      };
    }
    case "sector_contest_started": {
      const port = str(event, "port");
      const kind = str(event, "kind");
      const chal = str(event, "challengerName");
      const inc = str(event, "incumbentName");
      const voice = str(event, "voice");
      const feud = event.data["feud"] === true
        ? " There is old history between these two, and the harbour knows it."
        : "";
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text:
          (inc === ""
            ? `Harbour news at ${port}: the ${chal} bid openly for the free port. An ${kind} will settle it.`
            : `Harbour news at ${port}: the ${chal} have challenged the ${inc} for the port. An ${kind} will settle it, day by day.`) +
          feud +
          (voice !== ""
            ? ` ${voice} speaks for the challengers: "The port will decide, and we like its mood."`
            : ""),
      };
    }
    case "sector_contest_day": {
      if (event.data["witnessed"] !== true) return null;
      const port = str(event, "port");
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `From the dockside at ${port}: the ${str(event, "kind")} stands ${num(event, "scoreIncumbent")}–${num(event, "scoreChallenger")} after day ${num(event, "day")}. The harbour is keeping score on a wall.`,
      };
    }
    case "sector_contest_resolved": {
      const port = str(event, "port");
      const flipped = event.data["flipped"] === true;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: flipped
          ? `Harbour news at ${port}: the ${str(event, "kind")} is over, ${num(event, "scoreWinner")}–${num(event, "scoreLoser")}. The ${str(event, "winnerName")} take the port. New flag over the harbour office by morning.`
          : `Harbour news at ${port}: the ${str(event, "kind")} is over, ${num(event, "scoreWinner")}–${num(event, "scoreLoser")}. The ${str(event, "winnerName")} hold the port against the ${str(event, "loserName")}.`,
      };
    }
    case "sector_condition": {
      const port = str(event, "port");
      const state = str(event, "state");
      const phase = str(event, "phase");
      const text =
        phase === "pending"
          ? `Harbour news at ${port}: a ${state} is coming. Prices are already moving on the rumour.`
          : phase === "active"
            ? `Harbour news at ${port}: the ${state} is on. The harbour feels it in every queue and manifest.`
            : `Harbour news at ${port}: the ${state} has cleared. The harbour breathes again.`;
      return { kind: "post", seq, tick, author: null, text };
    }
    case "sector_relief": {
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Our call at ${str(event, "port")} counted as relief there. A hungry port remembers who showed up.`,
      };
    }
    case "sector_collapse": {
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Harbour news at ${str(event, "port")}: the ${str(event, "name")} are finished there. Their flag came down and the port answers to nobody now.`,
      };
    }
    case "resupply": {
      const port = str(event, "port");
      const manifest = Array.isArray(event.data.manifest)
        ? event.data.manifest.length
        : 0;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text:
          manifest > 0
            ? `Took aboard ${manifest} stores at ${port}. The tanks say thank you in their way.`
            : `No stores needed at ${port}. The ship wanted for nothing, and said so smugly.`,
      };
    }
    case "death": {
      if (actor === undefined) return null;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `The ${names.ship} records the death of ${names.person(actor)}. The watch roster keeps their name one more day.`,
      };
    }
    case "council_convened": {
      if (str(event, "kind") !== "inquiry") return null;
      const accused = str(event, "accused");
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text:
          accused !== ""
            ? `The council sits in inquiry on ${names.person(accused)}. Mess deck, closed doors, open ears.`
            : "The council sits in inquiry. Mess deck, closed doors, open ears.",
      };
    }
    case "rationing_imposed": {
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: "Rationing is imposed. Portions shrink; tempers are asked not to.",
      };
    }
    case "rationing_lifted": {
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: "Rationing is lifted. The mess sends its regards to the tanks.",
      };
    }
    case "council_testimony": {
      const witness = str(event, "witness");
      if (witness === "") return null;
      const text =
        str(event, "kind") === "denial"
          ? denialText(event.data)
          : testimonyText(event.data, names);
      if (text === "") return null;
      const about = str(event, "about");
      return {
        kind: "post",
        seq,
        tick,
        author: witness,
        text:
          about !== "" && about !== witness
            ? `Testifying on ${names.firstName(about)}: "${text}"`
            : `Testifying: "${text}"`,
      };
    }
    case "duty_neglected": {
      const def = dutyDef(str(event, "duty"));
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: def?.neglectText ?? `The ${str(event, "name")} duty is overdue.`,
      };
    }
    case "duty_restored": {
      const by = str(event, "by");
      const def = dutyDef(str(event, "duty"));
      const dutyName = (def?.name ?? "duty").toLowerCase();
      if (by === "") {
        return {
          kind: "post",
          seq,
          tick,
          author: null,
          text: `The crew brings the ${dutyName} back up to standard.`,
        };
      }
      return {
        kind: "post",
        seq,
        tick,
        author: by,
        text: pick(seq, 31, [
          `${def?.name ?? "The duty"}: back up to standard. It was not the standard fairy.`,
          `${dutyName}, handled. You may all breathe the good air again.`,
          `For the record: the ${dutyName} did not restore itself either.`,
        ]),
      };
    }
    case "socialize_refused": {
      const withId = str(event, "with");
      if (actor === undefined) return null;
      // Snubs are constant ship weather (measured: tens of
      // thousands in a two-year run). Only the occasional one
      // is feed matter, or the feed becomes a snub ledger.
      if (hash01(seq, 83) >= 0.06) return null;
      const post: FeedPost = {
        kind: "post",
        seq,
        tick,
        author: actor,
        text: pick(seq, 37, SNUBBED),
      };
      if (withId !== "") {
        const reply = maybeReply(event, withId, REPLIES_EXCUSE);
        if (reply !== undefined) post.replies = [reply];
      }
      return post;
    }
    case "level_up": {
      const person = str(event, "person");
      if (person === "") return null;
      const task = str(event, "task");
      const level = num(event, "level");
      return {
        kind: "post",
        seq,
        tick,
        author: person,
        text: pick(seq, 41, [
          `${task === "" ? "The work" : task[0]?.toUpperCase() + task.slice(1)}: level ${level}. The work teaches, if you let it.`,
          `Level ${level}, earned the slow way. No ceremony. This is the ceremony.`,
          `Turns out repetition is a teacher. Level ${level}. She charges nothing and forgives less.`,
        ]),
      };
    }
    case "shore_leave": {
      const port = str(event, "port");
      const members = Array.isArray(event.data.members)
        ? event.data.members.filter(
            (m): m is string => typeof m === "string",
          )
        : [];
      const first = members[0];
      if (port === "" || first === undefined) return null;
      const count = num(event, "count");
      return {
        kind: "post",
        seq,
        tick,
        author: first,
        text: pick(seq, 43, [
          `Shore leave at ${port}: ${count} of us loose on the dock. We will be back before the roster sends a search party.`,
          `${port} from the dockside: loud, bright, and selling everything. ${count} ashore. Behaving. Mostly.`,
        ]),
      };
    }
    case "harbour_news": {
      const port = str(event, "port");
      if (port === "") return null;
      const kind = str(event, "kind");
      if (kind === "berthing") {
        return {
          kind: "post",
          seq,
          tick,
          author: null,
          text: `Harbour news at ${port}: the ${str(event, "type")} ${str(event, "ship")} lies berthed here.`,
        };
      }
      if (kind === "recent") {
        const ago = num(event, "daysAgo");
        return {
          kind: "post",
          seq,
          tick,
          author: null,
          text: `Harbour news at ${port}: the ${str(event, "type")} ${str(event, "ship")} made port here ${ago} ${ago === 1 ? "day" : "days"} since and has sailed.`,
        };
      }
      const lines = CONFIG.stores.port.rumourLines;
      const template =
        lines[num(event, "variant") % lines.length] ?? lines[0] ?? "";
      if (template === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: template
          .replaceAll("{port}", port)
          .replaceAll("{faction}", str(event, "faction")),
      };
    }
    case "port_incident": {
      const port = str(event, "port");
      if (port === "") return null;
      const lines = CONFIG.stores.port.incidentLines;
      const template =
        lines[num(event, "variant") % lines.length] ?? lines[0] ?? "";
      if (template === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: template.replaceAll("{port}", port),
      };
    }
    case "stores_low": {
      const label = STORE_LABELS[str(event, "store")] ?? str(event, "store");
      const days = Math.round(num(event, "days"));
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: pick(seq, 89, [
          `Stores watch: roughly ${days} days of ${label} left. The quartermaster has started looking at ports the way the rest of us look at weather.`,
          `Stores watch: ${label} at roughly ${days} days. Nobody is panicking. The quartermaster is tidying, which is worse.`,
          `Counted twice: about ${days} days of ${label}. The next port call just got an agenda.`,
        ]),
      };
    }
    case "stores_critical": {
      const label = STORE_LABELS[str(event, "store")] ?? str(event, "store");
      const days = Math.round(num(event, "days"));
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: pick(seq, 89, [
          `Stores critical: roughly ${days} days of ${label} left. Next port is not a suggestion anymore.`,
          `Stores critical: ${label} at roughly ${days} days. The council has the numbers; the numbers have the council's attention.`,
          `This is the quartermaster's serious voice: ${label}, about ${days} days. Plan accordingly.`,
        ]),
      };
    }
    case "stores_discrepancy": {
      const by = str(event, "by");
      if (by === "") {
        return {
          kind: "post",
          seq,
          tick,
          author: null,
          text: "The stores count does not tally with the stores. Counting again, slower.",
        };
      }
      return {
        kind: "post",
        seq,
        tick,
        author: by,
        text: pick(seq, 47, [
          "Counted the stores twice. The stores disagree with the stores. Counting a third time, out loud.",
          "Somewhere between the manifest and the shelves there is a gap with good manners: it has not introduced itself yet.",
        ]),
      };
    }
    case "theft": {
      if (event.data.witnessed !== true) return null;
      const witness = str(event, "witness");
      const thief = str(event, "thief");
      if (witness === "" || thief === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: witness,
        text: pick(seq, 53, [
          `Saw it myself: ${names.firstName(thief)}, in the stores, helping themselves. The council can have the rest of the story.`,
          `Posting this so it is not just my word in a corridor: ${names.firstName(thief)} took from the stores. I was there.`,
        ]),
      };
    }
    case "repair_assist": {
      const systemName = str(event, "systemName");
      if (systemName === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Dock crews at ${str(event, "port")} lent their hands to the ${systemName}. Port manners, port prices.`,
      };
    }
    case "commendation": {
      const member = str(event, "member");
      if (member === "") return null;
      const systemId = str(event, "system");
      return {
        kind: "post",
        seq,
        tick,
        author: member,
        text:
          systemId !== ""
            ? pick(seq, 59, [
                `Commended, for the ${names.system(systemId)}. Framing the citation next to the toolbox.`,
                `The council commended the ${names.system(systemId)} work. Blushing in writing, once.`,
              ])
            : pick(seq, 59, [
                "Commended by the council. Blushing in writing, once.",
                "A commendation. The citation goes on the bulkhead, next to the scorch marks.",
              ]),
      };
    }
    case "leisure_exercise": {
      if (actor === undefined) return null;
      if (hash01(seq, 61) >= 0.5) return null;
      const withId = str(event, "with");
      const post: FeedPost = {
        kind: "post",
        seq,
        tick,
        author: actor,
        text:
          withId !== ""
            ? pick(seq, 67, [
                `Gym with ${names.firstName(withId)}. The ship moves; we stay hard to move.`,
                `Sparred the boredom off with ${names.firstName(withId)}. It lost on points.`,
              ])
            : pick(seq, 67, [
                "Gym. The machines do not gossip, which is half their charm.",
                "Put in the quiet work. The bulkheads witnessed everything and said nothing.",
              ]),
      };
      return post;
    }
    case "leisure_read": {
      if (actor === undefined) return null;
      if (hash01(seq, 71) >= 0.12) return null;
      return {
        kind: "post",
        seq,
        tick,
        author: actor,
        text: pick(seq, 73, [
          "Reading, off watch. The book's crew has worse problems than ours, which is comforting.",
          "A quiet hour and a borrowed book. Returning both in better condition.",
        ]),
      };
    }
    case "council_sentence": {
      const member = str(event, "member");
      if (member === "") return null;
      const words: Record<string, string> = {
        brig: "confined to the brig",
        quarters: "confined to quarters",
        restriction: "restricted from the ship's systems",
        mess_ban: "denied mess privileges",
        extra_duties: "given extra duties",
      };
      const kind = str(event, "sentence");
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `Sentence: ${names.person(member)} is ${words[kind] ?? kind}.`,
      };
    }
    case "election_called": {
      const seat = seatTitle(str(event, "seat"));
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `An election is called for the ${seat} seat. Three days of campaigning, then the whole crew votes. Mind the posters.`,
      };
    }
    case "election_declared": {
      const candidate = str(event, "candidate");
      if (candidate === "") return null;
      const seat = seatTitle(str(event, "seat"));
      const lines = [
        `I am standing for the ${seat} seat. You know my work. Judge it, and judge me beside it.`,
        `Standing for the ${seat} seat. No promises I cannot keep: you will see me at the table, and you will hear the truth from it.`,
        `I have put my name in for the ${seat} seat. Ask me anything, anywhere. That is the whole platform.`,
      ];
      return {
        kind: "post",
        seq,
        tick,
        author: candidate,
        text: lines[Math.floor(hash01(seq, 7) * lines.length)] as string,
      };
    }
    case "election_campaign": {
      const candidate = str(event, "candidate");
      if (candidate === "") return null;
      const seat = seatTitle(str(event, "seat"));
      const kind = str(event, "kind");
      let text: string;
      if (kind === "record") {
        const lines = [
          `My record is the campaign. Check the work, check the watches I stood, then vote how you like.`,
          `Everything I have done aboard is written down somewhere. Read it before you read my posters.`,
        ];
        text = lines[Math.floor(hash01(seq, 8) * lines.length)] as string;
      } else if (kind === "attack") {
        const rival = str(event, "rival");
        const rivalName = rival !== "" ? names.firstName(rival) : "my opponent";
        const lines = [
          `Ask ${rivalName} where they were the last time this ship needed hands. Then ask me.`,
          `${rivalName} talks a fine table. The ${seat} seat is sat in, not talked in.`,
        ];
        text = lines[Math.floor(hash01(seq, 9) * lines.length)] as string;
      } else {
        const lines = [
          `If I hold the ${seat} seat, sittings start on time and end with reasons given. That is the promise.`,
          `Vote for me and the ${seat} seat answers questions in the mess, not just at the table.`,
          `My promise is small and keepable: the ${seat} seat, present at every sitting, awake at every vote.`,
        ];
        text = lines[Math.floor(hash01(seq, 10) * lines.length)] as string;
      }
      return { kind: "post", seq, tick, author: candidate, text };
    }
    case "election_endorsed": {
      const by = str(event, "by");
      const candidate = str(event, "candidate");
      if (by === "" || candidate === "") return null;
      return {
        kind: "post",
        seq,
        tick,
        author: by,
        text: `For the seat: I have watched ${names.firstName(candidate)} work, and I am putting my name behind theirs. Vote as you judge, but judge knowing that.`,
      };
    }
    case "election_unopposed": {
      const incumbent = str(event, "incumbent");
      if (incumbent === "") return null;
      const seat = seatTitle(str(event, "seat"));
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `No challenger stood for the ${seat} seat. ${names.person(incumbent)} is returned unopposed.`,
      };
    }
    case "election_result": {
      const ballots = Array.isArray(event.data.ballots)
        ? event.data.ballots
        : [];
      if (ballots.length === 0) return null;
      const byChoice = new Map<string, string[]>();
      for (const entry of ballots) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const member =
          typeof record.member === "string" ? record.member : "";
        const choice =
          typeof record.choice === "string" ? record.choice : "";
        if (member === "" || choice === "") continue;
        const list = byChoice.get(choice) ?? [];
        list.push(member);
        byChoice.set(choice, list);
      }
      if (byChoice.size === 0) return null;
      const seat = seatTitle(str(event, "seat"));
      const winner = str(event, "winner");
      const winnerName = winner !== "" ? names.person(winner) : "the winner";
      const question = `Who holds the ${seat} seat?`;
      const outcome =
        event.data.changed === true
          ? `${winnerName} takes the ${seat} seat.`
          : `${winnerName} holds the ${seat} seat.`;
      const bars = [...byChoice.entries()].map(([candId, voters]) => ({
        choice: names.person(candId),
        voters,
      }));
      return { kind: "poll", seq, tick, question, outcome, bars };
    }
    case "council_finding": {
      const votes = Array.isArray(event.data.votes)
        ? event.data.votes
        : [];
      if (votes.length === 0) return null;
      const byChoice = new Map<string, string[]>();
      for (const entry of votes) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const member =
          typeof record.member === "string" ? record.member : "";
        const choice =
          typeof record.choice === "string" ? record.choice : "";
        if (member === "" || choice === "") continue;
        const list = byChoice.get(choice) ?? [];
        list.push(member);
        byChoice.set(choice, list);
      }
      if (byChoice.size === 0) return null;
      const kind = str(event, "kind");
      const accused = str(event, "accused");
      const accusedName =
        accused !== "" ? names.person(accused) : "the matter";
      let question: string;
      let outcome: string;
      if (kind === "inquiry" || kind === "discipline") {
        question =
          accused !== ""
            ? `Is ${accusedName} responsible?`
            : "Does the board find a cause?";
        if (accused === "") {
          outcome = `Finding: a cause, ${str(event, "cause")}, and no culprit named.`;
        } else if (event.data.convicted === true) {
          outcome = `Finding: ${accusedName} is held responsible.`;
        } else {
          outcome = `Finding: ${accusedName} is cleared.`;
        }
      } else if (kind === "commendation") {
        const subject = str(event, "subject");
        const subjectName =
          subject !== "" ? names.person(subject) : "the member";
        question = `Commend ${subjectName}?`;
        outcome =
          event.data.convicted === true
            ? `${subjectName} is commended.`
            : "The commendation is refused.";
      } else if (kind === "course") {
        // A course poll must say where the ship is going and,
        // on a refusal, why that port: the finding carries the
        // decision's basis and its strongest backers.
        question = "The council votes on the captain's course.";
        const coursePort = str(event, "coursePort");
        const backers = Array.isArray(event.data.courseBackers)
          ? event.data.courseBackers
          : [];
        const backerText = backers
          .slice(0, 2)
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) return "";
            const clause = (entry as Record<string, unknown>).clause;
            return typeof clause === "string" ? clause : "";
          })
          .filter((clause) => clause !== "")
          .join("; ");
        if (event.data.convicted === true) {
          outcome =
            coursePort !== ""
              ? `The motion carries. Course set for ${coursePort}.`
              : "The motion carries.";
        } else {
          outcome =
            "The motion is refused." +
            (coursePort !== ""
              ? ` The table's combined prices set the course for ${coursePort}`
              : "") +
            (backerText !== "" ? `: ${backerText}.` : ".");
        }
      } else {
        const phrases: Record<string, string> = {
          rationing: "the rationing proposal",
          lift: "lifting rationing",
          ratification: "ratifying emergency rationing",
          emergency: "emergency powers",
          relief: "a motion of no confidence",
          appointment: "the First Officer's appointment",
          course: "the captain's course",
        };
        question = `The council votes on ${phrases[kind] ?? kind}.`;
        outcome =
          event.data.convicted === true
            ? "The motion carries."
            : "The motion is refused.";
      }
      const order = ["for", "against", "abstain"];
      const bars = order
        .filter((choice) => byChoice.has(choice))
        .map((choice) => ({
          choice,
          voters: byChoice.get(choice) as string[],
        }));
      for (const [choice, voters] of byChoice) {
        if (!order.includes(choice)) bars.push({ choice, voters });
      }
      return { kind: "poll", seq, tick, question, outcome, bars };
    }
    default:
      return null;
  }
}

const SEAT_TITLES: Record<string, string> = {
  captain: "Captain's",
  "first officer": "First Officer's",
  "chief engineer": "Chief Engineer's",
  "chief medical officer": "Chief Medical Officer's",
  "security chief": "Security Chief's",
  "science officer": "Science Officer's",
  quartermaster: "Quartermaster's",
};

function seatTitle(key: string): string {
  return SEAT_TITLES[key] ?? key;
}

const DEFENCE = [
  "Leave them alone.",
  "Say it to their face next time.",
  "They have people on this ship. Remember that.",
  "Careful. That one is spoken for.",
] as const;

/**
 * The feed with a memory. feedItemFor alone is stateless; the
 * builder tracks the run's bonds and grudges as their events
 * arrive, so what decorates a post (the faces that react warmly,
 * the friend who answers a cold post) only ever comes from
 * relationships that already exist at that point in the run.
 * Deaths clear a name from every set.
 */
export class FeedBuilder {
  /** Turning points kept per pair in the ledger. */
  private static readonly LEDGER_CAP = 6;

  private readonly bonds = new Map<string, Set<string>>();
  private readonly grudges = new Map<string, Set<string>>();
  /** The last few turning points for each pair, keyed "a|b"
   *  with a < b, oldest first, capped at LEDGER_CAP. Kinds:
   *  bond, grudge, broken (the relational turns the callbacks
   *  answer), snub, accused. Later posts between the same two
   *  people answer the last relational turn: a bond after a
   *  grudge reads differently from a bond out of nowhere. */
  private readonly pairHistory = new Map<
    string,
    Array<{ kind: string; from: string; to: string }>
  >();
  /** System ids that have failed at least once this run. */
  private readonly failedSystems = new Set<string>();
  /** Table-game wins per person, for streak callouts. */
  private readonly gameWins = new Map<string, number>();

  private pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  private link(
    map: Map<string, Set<string>>,
    from: string,
    to: string,
  ): void {
    const set = map.get(from) ?? new Set<string>();
    set.add(to);
    map.set(from, set);
  }

  private unlink(map: Map<string, Set<string>>, from: string, to: string): void {
    map.get(from)?.delete(to);
  }

  private track(event: SimEvent): void {
    const actor = event.actors[0];
    switch (event.type) {
      case "bond_formed": {
        const withId = str(event, "with");
        if (actor === undefined || withId === "") break;
        this.link(this.bonds, actor, withId);
        this.link(this.bonds, withId, actor);
        break;
      }
      case "grudge_formed": {
        const target = str(event, "target");
        if (actor === undefined || target === "") break;
        this.link(this.grudges, actor, target);
        break;
      }
      case "trust_broken": {
        const withId = str(event, "with");
        if (actor === undefined || withId === "") break;
        this.unlink(this.bonds, actor, withId);
        this.unlink(this.bonds, withId, actor);
        break;
      }
      case "system_failed": {
        const system = str(event, "system");
        if (system !== "") this.failedSystems.add(system);
        break;
      }
      case "death": {
        if (actor === undefined) break;
        this.bonds.delete(actor);
        this.grudges.delete(actor);
        for (const set of this.bonds.values()) set.delete(actor);
        for (const set of this.grudges.values()) set.delete(actor);
        for (const key of [...this.pairHistory.keys()]) {
          const [a, b] = key.split("|");
          if (a === actor || b === actor) this.pairHistory.delete(key);
        }
        break;
      }
      default:
        break;
    }
  }

  /** One event in, one decorated feed item (or null) out. */
  push(event: SimEvent, names: FeedNames): FeedItem | null {
    // Pair history is read for callbacks before this event
    // updates it, then updated for whatever comes later.
    const actor0 = event.actors[0];
    const other0 =
      str(event, "with") || str(event, "target") || undefined;
    const ledgerKey =
      actor0 !== undefined && other0 !== undefined
        ? this.pairKey(actor0, other0)
        : undefined;
    const entries =
      ledgerKey !== undefined
        ? (this.pairHistory.get(ledgerKey) ?? [])
        : [];
    // The last relational turn (bond, grudge, broken) is what
    // callbacks answer; snubs and accusations sit in the
    // ledger without resetting it.
    let prevPair: string | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const kind = entries[i]?.kind;
      if (kind === "bond" || kind === "grudge" || kind === "broken") {
        prevPair = kind;
        break;
      }
    }
    if (ledgerKey !== undefined && actor0 !== undefined && other0 !== undefined) {
      const kind =
        event.type === "bond_formed"
          ? "bond"
          : event.type === "grudge_formed"
            ? "grudge"
            : event.type === "trust_broken"
              ? "broken"
              : event.type === "socialize_refused"
                ? "snub"
                : event.type === "accusation"
                  ? "accused"
                  : undefined;
      if (kind !== undefined) {
        const next = [
          ...entries,
          {
            kind,
            from: kind === "snub" ? other0 : actor0,
            to: kind === "snub" ? actor0 : other0,
          },
        ];
        this.pairHistory.set(
          ledgerKey,
          next.slice(-FeedBuilder.LEDGER_CAP),
        );
      }
    }
    this.track(event);
    const item = feedItemFor(event, names);
    if (item === null || item.kind !== "post") {
      return item;
    }
    // A repair of a system that has failed before is a reunion,
    // not an introduction, in the repairer's own voice. Ship
    // posts keep the plain line: the ship has no toolbox.
    if (event.type === "system_repaired" && item.author !== null) {
      const systemId = str(event, "system");
      if (systemId !== "" && this.failedSystems.has(systemId)) {
        item.text = pick(event.seq, 167, REPAIR_AGAIN).replaceAll(
          "{system}",
          names.system(systemId),
        );
      }
    }
    if (item.author === null) {
      return item;
    }
    // A trial is solemn: testimony and accusations carry no reactions.
    if (event.type === "council_testimony" || event.type === "accusation") {
      return item;
    }
    const author = item.author;
    // Callbacks: this post answers the pair's last turning point.
    if (event.type === "bond_formed" && prevPair !== undefined && prevPair !== "bond") {
      item.text += " " + pick(event.seq, 163, CALLBACK_REPAIRED);
    }
    if (
      (event.type === "grudge_formed" || event.type === "trust_broken") &&
      prevPair === "bond"
    ) {
      item.text += " " + pick(event.seq, 163, CALLBACK_FALLEN);
    }
    if (event.type === "leisure_game") {
      const winner = str(event, "winner");
      if (winner !== "") {
        const wins = (this.gameWins.get(winner) ?? 0) + 1;
        this.gameWins.set(winner, wins);
        if (winner === author && wins >= 3) {
          item.text += ` That is win number ${wins} at the table. The others have noticed.`;
        }
      }
    }
    // A friend of the grudge's target answers the cold post.
    if (event.type === "grudge_formed") {
      const target = str(event, "target");
      const defenders = [...(this.bonds.get(target) ?? [])]
        .filter((id) => id !== author)
        .sort();
      const first = defenders[0];
      if (first !== undefined && hash01(event.seq, 137) < 0.6) {
        item.replies = [
          ...(item.replies ?? []),
          { author: first, text: pick(event.seq, 139, DEFENCE) },
        ];
      }
    }
    // Warm faces: the author's bonded crew, never the post's subject.
    const subject =
      str(event, "with") || str(event, "about") || str(event, "target");
    const warm = [...(this.bonds.get(author) ?? [])]
      .filter((id) => id !== subject)
      .sort()
      .slice(0, 3);
    if (warm.length > 0 && hash01(event.seq, 131) < 0.7) {
      item.reactions = warm;
    }
    // A bond announcement can draw one dry voice: someone who
    // holds a grudge against the author, watching the parade.
    if (event.type === "bond_formed" && hash01(event.seq, 173) < 0.3) {
      const holders = [...this.grudges.entries()]
        .filter(([, set]) => set.has(author))
        .map(([holder]) => holder)
        .filter((id) => id !== author && id !== subject)
        .sort();
      const first = holders[0];
      if (first !== undefined) {
        item.replies = [
          ...(item.replies ?? []),
          { author: first, text: pick(event.seq, 179, REPLIES_DRY) },
        ];
      }
    }
    // Reply chains: when a post already drew one answer, a
    // second voice sometimes joins, the subject's friend in
    // protest or the author's friend in agreement, never
    // repeating a voice already in the thread.
    if (
      item.replies !== undefined &&
      item.replies.length === 1 &&
      hash01(event.seq, 149) < 0.35
    ) {
      const heard = new Set([author, item.replies[0]?.author]);
      let second: { author: string; text: string } | undefined;
      if (event.type === "gossip" && subject !== "") {
        const friend = [...(this.bonds.get(subject) ?? [])]
          .filter((id) => !heard.has(id))
          .sort()[0];
        if (friend !== undefined) {
          second = { author: friend, text: pick(event.seq, 151, DEFENCE) };
        }
      }
      if (second === undefined) {
        const friend = [...(this.bonds.get(author) ?? [])]
          .filter((id) => !heard.has(id) && id !== subject)
          .sort()[0];
        if (friend !== undefined) {
          second = {
            author: friend,
            text: pick(event.seq, 151, REPLIES_AGREE),
          };
        }
      }
      if (second !== undefined) item.replies = [...item.replies, second];
    }
    return item;
  }
}
