// Run a simulation and, with --out, write the run to a directory:
// events.ndjson, decisions.ndjson, summary.json (which also records
// elapsedMs and ticksPerSecond, because speed is a requirement), and
// chronicle.txt, the event log rendered as a readable ship's log.
//
// This file is platform code, not engine code: it may read the wall clock
// (for the speed report) and touch the file system.
//
//   npm run simulate -- --seed 42 --ticks 200 --out runs/seed42

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderChronicle } from "../log/chronicle.ts";
import { runSimulation } from "../sim.ts";
import { argValue } from "./args.ts";

export interface RunSummary {
  seed: number;
  ticks: number;
  events: number;
  decisions: number;
  hash: string;
  elapsedMs: number;
  ticksPerSecond: number;
}

function main(args: string[]): void {
  const seed = Number(argValue(args, "--seed") ?? "42");
  const ticks = Number(argValue(args, "--ticks") ?? "200");
  const out = argValue(args, "--out");

  const started = performance.now();
  const { world, decisions } = runSimulation({ seed }, ticks);
  const elapsedMs = performance.now() - started;
  const ticksPerSecond = ticks / (elapsedMs / 1000);
  const hash = world.events.hash();

  console.log(
    `seed ${seed}  ticks ${ticks}  events ${world.events.size}  decisions ${decisions.length}`,
  );
  console.log(`hash ${hash}`);
  console.log(
    `elapsed ${elapsedMs.toFixed(1)} ms  ${Math.round(ticksPerSecond)} ticks/sec`,
  );

  if (out !== undefined) {
    mkdirSync(out, { recursive: true });
    const eventLines = world.events.events
      .map((event) => JSON.stringify(event))
      .join("\n");
    writeFileSync(join(out, "events.ndjson"), eventLines + "\n");
    const decisionLines = decisions
      .map((record) => JSON.stringify(record))
      .join("\n");
    writeFileSync(
      join(out, "decisions.ndjson"),
      decisionLines === "" ? "" : decisionLines + "\n",
    );
    const summary: RunSummary = {
      seed,
      ticks,
      events: world.events.size,
      decisions: decisions.length,
      hash,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      ticksPerSecond: Math.round(ticksPerSecond),
    };
    writeFileSync(
      join(out, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    writeFileSync(
      join(out, "chronicle.txt"),
      renderChronicle(world.events.events),
    );
    console.log(`wrote ${out}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
