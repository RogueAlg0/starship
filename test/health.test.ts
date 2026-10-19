import { describe, expect, it } from "vitest";
import { UtilitySource } from "../src/decision/decisions.ts";
import { Engine, World } from "../src/engine/engine.ts";
import { generateCrew } from "../src/entities/crew.ts";
import { CONFIG } from "../src/scenario/config.ts";
import { createRun, type RunContext } from "../src/sim.ts";
import { generateShip } from "../src/world/ship.ts";
import {
  bookHarm,
  createHealthState,
  ledgerTotals,
  stepHealth,
  woundMember,
} from "../src/world/health.ts";
import { createStores } from "../src/world/stores.ts";
import { Weather } from "../src/world/weather.ts";

const TPD = CONFIG.time.ticksPerDay;

/** The ledger identity: health is exactly what the ledger says. */
function expectLedgerIdentity(run: RunContext): void {
  for (const member of run.crew) {
    const total = member.body.ledger.reduce((sum, e) => sum + e.amount, 0);
    expect(
      Math.abs(member.body.health - (1 - total)),
      `ledger identity for ${member.id}`,
    ).toBeLessThan(1e-6);
    expect(member.body.health).toBeGreaterThanOrEqual(0);
    expect(member.body.health).toBeLessThanOrEqual(1);
  }
}

/**
 * Hold the cascade's preconditions against the crew's repair
 * work: life support pinned sick, the oxygen store pinned dry.
 * Called every few ticks, so a repair begun is a repair undone.
 */
function pinCascade(run: RunContext): void {
  for (const system of run.ship.systems) {
    if (system.kind === "life support") {
      system.condition = 0.2;
      system.damaged = true;
    }
  }
  run.stores.byKey.oxygen.qtyMilli = 0;
}

describe("the harm ledger", () => {
  it("reconciles exactly after a natural 30-day run", () => {
    const run = createRun({ seed: 42 });
    run.run(30 * TPD);
    expectLedgerIdentity(run);
  });

  it("woundMember books the wound, the harm, and the lasting mark", () => {
    const run = createRun({ seed: 42 });
    const member = run.crew[2] as (typeof run.crew)[number];
    const before = member.body.health;
    woundMember(run.world, member, "accident", "legs", 0.6);
    expect(member.body.wounds.legs.severity).toBeCloseTo(0.6, 6);
    expect(member.body.health).toBeCloseTo(
      before - 0.6 * CONFIG.health.woundImpact,
      6,
    );
    expect(member.body.marks).toContain("lame leg");
    const injuries = run.world.events.events.filter(
      (e) => e.type === "injury",
    );
    expect(injuries.length).toBe(1);
    expect(injuries[0]?.data.person).toBe(member.id);
    expectLedgerIdentity(run);
  });

  it("an infected wound keeps booking harm until it is treated or heals", () => {
    const run = createRun({ seed: 42 });
    const member = run.crew[4] as (typeof run.crew)[number];
    woundMember(run.world, member, "accident", "torso", 0.5);
    member.body.wounds.torso.infected = true;
    const bookedBefore = ledgerTotals(member).infection ?? 0;
    run.run(3 * TPD);
    const bookedAfter = ledgerTotals(member).infection ?? 0;
    expect(bookedAfter).toBeGreaterThan(bookedBefore);
    expectLedgerIdentity(run);
  });
});

describe("constructed cascades", () => {
  it("thin air and an empty oxygen store kill by suffocation, through the ledger", () => {
    const run = createRun({ seed: 42 });
    // Life support sick but not failed (no doom, no ship lost):
    // air quality falls shipwide, and the oxygen store is dry.
    pinCascade(run);
    // One member starts the slide ahead of the ship (booked to
    // the same cause, through the same door): the cascade is
    // shipwide and even, so without a leader the able-crew count
    // crosses its line before any single body reaches zero, and
    // the ending under test becomes the collapse, not the death.
    const leader = run.crew[3] as (typeof run.crew)[number];
    bookHarm(leader, 0, "suffocation", 0.55);
    let deaths = 0;
    for (let step = 0; step < 45 * (TPD / 36) && deaths === 0; step++) {
      run.run(36);
      deaths = run.world.events.countOf("death");
      pinCascade(run);
    }
    expect(deaths).toBeGreaterThanOrEqual(1);
    expect(run.health.deaths.length).toBeGreaterThanOrEqual(1);
    expect(run.health.deaths[0]?.topCause).toBe("suffocation");
    const dead = run.crew.find((m) => m.id === run.health.deaths[0]?.memberId);
    expect(dead?.dead).toBe(true);
    expect(dead?.body.health).toBe(0);
    // The death is the ledger, whole: nothing arrived from nowhere.
    const totals = ledgerTotals(dead as (typeof run.crew)[number]);
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    expectLedgerIdentity(run);
  });

  it("grudge violence lands through the ledger and names its attacker", () => {
    // A health-only harness: the real generation order, only the
    // health system stepped, so nobody wanders off between the
    // arrangement and the act. (In the full sim the same gates
    // apply; co-location there is the crew's own doing.)
    const world = new World({ seed: 42 }, new UtilitySource());
    const engine = new Engine(world);
    const ship = generateShip(world.rng.get("shipgen"));
    const crew = generateCrew(
      world.rng.get("crewgen"),
      ship,
      world.rng.get("routine"),
    );
    ship.stores = createStores(crew.length);
    const health = createHealthState();
    const weather = new Weather();
    engine.addSystem({
      name: "health",
      step: (w) => stepHealth(w, health, ship, crew, weather),
    });
    const attacker = crew[1] as (typeof crew)[number];
    const victim = crew[5] as (typeof crew)[number];
    // Despair, held long: a settled grudge, broken trust, low
    // morale, an empty stomach, and the two of them in one room.
    // The chance is turned up so the gate, not the dice, is what
    // the test exercises.
    victim.room = attacker.room;
    victim.activity = "socialize";
    attacker.activity = "socialize";
    attacker.beliefs.grudges.push(victim.id);
    attacker.beliefs.trust[victim.id] = -1;
    attacker.beliefs.lowTrustSince[victim.id] = -100000;
    attacker.needs.morale = 0.1;
    attacker.needs.hunger = 0.2;
    attacker.needs.energy = 0.9;
    const saved = CONFIG.health.violenceChancePerTick;
    CONFIG.health.violenceChancePerTick = 1;
    try {
      engine.run(5);
    } finally {
      CONFIG.health.violenceChancePerTick = saved;
    }
    const attacks = world.events.events.filter((e) => e.type === "attack");
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    expect(attacks[0]?.data.attacker).toBe(attacker.id);
    expect(attacks[0]?.data.victim).toBe(victim.id);
    expect(health.lastViolence?.attackerId).toBe(attacker.id);
    const violence = ledgerTotals(victim).violence ?? 0;
    expect(violence).toBeGreaterThan(0);
    for (const member of crew) {
      const total = member.body.ledger.reduce((sum, e) => sum + e.amount, 0);
      expect(Math.abs(member.body.health - (1 - total))).toBeLessThan(1e-6);
    }
  });
});

describe("death comes only through the ledger", () => {
  it("every death in a 90-day run is a body whose ledger sums to one", () => {
    const run = createRun({ seed: 30 });
    run.run(90 * TPD);
    for (const death of run.health.deaths) {
      const member = run.crew.find((m) => m.id === death.memberId);
      expect(member?.dead).toBe(true);
      expect(member?.body.health).toBe(0);
      const totals = ledgerTotals(member as (typeof run.crew)[number]);
      const sum = Object.values(totals).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }
    expectLedgerIdentity(run);
  }, 60_000);
});
