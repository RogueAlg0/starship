// Stores: what the ship eats, burns, and breathes.
//
// Five stores — food, water, oxygen margin, fuel, spare parts —
// each tracked in integer milli-units with a fractional carry for
// the per-tick flows, and read in days of supply: quantity over
// the day's draw. Production is a system's rate times its
// condition; consumption is the crew living and the engines
// burning; ports refill by character, under no money system at
// all: charter right and reciprocity, capped by the table.
//
// The stores system also runs the port call: the manifest in the
// first hours, shore leave in rotations, harbour news once, and
// the small dishonesties scarcity breeds — theft by a hoarding
// hand, which the beliefs machinery hears about only through
// witnesses and tallies, never through truth. Rationing used to
// be imposed here as the quartermaster's interim emergency act;
// the Council owns it now (src/world/council.ts), and this system
// only reads the disposed level in its consumption arithmetic.

import type { World } from "../engine/engine.ts";
import type { CrewMember } from "../entities/crew.ts";
import { currentBlock } from "../entities/routine.ts";
import { r3 } from "../log/events.ts";
import { driftSuspicion } from "../perception/beliefs.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Port, Sector, Voyage } from "./galaxy.ts";
import type { Ship } from "./ship.ts";
import { applyConditionDelta, clamp01 } from "./systems.ts";
import type { Traffic } from "./traffic.ts";

export const STORE_KEYS = ["food", "water", "oxygen", "fuel", "parts"] as const;
export type StoreKey = (typeof STORE_KEYS)[number];

export const STORE_LABELS: Record<StoreKey, string> = {
  food: "Food",
  water: "Water",
  oxygen: "Oxygen margin",
  fuel: "Fuel",
  parts: "Spare parts",
};

/** The system kind that produces (or, for fuel, burns) a store. */
export const STORE_PRODUCER_KIND: Record<StoreKey, string> = {
  food: "hydroponics rig",
  water: "water recycler",
  oxygen: "life support",
  fuel: "engines",
  parts: "engines",
};

export interface StoreState {
  /** Absolute quantity, integer milli-units. */
  qtyMilli: number;
  capMilli: number;
  /** Fractional milli-units carried between ticks. */
  carry: number;
  /** Threshold arming: a crossing speaks once, then stays silent
   *  until the store climbs back above threshold + hysteresis. */
  lowArmed: boolean;
  critArmed: boolean;
}

/** Signed flow sums, in milli-units, for the accounting identity:
 *  initial + produced + resupplied + consumed + charged = on hand. */
export interface StoreTotals {
  producedMilli: number;
  consumedMilli: number;
  resuppliedMilli: number;
  chargedMilli: number;
}

export interface PendingDiscrepancy {
  thiefId: string;
  atTick: number;
  /** The thief was glimpsed near the stores: suspicion may land. */
  partial: boolean;
  shortMilli: number;
}

export interface PortCallState {
  stayIndex: number;
  port: number;
  startTick: number;
  endTick: number;
  resupplied: boolean;
  newsDone: boolean;
  /** Tick the call's one flavour incident fires, or null. */
  incidentTick: number | null;
  leaveBlockIndex: number;
  leaveCounts: Record<string, number>;
  assistSystemId: string | null;
  assistAnnounced: boolean;
}

export interface StoresState {
  byKey: Record<StoreKey, StoreState>;
  totals: Record<StoreKey, StoreTotals>;
  initialMilli: Record<StoreKey, number>;
  crewCount: number;
  rationing: Record<"food" | "water", boolean>;
  /** The council's disposed level per rationed store, when the
   *  Council has set one: "reduced" or "strict". Null when the
   *  store is not rationed. Owned by the council system; the
   *  stores flows only read the level's consumption factor. */
  rationLevel: Record<"food" | "water", "reduced" | "strict" | null>;
  /** Food hidden away per member, in milli-units. Not ship state
   *  the crew can see: it exists so the accounting reconciles. */
  caches: Record<string, number>;
  cacheEatenMilli: number;
  discrepancies: PendingDiscrepancy[];
  deadInSpace: boolean;
  lastStrainDay: number;
  call: PortCallState | null;
  /** Standing net flow per day (production minus consumption),
   *  refreshed every tick: the viewer's trend arrows read it. */
  netMilliPerDay: Record<StoreKey, number>;
}

