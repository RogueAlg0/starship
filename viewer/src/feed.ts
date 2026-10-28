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

export interface FeedPost {
  kind: "post";
  seq: number;
  tick: number;
  /** Crew id of the poster, or null for the ship itself. */
  author: string | null;
  text: string;
  replies?: Array<{ author: string; text: string }>;
  /** Crew ids whose faces react warmly, from bonds already formed. */
  reactions?: string[];
}

export interface FeedPoll {
  kind: "poll";
  seq: number;
  tick: number;
  question: string;
  outcome: string;
  bars: Array<{ choice: string; voters: string[] }>;
}

export type FeedItem = FeedPost | FeedPoll;

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
      if (winner === "" || players.length === 0) return null;
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
      return {
        kind: "post",
        seq,
        tick,
        author: null,
        text: `${by !== "" ? names.person(by) : "The crew"} brings the ${(def?.name ?? "duty").toLowerCase()} back up to standard.`,
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
  private readonly bonds = new Map<string, Set<string>>();
  private readonly grudges = new Map<string, Set<string>>();

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
      case "death": {
        if (actor === undefined) break;
        this.bonds.delete(actor);
        this.grudges.delete(actor);
        for (const set of this.bonds.values()) set.delete(actor);
        for (const set of this.grudges.values()) set.delete(actor);
        break;
      }
      default:
        break;
    }
  }

  /** One event in, one decorated feed item (or null) out. */
  push(event: SimEvent, names: FeedNames): FeedItem | null {
    this.track(event);
    const item = feedItemFor(event, names);
    if (item === null || item.kind !== "post" || item.author === null) {
      return item;
    }
    // A trial is solemn: testimony and accusations carry no reactions.
    if (event.type === "council_testimony" || event.type === "accusation") {
      return item;
    }
    const author = item.author;
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
    return item;
  }
}
