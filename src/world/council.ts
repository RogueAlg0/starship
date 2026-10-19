// The Ship's Council (the Council chapter).
//
// Seven seats worn over roles: Captain, First Officer, Chief
// Engineer, Chief Medical Officer (the medic), Security Chief,
// Science Officer, Quartermaster. The cook sits on none of them,
// deliberately. The captain commands between sittings; the council
// is where command becomes judgment, and judgment is made of
// beliefs, so it can be wrong in ways that outlive the meeting.
//
// A sitting judges from beliefs alone. Every vote is computed
// from four inspectable terms (evidence as the officer holds it,
// trust in the motion's people, trait and portfolio leanings,
// bond blocs) and NO vote ever touches an RNG stream: the table
// has no dice. Testimony enters belief stores discounted by
// trust in the teller, a guilty party can push a scapegoat, and
// consequences flow from the FINDING, never from the truth.
//
// Jurisdiction built here: boards of inquiry (death automatic;
// sabotage above a damage threshold; stores theft with a named
// suspect; a Security-certified accusation), rationing (the
// quartermaster proposes, the council disposes; the captain's
// emergency imposition expires unratified), discipline short of
// inquiry, emergency powers with expiring grants and harder
// renewals, and relief of the captain. Deferred, with their
// inputs unbuilt: admissions and course/port decisions (crew
// arrivals and distress calls do not exist yet).

import type { World } from "../engine/engine.ts";
import type { CrewMember } from "../entities/crew.ts";
import { r3 } from "../log/events.ts";
import {
  bondOf,
  driftSuspicion,
  driftTrust,
  suspicionOf,
  trustOf,
} from "../perception/beliefs.ts";
import { CONFIG } from "../scenario/config.ts";
import type { Sector, Voyage } from "./galaxy.ts";
import type { HealthState } from "./health.ts";
import { ledgerSummary } from "./health.ts";
import type { Ship } from "./ship.ts";
import { daysOf, type StoresState } from "./stores.ts";

export interface SeatDef {
  key: string;
  seat: string;
  role: string;
}

export const SEATS: readonly SeatDef[] = CONFIG.council.seats;

/** The seat key a role first wears, or null for off-council roles. */
export function seatKeyForRole(roleKey: string): string | null {
  const def = SEATS.find((s) => s.role === roleKey);
  return def === undefined ? null : def.key;
}

export interface VoteRecord {
  member: string;
  seat: string;
  choice: "for" | "against" | "abstain";
  score: number;
  evidence: number;
}

export interface VoteMotion {
  kind: string;
  accusedId?: string | null;
  accuserId?: string | null;
  proposerId?: string | null;
  victimId?: string | null;
  /** The person a relief or appointment motion is about. */
  subjectId?: string | null;
  /** Days of supply, for stores motions (the counters as tabled). */
  days?: number;
  /** Emergency severity in [0, 1], for emergency motions. */
  severity?: number;
}

interface OfficerContext {
  crew: readonly CrewMember[];
  /** The security chief's holder, whose presentation is testimony. */
  securityId: string | null;
}

/**
 * One officer's vote, computed. Pure: no RNG, no world writes.
 * The four terms are summed in order and the lines in config turn
 * the sum into a choice. Exported so tests can inspect the terms
 * directly.
 */
export function computeVote(
  officer: CrewMember,
  seatKey: string,
  motion: VoteMotion,
  ctx: OfficerContext,
): VoteRecord {
  const cfg = CONFIG.council;
  const byId = (id: string | null | undefined): CrewMember | undefined =>
    id === null || id === undefined
      ? undefined
      : ctx.crew.find((c) => c.id === id);
  const accused = byId(motion.accusedId);
  const proposer = byId(motion.proposerId);
  const accuser = byId(motion.accuserId);
  const subject = byId(motion.subjectId);

  let evidence = 0;
  let evidenceTerm = 0;
  let trustTerm = 0;
  const kind = motion.kind;
  if (kind === "inquiry" || kind === "discipline") {
    evidence = accused !== undefined ? suspicionOf(officer.beliefs, accused.id) : 0;
    // The Security Chief's presentation enters as testimony, not
    // fact: their suspicion of the accused, discounted by how
    // much this officer trusts them.
    const sec = byId(ctx.securityId);
    if (sec !== undefined && sec !== officer && accused !== undefined) {
      const discount = Math.max(0, trustOf(officer.beliefs, sec.id));
      evidence = Math.min(
        1,
        evidence + suspicionOf(sec.beliefs, accused.id) * discount * 0.15,
      );
    }
    evidenceTerm = (evidence - 0.35) * 1.7;
    if (accused !== undefined) {
      trustTerm -= trustOf(officer.beliefs, accused.id) * 0.45;
    }
    if (accuser !== undefined && accuser !== officer) {
      trustTerm += trustOf(officer.beliefs, accuser.id) * 0.25;
    }
  } else if (kind === "rationing" || kind === "ratification") {
    const days = motion.days ?? 99;
    evidence = Math.max(0, Math.min(1, (CONFIG.stores.rationing.triggerDays - days) / 12));
    evidenceTerm = (CONFIG.stores.rationing.triggerDays - days) * 0.09;
    if (proposer !== undefined && proposer !== officer) {
      trustTerm += trustOf(officer.beliefs, proposer.id) * 0.25;
    }
  } else if (kind === "lift") {
    const days = motion.days ?? 0;
    evidence = Math.max(0, Math.min(1, (days - CONFIG.stores.rationing.liftDays) / 12));
    evidenceTerm = (days - CONFIG.stores.rationing.liftDays) * 0.09;
    if (proposer !== undefined && proposer !== officer) {
      trustTerm += trustOf(officer.beliefs, proposer.id) * 0.15;
    }
  } else if (kind === "emergency") {
    evidence = motion.severity ?? 0;
    evidenceTerm = (evidence - 0.4) * 1.2;
    if (proposer !== undefined && proposer !== officer) {
      trustTerm += trustOf(officer.beliefs, proposer.id) * 0.2;
    }
  } else if (kind === "relief") {
    const captain = subject;
    const distrust =
      captain !== undefined ? -trustOf(officer.beliefs, captain.id) : 0;
    evidence = Math.max(0, Math.min(1, distrust));
    evidenceTerm = (distrust - 0.25) * 1.3;
    if (proposer !== undefined && proposer !== officer) {
      trustTerm += trustOf(officer.beliefs, proposer.id) * 0.15;
    }
  } else if (kind === "appointment") {
    const appointee = subject;
    evidence =
      appointee !== undefined
        ? Math.max(0, trustOf(officer.beliefs, appointee.id))
        : 0;
    evidenceTerm = evidence * 0.8 - 0.1;
    if (proposer !== undefined && proposer !== officer) {
      trustTerm += trustOf(officer.beliefs, proposer.id) * 0.2;
    }
  }

  // A meticulous officer weighs the evidence term harder.
  if (officer.traits.includes("meticulous")) evidenceTerm *= 1.2;

  const leanTable =
    kind === "ratification" || kind === "lift"
      ? CONFIG.council.portfolioLean.rationing
      : CONFIG.council.portfolioLean[kind];
  let lean = leanTable?.[seatKey] ?? 0;
  if (kind === "lift") lean = -lean;
  const traitFamily =
    kind === "inquiry" || kind === "discipline" ? "guilty" : "motion";
  for (const trait of officer.traits) {
    lean += CONFIG.council.traitLean[traitFamily][trait] ?? 0;
  }

  const score = evidenceTerm + trustTerm + lean;
  let choice: VoteRecord["choice"] =
    score >= cfg.voteForLine
      ? "for"
      : score <= cfg.voteAgainstLine
        ? "against"
        : "abstain";
  // The science seat votes uncertainty: thin evidence, no verdict.
  if (
    seatKey === "science officer" &&
    (kind === "inquiry" || kind === "discipline") &&
    evidence < cfg.scienceAbstainEvidence
  ) {
    choice = "abstain";
  }
  return {
    member: officer.id,
    seat: seatKey,
    choice,
    score: r3(score),
    evidence: r3(evidence),
  };
}

