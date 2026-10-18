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
import { dailySeed } from "./daily.ts";
import { DeckView } from "./deck.ts";
import { Minimap } from "./minimap.ts";
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

let run: RunContext;
let renderer: ChronicleRenderer;
let currentSeed = 42;
let toastTimer = 0;
let seenEvents = 0;
let allLines: ChronicleLine[] = [];
let playing = true;
let speedIndex = 2; // 3x
let accumulator = 0;
let lastFrameMs = 0;
let lastSlowUiMs = 0;
let selectedCrew: string | null = null;
let highlightsOnly = true;
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
const minimapCanvas = must<HTMLCanvasElement>("minimap-canvas");
const crewPanel = must<HTMLElement>("crew-panel");
const chronicleEl = must<HTMLElement>("chronicle");
const highlightsToggle = must<HTMLInputElement>("highlights-toggle");

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

/** The minimap: both decks at a glance, beside the main canvas. */
let minimap: Minimap | null = null;
let lastMinimapMs = 0;

function buildDeck(): void {
  deck = new DeckView(run.ship, deckCanvas);
  minimap = new Minimap(deck.shipLayout, minimapCanvas);
  refreshDeckButtons();
}

/**
 * Show one deck on the main canvas. The other deck keeps living: its
 * wear accrues, its crew ride the lifts, and the minimap watches it.
 */
function setViewDeck(next: number): void {
  if (deck === null) return;
  deck.setDeck(next);
  refreshDeckButtons();
}

function refreshDeckButtons(): void {
  const active = deck?.visibleDeck ?? 0;
  deck1Btn.classList.toggle("active", active === 0);
  deck2Btn.classList.toggle("active", active === 1);
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
    if (where !== deck.visibleDeck) setViewDeck(where);
    selectCrew(member.id);
    openPersonCard(member.id);
    return;
  }
  if (focus.room !== undefined && deck !== null) {
    const where = deck.deckOfRoom(focus.room);
    if (where !== deck.visibleDeck) setViewDeck(where);
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
    if (where !== deck.visibleDeck) setViewDeck(where);
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
  idle: "taking a moment",
};

function crewById(id: string): CrewMember | undefined {
  return run.crew.find((member) => member.id === id);
}

function personName(id: string): string {
  return crewById(id)?.name ?? id;
}

function openPersonCard(id: string): void {
  cardCrewId = id;
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
  personWhereEl.textContent =
    `Currently ${activity} in the ${room?.name ?? "ship"}, Deck ${deckNo}.`;
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

// -------------------------------------------------------------- chronicle

function linePasses(line: ChronicleLine): boolean {
  return !highlightsOnly || line.highlight;
}

function appendLineToDom(line: ChronicleLine): void {
  if (!linePasses(line)) return;
  const div = document.createElement("div");
  div.className =
    "line " + (line.highlight ? "hl" : "routine") + (line.text === "" ? " blank" : "");
  if (line.actor !== undefined) div.dataset.actor = line.actor;
  if (selectedCrew !== null && line.actor !== selectedCrew) {
    div.classList.add("dim");
  }
  div.textContent = line.text === "" ? " " : line.text;
  chronicleEl.appendChild(div);
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
  const visible = allLines.filter(linePasses);
  for (const line of visible.slice(-MAX_CHRONICLE_DOM_LINES)) {
    appendLineToDom(line);
  }
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
    feedAlert(event);
    for (const line of renderer.push(event)) {
      allLines.push(line);
      appendLineToDom(line);
    }
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

function updateSlowUi(): void {
  weatherNameEl.textContent = weatherName;
  weatherBanner.classList.toggle("storm", weatherName === "radiation storm");
  syncAlerts();

  for (const member of run.crew) {
    const ui = crewUi.get(member.id);
    if (ui === undefined) continue;
    for (const key of NEED_KEYS) {
      const fill = ui.bars.get(key);
      if (fill === undefined) continue;
      const value = member.needs[key];
      fill.style.width = `${Math.round(value * 100)}%`;
      fill.className = value < 0.25 ? "low" : value < 0.5 ? "mid" : "";
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
  if (deck !== null) {
    const tickMs = playing
      ? 1000 / (SPEEDS[speedIndex] as (typeof SPEEDS)[number]).ticksPerSecond
      : Number.POSITIVE_INFINITY;
    deck.frame(run.crew, {
      now: nowMs,
      dtMs,
      tickMs,
      snap: speedIndex >= 4,
      selectedId: selectedCrew,
      workSystem: workSystemByMember,
      dayMinutes:
        (run.tick % CONFIG.time.ticksPerDay) * CONFIG.time.minutesPerTick,
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
    nowMs - lastMinimapMs > 250
  ) {
    lastMinimapMs = nowMs;
    minimap.draw(
      run.ship,
      run.crew,
      deck.minimapSnapshot(run.crew),
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
highlightsToggle.addEventListener("change", () => {
  highlightsOnly = highlightsToggle.checked;
  rebuildChronicleDom();
});
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
  } else if (event.key >= "1" && event.key <= "6") {
    setSpeed(Number(event.key) - 1);
  } else if (event.key === "7" || event.key === "[") {
    setViewDeck(0);
  } else if (event.key === "8" || event.key === "]") {
    setViewDeck(1);
  }
});

// ------------------------------------------------------------------ boot

const params = new URLSearchParams(window.location.search);
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
