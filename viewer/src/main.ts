// The viewer: a separate layer over the same engine in ../../src.
//
// The simulation runs entirely here, in the browser, from the seed in
// the URL. The viewer creates a run through the stepper API and advances
// it on a requestAnimationFrame clock; it never changes engine code
// paths. Two choices keep it pleasant over hours of slow play:
//
// - Catch-up is clamped: a frame advances at most MAX_TICKS_PER_FRAME
//   ticks and any larger backlog (a slept phone, a backgrounded tab) is
//   discarded, so returning to the tab resumes gently instead of
//   burst-simulating the whole absence in one frame.
// - The chronicle keeps at most MAX_CHRONICLE_DOM_LINES line elements in
//   the DOM. Older lines leave the DOM, but the full rendered log stays
//   in memory as line objects, so toggling the filter can rebuild the
//   visible window at any time.

import {
  createChronicleRenderer,
  type ChronicleLine,
  type ChronicleRenderer,
} from "../../src/log/chronicle.ts";
import type { SimEvent } from "../../src/log/events.ts";
import { CONFIG } from "../../src/scenario/config.ts";
import { createRun, type RunContext } from "../../src/sim.ts";
import type { CrewMember } from "../../src/entities/crew.ts";
import {
  blockAt,
  mealWindowAt,
  type BlockKind,
} from "../../src/entities/routine.ts";
import {
  appearanceOf,
  departmentOf,
  faceStateOf,
  getPortraitCanvas,
  stateSignature,
} from "./faces.ts";
import {
  AlertStack,
  AlertStackView,
  type AlertItem,
} from "./alerts.ts";
import {
  daysOf,
  STORE_KEYS,
  STORE_LABELS,
  STORE_PRODUCER_KIND,
  type StoreKey,
} from "../../src/world/stores.ts";
import { dailySeed } from "./daily.ts";
import { DeckView } from "./deck.ts";
import { Minimap } from "./minimap.ts";
import { StarMapView } from "./starmap.ts";
import type { Port } from "../../src/world/galaxy.ts";
import type { TrafficShip } from "../../src/world/traffic.ts";
import { watchName, type WatchName } from "./daynight.ts";
import { spriteCanvas, type SpriteDef } from "./props.ts";

/** Playback speeds: keys and buttons 1 to 6, mirroring the reference. */
const SPEEDS = [
  { label: "1x", ticksPerSecond: 0.4 }, // one tick every 2.5 s: the witness pace
  { label: "2x", ticksPerSecond: 1 },
  { label: "3x", ticksPerSecond: 3 },
  { label: "4x", ticksPerSecond: 8 },
  { label: "5x", ticksPerSecond: 20 },
  { label: "6x", ticksPerSecond: 60 },
] as const;

const MAX_TICKS_PER_FRAME = 5;
const MAX_CHRONICLE_DOM_LINES = 300;

const NEED_KEYS = ["energy", "hunger", "social", "morale"] as const;
type NeedKey = (typeof NEED_KEYS)[number];
const NEED_LABELS: Record<NeedKey, string> = {
  energy: "Energy",
  hunger: "Food",
  social: "Social",
  morale: "Morale",
};

function must<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`viewer: no element #${id}`);
  return element as unknown as T;
}

// ---------------------------------------------------------------- state

/** One chronicle line with the event type that produced it. */
interface LogLine {
  line: ChronicleLine;
  type: string;
}

let run: RunContext;
let renderer: ChronicleRenderer;
let currentSeed = 42;
let toastTimer = 0;
let seenEvents = 0;
let allLines: LogLine[] = [];
let playing = true;
let speedIndex = 2; // 3x
let accumulator = 0;
let lastFrameMs = 0;
let lastSlowUiMs = 0;
/** When the deck was last painted (the paused throttle's clock). */
let lastDeckMs = 0;
let selectedCrew: string | null = null;
/**
 * The chronicle's detail: "highlights" (the default; the log as a
 * minor channel) or "full" (every line, exactly as rendered). The
 * choice lives in the URL (?log=full) and in localStorage, and
 * switching rebuilds the visible log from allLines without ever
 * touching the sim.
 */
let logMode: "highlights" | "full" = "highlights";
let weatherName = "calm";
let stickToBottom = true;

// ------------------------------------------------------------ dom handles

const shipNameEl = must<HTMLElement>("ship-name");
const clockDayEl = must<HTMLElement>("clock-day");
const clockTimeEl = must<HTMLElement>("clock-time");
const watchIcon = must<HTMLCanvasElement>("watch-icon");
const watchLabelEl = must<HTMLElement>("watch-label");
const speedReadoutEl = must<HTMLElement>("speed-readout");
const hashEl = must<HTMLElement>("hash");
const eventCountEl = must<HTMLElement>("event-count");
const playBtn = must<HTMLButtonElement>("play-btn");
const dailyText = must<HTMLElement>("daily-text");
const dailyBtn = must<HTMLButtonElement>("daily-btn");
const toastEl = must<HTMLElement>("toast");
const speedGroup = must<HTMLElement>("speed-group");
const seedInput = must<HTMLInputElement>("seed-input");
const weatherBanner = must<HTMLElement>("weather-banner");
const weatherNameEl = must<HTMLElement>("weather-name");
const alertStackEl = must<HTMLElement>("alert-stack");
const deckCanvas = must<HTMLCanvasElement>("ship-canvas");
const deck1Btn = must<HTMLButtonElement>("deck1-btn");
const deck2Btn = must<HTMLButtonElement>("deck2-btn");
const exteriorBtn = must<HTMLButtonElement>("exterior-btn");
const mapBtn = must<HTMLButtonElement>("map-btn");
const routeEl = must<HTMLElement>("route-readout");
const minimapCanvas = must<HTMLCanvasElement>("minimap-canvas");
const crewPanel = must<HTMLElement>("crew-panel");
const chronicleEl = must<HTMLElement>("chronicle");
const logHighlightsBtn = must<HTMLButtonElement>("log-highlights-btn");
const logFullBtn = must<HTMLButtonElement>("log-full-btn");
const ribbonEl = must<HTMLElement>("day-ribbon");

// ------------------------------------------------------------------ deck

/** The procedural deck view for the current run's ship. */
let deck: DeckView | null = null;

/**
 * The system each member last worked, from their work events: the
 * viewer remembers it so the deck can stand them at that system's
 * equipment while they work. Repairs need no memory: the member's
 * live repairTarget names the system.
 */
const workSystemByMember = new Map<string, string | null>();

// ------------------------------------------------- staging the mundane
//
// Presentation state the deck needs that the member snapshot alone
// does not carry, all of it read off the event stream the viewer
// already drains. The engine is never asked for any of it.

/** A table game in progress, from its leisure_game event. */
interface ActiveGame {
  room: number;
  participants: string[];
  untilTick: number;
}

/**
 * A game lasts about an hour of ship time (the engine's own flavour
 * for one: "an hour of cards"), six ticks at ten minutes each. The
 * deck seats the players for exactly that span from the event.
 */
const GAME_TICKS = CONFIG.time.ticksPerDay / 24;
const activeGames: ActiveGame[] = [];
/** Player id to their seat at the game's table, rebuilt on change. */
const gameSeatByMember = new Map<string, { room: number; seat: number }>();

function rebuildGameSeats(): void {
  gameSeatByMember.clear();
  for (const game of activeGames) {
    game.participants.forEach((id, seat) => {
      gameSeatByMember.set(id, { room: game.room, seat });
    });
  }
}

/** Retire finished games; called on the frame clock. */
function pruneGames(): void {
  if (activeGames.length === 0) return;
  let changed = false;
  for (let i = activeGames.length - 1; i >= 0; i--) {
    if (run.tick >= (activeGames[i] as ActiveGame).untilTick) {
      activeGames.splice(i, 1);
      changed = true;
    }
  }
  if (changed) rebuildGameSeats();
}

/**
 * Members carrying a prop in transit, derived from move events:
 * "tool" toward a room holding a damaged or failed system the
 * member can repair, "crate" out of the cargo bay. The derivation
 * is deliberately conservative: when in doubt, empty hands.
 */
const carryByMember = new Map<string, "tool" | "crate">();

