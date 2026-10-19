// Speech: the chatter layer, a voice laid over the social machinery.
//
// The crew already socialise, eat together, and pass suspicion by
// gossip; until now all of it was silent arithmetic. This module
// turns some of it into spoken lines, under three hard rules.
//
// 1. Lines are composed from real state only: a belief the speaker
//    actually holds, a fact of the ship's situation, their own body,
//    their relationship to the listener. Templates carry the words;
//    the state carries the facts, and a line with no fact behind it
//    is never spoken.
// 2. Speech is inert. This layer reads beliefs, bodies, the ship,
//    and the event log, and writes nothing but `chatter` events
//    (and the speaker's own last-spoken tick). Line selection draws
//    NO RNG stream: the gates and variants below are pure hashes of
//    the moment, so speech can never shift the simulation it
//    reports. A test proves it: chatter on and off, the runs are
//    identical apart from the chatter events themselves.
// 3. The log never lies, but people do, and the log says so. A
//    spoken suspicion is graded against the log's own record (the
//    sabotage culprits and thieves it holds) and tagged for the
//    watcher: [not true] when the substance is false, [lie] when
//    the speaker is themselves in the culprit set and points
//    elsewhere. The tags live in the event payload and the
//    chronicle's rendering; no belief ever reads them.

import type { World } from "../engine/engine.ts";
import { hash32 } from "../engine/rng.ts";
import type { CrewMember } from "../entities/crew.ts";
import type { SimEvent } from "../log/events.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Voyage } from "../world/galaxy.ts";
import type { Ship } from "../world/ship.ts";
import type { Weather } from "../world/weather.ts";

/** A deterministic gate in [0, 1): a hash of the moment, no stream. */
export function gate01(...parts: readonly (string | number)[]): number {
  return hash32(parts.join("|")) / 4294967296;
}

/** A deterministic template index for the moment, in [0, count). */
export function pickVariant(
  parts: readonly (string | number)[],
  count: number,
): number {
  if (count <= 1) return 0;
  return Math.floor(gate01(...parts) * count) % count;
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

function num(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" ? value : 0;
}

/** Everyone the log itself records as a hand in the ship's crimes:
 *  sabotage culprits and stores thieves, witnessed or not. This is
 *  the truth the watcher grades speech against. */
export function culpritsInLog(events: readonly SimEvent[]): Set<string> {
  const culprits = new Set<string>();
  for (const event of events) {
    if (event.type === "sabotage_committed") {
      const culprit = event.data.culprit;
      if (typeof culprit === "string") culprits.add(culprit);
    } else if (event.type === "theft") {
      const thief = event.data.thief;
      if (typeof thief === "string") culprits.add(thief);
    }
  }
  return culprits;
}

interface RecentCrime {
  kind: "sabotage" | "theft";
  system: string | null;
  thief: string | null;
  witness: string | null;
}

/** The most recent crime still young enough to be talk. */
function latestCrime(events: readonly SimEvent[], tick: number): RecentCrime | null {
  const floor = tick - CONFIG.chatter.crimeTalkTicks;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SimEvent;
    if (event.tick < floor) break;
    if (event.type === "sabotage_committed") {
      return {
        kind: "sabotage",
        system: typeof event.data.system === "string" ? event.data.system : null,
        thief: null,
        witness: null,
      };
    }
    if (event.type === "theft") {
      return {
        kind: "theft",
        system: null,
        thief: typeof event.data.thief === "string" ? event.data.thief : null,
        witness: typeof event.data.witness === "string" ? event.data.witness : null,
      };
    }
  }
  return null;
}

