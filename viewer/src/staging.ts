// Staging: engine events, re-staged in the world at the moment they
// are shown. The reference squad viewer turns every event into timed
// visual effects in its render loop (a burst of fire becomes tracers
// with travel time); this layer is the shipboard version of that
// grammar, built from the drama this sim actually has: sabotage,
// failure, repair, and the weather arriving.
//
// Three parts, all pure state (no DOM), all wall-clock:
// - Staged effects: a sabotage flashes wrong at the culprit's system
//   for the god-witness; a system that fails bursts sparks and vents
//   vapour; a finished repair rings green; a radiation storm makes
//   the navigation lights strobe as it arrives.
// - Telegraphs: a system in its worst band COUGHS — irregular bigger
//   spark bursts, a strobing warning lamp, a thin smoke wisp — so a
//   failure approaches before it lands. The middle band only
//   sputters, rarely.
// - Shake: staged events kick the deck. Contributions decay as
//   (1 - T/span)^2, halve when the event's room is on the deck the
//   viewer is not watching, sum under a cap, and vanish entirely
//   under prefers-reduced-motion.
//
// Effects are capped and coalesced: within a short window, one
// effect per system, the most severe kind winning, because at high
// playback speed a burst of drained events must read as the worst
// thing that happened, not as a queue. Particles live in their own
// bounded pool, beside the deck's spark budget, not inside it.

import { hash01 } from "./faces.ts";

export type StageKind = "sabotage" | "failure" | "repaired" | "storm";

/** A system's equipment position, in canvas pixels. */
export interface StageAnchor {
  px: number;
  py: number;
}

/** Resolve a system's anchor on a given deck, or null if it has none. */
export type AnchorFor = (
  systemId: string,
  deck: number,
) => StageAnchor | null;

/** One system's live state, as the staging sync reads it. */
export interface StageSystemState {
  id: string;
  /** Condition in [0, 1]. */
  condition: number;
  failed: boolean;
  /** The deck the system's room lives on. */
  deck: number;
}

/** The slice of canvas context the staging draw uses. */
export interface StageCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
}

export const MAX_STAGED_EFFECTS = 300;
export const MAX_STAGE_PARTICLES = 160;
export const SHAKE_CAP_PX = 7;
export const SHAKE_SPAN_MS = 450;
export const CRITICAL_BELOW = 0.3;
export const MAJOR_BELOW = 0.6;

/** Two events on one system inside this window are one burst. */
const COALESCE_WINDOW_MS = 120;
/** Wall-ms each staged kind stays on screen. */
const SPAN_MS: Record<StageKind, number> = {
  sabotage: 900,
  failure: 1200,
  repaired: 800,
  storm: 800,
};
const SEVERITY: Record<StageKind, number> = {
  storm: 0,
  repaired: 1,
  sabotage: 2,
  failure: 3,
};
const SABOTAGE_SHAKE = 1.5;
const FAILURE_SHAKE = 5;
const STORM_SHAKE = 3;
/** Half-period of the warning lamp for a system in its worst band. */
const LAMP_FAST_MS = 170;
const LAMP_SLOW_MS = 450;

const SABOTAGE_COLOURS = ["#fff3f0", "#ff5a4a", "#ffb35c"];
const DAMAGE_COLOURS = ["#ffd76a", "#ffb35c", "#ff7847"];
const VAPOUR_COLOUR = "#aebacd";
const SMOKE_COLOUR = "#6e7a8d";

function strSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 100000);
}

type Band = "critical" | "major" | "ok";

function bandOf(condition: number, failed: boolean): Band {
  if (failed || condition < CRITICAL_BELOW) return "critical";
  if (condition < MAJOR_BELOW) return "major";
  return "ok";
}

interface StagedEffect {
  kind: StageKind;
  systemId: string | null;
  /** Deck the effect belongs to; -1 is ship-wide (a storm). */
  deck: number;
  anchor: StageAnchor | null;
  bornMs: number;
  spanMs: number;
  seed: number;
}

interface StageParticle {
  kind: "spark" | "vapour" | "smoke";
  systemId: string | null;
  deck: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornMs: number;
  spanMs: number;
  seed: number;
  colour: string;
}

interface ShakeKick {
  amp: number;
  deck: number;
  bornMs: number;
}

interface TrackedSystem {
  condition: number;
  failed: boolean;
  deck: number;
  band: Band;
}