function updateCarry(memberId: string, event: SimEvent): void {
  const member = crewById(memberId);
  if (member === undefined) return;
  const towards = eventNum(event, "towards");
  const from = eventNum(event, "from");
  // The engine's own repair test (affinity plus skill), applied to
  // the move's destination: an engineer heading to a failed system
  // carries the tools for it.
  const errand = run.ship.systems.find(
    (s) =>
      s.room === towards &&
      (s.damaged || s.failed) &&
      member.affinity.includes(s.kind) &&
      member.repairSkill >= 0.2,
  );
  if (errand !== undefined) {
    carryByMember.set(memberId, "tool");
    return;
  }
  // Leaving the cargo bay means carrying stores out of it. Heading
  // in is a fetch not yet fetched: empty hands.
  if (run.ship.rooms[from]?.kind === "cargo") {
    carryByMember.set(memberId, "crate");
    return;
  }
  carryByMember.delete(memberId);
}

/** The minimap: both decks at a glance, beside the main canvas. */
let minimap: Minimap | null = null;
let lastMinimapMs = 0;

/** The star map for the current run's sector, on the same canvas. */
let starMap: StarMapView | null = null;
/** True while the main canvas shows the sector chart, not the ship. */
let mapActive = false;

function buildDeck(): void {
  deck = new DeckView(run.ship, deckCanvas);
  minimap = new Minimap(deck.shipLayout, minimapCanvas);
  starMap = new StarMapView(
    deckCanvas,
    run.galaxy.sector,
    run.galaxy.voyage,
    run.galaxy.traffic,
    run.ship.name,
    currentSeed,
  );
  mapActive = false;
  closePortCard();
  closeTrafficCard();
  refreshDeckButtons();
}

/**
 * Show one deck on the main canvas. The other deck keeps living: its
 * wear accrues, its crew ride the lifts, and the minimap watches it.
 * Coming in from outside, this is also the way back: the deck focus
 * was never moved by stepping out.
 */
function setViewDeck(next: number): void {
  if (deck === null) return;
  mapActive = false;
  closePortCard();
  closeTrafficCard();
  deck.setExterior(false);
  deck.setDeck(next);
  refreshDeckButtons();
}

/** Step outside: the ship from the hull, windows lit by the life inside. */
function setViewExterior(): void {
  if (deck === null) return;
  mapActive = false;
  closePortCard();
  closeTrafficCard();
  deck.setExterior(true);
  refreshDeckButtons();
}

/** Open the chart: the sector, its ports, and the route being sailed. */
function setViewMap(): void {
  if (deck === null) return;
  deck.setExterior(false);
  mapActive = true;
  refreshDeckButtons();
}

function refreshDeckButtons(): void {
  const outside = (deck?.exteriorActive ?? false) && !mapActive;
  const active = deck?.visibleDeck ?? 0;
  deck1Btn.classList.toggle("active", !outside && !mapActive && active === 0);
  deck2Btn.classList.toggle("active", !outside && !mapActive && active === 1);
  exteriorBtn.classList.toggle("active", outside);
  mapBtn.classList.toggle("active", mapActive);
  deckCanvas.setAttribute(
    "aria-label",
    mapActive
      ? "Star map of the sector: ports in their factions' colours, the chartered route, and the ship under way. Tap a port for its card."
      : outside
        ? "The ship from outside: her hull in profile, windows lit by the crew inside. Tap a part of the hull to go to its deck."
        : "Top-down deck plan of the ship: rooms, equipment, and crew at work",
  );
}

// ---------------------------------------------------------------- alerts

/**
 * Urgency-tiered alerts over the deck (./alerts.ts). Two feeds,
 * both from state the viewer already holds: the event stream (in
 * drainEvents) for moments, and the per-frame system conditions
 * (in updateSlowUi) for states. Nothing is invented here; the
 * texts mirror the chronicle's own sentences.
 */
const alertStack = new AlertStack();
const alertView = new AlertStackView(alertStackEl, alertStack, (item) => {
  focusAlert(item);
});

/** A tap on an alert: go to the person, or to the room it names. */
function focusAlert(item: AlertItem): void {
  const focus = item.focus;
  if (focus.personId !== undefined) {
    const member = crewById(focus.personId);
    if (member === undefined || deck === null) return;
    const where = deck.deckOfRoom(member.room);
    if (mapActive || where !== deck.visibleDeck) setViewDeck(where);
    selectCrew(member.id);
    openPersonCard(member.id);
    return;
  }
  if (focus.room !== undefined && deck !== null) {
    const where = deck.deckOfRoom(focus.room);
    if (mapActive || where !== deck.visibleDeck) setViewDeck(where);
    deck.flashRoom(focus.room);
  }
}

function eventStr(event: SimEvent, key: string): string {
  const value = event.data[key];
  return typeof value === "string" ? value : "";
}

function eventNum(event: SimEvent, key: string): number {
  const value = event.data[key];
  return typeof value === "number" ? value : 0;
}

function systemName(id: string): string {
  return run.ship.systems.find((s) => s.id === id)?.name ?? id;
}

function roomName(index: number): string {
  return run.ship.rooms[index]?.name ?? `room ${index}`;
}

/** Moments from the event stream, tiered by how loud they are. */
function feedAlert(event: SimEvent): void {
  const now = performance.now();
  const actor = event.actors[0];
  switch (event.type) {
    case "sabotage_committed": {
      const systemId = eventStr(event, "system");
      const system = run.ship.systems.find((s) => s.id === systemId);
      const room = system?.room ?? eventNum(event, "room");
      alertStack.post(
        {
          tier: "major",
          category: "sabotage",
          text:
            `Sabotage: the ${systemName(systemId)} in the ` +
            `${roomName(room)} is found damaged.`,
          focus: { room, systemId },
        },
        now,
      );
      break;
    }
    case "accusation": {
      if (actor === undefined) break;
      alertStack.post(
        {
          tier: "major",
          category: "speech",
          text:
            `${personName(actor)} accuses ` +
            `${personName(eventStr(event, "accused"))} of sabotage.`,
          focus: { personId: actor },
        },
        now,
      );
      break;
    }
    case "grudge_formed": {
      if (actor === undefined) break;
      alertStack.post(
        {
          tier: "major",
          category: "grudge",
          text:
            `${personName(actor)} now holds a grudge against ` +
            `${personName(eventStr(event, "target"))}.`,
          focus: { personId: actor },
        },
        now,
      );
      break;
    }
    case "trust_broken": {
      if (actor === undefined) break;
      alertStack.post(
        {
          tier: "major",
          category: "trust",
          text:
            `${personName(actor)}'s trust in ` +
            `${personName(eventStr(event, "with"))} is broken.`,
          focus: { personId: actor },
        },
        now,
      );
      break;
    }
    case "system_repaired": {
      const systemId = eventStr(event, "system");
      const system = run.ship.systems.find((s) => s.id === systemId);
      const by = eventStr(event, "by");
      alertStack.post(
        {
          tier: "minor",
          category: "repair",
          text:
            by !== ""
              ? `${personName(by)} has repaired the ${systemName(systemId)}.`
              : `The ${systemName(systemId)} is repaired.`,
          focus: { room: system?.room, systemId },
        },
        now,
      );
      break;
    }
    case "bond_formed": {
      if (actor === undefined) break;
      const level = eventNum(event, "level");
      alertStack.post(
        {
          tier: "minor",
          category: "bond",
          text:
            level >= 2
              ? `${personName(actor)} and ${personName(eventStr(event, "with"))} are fast friends now.`
              : `${personName(actor)} and ${personName(eventStr(event, "with"))} have grown close.`,
          focus: { personId: actor },
        },
        now,
      );
      break;
    }
    case "stores_low":
    case "stores_critical": {
      const key = eventStr(event, "store") as StoreKey;
      const days = Math.floor(eventNum(event, "days"));
      const system = run.ship.systems.find(
        (s) => s.kind === STORE_PRODUCER_KIND[key],
      );
      alertStack.post(
        {
          tier: event.type === "stores_critical" ? "critical" : "major",
          category: "stores",
          text:
            event.type === "stores_critical"
              ? `${STORE_LABELS[key]} stores are critical: ${days} days remain.`
              : `${STORE_LABELS[key]} stores run low: ${days} days remain.`,
          focus: { room: system?.room, systemId: system?.id },
        },
        now,
      );
      break;
    }
    case "rationing_imposed": {
      const by = eventStr(event, "by");
      if (by === "") break;
      alertStack.post(
        {
          tier: "major",
          category: "stores",
          text:
            `${personName(by)} imposes rationing: ` +
            `${eventStr(event, "store")} at ${Math.floor(eventNum(event, "days"))} days.`,
          focus: { personId: by },
        },
        now,
      );
      break;
    }
    case "theft": {
      // Only a witnessed theft is news aboard; the rest is a tally
      // the chronicle finds later, or never.
      if (event.data.witnessed !== true) break;
      alertStack.post(
        {
          tier: "major",
          category: "sabotage",
          text:
            `${personName(eventStr(event, "witness"))} saw ` +
            `${personName(eventStr(event, "thief"))} take food from the stores.`,
          focus: { personId: eventStr(event, "thief") },
        },
        now,
      );
      break;
    }
    case "dead_in_space": {
      const system = run.ship.systems.find((s) => s.kind === "engines");
      alertStack.post(
        {
          tier: "major",
          category: "stores",
          text: `Out of fuel: the ${run.ship.name} drifts, dead in space.`,
          focus: { room: system?.room, systemId: system?.id },
        },
        now,
      );
      break;
    }
    default:
      break;
  }
}

