// Replay a recorded run and check that it reproduces the event stream
// exactly: re-run the same seed from the recorded decision log, then
// compare the stream hash and event count against the run's summary.
//
//   npm run replay -- --dir runs/seed42

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ReplaySource,
  type DecisionRecord,
} from "../decision/decisions.ts";
import { runSimulation } from "../sim.ts";
import { argValue } from "./args.ts";
import type { RunSummary } from "./simulate.ts";

function main(args: string[]): void {
  const dir = argValue(args, "--dir");
  if (dir === undefined) {
    console.error("usage: npm run replay -- --dir <run directory>");
    process.exit(2);
  }
  const summary = JSON.parse(
    readFileSync(join(dir, "summary.json"), "utf8"),
  ) as RunSummary;
  const decisionsText = readFileSync(join(dir, "decisions.ndjson"), "utf8");
  const records: DecisionRecord[] = decisionsText
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as DecisionRecord);

  const source = new ReplaySource(records);
  const started = performance.now();
  const { world } = runSimulation({ seed: summary.seed }, summary.ticks, source);
  const elapsedMs = performance.now() - started;
  source.assertFullyConsumed();

  const hash = world.events.hash();
  if (hash !== summary.hash || world.events.size !== summary.events) {
    console.error(
      `REPLAY FAILED: recorded hash ${summary.hash} (${summary.events} events), ` +
        `replayed hash ${hash} (${world.events.size} events)`,
    );
    process.exit(1);
  }
  console.log(
    `OK: replay reproduced the event stream exactly (hash ${hash}, ` +
      `${records.length} decisions consumed, ${elapsedMs.toFixed(1)} ms)`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