export class StagingLayer {
  private readonly reducedMotion: () => boolean;
  private effects: StagedEffect[] = [];
  private particles: StageParticle[] = [];
  private kicks: ShakeKick[] = [];
  private systems = new Map<string, TrackedSystem>();
  /** False until the first condition sync seeds the baseline bands. */
  private seeded = false;
  private coughAt = new Map<string, number>();
  private sputterAt = new Map<string, number>();
  private smokeAcc = new Map<string, number>();
  private lastStormMs = Number.NEGATIVE_INFINITY;
  private seq = 0;

  constructor(reducedMotion: () => boolean = () => false) {
    this.reducedMotion = reducedMotion;
  }

  // ------------------------------------------------------------ intake

  /**
   * Stage one event. Sabotage, failure, and repair belong to a
   * system (anchor may be null when the deck has no prop for it: the
   * shake still lands, the picture has nowhere to hang). A storm is
   * ship-wide: systemId null, deck -1.
   */
  stage(
    kind: StageKind,
    systemId: string | null,
    deck: number,
    anchor: StageAnchor | null,
    nowMs: number,
  ): void {
    // A storm's subject is the ship herself: two arrivals inside
    // one burst window are the same arrival, heard twice.
    if (kind === "storm" && nowMs - this.lastStormMs < COALESCE_WINDOW_MS) {
      return;
    }
    if (systemId !== null) {
      const existing = this.effects.find(
        (e) =>
          e.systemId === systemId &&
          nowMs - e.bornMs < COALESCE_WINDOW_MS &&
          e.bornMs + e.spanMs > nowMs,
      );
      if (existing !== undefined) {
        if (SEVERITY[kind] <= SEVERITY[existing.kind]) return;
        // The worse news replaces the lesser inside the same burst:
        // its sparks go with it, its smoke (a telegraph) stays.
        this.effects = this.effects.filter((e) => e !== existing);
        this.particles = this.particles.filter(
          (p) => !(p.systemId === systemId && p.kind !== "smoke"),
        );
      }
    }
    const seed = strSeed(systemId ?? "ship") + ++this.seq;
    this.effects.push({
      kind,
      systemId,
      deck,
      anchor,
      bornMs: nowMs,
      spanMs: SPAN_MS[kind],
      seed,
    });
    this.trimEffects();
    if (anchor !== null && systemId !== null) {
      if (kind === "sabotage") {
        this.spawnSparks(systemId, deck, anchor, 9, 26, SABOTAGE_COLOURS, nowMs, seed);
      } else if (kind === "failure") {
        this.spawnSparks(systemId, deck, anchor, 12, 34, DAMAGE_COLOURS, nowMs, seed);
        this.spawnPuff(systemId, deck, anchor, 6, nowMs, seed);
      }
    }
    if (kind === "sabotage") {
      this.stageKick(SABOTAGE_SHAKE, deck, nowMs);
    } else if (kind === "failure") {
      this.stageKick(FAILURE_SHAKE, deck, nowMs);
    } else if (kind === "storm") {
      this.lastStormMs = nowMs;
      // A storm that arrives on top of a blowout adds nothing: the
      // failure's kick is already the ship flinching.
      const covered = this.kicks.some(
        (k) => k.amp >= FAILURE_SHAKE && nowMs - k.bornMs < 60,
      );
      if (!covered) this.stageKick(STORM_SHAKE, -1, nowMs);
    }
  }

  /**
   * Feed the live condition of every system. A crossing INTO the
   * critical band (below 30%, or the failed flag) stages a failure
   * effect; returns the ids that crossed this call. The first call
   * only seeds the baseline, so a ship never departs in a burst of
   * staged failures for damage it was generated with.
   */
  syncSystems(
    states: readonly StageSystemState[],
    nowMs: number,
    anchorFor: AnchorFor,
  ): string[] {
    const crossed: string[] = [];
    for (const state of states) {
      const band = bandOf(state.condition, state.failed);
      const prev = this.systems.get(state.id);
      this.systems.set(state.id, {
        condition: state.condition,
        failed: state.failed,
        deck: state.deck,
        band,
      });
      if (!this.seeded) continue;
      if (band === "critical" && (prev === undefined || prev.band !== "critical")) {
        crossed.push(state.id);
        this.stage(
          "failure",
          state.id,
          state.deck,
          anchorFor(state.id, state.deck),
          nowMs,
        );
      }
    }
    this.seeded = true;
    return crossed;
  }

  // --------------------------------------------------------- telegraphs