/** States from the live conditions, plus the speed the clock runs at. */
function syncAlerts(): void {
  alertStack.setTps(
    playing
      ? (SPEEDS[speedIndex] as (typeof SPEEDS)[number]).ticksPerSecond
      : 0,
  );
  alertStack.syncSystems(
    run.ship.systems.map((s) => ({
      id: s.id,
      name: s.name,
      room: s.room,
      roomName: roomName(s.room),
      condition: s.condition,
      failed: s.failed,
    })),
    performance.now(),
  );
}


// ------------------------------------------------------------ crew panel

interface CrewUi {
  row: HTMLDivElement;
  face: HTMLCanvasElement;
  /** The role line: it carries the "Ashore" marker in port. */
  roleEl: HTMLDivElement;
  /** Face state signature the row portrait currently shows. */
  sig: string;
  bars: Map<NeedKey, HTMLDivElement>;
}
let crewUi = new Map<string, CrewUi>();

function buildCrewPanel(): void {
  crewPanel.replaceChildren();
  crewUi = new Map();
  for (const member of run.crew) {
    const dept = departmentOf(member.roleKey);
    const row = document.createElement("div");
    row.className = "crew-row";
    row.dataset.crew = member.id;

    const face = document.createElement("canvas");
    face.className = "face";
    face.width = 64;
    face.height = 64;
    face.style.borderColor = dept.colour;
    const faceCtx = face.getContext("2d");
    const state = faceStateOf(member);
    if (faceCtx !== null) {
      faceCtx.drawImage(getPortraitCanvas(member, state), 0, 0);
    }
    row.appendChild(face);

    const who = document.createElement("div");
    who.className = "who";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = member.name;
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = member.title;
    who.append(name, role);
    row.appendChild(who);

    const needs = document.createElement("div");
    needs.className = "needs";
    const bars = new Map<NeedKey, HTMLDivElement>();
    for (const key of NEED_KEYS) {
      const cell = document.createElement("div");
      cell.className = "need";
      const label = document.createElement("span");
      label.className = "need-label";
      label.textContent = NEED_LABELS[key];
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      bar.appendChild(fill);
      cell.append(label, bar);
      needs.appendChild(cell);
      bars.set(key, fill);
    }
    row.appendChild(needs);

    row.addEventListener("click", () => {
      tapCrew(member.id);
    });
    crewPanel.appendChild(row);
    crewUi.set(member.id, {
      row,
      face,
      roleEl: role,
      sig: stateSignature(state),
      bars,
    });
  }
}

/** One tap behaviour for rows and map markers alike. */
function tapCrew(id: string): void {
  // The kind thing: if they are on the other deck, go to them.
  const member = crewById(id);
  if (member !== undefined && deck !== null) {
    const where = deck.deckOfRoom(member.room);
    if (mapActive || where !== deck.visibleDeck) setViewDeck(where);
  }
  if (selectedCrew === id) {
    selectCrew(null);
    closePersonCard();
  } else {
    selectCrew(id);
    openPersonCard(id);
  }
}

function selectCrew(id: string | null): void {
  selectedCrew = id;
  for (const [crewId, ui] of crewUi) {
    ui.row.classList.toggle("selected", crewId === id);
  }
  refreshLineDims();
}

// --------------------------------------------------------- person card

const personCard = must<HTMLElement>("person-card");
const personFace = must<HTMLCanvasElement>("person-face");
const personNameEl = must<HTMLElement>("person-name");
const personRoleEl = must<HTMLElement>("person-role");
const personWhereEl = must<HTMLElement>("person-where");
const personBioEl = must<HTMLElement>("person-bio");
const personDossierEl = must<HTMLElement>("person-dossier");
const personRecentEl = must<HTMLElement>("person-recent");
let cardCrewId: string | null = null;
let lastCardRenderMs = 0;

const ACTIVITY_WORDS: Record<string, string> = {
  work: "working",
  rest: "resting",
  eat: "eating",
  move: "on the move",
  repair: "repairing",
  socialize: "in conversation",
  exercise: "exercising",
  read: "reading",
  idle: "taking a moment",
};

/** The routine block names for the person card's watch line. */
const BLOCK_WORDS: Record<BlockKind, string> = {
  sleep: "Asleep",
  work: "On duty",
  meal: "At table",
  free: "Free time",
};

function crewById(id: string): CrewMember | undefined {
  return run.crew.find((member) => member.id === id);
}

function personName(id: string): string {
  return crewById(id)?.name ?? id;
}

function openPersonCard(id: string): void {
  cardCrewId = id;
  closePortCard();
  closeTrafficCard();
  personCard.hidden = false;
  lastCardRenderMs = 0;
  renderPersonCard();
}

function closePersonCard(): void {
  cardCrewId = null;
  personCard.hidden = true;
}

must<HTMLButtonElement>("person-close").addEventListener("click", () => {
  selectCrew(null);
  closePersonCard();
});

/**
 * The prose bio: appearance from the hash-derived descriptor, then the
 * clauses the live state has earned. Every fact is sim state or the
 * person's own descriptor; the viewer writes only the glue.
 */
function bioText(member: CrewMember): string {
  const look = appearanceOf(member);
  const parts: string[] = [];
  let opening =
    `${member.name} is ${look.heightWord}, of ${look.buildWord}, ` +
    `with ${look.skinWord} skin, ${look.hairStyleWord} in ${look.hairWord}, ` +
    `and ${look.eyeWord} eyes.`;
  if (look.mark === "mole") {
    opening += ` A small mole marks their ${look.markSide} cheek.`;
  } else if (look.mark === "freckles") {
    opening += " Freckles are scattered across their nose and cheeks.";
  }
  parts.push(opening);
  parts.push(
    `They serve as the ship's ${member.title.toLowerCase()} ` +
      `in the ${look.department.name.toLowerCase()} department.`,
  );
  if (member.traits.length > 0) {
    parts.push(`By temperament they are ${member.traits.join(", ")}.`);
  }
  const n = member.needs;
  if (n.energy < 0.2) parts.push("They are running on empty and badly need rest.");
  else if (n.energy < 0.4) parts.push("They look tired.");
  if (n.hunger < 0.3) parts.push("They have not eaten properly in a while.");
  if (n.social < 0.3) parts.push("They have been keeping to themselves, and it shows.");
  if (n.morale >= 0.72) parts.push("Their morale is high.");
  else if (n.morale < 0.3) parts.push("Their morale is in the bilges.");
  if (member.beliefs.grudges.length > 0) {
    const names = member.beliefs.grudges.map(personName).join(", ");
    parts.push(`They hold a grudge against ${names}.`);
  }
  let accusers = 0;
  for (const other of run.crew) {
    if (other !== member && (other.beliefs.suspicion[member.id] ?? 0) >= 0.3) {
      accusers++;
    }
  }
  if (accusers >= 2) {
    parts.push("Several crewmates suspect them of sabotage.");
  }
  return parts.join(" ");
}

function dossierRow(label: string, text: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "drow";
  const b = document.createElement("b");
  b.textContent = label;
  row.append(b, document.createTextNode(` ${text}`));
  return row;
}

