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
import { CONFIG } from "../../src/scenario/config.ts";
import { createRun, type RunContext } from "../../src/sim.ts";
import type { CrewMember } from "../../src/entities/crew.ts";
import type { Ship } from "../../src/world/ship.ts";

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

const ROOM_W = 148;
const ROOM_H = 64;
const GAP_X = 48;
const GAP_Y = 18;

const PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990", "#dcbeff",
];

const NEED_KEYS = ["energy", "hunger", "social", "morale"] as const;
type NeedKey = (typeof NEED_KEYS)[number];
const NEED_LABELS: Record<NeedKey, string> = {
  energy: "Energy",
  hunger: "Food",
  social: "Social",
  morale: "Morale",
};

const SVGNS = "http://www.w3.org/2000/svg";

function must<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`viewer: no element #${id}`);
  return element as unknown as T;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVGNS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ---------------------------------------------------------------- state

let run: RunContext;
let renderer: ChronicleRenderer;
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
const speedReadoutEl = must<HTMLElement>("speed-readout");
const hashEl = must<HTMLElement>("hash");
const eventCountEl = must<HTMLElement>("event-count");
const playBtn = must<HTMLButtonElement>("play-btn");
const speedGroup = must<HTMLElement>("speed-group");
const seedInput = must<HTMLInputElement>("seed-input");
const weatherBanner = must<HTMLElement>("weather-banner");
const weatherNameEl = must<HTMLElement>("weather-name");
const svgEl = must<SVGSVGElement>("ship-svg");
const crewPanel = must<HTMLElement>("crew-panel");
const chronicleEl = must<HTMLElement>("chronicle");
const highlightsToggle = must<HTMLInputElement>("highlights-toggle");

// ------------------------------------------------------------- schematic

interface RoomPos {
  x: number;
  y: number;
}

let roomPos: RoomPos[] = [];
let roomGroups = new Map<number, SVGGElement>();
let roomCondBars = new Map<number, SVGRectElement>();
let roomSysLabels = new Map<number, SVGTextElement>();

interface Dot {
  group: SVGGElement;
  member: CrewMember;
  x: number;
  y: number;
  tx: number;
  ty: number;
}
let dots = new Map<string, Dot>();

function computeLayout(ship: Ship): { pos: RoomPos[]; width: number; height: number } {
  const { dist } = ship.distancesFrom(0);
  const layers = new Map<number, number[]>();
  ship.rooms.forEach((room) => {
    const d = Math.max(0, dist[room.index] ?? 0);
    const layer = layers.get(d) ?? [];
    layer.push(room.index);
    layers.set(d, layer);
  });
  const maxLayer = Math.max(...layers.keys());
  const maxRows = Math.max(...[...layers.values()].map((a) => a.length));
  const width = (maxLayer + 1) * (ROOM_W + GAP_X) - GAP_X + 16;
  const height = maxRows * (ROOM_H + GAP_Y) - GAP_Y + 16;
  const pos: RoomPos[] = new Array<RoomPos>(ship.rooms.length);
  for (const [d, members] of layers) {
    const columnHeight = members.length * (ROOM_H + GAP_Y) - GAP_Y;
    const y0 = (height - columnHeight) / 2;
    members.forEach((roomIndex, row) => {
      pos[roomIndex] = {
        x: 8 + d * (ROOM_W + GAP_X),
        y: y0 + row * (ROOM_H + GAP_Y),
      };
    });
  }
  return { pos, width, height };
}

function slotTarget(
  member: CrewMember,
  occupants: Map<number, CrewMember[]>,
): { x: number; y: number } {
  const roomIndex = member.room;
  const group = occupants.get(roomIndex) ?? [member];
  const slot = Math.max(0, group.indexOf(member));
  const count = group.length;
  const base = roomPos[roomIndex] ?? { x: 0, y: 0 };
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const areaTop = 26;
  const areaH = ROOM_H - areaTop - 8;
  return {
    x: base.x + ((col + 1) * ROOM_W) / (cols + 1),
    y: base.y + areaTop + ((row + 1) * areaH) / (rows + 1),
  };
}

