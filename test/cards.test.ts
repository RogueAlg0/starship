import { describe, expect, it } from "vitest";
import {
  conditionFor,
  playMatch,
  starterDeck,
  SUITS,
  type GameCard,
} from "../src/entities/cards.ts";

/** An int source that makes the shuffle the identity: deck order
 *  is match order, so runs can be scripted card by card. */
const noShuffle = (n: number): number => n - 1;

function card(power: number, suit: GameCard["suit"], effect?: GameCard["effect"]): GameCard {
  return effect === undefined ? { suit, power } : { suit, power, effect };
}

/** Five plain cards, all one suit, ascending. */
function plain(powers: number[], suit: GameCard["suit"]): GameCard[] {
  return powers.map((p) => card(p, suit));
}

describe("PORTFALL starter decks", () => {
  it("every deck is twelve cards, three a suit, totalling 52", () => {
    for (const id of ["c0", "c1", "c7", "c11"]) {
      const deck = starterDeck(42, id);
      expect(deck).toHaveLength(12);
      expect(deck.reduce((n, c) => n + c.power, 0)).toBe(52);
      for (const suit of SUITS) {
        expect(deck.filter((c) => c.suit === suit)).toHaveLength(3);
      }
      expect(deck.filter((c) => c.effect === "anchor")).toHaveLength(1);
      expect(deck.filter((c) => c.effect === "surge")).toHaveLength(1);
    }
  });

  it("a deck is the same on every derivation and differs by member", () => {
    expect(starterDeck(42, "c3")).toEqual(starterDeck(42, "c3"));
    expect(starterDeck(42, "c3")).not.toEqual(starterDeck(42, "c4"));
    expect(starterDeck(42, "c3")).not.toEqual(starterDeck(7, "c3"));
  });
});

describe("PORTFALL table conditions", () => {
  it("the room favours a suit by where the ship is", () => {
    expect(conditionFor(true, "calm")).toBe("coin");
    expect(conditionFor(false, "solar wind")).toBe("helm");
    expect(conditionFor(false, "radiation storm")).toBe("forge");
    expect(conditionFor(false, "calm")).toBe("leaf");
  });
});

describe("PORTFALL matches", () => {
  it("higher power takes the run and the match", () => {
    const a = plain([7, 6, 5, 4, 3], "helm");
    const b = plain([2, 2, 2, 2, 2], "coin");
    const result = playMatch(a, b, "leaf", noShuffle);
    expect(result.scoreA).toBe(5);
    expect(result.winner).toBe("a");
  });

  it("the condition suit gets +1, enough to burn a run", () => {
    const a = [card(5, "helm"), ...plain([2, 2, 2, 2], "leaf")];
    const b = [card(6, "coin"), ...plain([2, 2, 2, 2], "leaf")];
    const result = playMatch(a, b, "helm", noShuffle);
    // 5 on a helm table reads 6, meeting the coin 6: the run burns.
    expect(result.runs[0]?.point).toBeNull();
  });

  it("an Anchor takes a tie that would otherwise burn", () => {
    const a = [card(4, "leaf", "anchor"), ...plain([2, 2, 2, 2], "leaf")];
    const b = plain([4, 2, 2, 2, 2], "coin");
    const result = playMatch(a, b, "helm", noShuffle);
    expect(result.runs[0]?.point).toBe("a");
  });

  it("a Surge played from behind gets +2", () => {
    const a = [
      ...plain([2, 2], "leaf"),
      card(3, "forge", "surge"),
      ...plain([9, 9], "leaf"),
    ];
    const b = plain([5, 5, 4, 2, 2], "coin");
    const result = playMatch(a, b, "helm", noShuffle);
    // A trails 0-2 when the Surge lands: 3 + 2 beats the 4.
    expect(result.runs[2]?.point).toBe("a");
  });

  it("a level match after five runs goes to sudden death", () => {
    const a = plain([7, 2, 7, 2, 2, 6], "helm");
    const b = plain([2, 7, 2, 7, 2, 3], "coin");
    const result = playMatch(a, b, "leaf", noShuffle);
    expect(result.runs).toHaveLength(6);
    expect(result.winner).toBe("a");
  });

  it("starter decks split matches evenly over a season of tables", () => {
    let state = 123456789;
    const int = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    let aWins = 0;
    const matches = 200;
    for (let m = 0; m < matches; m++) {
      const result = playMatch(
        starterDeck(42, `c${m % 12}`),
        starterDeck(42, `c${(m + 5) % 12}`),
        SUITS[m % 4] as GameCard["suit"],
        int,
      );
      if (result.winner === "a") aWins++;
    }
    expect(aWins).toBeGreaterThan(matches * 0.35);
    expect(aWins).toBeLessThan(matches * 0.65);
  });
});
