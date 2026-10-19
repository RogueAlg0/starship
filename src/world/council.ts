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
// renewals, relief of the captain, and course: at every port
// after the charter, the council sets the course the ship sails
// (the departure decision). Deferred, with their inputs
// unbuilt: admissions (crew arrivals do not exist yet) and the
// distress-call half of course (no distress calls exist yet).

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
import {
  consumptionMilliPerDay,
  dailyUseMilli,
  daysOf,
  productionMilliPerDay,
  STORE_KEYS,
  type StoreKey,
  type StoresState,
} from "./stores.ts";

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
  /** The port the captain tables, for course motions. */
  portIndex?: number | null;
  /** The port the ship lies in, for course motions. */
  fromPortIndex?: number | null;
}

/**
 * The course table's arithmetic, computed once per sitting: each
 * officer's price for each candidate port, in candidate order.
 * Course votes are read off these prices (the motion's port
 * against the officer's own best alternative), so the four terms
 * stay inspectable: portfolio and trait leans, trust in the
 * navigator's recommendation, and the common chart terms are all
 * priced into the table by scoreCourseCandidates.
 */
export interface CourseVoteContext {
  candidates: readonly number[];
  scores: ReadonlyMap<string, readonly number[]>;
}

interface OfficerContext {
  crew: readonly CrewMember[];
  /** The security chief's holder, whose presentation is testimony. */
  securityId: string | null;
  /** The course table's prices; present only for course votes. */
  course?: CourseVoteContext;
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
  } else if (kind === "course") {
    // The vote is the officer's own arithmetic, read off the
    // course table's prices: what the captain's port is worth to
    // them, against the best other port on the chart. Portfolio,
    // trait, and trust terms are already priced into the table
    // (see scoreCourseCandidates); the evidence the record
    // carries is how far the motion stands from their best
    // alternative, centred on a coin flip.
    const cc = ctx.course;
    const mine = cc?.scores.get(officer.id);
    if (cc !== undefined && mine !== undefined && motion.portIndex !== null && motion.portIndex !== undefined) {
      const motionAt = cc.candidates.indexOf(motion.portIndex);
      if (motionAt >= 0) {
        const motionPrice = mine[motionAt] as number;
        let bestAlt = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < mine.length; i++) {
          if (i !== motionAt) bestAlt = Math.max(bestAlt, mine[i] as number);
        }
        if (bestAlt === Number.NEGATIVE_INFINITY) bestAlt = motionPrice;
        evidence = Math.max(0, Math.min(1, 0.5 + (motionPrice - bestAlt)));
        evidenceTerm = motionPrice - bestAlt;
      }
    }
  }

  // A meticulous officer weighs the evidence term harder.
  if (officer.traits.includes("meticulous")) evidenceTerm *= 1.2;

  // Course prices its own leans into the table; the standing
  // tables below are for the binary motions.
  const leanTable =
    kind === "course"
      ? undefined
      : kind === "ratification" || kind === "lift"
        ? CONFIG.council.portfolioLean.rationing
        : CONFIG.council.portfolioLean[kind];
  let lean = leanTable?.[seatKey] ?? 0;
  if (kind === "lift") lean = -lean;
  const traitFamily =
    kind === "inquiry" || kind === "discipline" ? "guilty" : "motion";
  if (kind !== "course") {
    for (const trait of officer.traits) {
      lean += CONFIG.council.traitLean[traitFamily][trait] ?? 0;
    }
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
  /** The stay a course sitting sets the course out of. */
  stayIndex?: number;
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
  /** Course sittings held: one per stay the council decided. */
  courseSittings: number;
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
    courseSittings: 0,
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
  course?: CourseVoteContext,
): { votes: VoteRecord[]; forCount: number; againstCount: number; strength: number } {
  const secId = state.seats["security chief"] ?? null;
  const ctx: OfficerContext =
    course === undefined
      ? { crew, securityId: secId }
      : { crew, securityId: secId, course };
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

/** One candidate on the course chart, as the table prices it. */
interface CourseCandidate {
  index: number;
  character: string;
  legDays: number;
  visited: boolean;
  isPrevious: boolean;
}

/**
 * The public snapshots a course sitting reads: the stores
 * counters, the ship's condition, the crew's state, as the table
 * is entitled to know them. Course business reads the same
 * public face as rationing does (the counters as tabled), not
 * the belief stores: there is no believed-stores model aboard,
 * and the chart is a public document by the chapter's design.
 */
interface CourseSnapshot {
  days: Record<"food" | "water" | "oxygen" | "fuel" | "parts", number>;
  /** Net days of supply gained per day under way, at the ship's
   *  present production: negative where a store drains at sea. */
  netRateDays: Record<StoreKey, number>;
  worstCondition: number;
  worstKind: string;
  meanMorale: number;
  hurtShare: number;
  recentTheft: boolean;
}

/** What the quartermaster counts: how well a port's character
 *  answers the stores' needs, needs weighted by shortness. */
function storesFit(cand: CourseCandidate, snap: CourseSnapshot): number {
  const cfg = CONFIG.council.course;
  const supply = CONFIG.stores.port.supply[cand.character] ?? {};
  let fit = 0;
  for (const key of ["food", "water", "oxygen", "fuel", "parts"] as const) {
    const need = Math.max(
      0,
      Math.min(1, (cfg.shortLineDays - snap.days[key]) / cfg.shortLineDays),
    );
    // Parts are the repair economy: the worse the ship, the more
    // a parts-filling port is worth, whether or not the locker
    // has run dry yet.
    const weight = key === "parts" ? 1 + (1 - snap.worstCondition) : 1;
    fit += need * weight * (supply[key] ?? 0);
  }
  return fit * cfg.storesFitScale;
}

/** The store whose shortness a port answers best, for the clause. */
function shortestAnswered(
  cand: CourseCandidate,
  snap: CourseSnapshot,
): string | null {
  const cfg = CONFIG.council.course;
  const supply = CONFIG.stores.port.supply[cand.character] ?? {};
  let best: string | null = null;
  let bestGain = 0.02;
  for (const key of ["food", "water", "oxygen", "fuel", "parts"] as const) {
    const need = Math.max(
      0,
      Math.min(1, (cfg.shortLineDays - snap.days[key]) / cfg.shortLineDays),
    );
    const gain = need * (supply[key] ?? 0);
    if (gain > bestGain) {
      bestGain = gain;
      best = key;
    }
  }
  return best;
}

/**
 * How deep the ship's emergency stands, on [0, 1]: zero on a
 * sound ship with a full locker. It rises with system damage,
 * and with a short parts locker on a worn ship — the two shapes
 * of the same emergency, repairs stopping. The damage factor
 * saturates at the crisis line: a short locker is an emergency
 * in proportion to how much ship there is to repair.
 */
function courseCrisis(snap: CourseSnapshot): number {
  const cfg = CONFIG.council.course;
  const conditionCrisis = Math.max(
    0,
    Math.min(
      1,
      (cfg.crisisConditionLine - snap.worstCondition) /
        cfg.crisisConditionLine,
    ),
  );
  const partsCrisis =
    Math.max(
      0,
      Math.min(
        1,
        (cfg.crisisPartsLineDays - snap.days.parts) /
          cfg.crisisPartsLineDays,
      ),
    ) *
    Math.max(
      0,
      Math.min(1, (1 - snap.worstCondition) / (1 - cfg.crisisConditionLine)),
    );
  return Math.max(conditionCrisis, partsCrisis);
}

/**
 * One officer's price for one candidate, from their seat. The
 * four terms, priced per candidate: the chart's common terms
 * (the tank's reach, the standing penalty on going back, the
 * pull of new sky), the portfolio term (the seat's own
 * arithmetic), the trait term, and trust in the navigator,
 * priced on the navigator's own recommendation. The First
 * Officer is priced separately, from the table's centre.
 */
function coursePrice(
  seatKey: string,
  member: CrewMember,
  cand: CourseCandidate,
  snap: CourseSnapshot,
  table: { motionIndex: number; navPickIndex: number; proposerId: string | null },
): number {
  const cfg = CONFIG.council.course;
  let price = 0;
  // The chart's common terms. The crisis stands computed here
  // because it bends two of them: the backtrack penalty yields
  // as the crisis rises, and time at sea is priced in it.
  const crisis = courseCrisis(snap);
  if (cand.legDays > snap.days.fuel) price -= cfg.fuelShortfallPenalty;
  if (cand.isPrevious) price -= cfg.previousPortPenalty * (1 - crisis);
  if (!cand.visited) price += cfg.unvisitedLean;
  if (crisis > 0) price -= crisis * cand.legDays * cfg.crisisDistancePerDay;
  // The leg's own burn, by projection: where each store stands
  // on arrival day if the ship sails this leg at her present
  // production. Every officer prices it; it is the chart's
  // arithmetic, not a portfolio opinion.
  let shortfall = 0;
  for (const key of STORE_KEYS) {
    const projected = snap.days[key] + cand.legDays * snap.netRateDays[key];
    shortfall += Math.max(0, cfg.projectionSafeLineDays - projected);
  }
  price -= Math.min(cfg.projectionRiskCap, shortfall * cfg.projectionRiskWeight);
  // The damage report: a hurt ship's chart is priced by how
  // well each port can answer damage (its parts supply), before
  // any portfolio speaks.
  if (crisis > 0) {
    const partsSupply =
      CONFIG.stores.port.supply[cand.character]?.parts ?? 0;
    price += crisis * cfg.crisisWeight * (partsSupply - cfg.crisisSupplyCentre);
  }
  // The portfolio term.
  const damage = 1 - snap.worstCondition;
  switch (seatKey) {
    case "quartermaster":
      price += storesFit(cand, snap);
      break;
    case "chief engineer":
      if (cand.character === "shipyard") price += cfg.shipyardPull * damage;
      price -= cand.legDays * damage * cfg.distanceRiskPerDay;
      if (damage < 0.15) price += cand.legDays * 0.002;
      break;
    case "chief medical officer":
      price +=
        (cfg.leaveValue[cand.character] ?? 0) * (0.25 + (1 - snap.meanMorale));
      price -= cand.legDays * snap.hurtShare * cfg.distanceRiskPerDay;
      break;
    case "science officer":
      if (!cand.visited) price += 0.1;
      if (cand.character === "listening post") price += 0.1;
      if (cand.character === "shrine") price += 0.03;
      break;
    case "security chief":
      price += cfg.securityLean[cand.character] ?? 0;
      if (cand.character === "free port" && snap.recentTheft) {
        price += cfg.recentTheftFreePortLean;
      }
      break;
    case "captain":
      price += storesFit(cand, snap) * 0.8;
      if (!cand.visited) price += 0.05;
      price += (cfg.leaveValue[cand.character] ?? 0) * 0.3;
      if (cand.isPrevious) price -= cfg.previousPortPenalty * 0.5;
      price -= cand.legDays * cfg.captainDistancePerDay;
      break;
    case "navigator":
      if (!cand.visited) price += 0.08;
      if (cand.character === "listening post") price += 0.06;
      price -= cand.legDays * 0.002;
      break;
    default:
      break;
  }
  // The trait term.
  for (const trait of member.traits) {
    if (trait === "bold") price += cand.legDays * 0.004;
    else if (trait === "cautious") price -= cand.legDays * 0.004;
    else if (trait === "curious" && !cand.visited) price += 0.05;
    else if (
      trait === "methodical" &&
      cand.character === "shipyard" &&
      damage > 0.25
    ) {
      price += 0.04;
    }
  }
  // Trust in the proposer and the loyal lean toward the
  // captain's tabled course are priced in a second pass, once
  // the recommendation and the motion stand named (see
  // priceCourseTable): both are the officer's read of the
  // motion's people, not of the ports.
  return price;
}

/** The one clause an officer speaks for their best port. */
function courseClause(
  seatKey: string,
  member: CrewMember,
  cand: CourseCandidate,
  snap: CourseSnapshot,
  portName: string,
): string {
  const damage = 1 - snap.worstCondition;
  switch (seatKey) {
    case "quartermaster": {
      const store = shortestAnswered(cand, snap);
      return store === null
        ? "the counters are healthy; any port feeds her"
        : `the ${store} count is shortest, and ${portName} fills it`;
    }
    case "chief engineer":
      if (cand.character === "shipyard" && damage > 0.25) {
        return `the yards can mend the ${snap.worstKind}`;
      }
      return damage > 0.25
        ? "a hurt ship wants a short leg"
        : "the ship is sound; distance is cheap";
    case "chief medical officer":
      if (snap.hurtShare > 0.25) return "the hurt want a short leg";
      return snap.meanMorale < 0.55
        ? `the crew needs leave, and ${portName} grants it`
        : "the crew is well; any course serves";
    case "science officer":
      if (!cand.visited) return "unvisited sky";
      if (cand.character === "listening post") return "a listening post hears far";
      return "the chart is known water, and sound";
    case "security chief":
      if (cand.character === "free port") return "free ports breed thieves";
      if (cand.character === "company town") return "an orderly port";
      return "a quiet port, on a clean record";
    case "first officer":
      return "the room's centre";
    default:
      return member.traits.includes("bold")
        ? "a bold course"
        : "a steady course";
  }
}

/**
 * Price the whole course table: the navigator's recommendation,
 * the captain's tabled course (their own best price), and every
 * seated officer's prices, the First Officer's read off the
 * table's centre once the others stand priced. Pure: no RNG, no
 * world writes, the same inputs give the same table.
 */
function priceCourseTable(
  state: CouncilState,
  crew: readonly CrewMember[],
  snap: CourseSnapshot,
  candidates: readonly CourseCandidate[],
  proposer: CrewMember | undefined,
): {
  prices: Map<string, number[]>;
  motionPort: number;
  navPick: number;
} {
  const prices = new Map<string, number[]>();
  const table = { motionIndex: -1, navPickIndex: -1, proposerId: proposer?.id ?? null };
  const priceAll = (
    seatKey: string,
    member: CrewMember,
  ): number[] =>
    candidates.map((cand) => coursePrice(seatKey, member, cand, snap, table));

  // The navigator's recommendation first: trust is priced on it.
  let navPick = (candidates[0] as CourseCandidate).index;
  if (proposer !== undefined) {
    const navPrices = priceAll("navigator", proposer);
    prices.set(proposer.id, navPrices);
    let best = Number.NEGATIVE_INFINITY;
    candidates.forEach((cand, i) => {
      if ((navPrices[i] as number) > best) {
        best = navPrices[i] as number;
        navPick = cand.index;
      }
    });
  }
  table.navPickIndex = candidates.findIndex((c) => c.index === navPick);

  // The captain tables their own best course as the motion. With
  // no captain seated, the chair's prices stand in (in practice
  // the First Officer's, whose seat the succession fills first).
  const captain = byId(crew, captainId(state));
  let motionPort = navPick;
  if (captain !== undefined && alive(captain)) {
    const captainPrices = priceAll("captain", captain);
    prices.set(captain.id, captainPrices);
    let best = Number.NEGATIVE_INFINITY;
    candidates.forEach((cand, i) => {
      if ((captainPrices[i] as number) > best) {
        best = captainPrices[i] as number;
        motionPort = cand.index;
      }
    });
  }
  table.motionIndex = candidates.findIndex((c) => c.index === motionPort);

  // The people's terms are priced in a second pass, once the
  // recommendation and the motion stand named: trust in the
  // navigator, on the port they recommend, and the loyal lean
  // toward the captain's tabled course. (The captain and the
  // navigator do not price trust in themselves.)
  const peoplePrice = (member: CrewMember, base: number[]): number[] => {
    if (proposer === undefined || member.id === proposer.id) return base;
    const trust = Math.max(0, trustOf(member.beliefs, proposer.id));
    if (trust <= 0 || table.navPickIndex < 0) return base;
    const out = [...base];
    out[table.navPickIndex] =
      (out[table.navPickIndex] as number) +
      trust * CONFIG.council.course.trustInProposerWeight;
    // The loyal lean: toward the captain's tabled course.
    if (member.traits.includes("loyal") && table.motionIndex >= 0) {
      out[table.motionIndex] = (out[table.motionIndex] as number) + 0.05;
    }
    return out;
  };

  const officerPrices = new Map<string, number[]>();
  for (const def of SEATS) {
    if (def.key === "captain" || def.key === "first officer") continue;
    const holder = byId(crew, state.seats[def.key] ?? null);
    if (!alive(holder) || holder === undefined) continue;
    if (prices.has(holder.id)) {
      // The navigator holds a seat too (the science chair, when
      // the scientist is gone): their seat prices are the
      // navigator's prices, already tabled.
      officerPrices.set(holder.id, prices.get(holder.id) as number[]);
      continue;
    }
    officerPrices.set(holder.id, peoplePrice(holder, priceAll(def.key, holder)));
  }
  // The First Officer, the swing seat: the table's centre, plus a
  // cohesion lean toward the captain's course.
  const fo = byId(crew, state.seats["first officer"] ?? null);
  if (alive(fo) && fo !== undefined) {
    const others = [...officerPrices.values()];
    const foPrices = candidates.map((cand, i) => {
      let centre = 0;
      if (others.length > 0) {
        for (const pricesRow of others) centre += pricesRow[i] as number;
        centre /= others.length;
      }
      if (i === table.motionIndex) centre += 0.04;
      return centre;
    });
    officerPrices.set(fo.id, peoplePrice(fo, foPrices));
  }
  for (const [id, row] of officerPrices) prices.set(id, row);
  return { prices, motionPort, navPick };
}

/** Run a course sitting: the council sets the course out of a stay. */
function runCourseSitting(
  w: World,
  state: CouncilState,
  ship: Ship,
  crew: readonly CrewMember[],
  stores: StoresState,
  galaxy: { sector: Sector; voyage: Voyage },
  pending: PendingSitting,
): void {
  const { sector, voyage } = galaxy;
  const stayIndex = pending.stayIndex as number;
  const stay = voyage.stays[stayIndex];
  if (stay === undefined) return;
  const from = stay.port;
  const previous = voyage.previousPortForStay(stayIndex);
  const candidateIndexes = voyage.courseCandidates(from, previous);
  const fromPort = sector.portAt(from);
  const candidates: CourseCandidate[] = candidateIndexes.map((index) => {
    const port = sector.portAt(index);
    return {
      index,
      character: port.character,
      legDays:
        sector.distanceBetween(fromPort, port) /
        CONFIG.galaxy.cruiseLightDaysPerDay,
      visited: voyage.hasVisited(index),
      isPrevious: index === previous,
    };
  });

  // The snapshots the table reads: the counters as tabled, the
  // ship's hurt, the crew's temper, the recent log's thieving.
  const living = crew.filter((m) => alive(m));
  let worst = ship.systems[0] as (typeof ship.systems)[number];
  for (const system of ship.systems) {
    if (system.condition < worst.condition) worst = system;
  }
  const windowStart =
    w.tick - CONFIG.council.course.recentTheftWindowDays * CONFIG.time.ticksPerDay;
  const netRateDays = {} as Record<StoreKey, number>;
  for (const key of STORE_KEYS) {
    const netMilli =
      productionMilliPerDay(stores, ship, crew, key, w.tick) -
      consumptionMilliPerDay(stores, key, true);
    netRateDays[key] = netMilli / dailyUseMilli(stores, key);
  }
  const snap: CourseSnapshot = {
    days: {
      food: daysOf(stores, "food"),
      water: daysOf(stores, "water"),
      oxygen: daysOf(stores, "oxygen"),
      fuel: daysOf(stores, "fuel"),
      parts: daysOf(stores, "parts"),
    },
    netRateDays,
    worstCondition: worst.condition,
    worstKind: worst.kind,
    meanMorale:
      living.length > 0
        ? living.reduce((sum, m) => sum + m.needs.morale, 0) / living.length
        : 1,
    hurtShare:
      living.length > 0
        ? living.filter((m) => m.body.health < 0.8).length / living.length
        : 0,
    recentTheft: w.events.events.some(
      (e) => e.type === "theft" && e.tick >= windowStart,
    ),
  };

  // The navigator proposes: the crew member who holds the role,
  // or the science chair when no navigator sails.
  const proposer =
    crew.find((m) => m.roleKey === "navigator" && alive(m)) ??
    byId(crew, state.seats["science officer"] ?? null);
  const { prices, motionPort } = priceCourseTable(
    state,
    crew,
    snap,
    candidates,
    proposer !== undefined && alive(proposer) ? proposer : undefined,
  );
  const motion: VoteMotion = {
    kind: "course",
    proposerId: proposer !== undefined && alive(proposer) ? proposer.id : null,
    portIndex: motionPort,
    fromPortIndex: from,
  };
  const frame = frameSitting(state, crew, motion);
  const chosenName = (): string => sector.portAt(chosen).name;
  let chosen = motionPort;
  let carried = true;
  let votes: VoteRecord[] = [];
  let forCount = 0;
  let againstCount = 0;
  let strength = 0;

  if (frame.sitting.length === 0) {
    // No council can sit: the course falls to the old itinerary
    // rule, recorded like any other, so the ship is never left
    // waiting on an empty table.
    chosen = voyage.fallbackCourseFor(stayIndex);
    voyage.recordCourseDecision(stayIndex, chosen);
    state.courseSittings++;
    w.emit("course_decided", [], {
      from: fromPort.name,
      fromIndex: from,
      port: chosenName(),
      portIndex: chosen,
      character: sector.portAt(chosen).character,
      distance: r3(
        sector.distanceBetween(fromPort, sector.portAt(chosen)),
      ),
      legDays: r3(
        sector.distanceBetween(fromPort, sector.portAt(chosen)) /
          CONFIG.galaxy.cruiseLightDaysPerDay,
      ),
      motion: null,
      carried: false,
      noCouncil: true,
      candidates: candidates.map((c) => ({
        port: sector.portAt(c.index).name,
        portIndex: c.index,
        legDays: r3(c.legDays),
      })),
      leanings: [],
      votes: [],
      forCount: 0,
      againstCount: 0,
      proposer: motion.proposerId,
    });
    return;
  }

  emitConvened(w, ship, frame, "course", {
    accused: null,
    subject: null,
    from: fromPort.name,
    candidates: candidates.map((c) => sector.portAt(c.index).name),
    motion: sector.portAt(motionPort).name,
    proposer: motion.proposerId,
  });
  state.sittingsHeld++;
  state.courseSittings++;
  const courseCtx: CourseVoteContext = {
    candidates: candidateIndexes,
    scores: prices,
  };
  const result = runVote(state, crew, frame, motion, courseCtx);
  votes = result.votes;
  forCount = result.forCount;
  againstCount = result.againstCount;
  strength = result.strength;
  carried = forCount > againstCount;
  if (!carried) {
    // The motion falls: the course is the port the whole table's
    // prices favour in aggregate — every voter's arithmetic,
    // the abstainers' weak preferences included, so a refusal
    // cannot hand the ship to a minority of one. The tabled
    // port is excluded (the council refused it); ties break by
    // the captain's own prices, then chart order.
    const captainRow =
      captainId(state) !== null ? prices.get(captainId(state) as string) : undefined;
    const tableIds = votes
      .filter((v) => v.member !== captainId(state))
      .map((v) => v.member);
    let bestPick: number | null = null;
    let bestTotal = Number.NEGATIVE_INFINITY;
    let bestCaptainPrice = Number.NEGATIVE_INFINITY;
    for (const cand of candidates) {
      if (cand.index === motionPort) continue;
      const at = candidateIndexes.indexOf(cand.index);
      let total = 0;
      for (const id of tableIds) {
        total += prices.get(id)?.[at] ?? 0;
      }
      const captainPrice =
        captainRow !== undefined ? (captainRow[at] as number) : 0;
      if (
        total > bestTotal ||
        (total === bestTotal && captainPrice > bestCaptainPrice)
      ) {
        bestTotal = total;
        bestCaptainPrice = captainPrice;
        bestPick = cand.index;
      }
    }
    if (bestPick !== null) chosen = bestPick;
  }
  voyage.recordCourseDecision(stayIndex, chosen);

  // Each voter's stated leaning: their best port, in one clause.
  const leanings = frame.sitting
    .filter((s) => s.seatKey !== "captain")
    .map((s) => {
      const row = prices.get(s.member.id);
      let bestAt = candidateIndexes.indexOf(chosen);
      if (row !== undefined) {
        bestAt = 0;
        for (let i = 1; i < row.length; i++) {
          if ((row[i] as number) > (row[bestAt] as number)) bestAt = i;
        }
      }
      const cand = candidates[bestAt] as CourseCandidate;
      return {
        member: s.member.id,
        seat: s.seatKey,
        port: sector.portAt(cand.index).name,
        clause: courseClause(
          s.seatKey,
          s.member,
          cand,
          snap,
          sector.portAt(cand.index).name,
        ),
      };
    });

  const chosenPort = sector.portAt(chosen);
  const proposerId = motion.proposerId ?? null;
  const captainNow = captainId(state);
  w.emit(
    "course_decided",
    [
      ...(proposerId !== null ? [proposerId] : []),
      ...(captainNow !== null ? [captainNow] : []),
    ],
    {
      from: fromPort.name,
      fromIndex: from,
      port: chosenPort.name,
      portIndex: chosen,
      character: chosenPort.character,
      distance: r3(sector.distanceBetween(fromPort, chosenPort)),
      legDays: r3(
        sector.distanceBetween(fromPort, chosenPort) /
          CONFIG.galaxy.cruiseLightDaysPerDay,
      ),
      motion: sector.portAt(motionPort).name,
      motionIndex: motionPort,
      carried,
      noCouncil: false,
      candidates: candidates.map((c) => ({
        port: sector.portAt(c.index).name,
        portIndex: c.index,
        legDays: r3(c.legDays),
      })),
      leanings,
      votes,
      forCount,
      againstCount,
      proposer: motion.proposerId,
    },
  );
  w.emit("council_finding", [], {
    kind: "course",
    accused: null,
    victim: null,
    cause: "course",
    truthCause: null,
    truthCulprit: null,
    convicted: carried,
    votes,
    strength: r3(strength),
    consequence: `course set for ${chosenPort.name}`,
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

  // Course: a stay whose leg out has no decided course convenes
  // the council early in the call, while there is still sea-room
  // to argue. One sitting per stay; the voyage's fallback rule
  // covers any stay the table never reaches.
  const stay = galaxy.voyage.stayAt(w.tick);
  if (
    stay !== null &&
    galaxy.voyage.courseDecisionFor(stay.index) === null &&
    w.tick >= stay.arriveTick + cfg.course.conveneAfterTicks &&
    w.tick < stay.departTick - 2 &&
    !state.pending.some((p) => p.kind === "course")
  ) {
    state.pending.push({
      kind: "course",
      atTick: w.tick,
      accusedId: null,
      accuserId: null,
      victimId: null,
      truthCulprit: null,
      causeKind: "course",
      store: null,
      level: null,
      movers: [],
      renewal: 0,
      subjectId: null,
      stayIndex: stay.index,
    });
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
    } else if (pending.kind === "course") {
      runCourseSitting(w, state, ship, crew, stores, galaxy, pending);
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
