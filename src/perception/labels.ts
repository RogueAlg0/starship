// Relationship labels: the crew's own words for what a pair
// is, derived from the beliefs that already exist. No new
// state: a label is a reading, not a fact, and it is the
// holder's reading. A can call B a friend while B calls A an
// acquaintance, because the numbers underneath are directed
// and the label reads them in the holder's direction first.
// The chronicle stays the record; a label is what the holder
// would say in the mess, and like anything said in the mess
// it can be one-sided.

import type { CrewMember } from "../entities/crew.ts";
import { CONFIG } from "../scenario/config.ts";
import { bondOf, trustOf } from "./beliefs.ts";

export type RelationshipLabel =
  | "confidant"
  | "friend"
  | "rival"
  | "feud"
  | "estranged"
  | "acquaintance";

/** Trust at or above this, in both directions, reads as deep. */
const TRUST_HIGH = 0.5;
/** Trust at or above this, in both directions, reads as warm. */
const TRUST_WARM = 0.2;
/** Trust at or below this, in both directions, reads as rivalry. */
const TRUST_RIVAL = -0.3;
/** A bond that once crossed the milestone and now sits at or
 *  below this has collapsed: the pair is estranged. */
const BOND_COLLAPSED = 0.25;

/** Is this person among the holder's two most trusted peers? */
function isTopTrust(
  holder: CrewMember,
  other: CrewMember,
  peers: readonly CrewMember[],
): boolean {
  const mine = trustOf(holder.beliefs, other.id);
  let above = 0;
  for (const peer of peers) {
    if (peer === holder || peer === other) continue;
    if (trustOf(holder.beliefs, peer.id) > mine) above++;
  }
  return above < 2;
}

/**
 * The holder's word for the other. Precedence is story order:
 * a held grudge names the pair before anything warmer or
 * colder is read; a former friendship gone cold names it
 * before a mere rivalry; warmth is read before rivalry, and
 * everyone else is an acquaintance.
 *
 * Confidant is deliberately relative as well as absolute.
 * Measured on long runs, bond is a ratchet (111 of 132 pairs
 * at the cap by year two) and trust polarizes, so fixed
 * lines alone made the whole ship confidants (80 of 132).
 * A confidant must also sit in the holder's two most
 * trusted, and hold the holder in theirs. Peers defaults to
 * the pair alone, where the absolute lines decide.
 */
export function relationshipLabel(
  holder: CrewMember,
  other: CrewMember,
  peers: readonly CrewMember[] = [holder, other],
): RelationshipLabel {
  const beliefs = holder.beliefs;
  if (beliefs.grudges.includes(other.id)) return "feud";

  const bond = bondOf(beliefs, other.id);
  const trust = trustOf(beliefs, other.id);
  const backBond = bondOf(other.beliefs, holder.id);
  const backTrust = trustOf(other.beliefs, holder.id);

  const wasBonded =
    (beliefs.milestones[`${other.id}:bond`] ?? "0") !== "0";
  if (
    wasBonded &&
    (bond <= BOND_COLLAPSED || trust <= TRUST_RIVAL)
  ) {
    return "estranged";
  }

  const cfg = CONFIG.relationships;
  if (
    bond >= cfg.bondMilestoneHigh &&
    backBond >= cfg.bondMilestoneHigh &&
    trust >= TRUST_HIGH &&
    backTrust >= TRUST_HIGH &&
    isTopTrust(holder, other, peers) &&
    isTopTrust(other, holder, peers)
  ) {
    return "confidant";
  }
  if (
    bond >= cfg.bondMilestone &&
    trust >= TRUST_WARM &&
    backTrust >= TRUST_WARM
  ) {
    return "friend";
  }
  if (
    trust <= TRUST_RIVAL &&
    backTrust <= TRUST_RIVAL &&
    !other.beliefs.grudges.includes(holder.id)
  ) {
    return "rival";
  }
  return "acquaintance";
}
