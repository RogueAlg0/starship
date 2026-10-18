// Render a recorded run's event log as a readable ship's log.
//
//   npm run chronicle -- --dir runs/seed42
//
// Reads <dir>/events.ndjson and writes <dir>/chronicle.txt. This is
// platform code: file IO lives here, the renderer itself is pure.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderChronicle } from "../log/chronicle.ts";
import type { SimEvent } from "../log/events.ts";
import { argValue } from "./args.ts";

function main(args: string[]): void {
  const dir = argValue(args, "--dir");
  if (dir === undefined) {
    console.error("usage: npm run chronicle -- --dir <run directory>");
    process.exit(2);
  }
  const text = readFileSync(join(dir, "events.ndjson"), "utf8");
  const events: SimEvent[] = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SimEvent);
  const chronicle = renderChronicle(events);
  writeFileSync(join(dir, "chronicle.txt"), chronicle);
  console.log(
    `wrote ${join(dir, "chronicle.txt")} (${chronicle.split("\n").length} lines from ${events.length} events)`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