function buildSchematic(): void {
  const ship = run.ship;
  const layout = computeLayout(ship);
  roomPos = layout.pos;
  svgEl.setAttribute(
    "viewBox",
    `0 0 ${layout.width} ${layout.height}`,
  );
  svgEl.replaceChildren();
  roomGroups = new Map();
  roomCondBars = new Map();
  roomSysLabels = new Map();

  // Connections first, under the rooms.
  for (const room of ship.rooms) {
    for (const next of room.neighbors) {
      if (next < room.index) continue;
      const a = layout.pos[room.index] as RoomPos;
      const b = layout.pos[next] as RoomPos;
      svgEl.appendChild(
        svg("line", {
          x1: a.x + ROOM_W / 2,
          y1: a.y + ROOM_H / 2,
          x2: b.x + ROOM_W / 2,
          y2: b.y + ROOM_H / 2,
          class: "edge",
        }),
      );
    }
  }

  for (const room of ship.rooms) {
    const p = layout.pos[room.index] as RoomPos;
    const group = svg("g", { class: "room" });
    group.appendChild(
      svg("rect", {
        x: p.x,
        y: p.y,
        width: ROOM_W,
        height: ROOM_H,
        rx: 9,
        class: "room-rect",
      }),
    );
    const name = svg("text", {
      x: p.x + ROOM_W / 2,
      y: p.y + 16,
      class: "room-name",
    });
    name.textContent = room.name;
    group.appendChild(name);
    const sysLabel = svg("text", {
      x: p.x + ROOM_W / 2,
      y: p.y + ROOM_H - 12,
      class: "room-sys",
    });
    group.appendChild(sysLabel);
    roomSysLabels.set(room.index, sysLabel);
    if (ship.systemsInRoom(room.index).length > 0) {
      group.appendChild(
        svg("rect", {
          x: p.x + 6,
          y: p.y + ROOM_H - 8,
          width: ROOM_W - 12,
          height: 4,
          rx: 2,
          class: "condbar-bg",
        }),
      );
      const bar = svg("rect", {
        x: p.x + 6,
        y: p.y + ROOM_H - 8,
        width: ROOM_W - 12,
        height: 4,
        rx: 2,
        fill: "#57c465",
      });
      group.appendChild(bar);
      roomCondBars.set(room.index, bar);
    }
    svgEl.appendChild(group);
    roomGroups.set(room.index, group);
  }

  // Crew dots on top.
  dots = new Map();
  const occupants = occupantsByRoom();
  run.crew.forEach((member, i) => {
    const color = PALETTE[i % PALETTE.length] as string;
    const group = svg("g", { class: "crew-dot" });
    const circle = svg("circle", { r: 8.5, fill: color, class: "core" });
    const letter = svg("text", { y: 3 });
    letter.setAttribute(
      "fill",
      luminance(color) > 0.55 ? "#131a26" : "#f4f7fb",
    );
    letter.textContent = member.name.charAt(0);
    group.appendChild(circle);
    group.appendChild(letter);
    svgEl.appendChild(group);
    const target = slotTarget(member, occupants);
    dots.set(member.id, {
      group,
      member,
      x: target.x,
      y: target.y,
      tx: target.x,
      ty: target.y,
    });
  });
}

function occupantsByRoom(): Map<number, CrewMember[]> {
  const map = new Map<number, CrewMember[]>();
  for (const member of run.crew) {
    const list = map.get(member.room) ?? [];
    list.push(member);
    map.set(member.room, list);
  }
  return map;
}

// ------------------------------------------------------------ crew panel

interface CrewUi {
  row: HTMLDivElement;
  bars: Map<NeedKey, HTMLDivElement>;
}
let crewUi = new Map<string, CrewUi>();

function buildCrewPanel(): void {
  crewPanel.replaceChildren();
  crewUi = new Map();
  run.crew.forEach((member, i) => {
    const color = PALETTE[i % PALETTE.length] as string;
    const row = document.createElement("div");
    row.className = "crew-row";
    row.dataset.crew = member.id;

    const swatch = document.createElement("div");
    swatch.className = "swatch";
    swatch.style.background = color;
    row.appendChild(swatch);

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
      selectCrew(selectedCrew === member.id ? null : member.id);
    });
    crewPanel.appendChild(row);
    crewUi.set(member.id, { row, bars });
  });
}

