// Relationship labels: derived readings of the belief
// numbers, in the holder's direction. Fabricated members
// carry only what the derivation reads (id and beliefs).

import { describe, expect, it } from "vitest";
import type { CrewMember } from "../src/entities/crew.ts";
import {
  createBeliefs,
  driftBond,
  driftTrust,
} from "../src/perception/beliefs.ts";
import { relationshipLabel } from "../src/perception/labels.ts";

function member(id: string, roster: string[]): CrewMember {
  return { id, beliefs: createBeliefs(roster) } as unknown as CrewMember;
}

function pair(): { a: CrewMember; b: CrewMember } {
  const roster = ["a", "b"];
  return { a: member("a", roster), b: member("b", roster) };
}

describe("relationship labels", () => {
  it("strangers are acquaintances in both directions", () => {
    const { a, b } = pair();
    expect(relationshipLabel(a, b)).toBe("acquaintance");
    expect(relationshipLabel(b, a)).toBe("acquaintance");
  });

  it("a held grudge names the pair a feud, in the holder's direction only", () => {
    const { a, b } = pair();
    a.beliefs.grudges.push("b");
    expect(relationshipLabel(a, b)).toBe("feud");
    expect(relationshipLabel(b, a)).toBe("acquaintance");
  });

  it("friend needs the bond milestone and trust positive both ways", () => {
    const { a, b } = pair();
    driftBond(a.beliefs, "b", 0.7);
    driftTrust(a.beliefs, "b", 0.2);
    // One-sided trust is not yet friendship in the holder's word.
    expect(relationshipLabel(a, b)).toBe("acquaintance");
    driftTrust(b.beliefs, "a", 0.2);
    expect(relationshipLabel(a, b)).toBe("friend");
  });

  it("confidant needs high bond and high trust in both directions", () => {
    const { a, b } = pair();
    driftBond(a.beliefs, "b", 0.9);
    driftBond(b.beliefs, "a", 0.85);
    driftTrust(a.beliefs, "b", 0.6);
    driftTrust(b.beliefs, "a", 0.4);
    // Back-trust below the high line: still friends, not confidants.
    expect(relationshipLabel(a, b)).toBe("friend");
    driftTrust(b.beliefs, "a", 0.2);
    expect(relationshipLabel(a, b)).toBe("confidant");
    expect(relationshipLabel(b, a)).toBe("confidant");
  });

  it("labels are asymmetric when the numbers are", () => {
    const { a, b } = pair();
    driftBond(a.beliefs, "b", 0.7);
    driftTrust(a.beliefs, "b", 0.3);
    driftTrust(b.beliefs, "a", 0.3);
    // A holds the bond; B does not. A says friend, B says acquaintance.
    expect(relationshipLabel(a, b)).toBe("friend");
    expect(relationshipLabel(b, a)).toBe("acquaintance");
  });

  it("mutual low trust with no grudge is a rivalry", () => {
    const { a, b } = pair();
    driftTrust(a.beliefs, "b", -0.4);
    driftTrust(b.beliefs, "a", -0.5);
    expect(relationshipLabel(a, b)).toBe("rival");
    expect(relationshipLabel(b, a)).toBe("rival");
  });

  it("a grudge on the far side breaks the rivalry reading", () => {
    const { a, b } = pair();
    driftTrust(a.beliefs, "b", -0.4);
    driftTrust(b.beliefs, "a", -0.5);
    b.beliefs.grudges.push("a");
    expect(relationshipLabel(b, a)).toBe("feud");
    expect(relationshipLabel(a, b)).toBe("acquaintance");
  });

  it("a bond that crossed the milestone and collapsed is estranged", () => {
    const { a, b } = pair();
    a.beliefs.milestones["b:bond"] = "1";
    driftBond(a.beliefs, "b", 0.2);
    driftTrust(a.beliefs, "b", 0.1);
    driftTrust(b.beliefs, "a", 0.1);
    expect(relationshipLabel(a, b)).toBe("estranged");
    // B never bonded: no estrangement in the other direction.
    expect(relationshipLabel(b, a)).toBe("acquaintance");
  });

  it("a live bond above the milestone is never estranged", () => {
    const { a, b } = pair();
    a.beliefs.milestones["b:bond"] = "2";
    driftBond(a.beliefs, "b", 0.7);
    driftTrust(a.beliefs, "b", 0.2);
    driftTrust(b.beliefs, "a", 0.2);
    expect(relationshipLabel(a, b)).toBe("friend");
  });

  it("a former friendship whose trust died is estranged even at a live bond", () => {
    const { a, b } = pair();
    a.beliefs.milestones["b:bond"] = "1";
    driftBond(a.beliefs, "b", 0.7);
    driftTrust(a.beliefs, "b", -0.4);
    driftTrust(b.beliefs, "a", 0.2);
    expect(relationshipLabel(a, b)).toBe("estranged");
  });

  it("confidant must be mutual top-two trust when peers are known", () => {
    const roster = ["a", "b", "c", "d"];
    const a = member("a", roster);
    const b = member("b", roster);
    const c = member("c", roster);
    const d = member("d", roster);
    driftBond(a.beliefs, "b", 0.9);
    driftBond(b.beliefs, "a", 0.9);
    driftTrust(a.beliefs, "b", 0.7);
    driftTrust(b.beliefs, "a", 0.7);
    // Alone together the absolute lines make them confidants.
    expect(relationshipLabel(a, b)).toBe("confidant");
    // But two shipmates outrank B in A's trust, so the pair is
    // not mutual-top: confidant is mutual or it is nothing.
    driftTrust(a.beliefs, "c", 0.9);
    driftTrust(a.beliefs, "d", 0.85);
    expect(relationshipLabel(a, b, [a, b, c, d])).toBe("friend");
    expect(relationshipLabel(b, a, [a, b, c, d])).toBe("friend");
  });

  it("a grudge outranks a collapsed bond", () => {
    const { a, b } = pair();
    a.beliefs.milestones["b:bond"] = "1";
    driftBond(a.beliefs, "b", 0.1);
    a.beliefs.grudges.push("b");
    expect(relationshipLabel(a, b)).toBe("feud");
  });
});