interface PendingSitting {
  kind: string;
  atTick: number;
  accusedId: string | null;
  accuserId: string | null;
  victimId: string | null;
  truthCulprit: string | null;
  causeKind: string;
  store: "food" | "water" | null;
  level: "reduced" | "strict" | null;
  movers: string[];
  renewal: number;
  subjectId: string | null;
}

export interface CouncilState {
  seats: Record<string, string | null>;
  /** The sixth, unnumbered store: fills from findings the crew
   *  believe honest, empties on verdicts they do not. */
  legitimacy: number;
  eventCursor: number;
  deathCursor: number;
  pending: PendingSitting[];
  rationCooldownUntil: Record<"food" | "water", number>;
  emergencyUntil: number;
  emergencyRenewals: number;
  lastEmergencyEnd: number;
  lastReliefTick: number;
  disciplineAt: Record<string, number>;
  inquiryKeys: Set<string>;
  lastInquiryTick: number;
  lastInquiryByAccused: Record<string, number>;
  putOff: string[];
  foRatification: { memberId: string; atTick: number } | null;
  foRejected: string[];
  sittingsHeld: number;
  reliefMotions: number;
}

/** Seat the council from the roster's roles, as the ship sails. */
export function createCouncil(crew: readonly CrewMember[]): CouncilState {
  const seats: Record<string, string | null> = {};
  for (const def of SEATS) {
    const holder = crew.find((m) => m.roleKey === def.role);
    seats[def.key] = holder === undefined ? null : holder.id;
  }
  return {
    seats,
    legitimacy: CONFIG.council.legitimacyStart,
    eventCursor: 0,
    deathCursor: 0,
    pending: [],
    rationCooldownUntil: { food: -1, water: -1 },
    emergencyUntil: -1,
    emergencyRenewals: 0,
    lastEmergencyEnd: -1000000,
    lastReliefTick: -1000000,
    disciplineAt: {},
    inquiryKeys: new Set(),
    lastInquiryTick: -1000000,
    lastInquiryByAccused: {},
    putOff: [],
    foRatification: null,
    foRejected: [],
    sittingsHeld: 0,
    reliefMotions: 0,
  };
}

function byId(
  crew: readonly CrewMember[],
  id: string | null,
): CrewMember | undefined {
  if (id === null) return undefined;
  return crew.find((c) => c.id === id);
}

function alive(member: CrewMember | undefined): member is CrewMember {
  return member !== undefined && !member.dead && !member.leftShip;
}