function dossierLabel(text: string): HTMLDivElement {
  const label = document.createElement("div");
  label.className = "dlabel";
  label.textContent = text;
  return label;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPct(value: number): string {
  const p = Math.round(value * 100);
  return p > 0 ? `+${p}%` : `${p}%`;
}

function buildDossier(member: CrewMember): void {
  personDossierEl.replaceChildren();

  const needs = document.createElement("div");
  needs.className = "needs";
  for (const key of NEED_KEYS) {
    const cell = document.createElement("div");
    cell.className = "need";
    const label = document.createElement("span");
    label.className = "need-label";
    label.textContent = NEED_LABELS[key];
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    const value = member.needs[key];
    fill.style.width = `${Math.round(value * 100)}%`;
    fill.className = value < 0.25 ? "low" : value < 0.5 ? "mid" : "";
    bar.appendChild(fill);
    cell.append(label, bar);
    needs.appendChild(cell);
  }
  personDossierEl.appendChild(needs);

  // Closest relationships first: bond, with trust beside it.
  const others = run.crew
    .filter((other) => other !== member)
    .sort(
      (a, b) =>
        (member.beliefs.bond[b.id] ?? 0) - (member.beliefs.bond[a.id] ?? 0),
    )
    .slice(0, 5);
  personDossierEl.appendChild(dossierLabel("Closest aboard"));
  for (const other of others) {
    personDossierEl.appendChild(
      dossierRow(
        other.name,
        `bond ${pct(member.beliefs.bond[other.id] ?? 0)}, ` +
          `trust ${signedPct(member.beliefs.trust[other.id] ?? 0)}`,
      ),
    );
  }

  if (member.beliefs.grudges.length > 0) {
    personDossierEl.appendChild(
      dossierRow(
        "Holds a grudge against",
        member.beliefs.grudges.map(personName).join(", "),
      ),
    );
  }

  const suspects = run.crew
    .filter(
      (other) =>
        other !== member && (member.beliefs.suspicion[other.id] ?? 0) >= 0.2,
    )
    .sort(
      (a, b) =>
        (member.beliefs.suspicion[b.id] ?? 0) -
        (member.beliefs.suspicion[a.id] ?? 0),
    );
  if (suspects.length > 0) {
    personDossierEl.appendChild(
      dossierRow(
        "Suspects",
        suspects
          .map(
            (other) =>
              `${other.name} (${pct(member.beliefs.suspicion[other.id] ?? 0)})`,
          )
          .join(", "),
      ),
    );
  }

  const suspectedBy = run.crew
    .filter(
      (other) =>
        other !== member && (other.beliefs.suspicion[member.id] ?? 0) >= 0.2,
    )
    .sort(
      (a, b) =>
        (b.beliefs.suspicion[member.id] ?? 0) -
        (a.beliefs.suspicion[member.id] ?? 0),
    );
  if (suspectedBy.length > 0) {
    personDossierEl.appendChild(
      dossierRow(
        "Suspected by",
        suspectedBy
          .map(
            (other) =>
              `${other.name} (${pct(other.beliefs.suspicion[member.id] ?? 0)})`,
          )
          .join(", "),
      ),
    );
  }
}

const INVOLVES_KEYS = ["with", "accused", "target", "by", "culprit"] as const;

function eventInvolves(event: SimEvent, id: string): boolean {
  if (event.actors.includes(id)) return true;
  for (const key of INVOLVES_KEYS) {
    if (event.data[key] === id) return true;
  }
  return false;
}

/**
 * The person's own recent history, as chronicle sentences: scan the log
 * backwards for events that involve them, then render those events
 * through the one chronicle renderer (seeded with the generation
 * events so names resolve), newest last.
 */
function recentLinesFor(id: string): string[] {
  const events = run.world.events.events;
  const seeds = events.filter(
    (event) =>
      event.type === "ship_generated" || event.type === "crew_generated",
  );
  const matches: SimEvent[] = [];
  for (let i = events.length - 1; i >= 0 && matches.length < 30; i--) {
    const event = events[i] as SimEvent;
    if (eventInvolves(event, id)) matches.push(event);
  }
  matches.reverse();
  const renderer = createChronicleRenderer();
  for (const event of seeds) renderer.push(event);
  const lines: string[] = [];
  for (const event of matches) {
    for (const line of renderer.push(event)) {
      if (line.text !== "") lines.push(line.text);
    }
  }
  return lines.slice(-8);
}

function renderPersonCard(): void {
  if (cardCrewId === null) return;
  const member = crewById(cardCrewId);
  if (member === undefined) {
    closePersonCard();
    return;
  }
  const state = faceStateOf(member);
  const faceCtx = personFace.getContext("2d");
  if (faceCtx !== null) {
    faceCtx.clearRect(0, 0, personFace.width, personFace.height);
    faceCtx.drawImage(getPortraitCanvas(member, state), 0, 0);
  }
  personFace.style.borderColor = departmentOf(member.roleKey).colour;
  personNameEl.textContent = member.name;
  personRoleEl.textContent =
    `${member.title} · ${departmentOf(member.roleKey).name}`;
  const room = run.ship.rooms[member.room];
  const activity = ACTIVITY_WORDS[member.activity] ?? member.activity;
  const deckNo = (deck?.deckOfRoom(member.room) ?? 0) + 1;
  const watchWord = member.watch === "night" ? "Night watch" : "Day watch";
  const blockWord = BLOCK_WORDS[blockAt(member.routine, run.tick)];
  if (member.ashore) {
    const portIndex = run.galaxy.voyage.portIndexAt(run.tick);
    const portName =
      portIndex !== null
        ? run.galaxy.sector.portAt(portIndex).name
        : "the port";
    personWhereEl.textContent =
      `Ashore at ${portName}. ${watchWord} · ${blockWord}.`;
  } else {
    personWhereEl.textContent =
      `Currently ${activity} in the ${room?.name ?? "ship"}, Deck ${deckNo}. ` +
      `${watchWord} · ${blockWord}.`;
  }
  personBioEl.textContent = bioText(member);
  buildDossier(member);
  personRecentEl.replaceChildren();
  const recent = recentLinesFor(member.id);
  if (recent.length === 0) {
    const div = document.createElement("div");
    div.className = "rline";
    div.textContent = "Nothing yet. The voyage is young.";
    personRecentEl.appendChild(div);
  }
  for (const text of recent) {
    const div = document.createElement("div");
    div.className = "rline";
    div.textContent = text;
    personRecentEl.appendChild(div);
  }
}

// ----------------------------------------------------------- port card

const portCard = must<HTMLElement>("port-card");
const portNameEl = must<HTMLElement>("port-name");
const portFactionEl = must<HTMLElement>("port-faction");
const portWhereEl = must<HTMLElement>("port-where");
const portBioEl = must<HTMLElement>("port-bio");
let cardPortIndex: number | null = null;
let lastPortRenderMs = 0;

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function openPortCard(port: Port): void {
  cardPortIndex = port.index;
  closePersonCard();
  closeTrafficCard();
  portCard.hidden = false;
  lastPortRenderMs = 0;
  renderPortCard();
}

function closePortCard(): void {
  cardPortIndex = null;
  portCard.hidden = true;
}

must<HTMLButtonElement>("port-close").addEventListener("click", () => {
  closePortCard();
});

/**
 * The port card: the port's name, who holds it, what it is, and how
 * far it lies from the ship right now. Every fact is sector or
 * voyage state; the viewer writes only the glue, as with the crew.
 */
function renderPortCard(): void {
  if (cardPortIndex === null || starMap === null) return;
  const sector = run.galaxy.sector;
  const voyage = run.galaxy.voyage;
  const port = sector.portAt(cardPortIndex);
  const faction = sector.factionOf(port);
  portNameEl.textContent = port.name;
  const isHome = faction !== null && faction.homePort === port.index;
  portFactionEl.textContent =
    (faction === null ? "Independent" : faction.name) +
    (isHome ? " · faction home port" : "");
  const lightDays = starMap.distanceFromShip(port, run.tick);
  const days = starMap.distanceDaysFromShip(port, run.tick);
  portWhereEl.textContent =
    `${oneDecimal(lightDays)} light-days from the ${run.ship.name} · ` +
    `${oneDecimal(days)} days at cruise`;
  let bio =
    `${port.name} is a ${port.character} port, ` +
    (faction === null
      ? "answering to no faction."
      : `held by the ${faction.name}.`);
  if (port.index === voyage.origin) {
    bio += ` This voyage began here, ${oneDecimal(voyage.legDays)} days under charter for ${voyage.destinationPort.name}.`;
  } else if (port.index === voyage.destination) {
    bio += voyage.inPortAt(run.tick)
      ? " The charter ended here; the ship lies in port, and sails on."
      : ` The charter ends here, ${oneDecimal(voyage.daysOutAt(run.tick))} days out of ${oneDecimal(voyage.legDays)}.`;
  }
  portBioEl.textContent = bio;
}

// --------------------------------------------------------- traffic card

const trafficCard = must<HTMLElement>("traffic-card");
const trafficNameEl = must<HTMLElement>("traffic-name");
const trafficFactionEl = must<HTMLElement>("traffic-faction");
const trafficWhereEl = must<HTMLElement>("traffic-where");
const trafficBioEl = must<HTMLElement>("traffic-bio");
let cardTrafficIndex: number | null = null;
let lastTrafficRenderMs = 0;

function openTrafficCard(ship: TrafficShip): void {
  cardTrafficIndex = ship.index;
  closePersonCard();
  closePortCard();
  starMap?.selectTraffic(ship.index);
  trafficCard.hidden = false;
  lastTrafficRenderMs = 0;
  renderTrafficCard();
}

function closeTrafficCard(): void {
  cardTrafficIndex = null;
  trafficCard.hidden = true;
  starMap?.selectTraffic(null);
}

must<HTMLButtonElement>("traffic-close").addEventListener("click", () => {
  closeTrafficCard();
});

/**
 * The traffic card: who she is, whose registry she sails under,
 * what her business is at this tick, and how far she lies from
 * the witnessed ship. Every fact comes off the run's traffic
 * table and the same position functions the chart draws from.
 */
function renderTrafficCard(): void {
  if (cardTrafficIndex === null || starMap === null) return;
  const sector = run.galaxy.sector;
  const ship = run.galaxy.traffic.ships[cardTrafficIndex] as TrafficShip;
  trafficNameEl.textContent = ship.name;
  trafficFactionEl.textContent =
    ship.type +
    " · " +
    (ship.faction === null
      ? "Independent"
      : `${sector.factionAt(ship.faction).name} registry`);
  const lightDays = starMap.distanceFromPlayer(ship, run.tick);
  const days = starMap.distanceDaysFromPlayer(ship, run.tick);
  trafficWhereEl.textContent =
    `${oneDecimal(lightDays)} light-days from the ${run.ship.name} · ` +
    `${oneDecimal(days)} days at cruise`;
  const leg = ship.legAt(run.tick);
  const berthed = ship.portAt(run.tick);
  let bio: string;
  if (leg !== null) {
    const daysOut = (leg.arriveTick - run.tick) / CONFIG.time.ticksPerDay;
    bio =
      `Bound for ${sector.portAt(leg.to).name}, ` +
      `${oneDecimal(daysOut)} days out on her crossing.`;
  } else if (berthed !== null) {
    bio = `In port at ${sector.portAt(berthed).name}.`;
    const next = ship.legs.find((l) => l.departTick > run.tick);
    bio +=
      next === undefined
        ? " No sailing is on her board."
        : ` She sails for ${sector.portAt(next.to).name} in ` +
          `${oneDecimal((next.departTick - run.tick) / CONFIG.time.ticksPerDay)} days.`;
  } else {
    bio = "Off the chart's reckoning.";
  }
  bio += ` Registered out of ${ship.homePortRef.name}.`;
  trafficBioEl.textContent = bio;
}

/**
 * The exterior's neighbour: the nearest underway contact the
 * traffic system currently holds, as the descriptor the hull
 * view draws from. Berthed contacts cross no sky. Rebuilt only
 * when the contact or its opening tick changes, so the traverse
 * never restarts mid-crossing.
 */
let contactCacheKey = "";
let contactCache: {
  seed: number;
  sinceTick: number;
  dirX: 1 | -1;
} | null = null;

function exteriorContact(): {
  seed: number;
  sinceTick: number;
  dirX: 1 | -1;
} | null {
  const traffic = run.galaxy.traffic;
  const voyage = run.galaxy.voyage;
  const sector = run.galaxy.sector;
  const playerPos = voyage.positionAt(run.tick);
  let best: { ship: TrafficShip; sinceTick: number; dist: number } | null =
    null;
  for (const entry of traffic.activeContacts()) {
    if (entry.ship.legAt(run.tick) === null) continue;
    const pos = entry.ship.positionAt(run.tick);
    const dist = Math.hypot(pos.x - playerPos.x, pos.y - playerPos.y);
    if (best === null || dist < best.dist) {
      best = { ship: entry.ship, sinceTick: entry.sinceTick, dist };
    }
  }
  if (best === null) {
    contactCacheKey = "";
    contactCache = null;
    return null;
  }
  const key = `${best.ship.index}|${best.sinceTick}`;
  if (key !== contactCacheKey) {
    contactCacheKey = key;
    const leg = best.ship.legAt(run.tick);
    const dirX: 1 | -1 =
      leg !== null && sector.portAt(leg.to).x < sector.portAt(leg.from).x
        ? -1
        : 1;
    contactCache = {
      seed: best.ship.index * 7919 + best.sinceTick,
      sinceTick: best.sinceTick,
      dirX,
    };
  }
  return contactCache;
}

// -------------------------------------------------------------- chronicle

/**
 * The event types whose lines always print in highlights mode, on
 * top of every line the chronicle renderer itself flags as drama
 * (its highlight flag: bonds and grudges are in both sets, plus the
 * renderer's trust breaks, snubs, system damage and strain, and
 * tipping gossip). The sittings are named here because the renderer
 * files meal_service as routine aggregation; in the highlights
 * view a shared meal is an event, not bookkeeping. Full mode
 * prints everything, byte-identical, exactly as rendered.
 */
const HIGHLIGHT_TYPES: ReadonlySet<string> = new Set([
  "ship_generated", // firsts: the ship and her crew, named
  "crew_generated",
  "departure",
  "arrival", // the leg's end is a first-class moment, like its start
  "contact", // another ship on the sensors
  "contact_lost",
  "port_traffic", // arrivals and sailings at the port of call
  "weather", // weather turns
  "meal_service", // the shared sittings
  "leisure_game",
  "bond_formed",
  "grudge_formed",
  "accusation",
  "sabotage_committed",
  "system_failed", // the crossing into failure
  "system_repaired",
  "port_call", // every later arrival, plainer than the first
  "resupply", // the manifest: what the port gave
  "shore_leave", // the rotations ashore
  "harbour_news", // what the port is saying
  "rationing_imposed", // the quartermaster's emergency act
  "rationing_lifted",
  "theft", // witnessed hands in the stores
  "stores_low", // the thresholds
  "stores_critical",
  "stores_discrepancy", // the tally that does not tally
  "dead_in_space", // an empty tank, under way
]);

function linePasses(entry: LogLine): boolean {
  if (logMode === "full") return true;
  return entry.line.highlight || HIGHLIGHT_TYPES.has(entry.type);
}

function setLogMode(mode: "highlights" | "full", rebuild = true): void {
  logMode = mode;
  logHighlightsBtn.classList.toggle("active", mode === "highlights");
  logFullBtn.classList.toggle("active", mode === "full");
  logHighlightsBtn.setAttribute("aria-pressed", String(mode === "highlights"));
  logFullBtn.setAttribute("aria-pressed", String(mode === "full"));
  try {
    window.localStorage.setItem("starship.log", mode);
  } catch {
    // Storage can refuse (private windows); the URL still carries it.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("log", mode);
  window.history.replaceState(null, "", url);
  if (rebuild) rebuildChronicleDom();
}

/** The boot-time mode: the URL first, then the stored choice. */
function initialLogMode(params: URLSearchParams): "highlights" | "full" {
  const fromUrl = params.get("log");
  if (fromUrl === "full" || fromUrl === "highlights") return fromUrl;
  try {
    const stored = window.localStorage.getItem("starship.log");
    if (stored === "full" || stored === "highlights") return stored;
  } catch {
    // No storage: the default stands.
  }
  return "highlights";
}

function buildLineDiv(line: ChronicleLine): HTMLDivElement {
  const div = document.createElement("div");
  div.className =
    "line " + (line.highlight ? "hl" : "routine") + (line.text === "" ? " blank" : "");
  if (line.actor !== undefined) div.dataset.actor = line.actor;
  if (selectedCrew !== null && line.actor !== selectedCrew) {
    div.classList.add("dim");
  }
  div.textContent = line.text === "" ? " " : line.text;
  return div;
}

/**
 * Append a batch of lines in one DOM write. Reading scrollHeight
 * forces a synchronous layout of the whole scroll subtree, so the
 * batch (not the line) is the unit that pays for it: the fragment
 * goes in once, the cap trims once, and the scroll settles once.
 * The end state is identical to appending line by line.
 */
function appendLinesToDom(lines: readonly LogLine[]): void {
  const fragment = document.createDocumentFragment();
  let added = 0;
  for (const entry of lines) {
    if (!linePasses(entry)) continue;
    fragment.appendChild(buildLineDiv(entry.line));
    added++;
  }
  if (added === 0) return;
  chronicleEl.appendChild(fragment);
  // Cap the DOM: the full log stays in allLines, only the window is cut.
  while (chronicleEl.childElementCount > MAX_CHRONICLE_DOM_LINES) {
    const first = chronicleEl.firstElementChild;
    if (first === null) break;
    chronicleEl.removeChild(first);
  }
  if (stickToBottom) chronicleEl.scrollTop = chronicleEl.scrollHeight;
}

function rebuildChronicleDom(): void {
  chronicleEl.replaceChildren();
  const visible = allLines.filter((entry) => linePasses(entry));
  appendLinesToDom(visible.slice(-MAX_CHRONICLE_DOM_LINES));
  chronicleEl.scrollTop = chronicleEl.scrollHeight;
}

function refreshLineDims(): void {
  for (const child of chronicleEl.children) {
    const element = child as HTMLElement;
    const actor = element.dataset.actor;
    element.classList.toggle(
      "dim",
      selectedCrew !== null && actor !== selectedCrew,
    );
  }
}

function drainEvents(): void {
  const events = run.world.events.events;
  // Chronicle lines from the whole drain are appended as one batch:
  // the DOM pays for one layout per drain, not one per line.
  const batch: LogLine[] = [];
  while (seenEvents < events.length) {
    const event = events[seenEvents] as (typeof events)[number];
    seenEvents++;
    if (event.type === "weather") {
      const to = event.data.to;
      if (typeof to === "string") weatherName = to;
      // The feel pass: a storm's arrival is staged (nav lights
      // strobe, the deck flinches) at the tick it is displayed.
      if (to === "radiation storm") deck?.stageStorm();
    }
    if (event.type === "work") {
      const actor = event.actors[0];
      const system = event.data.system;
      if (actor !== undefined) {
        workSystemByMember.set(
          actor,
          typeof system === "string" ? system : null,
        );
      }
    }
    if (event.type === "accusation") {
      // Accusations are spoken aloud in-fiction: a speech bubble.
      const actor = event.actors[0];
      if (actor !== undefined) deck?.speech(actor);
    }
    // The feel pass (./staging.ts): the act and the mend are staged
    // in the world at the tick they are displayed, not only written
    // in the chronicle. Condition crossings stage themselves from
    // the deck's per-frame condition sync; these two are moments
    // only the event stream knows.
    if (event.type === "sabotage_committed") {
      const systemId = eventStr(event, "system");
      if (systemId !== "") deck?.stageSabotage(systemId);
    }
    if (event.type === "system_repaired") {
      const systemId = eventStr(event, "system");
      if (systemId !== "") deck?.stageRepaired(systemId);
    }
    // Staging the mundane: a table game seats its players on the
    // deck for the game's span, and a traveller's hands are read
    // off their move events (the derivations live above).
    if (event.type === "leisure_game") {
      const participants = event.data.participants;
      if (Array.isArray(participants)) {
        activeGames.push({
          room: eventNum(event, "room"),
          participants: participants.filter(
            (p): p is string => typeof p === "string",
          ),
          untilTick: event.tick + GAME_TICKS,
        });
        rebuildGameSeats();
      }
    }
    if (event.type === "move") {
      const actor = event.actors[0];
      if (actor !== undefined) updateCarry(actor, event);
    }
    feedAlert(event);
    for (const line of renderer.push(event)) {
      const entry: LogLine = { line, type: event.type };
      allLines.push(entry);
      batch.push(entry);
    }
  }
  appendLinesToDom(batch);
}

// ---------------------------------------------------------------- voyage

/**
 * The Voyage of the Day banner: a chip naming today's ship when this
 * voyage is the daily one, and a button that starts today's seed when
 * it is not. The rotation itself lives in ./daily.ts; the engine never
 * hears about it.
 */
function refreshDailyBanner(): void {
  if (currentSeed === dailySeed()) {
    dailyText.textContent =
      `★ Voyage of the Day: the ${run.ship.name} — the same ship for everyone`;
    dailyBtn.hidden = true;
  } else {
    dailyText.textContent = "Today's voyage is a different ship.";
    dailyBtn.hidden = false;
  }
}

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 6000);
}

