// Append-only event log with a running stream hash.
//
// Every state change in the simulation is emitted here. Each event is
// serialized to one canonical JSON line and folded into a two-lane 32-bit
// hash, so a whole run has a one-string identity: two runs are the same run
// if and only if their hashes and event counts agree. The hash is a
// divergence detector, not a cryptographic checksum.

export interface SimEvent {
  seq: number;
  tick: number;
  type: string;
  actors: string[];
  data: Record<string, unknown>;
}

type Sink = (line: string) => void;

export class EventLog {
  readonly events: SimEvent[] = [];
  private readonly counts = new Map<string, number>();
  private laneA = 0x811c9dc5;
  private laneB = 0x9e3779b9;
  private foldedChars = 0;
  private readonly sink: Sink | undefined;

  constructor(sink?: Sink) {
    this.sink = sink;
  }

  emit(
    tick: number,
    type: string,
    actors: readonly string[],
    data: Record<string, unknown>,
  ): SimEvent {
    const event: SimEvent = {
      seq: this.events.length,
      tick,
      type,
      actors: [...actors],
      data,
    };
    const line = JSON.stringify(event);
    this.fold(line);
    this.fold("\n");
    this.events.push(event);
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
    if (this.sink !== undefined) this.sink(line);
    return event;
  }

  private fold(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      this.laneA = Math.imul(this.laneA ^ code, 0x01000193);
      this.laneB = Math.imul(this.laneB ^ (code + this.laneA), 0x85ebca6b);
      this.laneB = (this.laneB << 13) | (this.laneB >>> 19);
    }
    this.foldedChars += text.length;
  }

  /** 16 hex characters naming the event stream folded so far. */
  hash(): string {
    const a = (this.laneA ^ this.foldedChars) >>> 0;
    const b = (this.laneB + this.foldedChars) >>> 0;
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  }

  get size(): number {
    return this.events.length;
  }

  countOf(type: string): number {
    return this.counts.get(type) ?? 0;
  }
}

/** Round a float to three decimals so logged numbers stay short and stable. */
export function r3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
