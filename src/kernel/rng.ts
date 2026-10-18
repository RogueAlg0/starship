// Seeded deterministic randomness.
//
// Design: one PRNG algorithm (sfc32), many independent streams. Each stream
// is seeded from hash32(seed + "/" + name), expanded through splitmix32, and
// warmed up before use. Because streams share no state, a new draw in one
// subsystem can never shift the sequence of another subsystem.

/** FNV-1a 32-bit string hash. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(state: { value: number }): number {
  state.value = (state.value + 0x9e3779b9) | 0;
  let z = state.value;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** A single sfc32 stream. Counts its own draws for diagnostics. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  draws = 0;

  constructor(seedWord: number) {
    const state = { value: seedWord | 0 };
    this.a = splitmix32(state) | 0;
    this.b = splitmix32(state) | 0;
    this.c = splitmix32(state) | 0;
    this.d = splitmix32(state) | 0;
    // Warm up so the first draws are well mixed; warm-up is not counted.
    for (let i = 0; i < 12; i++) this.step();
  }

  private step(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + ((this.c << 3) | 0)) | 0;
    this.c = ((((this.c << 21) | (this.c >>> 11)) | 0) + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.draws++;
    return this.step();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Rng.int: n must be a positive integer, got ${n}`);
    }
    return Math.floor(this.next() * n);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty array");
    return items[this.int(items.length)] as T;
  }
}

/**
 * Hands out one independent Rng per subsystem name, created lazily and
 * cached. Stream "crew" in two registries built from the same seed produces
 * the same sequence, regardless of what other streams were drawn from.
 */
export class StreamRegistry {
  private readonly streams = new Map<string, Rng>();
  private readonly seedText: string;

  constructor(seed: number | string) {
    this.seedText = String(seed);
  }

  get(name: string): Rng {
    let stream = this.streams.get(name);
    if (stream === undefined) {
      stream = new Rng(hash32(`${this.seedText}/${name}`));
      this.streams.set(name, stream);
    }
    return stream;
  }

  names(): string[] {
    return [...this.streams.keys()];
  }
}