/** Start today's seed as the daily voyage, with its greeting toast. */
function startDailyVoyage(): void {
  startVoyage(dailySeed(), { daily: true });
  showToast(
    `Voyage of the day: ${run.ship.name}. ` +
      "Everyone who opens today's voyage gets this same ship.",
  );
}

function startVoyage(seed: number, opts?: { daily?: boolean }): void {
  currentSeed = seed;
  run = createRun({ seed });
  renderer = createChronicleRenderer();
  seenEvents = 0;
  allLines = [];
  selectedCrew = null;
  closePersonCard();
  accumulator = 0;
  weatherName = CONFIG.weather.states[0] ?? "calm";
  workSystemByMember.clear();
  activeGames.length = 0;
  gameSeatByMember.clear();
  carryByMember.clear();
  alertStack.reset();
  chronicleEl.replaceChildren();
  shipNameEl.textContent = run.ship.name;
  seedInput.value = String(seed);
  buildDeck();
  buildCrewPanel();
  drainEvents(); // ship_generated and crew_generated header lines
  updateHeader();
  updateSlowUi();
  refreshDailyBanner();
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(seed));
  // The daily flag describes how this voyage was chosen: it is set by a
  // daily start and cleared by any hand-picked seed, so a reload never
  // silently swaps a chosen ship for today's.
  if (opts?.daily === true) url.searchParams.set("daily", "1");
  else url.searchParams.delete("daily");
  window.history.replaceState(null, "", url);
}