function selectCrew(id: string | null): void {
  selectedCrew = id;
  for (const [crewId, ui] of crewUi) {
    ui.row.classList.toggle("selected", crewId === id);
  }
  for (const [crewId, dot] of dots) {
    dot.group.classList.toggle("selected", crewId === id);
  }
  refreshLineDims();
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
    }
    for (const line of renderer.push(event)) {
      allLines.push(line);
      appendLineToDom(line);
    }
  }
}

// ---------------------------------------------------------------- voyage

function startVoyage(seed: number): void {
  run = createRun({ seed });
  renderer = createChronicleRenderer();
  seenEvents = 0;
  allLines = [];
  selectedCrew = null;
  accumulator = 0;
  weatherName = CONFIG.weather.states[0] ?? "calm";
  chronicleEl.replaceChildren();
  shipNameEl.textContent = run.ship.name;
  seedInput.value = String(seed);
  buildSchematic();
  buildCrewPanel();
  drainEvents(); // ship_generated and crew_generated header lines
  updateHeader();
  updateSlowUi();
  const url = new URL(window.location.href);
  url.searchParams.set("seed", String(seed));
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

let shownTick = -1;
function updateHeader(): void {
  if (run.tick === shownTick) return;
  shownTick = run.tick;
  const clock = shipClock(run.tick);
  clockDayEl.textContent = String(clock.day);
  clockTimeEl.textContent = clock.time;
  hashEl.textContent = run.hash().slice(0, 10);
  eventCountEl.textContent = String(run.world.events.size);
}

function updateSlowUi(): void {
  weatherNameEl.textContent = weatherName;
  weatherBanner.classList.toggle("storm", weatherName === "radiation storm");

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
  }

  for (const room of run.ship.rooms) {
    const systems = run.ship.systemsInRoom(room.index);
    const bar = roomCondBars.get(room.index);
    const group = roomGroups.get(room.index);
    const label = roomSysLabels.get(room.index);
    if (systems.length === 0) continue;
    let worst = systems[0] as (typeof systems)[number];
    for (const system of systems) {
      if (system.condition < worst.condition) worst = system;
    }
    if (bar !== undefined) {
      const width = Math.max(0, (ROOM_W - 12) * worst.condition);
      bar.setAttribute("width", width.toFixed(1));
      bar.setAttribute(
        "fill",
        worst.condition < 0.35
          ? "#e5534b"
          : worst.condition < 0.65
            ? "#e8a33d"
            : "#57c465",
      );
    }
    if (label !== undefined) {
      label.textContent =
        systems.length === 1
          ? `${worst.name} ${Math.round(worst.condition * 100)}%`
          : `${worst.name} ${Math.round(worst.condition * 100)}% +${systems.length - 1}`;
    }
    if (group !== undefined) {
      group.classList.toggle("damaged", worst.condition < 0.5);
    }
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

  // Crew dots glide toward their rooms.
  const occupants = occupantsByRoom();
  const blend = Math.min(1, dtMs / 220);
  for (const dot of dots.values()) {
    const target = slotTarget(dot.member, occupants);
    dot.tx = target.x;
    dot.ty = target.y;
    dot.x += (dot.tx - dot.x) * blend;
    dot.y += (dot.ty - dot.y) * blend;
    dot.group.setAttribute("transform", `translate(${dot.x.toFixed(1)} ${dot.y.toFixed(1)})`);
  }

  if (nowMs - lastSlowUiMs > 200) {
    lastSlowUiMs = nowMs;
    updateSlowUi();
    updateHeader();
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
  } else if (event.key >= "1" && event.key <= "6") {
    setSpeed(Number(event.key) - 1);
  }
});

// ------------------------------------------------------------------ boot

const params = new URLSearchParams(window.location.search);
const initialSeed = Number(params.get("seed") ?? "42") || 42;
setSpeed(speedIndex);
setPlaying(true);
startVoyage(initialSeed);
requestAnimationFrame(frame);