const ZERO_TOTALS = (): StoreTotals => ({
  producedMilli: 0,
  consumedMilli: 0,
  resuppliedMilli: 0,
  chargedMilli: 0,
});

/** The day's draw for a store, in milli-units: what "one day of
 *  supply" means for it. */
export function dailyUseMilli(state: StoresState, key: StoreKey): number {
  switch (key) {
    case "food":
    case "water":
    case "oxygen":
      return state.crewCount * 1000;
    case "fuel":
      return (
        CONFIG.galaxy.cruiseLightDaysPerDay *
        CONFIG.stores.fuelMilliPerLightDay
      );
    case "parts":
      return 1000;
  }
}

/** Days of supply on hand for a store. */
export function daysOf(state: StoresState, key: StoreKey): number {
  return state.byKey[key].qtyMilli / dailyUseMilli(state, key);
}

/** A fresh set of stores for a departing ship. */
export function createStores(crewCount: number): StoresState {
  const cfg = CONFIG.stores;
  const probe: StoresState = {
    byKey: {} as Record<StoreKey, StoreState>,
    totals: {} as Record<StoreKey, StoreTotals>,
    initialMilli: {} as Record<StoreKey, number>,
    crewCount,
    rationing: { food: false, water: false },
    rationLevel: { food: null, water: null },
    caches: {},
    cacheEatenMilli: 0,
    discrepancies: [],
    deadInSpace: false,
    lastStrainDay: -1,
    call: null,
    netMilliPerDay: { food: 0, water: 0, oxygen: 0, fuel: 0, parts: 0 },
  };
  for (const key of STORE_KEYS) {
    const capMilli = Math.round(
      cfg.capacityDays[key] * dailyUseMilli(probe, key),
    );
    const qtyMilli = Math.round(capMilli * cfg.departureFraction[key]);
    probe.byKey[key] = {
      qtyMilli,
      capMilli,
      carry: 0,
      lowArmed: qtyMilli / dailyUseMilli(probe, key) >= cfg.lowDays + cfg.hysteresisDays,
      critArmed:
        qtyMilli / dailyUseMilli(probe, key) >=
        cfg.criticalDays + cfg.hysteresisDays,
    };
    probe.totals[key] = ZERO_TOTALS();
    probe.initialMilli[key] = qtyMilli;
  }
  return probe;
}

type FlowBucket = "producedMilli" | "consumedMilli" | "resuppliedMilli";

/**
 * Move a (possibly fractional) quantity through a store. Whole
 * milli-units land in the quantity, clamped to [0, capacity]; the
 * fraction carries to the next tick. The totals record what
 * actually landed, so the books always reconcile.
 */
function applyFlow(
  state: StoresState,
  key: StoreKey,
  deltaMilli: number,
  bucket: FlowBucket,
): void {
  const store = state.byKey[key];
  store.carry += deltaMilli;
  const whole = Math.trunc(store.carry);
  if (whole === 0) return;
  store.carry -= whole;
  const next = Math.min(store.capMilli, Math.max(0, store.qtyMilli + whole));
  const applied = next - store.qtyMilli;
  store.qtyMilli = next;
  state.totals[key][bucket] += applied;
}

function systemCondition(ship: Ship, kind: string): number {
  const system = ship.systems.find((s) => s.kind === kind);
  return system === undefined ? 0 : system.condition;
}

/**
 * Whether engineering is staffed: the department is on watch —
 * any member whose role covers the reactor or the engines is
 * awake, aboard, and out of their sleep block. (An earlier rule
 * asked for a hand physically at work in an engineering room; it
 * measured 16 to 52 percent uptime depending on the ship's habits
 * and starved the fabricator on calm ships. A workshop runs while
 * its department stands its watches, which is the fiction and the
 * steadier arithmetic.)
 */
function engineeringStaffed(
  crew: readonly CrewMember[],
  tick: number,
): boolean {
  return crew.some(
    (m) =>
      !m.ashore &&
      (m.affinity.includes("engines") || m.affinity.includes("reactor")) &&
      currentBlock(m, tick) !== "sleep",
  );
}