// ------------------------------------------------------------------ loop

function shipClock(tick: number): { day: number; time: string } {
  const perDay = CONFIG.time.ticksPerDay;
  const day = Math.floor(tick / perDay) + 1;
  const minutes = (tick % perDay) * CONFIG.time.minutesPerTick;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return { day, time: `${hh}:${mm}` };
}

/** Sun and moon for the header watch indicator, pixel-drawn like all the art. */
const SUN_ROWS = [
  "....o....",
  ".o..o..o.",
  "....o....",
  "...yyy...",
  "..yyyyy..",
  "...yyy...",
  "....o....",
  ".o..o..o.",
  "....o....",
] as const;
const MOON_ROWS = [
  "...ccc...",
  "..ccc....",
  ".ccc.....",
  ".cc......",
  ".cc......",
  ".cc......",
  ".ccc.....",
  "..ccc....",
  "...ccc...",
] as const;
const WATCH_ICONS: Record<WatchName, SpriteDef> = {
  "Day watch": { rows: SUN_ROWS, pal: { o: "#c47b2a", y: "#ffd76a" } },
  "Dawn watch": { rows: SUN_ROWS, pal: { o: "#b87f36", y: "#f7cf7d" } },
  "Evening watch": { rows: MOON_ROWS, pal: { c: "#e8c98a" } },
  "Night watch": { rows: MOON_ROWS, pal: { c: "#aebfe0" } },
};
let shownWatch: WatchName | null = null;

function paintWatchIcon(watch: WatchName): void {
  const ctx = watchIcon.getContext("2d");
  if (ctx === null) return;
  ctx.clearRect(0, 0, watchIcon.width, watchIcon.height);
  ctx.drawImage(spriteCanvas(WATCH_ICONS[watch]), 0, 0);
}

let shownTick = -1;
function updateHeader(): void {
  if (run.tick === shownTick) return;
  shownTick = run.tick;
  const clock = shipClock(run.tick);
  clockDayEl.textContent = String(clock.day);
  clockTimeEl.textContent = clock.time;
  hashEl.textContent = run.hash().slice(0, 10);
  eventCountEl.textContent = String(run.world.events.size);
  const watch = watchName(
    (run.tick % CONFIG.time.ticksPerDay) * CONFIG.time.minutesPerTick,
  );
  if (watch !== shownWatch) {
    shownWatch = watch;
    watchLabelEl.textContent = watch;
    paintWatchIcon(watch);
  }
}