  /**
   * Advance the failure telegraphs for the visible deck. A critical
   * system coughs (an irregular bigger spark burst plus vapour) every
   * 2 to 5 seconds, the interval re-rolled from a hash of the system
   * and the time bucket so no two systems cough in step, breathes a
   * thin smoke wisp, and strobes its lamp (see lampOn). A system in
   * the middle band only sputters: a rare, slightly bigger puff every
   * 6 to 11 seconds, on top of the deck's standing damage sparks.
   */
  updateTelegraphs(
    nowMs: number,
    dtMs: number,
    visibleDeck: number,
    anchorFor: AnchorFor,
  ): void {
    for (const [id, sys] of this.systems) {
      if (sys.deck !== visibleDeck || sys.band === "ok") continue;
      const anchor = anchorFor(id, sys.deck);
      if (anchor === null) continue;
      const seed = strSeed(id);
      if (sys.band === "critical") {
        let next = this.coughAt.get(id);
        if (next === undefined) {
          next = nowMs + this.coughInterval(id, nowMs) * hash01(seed, 77);
          this.coughAt.set(id, next);
        }
        if (nowMs >= next) {
          this.spawnSparks(id, sys.deck, anchor, 7, 40, DAMAGE_COLOURS, nowMs, seed + Math.floor(nowMs / 1000));
          this.spawnPuff(id, sys.deck, anchor, 2, nowMs, seed + 5);
          this.coughAt.set(id, nowMs + this.coughInterval(id, nowMs));
        }
        let acc = (this.smokeAcc.get(id) ?? 0) + dtMs;
        while (acc >= 380) {
          acc -= 380;
          this.spawnSmoke(id, sys.deck, anchor, nowMs);
        }
        this.smokeAcc.set(id, acc);
      } else {
        let next = this.sputterAt.get(id);
        if (next === undefined) {
          next = nowMs + this.sputterInterval(id, nowMs) * hash01(seed, 91);
          this.sputterAt.set(id, next);
        }
        if (nowMs >= next) {
          this.spawnSparks(id, sys.deck, anchor, 2, 30, DAMAGE_COLOURS, nowMs, seed + Math.floor(nowMs / 1000));
          this.spawnPuff(id, sys.deck, anchor, 2, nowMs, seed + 9);
          this.sputterAt.set(id, nowMs + this.sputterInterval(id, nowMs));
        }
      }
    }
  }

  /** Cough interval for a system: 2 to 5 s, hash of system + bucket. */
  private coughInterval(id: string, nowMs: number): number {
    const bucket = Math.floor(nowMs / 1000);
    return 2000 + hash01(strSeed(id), bucket) * 3000;
  }

  /** Sputter interval for the middle band: 6 to 11 s, same recipe. */
  private sputterInterval(id: string, nowMs: number): number {
    const bucket = Math.floor(nowMs / 1000);
    return 6000 + hash01(strSeed(id), bucket + 31) * 5000;
  }

  /**
   * Whether a system's warning lamp is lit at this instant. Critical
   * systems strobe at the fast period; anything else keeps the
   * deck's standing slow blink.
   */
  lampOn(systemId: string, nowMs: number): boolean {
    const sys = this.systems.get(systemId);
    const period =
      sys !== undefined && sys.band === "critical" ? LAMP_FAST_MS : LAMP_SLOW_MS;
    const phase = hash01(strSeed(systemId), 53) * 2;
    return Math.floor(nowMs / period + phase) % 2 === 0;
  }

  /**
   * Navigation-light strobe brightness from the last storm arrival:
   * two pulses inside the storm effect's span, then nothing. The
   * deck multiplies its nav lights by this while a storm stages.
   */
  navStrobe(nowMs: number): number {
    const age = nowMs - this.lastStormMs;
    if (age < 0 || age > SPAN_MS.storm) return 0;
    const pulse = (centre: number): number =>
      Math.max(0, 1 - Math.abs(age - centre) / 90);
    return Math.min(1, Math.max(pulse(70), pulse(390)));
  }

  // -------------------------------------------------------------- shake

  /** Add one shake contribution. Public: the harness drives it raw. */
  stageKick(amp: number, deck: number, nowMs: number): void {
    this.kicks.push({ amp, deck, bornMs: nowMs });
  }