/** A theft in the talk window that this speaker saw this person commit. */
function witnessedTheft(
  events: readonly SimEvent[],
  tick: number,
  speakerId: string,
  aboutId: string,
): boolean {
  const floor = tick - CONFIG.chatter.crimeTalkTicks;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SimEvent;
    if (event.tick < floor) break;
    if (
      event.type === "theft" &&
      event.data.thief === aboutId &&
      event.data.witness === speakerId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Grade a spoken suspicion against the log. Null: the substance is
 * true (the person spoken of is in the culprit set). "lie": the
 * substance is false and the speaker is themselves in the culprit
 * set, pointing elsewhere. "not true": the substance is false and
 * the speaker believes what they say; they are wrong, not lying.
 */
export function suspicionTag(
  events: readonly SimEvent[],
  speakerId: string,
  aboutId: string,
): "lie" | "not true" | null {
  const culprits = culpritsInLog(events);
  if (culprits.has(aboutId)) return null;
  if (culprits.has(speakerId)) return "lie";
  return "not true";
}

/** The tick of the ship's most recent spoken line, or far past.
 *  Read off the log's tail: speech paces itself by what it has
 *  already said, and the scan is bounded because a chatter event
 *  older than the bound is, for pacing, long ago. */
function lastChatterTick(w: World): number {
  const events = w.events.events;
  const floor = Math.max(0, events.length - 600);
  for (let i = events.length - 1; i >= floor; i--) {
    const event = events[i] as SimEvent;
    if (event.type === "chatter") return event.tick;
  }
  return -1000000;
}

/** The ship-wide pacing gate shared by every kind of speech. */
function shipQuiet(w: World): boolean {
  return w.tick - lastChatterTick(w) < CONFIG.chatter.shipGapTicks;
}

/** Write one spoken line into the log, and mark the speaker's tick. */
function speak(
  w: World,
  speaker: CrewMember,
  listener: CrewMember,
  data: Record<string, unknown>,
): void {
  speaker.lastChatterTick = w.tick;
  w.emit("chatter", [speaker.id], {
    speaker: speaker.id,
    listener: listener.id,
    room: speaker.room,
    ...data,
  });
}

/**
 * Gossip made audible. Called from the gossip flow itself, at the
 * moment a suspicion actually transfers from speaker to listener:
 * a gated fraction of transfers are spoken aloud, in the speaker's
 * own belief, about the person the suspicion concerns. Notable
 * when the transfer tipped the listener over their accusation
 * threshold, when the speaker is rehearsing an accusation of
 * their own, or when the line is a lie.
 */
export function maybeGossipSpeech(
  w: World,
  speaker: CrewMember,
  listener: CrewMember,
  aboutId: string,
  opts: { tipped: boolean; rehearsal: boolean },
): void {
  const cfg = CONFIG.chatter;
  if (!cfg.enabled) return;
  if (w.tick - speaker.lastChatterTick < cfg.gossipCooldownTicks) return;
  if (shipQuiet(w)) return;
  const gate = gate01("gossip", w.tick, speaker.id, listener.id, aboutId);
  if (gate >= cfg.gossipSpeakFraction) return;

  const events = w.events.events;
  let topic = "suspicionNoAct";
  let system: string | null = null;
  if (witnessedTheft(events, w.tick, speaker.id, aboutId)) {
    topic = "theftSeen";
  } else {
    const crime = latestCrime(events, w.tick);
    if (crime !== null && crime.kind === "theft") {
      topic = "theftHeard";
    } else if (crime !== null && crime.kind === "sabotage") {
      topic = "suspicion";
      system = crime.system;
    }
  }
  const tag = suspicionTag(events, speaker.id, aboutId);
  const templates = cfg.templates[topic] ?? [];
  const data: Record<string, unknown> = {
    topic,
    variant: pickVariant(
      ["gossip-line", w.tick, speaker.id, listener.id, aboutId],
      templates.length,
    ),
    about: aboutId,
    notable: opts.tipped || opts.rehearsal || tag === "lie",
  };
  if (system !== null) data.system = system;
  if (tag !== null) data.tag = tag;
  speak(w, speaker, listener, data);
}

/** The ship's situation, as talk sees it: computed fresh, read-only. */
export interface SpeechSituation {
  storm: boolean;
  hurtSystem: { id: string; state: string; failed: boolean } | null;
  rationingStore: "food" | "water" | null;
  underway: { port: string; days: number } | null;
  inPort: string | null;
}

export function speechSituation(
  ship: Ship,
  weather: Weather,
  voyage: Voyage,
  tick: number,
): SpeechSituation {
  // The worst hurt system: a failed one outranks a merely hurt
  // one; within a class, the lowest condition speaks.
  let hurtSystem: SpeechSituation["hurtSystem"] = null;
  let hurtCondition = Number.POSITIVE_INFINITY;
  for (const system of ship.systems) {
    if (system.condition >= CONFIG.systems.damagedThreshold) continue;
    const outranks =
      hurtSystem === null ||
      (system.failed && !hurtSystem.failed) ||
      (system.failed === hurtSystem.failed && system.condition < hurtCondition);
    if (!outranks) continue;
    hurtCondition = system.condition;
    hurtSystem = {
      id: system.id,
      failed: system.failed,
      state: system.failed
        ? "dead"
        : system.condition < CONFIG.systems.strainThreshold
          ? "on its last legs"
          : "running rough",
    };
  }
  const stores = ship.stores;
  const rationingStore = stores === null
    ? null
    : stores.rationing.food
      ? "food"
      : stores.rationing.water
        ? "water"
        : null;
  let underway: SpeechSituation["underway"] = null;
  let inPort: string | null = null;
  const leg = voyage.currentLegAt(tick);
  if (leg !== null) {
    const days = Math.max(
      1,
      Math.ceil((leg.arriveTick - voyage.voyageTimeAt(tick)) / CONFIG.time.ticksPerDay),
    );
    underway = { port: voyage.sector.portAt(leg.to).name, days };
  } else {
    const stay = voyage.stayAt(tick);
    if (stay !== null) inPort = voyage.sector.portAt(stay.port).name;
  }
  return { storm: weather.storm, hurtSystem, rationingStore, underway, inPort };
}

/** The port a course sitting chose within the talk window, if any. */
function recentCoursePort(events: readonly SimEvent[], tick: number): string | null {
  const floor = tick - CONFIG.chatter.recentCourseTicks;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SimEvent;
    if (event.tick < floor) break;
    if (event.type === "course_decided") {
      const port = event.data.port;
      return typeof port === "string" ? port : null;
    }
  }
  return null;
}

/** The speaker's worst wounded part, if they carry a wound at all. */
function worstPart(speaker: CrewMember): string | null {
  let part: string | null = null;
  let worst = 0;
  for (const [name, wound] of Object.entries(speaker.body.wounds)) {
    if (wound.severity > worst) {
      worst = wound.severity;
      part = name;
    }
  }
  return part;
}

/**
 * General talk: on a shared-leisure occasion (a socialize that
 * landed, a pair at a meal table), a gated fraction of speakers
 * find a line. The topics are tried in salience order and the
 * first fact that exists is the line: the ship hurt, the body
 * hurt, the weather, the rationing, the course just set, the
 * port ahead, the speaker's own hunger and tiredness, a grudge,
 * a bond. No fact, no line.
 */
export function maybeSocialSpeech(
  w: World,
  speaker: CrewMember,
  listener: CrewMember,
  ship: Ship,
  weather: Weather,
  voyage: Voyage,
  source: "social" | "table",
): boolean {
  const cfg = CONFIG.chatter;
  if (!cfg.enabled) return false;
  if (w.tick - speaker.lastChatterTick < cfg.speakerCooldownTicks) return false;
  if (shipQuiet(w)) return false;
  const fraction =
    source === "table" ? cfg.tableSpeakFraction : cfg.socialSpeakFraction;
  if (gate01(source, w.tick, speaker.id, listener.id) >= fraction) return false;

  const situation = speechSituation(ship, weather, voyage, w.tick);
  let topic: string | null = null;
  const data: Record<string, unknown> = { notable: false };
  const part = worstPart(speaker);
  if (situation.hurtSystem !== null && situation.hurtSystem.failed) {
    topic = "system";
    data.system = situation.hurtSystem.id;
    data.state = situation.hurtSystem.state;
  } else if (part !== null) {
    topic = "hurt";
    data.part = part;
  } else if (speaker.body.sick >= 0.4) {
    topic = "sick";
  } else if (situation.hurtSystem !== null) {
    topic = "system";
    data.system = situation.hurtSystem.id;
    data.state = situation.hurtSystem.state;
  } else if (situation.storm) {
    topic = "storm";
  } else if (situation.rationingStore !== null) {
    topic = "rationing";
    data.store = situation.rationingStore;
  } else {
    const coursePort = recentCoursePort(w.events.events, w.tick);
    if (coursePort !== null) {
      topic = "course";
      data.port = coursePort;
    } else if (speaker.needs.hunger < 0.35) {
      topic = "hungry";
    } else if (speaker.needs.energy < 0.3) {
      topic = "tired";
    } else {
      const grudgeTarget = speaker.beliefs.grudges.find(
        (id) => id !== listener.id,
      );
      if (grudgeTarget !== undefined) {
        topic = "grudge";
        data.target = grudgeTarget;
      } else if (
        // Warmth and voyage talk are filler: true on almost every
        // occasion aboard a settled ship (bonds saturate; the
        // next port is always ahead), so they speak last, only
        // through a second gate, and the gate's hash picks which
        // filler the moment holds, so no one of them dominates.
        gate01("filler", w.tick, speaker.id, listener.id) <
        CONFIG.chatter.fillerSpeakFraction
      ) {
        const filler: string[] = [];
        if (
          (speaker.beliefs.bond[listener.id] ?? 0) >=
          CONFIG.relationships.bondMilestoneHigh
        ) {
          filler.push("bond");
        }
        // The countdown is true every day, which is exactly why
        // it must clear a stricter gate of its own: a sailor
        // remarks on the days left sometimes, not daily.
        if (
          gate01("voyage", w.tick, speaker.id, listener.id) <
          CONFIG.chatter.voyageSpeakFraction
        ) {
          if (situation.underway !== null) {
            filler.push(situation.underway.days > 1 ? "underway" : "underwaySoon");
          } else if (situation.inPort !== null) {
            filler.push("inport");
          }
        }
        if (filler.length > 0) {
          topic =
            filler[
              pickVariant(
                ["filler-pick", w.tick, speaker.id, listener.id],
                filler.length,
              )
            ] ?? null;
          if (topic === "underway" || topic === "underwaySoon") {
            data.port = situation.underway?.port;
            data.days = situation.underway?.days;
          } else if (topic === "inport") {
            data.port = situation.inPort;
          }
        }
      }
    }
  }
  if (topic === null) return false;
  const templates = CONFIG.chatter.templates[topic] ?? [];
  data.topic = topic;
  data.variant = pickVariant(
    ["social-line", w.tick, speaker.id, listener.id, topic],
    templates.length,
  );
  speak(w, speaker, listener, data);
  return true;
}

/** Name resolution for line composition, supplied by the renderer. */
export interface SpeechNames {
  person(id: string): string;
  system(id: string): string;
  room(index: number): string;
}

function fill(
  template: string,
  data: Record<string, unknown>,
  names: SpeechNames,
): string {
  return template
    .replaceAll("{about}", names.person(str(data, "about")))
    .replaceAll("{target}", names.person(str(data, "target")))
    .replaceAll("{system}", names.system(str(data, "system")))
    .replaceAll("{room}", names.room(num(data, "room")))
    .replaceAll("{port}", str(data, "port"))
    .replaceAll("{days}", String(num(data, "days")))
    .replaceAll("{store}", str(data, "store"))
    .replaceAll("{part}", str(data, "part"))
    .replaceAll("{state}", str(data, "state"));
}

/** Compose a chatter event's spoken line from its payload. */
export function chatterText(
  data: Record<string, unknown>,
  names: SpeechNames,
): string {
  const templates = CONFIG.chatter.templates[str(data, "topic")] ?? [];
  const template = templates[num(data, "variant") % Math.max(1, templates.length)];
  return template === undefined ? "" : fill(template, data, names);
}

/** Compose a testimony statement's spoken claim from its payload. */
export function testimonyText(
  data: Record<string, unknown>,
  names: SpeechNames,
): string {
  const list =
    data.present === true
      ? CONFIG.chatter.templates.testimonyPresent
      : CONFIG.chatter.templates.testimonyHeard;
  const templates = list ?? [];
  const template = templates[num(data, "variant") % Math.max(1, templates.length)];
  return template === undefined ? "" : fill(template, data, names);
}

/** Compose the accused's denial from its payload. */
export function denialText(data: Record<string, unknown>): string {
  const templates = CONFIG.chatter.templates.denial ?? [];
  return templates[num(data, "variant") % Math.max(1, templates.length)] ?? "";
}