export function captainId(state: CouncilState): string | null {
  return state.seats["captain"] ?? null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Votes required to relieve: five of seven, or two-thirds of the
 *  officers actually sitting when seats stand empty. */
export function reliefRequired(sittingCount: number): number {
  return Math.min(5, Math.ceil((2 / 3) * Math.max(1, sittingCount)));
}

interface SittingFrame {
  sitting: { member: CrewMember; seatKey: string }[];
  recused: { member: string; seat: string; reason: string }[];
  chairId: string | null;
}

/**
 * Who sits for a case, and who stands aside. Recusal: the accused,
 * the accuser, the victim, anyone bonded close to any of them,
 * and a chief whose own department stands accused with a bond the
 * crew would call protection.
 */
function frameSitting(
  state: CouncilState,
  crew: readonly CrewMember[],
  motion: VoteMotion,
): SittingFrame {
  const sitting: { member: CrewMember; seatKey: string }[] = [];
  const recused: { member: string; seat: string; reason: string }[] = [];
  const accused = byId(crew, motion.accusedId ?? null);
  const victim = byId(crew, motion.victimId ?? null);
  const judicial =
    motion.kind === "inquiry" || motion.kind === "discipline" || motion.kind === "relief";
  // "Closely bonded" is relative aboard this ship: bonds saturate
  // (affinity-matched shipmates sit near 1.0 within a month), so
  // an absolute line would stand down half the bench for any
  // well-liked accused. An officer is closely bonded to a person
  // when that person is among the officer's two closest bonds
  // aboard, and the bond is warm in absolute terms as well.
  const closelyBonded = (holder: CrewMember, otherId: string): boolean => {
    const bond = bondOf(holder.beliefs, otherId);
    if (bond < CONFIG.council.recuseBond) return false;
    let closer = 0;
    for (const member of crew) {
      if (member.id === holder.id || member.id === otherId) continue;
      if (bondOf(holder.beliefs, member.id) > bond) closer++;
    }
    return closer < 2;
  };
  for (const def of SEATS) {
    const holder = byId(crew, state.seats[def.key] ?? null);
    if (!alive(holder)) continue;
    if (holder === undefined) continue;
    let reason: string | null = null;
    if (judicial) {
      if (motion.accusedId === holder.id || motion.subjectId === holder.id) {
        reason = "accused";
      } else if (motion.accuserId === holder.id) reason = "accuser";
      else if (motion.victimId === holder.id) reason = "victim";
      else if (accused !== undefined && closelyBonded(holder, accused.id)) {
        reason = "bonded to the accused";
      } else if (victim !== undefined && closelyBonded(holder, victim.id)) {
        reason = "bonded to the victim";
      } else if (
        accused !== undefined &&
        def.key.includes("chief") &&
        holder.affinity.some((a) => accused.affinity.includes(a)) &&
        bondOf(holder.beliefs, accused.id) >= CONFIG.council.recuseDeptBond
      ) {
        reason = "their own department";
      }
    }
    if (reason !== null) {
      recused.push({ member: holder.id, seat: def.key, reason });
    } else {
      sitting.push({ member: holder, seatKey: def.key });
    }
  }
  let chairId: string | null = null;
  const captainSeat = sitting.find((s) => s.seatKey === "captain");
  const foSeat = sitting.find((s) => s.seatKey === "first officer");
  if (captainSeat !== undefined) chairId = captainSeat.member.id;
  else if (foSeat !== undefined) chairId = foSeat.member.id;
  else if (sitting.length > 0) chairId = (sitting[0] as { member: CrewMember }).member.id;
  return { sitting, recused, chairId };
}

/**
 * Run a vote over the sitting officers. The captain votes only to
 * break a tie (never on relief, where the captain is the subject,
 * and never on an inquiry into themselves). Bond blocs are the
 * fourth term: an officer strongly bonded to another tends to
 * land where they land, applied as a second pass over the
 * provisional votes, in seat order.
 */
function runVote(
  state: CouncilState,
  crew: readonly CrewMember[],
  frame: SittingFrame,
  motion: VoteMotion,
): { votes: VoteRecord[]; forCount: number; againstCount: number; strength: number } {
  const secId = state.seats["security chief"] ?? null;
  const ctx: OfficerContext = { crew, securityId: secId };
  const captainEntry = frame.sitting.find((s) => s.seatKey === "captain");
  const voters = frame.sitting.filter(
    (s) => motion.kind === "relief" || s.seatKey !== "captain",
  );
  const provisional = voters.map((s) =>
    computeVote(s.member, s.seatKey, motion, ctx),
  );
  // Bloc pass: pull each score a step toward the provisional
  // choice of the officer they are most bonded to at the table.
  const votes = provisional.map((vote, i) => {
    const officer = (voters[i] as { member: CrewMember }).member;
    let bloc = 0;
    let bestBond = CONFIG.council.recuseBond;
    for (let j = 0; j < voters.length; j++) {
      if (j === i) continue;
      const other = (voters[j] as { member: CrewMember }).member;
      const bond = bondOf(officer.beliefs, other.id);
      if (bond >= bestBond) {
        bestBond = bond;
        const their = (provisional[j] as VoteRecord).choice;
        bloc = their === "for" ? 0.08 : their === "against" ? -0.08 : 0;
      }
    }
    if (bloc === 0) return vote;
    const score = vote.score + bloc;
    let choice = vote.choice;
    if (vote.choice === "abstain") {
      choice =
        score >= CONFIG.council.voteForLine
          ? "for"
          : score <= CONFIG.council.voteAgainstLine
            ? "against"
            : "abstain";
    }
    return { ...vote, score: r3(score), choice };
  });
  let forCount = votes.filter((v) => v.choice === "for").length;
  let againstCount = votes.filter((v) => v.choice === "against").length;
  // The captain's tie-break.
  if (
    forCount === againstCount &&
    captainEntry !== undefined &&
    motion.kind !== "relief"
  ) {
    const captainVote = computeVote(captainEntry.member, "captain", motion, ctx);
    votes.push(captainVote);
    if (captainVote.choice === "for") forCount++;
    else if (captainVote.choice === "against") againstCount++;
  }
  const strength = median(votes.map((v) => v.evidence));
  return { votes, forCount, againstCount, strength };
}

function emitConvened(
  w: World,
  ship: Ship,
  frame: SittingFrame,
  kind: string,
  extra: Record<string, unknown>,
): void {
  w.emit("council_convened", frame.sitting.map((s) => s.member.id), {
    kind,
    chair: frame.chairId,
    sitting: frame.sitting.map((s) => s.member.id),
    seats: frame.sitting.map((s) => ({ member: s.member.id, seat: s.seatKey })),
    recused: frame.recused,
    room: ship.firstRoomOfKind("mess"),
    ...extra,
  });
}

function vacateSeat(
  w: World,
  state: CouncilState,
  seatKey: string,
  reason: string,
): void {
  const holder = state.seats[seatKey];
  if (holder === null || holder === undefined) return;
  state.seats[seatKey] = null;
  w.emit("council_seat_vacated", [], { seat: seatKey, member: holder, reason });
}

/** Sentence a member: confinement vacates any seat they hold. */
function sentence(
  w: World,
  state: CouncilState,
  crew: readonly CrewMember[],
  member: CrewMember,
  kind: string,
  untilTick: number,
): void {
  if (kind === "brig" || kind === "quarters") {
    member.confinedUntil = Math.max(member.confinedUntil, untilTick);
  } else if (kind === "restriction") {
    member.restrictedUntil = Math.max(member.restrictedUntil, untilTick);
  } else if (kind === "mess_ban") {
    member.messBanUntil = Math.max(member.messBanUntil, untilTick);
  }
  for (const def of SEATS) {
    if (state.seats[def.key] === member.id) {
      vacateSeat(w, state, def.key, "confined");
    }
  }
  w.emit("council_sentence", [member.id], {
    member: member.id,
    sentence: kind,
    untilTick,
  });
}

/** The inquiry's fallout: grudges and legitimacy, per the village pattern. */
function inquiryFallout(
  w: World,
  state: CouncilState,
  crew: readonly CrewMember[],
  frame: SittingFrame,
  outcome: {
    accusedId: string | null;
    victimId: string | null;
    convicted: boolean;
    votes: VoteRecord[];
  },
): number {
  const victim = byId(crew, outcome.victimId);
  const accused = byId(crew, outcome.accusedId);
  // The dead person's friends inherit the grudge: trust falls,
  // and the society step forms the grudge itself if the fall
  // holds, the way it forms every grudge. (Directly pushing
  // grudges here once ignited the feud engine: every sitting
  // manufactured fresh sabotage, which manufactured sittings.)
  if (victim !== undefined && accused !== undefined) {
    for (const member of crew) {
      if (!alive(member) || member === accused || member === victim) continue;
      if (bondOf(member.beliefs, victim.id) < 0.55) continue;
      if (outcome.convicted) {
        driftTrust(member.beliefs, accused.id, -0.18);
      } else if (suspicionOf(member.beliefs, accused.id) >= 0.4) {
        // The board acquitted someone they believe guilty:
        // injustice, against the accused and against the bench.
        driftTrust(member.beliefs, accused.id, -0.1);
        if (frame.chairId !== null && frame.chairId !== member.id) {
          driftTrust(member.beliefs, frame.chairId, -0.08);
        }
      }
    }
  }
  // The convicted's friends record grievances against the bench.
  if (outcome.convicted && accused !== undefined) {
    const guiltyVoters = new Set(
      outcome.votes.filter((v) => v.choice === "for").map((v) => v.member),
    );
    for (const member of crew) {
      if (!alive(member) || member === accused) continue;
      if (bondOf(member.beliefs, accused.id) < 0.55) continue;
      for (const voterId of guiltyVoters) {
        if (voterId !== member.id) driftTrust(member.beliefs, voterId, -0.08);
      }
    }
  }
  // Legitimacy: the share of the crew whose own beliefs agree
  // with the finding moves the sixth store.
  let delta = 0;
  if (accused !== undefined) {
    const living = crew.filter((m) => alive(m));
    if (living.length > 0) {
      const agree = living.filter((m) =>
        outcome.convicted
          ? suspicionOf(m.beliefs, accused.id) >= 0.4
          : suspicionOf(m.beliefs, accused.id) < 0.4,
      ).length;
      const share = agree / living.length;
      delta = (share - 0.5) * 2 * CONFIG.council.legitimacySwing;
      state.legitimacy = Math.max(0, Math.min(1, state.legitimacy + delta));
    }
  }
  return r3(state.legitimacy);
}

/**
 * Testimony, before the votes: witnesses speak from their belief
 * stores, and what they say enters the officers' stores as
 * suspicion, discounted by trust in the teller. A guilty party
 * among the witnesses names a scapegoat instead: the least
 * trusted non-kin soul aboard.
 */
interface TestimonyStatement {
  witness: string;
  about: string;
  kind: string;
}

/**
 * Compute the sitting's testimony: belief pushes land at once
 * (the board names its accused having heard the witnesses), but
 * the statements are returned, not emitted, so the caller can
 * write the convened record first and keep the log in sitting
 * order: convened, testimony, finding.
 */
function testimony(
  crew: readonly CrewMember[],
  frame: SittingFrame,
  data: {
    victimId: string | null;
    truthCulprit: string | null;
    presentIds: string[];
    causeKind: string;
  },
): TestimonyStatement[] {
  const cfg = CONFIG.council;
  const statements: TestimonyStatement[] = [];
  const officers = frame.sitting.map((s) => s.member);
  if (officers.length === 0) return statements;
  let witnessIds: string[] = [];
  if (data.presentIds.length > 0) {
    witnessIds = data.presentIds.filter((id) => alive(byId(crew, id)));
  }
  if (witnessIds.length === 0) {
    // No one stood there: the ship's talkers testify to what they
    // hold, the strongest suspicions first.
    witnessIds = crew
      .filter((m) => alive(m) && m.id !== data.victimId)
      .map((m) => {
        let top = 0;
        for (const id of Object.keys(m.beliefs.suspicion)) {
          top = Math.max(top, suspicionOf(m.beliefs, id));
        }
        return { id: m.id, top };
      })
      .filter((entry) => entry.top >= 0.25)
      .sort((a, b) => b.top - a.top)
      .slice(0, cfg.testimonyWitnessCap)
      .map((entry) => entry.id);
  }
  witnessIds = witnessIds.slice(0, cfg.testimonyWitnessCap);
  for (const witnessId of witnessIds) {
    const witness = byId(crew, witnessId);
    if (witness === undefined) continue;
    if (data.truthCulprit !== null && witnessId === data.truthCulprit) {
      // The scapegoat: least trusted by the culprit, kin to none.
      let scapegoat: CrewMember | undefined;
      let lowest = Infinity;
      for (const other of crew) {
        if (!alive(other) || other === witness) continue;
        if (other.id === data.victimId) continue;
        if (bondOf(witness.beliefs, other.id) >= 0.3) continue;
        if (bondOf(other.beliefs, witness.id) >= 0.3) continue;
        const trust = trustOf(witness.beliefs, other.id);
        if (trust < lowest) {
          lowest = trust;
          scapegoat = other;
        }
      }
      if (scapegoat !== undefined) {
        for (const officer of officers) {
          if (officer === witness) continue;
          const discount = 0.5 + 0.5 * Math.max(0, trustOf(officer.beliefs, witness.id));
          driftSuspicion(officer.beliefs, scapegoat.id, cfg.scapegoatPush * discount);
        }
        statements.push({
          witness: witness.id,
          about: scapegoat.id,
          kind: "scapegoat",
        });
      }
      continue;
    }
    // An honest witness names their strongest suspicion.
    let about: string | null = null;
    let top = 0.25;
    for (const id of Object.keys(witness.beliefs.suspicion)) {
      if (id === witness.id || id === data.victimId) continue;
      const value = suspicionOf(witness.beliefs, id);
      if (value > top) {
        top = value;
        about = id;
      }
    }
    if (about === null) continue;
    for (const officer of officers) {
      if (officer === witness) continue;
      const discount = 0.5 + 0.5 * Math.max(0, trustOf(officer.beliefs, witness.id));
      driftSuspicion(officer.beliefs, about, cfg.testimonyPush * discount);
    }
    statements.push({ witness: witness.id, about, kind: "suspicion" });
  }
  return statements;
}

/** Run one inquiry or discipline sitting, end to end. */
function runJudicialSitting(
  w: World,
  state: CouncilState,
  ship: Ship,
  crew: readonly CrewMember[],
  health: HealthState,
  pending: PendingSitting,
): void {
  const cfg = CONFIG.council;
  const victim = byId(crew, pending.victimId);
  const deathRecord = health.deaths.find((d) => d.memberId === pending.victimId);
  const presentIds = deathRecord?.presentIds ?? [];

  const motion: VoteMotion = {
    kind: pending.kind,
    accusedId: pending.accusedId,
    accuserId: pending.accuserId,
    victimId: pending.victimId,
  };
  let frame = frameSitting(state, crew, motion);

  // Witnesses are heard first (their pushes land now), then the
  // board names its accused: the preset suspect, or the person
  // the sitting officers' suspicions jointly point to.
  const statements =
    pending.kind === "inquiry"
      ? testimony(crew, frame, {
          victimId: pending.victimId,
          truthCulprit: pending.truthCulprit,
          presentIds,
          causeKind: pending.causeKind,
        })
      : [];
  let accusedId = pending.accusedId;
  if (accusedId === null && pending.kind === "inquiry") {
    let bestMedian = 0;
    for (const candidate of crew) {
      if (!alive(candidate)) continue;
      if (candidate.id === pending.victimId) continue;
      const values = frame.sitting.map((s) =>
        suspicionOf(s.member.beliefs, candidate.id),
      );
      const med = median(values);
      if (med > bestMedian) {
        bestMedian = med;
        accusedId = candidate.id;
      }
    }
    if (bestMedian < 0.3) accusedId = null;
    if (accusedId !== null) {
      // Naming the accused may recuse a bonded officer: reframe,
      // and the convened record is written from the final frame,
      // so the chronicle never seats an officer the board then
      // silently stood down.
      motion.accusedId = accusedId;
      frame = frameSitting(state, crew, motion);
    }
  }
  emitConvened(w, ship, frame, pending.kind, {
    accused: accusedId,
    victim: pending.victimId,
    cause: pending.causeKind,
  });
  state.sittingsHeld++;
  for (const statement of statements) {
    w.emit("council_testimony", [statement.witness], {
      witness: statement.witness,
      about: statement.about,
      kind: statement.kind,
    });
  }

  // The cause as the board finds it: the doctor reads the body;
  // lay judgment, without a medical seat at the table, can err.
  let believedCause = pending.causeKind;
  let truthCause: string | null = null;
  if (pending.causeKind === "death" && victim !== undefined) {
    const summary = ledgerSummary(victim);
    truthCause = summary[0]?.cause ?? "unknown";
    const cmoSitting = frame.sitting.some(
      (s) => s.seatKey === "chief medical officer",
    );
    believedCause = cmoSitting
      ? truthCause
      : (summary[1]?.cause ?? "unknown");
  }

  if (accusedId === null) {
    const legitimacy = inquiryFallout(w, state, crew, frame, {
      accusedId: null,
      victimId: pending.victimId,
      convicted: false,
      votes: [],
    });
    w.emit("council_finding", [], {
      kind: pending.kind,
      accused: null,
      victim: pending.victimId,
      cause: believedCause,
      truthCause,
      truthCulprit: pending.truthCulprit,
      convicted: false,
      votes: [],
      strength: 0,
      consequence: "no culprit found",
      chair: frame.chairId,
      legitimacy,
    });
    return;
  }

  motion.accusedId = accusedId;
  const { votes, forCount, againstCount, strength } = runVote(state, crew, frame, motion);
  const convicted = forCount > againstCount;
  const accused = byId(crew, accusedId);
  let consequence = "acquitted";
  // Decide the sentence fully (including forgiveness) before any
  // event is written, so the chronicle reads finding, then
  // sentence, and never prints a sentence beside its own pardon.
  let sentenceKind = "";
  let sentenceUntil = -1;
  let forgiven = false;
  if (convicted && accused !== undefined && alive(accused)) {
    if (pending.kind === "discipline") {
      if (strength >= cfg.strengthFair) {
        sentenceKind = "quarters";
        sentenceUntil = w.tick + cfg.disciplineStrongTicks;
        consequence = "confined to quarters";
      } else {
        sentenceKind = "mess_ban";
        sentenceUntil = w.tick + cfg.disciplineWeakTicks;
        consequence = "loss of mess privileges";
      }
    } else if (strength >= cfg.strengthStrong) {
      sentenceKind = "brig";
      sentenceUntil = w.tick + cfg.brigStrongTicks;
      consequence = "brig";
      if (pending.causeKind === "death") {
        state.putOff.push(accused.id);
        consequence = "brig, then put off at the next port";
      }
    } else if (strength >= cfg.strengthFair) {
      sentenceKind = "quarters";
      sentenceUntil = w.tick + cfg.brigFairTicks;
      consequence = "confined to quarters";
    } else {
      sentenceKind = "restriction";
      sentenceUntil = w.tick + cfg.quartersWeakTicks;
      consequence = "restricted from systems";
    }
    // The captain's forgiveness: a captain who trusts the accused
    // and faces a weak or fair finding may lift the confinement.
    // It never touches the finding itself, and never applies to
    // a death sentence's put-off.
    const captain = byId(crew, captainId(state));
    if (
      captain !== undefined &&
      strength < cfg.strengthStrong &&
      trustOf(captain.beliefs, accused.id) > 0.45 &&
      (consequence === "confined to quarters" || consequence === "brig")
    ) {
      forgiven = true;
      consequence = "forgiven by the captain";
    }
  }
  const legitimacy = inquiryFallout(w, state, crew, frame, {
    accusedId,
    victimId: pending.victimId,
    convicted,
    votes,
  });
  w.emit("council_finding", [], {
    kind: pending.kind,
    accused: accusedId,
    victim: pending.victimId,
    cause: believedCause,
    truthCause,
    truthCulprit: pending.truthCulprit,
    convicted,
    votes,
    strength: r3(strength),
    consequence,
    chair: frame.chairId,
    legitimacy,
  });
  if (convicted && accused !== undefined && alive(accused)) {
    if (forgiven) {
      const captain = byId(crew, captainId(state));
      w.emit("captain_forgiveness", captain !== undefined ? [captain.id] : [], {
        captain: captainId(state),
        member: accused.id,
      });
    } else if (sentenceKind !== "") {
      sentence(w, state, crew, accused, sentenceKind, sentenceUntil);
    }
  }
}

/** Run a stores, powers, appointment, or relief sitting. */
function runMotionSitting(
  w: World,
  state: CouncilState,
  ship: Ship,
  crew: readonly CrewMember[],
  stores: StoresState,
  pending: PendingSitting,
): void {
  const cfg = CONFIG.council;
  const storesState = stores;
  let motion: VoteMotion = { kind: pending.kind };
  if (pending.kind === "rationing" || pending.kind === "lift" || pending.kind === "ratification") {
    const key = pending.store as "food" | "water";
    motion = {
      kind: pending.kind,
      proposerId:
        pending.kind === "ratification"
          ? captainId(state)
          : state.seats["quartermaster"],
      days: daysOf(storesState, key),
    };
  } else if (pending.kind === "emergency") {
    const failed = ship.systems.filter((s) => s.failed).length;
    motion = {
      kind: "emergency",
      proposerId: captainId(state),
      severity: Math.min(1, 0.3 + 0.35 * failed),
    };
  } else if (pending.kind === "relief") {
    motion = {
      kind: "relief",
      subjectId: captainId(state),
      proposerId: pending.movers[0] ?? null,
    };
  } else if (pending.kind === "appointment") {
    motion = {
      kind: "appointment",
      subjectId: pending.subjectId,
      proposerId: captainId(state),
    };
  }
  const frame = frameSitting(state, crew, motion);
  emitConvened(w, ship, frame, pending.kind, {
    accused: pending.kind === "relief" ? captainId(state) : null,
    subject: pending.subjectId,
    store: pending.store,
    level: pending.level,
    movers: pending.movers,
  });
  state.sittingsHeld++;
  const { votes, forCount, againstCount, strength } = runVote(state, crew, frame, motion);

  let carried = forCount > againstCount;
  if (pending.kind === "relief") {
    carried = forCount >= reliefRequired(frame.sitting.length);
  }
  if (pending.kind === "emergency" && pending.renewal > 0) {
    const voters = Math.max(1, frame.sitting.length);
    const share = 0.5 + cfg.emergencyRenewalShareStep * pending.renewal;
    carried = forCount / voters >= share;
  }

  const key = pending.store as "food" | "water";
  switch (pending.kind) {
    case "rationing": {
      if (carried && pending.store !== null && pending.level !== null) {
        storesState.rationing[key] = true;
        storesState.rationLevel[key] = pending.level;
        w.emit("rationing_imposed", [], {
          by: state.seats["quartermaster"],
          via: "council",
          level: pending.level,
          store: key,
          days: r3(daysOf(storesState, key)),
        });
      } else {
        state.rationCooldownUntil[key] =
          w.tick + cfg.rationRefusalCooldownDays * CONFIG.time.ticksPerDay;
      }
      break;
    }
    case "lift": {
      if (carried && pending.store !== null) {
        storesState.rationing[key] = false;
        storesState.rationLevel[key] = null;
        w.emit("rationing_lifted", [], {
          store: key,
          days: r3(daysOf(storesState, key)),
          reason: "council",
        });
      }
      break;
    }
    case "ratification": {
      if (pending.store !== null) {
        if (carried) {
          w.emit("rationing_ratified", [], {
            store: key,
            level: pending.level,
            days: r3(daysOf(storesState, key)),
          });
        } else {
          storesState.rationing[key] = false;
          storesState.rationLevel[key] = null;
          w.emit("rationing_lifted", [], {
            store: key,
            days: r3(daysOf(storesState, key)),
            reason: "council_refused",
          });
          // The refusal leaves the blame with the captain.
          const captain = byId(crew, captainId(state));
          if (captain !== undefined) {
            for (const officer of frame.sitting) {
              driftTrust(officer.member.beliefs, captain.id, -0.12);
            }
          }
          state.legitimacy = Math.max(0, state.legitimacy - 0.05);
        }
      }
      break;
    }
    case "emergency": {
      if (carried) {
        state.emergencyUntil = w.tick + cfg.emergencyGrantTicks;
        state.emergencyRenewals = pending.renewal;
        w.emit("emergency_granted", [], {
          untilTick: state.emergencyUntil,
          renewal: pending.renewal,
          votes,
        });
      } else {
        state.lastEmergencyEnd = w.tick;
        w.emit("emergency_refused", [], { renewal: pending.renewal, votes });
      }
      break;
    }
    case "appointment": {
      if (pending.subjectId !== null) {
        if (carried) {
          w.emit("appointment_ratified", [], {
            seat: "first officer",
            member: pending.subjectId,
          });
        } else {
          state.foRejected.push(pending.subjectId);
          vacateSeat(w, state, "first officer", "ratification refused");
          w.emit("appointment_refused", [], {
            seat: "first officer",
            member: pending.subjectId,
          });
        }
        if (state.foRatification?.memberId === pending.subjectId) {
          state.foRatification = null;
        }
      }
      break;
    }
    case "relief": {
      const captain = byId(crew, captainId(state));
      if (carried && captain !== undefined) {
        const foId = state.seats["first officer"];
        const successor =
          byId(crew, foId ?? null) ??
          frame.sitting.find((s) => s.seatKey !== "captain")?.member;
        if (successor !== undefined) {
          // The First Officer takes command; their old seat empties.
          for (const def of SEATS) {
            if (state.seats[def.key] === successor.id) state.seats[def.key] = null;
          }
          state.seats["captain"] = successor.id;
          captain.confinedUntil = w.tick + 7 * CONFIG.time.ticksPerDay;
          state.legitimacy = Math.max(0, state.legitimacy - 0.08);
          w.emit("captain_relieved", [captain.id], {
            member: captain.id,
            newCaptain: successor.id,
            votes,
            movers: pending.movers,
          });
        }
      } else {
        // A failed motion is not free: the movers are marked.
        if (captain !== undefined) {
          for (const moverId of pending.movers) {
            driftTrust(captain.beliefs, moverId, -0.3);
            const mover = byId(crew, moverId);
            if (mover !== undefined) {
              mover.needs.morale = Math.max(0, mover.needs.morale - 0.05);
            }
          }
        }
        w.emit("relief_failed", [], { movers: pending.movers, votes });
      }
      break;
    }
    default:
      break;
  }
  w.emit("council_finding", [], {
    kind: pending.kind,
    accused: null,
    victim: null,
    cause: pending.kind,
    truthCause: null,
    truthCulprit: null,
    convicted: carried,
    votes,
    strength: r3(strength),
    consequence: carried ? "carried" : "refused",
    chair: frame.chairId,
    legitimacy: r3(state.legitimacy),
  });
}

/** Qualification for a seat, by portfolio: who aboard could hold it. */
function qualification(
  seatKey: string,
  member: CrewMember,
  crew: readonly CrewMember[],
  appointer: CrewMember | undefined,
): number {
  switch (seatKey) {
    case "chief engineer":
      return (
        member.repairSkill *
        (member.affinity.includes("reactor") || member.affinity.includes("engines")
          ? 1
          : 0.4)
      );
    case "chief medical officer":
      return member.affinity.includes("medbay unit")
        ? 0.7 + member.repairSkill * 0.3
        : member.repairSkill * 0.3;
    case "security chief":
      return member.roleKey === "security officer"
        ? 1
        : member.repairSkill * 0.2 + (member.traits.includes("bold") ? 0.1 : 0);
    case "science officer":
      return member.roleKey === "scientist" ? 1 : 0.3;
    case "quartermaster":
      return member.roleKey === "quartermaster"
        ? 1
        : member.affinity.includes("water recycler")
          ? 0.5
          : 0.2;
    case "first officer": {
      let trustSum = 0;
      let count = 0;
      for (const other of crew) {
        if (other === member || !alive(other)) continue;
        trustSum += trustOf(other.beliefs, member.id);
        count++;
      }
      const medianTrust = count > 0 ? trustSum / count : 0;
      const captainBond =
        appointer !== undefined ? bondOf(appointer.beliefs, member.id) : 0;
      return medianTrust * 0.5 + member.repairSkill * 0.2 + captainBond * 0.3;
    }
    default:
      return member.repairSkill;
  }
}

/** The daily appointment round: succession, vacancies, appointments. */
function appointments(
  w: World,
  state: CouncilState,
  crew: readonly CrewMember[],
): void {
  const cfg = CONFIG.council;
  // Retire the hurt, bury the dead, free the confined: a seat
  // whose holder cannot sit is a vacant seat.
  for (const def of SEATS) {
    const holder = byId(crew, state.seats[def.key] ?? null);
    if (state.seats[def.key] === null || state.seats[def.key] === undefined) continue;
    if (holder === undefined || holder.dead || holder.leftShip) {
      vacateSeat(w, state, def.key, holder === undefined ? "holder gone" : holder.dead ? "death" : "left the ship");
    } else if (w.tick < holder.confinedUntil) {
      vacateSeat(w, state, def.key, "confined");
    } else if (holder.body.health < cfg.retireHealth) {
      vacateSeat(w, state, def.key, "retired hurt");
    }
  }
  // Succession: a vacant captaincy falls to the First Officer.
  if (state.seats["captain"] === null || state.seats["captain"] === undefined) {
    const fo = byId(crew, state.seats["first officer"] ?? null);
    if (alive(fo) && fo !== undefined) {
      state.seats["first officer"] = null;
      state.seats["captain"] = fo.id;
      w.emit("council_succession", [fo.id], { member: fo.id, seat: "captain" });
    }
  }
  const appointer =
    byId(crew, captainId(state)) ?? byId(crew, state.seats["first officer"] ?? null);
  if (appointer === undefined || !alive(appointer)) return;
  for (const def of SEATS) {
    if (def.key === "captain") continue;
    if (state.seats[def.key] !== null && state.seats[def.key] !== undefined) continue;
    const holders = new Set(
      Object.values(state.seats).filter((v) => v !== null),
    );
    const candidates = crew.filter(
      (m) =>
        alive(m) &&
        w.tick >= m.confinedUntil &&
        !holders.has(m.id) &&
        !(def.key === "first officer" && state.foRejected.includes(m.id)),
    );
    if (candidates.length === 0) continue;
    let best: CrewMember | undefined;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = qualification(def.key, candidate, crew, appointer);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best === undefined) continue;
    state.seats[def.key] = best.id;
    w.emit("council_appointment", [best.id], {
      seat: def.key,
      member: best.id,
      by: appointer.id,
      score: r3(bestScore),
    });
    if (def.key === "first officer") {
      state.foRatification = {
        memberId: best.id,
        atTick: w.tick + CONFIG.time.ticksPerDay,
      };
      state.pending.push({
        kind: "appointment",
        atTick: w.tick + CONFIG.time.ticksPerDay,
        accusedId: null,
        accuserId: null,
        victimId: null,
        truthCulprit: null,
        causeKind: "appointment",
        store: null,
        level: null,
        movers: [],
        renewal: 0,
        subjectId: best.id,
      });
    }
  }
}

