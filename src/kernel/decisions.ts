// Decision sources: the only way an agent influences the world.
//
// The engine offers an agent a list of candidates; a decision source picks
// an index. The utility source scores and picks live. The replay source
// plays back a recorded decision log and refuses to improvise: any mismatch
// between the recording and what the engine asks is a ReplayDivergenceError.

export interface Candidate {
  key: string;
  base: number;
  urgency?: number;
}

export interface DecisionContext {
  tick: number;
  purpose?: string;
}

export interface DecisionRecord {
  tick: number;
  agentId: string;
  candidateCount: number;
  chosen: number;
  chosenKey: string;
  keys: string[];
  scores: number[];
}

export interface DecisionSource {
  choose(
    agentId: string,
    candidates: readonly Candidate[],
    context: DecisionContext,
  ): number;
}

export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

/**
 * Scores every candidate as base * urgency plus optional small noise, picks
 * the argmax (ties go to the lower index), and records the decision.
 */
export class UtilitySource implements DecisionSource {
  readonly records: DecisionRecord[] = [];
  private readonly noise: (() => number) | undefined;

  constructor(noise?: () => number) {
    this.noise = noise;
  }

  choose(
    agentId: string,
    candidates: readonly Candidate[],
    context: DecisionContext,
  ): number {
    if (candidates.length === 0) {
      throw new Error(`UtilitySource: no candidates for agent ${agentId}`);
    }
    const scores = candidates.map(
      (c) =>
        c.base * (c.urgency ?? 1) +
        (this.noise !== undefined ? this.noise() * 0.01 : 0),
    );
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
      if ((scores[i] as number) > (scores[best] as number)) best = i;
    }
    this.records.push({
      tick: context.tick,
      agentId,
      candidateCount: candidates.length,
      chosen: best,
      chosenKey: (candidates[best] as Candidate).key,
      keys: candidates.map((c) => c.key),
      scores,
    });
    return best;
  }
}

/**
 * Consumes a recorded decision log in order. Throws ReplayDivergenceError on
 * log exhaustion, wrong agent, wrong tick, wrong candidate count, or when the
 * candidate at the recorded index is not the candidate that was chosen.
 */
export class ReplaySource implements DecisionSource {
  private cursor = 0;
  private readonly records: readonly DecisionRecord[];

  constructor(records: readonly DecisionRecord[]) {
    this.records = records;
  }

  choose(
    agentId: string,
    candidates: readonly Candidate[],
    context: DecisionContext,
  ): number {
    const record = this.records[this.cursor];
    if (record === undefined) {
      throw new ReplayDivergenceError(
        `decision log exhausted at call ${this.cursor} (agent ${agentId}, tick ${context.tick})`,
      );
    }
    if (record.agentId !== agentId) {
      throw new ReplayDivergenceError(
        `call ${this.cursor}: recorded agent ${record.agentId}, engine asked ${agentId}`,
      );
    }
    if (record.tick !== context.tick) {
      throw new ReplayDivergenceError(
        `call ${this.cursor}: recorded tick ${record.tick}, engine at tick ${context.tick}`,
      );
    }
    if (record.candidateCount !== candidates.length) {
      throw new ReplayDivergenceError(
        `call ${this.cursor}: recorded ${record.candidateCount} candidates, engine offered ${candidates.length}`,
      );
    }
    const chosen = candidates[record.chosen];
    if (chosen === undefined || chosen.key !== record.chosenKey) {
      throw new ReplayDivergenceError(
        `call ${this.cursor}: recorded choice "${record.chosenKey}" at index ${record.chosen}, ` +
          `engine offered "${chosen?.key ?? "<none>"}" there`,
      );
    }
    this.cursor++;
    return record.chosen;
  }

  get consumed(): number {
    return this.cursor;
  }

  assertFullyConsumed(): void {
    if (this.cursor !== this.records.length) {
      throw new ReplayDivergenceError(
        `replay consumed ${this.cursor} of ${this.records.length} recorded decisions`,
      );
    }
  }
}