/** Production per day for a store, from its system's condition. */
export function productionMilliPerDay(
  state: StoresState,
  ship: Ship,
  crew: readonly CrewMember[],
  key: StoreKey,
  tick: number,
): number {
  const cfg = CONFIG.stores;
  switch (key) {
    case "food":
      return (
        cfg.productionFactor.food *
        dailyUseMilli(state, key) *
        systemCondition(ship, STORE_PRODUCER_KIND.food)
      );
    case "water":
      return (
        cfg.productionFactor.water *
        dailyUseMilli(state, key) *
        systemCondition(ship, STORE_PRODUCER_KIND.water)
      );
    case "oxygen":
      return (
        cfg.productionFactor.oxygen *
        dailyUseMilli(state, key) *
        systemCondition(ship, STORE_PRODUCER_KIND.oxygen)
      );
    case "fuel":
      return 0;
    case "parts":
      return engineeringStaffed(crew, tick)
        ? cfg.partsMilliPerDay *
            ((systemCondition(ship, "reactor") +
              systemCondition(ship, "engines")) /
              2)
        : 0;
  }
}

/** Consumption per day for a store. Rationing bends food and
 *  water; the engines burn by the mile under way, by the sip in
 *  port; parts are consumed by repairs, not by the clock. */
export function consumptionMilliPerDay(
  state: StoresState,
  key: StoreKey,
  underway: boolean,
): number {
  const cfg = CONFIG.stores;
  switch (key) {
    case "food":
      return (
        dailyUseMilli(state, key) *
        (state.rationing.food
          ? state.rationLevel.food === "strict"
            ? cfg.rationing.strictFactor
            : cfg.rationing.consumptionFactor
          : 1)
      );
    case "water":
      return (
        dailyUseMilli(state, key) *
        (state.rationing.water
          ? state.rationLevel.water === "strict"
            ? cfg.rationing.strictFactor
            : cfg.rationing.consumptionFactor
          : 1)
      );
    case "oxygen":
      return dailyUseMilli(state, key);
    case "fuel":
      return underway
        ? dailyUseMilli(state, key)
        : dailyUseMilli(state, key) * cfg.fuelDockedFraction;
    case "parts":
      return 0;
  }
}

/**
 * Repairs pay for the condition they restore, out of the parts
 * locker. Returns the delta the locker allows: the full amount
 * when it can pay, what the remaining parts buy when it cannot,
 * and a jury-rigged crawl at the shortfall floor when it is empty.
 * Called from the crew's repair branch, the one repair door.
 */
export function gateRepairDelta(ship: Ship, delta: number, tick = -1): number {
  const state = ship.stores;
  if (state === null || delta <= 0) return delta;
  const cfg = CONFIG.stores;
  const parts = state.byKey.parts;
  const cost = Math.max(1, Math.round(delta * cfg.repairPartsMilliPerCondition));
  if (parts.qtyMilli >= cost) {
    parts.qtyMilli -= cost;
    state.totals.parts.chargedMilli -= cost;
    return delta;
  }
  if (parts.qtyMilli > 0) {
    const paid = parts.qtyMilli;
    parts.qtyMilli = 0;
    state.totals.parts.chargedMilli -= paid;
    return paid / cfg.repairPartsMilliPerCondition;
  }
  // Under the council's emergency powers, stores seizure and
  // unrestricted access raise the jury-rig floor: a ship fighting
  // for her life strips fittings a calmer ship would spare.
  const emergency =
    ship.councilPublic !== null && tick < ship.councilPublic.emergencyUntil;
  return delta * (emergency ? 0.7 : cfg.repairPartsShortfallFloor);
}

export interface ManifestEntry {
  store: StoreKey;
  addedMilli: number;
  /** The store now stands at capacity: the manifest says "full". */
  full: boolean;
}

/**
 * Take aboard what a port of this character can give: each store
 * rises toward the character's fraction of capacity, never above
 * it, and fuel never leaves a ship shorter than the departure
 * floor. Pure state arithmetic; the caller speaks the event.
 */
export function applyResupply(
  state: StoresState,
  character: string,
): ManifestEntry[] {
  const cfg = CONFIG.stores;
  const table = cfg.port.supply[character] ?? {};
  const manifest: ManifestEntry[] = [];
  for (const key of STORE_KEYS) {
    const store = state.byKey[key];
    let fraction = table[key] ?? 0;
    if (key === "fuel") {
      fraction = Math.max(fraction, cfg.port.minDepartureFuelFraction);
    }
    const target = Math.min(store.capMilli, Math.round(store.capMilli * fraction));
    const added = Math.max(0, target - store.qtyMilli);
    if (added > 0) {
      store.qtyMilli += added;
      state.totals[key].resuppliedMilli += added;
    }
    if (added > 0 || store.qtyMilli >= store.capMilli) {
      manifest.push({
        store: key,
        addedMilli: added,
        full: store.qtyMilli >= store.capMilli,
      });
    }
  }
  return manifest;
}