// ------------------------------------------------------- ship's day

/**
 * The printed beats of the ship's day, for the ribbon's next-beat
 * reading: the day watch's schedule, which is the ship's rhythm.
 */
const DAY_BEATS: ReadonlyArray<{ hour: number; label: string }> = [
  { hour: 6, label: "Wake" },
  { hour: 7, label: "Breakfast" },
  { hour: 8, label: "Work" },
  { hour: 12, label: "Midday break" },
  { hour: 13, label: "Work" },
  { hour: 18, label: "Evening meal" },
  { hour: 19, label: "Free time" },
  { hour: 22, label: "Lights-out" },
];

const BLOCK_LABELS: Record<BlockKind, string> = {
  sleep: "Sleep",
  work: "Work",
  meal: "At table",
  free: "Free time",
};

let lastRibbonText = "";

/**
 * The ship's day ribbon: the watch phase, the block most of the
 * crew are in right now, and the next beat of the day with its
 * time. It teaches the rhythm the deck is keeping; it is written
 * only when the reading changes, on the slow-UI cadence.
 */
function updateRibbon(): void {
  const tick = run.tick;
  const dayMinutes =
    (tick % CONFIG.time.ticksPerDay) * CONFIG.time.minutesPerTick;
  const watch = watchName(dayMinutes);
  const counts = new Map<BlockKind, number>();
  let nightOnDuty = 0;
  for (const member of run.crew) {
    const block = blockAt(member.routine, tick);
    counts.set(block, (counts.get(block) ?? 0) + 1);
    if (member.watch === "night" && block === "work") nightOnDuty++;
  }
  let majority: BlockKind = "free";
  let best = -1;
  for (const kind of ["sleep", "meal", "work", "free"] as const) {
    const n = counts.get(kind) ?? 0;
    if (n > best) {
      best = n;
      majority = kind;
    }
  }
  let nowLabel: string;
  if (majority === "meal") {
    nowLabel =
      mealWindowAt(tick) === "breakfast" ? "Breakfast" : "Evening meal";
  } else if (majority === "sleep" && nightOnDuty > 0) {
    // Most hands are asleep and the night pair holds the ship: the
    // ship's posture is the night watch, not merely sleep.
    nowLabel = "Night watch";
  } else {
    nowLabel = BLOCK_LABELS[majority];
  }
  let beat = DAY_BEATS[0] as (typeof DAY_BEATS)[number];
  for (const candidate of DAY_BEATS) {
    if (candidate.hour * 60 > dayMinutes) {
      beat = candidate;
      break;
    }
  }
  const beatTime = `${String(beat.hour).padStart(2, "0")}:00`;
  const text = `${watch} · ${nowLabel} · Next: ${beat.label} ${beatTime}`;
  if (text !== lastRibbonText) {
    lastRibbonText = text;
    ribbonEl.textContent = text;
  }
}

let lastRouteText = "";

/**
 * The header's route readout: the leg being sailed and what
 * remains of it, or the port being lived in, with the stay's day
 * and the sailing time. Written only when it changes, on the
 * slow-UI cadence.
 */
function updateRoute(): void {
  const voyage = run.galaxy.voyage;
  const sector = run.galaxy.sector;
  const tick = run.tick;
  const tpd = CONFIG.time.ticksPerDay;
  const vt = voyage.voyageTimeAt(tick);
  const stay = voyage.stayAt(tick);
  let text: string;
  if (stay !== null) {
    const port = sector.portAt(stay.port);
    const dayOfStay = Math.floor((vt - stay.arriveTick) / tpd) + 1;
    const stayDays = Math.round((stay.departTick - stay.arriveTick) / tpd);
    const sails = shipClock(Math.ceil(tick + (stay.departTick - vt)));
    text =
      `In port at ${port.name} · day ${dayOfStay} of ${stayDays} · ` +
      `sails day ${sails.day}, ${sails.time}`;
  } else {
    const leg = voyage.currentLegAt(tick);
    if (leg !== null) {
      const from = sector.portAt(leg.from).name;
      const to = sector.portAt(leg.to).name;
      const out = oneDecimal(voyage.daysOutAt(tick));
      const total = oneDecimal((leg.arriveTick - leg.departTick) / tpd);
      const toGo = oneDecimal((leg.arriveTick - vt) / tpd);
      text = `${from} → ${to} · ${out} of ${total} days out · ${toGo} to go`;
    } else {
      const portIndex = voyage.portIndexAt(tick);
      text =
        portIndex !== null
          ? `In port at ${sector.portAt(portIndex).name}`
          : "";
    }
  }
  if (text !== lastRouteText) {
    lastRouteText = text;
    routeEl.textContent = text;
  }
}

// ------------------------------------------------------------- stores

const STRIP_LABELS: Record<StoreKey, string> = {
  food: "Food",
  water: "Water",
  oxygen: "O2 margin",
  fuel: "Fuel",
  parts: "Parts",
};

interface StoreCell {
  fill: HTMLDivElement;
  value: HTMLSpanElement;
  sig: string;
}

const storeCells = new Map<StoreKey, StoreCell>();
{
  const strip = must<HTMLElement>("stores-strip");
  for (const key of STORE_KEYS) {
    const cell = document.createElement("div");
    cell.className = "store-cell";
    const label = document.createElement("span");
    label.className = "slabel";
    label.textContent = STRIP_LABELS[key];
    const bar = document.createElement("div");
    bar.className = "sbar";
    const fill = document.createElement("div");
    bar.appendChild(fill);
    const value = document.createElement("span");
    value.className = "sval";
    cell.append(label, bar, value);
    strip.appendChild(cell);
    storeCells.set(key, { fill, value, sig: "" });
  }
}

/**
 * The stores strip: five slim bars with whole-day counts and a
 * trend arrow from the standing net flow, banded by the alert
 * tiers. Write-on-change, on the slow cadence, like the rest of
 * the header.
 */
function updateStoresStrip(): void {
  for (const key of STORE_KEYS) {
    const cell = storeCells.get(key);
    if (cell === undefined) continue;
    const store = run.stores.byKey[key];
    const days = daysOf(run.stores, key);
    const whole = Math.floor(days);
    const net = run.stores.netMilliPerDay[key];
    const arrow = net > 50 ? "↑" : net < -50 ? "↓" : "→";
    const band =
      days < CONFIG.stores.criticalDays
        ? "crit"
        : days < CONFIG.stores.lowDays
          ? "warn"
          : "";
    const pct = Math.round((store.qtyMilli / store.capMilli) * 1000) / 10;
    const sig = `${whole}|${arrow}|${band}|${pct}`;
    if (cell.sig === sig) continue;
    cell.sig = sig;
    cell.fill.style.width = `${pct}%`;
    cell.fill.className = band;
    cell.value.textContent = `${whole}d ${arrow}`;
  }
}

function updateSlowUi(): void {
  weatherNameEl.textContent = weatherName;
  weatherBanner.classList.toggle("storm", weatherName === "radiation storm");
  updateRibbon();
  updateRoute();
  updateStoresStrip();
  syncAlerts();

  if (cardPortIndex !== null && performance.now() - lastPortRenderMs > 1000) {
    lastPortRenderMs = performance.now();
    renderPortCard();
  }

  if (
    cardTrafficIndex !== null &&
    performance.now() - lastTrafficRenderMs > 1000
  ) {
    lastTrafficRenderMs = performance.now();
    renderTrafficCard();
  }

  for (const member of run.crew) {
    const ui = crewUi.get(member.id);
    if (ui === undefined) continue;
    const roleText = member.ashore
      ? `${member.title} · Ashore`
      : member.title;
    if (ui.roleEl.textContent !== roleText) {
      ui.roleEl.textContent = roleText;
    }
    for (const key of NEED_KEYS) {
      const fill = ui.bars.get(key);
      if (fill === undefined) continue;
      const value = member.needs[key];
      // The bars are written only when the rounded value or its
      // band changes: the same discipline the faces already use,
      // so a steady pass costs no style recalculation at all.
      const pct = Math.round(value * 100);
      const band = value < 0.25 ? "low" : value < 0.5 ? "mid" : "";
      const sig = `${pct}|${band}`;
      if (fill.dataset.sig !== sig) {
        fill.dataset.sig = sig;
        fill.style.width = `${pct}%`;
        fill.className = band;
      }
    }
    // Faces repaint only when the state that shows on them changes.
    const state = faceStateOf(member);
    const sig = stateSignature(state);
    if (ui.sig !== sig) {
      ui.sig = sig;
      const faceCtx = ui.face.getContext("2d");
      if (faceCtx !== null) {
        faceCtx.clearRect(0, 0, ui.face.width, ui.face.height);
        faceCtx.drawImage(getPortraitCanvas(member, state), 0, 0);
      }
    }
  }

  if (cardCrewId !== null && performance.now() - lastCardRenderMs > 1000) {
    lastCardRenderMs = performance.now();
    renderPersonCard();
  }
}

