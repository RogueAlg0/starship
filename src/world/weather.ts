// Shipboard weather: a small Markov chain over the states in the scenario
// config, rolled on the dedicated "weather" RNG stream at the configured
// cadence. Weather does nothing directly; systems read the current state
// and let it push on their own scores and risks.

import type { World } from "../engine/engine.ts";
import { CONFIG } from "../scenario/config.ts";

export class Weather {
  /** Index into CONFIG.weather.states. */
  index = 0;

  get name(): string {
    return CONFIG.weather.states[this.index] as string;
  }

  get storm(): boolean {
    return this.name === "radiation storm";
  }

  step(w: World): void {
    if (w.tick % CONFIG.weather.cadenceTicks !== 0) return;
    const rng = w.rng.get("weather");
    const row = CONFIG.weather.transitions[this.index] as readonly number[];
    const roll = rng.next();
    let next = this.index;
    let acc = 0;
    for (let i = 0; i < row.length; i++) {
      acc += row[i] as number;
      if (roll < acc) {
        next = i;
        break;
      }
    }
    if (next !== this.index) {
      w.emit("weather", [], {
        from: CONFIG.weather.states[this.index],
        to: CONFIG.weather.states[next],
      });
      this.index = next;
    }
  }
}