function quartermaster(crew: readonly CrewMember[]): CrewMember | undefined {
  return crew.find((m) => m.roleKey === "quartermaster");
}

/** Harbour news for a call: a ship berthed here, a ship lately
 *  gone, or failing those, the port's rumour. Colour only in this
 *  build: no belief moves on harbour talk yet. */
function emitHarbourNews(
  w: World,
  sector: Sector,
  traffic: Traffic,
  port: Port,
): void {
  const rng = w.rng.get("stores");
  const berthed = traffic.ships.find((s) => s.portAt(w.tick) === port.index);
  if (berthed !== undefined) {
    w.emit("harbour_news", [], {
      port: port.name,
      kind: "berthing",
      ship: berthed.name,
      type: berthed.type,
    });
    return;
  }
  let recent: { name: string; type: string; daysAgo: number } | null = null;
  for (const ship of traffic.ships) {
    for (const leg of ship.legs) {
      if (leg.to !== port.index) continue;
      const ago = w.tick - leg.arriveTick;
      if (ago < 0 || ago > 10 * CONFIG.time.ticksPerDay) continue;
      if (recent === null || ago < recent.daysAgo) {
        recent = {
          name: ship.name,
          type: ship.type,
          daysAgo: Math.max(1, Math.round(ago / CONFIG.time.ticksPerDay)),
        };
      }
    }
  }
  if (recent !== null) {
    w.emit("harbour_news", [], {
      port: port.name,
      kind: "recent",
      ship: recent.name,
      type: recent.type,
      daysAgo: recent.daysAgo,
    });
    return;
  }
  const faction =
    port.faction !== null
      ? sector.factionAt(port.faction)
      : sector.factions[rng.int(sector.factions.length)];
  w.emit("harbour_news", [], {
    port: port.name,
    kind: "rumour",
    faction: faction === undefined ? "the port authority" : faction.name,
    variant: rng.int(CONFIG.stores.port.rumourLines.length),
  });
}

/** Begin a port call: schedule its beats across the stay. */
function beginCall(
  w: World,
  state: StoresState,
  sector: Sector,
  voyage: Voyage,
): void {
  const stay = voyage.stayAt(w.tick);
  if (stay === null) return;
  const rng = w.rng.get("stores");
  const stayTicks = stay.departTick - stay.arriveTick;
  state.call = {
    stayIndex: stay.index,
    port: stay.port,
    startTick: w.tick,
    endTick: w.tick + stayTicks,
    resupplied: false,
    newsDone: false,
    incidentTick: rng.chance(CONFIG.stores.port.incidentChance)
      ? w.tick +
        12 +
        rng.int(Math.max(1, stayTicks - 24))
      : null,
    leaveBlockIndex: -1,
    leaveCounts: {},
    assistSystemId: null,
    assistAnnounced: false,
  };
  // Arrival does not lift rationing by itself any more: the
  // Council disposes of rations now, and its daily lift vote reads
  // the resupplied counters like any other recovery.
}

function closeCall(state: StoresState, crew: readonly CrewMember[]): void {
  for (const member of crew) member.ashore = false;
  state.call = null;
}

/** The port call's beats for one tick: manifest, repair assist,
 *  shore leave, news, and the one flavour incident. */