function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  const dtMs = lastFrameMs === 0 ? 0 : nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  if (playing) {
    const speed = SPEEDS[speedIndex] as (typeof SPEEDS)[number];
    accumulator += (dtMs / 1000) * speed.ticksPerSecond;
    let steps = Math.floor(accumulator);
    if (steps > MAX_TICKS_PER_FRAME) {
      // The tab slept or lagged: take a bounded step and drop the rest of
      // the backlog. The voyage resumes from now, not from the backlog.
      steps = MAX_TICKS_PER_FRAME;
      accumulator = 0;
    } else {
      accumulator -= steps;
    }
    if (steps > 0) {
      for (let i = 0; i < steps; i++) run.step();
      drainEvents();
      updateHeader();
    }
  }

  // Alerts expire and burn down their lifetime bars on the frame
  // clock, not the sim clock: they are wall-time news.
  alertView.frame(nowMs);

  // The deck: bodies glide, work, spark, and think, on canvas.
  // While paused, everything left moving is a slow sine (drift,
  // blink, sway), so the deck redraws at about 15 fps and the frame
  // costs a quarter of itself; the deck is handed the true elapsed
  // time since its last paint, so nothing animates slower, only
  // less often. Playing rates are untouched.
  const deckDue = playing || nowMs - lastDeckMs >= 66;
  if (mapActive && starMap !== null) {
    // The chart: one blit and the ship's marker per paint, on the
    // same cadence as the deck (full rate playing, ~15 fps paused,
    // since all that moves then is a pulse). lastDeckMs advances so
    // the deck resumes without a stale clock when the witness
    // steps back inside.
    if (deckDue) {
      lastDeckMs = nowMs;
      starMap.frame(run.tick, nowMs);
    }
  } else if (deck !== null && deckDue) {
    pruneGames();
    const deckDtMs = lastDeckMs === 0 ? dtMs : nowMs - lastDeckMs;
    lastDeckMs = nowMs;
    const tickMs = playing
      ? 1000 / (SPEEDS[speedIndex] as (typeof SPEEDS)[number]).ticksPerSecond
      : Number.POSITIVE_INFINITY;
    // Crew ashore at a port call are not on the deck at all: their
    // dots, their windows, and their minimap marks stay at the port.
    const aboard = run.crew.filter((m) => !m.ashore);
    deck.frame(aboard, {
      now: nowMs,
      dtMs: deckDtMs,
      tickMs,
      snap: speedIndex >= 4,
      selectedId: selectedCrew,
      workSystem: workSystemByMember,
      gameSeat: gameSeatByMember,
      carry: carryByMember,
      dayMinutes:
        (run.tick % CONFIG.time.ticksPerDay) * CONFIG.time.minutesPerTick,
      storm: weatherName === "radiation storm",
      meal: mealWindowAt(run.tick),
      contact: exteriorContact(),
      tick: run.tick,
      speedTps: playing
        ? (SPEEDS[speedIndex] as (typeof SPEEDS)[number]).ticksPerSecond
        : 0,
    });
  }


  if (nowMs - lastSlowUiMs > 200) {
    lastSlowUiMs = nowMs;
    updateSlowUi();
    updateHeader();
  }

  // The minimap redraws at a throttled rate: it is a glance, not a
  // second simulation, and its frame cost stays negligible.
  if (
    minimap !== null &&
    deck !== null &&
    !mapActive &&
    nowMs - lastMinimapMs > 250
  ) {
    lastMinimapMs = nowMs;
    const aboard = run.crew.filter((m) => !m.ashore);
    minimap.draw(
      run.ship,
      aboard,
      deck.minimapSnapshot(aboard),
      deck.visibleDeck,
      nowMs,
    );
  }
}

// -------------------------------------------------------------- controls

function setPlaying(next: boolean): void {
  playing = next;
  playBtn.textContent = playing ? "Pause" : "Play";
}

function setSpeed(index: number): void {
  speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, index));
  const speed = SPEEDS[speedIndex] as (typeof SPEEDS)[number];
  speedReadoutEl.textContent = speed.label;
  [...speedGroup.children].forEach((child, i) => {
    child.classList.toggle("active", i === speedIndex);
  });
}

SPEEDS.forEach((speed, i) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = speed.label;
  button.addEventListener("click", () => setSpeed(i));
  speedGroup.appendChild(button);
});

playBtn.addEventListener("click", () => setPlaying(!playing));
dailyBtn.addEventListener("click", () => startDailyVoyage());
deck1Btn.addEventListener("click", () => setViewDeck(0));
deck2Btn.addEventListener("click", () => setViewDeck(1));
exteriorBtn.addEventListener("click", () => setViewExterior());
mapBtn.addEventListener("click", () => setViewMap());
minimapCanvas.addEventListener("click", (event) => {
  if (minimap === null) return;
  const rect = minimapCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const x = (event.clientX - rect.left) * (minimapCanvas.width / rect.width);
  const y = (event.clientY - rect.top) * (minimapCanvas.height / rect.height);
  const target = minimap.deckAt(x, y);
  if (target !== null) setViewDeck(target);
});
deckCanvas.addEventListener("click", (event) => {
  const rect = deckCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const x = (event.clientX - rect.left) * (deckCanvas.width / rect.width);
  const y = (event.clientY - rect.top) * (deckCanvas.height / rect.height);
  if (mapActive && starMap !== null) {
    // On the chart, a tap names a port or another ship (its card),
    // the witnessed ship (nothing to open: the header carries her
    // state), or empty space (close).
    const hit = starMap.pick(x, y, run.tick);
    if (hit !== null && hit.kind === "port") openPortCard(hit.port);
    else if (hit !== null && hit.kind === "traffic") openTrafficCard(hit.ship);
    else {
      closePortCard();
      closeTrafficCard();
    }
    return;
  }
  if (deck !== null && deck.exteriorActive) {
    // Outside, a tap names a part of the hull and goes to its deck.
    const target = deck.pickSection(x, y);
    if (target !== null) setViewDeck(target);
    return;
  }
  const id = deck?.pick(x, y);
  if (id !== null && id !== undefined) tapCrew(id);
});
must<HTMLButtonElement>("new-voyage-btn").addEventListener("click", () => {
  const seed = Number(seedInput.value);
  startVoyage(Number.isFinite(seed) ? Math.trunc(seed) : 42);
});
must<HTMLButtonElement>("random-btn").addEventListener("click", () => {
  startVoyage(Math.floor(Math.random() * 1_000_000));
});
logHighlightsBtn.addEventListener("click", () => setLogMode("highlights"));
logFullBtn.addEventListener("click", () => setLogMode("full"));
chronicleEl.addEventListener("scroll", () => {
  stickToBottom =
    chronicleEl.scrollHeight - chronicleEl.scrollTop - chronicleEl.clientHeight <
    40;
});

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    setPlaying(!playing);
  } else if (event.key === "Escape") {
    selectCrew(null);
    closePersonCard();
    closePortCard();
    closeTrafficCard();
  } else if (event.key >= "1" && event.key <= "6") {
    setSpeed(Number(event.key) - 1);
  } else if (event.key === "7" || event.key === "[") {
    setViewDeck(0);
  } else if (event.key === "8" || event.key === "]") {
    setViewDeck(1);
  } else if (event.key === "9") {
    setViewExterior();
  } else if (event.key === "0" || event.key === "m" || event.key === "M") {
    setViewMap();
  }
});

// ------------------------------------------------------------------ boot

const params = new URLSearchParams(window.location.search);
setLogMode(initialLogMode(params), false);
setSpeed(speedIndex);
setPlaying(true);
if (params.get("daily") === "1") {
  // ?daily=1 wins over ?seed=: it names a day, not a ship, and the ship
  // it names changes at UTC midnight.
  startDailyVoyage();
} else {
  const initialSeed = Number(params.get("seed") ?? "42") || 42;
  startVoyage(initialSeed);
}
requestAnimationFrame(frame);