/** Scan the event stream since the cursor for sitting triggers. */
function scanTriggers(
  w: World,
  state: CouncilState,
  crew: readonly CrewMember[],
): void {
  const cfg = CONFIG.council;
  const events = w.events.events;
  while (state.eventCursor < events.length) {
    const event = events[state.eventCursor] as (typeof events)[number];
    state.eventCursor++;
    if (event.type === "sabotage_committed") {
      const damage = typeof event.data.damage === "number" ? event.data.damage : 0;
      const key = `sabotage:${String(event.data.system)}:${event.tick}`;
      if (damage >= cfg.sabotageInquiryDamage && !state.inquiryKeys.has(key)) {
        state.inquiryKeys.add(key);
        state.pending.push({
          kind: "inquiry",
          atTick: w.tick + cfg.conveneDelayTicks,
          accusedId: null,
          accuserId: null,
          victimId: null,
          truthCulprit: typeof event.data.culprit === "string" ? event.data.culprit : null,
          causeKind: "sabotage",
          store: null,
          level: null,
          movers: [],
          renewal: 0,
          subjectId: null,
        });
      }
    } else if (event.type === "stores_discrepancy") {
      const suspect = event.data.suspect;
      if (typeof suspect === "string") {
        const key = `theft:${suspect}:${event.tick}`;
        if (!state.inquiryKeys.has(key)) {
          state.inquiryKeys.add(key);
          state.pending.push({
            kind: "inquiry",
            atTick: w.tick + cfg.conveneDelayTicks,
            accusedId: suspect,
            accuserId: typeof event.data.by === "string" ? event.data.by : null,
            victimId: null,
            truthCulprit: suspect,
            causeKind: "theft",
            store: null,
            level: null,
            movers: [],
            renewal: 0,
            subjectId: null,
          });
        }
      }
    } else if (event.type === "accusation") {
      const accuser = byId(crew, event.actors[0] ?? null);
      const accused = typeof event.data.accused === "string" ? event.data.accused : null;
      const suspicion =
        typeof event.data.suspicion === "number" ? event.data.suspicion : 0;
      if (accuser !== undefined && accuser.roleKey === "security officer" && accused !== null) {
        if (
          suspicion >= cfg.certifiedSuspicion &&
          w.tick - (state.lastInquiryByAccused[accused] ?? -1000000) >=
            cfg.inquiryAccusedCooldownTicks
        ) {
          state.lastInquiryByAccused[accused] = w.tick;
          const key = `certified:${accused}:${event.tick}`;
          if (!state.inquiryKeys.has(key)) {
            state.inquiryKeys.add(key);
            state.pending.push({
              kind: "inquiry",
              atTick: w.tick + cfg.conveneDelayTicks,
              accusedId: accused,
              accuserId: accuser.id,
              victimId: null,
              truthCulprit: null,
              causeKind: "accusation",
              store: null,
              level: null,
              movers: [],
              renewal: 0,
              subjectId: null,
            });
          }
        } else if (suspicion >= cfg.disciplineSuspicion) {
          queueDiscipline(state, accused, accuser.id, w.tick);
        }
      }
    } else if (event.type === "theft" && event.data.witnessed === true) {
      const thief = typeof event.data.thief === "string" ? event.data.thief : null;
      if (thief !== null) queueDiscipline(state, thief, null, w.tick);
    }
  }
}

