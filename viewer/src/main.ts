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
import { chatterText } from "../../src/perception/speech.ts";
import { CONFIG } from "../../src/scenario/config.ts";
import { DUTY_DEFS } from "../../src/world/duties.ts";
import { bandOf } from "../../src/world/factions.ts";
import { createRun, type RunContext } from "../../src/sim.ts";
import { canRepair, type CrewMember } from "../../src/entities/crew.ts";
import {
  believedSkill,
  capFor,
  DISCIPLINES,
  DISCIPLINE_LABEL,
  DISCIPLINE_SHORT,
  levelOf,
  levelProgress,
  topDiscipline,
} from "../../src/world/skills.ts";
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
  hash01,
  stateSignature,
} from "./faces.ts";
import { FeedBuilder, type FeedItem, type FeedNames } from "./feed.ts";
import {
  ALERT_KIND_DEFS,
  AlertStack,
  AlertStackView,
  loadPausePrefs,
  savePausePrefs,
  type AlertItem,
  type PausePrefs,
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
/** The Log tab's face: the Scuttlebutt feed first, the chronicle behind it. */
let logView: "feed" | "chronicle" = "feed";
const feedItems: FeedItem[] = [];
let feedDirty = false;
let feedBuilder = new FeedBuilder();
let weatherName = "calm";
let stickToBottom = true;
/** Which sheet the bottom sheet shows, or null while it is closed. */
let sheetTab: string | null = null;
/** View toggles from the menu row, persisted like the log mode. */
let showWear = true;
let showBubbles = true;
/** Pause-on preferences for alert kinds (./alerts.ts). */
const pausePrefs: PausePrefs = loadPausePrefs();

// ------------------------------------------------------------ dom handles

const shipNameEl = must<HTMLElement>("ship-name");
const stripLineEl = must<HTMLElement>("strip-line");
const watchIcon = must<HTMLCanvasElement>("watch-icon");
const hashEl = must<HTMLElement>("hash");
const eventCountEl = must<HTMLElement>("event-count");
const playBtn = must<HTMLButtonElement>("play-btn");
const speedBtn = must<HTMLButtonElement>("speed-btn");
const menuBtn = must<HTMLButtonElement>("menu-btn");
const menuRow = must<HTMLElement>("menu-row");
const toggleWearBtn = must<HTMLButtonElement>("toggle-wear");
const toggleBubblesBtn = must<HTMLButtonElement>("toggle-bubbles");
const dailyText = must<HTMLElement>("daily-text");
const dailyBtn = must<HTMLButtonElement>("daily-btn");
const toastEl = must<HTMLElement>("toast");
const seedInput = must<HTMLInputElement>("seed-input");
const alertStackEl = must<HTMLElement>("alert-stack");
const deckCanvas = must<HTMLCanvasElement>("ship-canvas");
const decksBtn = must<HTMLButtonElement>("decks-btn");
const exteriorBtn = must<HTMLButtonElement>("exterior-btn");
const mapBtn = must<HTMLButtonElement>("map-btn");
const sceneChipEl = must<HTMLElement>("scene-chip");
const routeEl = must<HTMLElement>("route-readout");
const minimapCanvas = must<HTMLCanvasElement>("minimap-canvas");
const crewPanel = must<HTMLElement>("crew-panel");
const chronicleEl = must<HTMLElement>("chronicle");
const logHighlightsBtn = must<HTMLButtonElement>("log-highlights-btn");
const logFullBtn = must<HTMLButtonElement>("log-full-btn");
const feedEl = must<HTMLElement>("feed");
const logViewFeedBtn = must<HTMLButtonElement>("log-view-feed-btn");
const logViewChronicleBtn = must<HTMLButtonElement>("log-view-chronicle-btn");
const logDetailToggle = must<HTMLElement>("log-detail-toggle");
const sheetEl = must<HTMLElement>("sheet");
const sheetBodyEl = must<HTMLElement>("sheet-body");
const sheetTitleEl = must<HTMLElement>("sheet-title");
const councilSeatsEl = must<HTMLElement>("council-seats");
const councilListEl = must<HTMLElement>("council-list");
const councilDetailEl = must<HTMLElement>("council-detail");
const councilTranscriptEl = must<HTMLElement>("council-transcript");
const alertPrefsEl = must<HTMLElement>("alert-prefs");
const tabButtons = new Map<string, HTMLButtonElement>(
  ["crew", "council", "log", "ship", "map"].map((tab) => [
    tab,
    must<HTMLButtonElement>(`tab-${tab}`),
  ]),
);
const sheetSections = new Map<string, HTMLElement>(
  ["crew", "council", "log", "ship"].map((tab) => {
    const el = document.querySelector<HTMLElement>(
      `#sheet-body section[data-sheet="${tab}"]`,
    );
    if (el === null) throw new Error(`viewer: no sheet section ${tab}`);
    return [tab, el] as [string, HTMLElement];
  }),
);

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

/** A council sitting in progress, from its council_convened event. */
interface ActiveSitting {
  room: number;
  /** The sitting's business ("inquiry", "course", ...). */
  kind: string;
  /** Officer ids in seat order (the convened record's own order). */
  seats: Array<{ member: string; seat: string }>;
  accused: string | null;
  untilTick: number;
}

/**
 * A sitting is an instant in the engine and a set-piece on the
 * deck: the officers hold the mess for about three hours of ship
 * time while the chronicle prints the sitting in full.
 */
const SITTING_TICKS = (CONFIG.time.ticksPerDay / 24) * 3;
const activeSittings: ActiveSitting[] = [];
/** Officer id to their chair at the sitting's table. */
const councilSeatByMember = new Map<string, { room: number; seat: number }>();
/** Member id to their standing slot at the open end (0 accused, 1 security). */
const councilStandByMember = new Map<string, { room: number; slot: number }>();

function rebuildCouncilSeats(): void {
  councilSeatByMember.clear();
  councilStandByMember.clear();
  for (const sitting of activeSittings) {
    sitting.seats.forEach((entry, seat) => {
      // The security chief does not sit when there is an accused
      // to stand beside: they take the open end with them.
      if (
        sitting.accused !== null &&
        entry.seat === "security chief" &&
        entry.member !== sitting.accused
      ) {
        councilStandByMember.set(entry.member, {
          room: sitting.room,
          slot: 1,
        });
        return;
      }
      councilSeatByMember.set(entry.member, { room: sitting.room, seat });
    });
    if (sitting.accused !== null) {
      councilStandByMember.set(sitting.accused, {
        room: sitting.room,
        slot: 0,
      });
    }
  }
}

/** Retire finished sittings; called on the frame clock. */
function pruneSittings(): void {
  if (activeSittings.length === 0) return;
  let changed = false;
  for (let i = activeSittings.length - 1; i >= 0; i--) {
    if (run.tick >= (activeSittings[i] as ActiveSitting).untilTick) {
      activeSittings.splice(i, 1);
      changed = true;
    }
  }
  if (changed) rebuildCouncilSeats();
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
  // The engine's own repair test (affinity plus discipline
  // level), applied to the move's destination: an engineer
  // heading to a failed system carries the tools for it.
  const errand = run.ship.systems.find(
    (s) => s.room === towards && (s.damaged || s.failed) && canRepair(member, s),
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
  document.body.dataset.view = "deck";
  refreshDeckButtons();
  refreshTabStates();
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
  document.body.dataset.view = "deck";
  refreshDeckButtons();
  refreshTabStates();
}

/** Step outside: the ship from the hull, windows lit by the life inside. */
function setViewExterior(): void {
  if (deck === null) return;
  mapActive = false;
  closePortCard();
  closeTrafficCard();
  deck.setExterior(true);
  document.body.dataset.view = "exterior";
  refreshDeckButtons();
  refreshTabStates();
}

/** Open the chart: the sector, its ports, and the route being sailed. */
function setViewMap(): void {
  if (deck === null) return;
  deck.setExterior(false);
  mapActive = true;
  document.body.dataset.view = "map";
  refreshDeckButtons();
  refreshTabStates();
}

/**
 * Scale the ship canvas up to fill the stage, in whole multiples:
 * the art is pixels, and an integer scale keeps every pixel the
 * same size on a big screen instead of the ship sitting small in
 * a sea of black. Below 1x the stylesheet's max-width/max-height
 * shrink-to-fit takes over, as it always has on small screens.
 */
function fitShipCanvas(): void {
  const stage = deckCanvas.parentElement;
  if (stage === null || deckCanvas.width === 0) return;
  const scale = Math.min(
    stage.clientWidth / deckCanvas.width,
    stage.clientHeight / deckCanvas.height,
  );
  if (scale >= 1) {
    const s = Math.floor(scale);
    deckCanvas.style.width = `${deckCanvas.width * s}px`;
    deckCanvas.style.height = `${deckCanvas.height * s}px`;
  } else {
    deckCanvas.style.width = "";
    deckCanvas.style.height = "";
  }
}

if (typeof ResizeObserver !== "undefined") {
  const stageEl = deckCanvas.parentElement;
  if (stageEl !== null) {
    new ResizeObserver(() => fitShipCanvas()).observe(stageEl);
  }
}

// ------------------------------------------------------------------ sheet

/**
 * One bottom sheet holds every panel (the reference viewers' fold:
 * the stage stays the screen, panels visit it). The tab bar opens
 * a sheet; the Map tab is not a sheet at all, it changes the stage.
 * Tapping the open tab again, or the sheet's close button, folds
 * the sheet away. Person and port cards stay floating overlays.
 */
const TAB_TITLES: Record<string, string> = {
  crew: "Crew",
  council: "Council",
  log: "Scuttlebutt",
  ship: "Ship",
  map: "Map",
};

function refreshTabStates(): void {
  for (const [tab, button] of tabButtons) {
    button.classList.toggle(
      "on",
      tab === "map"
        ? sheetTab === null && mapActive
        : sheetTab === tab,
    );
  }
}

function openSheet(tab: string): void {
  if (tab === "map") {
    closeSheet();
    setViewMap();
    return;
  }
  sheetTab = tab;
  document.body.dataset.sheet = tab;
  sheetEl.classList.remove("closed");
  sheetTitleEl.textContent = TAB_TITLES[tab] ?? tab;
  for (const [key, section] of sheetSections) {
    section.hidden = key !== tab;
  }
  // Each panel opens at its top; the log opens at its foot when
  // it is riding the bottom, as it did in its own scroller.
  if (tab === "log" && stickToBottom && logView === "chronicle") {
    sheetBodyEl.scrollTop = sheetBodyEl.scrollHeight;
  } else {
    sheetBodyEl.scrollTop = 0;
  }
  if (tab === "council") showSittingList();
  refreshTabStates();
}

function closeSheet(): void {
  sheetTab = null;
  delete document.body.dataset.sheet;
  sheetEl.classList.add("closed");
  refreshTabStates();
}

function toggleSheet(tab: string): void {
  if (tab !== "map" && sheetTab === tab) closeSheet();
  else openSheet(tab);
}

function refreshDeckButtons(): void {
  const outside = (deck?.exteriorActive ?? false) && !mapActive;
  decksBtn.classList.toggle("active", !outside && !mapActive);
  exteriorBtn.classList.toggle("active", outside);
  mapBtn.classList.toggle("active", mapActive);
  fitShipCanvas();
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
 * Whitelisted alerts over the deck (./alerts.ts). Only the kinds
 * on the whitelist are ever posted from here; everything else
 * the chronicle speaks stays in the chronicle. Two feeds, both
 * from state the viewer already holds: the event stream (in
 * drainEvents) for moments, and the per-frame system conditions
 * plus voyage transitions (in updateSlowUi) for states. Nothing
 * is invented here; the texts mirror the chronicle's own
 * sentences.
 */
const alertStack = new AlertStack();
const alertView = new AlertStackView(alertStackEl, alertStack, (item) => {
  focusAlert(item);
});
alertStack.onRaise = (kind) => {
  if (pausePrefs[kind]) setPlaying(false);
};

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

/**
 * Whether a board's finding matches the truth it judged, on the
 * chronicle's own reckoning (the hand, and for a death the
 * cause). Null where the sitting's record carries no truth to
 * tell. Watcher knowledge only: it colours a card and a chip,
 * and never reaches the crew.
 */
function findingWasRight(event: SimEvent): boolean | null {
  if (event.data.truthKnown !== true) return null;
  const accused = eventStr(event, "accused");
  const truthCulprit = eventStr(event, "truthCulprit");
  const truthCause = eventStr(event, "truthCause");
  const victim = eventStr(event, "victim");
  const culpritRight =
    accused === ""
      ? truthCulprit === ""
      : event.data.convicted === true
        ? accused === truthCulprit
        : accused !== truthCulprit;
  const causeWrong =
    victim !== "" && truthCause !== "" && eventStr(event, "cause") !== truthCause;
  return culpritRight && !causeWrong;
}

/** Tick of the last storm card: landfall flicker is one storm. */
let lastStormToastTick = Number.NEGATIVE_INFINITY;

/** Moments from the event stream: the whitelist, and nothing else. */
function feedAlert(event: SimEvent): void {
  const now = performance.now();
  const actor = event.actors[0];
  switch (event.type) {
    case "death": {
      if (actor === undefined) break;
      alertStack.post(
        {
          kind: "death",
          subject: actor,
          text: `${personName(actor)} has died.`,
          focus: { personId: actor },
        },
        now,
      );
      break;
    }
    case "council_convened": {
      // Only a board of inquiry opens with a card; discipline,
      // rationing, course and the rest convene quietly.
      if (eventStr(event, "kind") !== "inquiry") break;
      const accused = eventStr(event, "accused");
      alertStack.post(
        {
          kind: "inquiry",
          subject: accused !== "" ? accused : `tick${event.tick}`,
          text:
            accused !== ""
              ? `Inquiry: ${personName(accused)} is called before the board.`
              : "Inquiry: the board convenes.",
          focus: accused !== "" ? { personId: accused } : {},
        },
        now,
      );
      break;
    }
    case "council_finding": {
      const kind = eventStr(event, "kind");
      if (kind !== "inquiry" && kind !== "discipline") break;
      const accused = eventStr(event, "accused");
      if (accused === "") break;
      const convicted = event.data.convicted === true;
      // A sabotage finding the truth confirms is the one drama
      // that outranks the plain verdict, and takes its card.
      const confirmedSabotage =
        convicted &&
        eventStr(event, "cause") === "sabotage" &&
        findingWasRight(event) === true;
      alertStack.post(
        {
          kind: confirmedSabotage ? "sabotage" : "verdict",
          subject: accused,
          text: confirmedSabotage
            ? `Sabotage confirmed: ${personName(accused)}.`
            : convicted
              ? `Verdict: ${personName(accused)} is found culpable.`
              : `Verdict: ${personName(accused)} is acquitted.`,
          focus: { personId: accused },
        },
        now,
      );
      break;
    }
    case "captain_relieved": {
      const member = eventStr(event, "member");
      alertStack.post(
        {
          kind: "relief",
          subject: member,
          text: `${personName(member)} has been relieved of command.`,
          focus: { personId: member },
        },
        now,
      );
      break;
    }
    case "ship_lost": {
      alertStack.post(
        {
          kind: "ship-lost",
          subject: "ship",
          text: `The ${run.ship.name} is lost.`,
          focus: {},
        },
        now,
      );
      break;
    }
    case "crew_collapse": {
      alertStack.post(
        {
          kind: "collapse",
          subject: "ship",
          text: `Too few able crew remain: the ${run.ship.name} drifts.`,
          focus: {},
        },
        now,
      );
      break;
    }
    case "departure": {
      const to = eventStr(event, "to");
      alertStack.post(
        {
          kind: "departure",
          subject: `charter@${event.tick}`,
          text: `Departure: for ${to}.`,
          focus: {},
        },
        now,
      );
      break;
    }
    case "arrival":
    case "port_call": {
      const port = eventStr(event, "port");
      alertStack.post(
        {
          kind: "arrival",
          subject: `${port}@${event.tick}`,
          text: `Arrival: ${port}.`,
          focus: {},
        },
        now,
      );
      break;
    }
    case "weather": {
      // Landfall only: the chain's move into the storm. The chain
      // flickers at the storm's edge, so a re-landfall inside a
      // day is the same storm system, not new news.
      if (eventStr(event, "to") !== "radiation storm") break;
      if (event.tick - lastStormToastTick < CONFIG.time.ticksPerDay) break;
      lastStormToastTick = event.tick;
      alertStack.post(
        {
          kind: "storm",
          subject: "storm",
          text: "Radiation storm.",
          focus: {},
        },
        now,
      );
      break;
    }
    default:
      break;
  }
}

/**
 * States from the live conditions: the critical-band system
 * cards. Later-leg departures are derived here too: the voyage
 * system emits no event when a stay ends, but the viewer watches
 * the stay end, and a departure is whitelisted news. Only stays
 * count: the charter origin is not a port call, and its
 * departure already arrives as an event.
 */
let prevStayPort: number | null = null;
let staySeen = false;

function syncAlerts(): void {
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
  const stay = run.galaxy.voyage.stayAt(run.tick);
  const stayPort = stay !== null ? stay.port : null;
  if (!staySeen) {
    staySeen = true;
    prevStayPort = stayPort;
    return;
  }
  if (prevStayPort !== null && stayPort === null) {
    const sector = run.galaxy.sector;
    const from = sector.portAt(prevStayPort).name;
    const leg = run.galaxy.voyage.currentLegAt(run.tick);
    const to = leg !== null ? sector.portAt(leg.to).name : "";
    alertStack.post(
      {
        kind: "departure",
        subject: `${from}@${run.tick}`,
        text: to !== "" ? `Departure: ${from} for ${to}.` : `Departure: ${from}.`,
        focus: {},
      },
      performance.now(),
    );
  }
  prevStayPort = stayPort;
}


// ------------------------------------------------------------- council

/**
 * The Council sheet's records, read off the event stream the
 * viewer already drains: a sitting is one row (time, subject,
 * matter, verdict) plus the watcher's truth chip where the
 * finding's record carries a truth, and its transcript (the
 * convening, the testimony quotes with their grades, the
 * finding, the truth line, the sentence) lives one tap deeper.
 * The renderer that prints the transcript is the chronicle's
 * own, seeded the same way the person card seeds it, so the
 * sheet and the log never disagree.
 */
interface SittingRecord {
  id: number;
  tick: number;
  kind: string;
  accusedId: string | null;
  subject: string;
  matter: string;
  verdict: string;
  chip: string | null;
  chipGood: boolean;
  coursePort: string;
  events: SimEvent[];
}

const SITTING_MATTERS: Record<string, string> = {
  inquiry: "Inquiry",
  discipline: "Discipline",
  rationing: "Rationing",
  lift: "Lift rationing",
  ratification: "Ratification",
  emergency: "Emergency",
  relief: "No confidence",
  appointment: "Appointment",
  course: "Course",
};

const SEAT_TITLES: Record<string, string> = {
  captain: "Captain",
  "first officer": "First Officer",
  "chief engineer": "Chief Engineer",
  "chief medical officer": "Chief Medical Officer",
  "security chief": "Security Chief",
  "science officer": "Science Officer",
  quartermaster: "Quartermaster",
};

let sittings: SittingRecord[] = [];
let openSitting: SittingRecord | null = null;
let lastSitting: SittingRecord | null = null;
let sittingsDirty = true;
let detailSittingId: number | null = null;
let seatsSig = "";

function trackCouncil(event: SimEvent): void {
  switch (event.type) {
    case "council_convened": {
      const kind = eventStr(event, "kind");
      const accused = eventStr(event, "accused");
      let subject = "";
      if (accused !== "") {
        subject = personName(accused);
      } else if (kind === "course") {
        subject = eventStr(event, "from");
      } else if (
        kind === "rationing" ||
        kind === "lift" ||
        kind === "ratification"
      ) {
        const store = eventStr(event, "store");
        subject =
          store === "food" ? "Food" : store === "water" ? "Water" : "Stores";
      } else if (kind === "relief") {
        const captain = run.council.seats["captain"];
        subject = captain !== null && captain !== undefined
          ? personName(captain)
          : "Captain";
      } else if (kind === "appointment") {
        subject = "First Officer";
      } else if (kind === "emergency") {
        subject = "Ship";
      }
      const record: SittingRecord = {
        id: sittings.length,
        tick: event.tick,
        kind,
        accusedId: accused !== "" ? accused : null,
        subject,
        matter: SITTING_MATTERS[kind] ?? kind,
        verdict: "",
        chip: null,
        chipGood: false,
        coursePort: "",
        events: [event],
      };
      sittings.push(record);
      openSitting = record;
      lastSitting = record;
      sittingsDirty = true;
      break;
    }
    case "council_testimony": {
      openSitting?.events.push(event);
      break;
    }
    case "course_decided": {
      if (openSitting !== null) {
        openSitting.events.push(event);
        openSitting.coursePort = eventStr(event, "port");
      }
      break;
    }
    case "council_finding": {
      const record = openSitting ?? lastSitting;
      if (record === null) break;
      record.events.push(event);
      const kind = eventStr(event, "kind");
      const accused = eventStr(event, "accused");
      const convicted = event.data.convicted === true;
      if (kind === "inquiry" || kind === "discipline") {
        record.verdict =
          accused === "" ? "no culprit" : convicted ? "culpable" : "acquitted";
        const right = findingWasRight(event);
        if (right === true) {
          record.chip = "upheld";
          record.chipGood = true;
        } else if (right === false) {
          const truthCulprit = eventStr(event, "truthCulprit");
          record.chip =
            convicted && accused !== truthCulprit
              ? "wrongly brigged"
              : !convicted && truthCulprit !== "" &&
                  (accused === "" || accused === truthCulprit)
                ? "culprit walks"
                : "wrong cause";
          record.chipGood = false;
        }
      } else if (kind === "course") {
        record.verdict =
          record.coursePort !== ""
            ? record.coursePort
            : eventStr(event, "consequence").replace("course set for ", "");
      } else {
        record.verdict = convicted ? "carried" : "refused";
      }
      if (openSitting === record) openSitting = null;
      sittingsDirty = true;
      if (detailSittingId === record.id) renderSittingTranscript(record);
      break;
    }
    case "council_sentence":
    case "captain_forgiveness": {
      // The tail of the sitting that just found: the sentence and
      // the forgiveness belong to its transcript.
      const member = eventStr(event, "member");
      if (lastSitting !== null && member === lastSitting.accusedId) {
        lastSitting.events.push(event);
        if (detailSittingId === lastSitting.id) {
          renderSittingTranscript(lastSitting);
        }
      }
      break;
    }
    default:
      break;
  }
}

function renderCouncilSeats(): void {
  const seats = run.council.seats;
  const legitimacy = Math.round(run.council.legitimacy * 100);
  const election = run.council.election;
  const electionSig =
    election === null
      ? ""
      : `${election.seatKey}:${election.incumbentId}:${election.challengerIds.join(",")}:${Math.floor(election.endsTick / CONFIG.time.ticksPerDay)}`;
  const sig =
    CONFIG.council.seats.map((def) => seats[def.key] ?? "-").join("|") +
    `#${legitimacy}#${electionSig}`;
  if (sig === seatsSig) return;
  seatsSig = sig;
  councilSeatsEl.replaceChildren();
  if (election !== null) {
    const banner = document.createElement("div");
    banner.className = "legitimacy-row";
    const label = document.createElement("span");
    const seatName = SEAT_TITLES[election.seatKey] ?? election.seatKey;
    const challengers = election.challengerIds
      .map((id) => personName(id))
      .join(" and ");
    label.textContent =
      `Election for the ${seatName} seat: ${personName(election.incumbentId)} ` +
      `stands against ${challengers}. The crew votes on day ${Math.floor(election.endsTick / CONFIG.time.ticksPerDay) + 1}.`;
    banner.appendChild(label);
    councilSeatsEl.appendChild(banner);
  }
  for (const def of CONFIG.council.seats) {
    const row = document.createElement("div");
    row.className = "seat-row";
    const name = document.createElement("span");
    name.className = "seat-name";
    name.textContent = SEAT_TITLES[def.key] ?? def.key;
    const holder = document.createElement("span");
    const holderId = seats[def.key];
    holder.className =
      "seat-holder" + (holderId === null || holderId === undefined ? " vacant" : "");
    holder.textContent =
      holderId === null || holderId === undefined
        ? "Vacant"
        : personName(holderId);
    row.append(name, holder);
    councilSeatsEl.appendChild(row);
  }
  const legRow = document.createElement("div");
  legRow.className = "legitimacy-row";
  const legLabel = document.createElement("span");
  legLabel.textContent = "Legitimacy";
  const bar = document.createElement("div");
  bar.className = "sbar";
  const fill = document.createElement("div");
  fill.style.width = `${legitimacy}%`;
  fill.className = legitimacy < 30 ? "crit" : legitimacy < 50 ? "warn" : "";
  bar.appendChild(fill);
  const value = document.createElement("span");
  value.className = "sval";
  value.textContent = `${legitimacy}%`;
  legRow.append(legLabel, bar, value);
  councilSeatsEl.appendChild(legRow);
}

function renderSittingList(): void {
  councilListEl.replaceChildren();
  if (sittings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sheet-empty";
    empty.textContent = "No sittings yet.";
    councilListEl.appendChild(empty);
    return;
  }
  for (let i = sittings.length - 1; i >= 0; i--) {
    const record = sittings[i] as SittingRecord;
    const clock = shipClock(record.tick);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sitting-row";
    const time = document.createElement("span");
    time.className = "s-time";
    time.textContent = `D${clock.day} ${clock.time}`;
    const main = document.createElement("span");
    main.className = "s-main";
    main.textContent =
      record.subject !== ""
        ? `${record.subject} · ${record.matter}`
        : record.matter;
    row.append(time, main);
    if (record.verdict !== "") {
      const verdict = document.createElement("span");
      verdict.className = "s-verdict";
      verdict.textContent = record.verdict;
      row.appendChild(verdict);
    }
    if (record.chip !== null) {
      const chip = document.createElement("span");
      chip.className = "truth-chip" + (record.chipGood ? " good" : "");
      chip.textContent = record.chip;
      row.appendChild(chip);
    }
    row.addEventListener("click", () => openSittingDetail(record));
    councilListEl.appendChild(row);
  }
}

function showSittingList(): void {
  detailSittingId = null;
  councilDetailEl.hidden = true;
  councilListEl.hidden = false;
  renderCouncilSeats();
  renderSittingList();
  sittingsDirty = false;
}

function openSittingDetail(record: SittingRecord): void {
  detailSittingId = record.id;
  councilListEl.hidden = true;
  councilDetailEl.hidden = false;
  renderSittingTranscript(record);
  sheetBodyEl.scrollTop = 0;
}

/** The transcript: the sitting's own events through the one renderer. */
function renderSittingTranscript(record: SittingRecord): void {
  const events = run.world.events.events;
  const transcript = createChronicleRenderer();
  for (const event of events) {
    if (event.type === "ship_generated" || event.type === "crew_generated") {
      transcript.push(event);
    }
  }
  councilTranscriptEl.replaceChildren();
  for (const event of record.events) {
    for (const line of transcript.push(event)) {
      if (line.text === "") continue;
      const div = document.createElement("div");
      div.className = "tline";
      div.textContent = line.text;
      councilTranscriptEl.appendChild(div);
    }
  }
  if (councilTranscriptEl.childElementCount === 0) {
    const div = document.createElement("div");
    div.className = "tline";
    div.textContent = "Nothing recorded.";
    councilTranscriptEl.appendChild(div);
  }
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

  // The body, as the consequences chapter keeps it: one health
  // figure, the open wounds by part, the sickness, and the marks
  // that stay. The dead keep their record; the roster says why
  // they are gone.
  if (member.dead) {
    personDossierEl.appendChild(
      dossierRow("Body", "Deceased. The ledger is closed."),
    );
  } else if (member.leftShip) {
    personDossierEl.appendChild(
      dossierRow("Body", "Put off the ship under the board's sentence."),
    );
  } else if (member.body !== undefined) {
    const body = member.body;
    const parts = [
      ["head", "Head"],
      ["torso", "Torso"],
      ["arms", "Arms"],
      ["legs", "Legs"],
    ] as const;
    const woundLines = parts
      .filter(([key]) => body.wounds[key].severity > 0)
      .map(([key, label]) => {
        const wound = body.wounds[key];
        return (
          `${label} ${pct(wound.severity)}` +
          (wound.infected ? ", infected" : "")
        );
      });
    let bodyText = `Health ${pct(body.health)}`;
    if (woundLines.length > 0) bodyText += `. Wounds: ${woundLines.join("; ")}`;
    if (body.sick >= 0.15) bodyText += `. Sick ${pct(body.sick)}`;
    if (body.marks.length > 0) bodyText += `. Marks: ${body.marks.join(", ")}`;
    if (woundLines.length === 0 && body.sick < 0.15 && body.marks.length === 0) {
      bodyText += ". Unmarked.";
    }
    personDossierEl.appendChild(dossierRow("Body", bodyText));
  }

  // The hands: seven disciplines, the true levels with progress
  // toward the next, the passion in prose, any cap a mark
  // imposes, and the captain's believed level where it differs —
  // the gap between the ledger and the appointment is the story.
  if (member.skills !== undefined) {
    personDossierEl.appendChild(dossierLabel("Skills"));
    const passionForms = ["a gift for", "a hunger for", "a love of"];
    const passion = member.skills.passion;
    personDossierEl.appendChild(
      dossierRow(
        "Passion",
        `${passionForms[DISCIPLINES.indexOf(passion) % passionForms.length]} ` +
          DISCIPLINE_LABEL[passion],
      ),
    );
    const captainId = run.council.seats["captain"] ?? null;
    const captain =
      captainId !== null && captainId !== member.id
        ? crewById(captainId)
        : undefined;
    for (const discipline of DISCIPLINES) {
      const level = levelOf(member, discipline);
      const cap = capFor(member, discipline);
      if (level === 0 && discipline !== passion && cap === null) continue;
      const progress = levelProgress(member, discipline);
      let text = `${level}`;
      if (level < 10) {
        text += ` · ${Math.round(progress.fraction * 100)}% to ${level + 1}`;
      }
      if (discipline === passion) text += " · passion";
      if (cap !== null && level > cap) {
        const mark =
          discipline === "operations" ? "a lost eye" : "a ruined hand";
        text += ` · capped at ${cap} by ${mark}`;
      }
      if (captain !== undefined) {
        const believed = Math.round(
          believedSkill(captain, member.id, discipline),
        );
        if (Math.abs(believed - level) >= 1) {
          text += ` · the captain rates them ${believed}`;
        }
      }
      personDossierEl.appendChild(
        dossierRow(DISCIPLINE_LABEL[discipline], text),
      );
    }
  }

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
  if (faction === null) {
    portFactionEl.textContent = "Independent";
  } else {
    const band = bandOf(run.standing.byId[faction.id] ?? 0);
    const bandLabel =
      band === "unregarded"
        ? "Unregarded"
        : band.charAt(0).toUpperCase() + band.slice(1);
    portFactionEl.textContent =
      `${faction.name} · a ${faction.kind}, ${faction.temperament}` +
      (isHome ? " · home port" : "") +
      ` · they hold us: ${bandLabel}`;
  }
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
  "injury", // consequences: a body hurt at its work
  "infection",
  "sickness",
  "attack", // a grudge made physical
  "lasting_mark", // the wound that stays
  "carried_to_medbay",
  "death", // the ledger come due
  "council_convened", // the council sits: a set-piece
  "course_decided", // the council sets the course out of a port
  "council_testimony",
  "council_finding", // verdicts, apart from the truth
  "council_sentence",
  "council_seat_vacated",
  "council_appointment",
  "council_succession",
  "appointment_ratified",
  "appointment_refused",
  "captain_forgiveness",
  "emergency_declared",
  "emergency_granted",
  "emergency_refused",
  "emergency_expired",
  "rationing_ratified",
  "relief_motion", // the terminal motion, tabled
  "captain_relieved",
  "relief_failed",
  "put_off", // a sentence carried out at the dock
  "ship_lost", // an ending
  "crew_collapse", // the other ending
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

logViewFeedBtn.addEventListener("click", () => setLogView("feed"));
logViewChronicleBtn.addEventListener("click", () => setLogView("chronicle"));

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

// ------------------------------------------------------------ scuttlebutt

function feedNames(): FeedNames {
  return {
    person: (id) => personName(id),
    firstName: (id) => personName(id).split(" ")[0] ?? personName(id),
    system: (id) => systemName(id),
    room: (index) => roomName(index),
    ship: run.ship.name,
  };
}

function feedTime(tick: number): string {
  const tpd = CONFIG.time.ticksPerDay;
  const day = Math.floor(tick / tpd) + 1;
  const minutes = (tick % tpd) * 10;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `D${day} · ${hh}:${mm}`;
}

const MAX_FEED_DOM = 80;

/** Every face and name in the feed opens that person's card:
 *  posters, repliers, reactors, and poll voters alike. */
function wirePersonTap(el: HTMLElement, id: string): void {
  el.classList.add("tappable");
  el.addEventListener("click", () => {
    selectCrew(id);
    openPersonCard(id);
  });
}

function feedAvatar(author: string | null): HTMLElement {
  if (author === null) {
    const div = document.createElement("div");
    div.className = "feed-avatar ship";
    div.textContent = "🚀";
    return div;
  }
  const canvas = document.createElement("canvas");
  canvas.className = "feed-avatar";
  canvas.width = 28;
  canvas.height = 28;
  const member = crewById(author);
  const ctx = canvas.getContext("2d");
  if (ctx !== null && member !== undefined) {
    ctx.drawImage(getPortraitCanvas(member, faceStateOf(member)), 0, 0, 28, 28);
  }
  return canvas;
}

function buildFeedCard(item: FeedItem): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "feed-card";
  const head = document.createElement("div");
  head.className = "feed-head";
  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = feedTime(item.tick);
  if (item.kind === "poll") {
    head.append(feedAvatar(null));
    const who = document.createElement("div");
    who.className = "feed-who";
    who.textContent = `${run.ship.name} · Council vote`;
    head.append(who, time);
    card.appendChild(head);
    const q = document.createElement("div");
    q.className = "poll-q";
    q.textContent = item.question;
    card.appendChild(q);
    const total = item.bars.reduce((n, b) => n + b.voters.length, 0);
    for (const bar of item.bars) {
      const row = document.createElement("div");
      row.className = "poll-row";
      const label = document.createElement("div");
      label.className = "poll-label";
      label.textContent = `${bar.choice} · ${bar.voters.length}`;
      const track = document.createElement("div");
      track.className = "poll-track";
      const fill = document.createElement("div");
      fill.className = `poll-fill ${bar.choice}`;
      fill.style.width = `${total > 0 ? Math.round((bar.voters.length / total) * 100) : 0}%`;
      track.appendChild(fill);
      const names = document.createElement("div");
      names.className = "poll-names";
      bar.voters.forEach((id, at) => {
        if (at > 0) names.append(document.createTextNode(", "));
        const span = document.createElement("span");
        span.textContent = personName(id);
        wirePersonTap(span, id);
        names.append(span);
      });
      row.append(label, track, names);
      card.appendChild(row);
    }
    const outcome = document.createElement("div");
    outcome.className = "poll-outcome";
    outcome.textContent = item.outcome;
    card.appendChild(outcome);
    return card;
  }
  head.append(feedAvatar(item.author));
  const who = document.createElement("div");
  who.className = "feed-who";
  if (item.author === null) {
    who.textContent = run.ship.name;
  } else {
    const member = crewById(item.author);
    who.textContent =
      member !== undefined
        ? `${member.name} · ${member.title}`
        : personName(item.author);
  }
  if (item.author !== null) wirePersonTap(head, item.author);
  head.append(who, time);
  card.appendChild(head);
  const text = document.createElement("div");
  text.className = "feed-text";
  text.textContent = item.text;
  card.appendChild(text);
  for (const entry of item.replies ?? []) {
    const reply = document.createElement("div");
    reply.className = "feed-reply";
    reply.append(feedAvatar(entry.author));
    const rtext = document.createElement("div");
    rtext.className = "feed-reply-text";
    const rname = document.createElement("span");
    rname.className = "feed-reply-name";
    rname.textContent = personName(entry.author);
    rtext.append(rname, document.createTextNode(` ${entry.text}`));
    reply.appendChild(rtext);
    wirePersonTap(reply, entry.author);
    card.appendChild(reply);
  }
  if (item.reactions !== undefined && item.reactions.length > 0) {
    const row = document.createElement("div");
    row.className = "feed-reactions";
    for (const id of item.reactions) {
      const face = feedAvatar(id);
      wirePersonTap(face, id);
      row.append(face);
    }
    const heart = document.createElement("span");
    heart.className = "heart";
    heart.textContent = "♥";
    row.appendChild(heart);
    card.appendChild(row);
  }
  return card;
}

function renderFeed(): void {
  const prevHeight = sheetBodyEl.scrollHeight;
  const prevTop = sheetBodyEl.scrollTop;
  feedEl.replaceChildren();
  const items = feedItems.slice(-MAX_FEED_DOM).reverse();
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.appendChild(buildFeedCard(item));
  if (items.length === 0) {
    const div = document.createElement("div");
    div.className = "feed-empty";
    div.textContent = "Quiet so far. The ship is still clearing its throat.";
    fragment.appendChild(div);
  }
  feedEl.appendChild(fragment);
  // New posts land at the top; a reader who has scrolled into the
  // feed's history keeps their place instead of being yanked up.
  if (prevTop > 0 && sheetTab === "log" && logView === "feed") {
    sheetBodyEl.scrollTop =
      prevTop + (sheetBodyEl.scrollHeight - prevHeight);
  }
}

function setLogView(view: "feed" | "chronicle"): void {
  logView = view;
  feedEl.hidden = view !== "feed";
  chronicleEl.hidden = view !== "chronicle";
  logDetailToggle.hidden = view !== "chronicle";
  logViewFeedBtn.classList.toggle("active", view === "feed");
  logViewChronicleBtn.classList.toggle("active", view === "chronicle");
  logViewFeedBtn.setAttribute("aria-pressed", String(view === "feed"));
  logViewChronicleBtn.setAttribute("aria-pressed", String(view === "chronicle"));
  if (view === "feed") renderFeed();
  else rebuildChronicleDom();
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
  // The sheet body is the scroller now; the log rides it.
  if (stickToBottom && sheetTab === "log") {
    sheetBodyEl.scrollTop = sheetBodyEl.scrollHeight;
  }
}

function rebuildChronicleDom(): void {
  chronicleEl.replaceChildren();
  const visible = allLines.filter((entry) => linePasses(entry));
  appendLinesToDom(visible.slice(-MAX_CHRONICLE_DOM_LINES));
  sheetBodyEl.scrollTop = sheetBodyEl.scrollHeight;
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
    if (event.type === "chatter") {
      // The words themselves, over the speaker's head: composed
      // from the event payload by the same speech layer the
      // chronicle uses, so the deck and the log never disagree.
      const speaker = eventStr(event, "speaker");
      if (speaker !== "") {
        const text = chatterText(event.data, {
          person: (id) => personName(id),
          system: (id) => systemName(id),
          room: (index) => roomName(index),
        });
        if (text !== "") deck?.speechLine(speaker, text);
      }
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
    // A council sitting stages itself in the mess: the officers
    // cross the ship and take their seats, the accused stands at
    // the open end with Security beside them.
    if (event.type === "council_convened") {
      const seatsRaw = event.data.seats;
      if (Array.isArray(seatsRaw)) {
        const seats = seatsRaw
          .filter(
            (s): s is { member: string; seat: string } =>
              typeof s === "object" &&
              s !== null &&
              typeof (s as { member?: unknown }).member === "string" &&
              typeof (s as { seat?: unknown }).seat === "string",
          )
          .map((s) => ({ member: s.member, seat: s.seat }));
        const accusedRaw = event.data.accused;
        activeSittings.push({
          room: eventNum(event, "room"),
          kind: eventStr(event, "kind"),
          seats,
          accused: typeof accusedRaw === "string" ? accusedRaw : null,
          untilTick: event.tick + SITTING_TICKS,
        });
        rebuildCouncilSeats();
      }
    }
    // The vote: tokens rise over the voters' heads in seat order,
    // read off the finding's own recorded votes.
    if (event.type === "council_finding" && deck !== null) {
      const votesRaw = event.data.votes;
      if (Array.isArray(votesRaw) && votesRaw.length > 0) {
        const sitting = activeSittings[activeSittings.length - 1];
        const order = new Map<string, number>(
          (sitting?.seats ?? []).map((s, i) => [s.member, i]),
        );
        const votes = votesRaw
          .filter(
            (v): v is { member: string; choice: string } =>
              typeof v === "object" &&
              v !== null &&
              typeof (v as { member?: unknown }).member === "string",
          )
          .slice()
          .sort(
            (a, b) =>
              (order.get(a.member) ?? 99) - (order.get(b.member) ?? 99),
          );
        const runRef = run;
        const deckRef = deck;
        votes.forEach((vote, i) => {
          window.setTimeout(() => {
            if (run === runRef && deck === deckRef) {
              deckRef.stageVote(vote.member, String(vote.choice));
            }
          }, 500 + i * 450);
        });
      }
    }
    if (event.type === "move") {
      const actor = event.actors[0];
      if (actor !== undefined) updateCarry(actor, event);
    }
    trackCouncil(event);
    feedAlert(event);
    // Small talk is the feed's wallpaper, not its news: notable
    // chatter always posts, the rest posts on a hash sample, the
    // same discipline the chronicle gives its chatter highlights.
    const feedGate =
      event.type !== "chatter" ||
      event.data.notable === true ||
      hash01(event.seq, 53) < 0.18;
    const feedItem = feedGate ? feedBuilder.push(event, feedNames()) : null;
    if (feedItem !== null) {
      feedItems.push(feedItem);
      if (feedItems.length > 400) feedItems.shift();
      feedDirty = true;
    }
    for (const line of renderer.push(event)) {
      const entry: LogLine = { line, type: event.type };
      allLines.push(entry);
      batch.push(entry);
    }
  }
  appendLinesToDom(batch);
  if (feedDirty) {
    feedDirty = false;
    if (logView === "feed") renderFeed();
  }
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
    dailyText.textContent = `★ Voyage of the Day · ${run.ship.name}`;
    dailyBtn.hidden = true;
  } else {
    dailyText.textContent = "";
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
  activeSittings.length = 0;
  councilSeatByMember.clear();
  councilStandByMember.clear();
  carryByMember.clear();
  sittings = [];
  openSitting = null;
  lastSitting = null;
  detailSittingId = null;
  sittingsDirty = true;
  seatsSig = "";
  councilListEl.replaceChildren();
  councilSeatsEl.replaceChildren();
  staySeen = false;
  prevStayPort = null;
  lastStormToastTick = Number.NEGATIVE_INFINITY;
  alertStack.reset();
  chronicleEl.replaceChildren();
  feedItems.length = 0;
  feedDirty = false;
  feedBuilder = new FeedBuilder();
  if (logView === "feed") renderFeed();
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
  hashEl.textContent = run.hash().slice(0, 10);
  eventCountEl.textContent = String(run.world.events.size);
}

/** The strip's weather word: the state, never a sentence. */
const WEATHER_WORDS: Record<string, string> = {
  calm: "Calm",
  "solar wind": "Solar wind",
  "radiation storm": "Storm",
};

/** The strip's position segment, kept by updateRoute. */
let stripRouteShort = "";
let lastStripText = "";

/**
 * The one status strip: day, time, watch, weather, position.
 * One line, written on the slow cadence and only when it
 * changes; the weather itself is painted in the world, so the
 * strip carries just its name.
 */
function updateStrip(): void {
  const clock = shipClock(run.tick);
  const watch = watchName(
    (run.tick % CONFIG.time.ticksPerDay) * CONFIG.time.minutesPerTick,
  );
  if (watch !== shownWatch) {
    shownWatch = watch;
    paintWatchIcon(watch);
  }
  const watchWord = watch.replace(" watch", "");
  const parts = [
    `D${clock.day}`,
    clock.time,
    watchWord,
    WEATHER_WORDS[weatherName] ?? weatherName,
  ];
  if (stripRouteShort !== "") parts.push(stripRouteShort);
  const text = parts.join(" · ");
  if (text !== lastStripText) {
    lastStripText = text;
    stripLineEl.textContent = text;
  }
}

// ------------------------------------------------------- ship's day

/** The scene chip's word for a sitting's business. */
const SITTING_CHIP_WORDS: Record<string, string> = {
  inquiry: "Inquiry",
  discipline: "Discipline",
  rationing: "Rationing",
  lift: "Rationing",
  ratification: "Ratification",
  emergency: "Emergency",
  relief: "Relief",
  appointment: "Appointment",
  course: "Course",
};

let lastSceneText = "\u0000";

/**
 * The scene chip over the deck: the moment the ship is in, in
 * the reference's style ("Council · Inquiry · 5 seated",
 * "Mess · Breakfast · 9 at table"). Derived from the staging
 * state the deck already keeps; written only when it changes,
 * on the slow cadence.
 */
function updateSceneChip(): void {
  const tick = run.tick;
  let text = "";
  const sitting = activeSittings[activeSittings.length - 1];
  if (sitting !== undefined) {
    const word = SITTING_CHIP_WORDS[sitting.kind] ?? "Sitting";
    text = `Council · ${word} · ${sitting.seats.length} seated`;
  } else {
    const stay = run.galaxy.voyage.stayAt(tick);
    if (stay !== null) {
      const port = run.galaxy.sector.portAt(stay.port);
      const ashore = run.crew.filter((m) => m.ashore).length;
      text =
        ashore > 0
          ? `Port · ${port.name} · ${ashore} ashore`
          : `Port · ${port.name}`;
    } else {
      const meal = mealWindowAt(tick);
      if (meal !== null) {
        const atTable = run.crew.filter(
          (m) => !m.ashore && !m.dead && !m.leftShip && m.activity === "eat",
        ).length;
        text =
          `Mess · ${meal === "breakfast" ? "Breakfast" : "Evening meal"}` +
          ` · ${atTable} at table`;
      } else {
        const counts = new Map<BlockKind, number>();
        let nightOnDuty = 0;
        for (const member of run.crew) {
          if (member.dead || member.leftShip) continue;
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
        if (majority === "sleep" && nightOnDuty > 0) {
          // Most hands are asleep and the night pair holds the
          // ship: the ship's posture is the night watch.
          text = `Night watch · ${nightOnDuty} on duty`;
        } else if (majority === "sleep") {
          text = `Sleep · ${best} in bunks`;
        } else if (majority === "work") {
          text = `Work · ${best} on duty`;
        } else if (majority === "meal") {
          text = `Mess · ${best} at table`;
        } else {
          text = `Free time · ${best} about`;
        }
      }
    }
  }
  if (text !== lastSceneText) {
    lastSceneText = text;
    sceneChipEl.textContent = text;
    sceneChipEl.hidden = text === "";
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
    // The next course is named only once the council has set it:
    // before the sitting, the header assumes nothing.
    const decided = voyage.courseDecisionFor(stay.index);
    if (decided !== null) {
      text += ` · for ${sector.portAt(decided).name}`;
    }
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
  // The strip's position segment: the port's name in port, the
  // destination and whole days out under way.
  let short = "";
  if (stay !== null) {
    short = sector.portAt(stay.port).name;
  } else {
    const leg = voyage.currentLegAt(tick);
    if (leg !== null) {
      const daysToGo = (leg.arriveTick - vt) / tpd;
      short = `${sector.portAt(leg.to).name} ${Math.max(1, Math.ceil(daysToGo))}d`;
    } else {
      const portIndex = voyage.portIndexAt(tick);
      if (portIndex !== null) short = sector.portAt(portIndex).name;
    }
  }
  stripRouteShort = short;
  if (text !== lastRouteText) {
    lastRouteText = text;
    routeEl.textContent = text;
  }
}

// ------------------------------------------------------------- stores

const STRIP_LABELS: Record<StoreKey, string> = {
  food: "Food",
  water: "Water",
  oxygen: "O2",
  fuel: "Fuel",
  parts: "Parts",
};

interface StoreCell {
  fill: HTMLDivElement;
  value: HTMLSpanElement;
  sig: string;
}

const storeCells = new Map<StoreKey, StoreCell>();
let dutiesSig = "";
const dutiesEl = must<HTMLElement>("duties-list");
/** The upkeep layer on the Ship tab: one bar per duty, grouped
 *  under its department, banded like the stores. */
function updateDutiesList(): void {
  const duties = run.ship.duties;
  if (duties === null) return;
  const rows = DUTY_DEFS.map((def) => {
    const state = duties.byId[def.id];
    const pct = state === undefined ? 100 : Math.round(state.level * 100);
    return `${def.id}:${pct}:${state?.neglected ? "!" : ""}`;
  });
  const sig = rows.join("|");
  if (sig === dutiesSig) return;
  dutiesSig = sig;
  dutiesEl.replaceChildren();
  for (const def of DUTY_DEFS) {
    const state = duties.byId[def.id];
    if (state === undefined) continue;
    const pct = Math.round(state.level * 100);
    const row = document.createElement("div");
    row.className = "seat-row";
    const name = document.createElement("span");
    name.className = "seat-name";
    name.textContent = `${def.name} · ${def.department}`;
    const bar = document.createElement("div");
    bar.className = "sbar";
    const fill = document.createElement("div");
    fill.style.width = `${pct}%`;
    fill.className = state.neglected ? "crit" : pct < 55 ? "warn" : "";
    bar.appendChild(fill);
    const value = document.createElement("span");
    value.className = "sval";
    value.textContent = state.neglected ? `${pct}% overdue` : `${pct}%`;
    row.append(name, bar, value);
    dutiesEl.appendChild(row);
  }
}

let factionsSig = "";
const factionsEl = must<HTMLElement>("factions-list");
/** The sector's powers on the Ship tab: each faction's form,
 *  temperament, and the band it currently holds the ship in. */
function updateFactionsList(): void {
  const sector = run.galaxy.sector;
  const rows = sector.factions.map((f) => {
    const v = run.standing.byId[f.id] ?? 0;
    return `${f.id}:${Math.round(v * 1000)}`;
  });
  const sig = rows.join("|");
  if (sig === factionsSig) return;
  factionsSig = sig;
  factionsEl.replaceChildren();
  for (const f of sector.factions) {
    const v = run.standing.byId[f.id] ?? 0;
    const band = bandOf(v);
    const row = document.createElement("div");
    row.className = "seat-row";
    const name = document.createElement("span");
    name.className = "seat-name";
    name.textContent = `${f.name} · ${f.kind}, ${f.temperament}`;
    const bar = document.createElement("div");
    bar.className = "sbar";
    const fill = document.createElement("div");
    fill.style.width = `${Math.round(((v + 1) / 2) * 100)}%`;
    fill.className = band === "cold" ? "crit" : band === "warm" || band === "honoured" ? "" : "warn";
    bar.appendChild(fill);
    const value = document.createElement("span");
    value.className = "sval";
    value.textContent =
      band === "unregarded"
        ? "Unregarded"
        : band.charAt(0).toUpperCase() + band.slice(1);
    row.append(name, bar, value);
    factionsEl.appendChild(row);
  }
}

/** The sixth, unnumbered store: the council's legitimacy. */
const legitimacyCell: {
  fill: HTMLDivElement | null;
  value: HTMLSpanElement | null;
  sig: string;
} = { fill: null, value: null, sig: "" };
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
  // Legitimacy gets a cell of the same shape at the strip's end:
  // no days, no trend, just how far the crew believes its own
  // council. It is the chapter's light surface; the chronicle
  // carries the detail.
  const cell = document.createElement("div");
  cell.className = "store-cell";
  const label = document.createElement("span");
  label.className = "slabel";
  label.textContent = "Council";
  const bar = document.createElement("div");
  bar.className = "sbar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  const value = document.createElement("span");
  value.className = "sval";
  cell.append(label, bar, value);
  strip.appendChild(cell);
  legitimacyCell.fill = fill;
  legitimacyCell.value = value;
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
  const legitimacy = Math.round(run.council.legitimacy * 100);
  const legSig = `${legitimacy}`;
  if (
    legitimacyCell.sig !== legSig &&
    legitimacyCell.fill !== null &&
    legitimacyCell.value !== null
  ) {
    legitimacyCell.sig = legSig;
    legitimacyCell.fill.style.width = `${legitimacy}%`;
    legitimacyCell.fill.className =
      legitimacy < 30 ? "crit" : legitimacy < 50 ? "warn" : "";
    legitimacyCell.value.textContent = `${legitimacy}%`;
  }
}

function updateSlowUi(): void {
  updateRoute();
  updateStrip();
  updateSceneChip();
  updateStoresStrip();
  updateDutiesList();
  updateFactionsList();
  syncAlerts();
  if (sheetTab === "council") {
    renderCouncilSeats();
    if (sittingsDirty && detailSittingId === null) {
      renderSittingList();
      sittingsDirty = false;
    }
  }

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
    // The role line carries the primary discipline and its level:
    // the roster is a glance, and one number is the glance.
    const top = topDiscipline(member);
    const skillText = `${DISCIPLINE_SHORT[top.discipline]} ${top.level}`;
    const roleText = member.dead
      ? `${member.title} · ${skillText} · Deceased`
      : member.leftShip
        ? `${member.title} · ${skillText} · Put off the ship`
        : member.ashore
          ? `${member.title} · ${skillText} · Ashore`
          : `${member.title} · ${skillText}`;
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
    pruneSittings();
    const deckDtMs = lastDeckMs === 0 ? dtMs : nowMs - lastDeckMs;
    lastDeckMs = nowMs;
    const tickMs = playing
      ? 1000 / (SPEEDS[speedIndex] as (typeof SPEEDS)[number]).ticksPerSecond
      : Number.POSITIVE_INFINITY;
    // Crew ashore at a port call are not on the deck at all: their
    // dots, their windows, and their minimap marks stay at the port.
    // The dead are not on the deck either, and neither is anyone
    // the council has put off the ship: the roster keeps their
    // names and their markers, the deck keeps only the living.
    const aboard = run.crew.filter((m) => !m.ashore && !m.dead && !m.leftShip);
    // While a sitting lasts, its people are presented in the mess:
    // presentation copies with the sitting's room, so the deck
    // walks the officers across the ship to their seats. The sim's
    // own members are never touched.
    const presented =
      activeSittings.length === 0
        ? aboard
        : aboard.map((m) => {
            const seat = councilSeatByMember.get(m.id);
            const stand = councilStandByMember.get(m.id);
            const spot = seat ?? stand;
            if (spot === undefined || spot.room === m.room) return m;
            return { ...m, room: spot.room, activity: "socialize" };
          });
    deck.frame(presented, {
      now: nowMs,
      dtMs: deckDtMs,
      tickMs,
      snap: speedIndex >= 4,
      selectedId: selectedCrew,
      workSystem: workSystemByMember,
      gameSeat: gameSeatByMember,
      councilSeat: councilSeatByMember,
      councilStand: councilStandByMember,
      carry: carryByMember,
      showWear,
      showBubbles,
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
    const aboard = run.crew.filter((m) => !m.ashore && !m.dead && !m.leftShip);
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
  speedBtn.textContent = speed.label;
}

/** One cycling speed button (the reference viewers' fold). */
speedBtn.addEventListener("click", () => {
  setSpeed((speedIndex + 1) % SPEEDS.length);
});

playBtn.addEventListener("click", () => setPlaying(!playing));
menuBtn.addEventListener("click", () => {
  menuRow.hidden = !menuRow.hidden;
});

function setToggle(
  which: "wear" | "bubbles",
  on: boolean,
  persist = true,
): void {
  if (which === "wear") showWear = on;
  else showBubbles = on;
  const button = which === "wear" ? toggleWearBtn : toggleBubblesBtn;
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", String(on));
  if (persist) {
    try {
      window.localStorage.setItem(
        "starship.toggles",
        JSON.stringify({ wear: showWear, bubbles: showBubbles }),
      );
    } catch {
      // Storage can refuse; the toggles still work for the session.
    }
  }
}
toggleWearBtn.addEventListener("click", () => setToggle("wear", !showWear));
toggleBubblesBtn.addEventListener("click", () =>
  setToggle("bubbles", !showBubbles),
);

for (const [tab, button] of tabButtons) {
  button.addEventListener("click", () => toggleSheet(tab));
}
must<HTMLButtonElement>("sheet-close").addEventListener("click", () => {
  closeSheet();
});
must<HTMLButtonElement>("council-back").addEventListener("click", () => {
  showSittingList();
});

/** The pause-on settings: one checkbox per whitelisted kind. */
function buildAlertPrefs(): void {
  alertPrefsEl.replaceChildren();
  for (const def of ALERT_KIND_DEFS) {
    const row = document.createElement("label");
    row.className = "pref-row";
    const label = document.createElement("span");
    label.textContent = def.label;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.pauseKind = def.kind;
    box.checked = pausePrefs[def.kind];
    box.addEventListener("change", () => {
      pausePrefs[def.kind] = box.checked;
      savePausePrefs(pausePrefs);
    });
    row.append(label, box);
    alertPrefsEl.appendChild(row);
  }
}
dailyBtn.addEventListener("click", () => startDailyVoyage());
decksBtn.addEventListener("click", () =>
  setViewDeck(deck?.visibleDeck ?? 0),
);
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
sheetBodyEl.addEventListener("scroll", () => {
  if (sheetTab !== "log") return;
  stickToBottom =
    sheetBodyEl.scrollHeight - sheetBodyEl.scrollTop - sheetBodyEl.clientHeight <
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
    closeSheet();
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
buildAlertPrefs();
document.body.dataset.view = "deck";
{
  // The alert stack's phone discipline (caps and lifetimes)
  // follows the viewport, live.
  const phoneQuery = window.matchMedia("(max-width: 760px)");
  const applyPhone = () => alertStack.setPhoneMode(phoneQuery.matches);
  applyPhone();
  phoneQuery.addEventListener("change", applyPhone);
  // The menu row's view toggles, restored.
  let wear = true;
  let bubbles = true;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem("starship.toggles") ?? "{}",
    ) as { wear?: unknown; bubbles?: unknown };
    if (typeof stored.wear === "boolean") wear = stored.wear;
    if (typeof stored.bubbles === "boolean") bubbles = stored.bubbles;
  } catch {
    // No stored toggles: both on.
  }
  setToggle("wear", wear, false);
  setToggle("bubbles", bubbles, false);
}
if (params.get("daily") === "1") {
  // ?daily=1 wins over ?seed=: it names a day, not a ship, and the ship
  // it names changes at UTC midnight.
  startDailyVoyage();
} else {
  const initialSeed = Number(params.get("seed") ?? "42") || 42;
  startVoyage(initialSeed);
}
requestAnimationFrame(frame);