function runCall(
  w: World,
  state: StoresState,
  ship: Ship,
  crew: readonly CrewMember[],
  sector: Sector,
  traffic: Traffic,
): void {
  const call = state.call;
  if (call === null) return;
  const cfg = CONFIG.stores.port;
  const port = sector.portAt(call.port);
  const rng = w.rng.get("stores");

  if (!call.resupplied && w.tick >= call.startTick + cfg.resupplyDelayTicks) {
    call.resupplied = true;
    const manifest = applyResupply(state, port.character);
    w.emit("resupply", [], {
      port: port.name,
      character: port.character,
      gift: port.character === "shrine",
      manifest: manifest.map((entry) => ({
        store: entry.store,
        days: r3(entry.addedMilli / dailyUseMilli(state, entry.store)),
        full: entry.full,
      })),
    });
    if (port.character === "shrine") {
      for (const member of crew) {
        member.needs.morale = clamp01(
          member.needs.morale + cfg.shrineMoraleGift,
        );
      }
    }
    if (port.character === "company town") {
      w.emit("port_dues", [], { port: port.name });
    }
    if (port.character === "shipyard") {
      let worst = ship.systems[0];
      for (const system of ship.systems) {
        if (worst === undefined || system.condition < worst.condition) {
          worst = system;
        }
      }
      if (worst !== undefined) call.assistSystemId = worst.id;
    }
  }

  if (call.assistSystemId !== null) {
    const system = ship.systemById(call.assistSystemId);
    if (system.condition < 1) {
      applyConditionDelta(w, system, cfg.repairAssistPerTick, null, "work");
      if (!call.assistAnnounced) {
        call.assistAnnounced = true;
        w.emit("repair_assist", [], {
          port: port.name,
          system: system.id,
          systemName: system.name,
        });
      }
    }
  }

  // Shore leave: a fresh rotation each block, off-watch crew only,
  // fewest leaves first so the whole ship gets its turn ashore.
  const blockIndex = Math.floor((w.tick - call.startTick) / cfg.leaveBlockTicks);
  if (blockIndex !== call.leaveBlockIndex && w.tick < call.endTick) {
    call.leaveBlockIndex = blockIndex;
    for (const member of crew) member.ashore = false;
    const eligible = crew
      .filter((m) => currentBlock(m, w.tick) === "free")
      .sort(
        (a, b) =>
          (call.leaveCounts[a.id] ?? 0) - (call.leaveCounts[b.id] ?? 0) ||
          crew.indexOf(a) - crew.indexOf(b),
      );
    const group = eligible.slice(0, cfg.leaveGroupSize);
    if (group.length > 0) {
      for (const member of group) {
        member.ashore = true;
        call.leaveCounts[member.id] = (call.leaveCounts[member.id] ?? 0) + 1;
      }
      w.emit("shore_leave", group.map((m) => m.id), {
        port: port.name,
        members: group.map((m) => m.id),
        count: group.length,
      });
    }
  }

  if (!call.newsDone && w.tick >= call.startTick + cfg.newsDelayTicks) {
    call.newsDone = true;
    emitHarbourNews(w, sector, traffic, port);
  }

  if (call.incidentTick !== null && w.tick >= call.incidentTick) {
    call.incidentTick = null;
    w.emit("port_incident", [], {
      port: port.name,
      variant: rng.int(CONFIG.stores.port.incidentLines.length),
    });
  }
}

/** One day's temptation, drawn once: scarcity, a hoarding trait,
 *  and a stores-stream draw. Witnesses make evidence; an empty
 *  room makes a discrepancy the tally will find later. */
function drawTheft(
  w: World,
  state: StoresState,
  ship: Ship,
  crew: readonly CrewMember[],
): void {
  const cfg = CONFIG.stores.theft;
  const food = state.byKey.food;
  if (food.qtyMilli <= cfg.takeMilli) return;
  const eligible = crew.filter(
    (m) => !m.ashore && m.traits.includes("hoarding"),
  );
  if (eligible.length === 0) return;
  const rng = w.rng.get("stores");
  if (!rng.chance(cfg.chancePerDay)) return;
  const thief = rng.pick(eligible);

  food.qtyMilli -= cfg.takeMilli;
  state.caches[thief.id] = (state.caches[thief.id] ?? 0) + cfg.takeMilli;

  const storesRoom = ship.systems.find(
    (s) => s.kind === STORE_PRODUCER_KIND.food,
  )?.room;
  const witness =
    storesRoom === undefined
      ? undefined
      : crew.find(
          (m) =>
            m !== thief &&
            !m.ashore &&
            m.room === storesRoom &&
            m.activity !== "rest",
        );
  if (witness !== undefined) {
    driftSuspicion(witness.beliefs, thief.id, cfg.witnessSuspicion);
    w.emit("theft", [thief.id, witness.id], {
      thief: thief.id,
      witness: witness.id,
      witnessed: true,
      days: r3(cfg.takeMilli / dailyUseMilli(state, "food")),
    });
    return;
  }
  w.emit("theft", [thief.id], {
    thief: thief.id,
    witness: null,
    witnessed: false,
    days: r3(cfg.takeMilli / dailyUseMilli(state, "food")),
  });
  // Partial evidence: someone awake in a room adjoining the stores
  // could have glimpsed a figure. Not proof; a direction to look.
  let partial = false;
  if (storesRoom !== undefined) {
    const neighbours = (ship.rooms[storesRoom]?.neighbors ?? []).concat(
      storesRoom,
    );
    partial = crew.some(
      (m) =>
        m !== thief &&
        !m.ashore &&
        m.activity !== "rest" &&
        neighbours.includes(m.room),
    );
  }
  state.discrepancies.push({
    thiefId: thief.id,
    atTick:
      w.tick +
      cfg.inventoryMinDelayTicks +
      rng.int(cfg.inventoryDelaySpanTicks),
    partial,
    shortMilli: cfg.takeMilli,
  });
}

