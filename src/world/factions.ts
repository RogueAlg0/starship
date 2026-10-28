/**
 * Standing: the ship's reputation with the galactic factions.
 *
 * DESIGN, the galaxy chapter: factions are the sector's powers,
 * and the ship lives among them. Slice 1 keeps the ledger
 * honest and small: standing lives in [-1, 1] per faction and
 * is moved by the voyage itself. Calling at a faction's port
 * warms them (you came, you traded); staying a while warms
 * them more. Temperament bends the warmth: a greedy faction
 * loves a long stay (your business), an insular one warms
 * slowly whatever you do. Crossing a band (cold, unregarded,
 * warm, honoured) is news and is emitted once per crossing;
 * the feed carries it as word from the wider world.
 *
 * Later slices add the colder movers: theft in their ports,
 * course votes that snub them, and what factions DO with
 * standing (prices, welcomes, liaison officers).
 */
import { CONFIG } from "../scenario/config.ts";
import type { World } from "../engine/engine.ts";
import { r3 } from "../log/events.ts";
import type { Sector } from "./galaxy.ts";

export interface FactionStanding {
  /** Standing per faction id, in [-1, 1]. */
  byId: Record<string, number>;
  /** The band each faction currently holds the ship in. */
  band: Record<string, string>;
  eventCursor: number;
}

export function bandOf(standing: number): string {
  const f = CONFIG.factions;
  if (standing < f.coldLine) return "cold";
  if (standing >= f.honouredLine) return "honoured";
  if (standing >= f.warmLine) return "warm";
  return "unregarded";
}

export function createFactionStanding(sector: Sector): FactionStanding {
  const byId: Record<string, number> = {};
  const band: Record<string, string> = {};
  for (const f of sector.factions) {
    byId[f.id] = 0;
    band[f.id] = bandOf(0);
  }
  return { byId, band, eventCursor: 0 };
}

export function stepFactionStanding(
  w: World,
  standing: FactionStanding,
  sector: Sector,
): void {
  const f = CONFIG.factions;
  const events = w.events.events;
  while (standing.eventCursor < events.length) {
    const ev = events[standing.eventCursor] as (typeof events)[number];
    standing.eventCursor++;
    if (ev.type !== "port_call" && ev.type !== "arrival") continue;
    const portIndex = ev.data["portIndex"];
    if (typeof portIndex !== "number") continue;
    const port = sector.portAt(portIndex);
    if (port.faction === null) continue;
    const faction = sector.factionAt(port.faction);
    let gain = f.arrivalGain;
    const stayDays = ev.data["stayDays"];
    if (
      ev.type === "port_call" &&
      typeof stayDays === "number" &&
      stayDays >= f.stayBonusDays
    ) {
      gain +=
        faction.temperament === "greedy" ? f.stayBonus * 1.5 : f.stayBonus;
    }
    if (faction.temperament === "insular") gain *= 0.6;
    const next = Math.max(
      -1,
      Math.min(1, (standing.byId[faction.id] ?? 0) + gain),
    );
    standing.byId[faction.id] = next;
    const band = bandOf(next);
    if (band !== standing.band[faction.id]) {
      standing.band[faction.id] = band;
      w.emit("faction_standing", [], {
        faction: faction.id,
        name: faction.name,
        kind: faction.kind,
        temperament: faction.temperament,
        band,
        standing: r3(next),
      });
    }
  }
}

export function checkFactionState(
  sector: Sector,
  standing: FactionStanding,
): string[] {
  const problems: string[] = [];
  for (const f of sector.factions) {
    const v = standing.byId[f.id];
    if (v === undefined) {
      problems.push(`faction ${f.id} has no standing entry`);
    } else if (v < -1 || v > 1) {
      problems.push(`faction ${f.id} standing ${v} outside [-1, 1]`);
    }
    if (standing.band[f.id] !== bandOf(v ?? 0)) {
      problems.push(
        `faction ${f.id} band ${standing.band[f.id]} disagrees with its standing`,
      );
    }
  }
  return problems;
}