  /**
   * The total shake amplitude in pixels at this instant: each kick
   * contributes amp * (1 - T/span)^2, halved when its deck is not
   * the visible one, summed and capped. Ship-wide kicks (deck -1)
   * are never halved.
   */
  shakeAmplitude(nowMs: number, viewDeck: number): number {
    let total = 0;
    for (const kick of this.kicks) {
      const t = nowMs - kick.bornMs;
      if (t < 0 || t >= SHAKE_SPAN_MS) continue;
      const decay = (1 - t / SHAKE_SPAN_MS) ** 2;
      const deckFactor = kick.deck < 0 || kick.deck === viewDeck ? 1 : 0.5;
      total += kick.amp * decay * deckFactor;
    }
    return Math.min(SHAKE_CAP_PX, total);
  }

  /**
   * The deck's shake offset for this frame: whole-pixel jitter on
   * incommensurate sine/cosine frequencies, the reference viewer's
   * recipe. Zero under prefers-reduced-motion, always: the gate is
   * checked here so no caller can forget it.
   */
  shakeOffset(nowMs: number, viewDeck: number): { x: number; y: number } {
    if (this.reducedMotion()) return { x: 0, y: 0 };
    this.kicks = this.kicks.filter((k) => nowMs - k.bornMs < SHAKE_SPAN_MS);
    const amp = this.shakeAmplitude(nowMs, viewDeck);
    if (amp < 0.4) return { x: 0, y: 0 };
    return {
      x: Math.round(amp * Math.sin(nowMs * 0.097)),
      y: Math.round(amp * Math.cos(nowMs * 0.083)),
    };
  }

  // -------------------------------------------------------------- draws

  /**
   * Paint the staged effects and the staging particle pool for the
   * visible deck. Positions are pure functions of each particle's
   * age, so a frame is a recompute, never an integration.
   */
  draw(ctx: StageCtx, nowMs: number, visibleDeck: number): void {
    this.effects = this.effects.filter((e) => nowMs - e.bornMs < e.spanMs);
    this.particles = this.particles.filter((p) => nowMs - p.bornMs < p.spanMs);

    // Sabotage washes first: the red flicker sits on the prop, under
    // its own sparks.
    for (const effect of this.effects) {
      if (effect.kind !== "sabotage" || effect.deck !== visibleDeck) continue;
      if (effect.anchor === null) continue;
      const age = nowMs - effect.bornMs;
      const fade = 1 - age / effect.spanMs;
      const bucket = Math.floor(age / 60);
      const hot = hash01(effect.seed, bucket) > 0.35;
      ctx.globalAlpha = (hot ? 0.3 : 0.06) * fade;
      ctx.fillStyle = "#e63c28";
      ctx.fillRect(effect.anchor.px - 4, effect.anchor.py - 2, 10, 9);
    }
    ctx.globalAlpha = 1;

    // Particles: sparks fall a little, vapour rises and spreads,
    // smoke curls as it thins.
    for (const p of this.particles) {
      if (p.deck !== visibleDeck) continue;
      const ageS = (nowMs - p.bornMs) / 1000;
      const frac = (nowMs - p.bornMs) / p.spanMs;
      if (p.kind === "spark") {
        const drag = 1 - 0.35 * frac;
        const x = p.x + p.vx * ageS * drag;
        const y = p.y + p.vy * ageS * drag + 26 * ageS * ageS;
        ctx.globalAlpha = (1 - frac) * 0.95;
        ctx.fillStyle = p.colour;
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      } else if (p.kind === "vapour") {
        const x = p.x + p.vx * ageS;
        const y = p.y + p.vy * ageS;
        const size = Math.round(2 + frac * 5);
        ctx.globalAlpha = 0.3 * (1 - frac) * Math.min(1, frac * 5);
        ctx.fillStyle = p.colour;
        ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      } else {
        const x = p.x + p.vx * ageS + Math.sin(ageS * 2 + p.seed) * 2;
        const y = p.y + p.vy * ageS;
        const size = Math.round(1 + frac * 3);
        ctx.globalAlpha = 0.2 * (1 - frac);
        ctx.fillStyle = p.colour;
        ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      }
    }
    ctx.globalAlpha = 1;

    // Failure flash and repair rings ride on top of their sparks.
    for (const effect of this.effects) {
      if (effect.deck !== visibleDeck || effect.anchor === null) continue;
      const age = nowMs - effect.bornMs;
      const frac = age / effect.spanMs;
      if (effect.kind === "failure" && age < 130) {
        ctx.globalAlpha = 0.5 * (1 - age / 130);
        ctx.fillStyle = "#ffb35c";
        ctx.fillRect(effect.anchor.px - 4, effect.anchor.py - 2, 10, 9);
      } else if (effect.kind === "repaired") {
        const r = Math.round(2 + frac * 13);
        ctx.globalAlpha = 0.8 * (1 - frac);
        ctx.strokeStyle = "#7fd4a8";
        ctx.lineWidth = 1;
        ctx.strokeRect(effect.anchor.px - r, effect.anchor.py - r + 2, r * 2, r * 2);
        ctx.globalAlpha = 0.1 * (1 - frac);
        ctx.fillStyle = "#7fd4a8";
        ctx.fillRect(effect.anchor.px - 4, effect.anchor.py - 2, 10, 9);
      }
    }
    ctx.globalAlpha = 1;
  }