/** The stores system: flows, thresholds, rationing, temptation,
 *  and the port call, in that order, every tick. */
export function stepStores(
  w: World,
  ship: Ship,
  crew: readonly CrewMember[],
  galaxy: { sector: Sector; voyage: Voyage; traffic: Traffic },
): void {
  const state = ship.stores;
  if (state === null) return;
  const cfg = CONFIG.stores;
  const tpd = CONFIG.time.ticksPerDay;
  const { sector, voyage, traffic } = galaxy;
  const inPort = voyage.inPortAt(w.tick);
  const underway = !inPort;

  // ---- the port call's frame: begin, run, close.
  const stay = voyage.stayAt(w.tick);
  if (
    state.call !== null &&
    (stay === null || stay.index !== state.call.stayIndex)
  ) {
    closeCall(state, crew);
  }
  if (stay !== null && state.call === null) {
    beginCall(w, state, sector, voyage);
  }
  if (state.call !== null) runCall(w, state, ship, crew, sector, traffic);
  if (!inPort) {
    for (const member of crew) member.ashore = false;
  }

  // ---- fuel and the drift: an empty tank under way slows the
  // voyage clock to the drift rate — momentum, not a full stop.
  // The span is voyage state, so replay reproduces the same slow
  // hours. Drift must never be zero progress: fuel rises only in
  // port, so a frozen clock would strand the ship forever. At a
  // quarter rate she still makes port, days late and humbled;
  // the balance gate's job is to see she never has to.
  const fuel = state.byKey.fuel;
  if (underway && fuel.qtyMilli <= 0 && !state.deadInSpace) {
    state.deadInSpace = true;
    const leg = voyage.currentLegAt(w.tick);
    voyage.beginDrift(w.tick);
    w.emit("dead_in_space", [], {
      boundFor: leg === null ? null : sector.portAt(leg.to).name,
      distanceLeft:
        leg === null
          ? null
          : r3(
              leg.distanceLightDays *
                (1 -
                  (voyage.voyageTimeAt(w.tick) - leg.departTick) /
                    (leg.arriveTick - leg.departTick)),
            ),
    });
  }
  if (state.deadInSpace && (!underway || fuel.qtyMilli > 0)) {
    state.deadInSpace = false;
    voyage.endDrift(w.tick);
  }

  // ---- production and consumption, the standing flows.
  for (const key of STORE_KEYS) {
    const produced = productionMilliPerDay(state, ship, crew, key, w.tick);
    const consumed = consumptionMilliPerDay(state, key, underway);
    if (produced !== 0) {
      applyFlow(state, key, produced / tpd, "producedMilli");
    }
    if (consumed !== 0) {
      applyFlow(state, key, -consumed / tpd, "consumedMilli");
    }
    state.netMilliPerDay[key] = produced - consumed;
  }

  // ---- caches feed their owners in secret, a day's snack at the
  // day boundary: the ship's books lose the food at the theft, and
  // this is where it goes.
  if (w.tick % tpd === 0) {
    for (const member of crew) {
      const cache = state.caches[member.id] ?? 0;
      if (cache <= 0 || member.needs.hunger >= 0.95) continue;
      const eaten = Math.min(cache, cfg.theft.cacheEatMilliPerDay);
      state.caches[member.id] = cache - eaten;
      state.cacheEatenMilli += eaten;
      member.needs.hunger = clamp01(
        member.needs.hunger + 0.25 * (eaten / cfg.theft.cacheEatMilliPerDay),
      );
    }
  }

  // ---- thresholds: a crossing speaks once per arming.
  for (const key of STORE_KEYS) {
    const store = state.byKey[key];
    const days = daysOf(state, key);
    if (!store.lowArmed && days >= cfg.lowDays + cfg.hysteresisDays) {
      store.lowArmed = true;
    }
    if (!store.critArmed && days >= cfg.criticalDays + cfg.hysteresisDays) {
      store.critArmed = true;
    }
    if (store.lowArmed && days < cfg.lowDays) {
      store.lowArmed = false;
      w.emit("stores_low", [], { store: key, days: r3(days) });
    }
    if (store.critArmed && days < cfg.criticalDays) {
      store.critArmed = false;
      w.emit("stores_critical", [], { store: key, days: r3(days) });
    }
  }

  // ---- rationing belongs to the Council now (see council.ts):
  // the quartermaster proposes, the council disposes, and the
  // captain's solo imposition is an emergency act that expires
  // unratified. The interim imposition that stood here until the
  // Council landed is retired. What remains in this system is
  // rationing's price, paid in morale while it stands.
  const qm = quartermaster(crew);
  if (state.rationing.food || state.rationing.water) {
    for (const member of crew) {
      member.needs.morale = clamp01(
        member.needs.morale - cfg.rationing.moralePerDay / tpd,
      );
    }
  }

  // ---- theft, on scarcity, once a day at the drawn hour.
  if (
    w.tick % tpd === cfg.theft.checkTickOfDay &&
    (state.rationing.food || daysOf(state, "food") < cfg.theft.scarceDays)
  ) {
    drawTheft(w, state, ship, crew);
  }

  // ---- the tally: a discrepancy comes due, and the quartermaster
  // counts what is not there.
  for (let i = state.discrepancies.length - 1; i >= 0; i--) {
    const pending = state.discrepancies[i] as PendingDiscrepancy;
    if (w.tick < pending.atTick) continue;
    state.discrepancies.splice(i, 1);
    if (pending.partial && qm !== undefined) {
      driftSuspicion(qm.beliefs, pending.thiefId, cfg.theft.partialSuspicion);
    }
    w.emit("stores_discrepancy", qm === undefined ? [] : [qm.id], {
      by: qm === undefined ? null : qm.id,
      suspect: pending.partial ? pending.thiefId : null,
      days: r3(pending.shortMilli / dailyUseMilli(state, "food")),
    });
  }

  // ---- zero stores: needs-level pressure here (morale, a
  // straining life support). The bodily consequences of an empty
  // store (starvation, dehydration, suffocation) are booked to
  // the cause ledger by the health system, under the Consequences
  // chapter's model and nothing else.
  if (state.byKey.food.qtyMilli <= 0) {
    for (const member of crew) {
      member.needs.morale = clamp01(
        member.needs.morale - cfg.zero.foodMoralePerDay / tpd,
      );
    }
  }
  if (state.byKey.oxygen.qtyMilli <= 0) {
    const lifeSupport = ship.systems.find((s) => s.kind === "life support");
    if (lifeSupport !== undefined) {
      applyConditionDelta(
        w,
        lifeSupport,
        -cfg.zero.oxygenStrainPerDay / tpd,
        null,
        "wear",
      );
    }
    const day = Math.floor(w.tick / tpd);
    if (day !== state.lastStrainDay) {
      state.lastStrainDay = day;
      w.emit("life_support_strain", [], {});
    }
  }
}

/** Invariant check: every store inside its tank, caches honest. */
export function checkStoresState(state: StoresState): void {
  for (const key of STORE_KEYS) {
    const store = state.byKey[key];
    if (
      !Number.isInteger(store.qtyMilli) ||
      store.qtyMilli < 0 ||
      store.qtyMilli > store.capMilli
    ) {
      throw new Error(
        `store ${key} out of range: ${store.qtyMilli} of ${store.capMilli}`,
      );
    }
  }
  for (const [id, cache] of Object.entries(state.caches)) {
    if (!Number.isInteger(cache) || cache < 0) {
      throw new Error(`cache of ${id} out of range: ${cache}`);
    }
  }
}
