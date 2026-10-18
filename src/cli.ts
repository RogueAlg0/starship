// Command line entry. This file is platform code, not engine code: it may
// read the wall clock (for the speed report) and touch the file system.
//
//   npm run simulate -- --seed 42 --ticks 200 --out runs/seed42
//   npm run replay   -- --dir runs/seed42

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ReplaySource,
  type DecisionRecord,
} from "./kernel/decisions.ts";
import { runDemo } from "./demo/world.ts";

interface Summary {
  seed: number;
  ticks: number;
  events: number;
  decisions: number;
  hash: string;
  elapsedMs: number;
  ticksPerSecond: number;
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function simulate(args: string[]): void {
  const seed = Number(argValue(args, "--seed") ?? "42");
  const ticks = Number(argValue(args, "--ticks") ?? "200");
  const out = argValue(args, "--out");

  const started = performance.now();
  const { world, decisions } = runDemo({ seed }, ticks);
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
    const summary: Summary = {
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
    console.log(`wrote ${out}`);
  }
}

function replay(args: string[]): void {
  const dir = argValue(args, "--dir");
  if (dir === undefined) {
    console.error("usage: npm run replay -- --dir <run directory>");
    process.exit(2);
  }
  const summary = JSON.parse(
    readFileSync(join(dir, "summary.json"), "utf8"),
  ) as Summary;
  const decisionsText = readFileSync(join(dir, "decisions.ndjson"), "utf8");
  const records: DecisionRecord[] = decisionsText
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as DecisionRecord);

  const source = new ReplaySource(records);
  const started = performance.now();
  const { world } = runDemo({ seed: summary.seed }, summary.ticks, source);
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

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "simulate") simulate(rest);
  else if (command === "replay") replay(rest);
  else {
    console.error("usage: node src/cli.ts simulate|replay [options]");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