  // --------------------------------------------------------- inspection

  /** Live staged effects (test and harness surface). */
  effectCount(): number {
    return this.effects.length;
  }

  /** Live staging particles (test and harness surface). */
  particleCount(): number {
    return this.particles.length;
  }

  /** Kinds of the live staged effects, oldest first. */
  effectKinds(): StageKind[] {
    return this.effects.map((e) => e.kind);
  }

  // ------------------------------------------------------------ spawning

  private trimEffects(): void {
    while (this.effects.length > MAX_STAGED_EFFECTS) {
      let worst = 0;
      for (let i = 1; i < this.effects.length; i++) {
        const a = this.effects[i] as StagedEffect;
        const b = this.effects[worst] as StagedEffect;
        if (
          SEVERITY[a.kind] < SEVERITY[b.kind] ||
          (SEVERITY[a.kind] === SEVERITY[b.kind] && a.bornMs < b.bornMs)
        ) {
          worst = i;
        }
      }
      this.effects.splice(worst, 1);
    }
  }

  /** Make room in the particle pool: smoke yields, then vapour. */
  private makeParticleRoom(): boolean {
    if (this.particles.length < MAX_STAGE_PARTICLES) return true;
    for (const kind of ["smoke", "vapour"] as const) {
      const idx = this.particles.findIndex((p) => p.kind === kind);
      if (idx >= 0) {
        this.particles.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  private spawnSparks(
    systemId: string,
    deck: number,
    anchor: StageAnchor,
    count: number,
    spread: number,
    colours: readonly string[],
    nowMs: number,
    seed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      if (!this.makeParticleRoom()) return;
      const h1 = hash01(seed, i * 7 + 1);
      const h2 = hash01(seed, i * 11 + 3);
      this.particles.push({
        kind: "spark",
        systemId,
        deck,
        x: anchor.px + (h1 - 0.5) * 5,
        y: anchor.py + (h2 - 0.5) * 3,
        vx: (h1 - 0.5) * spread,
        vy: -(3 + h2 * spread * 0.55),
        bornMs: nowMs,
        spanMs: 300 + h1 * 400,
        seed: seed + i,
        colour: colours[Math.floor(h2 * colours.length)] ?? colours[0] as string,
      });
    }
  }

  private spawnPuff(
    systemId: string,
    deck: number,
    anchor: StageAnchor,
    count: number,
    nowMs: number,
    seed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      if (!this.makeParticleRoom()) return;
      const h1 = hash01(seed, i * 13 + 7);
      const h2 = hash01(seed, i * 17 + 11);
      this.particles.push({
        kind: "vapour",
        systemId,
        deck,
        x: anchor.px + (h1 - 0.5) * 4,
        y: anchor.py - 1,
        vx: (h1 - 0.5) * 4,
        vy: -(6 + h2 * 6),
        bornMs: nowMs,
        spanMs: 900 + h1 * 400,
        seed: seed + i,
        colour: VAPOUR_COLOUR,
      });
    }
  }

  private spawnSmoke(
    systemId: string,
    deck: number,
    anchor: StageAnchor,
    nowMs: number,
  ): void {
    if (!this.makeParticleRoom()) return;
    const seed = strSeed(systemId) + ++this.seq;
    const h1 = hash01(seed, 23);
    this.particles.push({
      kind: "smoke",
      systemId,
      deck,
      x: anchor.px + (h1 - 0.5) * 3,
      y: anchor.py - 2,
      vx: (h1 - 0.5) * 1.5,
      vy: -(3.5 + h1 * 2),
      bornMs: nowMs,
      spanMs: 2600,
      seed,
      colour: SMOKE_COLOUR,
    });
  }
}
