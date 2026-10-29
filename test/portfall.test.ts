import { describe, expect, it } from "vitest";
import { ReplaySource } from "../src/decision/decisions.ts";
import { starterDeck } from "../src/entities/cards.ts";
import { createRun, runSimulation } from "../src/sim.ts";
import {
  canTrade,
  checkPortfallState,
  createPortfallState,
  fieldDeck,
  recordPortfallMatch,
  type PortfallCard,
} from "../src/world/portfall.ts";

describe("PORTFALL collections and fielding", () => {
  it("with no pulls, the fielded deck is exactly the starter deck", () => {
    const run = createRun({ seed: 42 });
    const member = run.crew[0] as (typeof run.crew)[number];
    expect(fieldDeck(run.portfall, 42, member.id)).toEqual(
      starterDeck(42, member.id),
    );
  });

  it("a strong pull fields at once and pushes the weakest starter out", () => {
    const run = createRun({ seed: 42 });
    const member = run.crew[0] as (typeof run.crew)[number];
    const state = run.portfall;
    const card: PortfallCard = {
      suit: "coin",
      power: 7,
      originPort: 0,
      originName: "Test Port",
      factionName: "Free port",
      stamp: "Test Port",
      acquiredTick: 0,
      acquiredOrder: state.nextOrder++,
      owners: ["c1"],
    };
    (state.collections[member.id] as PortfallCard[]).push(card);
    const deck = fieldDeck(state, 42, member.id);
    expect(deck).toHaveLength(12);
    expect(deck).toContain(card);
    // The starter ladder totals 52 and holds exactly one 2: the
    // 7 takes its seat, so the fielded total is 52 - 2 + 7.
    expect(deck.reduce((n, c) => n + c.power, 0)).toBe(57);
    expect(deck.some((c) => c.power === 2)).toBe(false);
    checkPortfallState(state, run.crew);
  });

  it("the league books wins, losses, draws, and points", () => {
    const run = createRun({ seed: 42 });
    const state = createPortfallState(run.crew);
    recordPortfallMatch(state, "c0", "c1", "c0");
    recordPortfallMatch(state, "c0", "c1", "");
    expect(state.league.c0).toEqual({ w: 1, l: 0, d: 1, points: 4 });
    expect(state.league.c1).toEqual({ w: 0, l: 1, d: 1, points: 1 });
    expect(state.matches).toBe(2);
    checkPortfallState(state, run.crew);
  });
});

describe("PORTFALL trading law", () => {
  it("friends may trade, a grudge forbids it, one-way warmth is not enough", () => {
    const run = createRun({ seed: 42 });
    const a = run.crew[0] as (typeof run.crew)[number];
    const b = run.crew[1] as (typeof run.crew)[number];
    a.beliefs.trust[b.id] = 0.3;
    b.beliefs.trust[a.id] = 0.3;
    expect(canTrade(run.portfall, a, b, run.crew, 1)).toBe(true);

    a.beliefs.grudges.push(b.id);
    expect(canTrade(run.portfall, a, b, run.crew, 1)).toBe(false);
    a.beliefs.grudges.splice(a.beliefs.grudges.indexOf(b.id), 1);

    b.beliefs.trust[a.id] = -0.1;
    expect(canTrade(run.portfall, a, b, run.crew, 1)).toBe(false);

    // And a pair that already traded this stay is done for the stay.
    b.beliefs.trust[a.id] = 0.3;
    run.portfall.tradedPairs.add(`1:${[a.id, b.id].sort().join(":")}`);
    expect(canTrade(run.portfall, a, b, run.crew, 1)).toBe(false);
  });
});

describe("PORTFALL at the ports (seed 42)", () => {
  it("packets land stamped, trades move provenance, and the league reconciles", () => {
    const run = createRun({ seed: 42 });
    run.run(240 * 144);
    const events = run.world.events;
    expect(events.countOf("portfall_packet")).toBeGreaterThan(0);
    expect(events.countOf("portfall_trade")).toBeGreaterThan(0);
    expect(run.portfall.packets).toBe(events.countOf("portfall_packet"));
    expect(run.portfall.trades).toBe(events.countOf("portfall_trade"));
    expect(run.portfall.matches).toBe(events.countOf("leisure_game"));

    let acquired = 0;
    let wins = 0;
    let losses = 0;
    for (const member of run.crew) {
      const entry = run.portfall.league[member.id];
      expect(entry).toBeDefined();
      wins += entry?.w ?? 0;
      losses += entry?.l ?? 0;
      for (const card of run.portfall.collections[member.id] ?? []) {
        acquired++;
        expect(card.stamp).toBe(card.originName);
        expect(card.stamp).not.toBe("");
        expect(card.factionName).not.toBe("");
        for (const owner of card.owners) {
          expect(run.crew.some((m) => m.id === owner)).toBe(true);
        }
      }
    }
    expect(wins).toBe(losses);
    expect(acquired).toBe(run.portfall.nextOrder);
    expect(acquired).toBeGreaterThan(50);
    checkPortfallState(run.portfall, run.crew);
  }, 120_000);

  it("replaying across packets and trades reproduces the run exactly", () => {
    const ticks = 8_000;
    const live = runSimulation({ seed: 42 }, ticks);
    expect(live.world.events.countOf("portfall_packet")).toBeGreaterThan(0);
    const source = new ReplaySource(live.decisions);
    const replayed = runSimulation({ seed: 42 }, ticks, source);
    expect(replayed.world.events.hash()).toBe(live.world.events.hash());
    expect(replayed.world.events.size).toBe(live.world.events.size);
    source.assertFullyConsumed();
  }, 120_000);
});