function queueDiscipline(
  state: CouncilState,
  accusedId: string,
  accuserId: string | null,
  tick: number,
): void {
  const last = state.disciplineAt[accusedId] ?? -1000000;
  if (tick - last < CONFIG.council.disciplineCooldownTicks) return;
  state.disciplineAt[accusedId] = tick;
  state.pending.push({
    kind: "discipline",
    atTick: tick + CONFIG.council.conveneDelayTicks,
    accusedId,
    accuserId,
    victimId: null,
    truthCulprit: null,
    causeKind: "discipline",
    store: null,
    level: null,
    movers: [],
    renewal: 0,
    subjectId: null,
  });
}

/**
 * The council system: triggers, sittings, standing business, in
 * that order, every tick. Runs last: it judges the tick the rest
 * of the ship has already lived.
 */
export function stepCouncil(
  w: World,
  state: CouncilState,
  ship: Ship,
  crew: readonly CrewMember[],
  health: HealthState,
  stores: StoresState,
  galaxy: { sector: Sector; voyage: Voyage },
): void {
  const cfg = CONFIG.council;
  const tpd = CONFIG.time.ticksPerDay;
  const tod = w.tick % tpd;

  // The public face stays current even on a quiet tick.
  const syncPublic = (): void => {
    if (ship.councilPublic !== null) {
      const cmo = byId(crew, state.seats["chief medical officer"] ?? null);
      ship.councilPublic.cmoFilled = alive(cmo);
      ship.councilPublic.emergencyUntil = state.emergencyUntil;
    }
  };
  syncPublic();
  if (ship.ended) return;

  scanTriggers(w, state, crew);

  // Every death convenes a board, automatically.
  while (state.deathCursor < health.deaths.length) {
    const death = health.deaths[state.deathCursor] as (typeof health.deaths)[number];
    state.deathCursor++;
    state.pending.push({
      kind: "inquiry",
      atTick: w.tick + cfg.conveneDelayTicks,
      accusedId: null,
      accuserId: null,
      victimId: death.memberId,
      truthCulprit: death.attackerId,
      causeKind: "death",
      store: null,
      level: null,
      movers: [],
      renewal: 0,
      subjectId: null,
    });
  }

  // Emergency imposition: a store under the emergency line is the
  // captain acting alone, and the council must ratify within a
  // day or it lapses.
  for (const key of ["food", "water"] as const) {
    const days = daysOf(stores, key);
    if (!stores.rationing[key] && days < cfg.rationEmergencyDays) {
      const captain = byId(crew, captainId(state));
      const level = days < 4 ? "strict" : "reduced";
      stores.rationing[key] = true;
      stores.rationLevel[key] = level as "reduced" | "strict";
      w.emit("rationing_imposed", captain !== undefined ? [captain.id] : [], {
        by: captainId(state),
        via: "captain_emergency",
        level,
        store: key,
        days: r3(days),
        emergency: true,
      });
      state.pending.push({
        kind: "ratification",
        atTick: w.tick + cfg.ratifyWithinTicks,
        accusedId: null,
        accuserId: null,
        victimId: null,
        truthCulprit: null,
        causeKind: "ratification",
        store: key,
        level: level as "reduced" | "strict",
        movers: [],
        renewal: 0,
        subjectId: null,
      });
    }
  }

  // Due sittings, in the order they were called. Inquiry boards
  // are set-pieces: a board that would sit too soon after the
  // last one waits for its gap, in the queue.
  for (let i = state.pending.length - 1; i >= 0; i--) {
    const pending = state.pending[i] as PendingSitting;
    if (pending.atTick > w.tick) continue;
    if (
      (pending.kind === "inquiry" || pending.kind === "discipline") &&
      w.tick - state.lastInquiryTick < cfg.inquiryGapTicks
    ) {
      pending.atTick = state.lastInquiryTick + cfg.inquiryGapTicks;
      continue;
    }
    state.pending.splice(i, 1);
    if (pending.kind === "inquiry" || pending.kind === "discipline") {
      state.lastInquiryTick = w.tick;
      runJudicialSitting(w, state, ship, crew, health, pending);
    } else {
      runMotionSitting(w, state, ship, crew, stores, pending);
    }
  }

  // The FO ratification may also lapse if its sitting was consumed
  // by an ending; nothing to do on a live ship (it is a pending
  // sitting like any other).

  // Emergency powers: declared by the captain when the ship is
  // hurt, granted or refused by vote, expiring on their tick.
  const failedCount = ship.systems.filter((s) => s.failed).length;
  const casualty = failedCount >= 3 || ship.systems.some(
    (s) => s.failed && (s.kind === "life support" || s.kind === "reactor"),
  );
  if (w.tick === state.emergencyUntil && state.emergencyUntil > 0) {
    w.emit("emergency_expired", [], { renewals: state.emergencyRenewals });
    state.lastEmergencyEnd = w.tick;
    state.emergencyUntil = -1;
    if (casualty) {
      state.pending.push({
        kind: "emergency",
        atTick: w.tick + 6,
        accusedId: null,
        accuserId: null,
        victimId: null,
        truthCulprit: null,
        causeKind: "emergency",
        store: null,
        level: null,
        movers: [],
        renewal: state.emergencyRenewals + 1,
        subjectId: null,
      });
    }
  }
  if (
    casualty &&
    state.emergencyUntil < w.tick &&
    w.tick - state.lastEmergencyEnd >= cfg.emergencyCooldownTicks &&
    !state.pending.some((p) => p.kind === "emergency") &&
    captainId(state) !== null
  ) {
    const captain = byId(crew, captainId(state));
    w.emit("emergency_declared", captain !== undefined ? [captain.id] : [], {
      by: captainId(state),
      failed: failedCount,
    });
    runMotionSitting(w, state, ship, crew, stores, {
      kind: "emergency",
      atTick: w.tick,
      accusedId: null,
      accuserId: null,
      victimId: null,
      truthCulprit: null,
      causeKind: "emergency",
      store: null,
      level: null,
      movers: [],
      renewal: 0,
      subjectId: null,
    });
  }

  // Standing business, on its ticks of the day.
  if (tod === cfg.appointmentTickOfDay) {
    appointments(w, state, crew);
  }
  if (tod === cfg.rationTickOfDay) {
    // No quartermaster: the counts drift, booked as charged so
    // the stores identity still reconciles to the milli-unit.
    if (state.seats["quartermaster"] === null || state.seats["quartermaster"] === undefined) {
      const food = stores.byKey.food;
      const drift = Math.min(food.qtyMilli, cfg.qmVacancyDriftMilliPerDay);
      if (drift > 0) {
        food.qtyMilli -= drift;
        stores.totals.food.chargedMilli -= drift;
      }
    }
    // Rationing: proposal when a store crosses the trigger (the
    // quartermaster's traits bend it, as the interim's did), and
    // a lift vote when the counters recover.
    const qm = byId(crew, state.seats["quartermaster"] ?? null);
    let triggerShift = 0;
    if (qm !== undefined) {
      for (const trait of qm.traits) {
        triggerShift += CONFIG.stores.rationing.traitTriggerShift[trait] ?? 0;
      }
    }
    for (const key of ["food", "water"] as const) {
      const days = daysOf(stores, key);
      if (
        !stores.rationing[key] &&
        days < CONFIG.stores.rationing.triggerDays + triggerShift &&
        w.tick >= state.rationCooldownUntil[key] &&
        !state.pending.some((p) => p.kind === "rationing" && p.store === key)
      ) {
        state.pending.push({
          kind: "rationing",
          atTick: w.tick + 6,
          accusedId: null,
          accuserId: null,
          victimId: null,
          truthCulprit: null,
          causeKind: "rationing",
          store: key,
          level: days < cfg.rationStrictDays ? "strict" : "reduced",
          movers: [],
          renewal: 0,
          subjectId: null,
        });
      } else if (
        stores.rationing[key] &&
        days > CONFIG.stores.rationing.liftDays + triggerShift &&
        !state.pending.some((p) => p.kind === "lift" && p.store === key)
      ) {
        state.pending.push({
          kind: "lift",
          atTick: w.tick + 6,
          accusedId: null,
          accuserId: null,
          victimId: null,
          truthCulprit: null,
          causeKind: "lift",
          store: key,
          level: null,
          movers: [],
          renewal: 0,
          subjectId: null,
        });
      }
    }
  }
  if (tod === cfg.reliefTickOfDay) {
    // Relief of the captain: three officers whose trust in the
    // captain has collapsed may table the motion.
    const captain = byId(crew, captainId(state));
    if (
      captain !== undefined &&
      w.tick - state.lastReliefTick >= cfg.reliefCooldownTicks
    ) {
      const movers: string[] = [];
      for (const def of SEATS) {
        if (def.key === "captain") continue;
        const holder = byId(crew, state.seats[def.key] ?? null);
        if (!alive(holder) || holder === undefined) continue;
        if (
          trustOf(holder.beliefs, captain.id) <= cfg.reliefTrustLine &&
          holder.beliefs.grudges.includes(captain.id)
        ) {
          movers.push(holder.id);
        }
      }
      if (movers.length >= cfg.reliefMoversNeeded) {
        state.lastReliefTick = w.tick;
        state.reliefMotions++;
        w.emit("relief_motion", movers, {
          movers,
          captain: captain.id,
        });
        state.pending.push({
          kind: "relief",
          atTick: w.tick + cfg.conveneDelayTicks,
          accusedId: null,
          accuserId: null,
          victimId: null,
          truthCulprit: null,
          causeKind: "relief",
          store: null,
          level: null,
          movers,
          renewal: 0,
          subjectId: captain.id,
        });
      }
    }
  }

  // Put off at the next port: the sentence waits for a dock.
  if (state.putOff.length > 0 && galaxy.voyage.inPortAt(w.tick)) {
    const portIndex = galaxy.voyage.portIndexAt(w.tick);
    const portName =
      portIndex !== null ? galaxy.sector.portAt(portIndex).name : "port";
    for (const memberId of state.putOff.splice(0)) {
      const member = byId(crew, memberId);
      if (member === undefined || member.dead || member.leftShip) continue;
      member.leftShip = true;
      member.confinedUntil = -1;
      member.activity = "gone";
      for (const def of SEATS) {
        if (state.seats[def.key] === member.id) state.seats[def.key] = null;
      }
      w.emit("put_off", [member.id], { member: member.id, port: portName });
    }
  }

  syncPublic();
}

/** Invariant check: seats name living-or-no members, legitimacy in range. */
export function checkCouncilState(
  state: CouncilState,
  crew: readonly CrewMember[],
): void {
  if (state.legitimacy < 0 || state.legitimacy > 1) {
    throw new Error(`legitimacy out of range: ${state.legitimacy}`);
  }
  const ids = new Set(crew.map((m) => m.id));
  for (const def of SEATS) {
    const holder = state.seats[def.key];
    if (holder !== null && holder !== undefined && !ids.has(holder)) {
      throw new Error(`seat ${def.key} names unknown member ${holder}`);
    }
  }
}
